import React from "react";

type Usage = { remaining_pct: number; set_at: string };

// Severity bands mirror the statusline script's compact-judgement
// thresholds: <= 5% is the "compact mandatory" red band, <= 20% is the
// caution band, otherwise plenty of headroom.
function severityClass(pct: number): string {
  if (pct <= 5) return "context-critical";
  if (pct <= 20) return "context-warn";
  return "context-ok";
}

// Single source of truth for the "context free %" chip rendered in the
// board header, the session dashboard header, and the root-dashboard
// session cards. Returns null when no usage has been reported yet, so
// callers can drop in `<ContextMeter usage={...} />` unconditionally.
function ContextMeterImpl({
  usage,
  prefix,
}: {
  usage: Usage | null | undefined;
  // Optional leading label, e.g. "Context: ". The Root-dashboard cards
  // omit this because the row is already cramped; the headers include
  // it so the number isn't ambiguous next to other numeric chips.
  prefix?: string;
}) {
  if (!usage) return null;
  const pct = usage.remaining_pct;
  return (
    <span
      className={`context-meter ${severityClass(pct)}`}
      title={`Context: ${pct.toFixed(0)}% free (reported ${usage.set_at})`}
    >
      {prefix}
      {pct.toFixed(0)}%
    </span>
  );
}

// Memoized so the chip doesn't re-render on every parent re-render
// (BoardApp updates state on every WS message / draft keystroke).
// Custom comparator: usage prop is a fresh object on each fetch, but
// the displayed value only depends on remaining_pct + set_at.
export const ContextMeter = React.memo(
  ContextMeterImpl,
  (prev, next) =>
    prev.prefix === next.prefix &&
    prev.usage?.remaining_pct === next.usage?.remaining_pct &&
    prev.usage?.set_at === next.usage?.set_at,
);
