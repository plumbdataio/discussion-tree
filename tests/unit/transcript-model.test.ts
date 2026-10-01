import { describe, test, expect, afterAll } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  lastModelFromJsonl,
  modelFromTranscript,
  readTail,
} from "../../scripts/transcript-model.ts";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dt-transcript-model-"));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

const asst = (model: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    type: "assistant",
    message: { model, role: "assistant", content: [{ type: "text", text: "hi" }] },
    ...extra,
  });
const user = (text = "q") =>
  JSON.stringify({ type: "user", message: { role: "user", content: text } });

function write(name: string, lines: string[]): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, lines.join("\n") + "\n");
  return p;
}

describe("lastModelFromJsonl", () => {
  test("finds the model of an assistant line", () => {
    expect(lastModelFromJsonl([user(), asst("claude-opus-5-5")].join("\n"))).toBe(
      "claude-opus-5-5",
    );
  });

  test("the LAST assistant line wins (a /model switch)", () => {
    const text = [
      asst("claude-opus-4-8"),
      user(),
      asst("claude-opus-5-5"),
      user("tool result"),
    ].join("\n");
    expect(lastModelFromJsonl(text)).toBe("claude-opus-5-5");
  });

  test("no assistant lines -> null", () => {
    expect(lastModelFromJsonl([user(), user()].join("\n"))).toBeNull();
    expect(lastModelFromJsonl("")).toBeNull();
  });

  test("a truncated first line is skipped, not fatal", () => {
    const full = asst("claude-sonnet-5");
    const cut = full.slice(Math.floor(full.length / 2));
    expect(lastModelFromJsonl(cut + "\n" + user())).toBeNull();
    expect(
      lastModelFromJsonl(cut + "\n" + asst("claude-haiku-4-5-20251001")),
    ).toBe("claude-haiku-4-5-20251001");
  });

  test("skips synthetic models, sidechain entries and empty models", () => {
    const text = [
      asst("claude-opus-5-5"),
      asst("claude-haiku-4-5-20251001", { isSidechain: true }),
      asst("<synthetic>"),
      asst(""),
    ].join("\n");
    expect(lastModelFromJsonl(text)).toBe("claude-opus-5-5");
  });
});

describe("modelFromTranscript (tail read)", () => {
  test("missing file -> null", () => {
    expect(modelFromTranscript(path.join(dir, "nope.jsonl"))).toBeNull();
  });

  test("huge file: only the tail is read", () => {
    // ~3 MB of old history whose assistant lines carry an OLD model, then a
    // newer model near the end. A tail read must see only the newer one.
    const filler = user("x".repeat(1000));
    const lines: string[] = [];
    for (let i = 0; i < 3000; i++) {
      lines.push(i % 10 === 0 ? asst("claude-opus-4-8") : filler);
    }
    lines.push(asst("claude-opus-5-5"), user());
    const p = write("huge.jsonl", lines);
    expect(fs.statSync(p).size).toBeGreaterThan(2_500_000);
    expect(modelFromTranscript(p, [4096])).toBe("claude-opus-5-5");
    // readTail never returns more than the requested window.
    expect(Buffer.byteLength(readTail(p, 4096), "utf8")).toBeLessThanOrEqual(4096);
  });

  test("widens the window when one huge entry fills the first one", () => {
    const big = user("y".repeat(20_000));
    const p = write("wide.jsonl", [asst("claude-sonnet-5"), big, big]);
    expect(modelFromTranscript(p, [8192])).toBeNull();
    expect(modelFromTranscript(p, [8192, 1024 * 1024])).toBe("claude-sonnet-5");
  });
});
