#!/usr/bin/env bun
// discussion-tree PostToolUse hook — Bun port of cc-context-report-hook.sh.
//
// Reports this CC session's current context-free % AND its subscription's
// native 5h / 7d usage-limit windows to the broker, so the sidebar can show a
// per-session context meter and a per-subscription usage chip. Also reports the
// session's current Claude model (read from the transcript tail) when it changes.
//
// WHY A PORT. The .sh version shells out to jq + curl and cannot run on Windows
// (Claude Code cannot exec a bare .sh there), so on pd-002 the hook is a no-op
// and the sidebar meters go dark. Bun is spawned directly, needs no bash / jq /
// curl, and handles ${CLAUDE_PLUGIN_ROOT} regardless of slash direction. This
// file mirrors the .sh byte-for-byte in behavior: same endpoints, same payload
// shapes, same best-effort semantics (every failure swallowed but logged via
// hook-io; never blocks a tool call; ~1s fetch timeout via AbortController).
//
// The CC statusline (a separate, non-OSS user setup) already writes the live
// free % and the rate-limit windows to temp files on every PostToolUse. This
// hook just reads those files and forwards the numbers to the broker.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { brokerBaseUrl } from "./broker-url.ts";
import {
  logHookFailure,
  postBestEffort,
  postJsonBestEffort,
  readStdin,
  setHookSessionId,
} from "./hook-io.ts";
import { modelFromTranscript } from "./transcript-model.ts";

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

// --- Current Claude model ------------------------------------------------------
// The model is read from the session transcript (NOT the user's statusline,
// which is outside this repo and differs per platform) and POSTed only when it
// changed, so the common case costs one small file read and no request. The
// last successfully reported value lives in a tiny per-session cache file next
// to the statusline's files. It is written only when the broker answered ok
// (so a report made before the session registered is retried on the next tool
// call), and it is re-sent after MODEL_RESEND_MS even if unchanged, so a broker
// that lost the value (e.g. a fresh broker session for a resumed CC) recovers.
export const MODEL_RESEND_MS = 10 * 60 * 1000;

export function modelCacheFile(sid: string, tmp: string): string {
  return path.join(tmp, `claude-sl-${sid}-model`);
}

export async function reportModel(
  sid: string,
  transcriptPath: string,
  base: string,
  tmp: string,
  now: number = Date.now(),
): Promise<void> {
  const model = modelFromTranscript(transcriptPath);
  if (!model) return;
  const cacheFile = modelCacheFile(sid, tmp);
  try {
    const st = fs.statSync(cacheFile);
    const cached = fs.readFileSync(cacheFile, "utf8").trim();
    if (cached === model && now - st.mtimeMs < MODEL_RESEND_MS) return;
  } catch {
    /* no cache yet — report */
  }
  const res = (await postJsonBestEffort(`${base}/report-model`, {
    cc_session_id: sid,
    model,
  })) as { ok?: unknown } | null;
  if (res && res.ok === true) {
    try {
      fs.writeFileSync(cacheFile, model + "\n");
    } catch {
      /* unwritable temp dir — we just report again next time */
    }
  }
}

// The statusline's 5h / 7d file: a non-empty plain object (jq: type == "object"
// and length > 0). Arrays, null, scalars, unreadable or malformed → null.
export function readLimitsFile(file: string): Record<string, unknown> | null {
  try {
    if (!fs.existsSync(file)) return null;
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    if (
      parsed &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      Object.keys(parsed as Record<string, unknown>).length > 0
    ) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    /* unreadable / malformed — skip, best-effort */
  }
  return null;
}

// --- Optional extra usage windows -------------------------------------------
// A user's statusline setup MAY also write claude-sl-<sid>-extra-limits.json:
// a JSON array of { label, pct, resets_at } (pct = used% 0..100, resets_at =
// epoch seconds or an ISO string) for usage windows beyond 5h / 7d. dt does not
// care where they come from; the broker validates them (broker/extra-usage.ts)
// and the header chip shows each one after 5h / 7d. An EMPTY array is forwarded
// too (it means "none right now"). A missing / malformed file sends nothing.
export const MAX_FORWARDED_EXTRA = 8;

export function extraLimitsFile(sid: string, tmp: string): string {
  return path.join(tmp, `claude-sl-${sid}-extra-limits.json`);
}

export function readExtraLimitsFile(file: string): unknown[] | null {
  try {
    if (!fs.existsSync(file)) return null;
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!Array.isArray(parsed)) return null;
    return parsed.slice(0, MAX_FORWARDED_EXTRA);
  } catch {
    return null;
  }
}

export async function runContextReport(
  input: { session_id?: string; transcript_path?: string } = {},
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

  // --- Native 5h / 7d subscription-usage limits (+ optional extra windows) -----
  const limits = readLimitsFile(path.join(tmp, `claude-sl-${sid}-limits.json`));
  const extra = readExtraLimitsFile(extraLimitsFile(sid, tmp));
  if (limits || extra) {
    try {
      // Tag with cc_session_id (binds the report to the session) and account
      // (groups usage_limits by subscription). The .sh spread these AFTER the
      // file's fields so they override any same-named key — same here.
      await postBestEffort(`${base}/report-usage-limits`, {
        ...(limits ?? {}),
        ...(extra ? { extra } : {}),
        cc_session_id: sid,
        account: accountKey(env),
      });
    } catch {
      /* best-effort */
    }
  }

  // --- Current model (from the transcript tail) ---------------------------------
  const transcriptPath = input?.transcript_path;
  if (typeof transcriptPath === "string" && transcriptPath) {
    try {
      await reportModel(sid, transcriptPath, base, tmp);
    } catch (e) {
      logHookFailure({ step: "report-model", error: e, session_id: sid });
    }
  }
}

async function main(): Promise<void> {
  try {
    const raw = await readStdin();
    let input: { session_id?: string; transcript_path?: string } = {};
    try {
      input = JSON.parse(raw || "{}");
    } catch {
      /* tolerate empty / malformed stdin */
    }
    setHookSessionId(input?.session_id);
    await runContextReport(input);
  } catch (e) {
    logHookFailure({ step: "main", error: e });
  } finally {
    process.exit(0);
  }
}

if (import.meta.main) main();
