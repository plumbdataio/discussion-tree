import React from "react";
import type { Activity } from "../../shared/types.ts";

function ActivityBadgeImpl({ activity }: { activity: Activity }) {
  const label = activity.state || "";
  const msg = activity.message || "";
  return (
    <span className="activity-badge" data-state={label}>
      <span className="activity-dot" />
      {label && <strong className="activity-state">{label}</strong>}
      {msg && <span className="activity-msg">{msg}</span>}
    </span>
  );
}

// Memoized: activity objects get replaced on every WS push and on every
// /api/board fetch, but the visible chip only depends on state + message.
export const ActivityBadge = React.memo(
  ActivityBadgeImpl,
  (prev, next) =>
    prev.activity.state === next.activity.state &&
    prev.activity.message === next.activity.message &&
    prev.activity.node_id === next.activity.node_id &&
    prev.activity.board_id === next.activity.board_id,
);
