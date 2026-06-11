// allow-japanese-file: CJK-rendering tests need CJK input/expected strings
import { describe, test, expect } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { MDView } from "../../web/components/MDView.tsx";

// MDView renders message markdown via react-markdown. Two dt-specific behaviours
// are pinned here:
//  1. CJK **bold** rescue (remarkCjkStrong): CommonMark's flanking rules drop a
//     bold span whose content is edged by Japanese punctuation, leaving literal
//     asterisks. We re-parse those into <strong> without touching the cases that
//     already work or `**` inside code.
//  2. GFM tables get wrapped in .md-table-wrap so they scroll inside dt's narrow
//     columns.
const html = (text: string) =>
  renderToStaticMarkup(createElement(MDView, { text }));

describe("MDView CJK strong rescue", () => {
  test("bold edged by Japanese brackets is rescued", () => {
    const out = html("これは**「重要」**です");
    expect(out).toContain("<strong>「重要」</strong>");
    expect(out).not.toContain("**");
  });

  test("bold edged by fullwidth parens is rescued", () => {
    const out = html("対象は**（注意）**こちら");
    expect(out).toContain("<strong>（注意）</strong>");
    expect(out).not.toContain("**");
  });

  test("already-working bold is unchanged (no double-wrap)", () => {
    const out = html("これは**重要**です");
    expect(out).toContain("<strong>重要</strong>");
    expect((out.match(/<strong>/g) || []).length).toBe(1);
  });

  test("** inside inline code is NOT rewritten", () => {
    const out = html("`a ** b ** c` はコード");
    expect(out).toContain("<code>a ** b ** c</code>");
    expect(out).not.toContain("<strong>");
  });

  test("plain text with no bold is untouched", () => {
    const out = html("ただの文章です");
    expect(out).not.toContain("<strong>");
    expect(out).toContain("ただの文章です");
  });

  test("escaped asterisks stay literal (rescue must not un-escape)", () => {
    // `\*\*literal\*\*` parses to a text node `**literal**`; an ASCII boundary
    // means it was deliberately escaped, so the rescue must leave it alone.
    const out = html("これは \\*\\*literal\\*\\* です");
    expect(out).toContain("**literal**");
    expect(out).not.toContain("<strong>");
  });

  test("escaped bold with CJK-letter (non-punct) edges stays literal", () => {
    // Boundary chars are kanji (letters, not punctuation), so this is the
    // escaped case, not a flanking failure — leave it literal.
    const out = html("\\*\\*重要\\*\\*");
    expect(out).toContain("**重要**");
    expect(out).not.toContain("<strong>");
  });

  test("escaped bold with CJK-PUNCTUATION edges stays literal", () => {
    // The hard case: escaped content that is ALSO bracket-edged. It parses to
    // the same text as a flanking failure, so the rescue must consult the
    // source position (which still shows the backslashes) to leave it literal.
    const out = html("\\*\\*「重要」\\*\\*");
    expect(out).toContain("**「重要」**");
    expect(out).not.toContain("<strong>");
  });
});

describe("MDView GFM tables", () => {
  test("a table is parsed and wrapped for horizontal scroll", () => {
    const out = html("| A | B |\n|---|---|\n| 1 | 2 |");
    expect(out).toContain('<div class="md-table-wrap">');
    expect(out).toContain("<table>");
    expect(out).toContain("<th>A</th>");
    expect(out).toContain("<td>1</td>");
  });

  test("table directly after a heading (no blank line) still parses", () => {
    const out = html("## 見出し\n| A | B |\n|---|---|\n| 1 | 2 |");
    expect(out).toContain("<table>");
    expect(out).toContain("<th>A</th>");
  });
});
