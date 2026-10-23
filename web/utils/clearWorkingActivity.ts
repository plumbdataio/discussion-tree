// Dismiss a session's hook-managed "working" spinner from the UI.
//
// The spinner is normally cleared by the Stop hook's /clear-tool-activity. That
// POST is best-effort and can fail (a remote CC whose hook times out against the
// tailnet broker), and the broker's idle watchdog is intentionally disabled, so
// a missed clear left the spinner spinning forever. Clicking the spinner calls
// the broker's /clear-working-activity with the broker session id: it drops
// only a "working" state (never an explicit one like "blocked") and leaves the
// stall / compacting flags alone. A session that really is still working
// re-lights the spinner on its next tool call. The WS `activity` broadcast
// updates every view, so nothing is returned.
export function clearWorkingActivity(
  sessionId: string,
  doFetch: typeof fetch = fetch,
): Promise<void> {
  if (!sessionId) return Promise.resolve();
  return doFetch("/clear-working-activity", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ session_id: sessionId }),
  }).then(
    () => undefined,
    () => undefined, // best-effort; the next tool call or Stop corrects it
  );
}
