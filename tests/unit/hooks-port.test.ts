import { describe, test, expect, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

import {
  runContextReport,
  statuslineTmpDir,
} from "../../scripts/cc-context-report-hook.ts";
import { runStopFailure } from "../../scripts/stop-failure-hook.ts";
import { runPostCompact } from "../../scripts/post-compact-board-reminder.ts";

// These lock the ts ports of the three bash hooks against the broker contract
// the .sh versions established: the SAME endpoints, the SAME payload shapes, and
// the SAME best-effort/no-POST-when-idle semantics. fetch is monkeypatched to
// capture the outbound calls (never a real broker); temp-file branches seed the
// resolved statusline temp dir (/tmp on macOS, %TEMP% on Windows) and clean up.

const BASE = "http://broker.test:7898";
const ENV = { DISCUSSION_TREE_BROKER_URL: BASE } as Record<string, string>;

type Call = { url: string; method?: string; body: any };
const realFetch = globalThis.fetch;
let calls: Call[] = [];
let responder: (url: string) => Record<string, unknown> = () => ({});

function installFetch(): void {
  calls = [];
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : input?.url;
    let body: any;
    try {
      body = init?.body ? JSON.parse(init.body) : undefined;
    } catch {
      body = init?.body;
    }
    calls.push({ url, method: init?.method, body });
    return new Response(JSON.stringify(responder(url)), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as any;
}

function callTo(suffix: string): Call | undefined {
  return calls.find((c) => c.url.endsWith(suffix));
}

const seeded: string[] = [];
function seed(name: string, content: string): void {
  const p = path.join(statuslineTmpDir(), name);
  fs.writeFileSync(p, content);
  seeded.push(p);
}

afterEach(() => {
  globalThis.fetch = realFetch;
  responder = () => ({});
  for (const p of seeded.splice(0)) {
    try {
      fs.rmSync(p, { force: true });
    } catch {
      /* already gone */
    }
  }
});

describe("cc-context-report-hook", () => {
  test("pct file present -> POST /report-context-usage with numeric remaining_pct", async () => {
    installFetch();
    const sid = `ctx-pct-${Date.now()}`;
    seed(`claude-sl-${sid}-pct`, "42.0\n");
    await runContextReport({ session_id: sid }, ENV);

    const c = callTo("/report-context-usage");
    expect(c).toBeTruthy();
    expect(c!.url).toBe(`${BASE}/report-context-usage`);
    expect(c!.method).toBe("POST");
    expect(c!.body).toEqual({ cc_session_id: sid, remaining_pct: 42 });
    // No limits file -> no usage-limits POST.
    expect(callTo("/report-usage-limits")).toBeUndefined();
  });

  test("limits file present -> POST /report-usage-limits incl. account + cc_session_id", async () => {
    installFetch();
    const sid = `ctx-lim-${Date.now()}`;
    seed(
      `claude-sl-${sid}-limits.json`,
      JSON.stringify({ five_hour: { used_pct: 12 }, seven_day: { used_pct: 34 } }),
    );
    const acct = "/Users/x/.claude-pd";
    await runContextReport(
      { session_id: sid },
      { ...ENV, CLAUDE_CONFIG_DIR: acct },
    );

    const c = callTo("/report-usage-limits");
    expect(c).toBeTruthy();
    expect(c!.url).toBe(`${BASE}/report-usage-limits`);
    expect(c!.body).toEqual({
      five_hour: { used_pct: 12 },
      seven_day: { used_pct: 34 },
      cc_session_id: sid,
      account: acct,
    });
    // No pct file -> no context-usage POST.
    expect(callTo("/report-context-usage")).toBeUndefined();
  });

  test("both files present -> both POSTs fire", async () => {
    installFetch();
    const sid = `ctx-both-${Date.now()}`;
    seed(`claude-sl-${sid}-pct`, "7");
    seed(`claude-sl-${sid}-limits.json`, JSON.stringify({ a: 1 }));
    await runContextReport({ session_id: sid }, ENV);
    expect(callTo("/report-context-usage")!.body.remaining_pct).toBe(7);
    expect(callTo("/report-usage-limits")!.body).toMatchObject({
      a: 1,
      cc_session_id: sid,
    });
  });

  test("no files -> no POST at all", async () => {
    installFetch();
    await runContextReport({ session_id: `ctx-none-${Date.now()}` }, ENV);
    expect(calls.length).toBe(0);
  });

  test("malformed pct value is skipped (no context POST)", async () => {
    installFetch();
    const sid = `ctx-bad-${Date.now()}`;
    seed(`claude-sl-${sid}-pct`, "not-a-number");
    await runContextReport({ session_id: sid }, ENV);
    expect(callTo("/report-context-usage")).toBeUndefined();
  });

  test("empty limits object is rejected (jq: length > 0)", async () => {
    installFetch();
    const sid = `ctx-empty-${Date.now()}`;
    seed(`claude-sl-${sid}-limits.json`, "{}");
    await runContextReport({ session_id: sid }, ENV);
    expect(callTo("/report-usage-limits")).toBeUndefined();
  });

  test("no session_id -> no POST", async () => {
    installFetch();
    await runContextReport({}, ENV);
    expect(calls.length).toBe(0);
  });
});

describe("stop-failure-hook", () => {
  test("POST /session-stalled with cc_session_id + transcript_path", async () => {
    installFetch();
    await runStopFailure(
      { session_id: "sf-1", transcript_path: "/x/transcript.jsonl" },
      ENV,
    );
    const c = callTo("/session-stalled");
    expect(c).toBeTruthy();
    expect(c!.url).toBe(`${BASE}/session-stalled`);
    expect(c!.method).toBe("POST");
    expect(c!.body).toEqual({
      cc_session_id: "sf-1",
      transcript_path: "/x/transcript.jsonl",
    });
  });

  test("missing transcript_path is sent as empty string", async () => {
    installFetch();
    await runStopFailure({ session_id: "sf-2" }, ENV);
    expect(callTo("/session-stalled")!.body).toEqual({
      cc_session_id: "sf-2",
      transcript_path: "",
    });
  });

  test("no session_id -> no POST", async () => {
    installFetch();
    await runStopFailure({}, ENV);
    expect(calls.length).toBe(0);
  });
});

describe("post-compact-board-reminder", () => {
  const STATIC_MARK = "[discussion-tree post-compact notice]";

  test("emits the static notice AND fires all four POSTs; nudges when counts > 0", async () => {
    installFetch();
    responder = (url) => {
      if (url.endsWith("/session-compacting-done"))
        return { previous_compact_at: "2026-09-23T01:02:03Z" };
      if (url.endsWith("/get-incomplete-checklists")) return { count: 2 };
      if (url.endsWith("/review-message-links")) return { total: 3 };
      return {};
    };

    const out = await runPostCompact({ session_id: "pc-1" }, ENV);

    // Static notice always present.
    expect(out.startsWith(STATIC_MARK)).toBe(true);
    // Both conditional nudges present with the exact counts.
    expect(out).toContain("[discussion-tree unfinished-checklist notice]");
    expect(out).toContain("You own 2 board(s)");
    expect(out).toContain("[discussion-tree issue-link review]");
    expect(out).toContain("3 message(s) from the window you just compacted");

    // compacting-done badge clear.
    expect(callTo("/session-compacting-done")!.body).toEqual({
      cc_session_id: "pc-1",
    });
    // context meter reset to 100.
    expect(callTo("/report-context-usage")!.body).toEqual({
      cc_session_id: "pc-1",
      remaining_pct: 100,
    });
    // incomplete-checklists probe.
    expect(callTo("/get-incomplete-checklists")!.body).toEqual({
      cc_session_id: "pc-1",
    });
    // review-message-links carries the window (from = previous_compact_at).
    expect(callTo("/review-message-links")!.body).toEqual({
      cc_session_id: "pc-1",
      unlinked_only: true,
      head_chars: 60,
      from: "2026-09-23T01:02:03Z",
    });
  });

  test("counts of 0 -> POSTs still fire but no nudges appended", async () => {
    installFetch();
    responder = (url) => {
      if (url.endsWith("/get-incomplete-checklists")) return { count: 0 };
      if (url.endsWith("/review-message-links")) return { total: 0 };
      return {};
    };
    const out = await runPostCompact({ session_id: "pc-0" }, ENV);
    expect(out.startsWith(STATIC_MARK)).toBe(true);
    expect(out).not.toContain("unfinished-checklist notice");
    expect(out).not.toContain("issue-link review");
    // Still four POSTs (badge clear, meter reset, both probes).
    expect(calls.length).toBe(4);
  });

  test("no previous_compact_at -> review `from` falls back to a UTC day-ago stamp", async () => {
    installFetch();
    responder = () => ({}); // no previous_compact_at, count/total absent
    await runPostCompact({ session_id: "pc-fallback" }, ENV);
    const from = callTo("/review-message-links")!.body.from as string;
    // ISO-8601 UTC, no milliseconds, trailing Z (matches the .sh date format).
    expect(from).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });

  test("no session_id -> returns static notice only, no POSTs", async () => {
    installFetch();
    const out = await runPostCompact({}, ENV);
    expect(out.startsWith(STATIC_MARK)).toBe(true);
    expect(calls.length).toBe(0);
  });
});
