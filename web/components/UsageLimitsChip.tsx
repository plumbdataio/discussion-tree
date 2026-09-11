import React from "react";
import { useTranslation } from "react-i18next";
import type { UsageLimits } from "../../shared/types.ts";

// @reusable-ui UsageLimitsChip — USE WHEN: showing the account-global Claude
// subscription usage (the native 5h / 7d rate-limit windows Claude Code exposes
// on its statusline) INSTEAD OF hand-rolling a usage readout. These numbers are
// account-wide, so feed it from the shared useUsageLimits() store
// (web/utils/usageLimits.ts, populated by the Sidebar's poll) and render it in a
// page header next to the ContextMeter — never one per session row.

// used% severity rank: the more of a window is consumed, the more it matters.
// >= 90% used is the "almost out" red band; >= 75% is caution; below that stays
// calm. Returned as a rank so the chip can take the STRONGEST window's severity.
type Severity = "" | "warn" | "critical";
function usedSeverity(pct: number | undefined): Severity {
  if (typeof pct !== "number") return "";
  if (pct >= 90) return "critical";
  if (pct >= 75) return "warn";
  return "";
}

function severityRank(s: Severity): number {
  if (s === "critical") return 2;
  if (s === "warn") return 1;
  return 0;
}

function severityClass(s: Severity): string {
  return s ? " usage-limits-" + s : "";
}

// resets_at is a unix epoch in SECONDS. Returns a locale time string, or null
// when absent / unparseable (Claude Code omits it before the first response and
// after a window resets).
function formatResetTime(resetsAt: number | undefined): string | null {
  if (typeof resetsAt !== "number") return null;
  const d = new Date(resetsAt * 1000);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString();
}

function UsageLimitsChipImpl({
  limits,
}: {
  limits: UsageLimits | null | undefined;
}) {
  const { t } = useTranslation();
  if (!limits) return null;
  const hasFive = typeof limits.five_hour_pct === "number";
  const hasSeven = typeof limits.seven_day_pct === "number";
  // Nothing usable to show — don't render an empty chip.
  if (!hasFive && !hasSeven) return null;

  // Hover title: one line per present window, with its reset time when known.
  const titleParts: string[] = [];
  if (hasFive) {
    const rt = formatResetTime(limits.five_hour_resets_at);
    const pct = Math.round(limits.five_hour_pct as number);
    titleParts.push(
      rt
        ? t("usage_limits.five_hour_full", { pct, time: rt })
        : t("usage_limits.five_hour_no_reset", { pct }),
    );
  }
  if (hasSeven) {
    const rt = formatResetTime(limits.seven_day_resets_at);
    const pct = Math.round(limits.seven_day_pct as number);
    titleParts.push(
      rt
        ? t("usage_limits.seven_day_full", { pct, time: rt })
        : t("usage_limits.seven_day_no_reset", { pct }),
    );
  }

  // The chip shows two windows that can differ in severity; color the whole
  // chip background with the STRONGEST present window's severity so a near-limit
  // window reads at a glance as danger, while the per-window value below still
  // tints to say WHICH window is the offender.
  const fiveSev = usedSeverity(limits.five_hour_pct);
  const sevenSev = usedSeverity(limits.seven_day_pct);
  const chipSev =
    severityRank(fiveSev) >= severityRank(sevenSev) ? fiveSev : sevenSev;

  return (
    <div
      className={"usage-limits-chip" + severityClass(chipSev)}
      title={titleParts.join("\n")}
    >
      {hasFive && (
        <span
          className={"usage-limits-unit" + severityClass(fiveSev)}
        >
          <span className="usage-limits-label">
            {t("usage_limits.five_hour_label")}
          </span>
          <span className="usage-limits-value">
            {Math.round(limits.five_hour_pct as number)}%
          </span>
        </span>
      )}
      {hasSeven && (
        <span
          className={"usage-limits-unit" + severityClass(sevenSev)}
        >
          <span className="usage-limits-label">
            {t("usage_limits.seven_day_label")}
          </span>
          <span className="usage-limits-value">
            {Math.round(limits.seven_day_pct as number)}%
          </span>
        </span>
      )}
    </div>
  );
}

// Memoized so it doesn't re-render on every Sidebar state change (the sidebar
// re-renders on each /api/sessions poll and activity update). The rendered
// output depends only on the four numeric fields.
export const UsageLimitsChip = React.memo(
  UsageLimitsChipImpl,
  (prev, next) =>
    prev.limits?.five_hour_pct === next.limits?.five_hour_pct &&
    prev.limits?.seven_day_pct === next.limits?.seven_day_pct &&
    prev.limits?.five_hour_resets_at === next.limits?.five_hour_resets_at &&
    prev.limits?.seven_day_resets_at === next.limits?.seven_day_resets_at,
);
