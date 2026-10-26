// The MCP build tag in plugin.json (buildTag in scripts/mcp-node-build.mjs,
// kept in sync by scripts/update-mcp-build-tag.mjs). /reload-plugins restarts
// the MCP server only when its args change, so the tag must change with the
// MCP code, must NOT change between a CRLF (Windows) and an LF (Mac) checkout
// of the same code, and rewriting plugin.json must be idempotent.

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildTag, fingerprint, launcherFiles } from "../../scripts/mcp-node-build.mjs";
import {
  LAUNCHER_ARG,
  applyBuildTag,
  stagePluginJsonTag,
  updatePluginJson,
} from "../../scripts/update-mcp-build-tag.mjs";

const REPO = path.resolve(import.meta.dir, "../..");
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dt-mcp-tag-"));
afterAll(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

const PLUGIN_JSON = [
  "{",
  '  "name": "discussion-tree",',
  '  "mcpServers": {',
  '    "discussion-tree": {',
  '      "command": "node",',
  '      "args": ["${CLAUDE_PLUGIN_ROOT}/scripts/mcp-node.mjs"]',
  "    }",
  "  },",
  '  "skills": ["./skills/"]',
  "}",
  "",
];

// A minimal fake repo holding every input the tag hashes.
function makeRepo(name: string, eol: "\n" | "\r\n"): string {
  const dir = path.join(tmpRoot, name);
  const files: Record<string, string[]> = {
    "server.ts": ["#!/usr/bin/env bun", 'import "./server/a.ts";', ""],
    "server/a.ts": ["export const a = 1;", "export const s = `x", "y`;", ""],
    "server/sub/b.ts": ["export const b = 2;", ""],
    "shared/c.ts": ["export const c = 3;", ""],
    "package.json": ["{", '  "name": "x"', "}", ""],
    "bun.lock": ["{}", ""],
    "scripts/mcp-node.mjs": ["// launcher", ""],
    "scripts/mcp-node-build.mjs": ["// build", ""],
    ".claude-plugin/plugin.json": PLUGIN_JSON,
  };
  for (const [rel, lines] of Object.entries(files)) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, lines.join(eol));
  }
  return dir;
}

describe("buildTag", () => {
  test("is 12 lowercase hex characters", () => {
    expect(buildTag(makeRepo("shape", "\n"))).toMatch(/^[0-9a-f]{12}$/);
  });

  test("is the same for CRLF and LF checkouts of the same code", () => {
    const lf = makeRepo("lf", "\n");
    const crlf = makeRepo("crlf", "\r\n");
    expect(buildTag(crlf)).toBe(buildTag(lf));
    // The raw-bytes fingerprint (the bundle cache key) still tells them apart,
    // which shows the fixture really differs in line endings.
    expect(fingerprint(crlf, launcherFiles(crlf))).not.toBe(
      fingerprint(lf, launcherFiles(lf)),
    );
  });

  test("changes when a server/ file changes", () => {
    const dir = makeRepo("edit-server", "\n");
    const before = buildTag(dir);
    fs.appendFileSync(path.join(dir, "server/sub/b.ts"), "export const d = 4;\n");
    expect(buildTag(dir)).not.toBe(before);
  });

  test("changes when a launcher file changes", () => {
    const dir = makeRepo("edit-launcher", "\n");
    const before = buildTag(dir);
    fs.appendFileSync(path.join(dir, "scripts/mcp-node-build.mjs"), "// more\n");
    expect(buildTag(dir)).not.toBe(before);
  });

  test("does not depend on plugin.json itself", () => {
    const dir = makeRepo("plugin-independent", "\n");
    const before = buildTag(dir);
    updatePluginJson(dir);
    expect(buildTag(dir)).toBe(before);
  });
});

describe("plugin.json update", () => {
  test("sets the tag and only touches the args line", () => {
    const dir = makeRepo("update", "\n");
    const file = path.join(dir, ".claude-plugin/plugin.json");
    const before = fs.readFileSync(file, "utf8");
    const { tag, changed } = updatePluginJson(dir);
    expect(changed).toBe(true);
    const after = fs.readFileSync(file, "utf8");
    expect(JSON.parse(after).mcpServers["discussion-tree"].args).toEqual([
      LAUNCHER_ARG,
      "--build",
      tag,
    ]);
    const a = before.split("\n");
    const b = after.split("\n");
    expect(b.length).toBe(a.length);
    expect(a.filter((line, i) => line !== b[i])).toEqual([
      '      "args": ["${CLAUDE_PLUGIN_ROOT}/scripts/mcp-node.mjs"]',
    ]);
  });

  test("is idempotent: a second run changes nothing and does not write", () => {
    const dir = makeRepo("idempotent", "\n");
    const file = path.join(dir, ".claude-plugin/plugin.json");
    updatePluginJson(dir);
    const once = fs.readFileSync(file);
    const mtime = fs.statSync(file).mtimeMs;
    const second = updatePluginJson(dir);
    expect(second.changed).toBe(false);
    expect(fs.readFileSync(file).equals(once)).toBe(true);
    expect(fs.statSync(file).mtimeMs).toBe(mtime);
  });

  test("replaces a stale tag and keeps CRLF line endings", () => {
    const dir = makeRepo("stale-crlf", "\r\n");
    const file = path.join(dir, ".claude-plugin/plugin.json");
    fs.writeFileSync(
      file,
      applyBuildTag(fs.readFileSync(file, "utf8"), "000000000000"),
    );
    const { tag, changed } = updatePluginJson(dir);
    expect(changed).toBe(true);
    const text = fs.readFileSync(file, "utf8");
    expect(text).toContain(`"--build", "${tag}"`);
    expect(text).not.toContain("000000000000");
    expect(text.split("\r\n").length).toBe(PLUGIN_JSON.length);
  });

  test("--stage stages only the tag, leaving other unstaged edits unstaged", () => {
    const dir = makeRepo("stage", "\n");
    const rel = ".claude-plugin/plugin.json";
    const file = path.join(dir, rel);
    const run = (...args: string[]) => {
      const r = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
      expect(r.status).toBe(0);
      return r.stdout;
    };
    run("init", "-q");
    run("config", "core.autocrlf", "false");
    run("add", rel);
    // An unrelated unstaged edit that must stay unstaged.
    fs.writeFileSync(
      file,
      fs.readFileSync(file, "utf8").replace('"name": "discussion-tree"', '"name": "edited"'),
    );
    const { tag } = updatePluginJson(dir);
    expect(stagePluginJsonTag(dir, tag)).toBe(true);
    const staged = run("show", `:${rel}`);
    expect(JSON.parse(staged).mcpServers["discussion-tree"].args).toEqual([
      LAUNCHER_ARG,
      "--build",
      tag,
    ]);
    expect(staged).toContain('"name": "discussion-tree"');
    expect(fs.readFileSync(file, "utf8")).toContain('"name": "edited"');
    // Idempotent on the index too.
    expect(stagePluginJsonTag(dir, tag)).toBe(false);
  });

  test("rejects an unexpected MCP entry instead of guessing", () => {
    const text = JSON.stringify({ mcpServers: { "discussion-tree": { args: ["x"] } } });
    expect(() => applyBuildTag(text, "abc")).toThrow();
  });

  test("the repo's own plugin.json has the expected MCP entry shape", () => {
    // write:false: never touch the real plugin.json from a test.
    expect(() => updatePluginJson(REPO, { write: false })).not.toThrow();
  });
});
