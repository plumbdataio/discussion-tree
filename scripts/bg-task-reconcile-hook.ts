#!/usr/bin/env bun
// discussion-tree Stop hook — Bun port of bg-task-reconcile-hook.sh
// (auto-clear stale background-task markers).
//
// The PROBLEM this solves: when CC launches a Bash run_in_background task, the
// PreToolUse hook registers it with the broker (the "BG" marker). The broker
// has no way to learn the task finished — the <task-notification
// status=completed> only lands in CC's MESSAGE stream, never in a hook. The
// notification carries TWO ids,
//     <task-id>biyvamak5</task-id>            (short background-shell id)
//     <tool-use-id>toolu_...</tool-use-id>    (the launching Bash tool_use_id)
// and the broker registered the tool_use_id. So at every turn end this reads
// the session transcript — where the completion notifications DO land —
// extracts the <tool-use-id> of every completed background task, and tells the
// broker to clear them in one POST. Idempotent: re-sending already-cleared ids
// is a no-op, so re-scanning the whole transcript each turn is harmless.
//
// WHY A PORT. The .sh needs bash + jq + curl + grep/sed/sort and cannot exec on
// Windows. Same endpoint, payload and matching rules as the .sh's grep pipeline.
// Best-effort: prints nothing (never a Stop decision), always exits 0.

import * as fs from "node:fs";
import { brokerBaseUrl } from "./broker-url.ts";
import { jqRaw, postBestEffort, runHookMain, type HookEnv } from "./hook-io.ts";

// The .sh pipeline, line by line:
//   grep 'task-notification' | grep -E 'status>completed<|status=\\?"completed'
//   | grep -oE 'tool-use-id>(toolu_[A-Za-z0-9_-]+)' | sed 's#.*tool-use-id>##'
//   | sort -u
// Each <task-notification> block is a single jsonl line (its newlines are
// JSON-escaped), so a per-line match carrying BOTH the completed status and the
// tool-use-id is safe.
const NEEDLE = Buffer.from("task-notification", "latin1");
const COMPLETED = /status>completed<|status=\\?"completed/;
const TOOL_USE_ID = /tool-use-id>(toolu_[A-Za-z0-9_-]+)/g;
const CHUNK = 8 * 1024 * 1024;
const NL = 0x0a;

// Transcripts reach 100MB+, so this never decodes the whole file: it reads in
// chunks, finds the (rare) lines containing the needle with a byte search, and
// decodes only those lines. latin1 keeps a byte-per-char view like grep -a; the
// patterns are pure ASCII so multi-byte text elsewhere on the line is harmless.
function scanLines(seg: Buffer, ids: Set<string>): void {
  let pos = 0;
  while (pos < seg.length) {
    const hit = seg.indexOf(NEEDLE, pos);
    if (hit === -1) return;
    const start = seg.lastIndexOf(NL, hit) + 1;
    let end = seg.indexOf(NL, hit);
    if (end === -1) end = seg.length;
    const line = seg.toString("latin1", start, end);
    if (COMPLETED.test(line)) {
      for (const m of line.matchAll(TOOL_USE_ID)) ids.add(m[1]!);
    }
    pos = end + 1;
  }
}

// Unique completed-BG tool_use_ids in the transcript, sorted (sort -u). Order
// is byte order; the broker treats the list as a set.
export function extractCompletedBgTaskIds(transcriptPath: string): string[] {
  const ids = new Set<string>();
  const fd = fs.openSync(transcriptPath, "r");
  try {
    let carry: Buffer = Buffer.alloc(0);
    const chunk = Buffer.allocUnsafe(CHUNK);
    for (;;) {
      const n = fs.readSync(fd, chunk, 0, CHUNK, null);
      if (n <= 0) break;
      const buf: Buffer = carry.length
        ? Buffer.concat([carry, chunk.subarray(0, n)])
        : chunk.subarray(0, n);
      const lastNl = buf.lastIndexOf(NL);
      // The carry is copied because `chunk` is reused by the next read.
      if (lastNl === -1) {
        // No complete line yet (one very long line): keep accumulating.
        carry = Buffer.from(buf);
        continue;
      }
      scanLines(buf.subarray(0, lastNl), ids);
      carry = Buffer.from(buf.subarray(lastNl + 1));
    }
    // A final line without a trailing newline still counts (grep reads it).
    if (carry.length) scanLines(carry, ids);
  } finally {
    fs.closeSync(fd);
  }
  return [...ids].sort();
}

export async function runBgTaskReconcile(
  input: Record<string, unknown> = {},
  env: HookEnv = process.env,
): Promise<void> {
  const sid = jqRaw(input.session_id);
  const transcript = jqRaw(input.transcript_path);
  if (!sid || !transcript) return;
  // `[ -f "$transcript" ]`: must exist and be a regular file (symlinks followed).
  try {
    if (!fs.statSync(transcript).isFile()) return;
  } catch {
    return;
  }
  const ids = extractCompletedBgTaskIds(transcript);
  if (ids.length === 0) return;
  await postBestEffort(`${brokerBaseUrl(env)}/bg-task-done`, {
    cc_session_id: sid,
    task_ids: ids,
  });
}

if (import.meta.main) runHookMain((input) => runBgTaskReconcile(input));
