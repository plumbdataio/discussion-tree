import { describe, test, expect, afterAll } from "bun:test";
import { writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  classifyStallText,
  classifyStallFromTranscript,
  classifyStall,
  parseResetAt,
} from "../../broker/stall-reason.ts";

// Unit tests for the stall-cause classifier (broker/stall-reason.ts). The
// tricky case is the rate-limit banner, which itself contains
// "/login to switch to an API usage-billed account" — a naive "/login" check
// would misread it as a login expiry. So rate_limit MUST win over login.

describe("classifyStallText", () => {
  test("session usage cap → rate_limit (even though it mentions /login)", () => {
    const banner =
      "You've hit your session limit · resets 10:50pm (Asia/Tokyo)\n" +
      "/login to switch to an API usage-billed account.";
    expect(classifyStallText(banner)).toBe("rate_limit");
  });

  test("weekly cap → rate_limit", () => {
    expect(classifyStallText("You've hit your weekly limit")).toBe("rate_limit");
  });

  test("5-hour limit phrasing → rate_limit", () => {
    expect(classifyStallText("You have reached your 5-hour limit.")).toBe(
      "rate_limit",
    );
  });

  test("login expired banner → login", () => {
    expect(classifyStallText("Login expired · Please run /login")).toBe("login");
  });

  test("please run /login alone → login", () => {
    expect(classifyStallText("Please run /login to continue")).toBe("login");
  });

  test("a bare /login (not the expiry phrase) is NOT login", () => {
    // Only the explicit expiry phrases classify as login; a stray "/login"
    // mention must not, or the rate-limit banner would be misread.
    expect(classifyStallText("type /login to switch accounts")).toBe(
      "transient",
    );
  });

  test("transient 429 / overloaded → transient", () => {
    expect(
      classifyStallText("API Error: temporarily limiting requests, retry"),
    ).toBe("transient");
    expect(classifyStallText("Overloaded (retry also failed)")).toBe(
      "transient",
    );
  });

  test("empty / undefined → transient (fail open)", () => {
    expect(classifyStallText("")).toBe("transient");
    expect(classifyStallText(undefined as unknown as string)).toBe("transient");
  });
});

describe("classifyStallFromTranscript", () => {
  const dir = mkdtempSync(join(tmpdir(), "dt-stall-"));
  const files: string[] = [];
  function transcript(name: string, lines: object[]): string {
    const p = join(dir, name);
    writeFileSync(p, lines.map((l) => JSON.stringify(l)).join("\n"));
    files.push(p);
    return p;
  }
  afterAll(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  test("reads the last isApiErrorMessage entry (rate_limit)", () => {
    const p = transcript("rl.jsonl", [
      { type: "user", message: { content: "hi" } },
      { type: "assistant", message: { content: "working" } },
      {
        type: "assistant",
        isApiErrorMessage: true,
        message: {
          content: "You've hit your session limit · resets 10:50pm",
        },
      },
    ]);
    expect(classifyStallFromTranscript(p)).toBe("rate_limit");
  });

  test("login expiry entry → login", () => {
    const p = transcript("login.jsonl", [
      { type: "assistant", message: { content: "ok" } },
      {
        type: "assistant",
        isApiErrorMessage: true,
        message: { content: "Login expired · Please run /login" },
      },
    ]);
    expect(classifyStallFromTranscript(p)).toBe("login");
  });

  test("array-shaped content is flattened", () => {
    const p = transcript("arr.jsonl", [
      {
        type: "assistant",
        isApiErrorMessage: true,
        message: { content: [{ type: "text", text: "You've hit your weekly limit" }] },
      },
    ]);
    expect(classifyStallFromTranscript(p)).toBe("rate_limit");
  });

  test("no isApiErrorMessage entry → transient (fail open)", () => {
    const p = transcript("clean.jsonl", [
      { type: "user", message: { content: "hi" } },
      { type: "assistant", message: { content: "all good" } },
    ]);
    expect(classifyStallFromTranscript(p)).toBe("transient");
  });

  test("missing / non-jsonl path → transient", () => {
    expect(classifyStallFromTranscript("/no/such/file.jsonl")).toBe("transient");
    expect(classifyStallFromTranscript("")).toBe("transient");
    expect(classifyStallFromTranscript("/etc/hosts")).toBe("transient");
  });

  // A SUBAGENT (Task tool) that hit a cap is NOT recorded in the parent
  // transcript as an isApiErrorMessage assistant entry — it lands as an ordinary
  // tool_result whose text says the Task failed. classifyStall must still read
  // that as a cap (and parse its reset time), not fall through to "transient".
  test("subagent Task-failure cap tool_result (no isApiErrorMessage) → rate_limit + resetAt", () => {
    const p = transcript("subagent-cap.jsonl", [
      { type: "assistant", message: { content: "spawning a subagent" } },
      {
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_x",
              is_error: true,
              content:
                'Agent "general-purpose" failed: Agent terminated early due to an API error: You\'ve hit your session limit · resets 3:40pm (Asia/Tokyo). Please try again later.',
            },
          ],
        },
      },
    ]);
    expect(classifyStallFromTranscript(p)).toBe("rate_limit");
    const c = classifyStall(p);
    expect(c.reason).toBe("rate_limit");
    expect(c.resetAt).not.toBeNull();
    expect(c.resetAt!).toBeGreaterThan(Date.now());
  });

  test("subagent Task-failure content as nested text parts also flattens", () => {
    const p = transcript("subagent-cap-nested.jsonl", [
      {
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              content: [
                {
                  type: "text",
                  text: "Agent terminated early due to an API error: You've hit your weekly limit · resets tomorrow at 9am",
                },
              ],
            },
          ],
        },
      },
    ]);
    expect(classifyStallFromTranscript(p)).toBe("rate_limit");
  });

  test("bare isApiErrorMessage cap → rate_limit (classifyStall carries resetAt)", () => {
    const p = transcript("bare-cap.jsonl", [
      {
        type: "assistant",
        isApiErrorMessage: true,
        message: {
          content: "You've hit your session limit · resets 10:50pm (Asia/Tokyo)",
        },
      },
    ]);
    const c = classifyStall(p);
    expect(c.reason).toBe("rate_limit");
    expect(c.resetAt).not.toBeNull();
  });

  test("login isApiErrorMessage → login (classifyStall resetAt null)", () => {
    const p = transcript("login2.jsonl", [
      {
        type: "assistant",
        isApiErrorMessage: true,
        message: { content: "Login expired · Please run /login" },
      },
    ]);
    const c = classifyStall(p);
    expect(c.reason).toBe("login");
    expect(c.resetAt).toBeNull();
  });

  test("ordinary entry casually mentioning 'resets tomorrow' → transient (no false positive)", () => {
    // A normal discussion line that merely contains "resets" must NOT be read as
    // a cap: only a real cap (isApiErrorMessage, or the strict subagent
    // Task-failure two-part phrase) counts.
    const p = transcript("chatter.jsonl", [
      { type: "assistant", message: { content: "hi" } },
      {
        type: "user",
        message: {
          content: "the weekly window resets tomorrow so let's plan around it",
        },
      },
    ]);
    expect(classifyStallFromTranscript(p)).toBe("transient");
    expect(classifyStall(p).reason).toBe("transient");
  });
});

describe("parseResetAt", () => {
  test("'resets 3:40pm (Asia/Tokyo)' at a fixed now → exact epoch", () => {
    // now = 2026-09-16T00:00:00Z = 09:00 in Tokyo (UTC+9). 3:40pm Tokyo today is
    // still ahead of now → 2026-09-16T15:40+09:00 = 2026-09-16T06:40:00Z.
    const now = Date.UTC(2026, 8, 16, 0, 0, 0);
    expect(parseResetAt("You've hit your session limit · resets 3:40pm (Asia/Tokyo)", now)).toBe(
      Date.UTC(2026, 8, 16, 6, 40, 0),
    );
  });

  test("'resets at 9am (Asia/Tokyo)' wraps to tomorrow when today's is past", () => {
    // now = 2026-09-16T05:00:00Z = 14:00 in Tokyo. 9am Tokyo today (00:00Z) is
    // already behind now → next occurrence is 2026-09-17T09:00+09 = 09-17T00:00Z.
    const now = Date.UTC(2026, 8, 16, 5, 0, 0);
    expect(parseResetAt("resets at 9am (Asia/Tokyo)", now)).toBe(
      Date.UTC(2026, 8, 17, 0, 0, 0),
    );
  });

  test("explicit 'tomorrow' forces the next day even if today's is still ahead", () => {
    // now = 2026-09-16T00:00:00Z; 11pm today would be ahead, but "tomorrow" wins.
    const now = Date.UTC(2026, 8, 16, 0, 0, 0);
    // 11pm Tokyo tomorrow = 2026-09-17T23:00+09 = 2026-09-17T14:00:00Z.
    expect(parseResetAt("resets tomorrow 11pm (Asia/Tokyo)", now)).toBe(
      Date.UTC(2026, 8, 17, 14, 0, 0),
    );
  });

  test("a non-local timezone (America/New_York, EDT) is honored", () => {
    // now = 2026-09-16T00:00:00Z. NY is EDT (UTC-4) in September. 3pm EDT today =
    // 2026-09-16T15:00-04:00 = 2026-09-16T19:00:00Z (> now).
    const now = Date.UTC(2026, 8, 16, 0, 0, 0);
    expect(parseResetAt("resets 3pm (America/New_York)", now)).toBe(
      Date.UTC(2026, 8, 16, 19, 0, 0),
    );
  });

  test("24-hour form without am/pm ('resets at 15:40')", () => {
    const now = Date.UTC(2026, 8, 16, 0, 0, 0);
    // 15:40 Tokyo today = 2026-09-16T15:40+09 = 06:40Z.
    expect(parseResetAt("resets at 15:40 (Asia/Tokyo)", now)).toBe(
      Date.UTC(2026, 8, 16, 6, 40, 0),
    );
  });

  test("no timezone falls back to the machine's local zone (strictly future, right wall-clock)", () => {
    const now = Date.UTC(2026, 8, 16, 3, 0, 0);
    const r = parseResetAt("resets at 11:30pm", now);
    expect(r).not.toBeNull();
    expect(r!).toBeGreaterThan(now);
    // The result read back in the local zone must show 23:30, whatever zone runs.
    const parts = new Intl.DateTimeFormat("en-US", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(new Date(r!));
    const map: Record<string, string> = {};
    for (const p of parts) map[p.type] = p.value;
    expect(map.minute).toBe("30");
    expect(map.hour).toBe("23");
  });

  test("unparseable text → null", () => {
    expect(parseResetAt("")).toBeNull();
    expect(parseResetAt("everything is fine, carry on")).toBeNull();
    expect(parseResetAt("the window resets soon")).toBeNull(); // no time
    expect(parseResetAt("resets 3pm (Not/AZone)", Date.UTC(2026, 8, 16, 0, 0))).toBeNull();
  });
});
