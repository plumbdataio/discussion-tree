import { describe, test, expect } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { UsageLimitsChip } from "../../web/components/UsageLimitsChip.tsx";
import { sameExtraWindows } from "../../web/utils/usageLimits.ts";
import type { UsageLimits } from "../../shared/types.ts";

// UsageLimitsChip: the 5h / 7d windows plus optional extra windows rendered at
// the right end inside the same chip, with the same color thresholds.
const html = (limits: UsageLimits | null) =>
  renderToStaticMarkup(createElement(UsageLimitsChip, { limits }));

const base: UsageLimits = {
  five_hour_pct: 10,
  seven_day_pct: 50,
  set_at: "2026-10-16T00:00:00Z",
};

describe("UsageLimitsChip extra windows", () => {
  test("no extra → only the two native units", () => {
    const out = html(base);
    expect((out.match(/class="usage-limits-unit/g) || []).length).toBe(2);
  });

  test("extra windows render after 7d with label and rounded pct", () => {
    const out = html({
      ...base,
      extra: [{ label: "ModelX", pct: 77.4, resets_at: 1900000000 }],
    });
    expect((out.match(/class="usage-limits-unit/g) || []).length).toBe(3);
    const i7 = out.indexOf("50%");
    const iX = out.indexOf("ModelX");
    expect(i7).toBeGreaterThan(-1);
    expect(iX).toBeGreaterThan(i7);
    expect(out).toContain("77%");
  });

  test("same thresholds: >=90 critical, >=75 warn; chip takes the strongest", () => {
    const out = html({
      ...base,
      extra: [{ label: "Hot", pct: 100 }],
    });
    expect(out).toContain('class="usage-limits-chip usage-limits-critical"');
    expect(out).toContain('class="usage-limits-unit usage-limits-critical"');
    const warn = html({ ...base, extra: [{ label: "Warm", pct: 80 }] });
    expect(warn).toContain('class="usage-limits-unit usage-limits-warn"');
  });

  test("extra-only limits still render a chip", () => {
    const out = html({ set_at: "x", extra: [{ label: "Only", pct: 5 }] });
    expect(out).toContain("Only");
  });

  test("nothing at all → no chip", () => {
    expect(html({ set_at: "x", extra: [] })).toBe("");
    expect(html(null)).toBe("");
  });
});

describe("sameExtraWindows", () => {
  test("equal by value; undefined == []", () => {
    expect(sameExtraWindows(undefined, [])).toBe(true);
    expect(
      sameExtraWindows(
        [{ label: "A", pct: 1, resets_at: 2 }],
        [{ label: "A", pct: 1, resets_at: 2 }],
      ),
    ).toBe(true);
  });
  test("any field difference is a change", () => {
    expect(
      sameExtraWindows([{ label: "A", pct: 1 }], [{ label: "A", pct: 2 }]),
    ).toBe(false);
    expect(sameExtraWindows([{ label: "A", pct: 1 }], [])).toBe(false);
  });
});
