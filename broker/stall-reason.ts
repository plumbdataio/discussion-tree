// Classify WHY a Claude Code session stopped, from the tail of its transcript,
// so the auto-continue logic can react per-cause instead of blindly nudging a
// "continue" at everything.
//
//   - "rate_limit" : a 5-hour / weekly usage cap. A nudge can't lift the cap
//                    (the window only resets on its own), so continuing at it
//                    just hammers. dt instead resumes ONCE shortly after the
//                    cap's reset time (see classifyStall + parseResetAt, which
//                    the auto-continue timer uses to schedule that single resume).
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

// Flatten a transcript entry's `content` into plain text. Handles the string
// form, an array of text parts, AND tool_result parts — a subagent Task failure
// surfaces in the PARENT transcript as a tool_result whose message text lives in
// `part.content` (a string, or a nested array of text parts), not `part.text`.
// Recurse into that so the subagent cap phrase is actually reachable.
function flattenContent(c: any): string {
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    return c
      .map((p) => {
        if (typeof p === "string") return p;
        if (p?.text != null) {
          return typeof p.text === "string" ? p.text : flattenContent(p.text);
        }
        if (p?.content != null) return flattenContent(p.content);
        return "";
      })
      .join(" ");
  }
  return "";
}

function extractText(obj: any): string {
  const m = obj?.message ?? obj;
  const c = m?.content ?? m?.text ?? obj?.text ?? "";
  return flattenContent(c);
}

// A capped SUBAGENT (Task tool) is recorded in the PARENT transcript as an
// ordinary tool_result entry (NOT isApiErrorMessage), e.g.
//   Agent "…" failed: Agent terminated early due to an API error:
//   You've hit your session limit · resets 3:40pm (Asia/Tokyo) …
// Recognize that as a cap ONLY when BOTH halves are present, so a normal entry
// that merely mentions "resets …" is never a false positive.
const TASK_FAILURE_CAP_A = /terminated early due to an api error/i;
const TASK_FAILURE_CAP_B =
  /hit your (session|weekly|usage|5-hour|five-hour) limit/i;

// Scan the tail of a Claude Code transcript JSONL, newest-first, and return the
// stop cause plus the exact text that decided it (used to parse the reset time).
// A cap is recognized in EITHER form:
//   - an isApiErrorMessage:true entry (authoritative — this is also the ONLY
//     source of a "login" classification, and its text is classified as today),
//     OR
//   - a NON-isApiErrorMessage entry matching the strict subagent Task-failure-cap
//     pattern above → rate_limit.
// The newest qualifying entry wins. Nothing recognized, or an unreadable /
// non-.jsonl file → "transient" (fail open, the pre-existing behavior).
function scanTranscriptTail(path: string): {
  reason: StallReason;
  text: string;
} {
  if (!path || !path.endsWith(".jsonl")) return { reason: "transient", text: "" };
  const tail = readTail(path, 64 * 1024);
  if (!tail) return { reason: "transient", text: "" };
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
    const text = extractText(obj);
    if (obj?.isApiErrorMessage === true) {
      // The newest API-error entry is authoritative. login only ever comes from
      // here; a cap here classifies via the existing text patterns.
      return { reason: classifyStallText(text), text };
    }
    // A subagent Task-failure that hit a cap: only the strict two-part pattern
    // counts (never a bare "resets …"), so ordinary discussion can't trip it.
    if (TASK_FAILURE_CAP_A.test(text) && TASK_FAILURE_CAP_B.test(text)) {
      return { reason: "rate_limit", text };
    }
  }
  return { reason: "transient", text: "" };
}

// Classify from a Claude Code transcript JSONL. See scanTranscriptTail.
export function classifyStallFromTranscript(path: string): StallReason {
  return scanTranscriptTail(path).reason;
}

// Like classifyStallFromTranscript, but also returns, for a rate_limit cap, the
// absolute reset time (epoch ms) parsed out of the exact text that matched — so
// the auto-continue can resume ONCE at that time instead of hammering. resetAt is
// null for non-cap causes and for a cap whose reset time is unparseable.
export function classifyStall(path: string): {
  reason: StallReason;
  resetAt: number | null;
} {
  const { reason, text } = scanTranscriptTail(path);
  return {
    reason,
    resetAt: reason === "rate_limit" ? parseResetAt(text) : null,
  };
}

// The wall-clock offset (ms) of an IANA timezone at a given instant, defined so
// that: localWallClock = utcInstant + offset. Derived by formatting the instant
// in the zone and reading back the fields it shows. Throws (caught by the caller)
// only on an invalid timezone id.
function tzOffsetMs(tz: string, utcMs: number): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const map: Record<string, string> = {};
  for (const p of dtf.formatToParts(new Date(utcMs))) map[p.type] = p.value;
  let hour = map.hour;
  if (hour === "24") hour = "00"; // some engines emit "24" for midnight
  const asIfUtc = Date.UTC(
    Number(map.year),
    Number(map.month) - 1,
    Number(map.day),
    Number(hour),
    Number(map.minute),
    Number(map.second),
  );
  return asIfUtc - utcMs;
}

// The epoch (ms) of a wall-clock date+time interpreted IN timezone `tz`. Corrects
// the offset twice so a DST boundary near the target resolves to the right side.
function zonedWallClockToEpoch(
  tz: string,
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
): number {
  const asUtc = Date.UTC(year, month - 1, day, hour, minute, 0);
  const off1 = tzOffsetMs(tz, asUtc);
  let epoch = asUtc - off1;
  const off2 = tzOffsetMs(tz, epoch);
  if (off2 !== off1) epoch = asUtc - off2;
  return epoch;
}

// The calendar date (Y/M/D) showing in timezone `tz` at instant `utcMs`.
function dateInTz(
  tz: string,
  utcMs: number,
): { year: number; month: number; day: number } {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const map: Record<string, string> = {};
  for (const p of dtf.formatToParts(new Date(utcMs))) map[p.type] = p.value;
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
  };
}

// Pure calendar arithmetic on date fields (no DST — operates in UTC on the plain
// Y/M/D), so "the next day" is correct across month/year boundaries.
function addCalendarDays(
  year: number,
  month: number,
  day: number,
  n: number,
): { year: number; month: number; day: number } {
  const d = new Date(Date.UTC(year, month - 1, day));
  d.setUTCDate(d.getUTCDate() + n);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
  };
}

// Parse the NEXT future occurrence (epoch ms) of the reset time named in a cap
// message, using the FIRST "resets …" occurrence. Handles, case-insensitively:
//   "resets 3:40pm (Asia/Tokyo)", "resets 3pm", "resets at 9am",
//   "resets at 15:40", "resets 9:00am", optional "tomorrow", optional
//   "(<IANA timezone>)" (absent → machine local timezone).
// The result is STRICTLY in the future vs `now`: if today's occurrence is already
// at/behind now (or "tomorrow" is given), the next day's is used. Returns null on
// anything unrecognized (including an invalid timezone id).
export function parseResetAt(text: string, now = Date.now()): number | null {
  if (!text) return null;
  const m =
    /resets\s+(?:at\s+)?(?:(tomorrow)\s+(?:at\s+)?)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i.exec(
      text,
    );
  if (!m) return null;

  let hour = parseInt(m[2], 10);
  const minute = m[3] ? parseInt(m[3], 10) : 0;
  const ampm = m[4] ? m[4].toLowerCase() : null;
  if (!Number.isFinite(hour) || minute < 0 || minute > 59) return null;
  if (ampm) {
    if (hour < 1 || hour > 12) return null;
    if (ampm === "pm" && hour !== 12) hour += 12;
    if (ampm === "am" && hour === 12) hour = 0;
  } else if (hour < 0 || hour > 23) {
    return null;
  }

  // "tomorrow" may appear before the time (captured) or shortly after it.
  const rest = text.slice(m.index + m[0].length, m.index + m[0].length + 24);
  const tomorrow = !!m[1] || /\btomorrow\b/i.test(rest);

  // A timezone must sit immediately after the time, e.g. "3:40pm (Asia/Tokyo)".
  const tzMatch = /^\s*\(([^)]+)\)/.exec(rest);
  const tz =
    (tzMatch ? tzMatch[1].trim() : "") ||
    Intl.DateTimeFormat().resolvedOptions().timeZone ||
    "UTC";

  try {
    const today = dateInTz(tz, now);
    let target = zonedWallClockToEpoch(
      tz,
      today.year,
      today.month,
      today.day,
      hour,
      minute,
    );
    if (tomorrow || target <= now) {
      const next = addCalendarDays(today.year, today.month, today.day, 1);
      target = zonedWallClockToEpoch(
        tz,
        next.year,
        next.month,
        next.day,
        hour,
        minute,
      );
    }
    return Number.isFinite(target) ? target : null;
  } catch {
    return null; // invalid timezone id → unparseable
  }
}
