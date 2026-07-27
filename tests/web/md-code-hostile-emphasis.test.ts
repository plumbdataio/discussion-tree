// allow-japanese-file: the reported regression is a glob path embedded in CJK
// prose, and CJK adjacency is exactly what emphasis flanking rules key on — an
// ASCII-only restatement would not reproduce it. Mirrors md-render.test.tsx.
import "./happydom.ts";
import { describe, test, expect } from "bun:test";
import { escapeCodeHostileEmphasis } from "../../web/utils/markdownText.ts";

// A lone `*` used to open a CommonMark emphasis span. In dt that is actively
// wrong rather than merely ugly: messages are full of globs and config paths, so
// two of them pair up and the asterisks are CONSUMED as delimiters — the reader
// is shown a path that does not exist. These pin the escape that prevents it,
// plus everything that must keep working.

describe("escapeCodeHostileEmphasis — the bug it exists for", () => {
  test("two config-dir globs no longer pair into emphasis", () => {
    const out = escapeCodeHostileEmphasis(
      "~/.claude-*/CLAUDE.md なのか ./.claude/CLAUDE.md なのか、~/.claude-*/CLAUDE.md に記載",
    );
    // Both asterisks survive as literals, so neither path is silently rewritten.
    expect(out).toBe(
      "~/.claude-\\*/CLAUDE.md なのか ./.claude/CLAUDE.md なのか、~/.claude-\\*/CLAUDE.md に記載",
    );
  });

  test("a glob with a doubled star keeps the `**` and escapes only the lone one", () => {
    // `web/**/*.tsx`: the `**` is a run of two (left alone), the `*` is lone.
    expect(escapeCodeHostileEmphasis("web/**/*.tsx")).toBe("web/**/\\*.tsx");
  });

  test("a single trailing glob is escaped too", () => {
    expect(escapeCodeHostileEmphasis("~/.claude*/rules")).toBe("~/.claude\\*/rules");
  });
});

describe("escapeCodeHostileEmphasis — what must keep working", () => {
  test("**bold** is untouched", () => {
    expect(escapeCodeHostileEmphasis("これは **太字** です")).toBe(
      "これは **太字** です",
    );
  });

  test("***bold italic*** and a *** thematic break are untouched", () => {
    expect(escapeCodeHostileEmphasis("***both***")).toBe("***both***");
    expect(escapeCodeHostileEmphasis("***")).toBe("***");
  });

  test("a list bullet is not escaped, but emphasis later on the line is", () => {
    expect(escapeCodeHostileEmphasis("* item")).toBe("* item");
    expect(escapeCodeHostileEmphasis("  * nested item")).toBe("  * nested item");
    expect(escapeCodeHostileEmphasis("* item with a * in it")).toBe(
      "* item with a \\* in it",
    );
  });

  test("`*` inside an inline code span is left alone", () => {
    expect(escapeCodeHostileEmphasis("run `ls ~/.claude-*/` first")).toBe(
      "run `ls ~/.claude-*/` first",
    );
  });

  test("`*` inside a fenced block is left alone (and the fence may hold ~~~)", () => {
    const src = "before *x*\n```bash\nls ~/.claude-*/\n~~~\n```\nafter *y*";
    expect(escapeCodeHostileEmphasis(src)).toBe(
      "before \\*x\\*\n```bash\nls ~/.claude-*/\n~~~\n```\nafter \\*y\\*",
    );
  });

  test("an already-escaped asterisk is not double-escaped", () => {
    expect(escapeCodeHostileEmphasis("literal \\* star")).toBe("literal \\* star");
  });

  test("text with no asterisk is returned unchanged", () => {
    const s = "何も変わらない";
    expect(escapeCodeHostileEmphasis(s)).toBe(s);
  });

  test("an unclosed backtick does not swallow the rest of the line", () => {
    // The backtick is literal here; the asterisks after it still need escaping.
    expect(escapeCodeHostileEmphasis("a ` b *c*")).toBe("a ` b \\*c\\*");
  });
});

describe("escapeCodeHostileEmphasis — double underscore (dunders)", () => {
  test("a Jest-style path keeps its underscores", () => {
    // Rendered as src/<strong>tests</strong>/foo.ts before this fix.
    expect(escapeCodeHostileEmphasis("src/__tests__/foo.ts")).toBe(
      "src/\\_\\_tests\\_\\_/foo.ts",
    );
  });

  test("dunder filenames keep their underscores", () => {
    expect(escapeCodeHostileEmphasis("__init__.py")).toBe(
      "\\_\\_init\\_\\_.py",
    );
  });

  test("a single underscore is left alone — it is the last italic spelling", () => {
    expect(escapeCodeHostileEmphasis("_italic_")).toBe("_italic_");
    expect(escapeCodeHostileEmphasis("snake_case_name")).toBe("snake_case_name");
  });

  test("underscores inside a bare URL are untouched (escaping breaks autolinks)", () => {
    const u = "https://example.com/__tests__/x";
    expect(escapeCodeHostileEmphasis(u)).toBe(u);
    expect(escapeCodeHostileEmphasis(`see ${u} ok`)).toBe(`see ${u} ok`);
  });

  test("a link/image destination is copied out whole", () => {
    const s = "![img](/uploads/bd_x/__a__/img_b.png)";
    expect(escapeCodeHostileEmphasis(s)).toBe(s);
  });

  test("a glob inside a URL is untouched too", () => {
    const u = "https://example.com/a*b";
    expect(escapeCodeHostileEmphasis(u)).toBe(u);
  });

  test("underscores in code stay literal", () => {
    expect(escapeCodeHostileEmphasis("`__init__.py`")).toBe("`__init__.py`");
  });
});
