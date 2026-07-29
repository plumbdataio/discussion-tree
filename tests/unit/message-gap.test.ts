import { describe, test, expect } from "bun:test";
import {
  GAP_THRESHOLD_MS,
  formatGap,
  gapSince,
} from "../../server/message-gap.ts";

// CC cannot see how long a thread has been quiet — it has no clock, and it does
// not subtract two `sent_at` values unprompted. So a message arriving after a
// long break gets answered with hours-old context. This reports the gap, but
// only when it is long enough to change what should happen: a field that reads
// "40s" on every message becomes background and stops being read.

const HOUR = 60 * 60 * 1000;
const at = (ms: number) => new Date(ms).toISOString();

describe("message gap — when it is worth reporting", () => {
  test("silence shorter than the threshold says nothing", () => {
    // 59 minutes is the rhythm of a normal working conversation, not a break.
    expect(gapSince(at(0), at(59 * 60 * 1000))).toBe(null);
    expect(gapSince(at(0), at(1000))).toBe(null);
  });

  test("an hour or more is reported", () => {
    expect(gapSince(at(0), at(HOUR))).toBe("1h");
    expect(gapSince(at(0), at(3 * HOUR + 12 * 60 * 1000))).toBe("3h12m");
  });

  test("the threshold is caller-adjustable, but defaults to an hour", () => {
    expect(GAP_THRESHOLD_MS).toBe(HOUR);
    expect(gapSince(at(0), at(5 * 60 * 1000), 60_000)).toBe("5m");
  });

  test("a node with no earlier message reports nothing, rather than a huge gap", () => {
    // prev_message_at is NULL for the first message on a node; treating that as
    // "silent since the epoch" would put a nonsense value on every new thread.
    expect(gapSince(null, at(HOUR))).toBe(null);
    expect(gapSince(undefined, at(HOUR))).toBe(null);
    expect(gapSince("not a date", at(HOUR))).toBe(null);
  });

  test("clock skew does not produce a negative or alarming value", () => {
    // The two timestamps come from the same DB, but a row written during an NTP
    // step could still land out of order.
    expect(gapSince(at(HOUR), at(0))).toBe(null);
  });
});

describe("message gap — how it reads", () => {
  test("coarse on purpose: the number is a cue, not a measurement", () => {
    expect(formatGap(90 * 60 * 1000)).toBe("1h30m");
    expect(formatGap(2 * HOUR)).toBe("2h");
    expect(formatGap(26 * HOUR)).toBe("1d2h");
    // A whole number of days drops the trailing zero hours.
    expect(formatGap(48 * HOUR)).toBe("2d");
    expect(formatGap(45 * 60 * 1000)).toBe("45m");
  });

  test("degenerate input formats rather than throws", () => {
    expect(formatGap(0)).toBe("0m");
    expect(formatGap(-5)).toBe("0m");
    expect(formatGap(Number.NaN)).toBe("0m");
  });
});
