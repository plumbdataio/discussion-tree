// Compact timestamp shown next to thread message authors. Format follows the
// active i18next language (so toggling Settings → Language re-formats every
// timestamp on next render). The full ISO timestamp is exposed via the
// `title` attribute on the surrounding element so hovering reveals the
// unabbreviated value regardless of the chosen locale.

import i18n from "../i18n.ts";

function localeFor(lang: string): string {
  if (lang.startsWith("ja")) return "ja-JP";
  return "en-US";
}

export function formatThreadTimestamp(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const lang = i18n.language || "en";
  const locale = localeFor(lang);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  // ja always shows the year (date convention there leads with year). en
  // omits it when the message landed in the current calendar year to keep
  // the chip narrow, surfacing it only when the message crosses years.
  const showYear = lang.startsWith("ja") ? true : !sameYear;
  return new Intl.DateTimeFormat(locale, {
    year: showYear ? "numeric" : undefined,
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(d);
}
