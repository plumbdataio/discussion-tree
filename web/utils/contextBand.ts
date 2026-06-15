// Severity band for the sidebar's context-low "CTX" chip, derived from a
// session's context free %. Shown when free % drops below 15 (per request);
// "critical" at <=10 to line up with ContextMeter's red band (also <=10%).
// Above 15 → null (no chip). Non-numeric input (no report yet / dead session)
// → null. Kept as a tiny pure function so the threshold has one home and is
// unit-testable (the chip itself just maps the band to a CSS class).
export type ContextWarnBand = "warn" | "critical" | null;

export function contextWarnBand(
  remainingPct: number | null | undefined,
): ContextWarnBand {
  if (typeof remainingPct !== "number" || Number.isNaN(remainingPct)) {
    return null;
  }
  if (remainingPct <= 10) return "critical";
  if (remainingPct < 15) return "warn";
  return null;
}
