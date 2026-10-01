#!/usr/bin/env bun
// discussion-tree PreCompact hook — Bun port of pre-compact-hook.sh.
//
// Fires right before Claude Code compacts its context — both manual (/compact,
// including a /compact the user injected from the WebUI via /cli-send) and auto
// compaction. Marks the owning session "compacting" in the broker so the UI
// shows a distinct badge in the sidebar + header for the duration. Compaction
// runs no tools, so the normal "working" spinner would time out and read as
// idle; this dedicated flag tells the user the session is busy, not stuck.
//
// Cleared on resume by the post-compact SessionStart hook
// (post-compact-board-reminder.ts POSTs /session-compacting-done), or — as a
// self-heal if that never lands — by the next tool heartbeat / re-attach.
//
// WHY A PORT. The .sh needs bash + jq + curl and cannot exec on Windows. Same
// endpoint and payload as the .sh. Best-effort, always exits 0 (never blocks or
// delays compaction).

import { brokerBaseUrl } from "./broker-url.ts";
import { jqRaw, postBestEffort, runHookMain, type HookEnv } from "./hook-io.ts";

export async function runPreCompact(
  input: Record<string, unknown> = {},
  env: HookEnv = process.env,
): Promise<void> {
  const sid = jqRaw(input.session_id);
  if (!sid) return;
  await postBestEffort(`${brokerBaseUrl(env)}/session-compacting`, {
    cc_session_id: sid,
  });
}

if (import.meta.main) runHookMain((input) => runPreCompact(input));
