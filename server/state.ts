// Process-global state shared by handlers + the poll loop. Kept tiny on
// purpose — the only mutable thing is the broker session_id we got back from
// /register; once set, every tool call passes it down to the broker.

let mySessionId: string | null = null;
export const myCwd = process.cwd();

export function setSessionId(id: string) {
  mySessionId = id;
}

export function getSessionId(): string | null {
  return mySessionId;
}

// Tool handlers call this — bails loudly if /register hasn't completed yet
// (which would be a startup-ordering bug, not a recoverable condition).
export function ensureSession(): string {
  if (!mySessionId) throw new Error("Not registered with broker yet");
  return mySessionId;
}
