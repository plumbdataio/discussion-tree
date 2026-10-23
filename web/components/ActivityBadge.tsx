import React from "react";
import { useTranslation } from "react-i18next";
import type { Activity } from "../../shared/types.ts";
import { clearWorkingActivity } from "../utils/clearWorkingActivity.ts";

function ActivityBadgeImpl({
  activity,
  clearable = false,
}: {
  activity: Activity;
  // Header badges pass true: a click on a hook-managed "working" badge clears
  // it (escape hatch for a Stop-hook clear that never reached the broker).
  // Explicit LLM states ("blocked", ...) are never clickable.
  clearable?: boolean;
}) {
  const { t } = useTranslation();
  const label = activity.state || "";
  const msg = activity.message || "";
  const body = (
    <>
      <span className="activity-dot" />
      {label && <strong className="activity-state">{label}</strong>}
      {msg && <span className="activity-msg">{msg}</span>}
    </>
  );
  if (clearable && label === "working" && activity.session_id) {
    return (
      <button
        type="button"
        className="activity-badge activity-badge-clearable"
        data-state={label}
        title={t("activity.clear_working_hint")}
        aria-label={t("activity.clear_working_aria")}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          void clearWorkingActivity(activity.session_id);
        }}
      >
        {body}
      </button>
    );
  }
  return (
    <span className="activity-badge" data-state={label}>
      {body}
    </span>
  );
}

// Memoized: activity objects get replaced on every WS push and on every
// /api/board fetch, but the visible chip only depends on state + message.
export const ActivityBadge = React.memo(
  ActivityBadgeImpl,
  (prev, next) =>
    prev.clearable === next.clearable &&
    prev.activity.session_id === next.activity.session_id &&
    prev.activity.state === next.activity.state &&
    prev.activity.message === next.activity.message &&
    prev.activity.node_id === next.activity.node_id &&
    prev.activity.board_id === next.activity.board_id,
);
