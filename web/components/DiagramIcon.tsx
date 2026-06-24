import React from "react";

// The diagram-surface glyph: two diamonds (flowchart decision nodes) threaded
// on a vertical skewer. Deliberately distinct from the board (Network) and map
// (ChartNetwork) graph icons, which were all "connected nodes" and hard to tell
// apart. Stroke-only so it inherits currentColor; the skewer is drawn only
// OUTSIDE the diamonds (short stubs top/bottom + a connector between them) so
// the diamonds stay open and legible even at the 13px sidebar size.
export function DiagramIcon({
  size = 16,
  strokeWidth = 2,
  className,
}: {
  size?: number;
  strokeWidth?: number;
  className?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      {/* The skewer: a top stub, the connector between the diamonds, a bottom
          stub — so the line reads as a single rod through both without crossing
          (and muddying) the diamond interiors. */}
      <line x1="12" y1="2.5" x2="12" y2="4" />
      <line x1="12" y1="11" x2="12" y2="13" />
      <line x1="12" y1="20" x2="12" y2="21.5" />
      {/* Upper diamond. */}
      <path d="M12 4 L15.5 7.5 L12 11 L8.5 7.5 Z" />
      {/* Lower diamond. */}
      <path d="M12 13 L15.5 16.5 L12 20 L8.5 16.5 Z" />
    </svg>
  );
}
