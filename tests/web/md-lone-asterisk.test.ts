// allow-japanese-file: the reported regression is a glob path embedded in CJK
// prose, and CJK adjacency is exactly what emphasis flanking rules key on — an
// ASCII-only restatement would not reproduce it. Mirrors md-render.test.tsx.
import "./happydom.ts";
import { describe, test, expect } from "bun:test";
import { escapeLoneAsterisks } from "../../web/utils/markdownText.ts";

// A lone `*` used to open a CommonMark emphasis span. In dt that is actively
// wrong rather than merely ugly: messages are full of globs and config paths, so
// two of them pair up and the asterisks are CONSUMED as delimiters — the reader
// is shown a path that does not exist. These pin the escape that prevents it,
// plus everything that must keep working.

describe("escapeLoneAsterisks — the bug it exists for", () => {
  test("two config-dir globs no longer pair into emphasis", () => {
    const out = escapeLoneAsterisks(
      "~/.claude-*/CLAUDE.md なのか ./.claude/CLAUDE.md なのか、~/.claude-*/CLAUDE.md に記載",
    );
    // Both asterisks survive as literals, so neither path is silently rewritten.
    expect(out).toBe(
      "~/.claude-\\*/CLAUDE.md なのか ./.claude/CLAUDE.md なのか、~/.claude-\\*/CLAUDE.md に記載",
    );
  });

  test("a glob with a doubled star keeps the `**` and escapes only the lone one", () => {
    // `web/**/*.tsx`: the `**` is a run of two (left alone), the `*` is lone.
    expect(escapeLoneAsterisks("web/**/*.tsx")).toBe("web/**/\\*.tsx");
  });

  test("a single trailing glob is escaped too", () => {
    expect(escapeLoneAsterisks("~/.claude*/rules")).toBe("~/.claude\\*/rules");
  });
});

describe("escapeLoneAsterisks — what must keep working", () => {
  test("**bold** is untouched", () => {
    expect(escapeLoneAsterisks("これは **太字** です")).toBe(
      "これは **太字** です",
    );
  });

  test("***bold italic*** and a *** thematic break are untouched", () => {
    expect(escapeLoneAsterisks("***both***")).toBe("***both***");
    expect(escapeLoneAsterisks("***")).toBe("***");
  });

  test("a list bullet is not escaped, but emphasis later on the line is", () => {
    expect(escapeLoneAsterisks("* item")).toBe("* item");
    expect(escapeLoneAsterisks("  * nested item")).toBe("  * nested item");
    expect(escapeLoneAsterisks("* item with a * in it")).toBe(
      "* item with a \\* in it",
    );
  });

  test("`*` inside an inline code span is left alone", () => {
    expect(escapeLoneAsterisks("run `ls ~/.claude-*/` first")).toBe(
      "run `ls ~/.claude-*/` first",
    );
  });

  test("`*` inside a fenced block is left alone (and the fence may hold ~~~)", () => {
    const src = "before *x*\n```bash\nls ~/.claude-*/\n~~~\n```\nafter *y*";
    expect(escapeLoneAsterisks(src)).toBe(
      "before \\*x\\*\n```bash\nls ~/.claude-*/\n~~~\n```\nafter \\*y\\*",
    );
  });

  test("an already-escaped asterisk is not double-escaped", () => {
    expect(escapeLoneAsterisks("literal \\* star")).toBe("literal \\* star");
  });

  test("text with no asterisk is returned unchanged", () => {
    const s = "何も変わらない";
    expect(escapeLoneAsterisks(s)).toBe(s);
  });

  test("an unclosed backtick does not swallow the rest of the line", () => {
    // The backtick is literal here; the asterisks after it still need escaping.
    expect(escapeLoneAsterisks("a ` b *c*")).toBe("a ` b \\*c\\*");
  });
});
