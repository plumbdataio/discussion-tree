import React from "react";

// Outline-only SVG glyph used for the Sidebar's "blocked = CC is waiting on
// the user" indicator. Style: a chat bubble (= "the assistant wants to
// speak with you") with a small alert circle pinned to the top-right
// corner (= "act on this now"). Both shapes are stroke-only so the icon
// inherits currentColor cleanly and the pulse animation reads as a
// uniform attention-getter.
//
// We don't reuse lucide's MessageCircle + AlertCircle composed together
// because the two glyphs always overlap visually — keeping a hand-tuned
// combined glyph means the bubble and the badge never share pixels.
export function HelpBubbleIcon({
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
      {/* Speech bubble: rounded rectangle body with a tail at the
          bottom-left, sized to leave the top-right corner free for the
          alert badge. */}
      <path d="M4 9a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2H8l-3 3v-3H6a2 2 0 0 1-2-2z" />
      {/* Alert badge — separate ring at the top-right corner so it
          doesn't clip the bubble outline. */}
      <circle cx="20" cy="4" r="3" />
      {/* Exclamation stem inside the badge. */}
      <line x1="20" y1="2.7" x2="20" y2="4.2" />
      {/* Exclamation dot — a zero-length line rendered as a round cap
          gives us a filled-looking pixel without needing a separate
          <circle fill="currentColor">. */}
      <line x1="20" y1="5.4" x2="20" y2="5.4" />
    </svg>
  );
}
