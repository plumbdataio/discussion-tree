import React from "react";
import { useTranslation } from "react-i18next";

export function renderSystemMessage(text: string): React.ReactNode {
  const m = text.match(/^status_change:([^:]+):([^:]+)$/);
  if (m) {
    return <StatusChangeMessage from={m[1]} to={m[2]} />;
  }
  return text;
}

function StatusChangeMessage({ from, to }: { from: string; to: string }) {
  const { t } = useTranslation();
  return (
    <>
      {t("system_message.status_label")}{" "}
      <strong>{t([`node_status.${from}`, from])}</strong>
      {" → "}
      <strong>{t([`node_status.${to}`, to])}</strong>
    </>
  );
}
