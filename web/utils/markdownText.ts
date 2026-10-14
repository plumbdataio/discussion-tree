// Pre-parse text fixups for dt messages. Kept as pure functions so the tricky
// cases can be pinned by unit tests without rendering React.

// Neutralise the emphasis spellings that collide with code tokens.
//
// The rule dt settles on: **bold** and _italic_ each keep exactly ONE spelling,
// and the discarded spellings are precisely the ones that appear inside real
// identifiers and paths.
//
//   `**bold**`   kept     — never occurs in identifiers
//   `*italic*`   disabled — collides with globs (a home-config glob, build globs)
//   `_italic_`   kept     — CommonMark already refuses INTRAWORD `_`, so
//                           snake_case and leading-underscore names are safe
//   `__bold__`   disabled — collides with dunders: `__init__.py`, `__tests__`,
//                           `__proto__` all render with the underscores eaten
//
// Measured before choosing (2026-07-27): `snake_case_name`, `_foo ... _bar`,
// and URLs with single underscores already render literally, so disabling
// single `_` would cost the last italic spelling and buy nothing. Runs of two
// underscores do break, and `src/__tests__/foo.ts` is an everyday path.
//
// Left verbatim: inline code, fenced blocks, author escapes, link/image
// destinations, and bare URLs — escaping inside an autolink would corrupt the
// link itself, which is the very failure mode this function exists to prevent.
//
// Why: CommonMark reads `*x*` as italic, and dt messages are full of shell globs
// and config paths. Two of them in one message pair up, italicise everything
// between, and — worse — CONSUME the asterisks: a home-config glob path renders
// with its star deleted, i.e. as a DIFFERENT, non-existent path. That is a
// silently wrong path, not a cosmetic slip.
//
// This is the same call already made for `~`: dt passes `singleTilde: false` so
// a bare `~/foo` can't strike through. Emphasis has no such option (it's a core
// CommonMark construct, not a GFM extension), so we escape at the source
// instead. `**bold**` is untouched and `_italic_` still works — the standard
// alternative spelling — so no formatting capability is actually lost.
//
// Deliberately left alone: runs of 2+ asterisks (`**bold**`, `***both***`, a
// `***` thematic break), list bullets (`* item`), anything inside inline code or
// a fenced block, and asterisks the author already escaped.
//
// NOTE for future edits: do NOT put a glob path inside a /* block comment */ in
// this file — the `*` followed by `/` closes the comment early (that mistake
// broke the build once already). Line comments like these are safe.
export function escapeCodeHostileEmphasis(src: string): string {
  if (!src.includes("*") && !src.includes("__")) return src;

  const lines = src.split("\n");
  let fence: string | null = null; // the ``` / ~~~ run that opened a block
  const out: string[] = [];

  for (const line of lines) {
    // Fenced code: copy verbatim until the matching closing fence. Matching the
    // opener's char and length is what lets a ``` block contain ~~~ and vice
    // versa without ending early.
    const fenceMatch = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (fenceMatch && fenceMatch[1][0] === fence[0] && fenceMatch[1].length >= fence.length) {
        fence = null;
      }
      out.push(line);
      continue;
    }
    if (fenceMatch) {
      fence = fenceMatch[1];
      out.push(line);
      continue;
    }
    out.push(escapeLineEmphasis(line));
  }
  return out.join("\n");
}

function escapeLineEmphasis(line: string): string {
  // A leading `* ` is a list bullet, not emphasis — remember where it sits so
  // the scan below can skip exactly that one asterisk.
  const bullet = /^(\s*)\*(\s)/.exec(line);
  const bulletIdx = bullet ? bullet[1].length : -1;

  let res = "";
  let i = 0;
  while (i < line.length) {
    const ch = line[i];

    if (ch === "\\") {
      // Author-escaped character: pass the pair through untouched.
      res += line.slice(i, i + 2);
      i += 2;
      continue;
    }

    if (ch === "`") {
      // Inline code span: a run of N backticks closes on the next run of
      // exactly N. If it never closes, the backticks are literal — fall through
      // and keep scanning so asterisks after them are still handled.
      let n = 0;
      while (line[i + n] === "`") n++;
      const close = findClosingBackticks(line, i + n, n);
      if (close !== -1) {
        res += line.slice(i, close + n);
        i = close + n;
        continue;
      }
      res += line.slice(i, i + n);
      i += n;
      continue;
    }

    // A link / image destination: `](` … `)`. Backslashes inside are legal but
    // pointless noise, and an escape here is one edit away from corrupting the
    // href, so copy it out whole.
    if (ch === "]" && line[i + 1] === "(") {
      const close = line.indexOf(")", i + 2);
      if (close !== -1) {
        res += line.slice(i, close + 1);
        i = close + 1;
        continue;
      }
    }

    // A bare URL becomes a GFM autolink. A backslash inside it would break the
    // match and leave the backslash visible in the link text, so URLs are
    // untouchable — verified that `https://…/__tests__/x` renders correctly today.
    if (ch === "h" || ch === "w") {
      const rest = line.slice(i);
      if (/^(https?:\/\/|www\.)/.test(rest)) {
        const end = rest.search(/\s/);
        const stop = end === -1 ? line.length : i + end;
        res += line.slice(i, stop);
        i = stop;
        continue;
      }
    }

    if (ch === "_") {
      let n = 0;
      while (line[i + n] === "_") n++;
      // A run of 2+ is the `__bold__` spelling, which is also how every dunder
      // and Jest-style directory is written. Escape every underscore in the run
      // so the token survives; a single `_` is left alone (CommonMark already
      // refuses it intraword, and it is dt's one remaining italic spelling).
      res += n >= 2 ? "\\_".repeat(n) : line.slice(i, i + n);
      i += n;
      continue;
    }

    if (ch === "*") {
      let n = 0;
      while (line[i + n] === "*") n++;
      // Runs of 2+ are bold / bold-italic / a thematic break — leave them be.
      // A single one is the italic delimiter we're neutralising, unless it's
      // the list bullet.
      if (n === 1 && i !== bulletIdx) {
        res += "\\*";
      } else {
        res += line.slice(i, i + n);
      }
      i += n;
      continue;
    }

    res += ch;
    i++;
  }
  return res;
}

// End a list / blockquote at the first line that is not visibly part of it.
//
// CommonMark's "lazy continuation" rule glues an UNINDENTED line onto the
// paragraph of the list item (or blockquote) right above it when no blank line
// separates them. With remark-breaks that line then renders as a second line
// INSIDE the last bullet. Authors (mostly CC) write
//
//   - point A
//   - point B
//   If this is fine I'll go ahead.
//
// meaning the last line as a standalone closing sentence, and readers saw it
// tucked under bullet B. dt's rule: a line belongs to a list item only if it is
// indented (or is itself an item); a line belongs to a blockquote only if it
// starts with `>`. Anything else gets a blank line inserted before it, so it
// starts its own paragraph. Fenced code is copied verbatim.
const LIST_ITEM_RE = /^\s*(?:[-*+]|\d{1,9}[.)])(?:\s|$)/;
const QUOTE_RE = /^\s{0,3}>/;
// GFM table delimiter row (| --- | :-: |). A table runs from here while lines
// keep containing a pipe; GFM would otherwise turn the next pipe-less line into
// one more table row, so dt ends the table there too.
const TABLE_DELIM_RE = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;

export function breakLazyContinuation(src: string): string {
  if (!src.includes("\n")) return src;
  const lines = src.split("\n");
  const out: string[] = [];
  let fence: string | null = null;
  let inList = false; // previous line is a list item or its indented continuation
  let inQuote = false; // previous line is a blockquote line
  let inTable = false; // previous line is a table delimiter row or table row

  for (const line of lines) {
    const fenceMatch = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (fenceMatch && fenceMatch[1][0] === fence[0] && fenceMatch[1].length >= fence.length) {
        fence = null;
      }
      out.push(line);
      continue;
    }

    const blank = line.trim() === "";
    const indented = /^\s/.test(line);
    const isItem = LIST_ITEM_RE.test(line);
    const isQuote = QUOTE_RE.test(line);

    if (!blank) {
      const lazyAfterList = inList && !indented && !isItem && !isQuote;
      const lazyAfterQuote = inQuote && !isQuote;
      const lazyAfterTable = inTable && !line.includes("|");
      const prevBlank = out.length > 0 && out[out.length - 1].trim() === "";
      if ((lazyAfterList || lazyAfterQuote || lazyAfterTable) && !prevBlank) out.push("");
    }

    if (fenceMatch) {
      // An opening fence inside a list item (indented) stays in the item; a
      // flush one ended it above. Either way the block is verbatim from here.
      fence = fenceMatch[1];
      inList = inList && indented;
      inQuote = false;
      out.push(line);
      continue;
    }

    if (blank) inTable = false;
    else if (TABLE_DELIM_RE.test(line) && line.includes("|")) inTable = true;
    else inTable = inTable && line.includes("|");

    if (blank) {
      // A blank line keeps an indented continuation possible (a second
      // paragraph inside an item), so only a flush line ends the list.
      inQuote = false;
    } else if (isQuote) {
      inQuote = true;
      inList = false;
    } else {
      inQuote = false;
      inList = isItem || (inList && indented);
    }
    out.push(line);
  }
  return out.join("\n");
}

function findClosingBackticks(line: string, from: number, n: number): number {
  for (let i = from; i < line.length; i++) {
    if (line[i] !== "`") continue;
    let run = 0;
    while (line[i + run] === "`") run++;
    if (run === n) return i;
    i += run - 1;
  }
  return -1;
}
