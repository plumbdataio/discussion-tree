// allow-japanese-file: exercises the CJK detector with CJK sample input
import { describe, test, expect } from "bun:test";
import { findCjkViolations } from "../../scripts/check-no-japanese.ts";

// findCjkViolations is the pure core of the pre-commit guard: given a path +
// content it returns the offending lines (or [] when exempt / clean).

describe("findCjkViolations", () => {
  test("flags a Japanese string in a source file", () => {
    const v = findCjkViolations("web/foo.ts", 'const s = "テスト";');
    expect(v.length).toBe(1);
    expect(v[0]).toContain("web/foo.ts:1");
  });

  test("clean ASCII source is fine", () => {
    expect(findCjkViolations("web/foo.ts", "const s = 'ok';")).toEqual([]);
  });

  test("web/locales/* (i18n catalogs) are exempt", () => {
    expect(findCjkViolations("web/locales/ja.json", '{"k":"テスト"}')).toEqual(
      [],
    );
  });

  test("non-source extensions (e.g. .md) are ignored", () => {
    expect(findCjkViolations("docs/notes.md", "設計メモ")).toEqual([]);
  });

  test("a file-level pragma in the first 8 lines exempts the whole file", () => {
    const content = '// allow-japanese-file: reason\nconst s = "テスト";';
    expect(findCjkViolations("web/foo.ts", content)).toEqual([]);
  });

  test("a file-level pragma after line 8 does NOT exempt", () => {
    const content =
      Array(9).fill("// pad").join("\n") +
      '\n// allow-japanese-file\nconst s = "テスト";';
    expect(findCjkViolations("web/foo.ts", content).length).toBeGreaterThan(0);
  });

  test("an inline line pragma exempts only its own line", () => {
    const content = 'const a = "あ"; // allow-japanese: ok\nconst b = "い";';
    const v = findCjkViolations("web/foo.ts", content);
    expect(v.length).toBe(1);
    expect(v[0]).toContain(":2");
  });

  test("reports every offending line", () => {
    const content = 'const a = "ア";\nconst b = "イ";\nconst c = 1;';
    expect(findCjkViolations("web/foo.ts", content).length).toBe(2);
  });
});
