#!/usr/bin/env bun
// Pre-commit guard: block Japanese / CJK characters in committed source.
//
// dt is English-in-source: every user-facing string lives in
// web/locales/{ja,en}.json (i18n) and is reached via t(). Japanese leaking
// into .ts/.tsx/.css/etc — comments, examples, inline UI strings — is a
// recurring slip (memory rules alone don't catch it). This scans the STAGED
// content of source files and fails the commit if it finds CJK text.
//
// Escape hatches (kept explicit so exceptions stay auditable — grep the
// pragmas):
//   - web/locales/** is always exempt (the i18n catalogs).
//   - a line containing `allow-japanese` is exempt (inline, for one regex /
//     one example line).
//   - a file with `allow-japanese-file` in its first 8 lines is exempt whole
//     (for CJK-rendering tests, detection-pattern modules, etc).
//
// This file is itself ASCII-only: the CJK character class is built from code
// points, not literal glyphs, so the guard never trips on its own source.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

export const FILE_PRAGMA = "allow-japanese-file";
export const LINE_PRAGMA = "allow-japanese";

const cp = (n: number) => String.fromCharCode(n);
// hiragana+katakana, CJK ext A, CJK unified, compat ideographs, CJK symbols &
// punctuation, halfwidth/fullwidth forms.
const CJK = new RegExp(
  "[" +
    cp(0x3040) + "-" + cp(0x30ff) +
    cp(0x3400) + "-" + cp(0x4dbf) +
    cp(0x4e00) + "-" + cp(0x9fff) +
    cp(0xf900) + "-" + cp(0xfaff) +
    cp(0x3000) + "-" + cp(0x303f) +
    cp(0xff00) + "-" + cp(0xffef) +
    "]",
);

const SCAN_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|css|html|json)$/;

// Pure (no git / fs) so it can be unit-tested. Returns one "file:line: text"
// string per offending line, or [] if the file is exempt or clean.
export function findCjkViolations(file: string, content: string): string[] {
  if (!SCAN_EXT.test(file)) return [];
  if (file.startsWith("web/locales/")) return [];
  const lines = content.split("\n");
  if (lines.slice(0, 8).some((l) => l.includes(FILE_PRAGMA))) return [];
  const out: string[] = [];
  lines.forEach((line, i) => {
    if (!CJK.test(line)) return;
    if (line.includes(LINE_PRAGMA)) return;
    out.push(`${file}:${i + 1}: ${line.trim().slice(0, 100)}`);
  });
  return out;
}

// Commit-message variant: the message must be English too (repo surface rule).
// Skips git's stripped comment lines (the localized template) and honors an
// inline `allow-japanese` for the rare line that genuinely needs CJK.
// commentChar mirrors git's core.commentChar (default "#"); "auto"/empty -> "#".
export function checkMessageCjk(content: string, commentChar = "#"): string[] {
  const cc = commentChar && commentChar !== "auto" ? commentChar[0] : "#";
  const out: string[] = [];
  content.split("\n").forEach((line, i) => {
    if (line.startsWith(cc)) return; // git comment line — removed from the commit
    if (line.includes(LINE_PRAGMA)) return;
    if (CJK.test(line)) out.push(`commit message line ${i + 1}: ${line.trim().slice(0, 100)}`);
  });
  return out;
}

function git(args: string[]): string {
  const r = spawnSync("git", args, {
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024,
  });
  return r.status === 0 ? (r.stdout ?? "") : "";
}

function main(): void {
  const argv = process.argv.slice(2);
  // Commit-message mode (the commit-msg hook): scan the message file at argv[1].
  if (argv[0] === "--commit-msg") {
    const path = argv[1];
    const commentChar = git(["config", "core.commentChar"]).trim() || "#";
    const v = path
      ? checkMessageCjk(readFileSync(path, "utf8"), commentChar)
      : [];
    if (v.length > 0) {
      console.error(
        "\nERROR: Japanese / CJK text in the commit message " +
          "(commit messages must be English):\n",
      );
      console.error(v.map((l) => "  " + l).join("\n"));
      console.error(
        `\nReword in English. (If a line genuinely needs CJK, add ` +
          `"${LINE_PRAGMA}" to it.)\n`,
      );
      process.exit(1);
    }
    return;
  }

  // ACMR: added / copied / modified / RENAMED destinations. Renames must be
  // included or moving (e.g.) web/locales/ja.json onto a .ts path would smuggle
  // its Japanese past the guard.
  const files = git(["diff", "--cached", "--name-only", "--diff-filter=ACMR"])
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);

  const violations: string[] = [];
  for (const file of files) {
    const content = git(["show", `:${file}`]); // the staged blob, not the worktree
    if (!content) continue;
    for (const v of findCjkViolations(file, content)) violations.push("  " + v);
  }

  if (violations.length > 0) {
    console.error(
      "\nERROR: Japanese / CJK text found in source " +
        "(UI strings must live in web/locales/{ja,en}.json):\n",
    );
    console.error(violations.join("\n"));
    console.error(
      `\n${violations.length} line(s) blocked. If a line genuinely needs CJK ` +
        `(a detection regex, a CJK-rendering test, documenting which glyph breaks ` +
        `something), add an inline "${LINE_PRAGMA}: <reason>" comment on that line, ` +
        `or put "${FILE_PRAGMA}: <reason>" in the first 8 lines of the file. ` +
        `Otherwise move the string into web/locales/{ja,en}.json and use t().\n`,
    );
    process.exit(1);
  }
}

if (import.meta.main) main();
