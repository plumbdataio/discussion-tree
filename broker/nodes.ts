// Node-level handlers: structural mods (add / update / move / reorder /
// delete) and status changes. Most structural mods consult isDefaultBoard()
// and refuse to touch the locked default conversation board — the exception
// is /update-node, which is intentionally allowed (title/context edits
// don't change shape; the i18n-driven seed override means renames just shift
// what the user sees in their language).

import type { NodeInput } from "../shared/types.ts";
import {
  db,
  insertNode,
  insertThread,
  recomputeBoardStatus,
  updateNodeStatus,
} from "./db.ts";
import { broadcast } from "./ws.ts";
import {
  DEFAULT_BOARD_LOCKED_ERROR,
  isDefaultBoard,
} from "./default-board.ts";
import { generateId, insertNodesRecursive, maxChildPos } from "./helpers.ts";

// Helper: any node-structure / node-status mutation may flip the parent
// board's auto-rollup status (discussing ↔ settled). Run after every such
// mutation; the broadcast lets the sidebar refresh its per-board status
// pill / per-session summary chips in real time.
function syncBoardStatus(boardId: string) {
  const next = recomputeBoardStatus(boardId);
  if (next) {
    broadcast(boardId, { type: "board-status-update", status: next });
  }
}

export function handleAddConcern(body: any) {
  if (isDefaultBoard(body.board_id)) {
    return { error: DEFAULT_BOARD_LOCKED_ERROR };
  }
  const concern = body.concern as NodeInput;
  const id = concern.id || generateId("c");
  const pos = maxChildPos(body.board_id, null) + 1;
  insertNode.run(
    body.board_id,
    id,
    null,
    "concern",
    concern.title,
    concern.context ?? "",
    "pending",
    pos,
    new Date().toISOString(),
  );
  if (concern.items?.length) {
    insertNodesRecursive(body.board_id, id, "item", concern.items);
  }
  broadcast(body.board_id, { type: "structure-update" });
  syncBoardStatus(body.board_id);
  return { node_id: id };
}

export function handleAddItem(body: any) {
  if (isDefaultBoard(body.board_id)) {
    return { error: DEFAULT_BOARD_LOCKED_ERROR };
  }
  const item = body.item as NodeInput;
  if (item && Array.isArray(item.items) && item.items.length > 0) {
    return {
      error:
        "Sub-items are not supported. Pass only top-level items under a concern.",
    };
  }
  const id = item.id || generateId("i");
  const parentId = body.concern_id;
  const pos = maxChildPos(body.board_id, parentId) + 1;
  insertNode.run(
    body.board_id,
    id,
    parentId,
    "item",
    item.title,
    item.context ?? "",
    "pending",
    pos,
    new Date().toISOString(),
  );
  broadcast(body.board_id, { type: "structure-update" });
  syncBoardStatus(body.board_id);
  return { node_id: id };
}

export function handleUpdateNode(body: any) {
  // Title / context / kind edit. At least one field must be provided.
  // Intentionally NOT locked on the default board — see top-of-file comment.
  const sets: string[] = [];
  const params: any[] = [];
  if (typeof body.title === "string") {
    sets.push("title = ?");
    params.push(body.title);
  }
  if (typeof body.context === "string") {
    sets.push("context = ?");
    params.push(body.context);
  }
  if (typeof body.kind === "string") {
    if (body.kind !== "concern" && body.kind !== "item") {
      return { ok: false, error: "kind must be 'concern' or 'item'" };
    }
    sets.push("kind = ?");
    params.push(body.kind);
  }
  if (sets.length === 0) {
    return {
      ok: false,
      error: "Nothing to update — pass title / context / kind",
    };
  }
  params.push(body.board_id, body.node_id);
  db.run(
    `UPDATE nodes SET ${sets.join(", ")} WHERE board_id = ? AND id = ?`,
    params,
  );
  broadcast(body.board_id, {
    type: "structure-update",
    node_id: body.node_id,
  });
  return { ok: true };
}

export function handleSetNodeStatus(body: any) {
  // Status validation (the enum check) lives in the MCP tool's input schema in
  // server.ts. The broker accepts any string here so tests can lock that
  // behavior in across modularization.
  const cur = db
    .prepare("SELECT status FROM nodes WHERE board_id = ? AND id = ?")
    .get(body.board_id, body.node_id) as { status: string } | null;
  const oldStatus = cur?.status;

  updateNodeStatus.run(body.status, body.board_id, body.node_id);

  // Log the transition as a system thread entry only when the status
  // actually changed — re-applying the same status is a no-op.
  let changed = false;
  if (oldStatus && oldStatus !== body.status) {
    changed = true;
    insertThread.run(
      body.board_id,
      body.node_id,
      "system",
      `status_change:${oldStatus}:${body.status}`,
      new Date().toISOString(),
    );
  }

  broadcast(body.board_id, {
    type: "status-update",
    node_id: body.node_id,
    status: body.status,
  });
  if (changed) {
    broadcast(body.board_id, {
      type: "thread-update",
      node_id: body.node_id,
      source: "system",
    });
  }
  syncBoardStatus(body.board_id);
  return { ok: true };
}

export function handleDeleteNode(body: { board_id: string; node_id: string }) {
  if (isDefaultBoard(body.board_id)) {
    return { ok: false, error: DEFAULT_BOARD_LOCKED_ERROR };
  }
  // Soft-delete: set deleted_at on the node and all descendants. Thread items
  // and pending messages are preserved (conversation history is permanent).
  const now = new Date().toISOString();
  const targetId = body.node_id;
  const boardId = body.board_id;

  const exists = db
    .prepare(
      "SELECT id FROM nodes WHERE board_id = ? AND id = ? AND deleted_at IS NULL",
    )
    .get(boardId, targetId) as { id: string } | null;
  if (!exists) return { ok: false, error: "node not found" };

  const allRows = db
    .prepare(
      "SELECT id, parent_id FROM nodes WHERE board_id = ? AND deleted_at IS NULL",
    )
    .all(boardId) as { id: string; parent_id: string | null }[];
  const childrenOf = new Map<string | null, string[]>();
  for (const r of allRows) {
    const list = childrenOf.get(r.parent_id) ?? [];
    list.push(r.id);
    childrenOf.set(r.parent_id, list);
  }
  const toDelete = new Set<string>();
  const stack = [targetId];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (toDelete.has(id)) continue;
    toDelete.add(id);
    for (const c of childrenOf.get(id) ?? []) stack.push(c);
  }

  const placeholders = Array.from(toDelete).map(() => "?").join(",");
  db.run(
    `UPDATE nodes SET deleted_at = ? WHERE board_id = ? AND id IN (${placeholders})`,
    [now, boardId, ...toDelete],
  );
  broadcast(boardId, {
    type: "structure-update",
    deleted: Array.from(toDelete),
  });
  syncBoardStatus(boardId);
  return { ok: true, deleted_count: toDelete.size };
}

export function handleMoveNode(body: {
  board_id: string;
  node_id: string;
  new_parent_id?: string | null;
}) {
  if (isDefaultBoard(body.board_id)) {
    return { ok: false, error: DEFAULT_BOARD_LOCKED_ERROR };
  }
  const boardId = body.board_id;
  const nodeId = body.node_id;
  const newParent = body.new_parent_id ?? null;

  if (newParent === nodeId) {
    return { ok: false, error: "cannot move node under itself" };
  }

  const node = db
    .prepare(
      "SELECT id FROM nodes WHERE board_id = ? AND id = ? AND deleted_at IS NULL",
    )
    .get(boardId, nodeId) as { id: string } | null;
  if (!node) return { ok: false, error: "node not found" };

  if (newParent !== null) {
    const parent = db
      .prepare(
        "SELECT id FROM nodes WHERE board_id = ? AND id = ? AND deleted_at IS NULL",
      )
      .get(boardId, newParent) as { id: string } | null;
    if (!parent) return { ok: false, error: "new_parent_id not found" };

    // Cycle check: walk up from newParent — must not hit nodeId.
    let cursor: string | null = newParent;
    const visited = new Set<string>();
    while (cursor) {
      if (cursor === nodeId) {
        return { ok: false, error: "would create cycle" };
      }
      if (visited.has(cursor)) break;
      visited.add(cursor);
      const row = db
        .prepare("SELECT parent_id FROM nodes WHERE board_id = ? AND id = ?")
        .get(boardId, cursor) as { parent_id: string | null } | null;
      cursor = row?.parent_id ?? null;
    }
  }

  // Append at end of new sibling group.
  const maxRow = db
    .prepare(
      newParent === null
        ? "SELECT MAX(position) AS max_pos FROM nodes WHERE board_id = ? AND parent_id IS NULL"
        : "SELECT MAX(position) AS max_pos FROM nodes WHERE board_id = ? AND parent_id = ?",
    )
    .get(...(newParent === null ? [boardId] : [boardId, newParent])) as
    | { max_pos: number | null }
    | null;
  const newPos = (maxRow?.max_pos ?? -1) + 1;

  db.run(
    "UPDATE nodes SET parent_id = ?, position = ? WHERE board_id = ? AND id = ?",
    [newParent, newPos, boardId, nodeId],
  );
  broadcast(boardId, { type: "structure-update", moved: nodeId });
  return { ok: true };
}

export function handleReorderNode(body: {
  board_id: string;
  node_id: string;
  new_position: number;
}) {
  if (isDefaultBoard(body.board_id)) {
    return { ok: false, error: DEFAULT_BOARD_LOCKED_ERROR };
  }
  const boardId = body.board_id;
  const nodeId = body.node_id;
  const want = body.new_position;

  const me = db
    .prepare(
      "SELECT parent_id, position FROM nodes WHERE board_id = ? AND id = ? AND deleted_at IS NULL",
    )
    .get(boardId, nodeId) as { parent_id: string | null; position: number } | null;
  if (!me) return { ok: false, error: "node not found" };

  const siblings = db
    .prepare(
      me.parent_id === null
        ? "SELECT id FROM nodes WHERE board_id = ? AND parent_id IS NULL AND deleted_at IS NULL ORDER BY position"
        : "SELECT id FROM nodes WHERE board_id = ? AND parent_id = ? AND deleted_at IS NULL ORDER BY position",
    )
    .all(...(me.parent_id === null ? [boardId] : [boardId, me.parent_id])) as
    { id: string }[];

  const ids = siblings.map((s) => s.id).filter((id) => id !== nodeId);
  const clamped = Math.max(0, Math.min(want, ids.length));
  ids.splice(clamped, 0, nodeId);

  const tx = db.transaction(() => {
    for (let i = 0; i < ids.length; i++) {
      db.run(
        "UPDATE nodes SET position = ? WHERE board_id = ? AND id = ?",
        [i, boardId, ids[i]],
      );
    }
  });
  tx();

  broadcast(boardId, { type: "structure-update", reordered: nodeId });
  return { ok: true, position: clamped };
}

export const routes = {
  "/add-concern": handleAddConcern,
  "/add-item": handleAddItem,
  "/update-node": handleUpdateNode,
  "/set-node-status": handleSetNodeStatus,
  "/delete-node": handleDeleteNode,
  "/move-node": handleMoveNode,
  "/reorder-node": handleReorderNode,
};
