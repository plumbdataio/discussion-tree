#!/usr/bin/env bun
// discussion-tree UserPromptSubmit hook — light the "working" badge the moment
// a turn starts, not at the first tool call.
//
// The PreToolUse hook (tool-activity-hook.ts) only fires once CC calls a tool,
// so a turn spent thinking/answering before any tool showed no badge at all.
// Per the hooks reference, UserPromptSubmit also fires on turns CC starts on its
// own: a message from another session (built-in cross-session messaging), a
// background subagent reporting back, a scheduled task / /loop. That makes it
// the one hook that sees an incoming message start a turn. The badge is cleared
// by the Stop hook exactly as for tool-driven activity.
//
// MUST print nothing: UserPromptSubmit stdout is added to the model's context.
// Best-effort — a broker failure is swallowed and never blocks the prompt.

import { brokerBaseUrl } from "./broker-url.ts";
import {
  jqRaw,
  perToolCallPost,
  postBestEffort,
  runHookMain,
  type HookEnv,
} from "./hook-io.ts";

export async function runPromptActivity(
  input: Record<string, unknown> = {},
  env: HookEnv = process.env,
): Promise<void> {
  const sid = jqRaw(input.session_id);
  if (!sid) return;
  // UserPromptSubmit runs BEFORE the turn starts, so CC waits on it: keep it
  // short (1s loopback / 2s remote), no retry. A miss only delays the spinner
  // to the first tool call's heartbeat.
  const url = `${brokerBaseUrl(env)}/heartbeat-tool`;
  await postBestEffort(url, { cc_session_id: sid, tool: "" }, perToolCallPost(url));
}

if (import.meta.main) runHookMain((input) => runPromptActivity(input));
