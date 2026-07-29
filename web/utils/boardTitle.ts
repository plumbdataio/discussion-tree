// Boards whose title is OWNED BY dt rather than written by anyone.
//
// Their titles are seeded in English in the DB (nothing can re-translate a
// stored string later), so every place that shows a board name has to swap in
// the localized one. That swap was already copy-pasted across four call sites
// for the default board; a second such board would have made it eight, and the
// one that got missed would show "Issue conversations" in a Japanese UI.
//
// Returns the i18n key to use, or null when the board's own title is the truth.
export function boardTitleKey(b: {
  is_default?: number;
  is_issue_chat?: number;
}): string | null {
  if (b.is_default) return "default_board.title";
  if (b.is_issue_chat) return "issues.chat_board_title";
  return null;
}

// Convenience for the common `key ? t(key) : b.title` shape.
export function boardTitle(
  b: { title: string; is_default?: number; is_issue_chat?: number },
  t: (key: string) => string,
): string {
  const key = boardTitleKey(b);
  return key ? t(key) : b.title;
}
