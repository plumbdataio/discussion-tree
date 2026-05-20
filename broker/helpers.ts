// Pure helpers shared by multiple handlers. ID generation, position math,
// recursive node insert for create-board, the read-side getBoardView used by
// /api/board/<id> and indirectly by tests.

import { randomBytes } from "node:crypto";

import type { Board, Node, NodeInput, ThreadItem } from "../shared/types.ts";
import {
  db,
  insertNode,
  selectBoard,
  selectMaxPosChild,
  selectMaxPosRoot,
  selectNodesByBoard,
  selectThreadsByBoard,
} from "./db.ts";
import { activities } from "./activity.ts";

// Board / session / node IDs act as bearer capabilities for /api/board/:id
// and /ws/:id — anyone who learns the ID can fetch and subscribe. So the
// entropy has to be unguessable. 16 random bytes (= 128 bits, 32 hex chars)
// matches the OWASP guidance for session-id-equivalent tokens.
export function generateId(prefix?: string): string {
  const id = randomBytes(16).toString("hex");
  return prefix ? `${prefix}_${id}` : id;
}

// Upload file IDs face the same exposure (the URL is shared with anyone
// viewing the board). Same posture but keep the timestamp prefix for
// human-friendly sorting when browsing the uploads dir on disk.
export function generateRandomId(prefix: string): string {
  const id = randomBytes(12).toString("hex");
  return `${prefix}_${Date.now().toString(36)}_${id}`;
}

export function maxChildPos(
  boardId: string,
  parentId: string | null,
): number {
  const row = (
    parentId == null
      ? selectMaxPosRoot.get(boardId)
      : selectMaxPosChild.get(boardId, parentId)
  ) as { max_pos: number | null } | null;
  return row?.max_pos ?? -1;
}

// Boards are 2-level by design (concern → items). We recurse exactly once
// (concern's items). If a caller smuggles `items` under an item, we drop them
// rather than create an unrenderable third level.
export function insertNodesRecursive(
  boardId: string,
  parentId: string | null,
  kind: "concern" | "item",
  items: NodeInput[],
): void {
  let pos = maxChildPos(boardId, parentId) + 1;
  for (const item of items) {
    const id = item.id || generateId(kind === "concern" ? "c" : "i");
    insertNode.run(
      boardId,
      id,
      parentId,
      kind,
      item.title,
      item.context ?? "",
      "pending",
      pos,
      new Date().toISOString(),
    );
    pos++;
    if (kind === "concern" && item.items && item.items.length > 0) {
      insertNodesRecursive(boardId, id, "item", item.items);
    }
  }
}

export function structureHasSubItems(structure: any): boolean {
  const concerns = structure?.concerns;
  if (!Array.isArray(concerns)) return false;
  for (const c of concerns) {
    const items = c?.items;
    if (!Array.isArray(items)) continue;
    for (const it of items) {
      if (Array.isArray(it?.items) && it.items.length > 0) return true;
    }
  }
  return false;
}

export function getBoardView(boardId: string) {
  const board = selectBoard.get(boardId) as Board | null;
  if (!board) return null;
  const nodes = selectNodesByBoard.all(boardId) as Node[];
  const threads = selectThreadsByBoard.all(boardId) as ThreadItem[];
  const threadsByNode: Record<string, ThreadItem[]> = {};
  for (const t of threads) {
    if (!threadsByNode[t.node_id]) threadsByNode[t.node_id] = [];
    threadsByNode[t.node_id].push(t);
  }
  const activity = activities.get(board.session_id) ?? null;
  const ownerRow = db
    .prepare("SELECT alive, name FROM sessions WHERE id = ?")
    .get(board.session_id) as { alive: number; name: string | null } | null;
  const owner_alive = ownerRow?.alive === 1;
  // Exposed so the frontend can update document.title to a meaningful
  // string like "discussion-tree / <session> / <board>" — that's what
  // Clockify's auto-tracker (and other browser-based time trackers) pick
  // up as the activity description when the tab is the active page.
  const owner_session_name = ownerRow?.name ?? null;
  return {
    board,
    nodes,
    threads: threadsByNode,
    activity,
    owner_alive,
    owner_session_name,
  };
}

export function buildNodePath(boardId: string, nodeId: string): string {
  const nodes = selectNodesByBoard.all(boardId) as Node[];
  const map = new Map<string, Node>();
  for (const n of nodes) map.set(n.id, n);
  const parts: string[] = [];
  let cur: Node | undefined = map.get(nodeId);
  while (cur) {
    parts.unshift(cur.title);
    cur = cur.parent_id ? map.get(cur.parent_id) : undefined;
  }
  return parts.join(" > ");
}
