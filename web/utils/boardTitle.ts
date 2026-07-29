// Boards whose title is OWNED BY dt rather than written by anyone.
//
// The default board's title is seeded in English in the DB (nothing can
// re-translate a stored string later), so every place that shows a board name
// has to swap in the localized one. (Issue-conversation boards used to be a
// second such case; the 2026-07-29 redesign made them ordinary boards that carry
// the issue's own title, so only the default board is left here.)
//
// Returns the i18n key to use, or null when the board's own title is the truth.
export function boardTitleKey(b: {
  is_default?: number;
}): string | null {
  if (b.is_default) return "default_board.title";
  return null;
}

// Convenience for the common `key ? t(key) : b.title` shape.
export function boardTitle(
  b: { title: string; is_default?: number },
  t: (key: string) => string,
): string {
  const key = boardTitleKey(b);
  return key ? t(key) : b.title;
}
