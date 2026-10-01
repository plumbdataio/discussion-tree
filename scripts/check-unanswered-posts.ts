#!/usr/bin/env bun
// discussion-tree Stop hook — Bun port of check-unanswered-posts.sh.
//
// Prevents the turn from ending while this session has dt posts (a user UI
// submission, or an external notice delivered via /notify-session) that were not
// replied to, and feeds Claude a message naming the unreplied nodes (or telling
// it to call reset_unanswered_posts if the omission is intentional).
//
// Per-node: the broker tracks WHICH (board, node) have an unreplied post
// (unanswered_nodes). A reply carrying a non-empty message clears that node; a
// status-only post or a reply on a different node does NOT. So the nag names the
// exact nodes instead of just a count.
//
// Mechanism: print {"decision":"block","reason":"..."} on stdout to block the
// Stop event and inject the reason as Claude's next input. We block on EVERY
// stop while any node is unanswered; loop protection lives BROKER-side
// (/get-unanswered returns block=false once the same unanswered set has been
// nagged MAX_NAG_STREAK times in a row). stop_hook_active is deliberately NOT
// consulted, exactly like the .sh.
//
// WHY A PORT. The .sh needs bash + jq + curl and cannot exec on Windows, so on
// pd-002 the nag never fires. Bun is spawned directly and needs none of them.
// This mirrors the .sh: same endpoints (/get-unanswered, then /heartbeat-tool
// only when blocking), same payloads, same 1s timeouts, same decision logic, and
// the same stdout bytes (jq's default 2-space pretty JSON plus trailing newline).
// Broker unreachable / malformed reply => no output => the stop is allowed.

import * as fs from "node:fs";
import { brokerBaseUrl } from "./broker-url.ts";

type UnansweredNode = {
  node_path?: unknown;
  reply_tool?: unknown;
};

// Reproduces the .sh's `jq -r '.count // 0'` followed by the `^[0-9]+$` guard.
// Returns the integer count, or null when the .sh would `exit 0` (not a
// non-negative integer). jq's `//` falls back on null AND false.
function parseCount(v: unknown): number | null {
  if (v === undefined || v === null || v === false) return 0;
  if (typeof v === "number") {
    return Number.isInteger(v) && v >= 0 ? v : null;
  }
  if (typeof v === "string" && /^[0-9]+$/.test(v)) return parseInt(v, 10);
  return null;
}

// jq string concatenation treats null as the identity, so a missing node_path
// renders as "" rather than "null".
function jqStr(v: unknown): string {
  if (v === undefined || v === null) return "";
  return typeof v === "string" ? v : String(v);
}

// Pure core: given the /get-unanswered response, return exactly what the hook
// prints on stdout ("" = allow the stop). No I/O.
export function buildUnansweredOutput(resp: unknown): string {
  const r = (resp && typeof resp === "object" ? resp : {}) as Record<
    string,
    unknown
  >;
  const count = parseCount(r.count);
  if (count === null) return "";
  // `jq -r '.block // false'` printed "true" only for a JSON true (or the
  // string "true").
  const block = String(r.block ?? false) === "true";
  if (!(count > 0 && block)) return "";

  // The reply tool differs per surface (a diagram has no node to post_to_node
  // at), so the broker names it per row and this just prints what it says.
  const rows = Array.isArray(r.nodes) ? (r.nodes as UnansweredNode[]) : [];
  const nodes = rows
    .map((n) => {
      const o = (n && typeof n === "object" ? n : {}) as UnansweredNode;
      const tool =
        o.reply_tool === undefined || o.reply_tool === null || o.reply_tool === false
          ? "post_to_node"
          : jqStr(o.reply_tool);
      return `  - ${jqStr(o.node_path)}  → reply with ${tool}`;
    })
    .join("\n");

  // Source-neutral: a flagged node may come from the user's UI submission OR an
  // external notice (/notify-session). Soft framing — replying on a different
  // node, or the user simply not wanting a reply, are legitimate, so the escape
  // hatch (reset_unanswered_posts) is offered as a first-class option.
  const msg =
    "discussion-tree: these thread(s) have a dt post (from the user or an external notification) you have not replied to yet:\n" +
    `${nodes}\n` +
    "Is that intentional? If you already handled it (you replied on a different node, or the user doesn't want a reply), call reset_unanswered_posts to yield. Otherwise post an actual reply message using the tool named above — a status-only post does NOT count.";

  // `jq -n --arg reason "$msg" '{decision:"block", reason:$reason}'` = 2-space
  // pretty JSON followed by a newline.
  return JSON.stringify({ decision: "block", reason: msg }, null, 2) + "\n";
}

// Best-effort POST returning the parsed JSON, or {} on any failure (connection
// error / timeout / non-JSON body). Mirrors `curl ... || echo '{}'`.
async function postJson(
  url: string,
  body: unknown,
  timeoutMs = 1000,
): Promise<unknown> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    return await res.json();
  } catch {
    return {};
  } finally {
    clearTimeout(t);
  }
}

export async function runCheckUnanswered(
  input: { session_id?: string; stop_hook_active?: boolean } = {},
  env: Record<string, string | undefined> = process.env,
): Promise<string> {
  const sid = typeof input?.session_id === "string" ? input.session_id : "";
  if (!sid) return "";
  const base = brokerBaseUrl(env);

  const resp = await postJson(`${base}/get-unanswered`, { cc_session_id: sid });
  const out = buildUnansweredOutput(resp);
  if (out) {
    // Stop is about to block-and-resume the turn. Re-arm the "working" badge so
    // the UI keeps spinning while the model thinks before its next tool call.
    // /heartbeat-tool never overwrites an explicit non-"working" state.
    await postJson(`${base}/heartbeat-tool`, {
      cc_session_id: sid,
      tool: "stop-hook-continuation",
    });
  }
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
  let out = "";
  try {
    const raw = await readStdin();
    let input: { session_id?: string } = {};
    try {
      input = JSON.parse(raw || "{}");
    } catch {
      /* malformed stdin: the .sh's jq fails and nothing is printed */
    }
    out = await runCheckUnanswered(input);
  } catch {
    /* best-effort: allow the stop */
  }
  // Synchronous write to fd 1 guarantees the bytes flush before process.exit.
  if (out) {
    try {
      fs.writeSync(1, out);
    } catch {
      /* nothing we can do */
    }
  }
  process.exit(0);
}

if (import.meta.main) main();
