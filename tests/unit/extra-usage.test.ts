import { describe, test, expect } from "bun:test";
import {
  cleanExtraWindows,
  liveExtraWindows,
  normalizeResetsAt,
  MAX_EXTRA_WINDOWS,
  MAX_EXTRA_LABEL_LEN,
} from "../../broker/extra-usage.ts";

// Validation + staleness of the optional extra usage windows a user's
// statusline setup may supply alongside the native 5h / 7d windows.

describe("normalizeResetsAt", () => {
  test("epoch seconds pass through (floored)", () => {
    expect(normalizeResetsAt(1900000000.7)).toBe(1900000000);
  });
  test("epoch milliseconds become seconds", () => {
    expect(normalizeResetsAt(1900000000123)).toBe(1900000000);
  });
  test("ISO string with offset becomes seconds", () => {
    expect(normalizeResetsAt("2026-10-16T21:00:00.354052+00:00")).toBe(
      Math.floor(Date.parse("2026-10-16T21:00:00Z") / 1000),
    );
  });
  test("garbage → undefined", () => {
    expect(normalizeResetsAt("soon")).toBeUndefined();
    expect(normalizeResetsAt(-5)).toBeUndefined();
    expect(normalizeResetsAt(null)).toBeUndefined();
    expect(normalizeResetsAt(NaN)).toBeUndefined();
  });
});

describe("cleanExtraWindows", () => {
  test("absent / non-array → undefined (no information)", () => {
    expect(cleanExtraWindows(undefined)).toBeUndefined();
    expect(cleanExtraWindows({ label: "x", pct: 1 })).toBeUndefined();
    expect(cleanExtraWindows("[]")).toBeUndefined();
  });

  test("empty array → [] (the source says none)", () => {
    expect(cleanExtraWindows([])).toEqual([]);
  });

  test("valid entries are kept, resets_at normalized", () => {
    expect(
      cleanExtraWindows([
        { label: " Opus ", pct: 42.5, resets_at: "2030-01-01T00:00:00Z" },
        { label: "Mini", pct: 0 },
      ]),
    ).toEqual([
      {
        label: "Opus",
        pct: 42.5,
        resets_at: Math.floor(Date.parse("2030-01-01T00:00:00Z") / 1000),
      },
      { label: "Mini", pct: 0 },
    ]);
  });

  test("invalid entries are skipped", () => {
    expect(
      cleanExtraWindows([
        null,
        "x",
        { label: "", pct: 5 },
        { label: 3, pct: 5 },
        { label: "A", pct: 101 },
        { label: "B", pct: -1 },
        { label: "C", pct: "50" },
        { label: "D", pct: 50 },
      ]),
    ).toEqual([{ label: "D", pct: 50 }]);
  });

  test("labels are length-capped; duplicates keep the first", () => {
    const long = "x".repeat(40);
    const out = cleanExtraWindows([
      { label: long, pct: 1 },
      { label: "Dup", pct: 2 },
      { label: "Dup", pct: 3 },
    ])!;
    expect(out[0].label.length).toBe(MAX_EXTRA_LABEL_LEN);
    expect(out.filter((w) => w.label === "Dup")).toEqual([
      { label: "Dup", pct: 2 },
    ]);
  });

  test("at most MAX_EXTRA_WINDOWS entries", () => {
    const many = Array.from({ length: 10 }, (_, i) => ({
      label: `L${i}`,
      pct: i,
    }));
    expect(cleanExtraWindows(many)!.length).toBe(MAX_EXTRA_WINDOWS);
  });
});

describe("liveExtraWindows", () => {
  const now = Date.parse("2026-10-16T12:00:00Z");
  const sec = (iso: string) => Math.floor(Date.parse(iso) / 1000);

  test("a window past its resets_at is dropped, a future one kept", () => {
    const ws = [
      { label: "Past", pct: 90, resets_at: sec("2026-10-16T11:59:00Z") },
      { label: "Future", pct: 10, resets_at: sec("2026-10-16T21:00:00Z") },
    ];
    expect(liveExtraWindows(ws, "2026-10-16T10:00:00Z", now)).toEqual([ws[1]]);
  });

  test("no resets_at: kept for up to 7 days after the report, then dropped", () => {
    const ws = [{ label: "NoReset", pct: 5 }];
    expect(liveExtraWindows(ws, "2026-10-15T12:00:00Z", now)).toEqual(ws);
    expect(liveExtraWindows(ws, "2026-10-01T12:00:00Z", now)).toEqual([]);
  });
});
