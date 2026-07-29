import React, { useCallback, useEffect, useState } from "react";
import { ClipboardList } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  isAwaitingApproval,
  fetchIssues,
  openIssueTracker,
  subscribeIssuesChanged,
} from "../utils/issues.ts";

// Entry point for the cross-session issue ledger. It sits in the sidebar's
// existing title row rather than as a list entry, because the user's standing
// constraint is that the sidebar must not grow taller and the header must not
// lose its empty space — an icon in a row that already exists costs neither.
//
// The badge is the reason to look: it counts issues where the ball is with the
// user and the work is not finished. Without it the entry is just another door,
// and doors that never say anything stop being opened.

const REFRESH_MS = 60_000;

export function IssueTrackerButton() {
  const { t } = useTranslation();
  const [mine, setMine] = useState(0);

  const recount = useCallback(() => {
    fetchIssues(false)
      .then((r) =>
        setMine(
          (r.issues ?? []).filter(
            (i) =>
              // A close waiting to be signed off is on the user's plate too —
              // it is closed, so the owner/state test alone would miss exactly
              // the rows that need them.
              isAwaitingApproval(i) ||
              (i.owner === "user" && (i.state === "todo" || i.state === "doing")),
          ).length,
        ),
      )
      .catch(() => {
        /* a blip leaves the last known count rather than flashing zero */
      });
  }, []);

  useEffect(() => {
    recount();
    const id = setInterval(recount, REFRESH_MS);
    const off = subscribeIssuesChanged(recount);
    return () => {
      clearInterval(id);
      off();
    };
  }, [recount]);

  return (
    <button
      type="button"
      className="sidebar-issues-btn"
      aria-label={t("issues.open_label", { count: mine })}
      title={t("issues.open_label", { count: mine })}
      onClick={openIssueTracker}
    >
      <ClipboardList size={16} strokeWidth={2} />
      {/* Absolutely positioned so appearing/disappearing never nudges the
          sibling buttons in this row. */}
      {mine > 0 && <span className="sidebar-issues-badge">{mine}</span>}
    </button>
  );
}
