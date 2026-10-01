import { describe, test, expect, afterEach } from "bun:test";
import * as path from "node:path";

import {
  buildUnansweredOutput,
  runCheckUnanswered,
} from "../../scripts/check-unanswered-posts.ts";

// Locks the ts port of check-unanswered-posts.sh (the Stop-hook "you have
// unanswered dt posts" nag) against the broker contract the .sh established:
// POST /get-unanswered {cc_session_id}; block only when count>0 AND the broker's
// block flag is true (the streak cap lives broker-side); on block, re-arm the
// working badge via /heartbeat-tool and print jq-style pretty JSON
// {"decision":"block","reason":...}; otherwise print nothing (stop allowed).

const BASE = "http://broker.test:7898";
const ENV = { DISCUSSION_TREE_BROKER_URL: BASE } as Record<string, string>;

type Call = { url: string; method?: string; body: any };
const realFetch = globalThis.fetch;
let calls: Call[] = [];
let responder: (url: string) => unknown = () => ({});

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

function installDownFetch(): void {
  calls = [];
  globalThis.fetch = (async (input: any, init?: any) => {
    calls.push({ url: String(input), method: init?.method, body: undefined });
    throw new TypeError("connect ECONNREFUSED");
  }) as any;
}

function callTo(suffix: string): Call | undefined {
  return calls.find((c) => c.url.endsWith(suffix));
}

afterEach(() => {
  globalThis.fetch = realFetch;
  responder = () => ({});
});

const TWO_NODES = {
  ok: true,
  count: 2,
  block: true,
  session_id: "s1",
  nodes: [
    {
      board_id: "bd_1",
      node_id: "i1",
      node_path: "Board A > C1 > I1",
      surface: "board",
      reply_tool: "post_to_node",
    },
    {
      board_id: "dg_1",
      node_id: "chat",
      node_path: "Diagram X",
      surface: "diagram",
      reply_tool: "post_diagram_chat",
    },
  ],
};

describe("check-unanswered-posts hook", () => {
  test("unanswered nodes + block:true -> blocks with a reason naming each node and its reply tool", async () => {
    installFetch();
    responder = (url) => (url.endsWith("/get-unanswered") ? TWO_NODES : {});
    const out = await runCheckUnanswered({ session_id: "cc-1" }, ENV);

    expect(callTo("/get-unanswered")!.body).toEqual({ cc_session_id: "cc-1" });
    expect(callTo("/get-unanswered")!.method).toBe("POST");
    // Badge re-arm only on block.
    expect(callTo("/heartbeat-tool")!.body).toEqual({
      cc_session_id: "cc-1",
      tool: "stop-hook-continuation",
    });

    expect(out.endsWith("}\n")).toBe(true);
    const j = JSON.parse(out);
    expect(j.decision).toBe("block");
    expect(j.reason).toContain(
      "have a dt post (from the user or an external notification) you have not replied to yet:",
    );
    expect(j.reason).toContain("  - Board A > C1 > I1  → reply with post_to_node");
    expect(j.reason).toContain("  - Diagram X  → reply with post_diagram_chat");
    expect(j.reason).toContain("call reset_unanswered_posts to yield");
    expect(j.reason).not.toContain("user submission");
    // jq's default pretty-print shape.
    expect(out.startsWith('{\n  "decision": "block",\n  "reason": "')).toBe(true);
  });

  test("count 0 -> allows stop (no output, no heartbeat)", async () => {
    installFetch();
    responder = () => ({ ok: true, count: 0, block: false, nodes: [] });
    const out = await runCheckUnanswered({ session_id: "cc-0" }, ENV);
    expect(out).toBe("");
    expect(callTo("/get-unanswered")).toBeTruthy();
    expect(callTo("/heartbeat-tool")).toBeUndefined();
  });

  test("broker streak cap (count>0 but block:false) -> allows stop", async () => {
    installFetch();
    responder = () => ({ ...TWO_NODES, block: false });
    expect(await runCheckUnanswered({ session_id: "cc-cap" }, ENV)).toBe("");
    expect(callTo("/heartbeat-tool")).toBeUndefined();
  });

  test("stop_hook_active is NOT consulted (still blocks), as in the .sh", async () => {
    installFetch();
    responder = () => TWO_NODES;
    const out = await runCheckUnanswered(
      { session_id: "cc-active", stop_hook_active: true },
      ENV,
    );
    expect(JSON.parse(out).decision).toBe("block");
  });

  test("broker down -> allows stop (fail open), no throw", async () => {
    installDownFetch();
    const out = await runCheckUnanswered({ session_id: "cc-down" }, ENV);
    expect(out).toBe("");
    // Only the /get-unanswered attempt; no heartbeat because nothing blocks.
    expect(calls.length).toBe(1);
  });

  test("no session_id -> no request, no output", async () => {
    installFetch();
    expect(await runCheckUnanswered({}, ENV)).toBe("");
    expect(calls.length).toBe(0);
  });

  test("pure core mirrors jq edge semantics", () => {
    // `.count // 0` + ^[0-9]+$ guard.
    expect(buildUnansweredOutput({})).toBe("");
    expect(buildUnansweredOutput({ count: -1, block: true })).toBe("");
    expect(buildUnansweredOutput({ count: 1.5, block: true })).toBe("");
    expect(buildUnansweredOutput({ count: "x", block: true })).toBe("");
    expect(buildUnansweredOutput({ count: 1, block: "false" })).toBe("");
    // Missing reply_tool falls back to post_to_node.
    const out = buildUnansweredOutput({
      count: 1,
      block: true,
      nodes: [{ node_path: "P" }],
    });
    expect(JSON.parse(out).reason).toContain("  - P  → reply with post_to_node");
  });
});

// ---- Output parity with the real .sh ----------------------------------------
// Runs the bash original against a mock broker (DISCUSSION_TREE_BROKER_URL) and
// compares its stdout byte-for-byte with the ts port for the same response.
const hasShTooling =
  process.platform !== "win32" &&
  Bun.which("bash") !== null &&
  Bun.which("jq") !== null &&
  Bun.which("curl") !== null;

describe.skipIf(!hasShTooling)("check-unanswered-posts .sh parity", () => {
  const SH = path.join(import.meta.dir, "../../scripts/check-unanswered-posts.sh");

  async function runSh(response: unknown): Promise<{ stdout: string; paths: string[] }> {
    const paths: string[] = [];
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        paths.push(new URL(req.url).pathname);
        const p = new URL(req.url).pathname;
        return new Response(JSON.stringify(p === "/get-unanswered" ? response : {}), {
          headers: { "Content-Type": "application/json" },
        });
      },
    });
    try {
      const proc = Bun.spawn(["bash", SH], {
        env: {
          ...process.env,
          DISCUSSION_TREE_BROKER_URL: `http://127.0.0.1:${server.port}`,
        },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });
      proc.stdin.write(JSON.stringify({ session_id: "cc-parity", stop_hook_active: true }));
      await proc.stdin.end();
      const stdout = await new Response(proc.stdout).text();
      await proc.exited;
      return { stdout, paths };
    } finally {
      server.stop(true);
    }
  }

  const cases: [string, unknown][] = [
    ["two nodes, block", TWO_NODES],
    [
      "one map node, missing reply_tool, quotes/backslash in path",
      {
        count: 1,
        block: true,
        nodes: [{ node_path: 'Map "M" \\ n1', surface: "map" }],
      },
    ],
    ["streak cap", { ...TWO_NODES, block: false }],
    ["none", { ok: true, count: 0, block: false, nodes: [] }],
  ];

  for (const [name, resp] of cases) {
    test(`stdout parity: ${name}`, async () => {
      const sh = await runSh(resp);
      const ts = buildUnansweredOutput(resp);
      expect(ts).toBe(sh.stdout);
      // Same endpoint sequence: heartbeat only when blocking.
      expect(sh.paths).toEqual(
        ts ? ["/get-unanswered", "/heartbeat-tool"] : ["/get-unanswered"],
      );
    });
  }
});
