#!/usr/bin/env bun
// discussion-tree PostToolUse hook — Bun port of cc-context-report-hook.sh.
//
// Reports this CC session's current context-free % AND its subscription's
// native 5h / 7d usage-limit windows to the broker, so the sidebar can show a
// per-session context meter and a per-subscription usage chip.
//
// WHY A PORT. The .sh version shells out to jq + curl and cannot run on Windows
// (Claude Code cannot exec a bare .sh there), so on pd-002 the hook is a no-op
// and the sidebar meters go dark. Bun is spawned directly, needs no bash / jq /
// curl, and handles ${CLAUDE_PLUGIN_ROOT} regardless of slash direction. This
// file mirrors the .sh byte-for-byte in behavior: same endpoints, same payload
// shapes, same best-effort semantics (every failure swallowed; never blocks a
// tool call; ~1s fetch timeout via AbortController).
//
// The CC statusline (a separate, non-OSS user setup) already writes the live
// free % and the rate-limit windows to temp files on every PostToolUse. This
// hook just reads those files and forwards the numbers to the broker.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { brokerBaseUrl } from "./broker-url.ts";

// Where the CC statusline writes claude-sl-<sid>-pct / -limits.json.
//
// CRITICAL: this is NOT os.tmpdir(). On macOS the statusline hard-codes /tmp
// (os.tmpdir() there is /var/folders/... — a different directory, so reading
// from it would silently find nothing). On Windows the python statusline writes
// to %TEMP%. Resolve accordingly so the ts hook reads the same files the
// statusline wrote on BOTH platforms.
export function statuslineTmpDir(
  env: Record<string, string | undefined> = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === "win32") return env.TEMP || env.TMP || os.tmpdir();
  return "/tmp";
}

// The session's subscription key = its CLAUDE_CONFIG_DIR (each config dir has
// its own OAuth token / plan). ${VAR:-default} semantics: empty OR unset falls
// back to $HOME/.claude. Mirrors the .sh's acct resolution.
export function accountKey(
  env: Record<string, string | undefined> = process.env,
): string {
  return env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
}

// Best-effort POST: short AbortController timeout, every failure swallowed.
// Never throws — a hook that throws could disrupt the tool call it rode in on.
async function postBestEffort(
  url: string,
  body: unknown,
  timeoutMs = 1000,
): Promise<void> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } catch {
    /* broker down / timeout / anything — swallow, best-effort */
  } finally {
    clearTimeout(t);
  }
}

export async function runContextReport(
  input: { session_id?: string } = {},
  env: Record<string, string | undefined> = process.env,
): Promise<void> {
  const sid = String(input?.session_id ?? "");
  if (!sid) return;

  const base = brokerBaseUrl(env);
  const tmp = statuslineTmpDir(env);

  // --- Context free % ---------------------------------------------------------
  const pctFile = path.join(tmp, `claude-sl-${sid}-pct`);
  try {
    if (fs.existsSync(pctFile)) {
      const raw = fs.readFileSync(pctFile, "utf8").trim();
      // Sanity-check: non-empty and only digits / dots (the statusline writes
      // floats like "27.0"), and a finite number. A malformed value just skips
      // this POST — the limits POST below still runs, matching the .sh.
      if (raw && /^[0-9.]+$/.test(raw)) {
        const pct = Number(raw);
        if (Number.isFinite(pct)) {
          await postBestEffort(`${base}/report-context-usage`, {
            cc_session_id: sid,
            remaining_pct: pct,
          });
        }
      }
    }
  } catch {
    /* unreadable pct file — skip, best-effort */
  }

  // --- Native 5h / 7d subscription-usage limits -------------------------------
  const limitsFile = path.join(tmp, `claude-sl-${sid}-limits.json`);
  try {
    if (fs.existsSync(limitsFile)) {
      const rawLimits = fs.readFileSync(limitsFile, "utf8");
      let parsed: unknown;
      try {
        parsed = JSON.parse(rawLimits);
      } catch {
        parsed = undefined;
      }
      // Require a non-empty plain object (jq: type == "object" and length > 0).
      // Arrays are rejected (type "array" in jq); so are null / scalars.
      if (
        parsed &&
        typeof parsed === "object" &&
        !Array.isArray(parsed) &&
        Object.keys(parsed as Record<string, unknown>).length > 0
      ) {
        // Tag with cc_session_id (binds the report to the session) and account
        // (groups usage_limits by subscription). The .sh spreads these AFTER
        // the file's fields so they override any same-named key — same here.
        await postBestEffort(`${base}/report-usage-limits`, {
          ...(parsed as Record<string, unknown>),
          cc_session_id: sid,
          account: accountKey(env),
        });
      }
    }
  } catch {
    /* unreadable / malformed limits file — skip, best-effort */
  }
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
  try {
    const raw = await readStdin();
    let input: { session_id?: string } = {};
    try {
      input = JSON.parse(raw || "{}");
    } catch {
      /* tolerate empty / malformed stdin */
    }
    await runContextReport(input);
  } catch {
    /* best-effort: never let the hook throw */
  } finally {
    process.exit(0);
  }
}

if (import.meta.main) main();
