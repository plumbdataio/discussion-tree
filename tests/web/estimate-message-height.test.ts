import { describe, test, expect } from "bun:test";
import {
  estimateMessageHeight,
  LIVE_REGION_COUNT,
} from "../../web/utils/estimateMessageHeight.ts";

// The estimate seeds contain-intrinsic-size for content-visibility:auto rows.
// Its only hard contracts: never underestimate as text grows (a short estimate
// under column-reverse is what recoils), and stay inside sane floor/ceiling
// bounds. Exact pixel values aren't load-bearing — the `auto` keyword corrects
// them after first paint — so we assert shape, not magic numbers.
describe("estimateMessageHeight", () => {
  test("empty text returns the floor", () => {
    expect(estimateMessageHeight("")).toBe(52);
  });

  test("floor: a one-word message never drops below the minimum", () => {
    expect(estimateMessageHeight("hi")).toBeGreaterThanOrEqual(52);
  });

  test("monotonic non-decreasing as characters are appended", () => {
    let prev = estimateMessageHeight("");
    let s = "";
    for (let i = 0; i < 500; i++) {
      s += "x";
      const cur = estimateMessageHeight(s);
      expect(cur).toBeGreaterThanOrEqual(prev);
      prev = cur;
    }
  });

  test("a longer message is at least as tall as a shorter one", () => {
    const short = estimateMessageHeight("a".repeat(20));
    const long = estimateMessageHeight("a".repeat(2000));
    expect(long).toBeGreaterThan(short);
  });

  test("wraps: a line well past the wrap width is taller than a short one", () => {
    // 40 chars-per-line divisor, so 200 chars => several wrapped lines.
    const oneLine = estimateMessageHeight("a".repeat(10));
    const manyChars = estimateMessageHeight("a".repeat(200));
    expect(manyChars).toBeGreaterThan(oneLine);
  });

  test("hard newlines add height even when segments are short", () => {
    const flat = estimateMessageHeight("a");
    const fiveLines = estimateMessageHeight("a\na\na\na\na");
    expect(fiveLines).toBeGreaterThan(flat);
  });

  test("errs tall: an inline image reserves more than the same text without it", () => {
    const text = "see the diagram below for the flow";
    const withImage = estimateMessageHeight(`${text}\n![image](/uploads/x.png)`);
    const withoutImage = estimateMessageHeight(`${text}\n[link](/uploads/x.png)`);
    expect(withImage).toBeGreaterThan(withoutImage);
  });

  test("cap: a pathological multi-KB paste clamps to a sane ceiling", () => {
    const huge = estimateMessageHeight("x".repeat(1_000_000));
    expect(huge).toBe(4000);
    expect(Number.isFinite(huge)).toBe(true);
  });

  test("returns a positive integer for realistic input", () => {
    const px = estimateMessageHeight("A normal couple-sentence reply.\nWith a second line.");
    expect(Number.isInteger(px)).toBe(true);
    expect(px).toBeGreaterThan(0);
  });

  test("LIVE_REGION_COUNT is a sane positive live-edge size", () => {
    expect(Number.isInteger(LIVE_REGION_COUNT)).toBe(true);
    expect(LIVE_REGION_COUNT).toBeGreaterThanOrEqual(40);
    expect(LIVE_REGION_COUNT).toBeLessThanOrEqual(120);
  });
});
