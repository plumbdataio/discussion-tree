// Client side of the issue tracker: types, the broker calls, and the channel
// used to open the modal from anywhere.
//
// WHY A MODAL AND NOT A PAGE — do not "improve" this into a route. The tracker
// is deliberately cross-session, and a page would change document.title, which
// is what the user's time tracking keys off. A modal keeps the title of
// whatever board is underneath, so being cross-session and being measured stay
// compatible. (Full rationale: auto-memory project_issue_tracker_invariants.)

export const ISSUE_OWNERS = ["user", "cc", "external"] as const;
export const ISSUE_STATES = ["todo", "doing", "done", "dropped"] as const;
export type IssueOwner = (typeof ISSUE_OWNERS)[number];
export type IssueState = (typeof ISSUE_STATES)[number];

// The two axes are independent on purpose: `owner` says who holds the ball and
// `state` says what is happening to it. Collapsing them into one status enum is
// what loses the subject ("blocked" cannot say blocked on whom).
export const OPEN_STATES: IssueState[] = ["todo", "doing"];

export type Issue = {
  id: string;
  title: string;
  body: string;
  owner: IssueOwner;
  state: IssueState;
  session_id: string | null;
  session_name?: string | null;
  session_cwd?: string | null;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  deleted_at?: string | null;
};

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

export function createIssue(fields: Partial<Issue>) {
  return callBroker<{ ok: boolean; issue?: Issue; error?: string }>(
    "/create-issue",
    fields,
  );
}

export function updateIssue(id: string, fields: Partial<Issue>) {
  return callBroker<{ ok: boolean; issue?: Issue; error?: string }>(
    "/update-issue",
    { issue_id: id, ...fields },
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

// One message in an issue's timeline. `surface` says which of the three kinds
// of container it was said in, which is what decides where a click goes.
export type IssueTimelineMessage = {
  id: number;
  source: "user" | "cc" | string;
  at: string;
  text: string;
  surface: "board" | "map" | "diagram" | "unknown";
  container_id: string;
  node_id: string;
  path: string;
};

export function fetchIssueTimeline(issueId: string) {
  return callBroker<{
    ok: boolean;
    error?: string;
    issue?: Issue;
    messages: IssueTimelineMessage[];
  }>("/issue-timeline", { issue_id: issueId });
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

export function openIssueTracker() {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(OPEN_EVENT));
}

export function subscribeOpenIssueTracker(cb: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  window.addEventListener(OPEN_EVENT, cb);
  return () => window.removeEventListener(OPEN_EVENT, cb);
}

export function notifyIssuesChanged() {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(CHANGED_EVENT));
}

export function subscribeIssuesChanged(cb: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  window.addEventListener(CHANGED_EVENT, cb);
  return () => window.removeEventListener(CHANGED_EVENT, cb);
}
