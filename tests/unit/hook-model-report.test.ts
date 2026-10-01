import { describe, test, expect, afterEach, afterAll } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  MODEL_RESEND_MS,
  modelCacheFile,
  reportModel,
  runContextReport,
  statuslineTmpDir,
} from "../../scripts/cc-context-report-hook.ts";

// The model report rides the PostToolUse hook, so it must POST only when the
// model changed (not on every tool call), yet at least once per session, and
// must not mark a value as reported when the broker refused it. fetch is
// monkeypatched; no real broker.

const BASE = "http://broker.test:7898";
const ENV = { DISCUSSION_TREE_BROKER_URL: BASE } as Record<string, string>;

type Call = { url: string; body: any };
const realFetch = globalThis.fetch;
let calls: Call[] = [];
let ok = true;

function installFetch(): void {
  calls = [];
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : input?.url;
    calls.push({ url, body: init?.body ? JSON.parse(init.body) : undefined });
    return new Response(JSON.stringify({ ok }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as any;
}
const modelCalls = () => calls.filter((c) => c.url.endsWith("/report-model"));

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dt-hook-model-"));
const cleanup: string[] = [];
afterEach(() => {
  globalThis.fetch = realFetch;
  ok = true;
  for (const p of cleanup.splice(0)) fs.rmSync(p, { force: true });
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

function transcript(name: string, models: string[]): string {
  const p = path.join(dir, name);
  fs.writeFileSync(
    p,
    models
      .map((m) =>
        JSON.stringify({ type: "assistant", message: { model: m, content: [] } }),
      )
      .join("\n") + "\n",
  );
  return p;
}

describe("cc-context-report-hook: model report", () => {
  test("POSTs once, then not again while the model is unchanged", async () => {
    installFetch();
    const sid = `model-once-${process.pid}-${Date.now()}`;
    cleanup.push(modelCacheFile(sid, statuslineTmpDir()));
    const tp = transcript(`${sid}.jsonl`, ["claude-opus-5-5"]);

    await runContextReport({ session_id: sid, transcript_path: tp }, ENV);
    expect(modelCalls()).toHaveLength(1);
    expect(modelCalls()[0].url).toBe(`${BASE}/report-model`);
    expect(modelCalls()[0].body).toEqual({
      cc_session_id: sid,
      model: "claude-opus-5-5",
    });

    await runContextReport({ session_id: sid, transcript_path: tp }, ENV);
    await runContextReport({ session_id: sid, transcript_path: tp }, ENV);
    expect(modelCalls()).toHaveLength(1);
  });

  test("POSTs again when the model changes (/model switch)", async () => {
    installFetch();
    const sid = `model-switch-${process.pid}-${Date.now()}`;
    cleanup.push(modelCacheFile(sid, statuslineTmpDir()));
    const tp = transcript(`${sid}.jsonl`, ["claude-opus-4-8"]);
    await runContextReport({ session_id: sid, transcript_path: tp }, ENV);
    transcript(`${sid}.jsonl`, ["claude-opus-4-8", "claude-opus-5-5"]);
    await runContextReport({ session_id: sid, transcript_path: tp }, ENV);
    expect(modelCalls().map((c) => c.body.model)).toEqual([
      "claude-opus-4-8",
      "claude-opus-5-5",
    ]);
  });

  test("a refused report (ok:false) is retried on the next call", async () => {
    installFetch();
    ok = false;
    const sid = `model-retry-${process.pid}-${Date.now()}`;
    cleanup.push(modelCacheFile(sid, statuslineTmpDir()));
    const tp = transcript(`${sid}.jsonl`, ["claude-sonnet-5"]);
    await runContextReport({ session_id: sid, transcript_path: tp }, ENV);
    ok = true;
    await runContextReport({ session_id: sid, transcript_path: tp }, ENV);
    await runContextReport({ session_id: sid, transcript_path: tp }, ENV);
    expect(modelCalls()).toHaveLength(2);
  });

  test("re-sends an unchanged model after MODEL_RESEND_MS", async () => {
    installFetch();
    const sid = `model-ttl-${process.pid}-${Date.now()}`;
    const tmp = fs.mkdtempSync(path.join(dir, "tmp-"));
    const tp = transcript(`${sid}.jsonl`, ["claude-opus-5-5"]);
    const t0 = Date.now();
    await reportModel(sid, tp, BASE, tmp, t0);
    await reportModel(sid, tp, BASE, tmp, t0 + 1000);
    expect(modelCalls()).toHaveLength(1);
    await reportModel(sid, tp, BASE, tmp, t0 + MODEL_RESEND_MS + 5000);
    expect(modelCalls()).toHaveLength(2);
  });

  test("no transcript_path / no assistant line -> no model POST", async () => {
    installFetch();
    const sid = `model-none-${process.pid}-${Date.now()}`;
    await runContextReport({ session_id: sid }, ENV);
    const tp = path.join(dir, `${sid}.jsonl`);
    fs.writeFileSync(tp, JSON.stringify({ type: "user", message: {} }) + "\n");
    await runContextReport({ session_id: sid, transcript_path: tp }, ENV);
    await runContextReport(
      { session_id: sid, transcript_path: path.join(dir, "missing.jsonl") },
      ENV,
    );
    expect(modelCalls()).toHaveLength(0);
  });

  test("broker down: never throws", async () => {
    globalThis.fetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as any;
    const sid = `model-down-${process.pid}-${Date.now()}`;
    cleanup.push(modelCacheFile(sid, statuslineTmpDir()));
    const tp = transcript(`${sid}.jsonl`, ["claude-opus-5-5"]);
    await runContextReport({ session_id: sid, transcript_path: tp }, ENV);
    expect(fs.existsSync(modelCacheFile(sid, statuslineTmpDir()))).toBe(false);
  });
});
