// Classify WHY a Claude Code session stopped, from the tail of its transcript,
// so the auto-continue logic can react per-cause instead of blindly nudging a
// "continue" at everything.
//
//   - "rate_limit" : a 5-hour / weekly usage cap. A nudge can't lift the cap
//                    (the window resets on its own; the external cc-usage bridge
//                    handles the reset-time resume), so continuing just hammers.
//   - "login"      : auth / login expired. Only the human can fix it (/login);
//                    a nudge is futile — surface a notice instead.
//   - "transient"  : any other API error (a passing 429 "temporarily limiting
//                    requests", "retry also failed", overloaded). A short
//                    delayed "continue" is the right move here.
//
// Fails OPEN to "transient" (the pre-existing behavior) on anything unexpected —
// an unreadable transcript, no recognizable stop banner, a parse miss — so a
// classification failure is never WORSE than the old "always continue".

import { openSync, fstatSync, readSync, closeSync } from "node:fs";

export type StallReason = "rate_limit" | "login" | "transient";

export function classifyStallText(text: string): StallReason {
  const t = (text ?? "").toLowerCase();
  // Usage / rate cap FIRST. The cap banner itself contains
  // "/login to switch to an API usage-billed account", so a bare "/login" test
  // below would otherwise misread a rate-limit as a login problem.
  if (
    /hit your (session|weekly|usage|5-hour|five-hour) limit/.test(t) ||
    /\bhit your limit\b/.test(t) ||
    /usage limit reached/.test(t) ||
    /\bresets? (at |on |today|tomorrow|\d)/.test(t) ||
    /\b(weekly|5-hour|five-hour) limit\b/.test(t)
  ) {
    return "rate_limit";
  }
  // Auth expiry: only the explicit phrases, NEVER a bare "/login" (which also
  // appears inside the rate-limit banner, handled above).
  if (/login expired/.test(t) || /please run \/login/.test(t)) {
    return "login";
  }
  return "transient";
}

// Read up to the last `maxBytes` of a file synchronously, without slurping a
// possibly-huge transcript whole. Returns "" on any error.
function readTail(path: string, maxBytes: number): string {
  let fd: number | null = null;
  try {
    fd = openSync(path, "r");
    const size = fstatSync(fd).size;
    const start = size > maxBytes ? size - maxBytes : 0;
    const len = size - start;
    if (len <= 0) return "";
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, start);
    return buf.toString("utf8");
  } catch {
    return "";
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

function extractText(obj: any): string {
  const m = obj?.message ?? obj;
  const c = m?.content ?? m?.text ?? obj?.text ?? "";
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    return c
      .map((p) => (typeof p === "string" ? p : (p?.text ?? "")))
      .join(" ");
  }
  return "";
}

// Classify from a Claude Code transcript JSONL. The stop reason is recorded as
// an assistant entry flagged isApiErrorMessage:true whose text IS the API error
// ("You've hit your session limit …", "Login expired · Please run /login", …).
// Scan the tail for the LAST such entry. No isApiErrorMessage entry, or an
// unreadable / non-.jsonl file, → "transient" (fail open).
export function classifyStallFromTranscript(path: string): StallReason {
  if (!path || !path.endsWith(".jsonl")) return "transient";
  const tail = readTail(path, 64 * 1024);
  if (!tail) return "transient";
  const lines = tail.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let obj: any;
    try {
      obj = JSON.parse(line);
    } catch {
      continue; // a partial first line from the tail cut, or non-JSON — skip
    }
    if (obj?.isApiErrorMessage === true) {
      return classifyStallText(extractText(obj));
    }
  }
  return "transient";
}
