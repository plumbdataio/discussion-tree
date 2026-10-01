#!/usr/bin/env bun
// discussion-tree SubagentStop hook — Bun port of subagent-stop-hook.sh.
//
// Fires when a Task-worker subagent finishes. Tells the broker to drop that
// subagent from the per-session "subagent running" indicator so it stops
// showing without waiting for the timeout backstop.
//
// It is UNKNOWN whether SubagentStop stdin carries an agent_id. If it does, we
// forward it so the broker drops exactly that subagent; if it doesn't, the
// broker drops all still-running subagents for the session (a genuinely-live
// sibling re-registers on its next tool call). Either way correctness never
// depends on agent_id being present.
//
// WHY A PORT. The .sh needs bash + jq + curl and cannot exec on Windows. Same
// endpoint and payload as the .sh. Best-effort, always exits 0.

import { brokerBaseUrl } from "./broker-url.ts";
import { jqRaw, postBestEffort, runHookMain, type HookEnv } from "./hook-io.ts";

export async function runSubagentStop(
  input: Record<string, unknown> = {},
  env: HookEnv = process.env,
): Promise<void> {
  const sid = jqRaw(input.session_id);
  if (!sid) return;
  const agentId = jqRaw(input.agent_id);
  const body: Record<string, string> = { cc_session_id: sid };
  if (agentId) body.agent_id = agentId;
  await postBestEffort(`${brokerBaseUrl(env)}/subagent-stop`, body);
}

if (import.meta.main) runHookMain((input) => runSubagentStop(input));
