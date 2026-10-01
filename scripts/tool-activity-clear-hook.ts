#!/usr/bin/env bun
// discussion-tree Stop hook — Bun port of tool-activity-clear-hook.sh.
//
// Fires when CC finishes a turn. Clears the auto "working" badge immediately
// instead of waiting for the broker's idle-timeout watchdog. The watchdog is
// still kept around as a safety net (in case CC crashes and Stop never fires).
//
// WHY A PORT. The .sh needs bash + jq + curl and cannot exec on Windows. Same
// endpoint and payload as the .sh. Best-effort, always exits 0, prints nothing
// (so it can never emit a Stop decision).

import { brokerBaseUrl } from "./broker-url.ts";
import { jqRaw, postBestEffort, runHookMain, type HookEnv } from "./hook-io.ts";

export async function runToolActivityClear(
  input: Record<string, unknown> = {},
  env: HookEnv = process.env,
): Promise<void> {
  const sid = jqRaw(input.session_id);
  if (!sid) return;
  await postBestEffort(`${brokerBaseUrl(env)}/clear-tool-activity`, {
    cc_session_id: sid,
  });
}

if (import.meta.main) runHookMain((input) => runToolActivityClear(input));
