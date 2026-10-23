#!/usr/bin/env bun
// discussion-tree Stop hook — Bun port of tool-activity-clear-hook.sh.
//
// Fires when CC finishes a turn. Clears the auto "working" badge. The broker's
// idle watchdog is disabled, so this POST is the only automatic clear; the UI
// lets the user click a stuck spinner away (/clear-working-activity).
//
// WHY A PORT. The .sh needs bash + jq + curl and cannot exec on Windows. Same
// endpoint and payload as the .sh. Best-effort, always exits 0, prints nothing
// (so it can never emit a Stop decision).

import { brokerBaseUrl } from "./broker-url.ts";
import {
  jqRaw,
  ONCE_PER_TURN_POST,
  postBestEffort,
  runHookMain,
  type HookEnv,
} from "./hook-io.ts";

export async function runToolActivityClear(
  input: Record<string, unknown> = {},
  env: HookEnv = process.env,
): Promise<void> {
  const sid = jqRaw(input.session_id);
  if (!sid) return;
  // Once per turn and nothing re-sends it: a missed clear leaves the "working"
  // spinner stuck (the idle watchdog is disabled), so the long timeout + one
  // retry (hook-io ONCE_PER_TURN_POST).
  await postBestEffort(
    `${brokerBaseUrl(env)}/clear-tool-activity`,
    { cc_session_id: sid },
    ONCE_PER_TURN_POST,
  );
}

if (import.meta.main) runHookMain((input) => runToolActivityClear(input));
