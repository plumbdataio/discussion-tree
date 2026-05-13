import React from "react";
import type { Activity } from "../../shared/types.ts";

export function ActivityBadge({ activity }: { activity: Activity }) {
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
