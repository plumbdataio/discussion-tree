// Pre-parse text fixups for dt messages. Kept as pure functions so the tricky
// cases can be pinned by unit tests without rendering React.

// Neutralise a LONE `*` so it can't open an emphasis span.
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
export function escapeLoneAsterisks(src: string): string {
  if (!src.includes("*")) return src;

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
    out.push(escapeLineAsterisks(line));
  }
  return out.join("\n");
}

function escapeLineAsterisks(line: string): string {
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
