#!/usr/bin/env bun
// discussion-tree StopFailure hook — Bun port of stop-failure-hook.sh.
//
// Fires when a turn ends with an API error (rate limit, "retry also failed",
// auth failure, ...) — i.e. Claude Code STOPPED rather than finished normally
// (StopFailure fires INSTEAD of Stop in that case). Marks the owning session
// "stalled" in the broker so the UI shows a prominent warning in the sidebar +
// header, instead of the user having to watch the CLI to notice the stall.
//
// Message-agnostic by design: ANY error-stop raises the SAME warning. The stall
// clears automatically the moment the session shows life again (next tool use /
// clean Stop / next SessionStart re-attach). transcript_path is forwarded so the
// broker can classify WHY the turn stopped (rate-limit / login-expired /
// transient) from the tail and only auto-continue transient errors.
//
// WHY A PORT. The .sh needs jq + curl and cannot exec on Windows, so on pd-002
// the stall indicator never lights. Bun is spawned directly and needs neither.
// Best-effort — any failure is swallowed (and logged via hook-io) so it never
// affects the session; always exits 0 (observation-only).

import { brokerBaseUrl } from "./broker-url.ts";
import {
  logHookFailure,
  ONCE_PER_TURN_POST,
  postBestEffort,
  readStdin,
  setHookSessionId,
} from "./hook-io.ts";

export async function runStopFailure(
  input: { session_id?: string; transcript_path?: string } = {},
  env: Record<string, string | undefined> = process.env,
): Promise<void> {
  const sid = String(input?.session_id ?? "");
  // Always forwarded, empty string when absent — matches the .sh's --arg tp.
  const transcript = String(input?.transcript_path ?? "");
  if (!sid) return;
  // Once per failed turn, nothing re-sends it (and it drives auto-continue):
  // the long timeout + one retry (hook-io ONCE_PER_TURN_POST).
  await postBestEffort(
    `${brokerBaseUrl(env)}/session-stalled`,
    { cc_session_id: sid, transcript_path: transcript },
    ONCE_PER_TURN_POST,
  );
}

async function main(): Promise<void> {
  try {
    const raw = await readStdin();
    let input: { session_id?: string; transcript_path?: string } = {};
    try {
      input = JSON.parse(raw || "{}");
    } catch {
      /* tolerate empty / malformed stdin */
    }
    setHookSessionId(input?.session_id);
    await runStopFailure(input);
  } catch (e) {
    logHookFailure({ step: "main", error: e });
  } finally {
    process.exit(0);
  }
}

if (import.meta.main) main();
