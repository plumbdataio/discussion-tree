// Shared I/O helpers for the Bun hook ports that replaced the bash hooks
// (tool-activity, blocked-on-user, pre-compact, tool-activity-clear,
// bg-task-reconcile, subagent-stop, and the broker calls of the other hooks).
//
// One copy of "read stdin", "fire-and-forget POST", "record a failure" and "what
// would the .sh's jq have produced" instead of one per hook, so the rules cannot
// drift between hooks. Dependency-free (node builtins only, no server/broker
// imports) so a hook that runs on every tool call stays cheap to load, and so it
// runs unchanged on Windows.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export type HookEnv = Record<string, string | undefined>;

export function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(data));
  });
}

// Parse the hook's stdin payload. Malformed / empty / non-object stdin yields {}
// so every field reads as absent — the .sh's jq would have failed there and the
// script would have POSTed nothing, which is what an empty object produces too.
export function parseHookInput(raw: string): Record<string, unknown> {
  try {
    const v = JSON.parse(raw || "{}");
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

// What `x=$(jq -r '.field // empty')` leaves in a bash variable:
//   - null / false / missing fall through `//` to empty -> ""
//   - a string is printed raw; anything else as JSON (jq -r only unquotes
//     strings; objects/arrays come out 2-space pretty-printed)
//   - $(...) then strips ALL trailing newlines.
export function jqRaw(v: unknown): string {
  if (v === undefined || v === null || v === false) return "";
  const s =
    typeof v === "string"
      ? v
      : typeof v === "object"
        ? JSON.stringify(v, null, 2)
        : String(v);
  return s.replace(/\n+$/, "");
}

// --- Failure log ----------------------------------------------------------------
// Every broker call from a hook is best-effort and its failure is swallowed (a
// hook must never break the tool call / turn it rides on). That left NO trace
// when hooks could not reach the broker (e.g. a remote Mac session whose Stop
// hook failed for minutes, leaving the "working" spinner stuck). So each failure
// appends ONE JSON line to a small log file in the OS temp dir. It never writes
// to stdout/stderr: hook stdout is fed to the model or parsed as a decision.

export const HOOK_FAILURE_LOG_MAX_BYTES = 1024 * 1024;

// Override with DT_HOOK_FAILURE_LOG (tests, or to move it). Returns "" (= do not
// log) under `bun test` without an explicit override, so unit tests that mock
// fetch with failing responses do not pollute the real diagnostic log.
export function hookFailureLogPath(env: HookEnv = process.env): string {
  if (env.DT_HOOK_FAILURE_LOG) return env.DT_HOOK_FAILURE_LOG;
  if (env.NODE_ENV === "test") return "";
  return path.join(os.tmpdir(), "dt-hook-failures.log");
}

// "tool-activity-hook.ts", or "blocked-on-user-hook.ts start" when the hook was
// registered with a mode argument.
export function hookName(argv: string[] = process.argv): string {
  const script = argv[1] ? path.basename(argv[1]) : "unknown";
  return argv[2] ? `${script} ${argv[2]}` : script;
}

// The cc session the current hook process serves; set once by runHookMain (or a
// hook's own main) so failures that are not tied to a request body still carry
// it.
let currentSessionId = "";
export function setHookSessionId(sid: unknown): void {
  if (typeof sid === "string") currentSessionId = sid;
}

// name + message + the system-level code (Bun puts e.g. ConnectionRefused /
// CERT_HAS_EXPIRED on the error itself; Node puts ECONNREFUSED on error.cause).
export function describeError(e: unknown): Record<string, unknown> {
  if (!e || typeof e !== "object") return { message: String(e) };
  const err = e as Record<string, any>;
  const out: Record<string, unknown> = {
    name: String(err.name ?? "Error"),
    message: String(err.message ?? ""),
  };
  if (err.code !== undefined && typeof err.code !== "number") {
    out.code = String(err.code);
  }
  const cause = err.cause;
  if (cause && typeof cause === "object") {
    if (cause.code !== undefined) out.cause_code = String(cause.code);
    if (cause.message) out.cause_message = String(cause.message);
  } else if (cause !== undefined) {
    out.cause_message = String(cause);
  }
  return out;
}

export type HookFailure = {
  // What failed: a URL (for a broker call) or a step name ("main", "spawn", ...).
  step: string;
  error?: unknown;
  status?: number;
  elapsed_ms?: number;
  session_id?: string;
  // Extra context (e.g. "ok:false", "timeout after 1000ms", an http error).
  detail?: string;
};

// Size cap: past maxBytes the file is renamed to <log>.1 (replacing the previous
// one). rename can fail on Windows (another process has the file open; seen
// inside psmux-launched processes), so fall back to truncating in place —
// losing old lines beats growing without bound.
function rotateIfNeeded(file: string, maxBytes: number): void {
  let size = 0;
  try {
    size = fs.statSync(file).size;
  } catch {
    return; // missing = nothing to rotate
  }
  if (size <= maxBytes) return;
  try {
    fs.renameSync(file, file + ".1");
  } catch {
    try {
      fs.writeFileSync(file, "");
    } catch {
      /* give up silently */
    }
  }
}

// Append one JSON line describing a hook failure. Never throws, never prints.
export function logHookFailure(
  f: HookFailure,
  env: HookEnv = process.env,
  maxBytes: number = HOOK_FAILURE_LOG_MAX_BYTES,
): void {
  try {
    const file = hookFailureLogPath(env);
    if (!file) return;
    const line: Record<string, unknown> = {
      ts: new Date().toISOString(),
      hook: hookName(),
      pid: process.pid,
      session_id: f.session_id || currentSessionId || undefined,
      step: f.step,
    };
    if (f.status !== undefined) line.status = f.status;
    if (f.detail) line.detail = f.detail;
    if (f.error !== undefined) line.error = describeError(f.error);
    if (f.elapsed_ms !== undefined) line.elapsed_ms = f.elapsed_ms;
    rotateIfNeeded(file, maxBytes);
    fs.appendFileSync(file, JSON.stringify(line) + "\n");
  } catch {
    /* logging is best-effort too */
  }
}

// --- Broker POST ------------------------------------------------------------------

function sessionFromBody(body: unknown): string | undefined {
  if (body && typeof body === "object") {
    const sid = (body as Record<string, unknown>).cc_session_id;
    if (typeof sid === "string" && sid) return sid;
  }
  return undefined;
}

function errorField(parsed: unknown): string | undefined {
  if (parsed && typeof parsed === "object") {
    const e = (parsed as Record<string, unknown>).error;
    if (e !== undefined && e !== null) return String(e);
  }
  return undefined;
}

// --- Timeout policy ---------------------------------------------------------------
// Measured on the Mac (2026-10-23): 1,417 of 1,423 logged hook failures were
// "timeout after 1000ms" against the REMOTE broker (https://hello.<tailnet>,
// Tailscale serve). Every hook is a fresh bun process opening a fresh TLS
// connection, so a request there takes ~1.0s median (max 2.4s) — the old flat
// 1s timeout (the .sh's `curl --max-time 1`) sat right on the median. When the
// Stop hook's /clear-tool-activity was the one that timed out, the sidebar
// "working" spinner stayed forever (the broker's idle watchdog is disabled).
//
// Two classes of hook, two policies:
//   - PER TOOL CALL (PreToolUse / PostToolUse / UserPromptSubmit): CC waits for
//     the hook before running the tool / the turn, on EVERY call, so keep them
//     short: 1s on loopback (the broker is local; 1s is already generous), 2s
//     for a remote broker (above the measured median, under the 2.4s max — a
//     miss there costs one stale heartbeat that the next call repairs). No
//     retry: the next tool call re-sends the same signal anyway.
//   - ONCE PER TURN / EVENT (Stop, SubagentStop, StopFailure, PreCompact,
//     post-compact SessionStart, blocked-on-user clear): nothing re-sends
//     these, so a single miss leaves a stuck badge. They run once per turn, so
//     a longer wait is cheap: 5s, plus ONE retry on a timeout / network error
//     (not on an HTTP error or `ok:false` — the broker answered, a retry would
//     get the same answer). Worst case per POST = 5s + 200ms + 5s.

export const PER_TOOL_TIMEOUT_LOOPBACK_MS = 1000;
export const PER_TOOL_TIMEOUT_REMOTE_MS = 2000;
export const ONCE_PER_TURN_TIMEOUT_MS = 5000;
export const ONCE_PER_TURN_RETRIES = 1;
export const RETRY_DELAY_MS = 200;

export type PostOptions = {
  // Per attempt. Default: perToolCallTimeoutMs(url).
  timeoutMs?: number;
  // Extra attempts after a timeout / network error. Default 0.
  retries?: number;
  // Pause before each retry (a broker mid-restart refuses instantly).
  retryDelayMs?: number;
};

// localhost / 127.x / ::1 — the broker runs on this machine.
export function isLoopbackUrl(url: string): boolean {
  try {
    const h = new URL(url).hostname.replace(/^\[|\]$/g, "").toLowerCase();
    return h === "localhost" || h === "::1" || /^127\./.test(h);
  } catch {
    return false;
  }
}

export function perToolCallTimeoutMs(url: string): number {
  return isLoopbackUrl(url)
    ? PER_TOOL_TIMEOUT_LOOPBACK_MS
    : PER_TOOL_TIMEOUT_REMOTE_MS;
}

// For per-tool-call hooks: short, no retry (see the policy above).
export function perToolCallPost(url: string): PostOptions {
  return { timeoutMs: perToolCallTimeoutMs(url), retries: 0 };
}

// For once-per-turn hooks: 5s + one retry (see the policy above).
export const ONCE_PER_TURN_POST: Readonly<PostOptions> = Object.freeze({
  timeoutMs: ONCE_PER_TURN_TIMEOUT_MS,
  retries: ONCE_PER_TURN_RETRIES,
  retryDelayMs: RETRY_DELAY_MS,
});

function resolvePostOptions(
  url: string,
  opts: number | PostOptions | undefined,
): Required<PostOptions> {
  const o: PostOptions = typeof opts === "number" ? { timeoutMs: opts } : opts ?? {};
  return {
    timeoutMs: o.timeoutMs ?? perToolCallTimeoutMs(url),
    retries: Math.max(0, o.retries ?? 0),
    retryDelayMs: o.retryDelayMs ?? RETRY_DELAY_MS,
  };
}

type AttemptResult =
  | { kind: "answered"; value: unknown }
  | { kind: "unreachable" };

// One HTTP attempt. "answered" = the broker replied (whatever it said; failures
// of that kind are logged here). "unreachable" = timeout / network error.
async function attemptPost(
  url: string,
  body: unknown,
  timeoutMs: number,
  attemptLabel: string,
): Promise<AttemptResult> {
  const ctrl = new AbortController();
  let timedOut = false;
  const t = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, timeoutMs);
  const started = Date.now();
  const session_id = sessionFromBody(body);
  let status: number | undefined;
  const fail = (detail?: string, error?: unknown) =>
    logHookFailure({
      step: url,
      status,
      detail,
      error,
      elapsed_ms: Date.now() - started,
      session_id,
    });
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    status = res.status;
    const text = await res.text();
    let parsed: unknown = null;
    let parseFailed = false;
    try {
      parsed = JSON.parse(text);
    } catch {
      parseFailed = true;
    }
    if (!res.ok) {
      const err = errorField(parsed);
      fail(err !== undefined ? `http error: ${err}` : "http error");
      return { kind: "answered", value: parseFailed ? null : parsed };
    }
    if (parseFailed) {
      fail(`non-JSON body: ${text.slice(0, 120)}`);
      return { kind: "answered", value: null };
    }
    if (
      parsed &&
      typeof parsed === "object" &&
      (parsed as Record<string, unknown>).ok === false
    ) {
      const err = errorField(parsed);
      fail(err !== undefined ? `ok:false (${err})` : "ok:false");
    }
    return { kind: "answered", value: parsed };
  } catch (e) {
    const what = timedOut ? `timeout after ${timeoutMs}ms` : "network error";
    // Keep the single-attempt detail exactly as before ("timeout after Nms" /
    // none) so existing log readers keep matching; tag retried attempts.
    const detail = attemptLabel
      ? `${what} (${attemptLabel})`
      : timedOut
        ? what
        : undefined;
    fail(detail, e);
    return { kind: "unreachable" };
  } finally {
    clearTimeout(t);
  }
}

// Best-effort POST returning the parsed JSON body, or null on any failure. The
// timeout covers reading the body too. Logged as failures: network error /
// timeout (each attempt), non-2xx, a 2xx body that is not JSON, and
// `{ ok: false }` (the broker's answer when e.g. no alive session matches the
// cc_session_id). `opts` is a timeout in ms (legacy) or PostOptions; omitted =
// the per-tool-call policy. Only a timeout / network error is retried. NOTE a
// timed-out attempt may still have been processed by the broker, so a retried
// endpoint must tolerate a duplicate (every once-per-turn endpoint is an
// idempotent clear/mark, except /get-unanswered, where a duplicate only advances
// the nag-streak counter one step early). Never throws.
export async function postJsonBestEffort(
  url: string,
  body: unknown,
  opts?: number | PostOptions,
): Promise<unknown> {
  const { timeoutMs, retries, retryDelayMs } = resolvePostOptions(url, opts);
  const attempts = retries + 1;
  for (let i = 1; i <= attempts; i++) {
    const label = attempts > 1 ? `attempt ${i}/${attempts}` : "";
    const r = await attemptPost(url, body, timeoutMs, label);
    if (r.kind === "answered") return r.value;
    if (i < attempts && retryDelayMs > 0) {
      await new Promise((res) => setTimeout(res, retryDelayMs));
    }
  }
  return null;
}

// Best-effort POST, every failure swallowed (but logged, see
// postJsonBestEffort). The body is compact JSON; the .sh sent jq's
// pretty-printed JSON, which parses to the same value. Each hook passes the
// policy for its class (perToolCallPost / ONCE_PER_TURN_POST).
export async function postBestEffort(
  url: string,
  body: unknown,
  opts?: number | PostOptions,
): Promise<void> {
  await postJsonBestEffort(url, body, opts);
}

// Standard hook entry point: read stdin, run, ALWAYS exit 0 (an observation-only
// hook must never block or fail the tool call / turn / session it observes).
export async function runHookMain(
  run: (input: Record<string, unknown>) => Promise<void>,
): Promise<void> {
  try {
    const input = parseHookInput(await readStdin());
    setHookSessionId(input.session_id);
    await run(input);
  } catch (e) {
    logHookFailure({ step: "main", error: e });
  } finally {
    process.exit(0);
  }
}
