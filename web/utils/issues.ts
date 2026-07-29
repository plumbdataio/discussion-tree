// Client side of the issue tracker: types, the broker calls, and the channel
// used to open the modal from anywhere.
//
// WHY A MODAL AND NOT A PAGE — do not "improve" this into a route. The tracker
// is deliberately cross-session, and a page would change document.title, which
// is what the user's time tracking keys off. A modal keeps the title of
// whatever board is underneath, so being cross-session and being measured stay
// compatible. (Full rationale: auto-memory project_issue_tracker_invariants.)

export const ISSUE_OWNERS = ["user", "cc", "external"] as const;
export const ISSUE_STATES = [
  "todo",
  "doing",
  "waiting_decision",
  "waiting_reply",
  "waiting_timing",
  "done",
  "dropped",
] as const;
// How much it matters, kept separate from what it is waiting for — see the
// broker's copy of this list for why one column could not carry both.
export const ISSUE_PRIORITIES = ["low", "mid", "high"] as const;
export type IssueOwner = (typeof ISSUE_OWNERS)[number];
export type IssueState = (typeof ISSUE_STATES)[number];
export type IssuePriority = (typeof ISSUE_PRIORITIES)[number];

// The two axes are independent on purpose: `owner` says who holds the ball and
// `state` says what is happening to it. Collapsing them into one status enum is
// what loses the subject ("blocked" cannot say blocked on whom) — which is also
// why the waiting states name what is awaited and never who.
export const OPEN_STATES: IssueState[] = [
  "todo",
  "doing",
  "waiting_decision",
  "waiting_reply",
  "waiting_timing",
];

export type Issue = {
  id: string;
  title: string;
  body: string;
  owner: IssueOwner;
  state: IssueState;
  priority?: IssuePriority;
  session_id: string | null;
  session_name?: string | null;
  session_cwd?: string | null;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  deleted_at?: string | null;
  /** Messages attached to this issue. 0 = nothing linked yet, not an error. */
  link_count?: number;
  /** Messages on this issue's own thread; 0 means no conversation exists yet. */
  chat_count?: number;
  /** Unread CC messages on that thread — what makes a reply visible in the list. */
  chat_unread?: number;
  /**
   * When the user acknowledged the close. NULL on a closed issue means CC
   * finished it and the user has not seen that yet.
   */
  close_approved_at?: string | null;
};

/**
 * Closed by CC, not yet acknowledged.
 *
 * These are shown regardless of every filter and sorted to the top. That is
 * deliberate: the point of the sign-off is not bookkeeping, it is the moment
 * where "that one is done" registers for someone who delegated the work end to
 * end and would otherwise never be handed anything back. A row that only shows
 * up under the right filter combination cannot do that.
 */
export function isAwaitingApproval(i: Issue): boolean {
  return (i.state === "done" || i.state === "dropped") && !i.close_approved_at;
}

// Declining a close CC made. Not just a state edit: the broker also pushes a
// channel message to the CC that owns the issue, because "I think this is done
// / no it isn't" is a disagreement that has to reach the other side.
export function rejectIssueClose(id: string) {
  return callBroker<{ ok: boolean; error?: string }>("/reject-issue-close", {
    issue_id: id,
  });
}

export function approveIssueClose(id: string) {
  return callBroker<{ ok: boolean; error?: string }>("/approve-issue-close", {
    issue_id: id,
  });
}

export type IssueSession = {
  id: string;
  name: string | null;
  cwd: string | null;
  alive: boolean;
};

export type IssueFilters = {
  owners: IssueOwner[];
  states: IssueState[];
  // Empty means "every session", the same convention the other two axes use.
  // Multi-select because the sessions worth looking at together are rarely one
  // (a repo and its sibling tooling repo, say) and never all.
  sessionIds: string[];
  q: string;
  showDeleted: boolean;
};

// Opening straight onto "what is on my plate" is the point of the view; the
// counts in the filter bar are computed BEFORE these are applied, so nothing is
// ever silently invisible — widening is always one click and one glance away.
export const DEFAULT_FILTERS: IssueFilters = {
  owners: ["user"],
  states: [...OPEN_STATES],
  sessionIds: [],
  q: "",
  showDeleted: false,
};

export function sanitizeFilters(raw: unknown): IssueFilters {
  const f = (raw ?? {}) as Partial<IssueFilters>;
  const owners = Array.isArray(f.owners)
    ? f.owners.filter((o): o is IssueOwner =>
        (ISSUE_OWNERS as readonly string[]).includes(o as string),
      )
    : DEFAULT_FILTERS.owners;
  const states = Array.isArray(f.states)
    ? f.states.filter((s): s is IssueState =>
        (ISSUE_STATES as readonly string[]).includes(s as string),
      )
    : DEFAULT_FILTERS.states;
  return {
    // Empty means unfiltered on every axis — kept as-is rather than widened
    // here. Widening on read used to paper over the view treating an empty
    // owners array as "owner is in the empty set", which showed nothing: saving
    // and reloading silently repaired it, so the bug only appeared once "clear
    // this axis" became an explicit action in the dropdown. The view now reads
    // empty the same way on all three axes, so this no longer compensates.
    owners,
    states,
    sessionIds: Array.isArray(f.sessionIds)
      ? f.sessionIds.filter((s): s is string => typeof s === "string")
      : [],
    q: typeof f.q === "string" ? f.q : "",
    showDeleted: f.showDeleted === true,
  };
}

// Issues filed against no session at all are rare but real (raised before a
// session existed, or deliberately detached). Without a value standing for them
// they would vanish the moment any session was picked, with nothing on screen
// to say why.
export const NO_SESSION = "__none__";

// EMPTY MEANS UNFILTERED — the one rule these three share, and the reason they
// live here as functions rather than inline in the view. Selecting nothing is a
// request to stop narrowing, not a request for rows whose owner is in the empty
// set. Session read it that way and the other two did not, so clearing an axis
// emptied the entire list (2026-07-29); sanitizeFilters widening empties on
// read had been hiding it, since saving and reloading repaired the state.
//
// Kept as three predicates rather than one: each count in the filter bar is
// taken with its OWN axis left out, so a chip never reads 0 merely because it
// is switched off.
export function ownerMatches(i: Issue, f: IssueFilters): boolean {
  return f.owners.length === 0 || f.owners.includes(i.owner);
}
export function stateMatches(i: Issue, f: IssueFilters): boolean {
  return f.states.length === 0 || f.states.includes(i.state);
}
export function sessionMatches(i: Issue, f: IssueFilters): boolean {
  return (
    f.sessionIds.length === 0 ||
    f.sessionIds.includes(i.session_id ?? NO_SESSION)
  );
}

/**
 * Should this row be on screen? All three axes, EXCEPT that a close awaiting
 * sign-off is never filtered out — the default view is owner=user + not-done,
 * which is exactly the combination that would hide a CC-closed issue, i.e. the
 * only rows that need the user.
 */
export function isVisible(i: Issue, f: IssueFilters): boolean {
  if (isAwaitingApproval(i)) return true;
  return ownerMatches(i, f) && stateMatches(i, f) && sessionMatches(i, f);
}

async function callBroker<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  return (await r.json()) as T;
}

// The whole ledger is small (tens to low hundreds of rows) and every filter is
// a cheap predicate, so the view fetches once and filters in the browser. That
// keeps toggling instant and keeps the broker API the same shape the MCP tools
// already use.
export function fetchIssues(includeDeleted: boolean) {
  return callBroker<{ ok: boolean; issues: Issue[] }>("/list-issues", {
    include_closed: true,
    include_deleted: includeDeleted,
  });
}

// actor:"user" is what makes the broker notify the session this is filed
// against. Everything filed through this view is the user's, by definition —
// the flag exists because create-issue is also the MCP tool CC files with, and
// announcing CC's own issue back to CC would be noise.
export function createIssue(fields: Partial<Issue>) {
  return callBroker<{ ok: boolean; issue?: Issue; error?: string }>(
    "/create-issue",
    { ...fields, actor: "user" },
  );
}

// actor:"user" marks every edit made from this UI. It matters for exactly one
// thing: a close the user performs is already known to them and needs no
// sign-off, whereas a close CC performs does. MCP calls omit it and are treated
// as CC.
export function updateIssue(id: string, fields: Partial<Issue>) {
  return callBroker<{ ok: boolean; issue?: Issue; error?: string }>(
    "/update-issue",
    { issue_id: id, actor: "user", ...fields },
  );
}

export function deleteIssue(id: string) {
  return callBroker<{ ok: boolean; error?: string }>("/delete-issue", {
    issue_id: id,
  });
}

export function restoreIssue(id: string) {
  return callBroker<{ ok: boolean; error?: string }>("/restore-issue", {
    issue_id: id,
  });
}

// Where an issue's own thread lives, once it exists.
export type IssueChatLocation = { board_id: string; node_id: string };

// One message in an issue's timeline. `surface` says which of the three kinds
// of container it was said in, which is what decides where a click goes.
export type IssueTimelineMessage = {
  id: number;
  source: "user" | "cc" | string;
  at: string;
  text: string;
  read_at?: string | null;
  surface: "board" | "map" | "diagram" | "unknown";
  container_id: string;
  node_id: string;
  path: string;
  /** Said on this issue's own thread, i.e. where the composer writes. */
  on_issue_thread?: boolean;
};

// One call answers both halves of the view: what has been said about this issue
// anywhere, and where a new message would go. They were briefly two endpoints
// and two modals — reading and writing turned out to be one activity, and
// splitting them made the user choose between two buttons every time.
export function fetchIssueTimeline(issueId: string) {
  return callBroker<{
    ok: boolean;
    error?: string;
    issue?: Issue;
    messages: IssueTimelineMessage[];
    location: IssueChatLocation | null;
    session: IssueSession | null;
  }>("/issue-timeline", { issue_id: issueId });
}

// Blocks until the CC actually picks the message up (the shared user-submission
// path), so "nobody is listening" surfaces here as it does on any board.
export function submitIssueChat(issueId: string, text: string) {
  return callBroker<{
    ok: boolean;
    error?: string;
    reason?: "no_recipient" | "timeout";
    location?: IssueChatLocation;
  }>("/issue-chat-submit", { issue_id: issueId, text });
}

export function fetchIssueSessions() {
  return callBroker<{ ok: boolean; sessions: IssueSession[] }>(
    "/list-issue-sessions",
    {},
  );
}

export function loadFilters() {
  return callBroker<{ ok: boolean; filters: unknown }>("/get-issue-filters", {});
}

export function saveFilters(filters: IssueFilters) {
  return callBroker<{ ok: boolean }>("/set-issue-filters", { filters });
}

// Same open-channel pattern the reservations list uses: the modal is rendered
// once at the app root and every trigger just fires an event, so a trigger does
// not have to own the modal state or sit in the same subtree.
const OPEN_EVENT = "pd-open-issues";
// Fired after any mutation so the sidebar badge re-counts without polling.
const CHANGED_EVENT = "pd-issues-changed";

// focusId opens the tracker ON a specific issue: expanded, and shown even if
// the current filters would exclude it. Following a link and landing on "no
// results" is the one outcome that would make the links not worth having.
export function openIssueTracker(focusId?: string) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent(OPEN_EVENT, { detail: { focusId: focusId ?? null } }),
  );
}

export function subscribeOpenIssueTracker(
  cb: (focusId: string | null) => void,
): () => void {
  if (typeof window === "undefined") return () => {};
  const handler = (e: Event) =>
    cb((e as CustomEvent<{ focusId: string | null }>).detail?.focusId ?? null);
  window.addEventListener(OPEN_EVENT, handler);
  return () => window.removeEventListener(OPEN_EVENT, handler);
}

/**
 * An issue id as written in a message. Matched only inside code spans — the
 * bare-text form appears in sentences ABOUT the format and linkifying those
 * would make the convention undocumentable.
 *
 * The shape follows the real generator (prefix + base36 timestamp + optional
 * hex suffix) rather than a loose "iss_anything": a looser pattern turned every
 * placeholder in an explanation — iss_xxx, iss_yyy — into a link to nothing,
 * which is worse than no link because it looks broken rather than illustrative.
 *
 * The suffix is optional because ids get shortened in prose all the time; the
 * timestamp half is already unique in practice, so a PREFIX match resolves it
 * (see the tracker's focus handling). Existence is not checked here — that
 * would be a lookup per code span on every render.
 */
export const ISSUE_ID_RE = /^iss_[a-z0-9]{6,14}(_[a-f0-9]{8,})?$/i;

export function notifyIssuesChanged() {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(CHANGED_EVENT));
}

export function subscribeIssuesChanged(cb: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  window.addEventListener(CHANGED_EVENT, cb);
  return () => window.removeEventListener(CHANGED_EVENT, cb);
}
