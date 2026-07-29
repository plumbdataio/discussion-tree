import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { RotateCw } from "lucide-react";
import { subscribeOutdated } from "../utils/appUpdate.ts";

// "The page you are looking at is not the latest build" — the replacement for
// HMR, which reloaded the user's page on every edit under web/ and made the app
// unusable while an agent was working in it (see broker.ts).
//
// It STAYS until acted on, and reloading is the user's call. An earlier cut
// reloaded automatically whenever nothing looked at risk, on the theory that a
// prompt would be ignored; the user pointed out that a prompt which never goes
// away cannot be missed for long, so the whole "is it safe right now" judgement
// — and the chance of getting it wrong while they were mid-sentence — was
// removed rather than made smarter.
//
// Note it does NOT mean "the agent finished": it appears on any broker restart
// that changed web/, including ones mid-task. It states exactly one thing —
// this tab is stale.
//
// Shares the connection banner's shape and position so the app has one place to
// speak about itself.

export function UpdateBanner() {
  const { t } = useTranslation();
  const [outdated, setOutdated] = useState(false);

  useEffect(() => subscribeOutdated(() => setOutdated(true)), []);

  if (!outdated) return null;

  return (
    <div className="connection-banner update" role="status">
      <RotateCw size={13} aria-hidden="true" />
      <span className="connection-banner-message">{t("update.available")}</span>
      <button
        type="button"
        className="connection-banner-reload"
        onClick={() => window.location.reload()}
        title={t("update.reload_title")}
      >
        {t("update.reload")}
      </button>
    </div>
  );
}
