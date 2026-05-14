// Translated status labels live in locale files (node_status.* /
// board_status.*). Components call t("node_status.pending") etc directly —
// keeping a separate constant map here would drift out of sync.
//
// Membership of these arrays is asserted to match the shared NodeStatus /
// BoardStatus unions in shared/types.ts. When introducing a new status,
// update BOTH places (the union type AND this array) so callers that iterate
// can see the new value.

export const NODE_STATUSES = [
  "pending",
  "discussing",
  "resolved",
  "agreed",
  "adopted",
  "rejected",
  "needs-reply",
  "done",
] as const;

// "discussing" / "settled" are auto-managed by the broker (rolled up from
// node statuses); "completed" / "withdrawn" / "paused" are explicit
// lifecycle decisions. Both kinds show up here so the sidebar filter offers
// the full set as checkboxes.
export const BOARD_STATUSES = [
  "discussing",
  "settled",
  "completed",
  "withdrawn",
  "paused",
] as const;

// Coerce any persisted board status into the current taxonomy. The legacy
// value 'active' (pre-rename) is mapped to 'discussing' — the broker's
// startup migration normally rewrites these rows, but if a stale row sneaks
// past (mid-migration, an external sqlite edit, an older replica), this
// keeps the UI from rendering the raw "ACTIVE" string via the i18n fallback.
// Also defends against null / undefined / unknown values so callers don't
// need their own ?? chain.
export function normalizeBoardStatus(
  raw: string | null | undefined,
): (typeof BOARD_STATUSES)[number] {
  if (raw === "active" || raw == null) return "discussing";
  return (BOARD_STATUSES as readonly string[]).includes(raw)
    ? (raw as (typeof BOARD_STATUSES)[number])
    : "discussing";
}
