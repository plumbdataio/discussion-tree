import React, { useState } from "react";
import { Settings } from "lucide-react";
import { useTranslation } from "react-i18next";
import { SettingsModal } from "./SettingsModal.tsx";

export function GearButton() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
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
