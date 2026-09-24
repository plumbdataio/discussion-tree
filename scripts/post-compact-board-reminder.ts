#!/usr/bin/env bun
// discussion-tree SessionStart(compact) hook — Bun port of
// post-compact-board-reminder.sh.
//
// Fires right after Claude Code resumes from a context compaction. Emits a
// prompt-style reminder (plain stdout, which Claude Code appends to the next
// assistant turn's context) so the model treats subsequent discussion-tree
// channel pushes as possibly-unfamiliar boards rather than continuations of
// whatever dominated the pre-compact conversation. Also, best-effort:
//   - clears the "compacting" badge the PreCompact hook set,
//   - resets the context-free meter to 100% (transient placeholder until the
//     next PostToolUse reports the real post-compact free %),
//   - emits a COUNT-ONLY unfinished-checklist nudge,
//   - emits an issue-link review nudge for the window that was just compacted.
//
// WHY A PORT. The .sh needs bash + jq + curl + date and cannot exec on Windows,
// so on pd-002 the whole post-compact reminder is a no-op. Bun is spawned
// directly and needs none of them. This mirrors the .sh byte-for-byte: same
// static notice text, same endpoints, same payloads, same conditional nudges,
// all best-effort (every failure swallowed; the static notice always prints).

import * as fs from "node:fs";
import { brokerBaseUrl } from "./broker-url.ts";

// The unconditional static notice. Reproduces the .sh's `cat <<'EOF' ... EOF`
// exactly, including the trailing newline after the final line.
const STATIC_NOTICE = `[discussion-tree post-compact notice]
You just resumed from a compacted conversation, so your memory of each
discussion-tree board's full thread history is likely faded.

From here on, whenever a <channel source="discussion-tree" ...>
message arrives for a board / node you do NOT clearly remember (or
about which you feel uncertain):

1. Before answering, refresh your context on that specific board by
   calling get_board(board_id=<that id>) and reading the thread items
   on the target node.
2. If relevant, also look at the node's parent concern and at sibling
   concerns / nodes on the same board to understand the surrounding
   discussion.
3. Only then post your reply.

Do NOT respond based on assumptions, pattern-matching to other boards,
or the topic that dominated the conversation right before the compact.
Different boards usually discuss completely different things — mixing
them up confuses the user badly.

The same applies to MAPS (the divergence-graph view): your mental
picture of a map's nodes / edges / positions is stale after a compact,
AND the user's structural edits (drags, new/removed edges, deleted
nodes) are silent by design. So when a <channel ... kind="map_chat">
message arrives, ALWAYS call get_map(map_id=<that id>) to reload the
current graph before you add nodes, draw edges, or reply — never act on
a remembered shape of the map.
`;

// The two conditional nudges, reproducing the .sh's printf format strings
// byte-for-byte (leading \n separator, single-line body, trailing \n).
function checklistNotice(count: number): string {
  return (
    `\n[discussion-tree unfinished-checklist notice]\n` +
    `You own ${count} board(s) with a decision checklist that still has open ` +
    `items (status pending / in-progress). This is a COUNT-ONLY reminder so the ` +
    `checklist is not forgotten across the compact — no action is required right ` +
    `now. If you want to act on them, call list_boards and get_board on the ` +
    `relevant board(s); otherwise carry on.\n`
  );
}

function reviewNotice(rcount: number): string {
  return (
    `\n[discussion-tree issue-link review]\n` +
    `${rcount} message(s) from the window you just compacted are not attached ` +
    `to any issue. That window is the part you can no longer read, so linking it ` +
    `now is what makes the conversation for an issue followable later.\n\n` +
    `Call review_message_links (defaults to exactly this window) and, for each ` +
    `message that belongs to an issue, link_message_to_issues. Messages that ` +
    `genuinely belong to none need no action — this is a nudge, not a block, so ` +
    `use your judgement and carry on.\n`
  );
}

// Best-effort POST that returns the parsed JSON response, or {} on any failure
// (connection error / timeout / non-JSON body). Mirrors the .sh's
// `curl ... || echo '{}'` piped into jq. Never throws.
async function postJson(
  url: string,
  body: unknown,
  timeoutMs = 1000,
): Promise<Record<string, unknown>> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const j = (await res.json()) as unknown;
    return j && typeof j === "object" ? (j as Record<string, unknown>) : {};
  } catch {
    return {};
  } finally {
    clearTimeout(t);
  }
}

export async function runPostCompact(
  input: { session_id?: string } = {},
  env: Record<string, string | undefined> = process.env,
): Promise<string> {
  // The static notice is unconditional — it prints even with no session_id,
  // exactly as the .sh's `cat` runs before the session_id check.
  let out = STATIC_NOTICE;
  const sid = String(input?.session_id ?? "");
  if (!sid) return out;

  const base = brokerBaseUrl(env);

  // Clear the "compacting" badge; the broker hands back the PREVIOUS compaction
  // boundary, which is the start of the window that now needs reviewing.
  const doneResp = await postJson(`${base}/session-compacting-done`, {
    cc_session_id: sid,
  });
  const prev =
    typeof doneResp.previous_compact_at === "string"
      ? doneResp.previous_compact_at
      : "";

  // Reset the context-free meter to 100% (transient placeholder; the next
  // PostToolUse overwrites it with the real post-compact free %).
  await postJson(`${base}/report-context-usage`, {
    cc_session_id: sid,
    remaining_pct: 100,
  });

  // Count-only unfinished-checklist nudge.
  const clResp = await postJson(`${base}/get-incomplete-checklists`, {
    cc_session_id: sid,
  });
  const count = Number(clResp.count ?? 0);
  if (Number.isInteger(count) && count > 0) out += checklistNotice(count);

  // Issue-link review over the window that was just compacted. `from` = the
  // previous compaction boundary, else the last day (never all of history).
  // The .sh's date format has no milliseconds and a trailing Z.
  const fallback = new Date(Date.now() - 24 * 60 * 60 * 1000)
    .toISOString()
    .replace(/\.\d{3}Z$/, "Z");
  const from = prev || fallback;
  const rbody: Record<string, unknown> = {
    cc_session_id: sid,
    unlinked_only: true,
    head_chars: 60,
  };
  if (from) rbody.from = from;
  const rResp = await postJson(`${base}/review-message-links`, rbody, 2000);
  const rcount = Number(rResp.total ?? 0);
  if (Number.isInteger(rcount) && rcount > 0) out += reviewNotice(rcount);

  return out;
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
  let out = STATIC_NOTICE;
  try {
    const raw = await readStdin();
    let input: { session_id?: string } = {};
    try {
      input = JSON.parse(raw || "{}");
    } catch {
      /* tolerate empty / malformed stdin */
    }
    out = await runPostCompact(input);
  } catch {
    /* best-effort: the static notice still prints below */
  }
  // Synchronous write to fd 1 guarantees the bytes flush before process.exit.
  try {
    fs.writeSync(1, out);
  } catch {
    /* nothing we can do */
  }
  process.exit(0);
}

if (import.meta.main) main();
