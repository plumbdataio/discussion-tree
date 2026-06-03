import React, { useEffect, useState } from "react";
import { Settings } from "lucide-react";
import { useTranslation } from "react-i18next";
import { SettingsModal } from "./SettingsModal.tsx";

export function GearButton() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  // The mobile Sidebar's quick-action row dispatches "pd-open-settings".
  // Match the AnchorButton's listener so the same modal opens whether
  // the user clicked the corner fab (desktop) or the sidebar entry
  // (mobile).
  useEffect(() => {
    const fn = () => setOpen(true);
    window.addEventListener("pd-open-settings", fn);
    return () => window.removeEventListener("pd-open-settings", fn);
  }, []);
  return (
    <>
      <button
        type="button"
        className="gear-fab"
        title={t("settings.title")}
        aria-label={t("settings.title")}
        onClick={() => setOpen(true)}
      >
        <Settings size={18} strokeWidth={1.75} />
      </button>
      {open && <SettingsModal onClose={() => setOpen(false)} />}
    </>
  );
}
