// Pure helpers shared by multiple handlers. ID generation, position math,
// recursive node insert for create-board, the read-side getBoardView used by
// /api/board/<id> and indirectly by tests.

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

export function generateId(prefix?: string): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let id = "";
  for (let i = 0; i < 8; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return prefix ? `${prefix}_${id}` : id;
}

// Random ID for uploaded files; the timestamp prefix prevents accidental
// re-collisions when two uploads happen in the same millisecond.
export function generateRandomId(prefix: string): string {
  const random = Math.random().toString(36).slice(2, 10);
  return `${prefix}_${Date.now().toString(36)}_${random}`;
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
    .prepare("SELECT alive FROM sessions WHERE id = ?")
    .get(board.session_id) as { alive: number } | null;
  const owner_alive = ownerRow?.alive === 1;
  return { board, nodes, threads: threadsByNode, activity, owner_alive };
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
