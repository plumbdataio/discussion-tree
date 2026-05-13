// Translated status labels live in locale files (node_status.* /
// board_status.*). Components call t("node_status.pending") etc directly —
// keeping a separate constant map here would drift out of sync.

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

export const BOARD_STATUSES = [
  "active",
  "completed",
  "withdrawn",
  "paused",
] as const;
