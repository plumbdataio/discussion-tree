import { describe, test, expect } from "bun:test";
import { contextWarnBand } from "../../web/utils/contextBand.ts";

// The sidebar "CTX" chip shows when context free % < 15, and goes critical
// (red) at <= 10 to match ContextMeter's red band. Boundaries are the part
// worth pinning.
describe("contextWarnBand", () => {
  test("no report / non-numeric → null (no chip)", () => {
    expect(contextWarnBand(undefined)).toBe(null);
    expect(contextWarnBand(null)).toBe(null);
    expect(contextWarnBand(Number.NaN)).toBe(null);
  });

  test("plenty of headroom → null", () => {
    expect(contextWarnBand(100)).toBe(null);
    expect(contextWarnBand(20)).toBe(null);
    expect(contextWarnBand(16)).toBe(null);
  });

  test("15 is NOT low (strictly below 15 triggers the chip)", () => {
    expect(contextWarnBand(15)).toBe(null);
  });

  test("10 < pct < 15 → warn (amber)", () => {
    expect(contextWarnBand(14.9)).toBe("warn");
    expect(contextWarnBand(12)).toBe("warn");
    expect(contextWarnBand(10.1)).toBe("warn");
  });

  test("pct <= 10 → critical (red), aligning with ContextMeter", () => {
    expect(contextWarnBand(10)).toBe("critical");
    expect(contextWarnBand(8)).toBe("critical");
    expect(contextWarnBand(0)).toBe("critical");
  });
});
