#!/usr/bin/env bun
// discussion-tree PreToolUse hook — Bun port of tool-activity-hook.sh.
//
// Pings the broker on every tool invocation so the UI can show a "working"
// activity badge automatically — the user no longer has to rely on the LLM
// remembering to call set_activity. The broker times the badge out a few
// seconds after the last ping so it disappears when CC goes idle.
//
// Wire this up as a PreToolUse hook (no matcher). Best-effort — any failure
// (broker down, etc.) is swallowed so it never blocks tool use. Runs on EVERY
// tool call, so it stays lean: no fs, at most two POSTs, each capped at 1s.
//
// WHY A PORT. The .sh needs bash + jq + curl and cannot exec on Windows, so on
// pd-002 the working badge, the subagent indicator and the BG-task marker never
// light. Same endpoints and payloads as the .sh.

import { brokerBaseUrl } from "./broker-url.ts";
import { jqRaw, postBestEffort, runHookMain, type HookEnv } from "./hook-io.ts";

export async function runToolActivity(
  input: Record<string, unknown> = {},
  env: HookEnv = process.env,
): Promise<void> {
  const sid = jqRaw(input.session_id);
  if (!sid) return;
  const base = brokerBaseUrl(env);

  // A SUBAGENT (Task worker) tool call fires THIS SAME hook, under the parent's
  // session_id — but its stdin carries an agent_id that the parent's own tool
  // calls never do. Detection is purely the PRESENCE of agent_id. agent_type is
  // ALSO forwarded: a real subagent's is a non-empty string (e.g.
  // "general-purpose") while transient harness "helper" subagents send an empty
  // agent_type; the broker uses that to register only real subagents
  // (empty-type helpers never get a SubagentStop and would leak).
  //
  // Subagent branch: DON'T ping /heartbeat-tool (that would spin the PARENT's
  // working badge for the subagent's work). Record a per-subagent heartbeat so
  // the UI shows a distinct "subagent running" indicator, then stop — the
  // BG-task tracking below is a parent-only concern.
  const agentId = jqRaw(input.agent_id);
  if (agentId) {
    await postBestEffort(`${base}/heartbeat-subagent`, {
      cc_session_id: sid,
      agent_id: agentId,
      agent_type: jqRaw(input.agent_type),
    });
    return;
  }

  const tool = jqRaw(input.tool_name);
  await postBestEffort(`${base}/heartbeat-tool`, { cc_session_id: sid, tool });

  // Track Bash run_in_background launches so the UI can show a BG marker next
  // to the working spinner. The broker holds a per-session set of in-flight BG
  // task tokens (the launching tool_use_id); the bg-task-reconcile Stop hook or
  // report_bg_task_done clears them. `jq -r '... // false'` = "true" only for a
  // JSON true (or the string "true").
  if (tool !== "Bash") return;
  const ti = input.tool_input;
  if (!ti || typeof ti !== "object") return;
  const bg = (ti as Record<string, unknown>).run_in_background;
  if (jqRaw(bg) !== "true") return;
  const tu = jqRaw(input.tool_use_id);
  if (!tu) return;
  await postBestEffort(`${base}/bg-task-start`, {
    cc_session_id: sid,
    task_id: tu,
  });
}

if (import.meta.main) runHookMain((input) => runToolActivity(input));
