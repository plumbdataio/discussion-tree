import React, { useEffect, useState } from "react";
import { Anchor } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { SessionListItem } from "../../shared/types.ts";
import { AnchorListModal } from "./AnchorListModal.tsx";

// Header-corner trigger for the anchor (favorites) list modal. Pulls the
// session list on demand — when the user clicks the button — rather than
// holding a perpetual subscription, since the modal is opened
// infrequently and we want the dropdown to reflect the latest sessions
// each time it appears.
export function AnchorButton() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [sessions, setSessions] = useState<ReadonlyArray<SessionListItem>>([]);

  // The mobile Sidebar's quick-action row dispatches this event so the
  // existing modal state stays here rather than getting lifted up.
  useEffect(() => {
    const fn = () => setOpen(true);
    window.addEventListener("pd-open-anchors", fn);
    return () => window.removeEventListener("pd-open-anchors", fn);
  }, []);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    fetch("/api/sessions")
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (cancelled || !j) return;
        const merged: SessionListItem[] = [
          ...(j.sessions ?? []),
          ...(j.inactive_sessions ?? []),
        ];
        setSessions(merged);
      })
      .catch(() => {
        /* sessions list is non-critical — modal still works with the
           stored favorites; the dropdown just shows fewer options. */
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  return (
    <>
      <button
        type="button"
        className="anchor-fab"
        title={t("anchor.list_button_title")}
        aria-label={t("anchor.list_button_title")}
        onClick={() => setOpen(true)}
      >
        <Anchor size={18} strokeWidth={1.75} />
      </button>
      {open && (
        <AnchorListModal sessions={sessions} onClose={() => setOpen(false)} />
      )}
    </>
  );
}
