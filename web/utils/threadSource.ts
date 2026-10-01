// Who-said-it helpers for thread items, shared by every view that renders a
// message or counts unread ones.
//
// Sources: "user" (the human), "cc" (the agent), "system" (status-change
// noise), and "external" — an automated relay that posted via /notify-session.
// An external notice is NOT the user and NOT Claude, so it must never fall
// through to either label; and since the user only watches the dt UI, it raises
// the unread indicator exactly like a CC post does.

import type { TFunction } from "i18next";

// Sources whose unread items light the unread dot / are auto-marked read.
export function countsAsUnreadSource(source: string | undefined | null): boolean {
  return source === "cc" || source === "external";
}

// True for an item the user hasn't seen yet (CC reply or external notice).
export function isUnreadThreadItem(item: {
  source?: string | null;
  read_at?: string | null;
}): boolean {
  return countsAsUnreadSource(item.source) && !item.read_at;
}

// Display label for a message's sender: "You" / "External (relay-name)" /
// "Claude" (any other source, matching the views' long-standing fallback).
export function senderLabel(
  t: TFunction,
  source: string | undefined | null,
  label?: string | null,
): string {
  if (source === "user") return t("item_card.you");
  if (source === "external") {
    return label
      ? t("item_card.external_with_label", { label })
      : t("item_card.external");
  }
  return t("item_card.claude");
}
