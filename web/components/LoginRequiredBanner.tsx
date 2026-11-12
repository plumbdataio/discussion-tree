import React, { useState } from "react";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import type { LoginRequiredSession } from "../../shared/types.ts";

// Banner row listing the sessions that stopped because their login expired (or
// another account problem only a human can fix). Data comes from GlobalBanner,
// which owns the always-on socket and fetches /get-login-required; this only
// decides what to show. dt sends no auto-continue to these sessions, so without
// this row a stopped session on another machine looks merely idle.
//
// Dismiss is local and keyed by the set of sessions + their stop times, so
// hiding the row never hides a session that stops LATER.

function dismissKey(sessions: LoginRequiredSession[]): string {
  return sessions.map((s) => `${s.session_id}@${s.since}`).join("|");
}

export function LoginRequiredBanner({
  sessions,
}: {
  sessions: LoginRequiredSession[];
}) {
  const { t } = useTranslation();
  const [dismissed, setDismissed] = useState<string | null>(null);
  if (sessions.length === 0) return null;
  const key = dismissKey(sessions);
  if (dismissed === key) return null;

  return (
    <div
      className="global-banner global-banner-error"
      role="status"
      aria-live="polite"
    >
      <span className="global-banner-message">{t("login_required.message")}</span>
      <span className="global-banner-sessions">
        {sessions.map((s) => (
          <a
            key={s.session_id}
            className="global-banner-session"
            href={"/session/" + s.session_id}
          >
            {s.name || s.session_id}
          </a>
        ))}
      </span>
      <span className="global-banner-detail">{t("login_required.hint")}</span>
      <button
        type="button"
        className="global-banner-dismiss"
        title={t("login_required.dismiss")}
        aria-label={t("login_required.dismiss")}
        onClick={() => setDismissed(key)}
      >
        <X size={14} strokeWidth={2} />
      </button>
    </div>
  );
}
