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
      <line x1="12" y1="1.5" x2="12" y2="3" />
      <line x1="12" y1="11" x2="12" y2="13" />
      <line x1="12" y1="21" x2="12" y2="22.5" />
      {/* Upper diamond — wide (5→19) and short so it reads as a landscape
          flowchart node and fills the icon box like the board/map glyphs. */}
      <path d="M12 3 L19 7 L12 11 L5 7 Z" />
      {/* Lower diamond. */}
      <path d="M12 13 L19 17 L12 21 L5 17 Z" />
    </svg>
  );
}
