// allow-japanese-file: CJK-rendering tests need CJK input/expected strings
import { describe, test, expect } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { MDView } from "../../web/components/MDView.tsx";

// MDView renders message markdown via react-markdown. Two dt-specific behaviours
// are pinned here:
//  1. CJK **bold** (via remark-cjk-friendly): CommonMark's flanking rules drop a
//     bold span whose content is edged by Japanese punctuation, leaving literal
//     asterisks. The extension fixes this at parse time, while honoring escapes
//     and not touching `**` inside code.
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

  test("escaped and genuine bracket-bold in ONE text node are handled per-run", () => {
    // `\*\*「A」\*\*` is escaped (must stay literal); `**「B」**` jammed between
    // CJK letters is a real flanking failure (must be rescued) — and both land
    // in the same text node, so the escape check has to be per-candidate.
    const out = html("\\*\\*「A」\\*\\*と**「B」**を");
    expect(out).toContain("**「A」**"); // escaped one stays literal
    expect(out).toContain("<strong>「B」</strong>"); // genuine failure rescued
  });

  test("identical escaped + genuine content on one line resolve independently", () => {
    // Same content 「A」 both escaped and genuine — a parse-time extension can
    // tell them apart (a post-parse fixup could not).
    const out = html("\\*\\*「A」\\*\\*と**「A」**を");
    expect((out.match(/<strong>/g) || []).length).toBe(1);
    expect(out).toContain("**「A」**"); // the escaped occurrence stays literal
  });

  test("a bracket from a character reference at the edge stays literal (known edge)", () => {
    // When the boundary bracket comes from an entity (&#x300c; = 「), the char
    // at the PARSE-level boundary is '&', not 「 — so neither CommonMark nor the
    // CJK extension treats it as emphasis. The entity still decodes; the
    // asterisks just stay literal. Astronomically rare in real messages; pinned
    // so a behavior change is noticed.
    const out = html("x**&#x300c;A」**y");
    expect(out).toContain("x**「A」**y");
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

describe("MDView tilde / strikethrough", () => {
  test("two home-dir paths do NOT strike the text between them", () => {
    // GFM's default singleTilde would treat ~ … ~ as strikethrough, eating the
    // text between two "~/" paths. We disabled it, so they render literally.
    const out = html("見て ~/Codes/foo と ~/Codes/bar を比較");
    expect(out).not.toContain("<del>");
    expect(out).toContain("~/Codes/foo");
    expect(out).toContain("~/Codes/bar");
  });

  test("single-tilde path jammed against CJK punctuation does NOT strike", () => {
    // Regression: the cjk-friendly-gfm-strikethrough companion registers its OWN
    // strikethrough tokenizer that, left at its default, re-enabled single ~…~
    // striking even though remark-gfm had singleTilde:false. A "。~/path" (tilde
    // right after CJK punctuation) tripped the companion's CJK-boundary logic —
    // the space-separated case above missed it. Real report: writing
    // "~/.claude-pd です。~/.claude-pd に…" struck the text out. Fixed by passing
    // singleTilde:false to the companion too.
    const out = html("~/.claude-pd です。~/.claude-pd に○○を");
    expect(out).not.toContain("<del>");
    expect(out).toContain("~/.claude-pd");
  });

  test("standard double-tilde strikethrough still works", () => {
    const out = html("これは ~~取り消し~~ です");
    expect(out).toContain("<del>取り消し</del>");
  });

  test("double-tilde jammed against CJK still strikes (cjk-friendly-gfm)", () => {
    // GFM flanking drops ~~x~~ edged by CJK/fullwidth punctuation, like it does
    // for **bold**. The cjk-friendly-gfm-strikethrough companion rescues it.
    expect(html("標準だと~~○×△~~だったり")).toContain("<del>○×△</del>");
    expect(html("これは~~取り消し~~です")).toContain("<del>取り消し</del>");
  });
});
