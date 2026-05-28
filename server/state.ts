// Process-global state shared by handlers + the poll loop. Kept tiny on
// purpose — the only mutable things are (1) the broker session_id we got
// back from /register and (2) whether the auto-attach to a cc_session_id
// has succeeded yet. Every tool call passes these down to the broker.

let mySessionId: string | null = null;
export const myCwd = process.cwd();

// Auto-attach state. `attachedCcId` is the cc_session_id we've successfully
// bound this broker session to (= boards / messages reclaim has run). A
// non-null value means we're in good shape. `lastAttachFailureNotified`
// flips to true once we've told the user (via channel notify) about a
// failure, so the heartbeat self-healing loop doesn't spam the chat.
let attachedCcId: string | null = null;
let lastAttachFailureNotified = false;

export function setSessionId(id: string) {
  mySessionId = id;
}

export function getSessionId(): string | null {
  return mySessionId;
}

export function setAttachedCcId(id: string | null) {
  attachedCcId = id;
}

export function getAttachedCcId(): string | null {
  return attachedCcId;
}

export function setLastAttachFailureNotified(v: boolean) {
  lastAttachFailureNotified = v;
}

export function getLastAttachFailureNotified(): boolean {
  return lastAttachFailureNotified;
}

// Tool handlers call this — bails loudly if /register hasn't completed yet
// (which would be a startup-ordering bug, not a recoverable condition).
export function ensureSession(): string {
  if (!mySessionId) throw new Error("Not registered with broker yet");
  return mySessionId;
}
