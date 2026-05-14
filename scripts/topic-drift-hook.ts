#!/usr/bin/env bun
// discussion-tree TOPIC-DRIFT hook (recommended: PostToolUse on the
// "post_to_node" tool, OR Stop).
//
// The MCP instructions ask the LLM to push parallel decision points into
// boards (add_concern / create_board) instead of burying them in the CLI
// thread. Instructions alone don't fire deterministically — this hook does.
//
// When the latest assistant turn shows option-presentation patterns AND the
// session already has discussing/settled option-decision boards, this script
// writes a <system-reminder> block to stdout. Claude Code surfaces stdout
// from PostToolUse / Stop hooks into the next turn's context.
//
// Install (claude-code settings.json):
//   {
//     "hooks": {
//       "Stop": [
//         {
//           "matcher": "*",
//           "hooks": [
//             { "type": "command", "command": "bun ~/discussion-tree/scripts/topic-drift-hook.ts" }
//           ]
//         }
//       ]
//     }
//   }
//
// Env:
//   DISCUSSION_TREE_PORT — broker port, default 7898
//   DISCUSSION_TREE_TOPIC_DRIFT_DEBUG=1 — log decision to stderr

import { existsSync, readFileSync } from "node:fs";

const DEBUG = process.env.DISCUSSION_TREE_TOPIC_DRIFT_DEBUG === "1";
function debug(...args: unknown[]) {
  if (DEBUG) console.error("[topic-drift-hook]", ...args);
}

let payload: any;
try {
  payload = JSON.parse(await Bun.stdin.text());
} catch (e) {
  debug("payload parse failed", e);
  process.exit(0);
}

const ccSessionId: string = payload.session_id ?? "";
const transcriptPath: string = payload.transcript_path ?? "";
if (!ccSessionId || !transcriptPath || !existsSync(transcriptPath)) {
  debug("missing session_id or transcript_path", { ccSessionId, transcriptPath });
  process.exit(0);
}

// Read transcript as JSONL (one event per line). Find the most recent
// assistant message that carries non-empty text content.
let assistantText: string | null = null;
try {
  const lines = readFileSync(transcriptPath, "utf-8").trimEnd().split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    let evt: any;
    try {
      evt = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    const role = evt?.message?.role ?? evt?.role;
    if (role !== "assistant") continue;
    const blocks = evt?.message?.content ?? evt?.content ?? [];
    const texts: string[] = [];
    for (const b of blocks) {
      if (typeof b === "string") texts.push(b);
      else if (b?.type === "text" && typeof b.text === "string") texts.push(b.text);
    }
    const joined = texts.join("\n").trim();
    if (joined.length > 0) {
      assistantText = joined;
      break;
    }
  }
} catch (e) {
  debug("transcript read failed", e);
  process.exit(0);
}

if (!assistantText) {
  debug("no assistant text in transcript");
  process.exit(0);
}

// Heuristic option-presentation patterns. The bar is intentionally high
// (multiple distinct alternatives in the same reply) — false positives are
// more annoying than false negatives here. Single bullet lists, numbered
// steps that aren't alternatives, etc. should not trigger.
//
//   1. Three+ enumerated numeric alternatives (1. / 2. / 3.)
//   2. Two+ capital-letter alternatives (A. / B.)
//   3. The string "Option A" / "Option 1" anywhere
//   4. Japanese "案A" / "案 1" style
const optionPatterns: RegExp[] = [
  /(?:^|\n)\s*1\.\s+.{0,300}?\n\s*2\.\s+.{0,300}?\n\s*3\.\s+/s,
  /(?:^|\n)\s*A\.\s+.{0,300}?\n\s*B\.\s+/s,
  /\bOption\s+[A-Z0-9]\b/,
  /案\s*[A-Zａ-ｚア-ンｱ-ﾝ0-9]/,
];
const drift = optionPatterns.some((re) => re.test(assistantText));
if (!drift) {
  debug("no option-presentation pattern matched");
  process.exit(0);
}

// Pull active option-decision boards for this CC session from the broker.
const port = parseInt(process.env.DISCUSSION_TREE_PORT ?? "7898", 10);
let activeBoards: Array<{ id: string; title: string; status: string }> = [];
try {
  const res = await fetch(`http://127.0.0.1:${port}/api/sessions`);
  if (res.ok) {
    const j: any = await res.json();
    const sessions: any[] = j.sessions ?? [];
    const me = sessions.find((s) => s?.cc_session_id === ccSessionId);
    if (me) {
      activeBoards = (me.boards ?? [])
        .filter(
          (b: any) =>
            !b.is_default &&
            (b.status === "discussing" || b.status === "settled"),
        )
        .map((b: any) => ({
          id: b.id,
          title: b.title,
          status: b.status,
        }));
    }
  }
} catch (e) {
  debug("broker fetch failed", e);
  process.exit(0);
}

if (activeBoards.length === 0) {
  debug("no active boards — skip reminder");
  process.exit(0);
}

const list = activeBoards
  .map((b) => `- ${b.id} (${b.status}): ${b.title}`)
  .join("\n");
const reminder =
  `<system-reminder>\n` +
  `[topic-drift] Your last reply enumerated multiple alternatives. ` +
  `If those represent decision points the user needs to evaluate, surface them via ` +
  `add_concern / add_item on an existing board, or create_board for a brand-new topic — ` +
  `do not bury parallel decisions inside the CLI thread.\n\n` +
  `Active option-decision boards for this session:\n${list}\n` +
  `</system-reminder>`;

process.stdout.write(reminder + "\n");
debug("reminder emitted", { boards: activeBoards.length });
