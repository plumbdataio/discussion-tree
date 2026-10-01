import React from "react";
import { useTranslation } from "react-i18next";
import { senderLabel } from "../utils/threadSource.ts";

// @reusable-ui SenderName — USE WHEN: rendering who wrote a thread message
// ("You" / "Claude" / an external relay notice) inside a message row or modal
// INSTEAD OF an inline `source === "user" ? you : claude` ternary, which makes
// a source="external" relay notice masquerade as Claude. For a plain string
// (title attributes, toasts) use senderLabel() from utils/threadSource.ts.
//
// An external notice shows "External" plus the relay's name as a separate,
// smaller muted chip rather than one joined string, so the kind of sender and
// the specific relay read as two distinct facts.
export function SenderName({
  source,
  label,
}: {
  source: string | undefined | null;
  label?: string | null;
}) {
  const { t } = useTranslation();
  if (source === "external") {
    return (
      <>
        {t("item_card.external")}
        {label ? <span className="sender-relay">{label}</span> : null}
      </>
    );
  }
  return <>{senderLabel(t, source)}</>;
}
