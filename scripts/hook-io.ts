// Shared I/O helpers for the Bun hook ports that replaced the bash hooks
// (tool-activity, blocked-on-user, pre-compact, tool-activity-clear,
// bg-task-reconcile, subagent-stop).
//
// One copy of "read stdin", "fire-and-forget POST" and "what would the .sh's jq
// have produced" instead of one per hook, so the jq-compatibility rules cannot
// drift between hooks. Dependency-free (no server/broker imports) so a hook that
// runs on every tool call stays cheap to load, and so it runs unchanged on
// Windows.

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

// Best-effort POST: 1s timeout (the .sh's `curl --max-time 1`), every failure
// swallowed. The body is compact JSON; the .sh sent jq's pretty-printed JSON,
// which parses to the same value (the broker JSON-parses it).
export async function postBestEffort(
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
    /* broker down / timeout — swallow, best-effort */
  } finally {
    clearTimeout(t);
  }
}

// Standard hook entry point: read stdin, run, ALWAYS exit 0 (an observation-only
// hook must never block or fail the tool call / turn / session it observes).
export async function runHookMain(
  run: (input: Record<string, unknown>) => Promise<void>,
): Promise<void> {
  try {
    await run(parseHookInput(await readStdin()));
  } catch {
    /* best-effort: never let the hook throw */
  } finally {
    process.exit(0);
  }
}
