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
// Best-effort — any failure is swallowed so it never affects the session; always
// exits 0 (observation-only).

import { brokerBaseUrl } from "./broker-url.ts";

async function postBestEffort(
  url: string,
  body: unknown,
  timeoutMs = 1000,
): Promise<void> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } catch {
    /* broker down / timeout — swallow, best-effort */
  } finally {
    clearTimeout(t);
  }
}

export async function runStopFailure(
  input: { session_id?: string; transcript_path?: string } = {},
  env: Record<string, string | undefined> = process.env,
): Promise<void> {
  const sid = String(input?.session_id ?? "");
  // Always forwarded, empty string when absent — matches the .sh's --arg tp.
  const transcript = String(input?.transcript_path ?? "");
  if (!sid) return;
  await postBestEffort(`${brokerBaseUrl(env)}/session-stalled`, {
    cc_session_id: sid,
    transcript_path: transcript,
  });
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(data));
  });
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
    await runStopFailure(input);
  } catch {
    /* best-effort: never let the hook throw */
  } finally {
    process.exit(0);
  }
}

if (import.meta.main) main();
