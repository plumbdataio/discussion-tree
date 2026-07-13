// Pure helpers shared by multiple handlers. ID generation, position math,
// recursive node insert for create-board, the read-side getBoardView used by
// /api/board/<id> and indirectly by tests.

import { randomBytes } from "node:crypto";

import type {
  Board,
  ChecklistItem,
  ChecklistItemSource,
  ChecklistSourcePreview,
  Node,
  NodeInput,
  ThreadItem,
  ThreadSource,
} from "../shared/types.ts";
import {
  db,
  insertNode,
  selectBoard,
  selectChecklistItemsByNode,
  selectChecklistSourcesByItem,
  selectMaxPosChild,
  selectMaxPosRoot,
  selectNodesByBoard,
  selectThreadsByBoard,
} from "./db.ts";
import { activities } from "./activity.ts";
import { getContextUsage } from "./context-usage.ts";
import { bgTaskCountForSession } from "./activity.ts";
import { ensureBoardLogNode } from "./structure-log.ts";

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

// --- Checklist source previews ---
// Resolve what a source points at so the UI can show the cited content, not
// just a link. Read-only; results are attached to the source, never stored.
const previewBoard = db.prepare(`SELECT title FROM boards WHERE id = ?`);
const previewNode = db.prepare(
  `SELECT title, context FROM nodes WHERE board_id = ? AND id = ? AND deleted_at IS NULL`,
);
const previewMessage = db.prepare(
  `SELECT text, source FROM thread_items WHERE id = ?`,
);

function buildSourcePreview(s: ChecklistItemSource): ChecklistSourcePreview {
  const boardRow = previewBoard.get(s.board_id) as { title: string } | undefined;
  const board_title = boardRow?.title;
  if (s.kind === "board") {
    const b = previewBoard.get(s.ref_id) as { title: string } | undefined;
    return b ? { title: b.title } : { missing: true };
  }
  if (s.kind === "node") {
    const n = previewNode.get(s.board_id, s.ref_id) as
      | { title: string; context: string | null }
      | undefined;
    return n
      ? { title: n.title, text: n.context || undefined, board_title }
      : { missing: true, board_title };
  }
  // message: ref_id is a thread_items.id
  const m = previewMessage.get(Number(s.ref_id)) as
    | { text: string; source: string }
    | undefined;
  return m
    ? { text: m.text, source: m.source as ThreadSource, board_title }
    : { missing: true, board_title };
}

export function getBoardView(boardId: string) {
  const board = selectBoard.get(boardId) as Board | null;
  if (!board) return null;
  // Lazily ensure the per-board structure-change log concern + item
  // exist before we read nodes. No-op for default boards. Idempotent.
  ensureBoardLogNode(boardId);
  const nodes = selectNodesByBoard.all(boardId) as Node[];
  // Attach the checklist_items array to any decision-checklist node so the
  // frontend can render the list without a second round-trip. Ordinary
  // nodes are left untouched (the property stays absent).
  for (const n of nodes) {
    if (n.is_checklist) {
      const items = selectChecklistItemsByNode.all(
        boardId,
        n.id,
      ) as ChecklistItem[];
      // Attach each item's structured sources (where the decision was made),
      // each enriched with a preview of the cited content.
      for (const it of items) {
        const sources = selectChecklistSourcesByItem.all(
          it.id,
        ) as ChecklistItemSource[];
        for (const s of sources) s.preview = buildSourcePreview(s);
        it.sources = sources;
      }
      n.checklist_items = items;
    }
  }
  const threads = selectThreadsByBoard.all(boardId) as ThreadItem[];
  const threadsByNode: Record<string, ThreadItem[]> = {};
  for (const t of threads) {
    if (!threadsByNode[t.node_id]) threadsByNode[t.node_id] = [];
    threadsByNode[t.node_id].push(t);
  }
  const activity = activities.get(board.session_id) ?? null;
  const ownerRow = db
    .prepare(
      "SELECT alive, name, stalled_at, compacting_at, tmux_pane FROM sessions WHERE id = ?",
    )
    .get(board.session_id) as {
    alive: number;
    name: string | null;
    stalled_at: string | null;
    compacting_at: string | null;
    tmux_pane: string | null;
  } | null;
  const owner_alive = ownerRow?.alive === 1;
  // The owning CC was launched inside tmux (a pane was captured at attach), so
  // the WebUI can inject a TUI command (e.g. /compact) into it via /cli-send.
  const owner_can_cli_send = owner_alive && !!ownerRow?.tmux_pane;
  // The owning CC stopped on an API error — surfaces a header warning.
  const owner_stalled = owner_alive && !!ownerRow?.stalled_at;
  // The owning CC is compacting its context — surfaces a header "compacting"
  // badge (benign, distinct from the stall warning).
  const owner_compacting = owner_alive && !!ownerRow?.compacting_at;
  // Exposed so the frontend can update document.title to a meaningful
  // string like "discussion-tree / <session> / <board>" — that's what
  // Clockify's auto-tracker (and other browser-based time trackers) pick
  // up as the activity description when the tab is the active page.
  const owner_session_name = ownerRow?.name ?? null;
  // Mirror context-meter info onto the board view too — saves the
  // header from doing a second /api/sessions fetch just to read one
  // number per page render.
  const owner_context_usage = getContextUsage(board.session_id);
  const owner_bg_task_count = bgTaskCountForSession(board.session_id);
  const owner_scheduled_count = pendingScheduledCount(board.session_id);
  const owner_timer_confirm_armed = pendingArmedCount(board.session_id) > 0;
  return {
    board,
    nodes,
    threads: threadsByNode,
    activity,
    owner_alive,
    owner_stalled,
    owner_compacting,
    owner_session_name,
    owner_context_usage,
    owner_bg_task_count,
    owner_scheduled_count,
    owner_timer_confirm_armed,
    scheduled: pendingScheduledList(board.id),
    owner_can_cli_send,
  };
}

// Pending (unfired) scheduled messages for a board — rendered pinned at the
// bottom of each node's thread until they fire. Same lazy/no-import posture as
// pendingScheduledCount above.
let _schedListStmt: ReturnType<typeof db.prepare> | null = null;
function pendingScheduledList(
  boardId: string,
): { id: string; node_id: string; text: string; fire_at: string }[] {
  try {
    if (!_schedListStmt)
      _schedListStmt = db.prepare(
        "SELECT id, node_id, text, fire_at FROM scheduled_messages WHERE board_id = ? AND sent_at IS NULL ORDER BY fire_at",
      );
    return _schedListStmt.all(boardId) as {
      id: string;
      node_id: string;
      text: string;
      fire_at: string;
    }[];
  } catch {
    return [];
  }
}

// Pending (unfired) scheduled-message count for the owning session — powers the
// header banner. Lazy-prepared (the scheduled_messages table is created by
// broker/scheduled-messages.ts on its own import) and NOT imported from there,
// to avoid a helpers → scheduled-messages → threads → helpers import cycle.
let _schedCountStmt: ReturnType<typeof db.prepare> | null = null;
export function pendingScheduledCount(sessionId: string): number {
  try {
    if (!_schedCountStmt)
      _schedCountStmt = db.prepare(
        "SELECT COUNT(*) AS n FROM scheduled_messages WHERE session_id = ? AND sent_at IS NULL",
      );
    return (
      (_schedCountStmt.get(sessionId) as { n: number } | undefined)?.n ?? 0
    );
  } catch {
    return 0; // table not present yet (very early call) — treat as none
  }
}

// Count of the session's pending reservations still ARMED for the confirm (see
// confirm_armed in scheduled-messages.ts). Same lazy/no-import posture.
let _schedArmedStmt: ReturnType<typeof db.prepare> | null = null;
export function pendingArmedCount(sessionId: string): number {
  try {
    if (!_schedArmedStmt)
      _schedArmedStmt = db.prepare(
        "SELECT COUNT(*) AS n FROM scheduled_messages WHERE session_id = ? AND sent_at IS NULL AND confirm_armed = 1",
      );
    return (
      (_schedArmedStmt.get(sessionId) as { n: number } | undefined)?.n ?? 0
    );
  } catch {
    return 0;
  }
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
