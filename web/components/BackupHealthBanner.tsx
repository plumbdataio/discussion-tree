import React, { useState } from "react";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import type { BackupHealth } from "../../shared/types.ts";
import { formatShortLocalDateTime } from "../utils/format.ts";

// Banner row for a failed / overdue DB backup. Data comes from GlobalBanner,
// which owns the always-on socket and fetches /get-backup-health; this only
// decides what (if anything) to show.
//
// Dismiss is local and keyed by state + finished_at + prune_errors, so hiding
// one failure never hides the NEXT one (a new run changes finished_at).

function dismissKey(h: BackupHealth): string {
  return `${h.state}|${h.finished_at ?? ""}|${h.prune_errors}`;
}

export function BackupHealthBanner({ health }: { health: BackupHealth | null }) {
  const { t } = useTranslation();
  const [dismissed, setDismissed] = useState<string | null>(null);
  if (!health || health.state === "none") return null;
  if (health.state === "ok" && health.prune_errors <= 0) return null;
  const key = dismissKey(health);
  if (dismissed === key) return null;

  const time = health.finished_at
    ? formatShortLocalDateTime(health.finished_at)
    : "";
  let tone: "warn" | "error";
  let message: string;
  let detail: React.ReactNode = null;
  switch (health.state) {
    case "failed":
      tone = "error";
      message = time
        ? t("backup.failed", { time })
        : t("backup.failed_no_time");
      detail = health.error;
      break;
    case "unreadable":
      tone = "error";
      message = t("backup.unreadable");
      detail = health.error;
      break;
    case "stale":
      tone = "warn";
      message = t("backup.stale", { hours: health.stale_after_hours });
      // Label + value as their own small spans, not glued into the sentence.
      detail = time ? (
        <>
          <span className="global-banner-detail-label">
            {t("backup.last_success")}
          </span>
          {time}
        </>
      ) : null;
      break;
    default:
      tone = "warn";
      message = t("backup.prune_errors", { count: health.prune_errors });
  }

  return (
    <div
      className={`global-banner global-banner-${tone}`}
      role="status"
      aria-live="polite"
      title={
        health.log_path
          ? t("backup.log_hint", { path: health.log_path })
          : undefined
      }
    >
      <span className="global-banner-message">{message}</span>
      {detail && <span className="global-banner-detail">{detail}</span>}
      <button
        type="button"
        className="global-banner-dismiss"
        title={t("backup.dismiss")}
        aria-label={t("backup.dismiss")}
        onClick={() => setDismissed(key)}
      >
        <X size={14} strokeWidth={2} />
      </button>
    </div>
  );
}
