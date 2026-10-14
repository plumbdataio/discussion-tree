import { describe, test, expect } from "bun:test";
import { breakLazyContinuation } from "../../web/utils/markdownText.ts";

// An unindented line right after a bullet / quote must start its own paragraph
// (CommonMark would glue it onto the last item as a lazy continuation line).

describe("breakLazyContinuation", () => {
  test("a flush line after a bullet list is split off", () => {
    const src = ["- a", "- b", "If this is fine I'll go ahead."].join("\n");
    expect(breakLazyContinuation(src)).toBe(["- a", "- b", "", "If this is fine I'll go ahead."].join("\n"));
  });

  test("ordered lists and * / + bullets too", () => {
    expect(breakLazyContinuation("1. a\n2) b\nnext")).toBe("1. a\n2) b\n\nnext");
    expect(breakLazyContinuation("* a\nnext")).toBe("* a\n\nnext");
    expect(breakLazyContinuation("+ a\nnext")).toBe("+ a\n\nnext");
  });

  test("an indented line stays inside the item, the flush line after it does not", () => {
    const src = ["- a", "  still a", "    deeper", "out"].join("\n");
    expect(breakLazyContinuation(src)).toBe(["- a", "  still a", "    deeper", "", "out"].join("\n"));
  });

  test("nested items stay in the list", () => {
    const src = ["- a", "  - a1", "- b"].join("\n");
    expect(breakLazyContinuation(src)).toBe(src);
  });

  test("an existing blank line is left as is (no double blank)", () => {
    const src = "- a\n\nnext";
    expect(breakLazyContinuation(src)).toBe(src);
  });

  test("a second paragraph inside an item (blank + indented) stays in the item", () => {
    const src = "- a\n\n  more of a\nout";
    expect(breakLazyContinuation(src)).toBe("- a\n\n  more of a\n\nout");
  });

  test("a blockquote ends at the first line without >", () => {
    expect(breakLazyContinuation("> quoted\n> more\nmy reply")).toBe("> quoted\n> more\n\nmy reply");
  });

  test("a list right after a quote is split from it", () => {
    expect(breakLazyContinuation("> q\n- a")).toBe("> q\n\n- a");
  });

  test("plain paragraphs and headings are untouched", () => {
    const src = "## Title\nline one\nline two";
    expect(breakLazyContinuation(src)).toBe(src);
  });

  test("fenced code is verbatim, even list-looking lines inside", () => {
    const src = ["```", "- x", "y", "```", "after"].join("\n");
    expect(breakLazyContinuation(src)).toBe(src);
  });

  test("a flush fence right after a list starts a new block", () => {
    const src = ["- a", "```", "code", "```"].join("\n");
    expect(breakLazyContinuation(src)).toBe(["- a", "", "```", "code", "```"].join("\n"));
  });

  test("an indented fence inside an item stays in the item", () => {
    const src = ["- a", "  ```", "  code", "  ```", "- b"].join("\n");
    expect(breakLazyContinuation(src)).toBe(src);
  });

  test("a hyphenated word or a thematic-break-like line is not a list item", () => {
    expect(breakLazyContinuation("-foo\nbar")).toBe("-foo\nbar");
    expect(breakLazyContinuation("2026. text\nbar")).toBe("2026. text\n\nbar");
  });

  test("a pipe-less line right after a table ends the table", () => {
    const src = ["| a | b |", "|---|---|", "| 1 | 2 |", "after the table"].join("\n");
    expect(breakLazyContinuation(src)).toBe(
      ["| a | b |", "|---|---|", "| 1 | 2 |", "", "after the table"].join("\n"),
    );
  });

  test("a table inside a list item: the indented line after it stays in the item as a new paragraph", () => {
    const src = ["- item", "  | a | b |", "  |---|---|", "  | 1 | 2 |", "  closing line"].join("\n");
    expect(breakLazyContinuation(src)).toBe(
      ["- item", "  | a | b |", "  |---|---|", "  | 1 | 2 |", "", "  closing line"].join("\n"),
    );
  });

  test("table rows without outer pipes keep the table going", () => {
    const src = ["a | b", "--- | ---", "1 | 2", "3 | 4"].join("\n");
    expect(breakLazyContinuation(src)).toBe(src);
  });

  test("a pipe in prose without a delimiter row is not a table", () => {
    const src = "x | y\nnext";
    expect(breakLazyContinuation(src)).toBe(src);
  });

  test("single-line text is returned unchanged", () => {
    expect(breakLazyContinuation("- a")).toBe("- a");
  });
});
