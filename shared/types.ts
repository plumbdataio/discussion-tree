// Shared types between broker, MCP server, and frontend.

export type NodeKind = "concern" | "item";
export type NodeStatus =
  | "pending"
  | "discussing"
  | "resolved"
  | "agreed"
  | "adopted"
  | "rejected"
  | "needs-reply"
  | "done";
export type ThreadSource = "user" | "cc" | "system";

// --- Node status classification ---
//
// Two disjoint groups make up the full NodeStatus enum. They are referenced
// by the board-level rollup (discussing vs settled) and by stat counters, so
// keeping them defined as named constants prevents the membership lists from
// drifting between broker, frontend, and any future SQL.
//
// Edit here when introducing a new NodeStatus value: decide which group the
// new value belongs to and add it; every consumer picks up the change
// automatically.

// "Still in motion" — the topic is not yet decided either way. needs-reply
// counts because the assistant is explicitly asking for input.
export const IN_PROGRESS_NODE_STATUSES: readonly NodeStatus[] = [
  "pending",
  "discussing",
  "needs-reply",
];

// "Decided" — a verdict has landed (one option chosen, an option rejected,
// the topic resolved as moot, the action item completed, or consensus
// reached). rejected counts because "we've decided NOT to do X" is also a
// decision and removes the node from the open-questions list.
export const SETTLED_NODE_STATUSES: readonly NodeStatus[] = [
  "adopted",
  "agreed",
  "rejected",
  "resolved",
  "done",
];

export function isSettledNodeStatus(s: NodeStatus | string): boolean {
  return (SETTLED_NODE_STATUSES as readonly string[]).includes(s);
}

// CC-supplied input shapes (used by create_board / add_concern / add_item).

export interface NodeInput {
  id?: string;
  title: string;
  context?: string;
  items?: NodeInput[];
}

export interface BoardStructure {
  title: string;
  concerns: NodeInput[];
}

// Persisted shapes.

export interface Board {
  id: string;
  title: string;
  session_id: string;
  created_at: string;
  closed: number;
  archived?: number;
  is_default?: number;
  status?: BoardStatus;
}

export interface Node {
  board_id: string;
  id: string;
  parent_id: string | null;
  kind: NodeKind;
  title: string;
  context: string;
  status: NodeStatus;
  position: number;
  created_at: string;
  // 1 = auto-created "Board log" concern or the "Structure changes" item
  // beneath it. Frontends should render these with a localized title and
  // hide structural-mutation affordances (delete / drag-reorder / etc).
  is_log?: number;
}

export interface ThreadItem {
  id: number;
  board_id: string;
  node_id: string;
  source: ThreadSource;
  text: string;
  created_at: string;
  read_at?: string | null;
}

// Anchor (= per-session pinned thread item). Stored as `favorites` in the
// DB; the user-facing UI calls them "anchors" / 「アンカー」.
//
// The optional `*_title` / `text` / `source` fields are populated by the
// list / broadcast paths so the UI can render the anchor list without a
// separate fetch per row. They aren't part of the storage schema —
// add_favorite by id alone, the broker joins on the fly.
export interface Favorite {
  id: number;
  session_id: string;
  board_id: string;
  node_id: string;
  thread_item_id: number;
  created_at: string;
  // Enrichment (optional). Present on list / WS responses, absent on
  // the bare store entry that handleAddFavorite returns synchronously.
  board_title?: string;
  concern_title?: string;
  node_title?: string;
  session_name?: string | null;
  text?: string;
  source?: ThreadSource;
  thread_item_created_at?: string;
}

export interface PendingMessage {
  id: number;
  session_id: string;
  board_id: string;
  node_id: string;
  node_path: string;
  text: string;
  created_at: string;
  kind?: string | null;
}

// Broker request/response types.

export interface RegisterRequest {
  pid: number;
  cwd: string;
}
export interface RegisterResponse {
  session_id: string;
}

export interface HeartbeatRequest {
  session_id: string;
}
export interface UnregisterRequest {
  session_id: string;
}

export interface CreateBoardRequest {
  session_id: string;
  structure: BoardStructure;
}
export interface CreateBoardResponse {
  board_id: string;
  url: string;
}

export interface AddConcernRequest {
  session_id: string;
  board_id: string;
  concern: NodeInput;
}
export interface AddItemRequest {
  session_id: string;
  board_id: string;
  concern_id: string;
  item: NodeInput;
  parent_item_id?: string;
}
export interface PostToNodeRequest {
  session_id: string;
  board_id: string;
  node_id: string;
  message: string;
}
export interface SetNodeStatusRequest {
  session_id: string;
  board_id: string;
  node_id: string;
  status: NodeStatus;
}
export interface CloseBoardRequest {
  session_id: string;
  board_id: string;
}

export interface SubmitAnswerRequest {
  board_id: string;
  node_id: string;
  text: string;
}

export interface LogRequestRequest {
  session_id: string;
  title: string;
  blocker: string;
  suggested_change?: string;
  board_id?: string;
}

export interface PollMessagesRequest {
  session_id: string;
}
export interface PollMessagesResponse {
  messages: PendingMessage[];
}

export interface Activity {
  session_id: string;
  state: string;
  board_id?: string;
  node_id?: string;
  message?: string;
  set_at: string;
}

export interface SetActivityRequest {
  session_id: string;
  state?: string;
  board_id?: string;
  node_id?: string;
  message?: string;
}

export interface Session {
  id: string;
  pid: number;
  cwd: string;
  name: string | null;
  alive: number;
  cc_session_id: string | null;
}

// Board-level status. "discussing" and "settled" are automatically managed
// by the broker (derived from node statuses, see SETTLED_NODE_STATUSES);
// "completed" / "withdrawn" / "paused" are set explicitly via
// set_board_status and are NOT touched by node-status changes — they
// represent user-driven lifecycle decisions about the board as a whole.
export type BoardStatus =
  | "discussing"
  | "settled"
  | "completed"
  | "withdrawn"
  | "paused";

// Statuses where the broker auto-recomputes the value from node statuses.
// Set-board-status to anything else (completed / withdrawn / paused) freezes
// the board against auto-recompute.
export const AUTO_BOARD_STATUSES: readonly BoardStatus[] = [
  "discussing",
  "settled",
];

export function isAutoBoardStatus(s: BoardStatus | string): boolean {
  return (AUTO_BOARD_STATUSES as readonly string[]).includes(s);
}

export interface BoardStats {
  open: number; // pending + discussing + needs-reply
  decided: number; // adopted + agreed + rejected + resolved
  needs_reply: number;
  total: number;
}

export interface BoardListItem {
  id: string;
  title: string;
  closed: number;
  status: BoardStatus;
  stats: BoardStats;
  is_default?: number;
  unread_count?: number;
}

export interface SessionListItem {
  id: string;
  name: string | null;
  cwd: string;
  alive: number;
  cc_session_id: string | null;
  // Live in-memory activity entry (working / blocked / etc) if the broker
  // currently has one for this session. Sidebar uses this to show the
  // per-session activity indicator so the user can see at a glance which
  // OTHER sessions are busy while they look at one in particular.
  activity?: Activity | null;
  // Latest context-window free % reported by the CC statusline hook.
  // remaining_pct is 0..100 (already includes the 4% safety margin from
  // statusline-command.sh). null when no report has arrived yet, or
  // when the CC session is dead.
  context_usage?: { remaining_pct: number; set_at: string } | null;
  boards: BoardListItem[];
  archived_boards?: BoardListItem[];
}

export interface SetSessionNameRequest {
  session_id: string;
  name: string;
}

export interface BoardView {
  board: Board;
  nodes: Node[];
  threads: Record<string, ThreadItem[]>;
  activity?: Activity | null;
  owner_alive?: boolean;
  // null when the owning session has no human-set name yet — the frontend
  // falls back to the session id in that case (or just omits the segment).
  owner_session_name?: string | null;
  // null when no CC statusline report has reached the broker yet for
  // this session (e.g. fresh broker, or the CC's first PostToolUse
  // hasn't fired since attach). The board header renders a colored
  // chip from this when present.
  owner_context_usage?: { remaining_pct: number; set_at: string } | null;
}
