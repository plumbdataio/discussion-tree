import { describe, test, expect, afterAll } from "bun:test";
import { writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  classifyStallText,
  classifyStallFromTranscript,
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
});
