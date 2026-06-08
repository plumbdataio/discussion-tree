// Decision-checklist mutation handlers. The checklist UI is read-only; all
// writes flow through these two endpoints, called by the record_decision /
// update_decision MCP tools. Each row in checklist_items is one tracked
// decision under a node flagged is_checklist=1.

import { isSettledNodeStatus } from "../shared/types.ts";
import {
  db,
  insertChecklistSource,
  insertPending,
  recomputeBoardStatus,
} from "./db.ts";
import { broadcast } from "./ws.ts";

const insertItem = db.prepare(
  `INSERT INTO checklist_items (board_id, node_id, summary, status, drop_reason, source_node_id, position, created_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
);
const selectItem = db.prepare(`SELECT * FROM checklist_items WHERE id = ?`);
const selectMaxPos = db.prepare(
  `SELECT MAX(position) AS m FROM checklist_items WHERE board_id = ? AND node_id = ?`,
);
const updateItem = db.prepare(
  `UPDATE checklist_items SET summary = ?, status = ?, drop_reason = ? WHERE id = ?`,
);
const selectNode = db.prepare(
  `SELECT id, is_checklist FROM nodes WHERE board_id = ? AND id = ? AND deleted_at IS NULL`,
);
const setNodeChecklist = db.prepare(
  `UPDATE nodes SET is_checklist = ? WHERE board_id = ? AND id = ? AND deleted_at IS NULL`,
);
const selectChecklistNodeOnBoard = db.prepare(
  `SELECT id FROM nodes WHERE board_id = ? AND is_checklist = 1 AND deleted_at IS NULL ORDER BY position LIMIT 1`,
);
const selectBoardOwnerTitle = db.prepare(
  `SELECT session_id, title FROM boards WHERE id = ?`,
);
const selectNodeTitle = db.prepare(
  `SELECT title FROM nodes WHERE board_id = ? AND id = ?`,
);
const selectThreadCount = db.prepare(
  `SELECT COUNT(*) AS c FROM thread_items WHERE board_id = ? AND node_id = ?`,
);

const VALID_STATUS = new Set(["pending", "in-progress", "done", "dropped"]);

const VALID_SOURCE_KIND = new Set(["board", "node", "message"]);
const selectBoardExists = db.prepare(`SELECT 1 AS x FROM boards WHERE id = ?`);
const selectNodeExists = db.prepare(
  `SELECT 1 AS x FROM nodes WHERE board_id = ? AND id = ? AND deleted_at IS NULL`,
);
const selectNodeBoards = db.prepare(
  `SELECT board_id FROM nodes WHERE id = ? AND deleted_at IS NULL`,
);
const selectThreadItemBoard = db.prepare(
  `SELECT board_id FROM thread_items WHERE id = ?`,
);

type SourceInput = { kind?: string; id?: string | number; board?: string };
type ResolvedSource = { kind: string; ref_id: string; board_id: string };

// Validate + resolve each source ref to its owning board up-front, so a
// record_decision writes nothing if any ref is bad (catches typos). A ref is
// the lowest-level pointer only. board ids and message ids (thread_items.id)
// are globally unique. node ids are NOT, so a node ref resolves by global
// uniqueness: `board` disambiguates when given; without it we auto-fill the
// board when the id exists on exactly one board, and reject when it collides
// across boards (the caller must then specify board). The resolved board_id is
// stored, so the citation stays unambiguous even if a same-id node appears on
// another board later.
function resolveSources(
  raw: SourceInput[],
): { ok: true; resolved: ResolvedSource[] } | { ok: false; error: string } {
  const resolved: ResolvedSource[] = [];
  for (const s of raw) {
    const kind = String(s.kind ?? "").trim();
    const refId = String(s.id ?? "").trim();
    if (!VALID_SOURCE_KIND.has(kind)) {
      return {
        ok: false,
        error: `invalid source kind '${kind}' (expected board|node|message)`,
      };
    }
    if (!refId) return { ok: false, error: "source id is required" };
    if (kind === "board") {
      if (!selectBoardExists.get(refId)) {
        return { ok: false, error: `source board not found: ${refId}` };
      }
      resolved.push({ kind, ref_id: refId, board_id: refId });
    } else if (kind === "node") {
      if (s.board) {
        const boardId = String(s.board);
        if (!selectNodeExists.get(boardId, refId)) {
          return {
            ok: false,
            error: `source node not found: ${refId} on board ${boardId}`,
          };
        }
        resolved.push({ kind, ref_id: refId, board_id: boardId });
      } else {
        const boards = selectNodeBoards.all(refId) as { board_id: string }[];
        if (boards.length === 0) {
          return { ok: false, error: `source node not found: ${refId}` };
        }
        if (boards.length > 1) {
          return {
            ok: false,
            error: `source node id '${refId}' exists on ${boards.length} boards — can't uniquely identify it; specify board to disambiguate (sources=[{kind:"node", id:"${refId}", board:"bd_..."}])`,
          };
        }
        resolved.push({ kind, ref_id: refId, board_id: boards[0].board_id });
      }
    } else {
      // message: ref_id is a globally-unique thread_items.id; derive its board.
      const row = selectThreadItemBoard.get(Number(refId)) as
        | { board_id: string }
        | undefined;
      if (!row) return { ok: false, error: `source message not found: ${refId}` };
      resolved.push({ kind, ref_id: refId, board_id: row.board_id });
    }
  }
  return { ok: true, resolved };
}

// Append a decision to a checklist node as a new pending item. The node must
// exist on the board and be flagged is_checklist=1 (created via a normal
// node + the is_checklist property) — we don't auto-create checklist nodes.
export function handleRecordDecision(body: {
  board_id?: string;
  node_id?: string;
  summary?: string;
  source_node_id?: string | null;
  sources?: SourceInput[];
}): { ok: boolean; item_id?: number; error?: string } {
  const { board_id, node_id } = body;
  const summary = body.summary?.trim();
  if (!board_id || !node_id || !summary) {
    return { ok: false, error: "board_id, node_id and summary are required" };
  }
  const node = selectNode.get(board_id, node_id) as
    | { is_checklist: number }
    | undefined;
  if (!node) return { ok: false, error: "node not found" };
  if (!node.is_checklist) {
    return {
      ok: false,
      error:
        "node is not a checklist node (is_checklist=0). Flag a node as a checklist node first.",
    };
  }
  // Structured sources take precedence; source_node_id is a node shorthand.
  // Resolve before writing anything so a bad ref leaves no orphan item.
  const rawSources: SourceInput[] =
    Array.isArray(body.sources) && body.sources.length > 0
      ? body.sources
      : body.source_node_id
        ? [{ kind: "node", id: body.source_node_id }]
        : [];
  const resolution = resolveSources(rawSources);
  if (!resolution.ok) return { ok: false, error: resolution.error };

  const pos =
    (((selectMaxPos.get(board_id, node_id) as { m: number | null }).m) ?? -1) +
    1;
  const now = new Date().toISOString();
  const res = insertItem.run(
    board_id,
    node_id,
    summary,
    "pending",
    null,
    body.source_node_id ?? null,
    pos,
    now,
  );
  const itemId = Number(res.lastInsertRowid);
  resolution.resolved.forEach((s, i) => {
    insertChecklistSource.run(itemId, s.board_id, s.kind, s.ref_id, i, now);
  });
  broadcast(board_id, { type: "structure-update" });
  return { ok: true, item_id: itemId };
}

// Update a checklist item: change status, edit the summary, and/or set a
// drop reason. status=dropped requires a non-empty drop_reason (the only
// place this is enforced — the UI can't edit at all). Moving OFF dropped
// clears the reason.
export function handleUpdateDecision(body: {
  item_id?: number;
  status?: string;
  summary?: string;
  drop_reason?: string;
}): { ok: boolean; error?: string } {
  if (body.item_id == null) {
    return { ok: false, error: "item_id is required" };
  }
  const cur = selectItem.get(body.item_id) as
    | {
        id: number;
        board_id: string;
        summary: string;
        status: string;
        drop_reason: string | null;
      }
    | undefined;
  if (!cur) return { ok: false, error: "checklist item not found" };

  const nextStatus = body.status ?? cur.status;
  if (!VALID_STATUS.has(nextStatus)) {
    return {
      ok: false,
      error: `invalid status '${nextStatus}' (expected pending|in-progress|done|dropped)`,
    };
  }
  const trimmed = body.summary?.trim();
  const nextSummary = trimmed ? trimmed : cur.summary;

  let nextReason: string | null;
  if (nextStatus === "dropped") {
    const reason = body.drop_reason?.trim() || cur.drop_reason || "";
    if (!reason) {
      return { ok: false, error: "drop_reason is required when status=dropped" };
    }
    nextReason = reason;
  } else {
    // A non-dropped item carries no drop reason.
    nextReason = null;
  }

  updateItem.run(nextSummary, nextStatus, nextReason, body.item_id);
  broadcast(cur.board_id, { type: "structure-update" });
  // An item reaching done/dropped can complete a settled board (see
  // recomputeBoardStatus). Re-derive + broadcast the board status so the
  // sidebar / header reflect a completion without waiting for a node change.
  const boardStatus = recomputeBoardStatus(cur.board_id);
  if (boardStatus) {
    broadcast(cur.board_id, {
      type: "board-status-update",
      status: boardStatus,
    });
  }
  return { ok: true };
}

// Flag (or unflag) an existing ordinary node as a decision-checklist node.
// Checklist nodes are made deliberately (never auto-created) — this is how a
// normal node gains its checklist_items list. is_checklist defaults to true.
export function handleSetNodeChecklist(body: {
  board_id?: string;
  node_id?: string;
  is_checklist?: boolean;
}): { ok: boolean; error?: string } {
  const { board_id, node_id } = body;
  if (!board_id || !node_id) {
    return { ok: false, error: "board_id and node_id are required" };
  }
  const node = selectNode.get(board_id, node_id) as { id: string } | undefined;
  if (!node) return { ok: false, error: "node not found" };
  const promoting = body.is_checklist !== false;
  if (promoting) {
    // The read-only checklist UI (ChecklistCard) renders title / context /
    // checklist_items but NOT the node's conversation thread. Flagging a node
    // that already has messages would hide them in the UI (they stay in the
    // DB / get_board, just aren't shown) — a footgun. Refuse; the caller
    // should make a FRESH node with add_item and flag that instead.
    const tc = selectThreadCount.get(board_id, node_id) as { c: number };
    if (tc.c > 0) {
      return {
        ok: false,
        error: `node has ${tc.c} conversation message(s) that the read-only checklist UI does not render — flagging it would hide them. Create a fresh node with add_item and flag THAT as the checklist node instead.`,
      };
    }
  }
  setNodeChecklist.run(promoting ? 1 : 0, board_id, node_id);
  broadcast(board_id, { type: "structure-update" });
  return { ok: true };
}

// Fire-once when a board that carries a checklist node rolls up to "settled":
// remind the owner session to reconcile the checklist and leave a memory
// pointer (so the link survives a compact). Called from syncBoardStatus on a
// genuine transition INTO settled. Delivered as a pending_message with a
// dedicated kind so poll.ts pushes it as a plain channel note (no UI-mirror
// reminder appended) and WITHOUT bumping the unanswered-post counter
// (insertPending alone doesn't touch it — only handleSubmitAnswer does).
export function onBoardSettled(boardId: string): void {
  const cn = selectChecklistNodeOnBoard.get(boardId) as
    | { id: string }
    | undefined;
  if (!cn) return; // no checklist node on this board — nothing to remind about
  const board = selectBoardOwnerTitle.get(boardId) as
    | { session_id: string; title: string }
    | undefined;
  if (!board) return;
  const text =
    `[discussion-tree] このボード「${board.title}」が settled になりました。\n` +
    `1. チェックリストノード(${cn.id})に、この議論で決まったことが record_decision で全て反映されているか最終確認を。\n` +
    `2. 今後、別のボードや general でこのチェックリストの管理対象に当たる話が出たら、必ず ${cn.id} に追加すること。\n` +
    `3. 以降 discussion-tree 側の自動リマインダは効きません(特に compact を跨ぐと board ごと忘れます)。必要なら「${board.title}のチェックリストは ${boardId}/${cn.id} にあり」とメモリに簡潔な pointer を残すこと。`;
  insertPending.run(
    board.session_id,
    boardId,
    cn.id,
    "", // node_path — not a user reply, no path needed
    text,
    new Date().toISOString(),
    "checklist_settled",
  );
}

// Fire when an individual node lands on a verdict (adopted / agreed /
// resolved / rejected / done) on a board that carries a checklist node:
// remind the owner to record THAT decision into the checklist now. The
// board-level onBoardSettled (above) is the final reconciliation; this is the
// incremental nudge as each decision lands. Same dedicated-kind / no-counter
// delivery. Skips the checklist node settling on itself. Wording is
// intentionally simple — tune in operation.
export function onNodeSettled(
  boardId: string,
  nodeId: string,
  status: string,
): void {
  if (!isSettledNodeStatus(status)) return;
  const cn = selectChecklistNodeOnBoard.get(boardId) as
    | { id: string }
    | undefined;
  if (!cn) return; // no checklist node on this board
  if (cn.id === nodeId) return; // the checklist node settling isn't a "record this" event
  const board = selectBoardOwnerTitle.get(boardId) as
    | { session_id: string }
    | undefined;
  if (!board) return;
  const node = selectNodeTitle.get(boardId, nodeId) as
    | { title: string }
    | undefined;
  const title = node?.title ?? nodeId;
  const text =
    `[discussion-tree] ノード「${title}」の決定が確定しました。` +
    `この決定を record_decision(board_id="${boardId}", node_id="${cn.id}", summary=<「〜であること」型の検証可能な1行>, sources=[{kind:"node", id:"${nodeId}", board:"${boardId}"}]) でチェックリストに反映してください。` +
    `出典(sources)は最下層の参照だけでよく、kind は board/node/message から選べます。node の board は省略可(全ボードで一意なら自動補完、衝突する時だけ要指定)。特定メッセージを引くなら post_to_node の戻り値や受信メタの message_id を {kind:"message", id:<その id>} で指定。`;
  insertPending.run(
    board.session_id,
    boardId,
    cn.id,
    "",
    text,
    new Date().toISOString(),
    "checklist_node_settled",
  );
}

export const routes = {
  "/record-decision": handleRecordDecision,
  "/update-decision": handleUpdateDecision,
  "/set-node-checklist": handleSetNodeChecklist,
};
