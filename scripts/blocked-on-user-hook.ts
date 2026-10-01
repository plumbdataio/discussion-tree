#!/usr/bin/env bun
// discussion-tree PreToolUse/PostToolUse hook for AskUserQuestion +
// ExitPlanMode — Bun port of blocked-on-user-hook.sh.
//
// Wire this up with matcher "AskUserQuestion|ExitPlanMode" on both PreToolUse
// (arg: start) and PostToolUse (arg: clear). It pings the broker so the UI
// sidebar shows a "blocked: waiting for user" badge — without it the user can
// miss that CC is paused waiting for their input.
//
// WHY A PORT. The .sh needs bash + jq + curl and cannot exec on Windows. Same
// endpoints and payloads as the .sh. Best-effort: every failure is swallowed so
// it never blocks the user-facing prompt; always exits 0.

import { brokerBaseUrl } from "./broker-url.ts";
import { jqRaw, postBestEffort, runHookMain, type HookEnv } from "./hook-io.ts";

export async function runBlockedOnUser(
  mode: string,
  input: Record<string, unknown> = {},
  env: HookEnv = process.env,
): Promise<void> {
  const sid = jqRaw(input.session_id);
  if (!sid) return;
  const base = brokerBaseUrl(env);

  if (mode === "start") {
    // AskUserQuestion has tool_input.question; ExitPlanMode has tool_input.plan.
    // Either works as a short tooltip — take the first one jq's `//` accepts.
    // Only null / false / missing fall through; an EMPTY question string does
    // NOT, so `question: ""` wins over a plan (exactly as the .sh did).
    const ti = input.tool_input;
    const t =
      ti && typeof ti === "object" ? (ti as Record<string, unknown>) : {};
    const absent = (v: unknown) => v === undefined || v === null || v === false;
    const question = jqRaw(absent(t.question) ? t.plan : t.question);
    await postBestEffort(`${base}/blocked-on-user-start`, {
      cc_session_id: sid,
      question,
    });
  } else {
    await postBestEffort(`${base}/blocked-on-user-clear`, { cc_session_id: sid });
  }
}

// `${1:-start}`: a missing or empty arg means start; anything else but "start"
// means clear.
if (import.meta.main) {
  const mode = process.argv[2] || "start";
  runHookMain((input) => runBlockedOnUser(mode, input));
}
