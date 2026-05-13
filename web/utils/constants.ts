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
