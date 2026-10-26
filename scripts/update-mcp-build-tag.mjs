#!/usr/bin/env node
// Keep the MCP build tag in .claude-plugin/plugin.json in step with the MCP
// code: rewrites mcpServers["discussion-tree"].args to
//   ["${CLAUDE_PLUGIN_ROOT}/scripts/mcp-node.mjs", "--build", "<tag>"]
// when <tag> (buildTag in mcp-node-build.mjs) differs. Why the tag exists is
// explained there: /reload-plugins restarts the MCP server only when its
// command/args change.
//
// The rewrite is textual (only the args array is touched), so the file's
// formatting and line endings are preserved, and it is idempotent: an
// up-to-date file is not written at all.
//
// Run by the pre-commit hook (.githooks/pre-commit, with --stage) and by
// `bun run mcp:build-tag`. Works under node or bun.
// Flags: --check  exit 1 instead of writing when the tag is stale.
//        --stage  also put the tag into the staged plugin.json (only the tag;
//                 other unstaged edits to plugin.json stay unstaged).
//
// The tag is computed from the working tree, not the index: a commit that
// stages only part of the MCP changes gets the tag of the full working tree.

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildTag } from "./mcp-node-build.mjs";

export const SERVER_NAME = "discussion-tree";
export const LAUNCHER_ARG = "${CLAUDE_PLUGIN_ROOT}/scripts/mcp-node.mjs";

export function pluginJsonPath(repo) {
  return path.join(repo, ".claude-plugin", "plugin.json");
}

// Returns plugin.json text with the build tag set to `tag` (unchanged text if
// it already is). Throws if the MCP server entry is not in the expected shape,
// rather than guessing.
export function applyBuildTag(text, tag) {
  const json = JSON.parse(text);
  const args = json?.mcpServers?.[SERVER_NAME]?.args;
  if (!Array.isArray(args) || args[0] !== LAUNCHER_ARG) {
    throw new Error(
      `plugin.json: mcpServers.${SERVER_NAME}.args must start with ${JSON.stringify(LAUNCHER_ARG)}`,
    );
  }
  const want = [LAUNCHER_ARG, "--build", tag];
  if (args.length === want.length && args.every((a, i) => a === want[i])) return text;

  // Replace the whole args array of the discussion-tree server entry, keeping
  // everything around it byte for byte. The array holds only strings, so the
  // first "]" after "args": [ closes it.
  const entry = text.indexOf(`"${SERVER_NAME}"`, text.indexOf('"mcpServers"'));
  const re = /"args"\s*:\s*\[[^\]]*\]/g;
  re.lastIndex = entry;
  const m = entry >= 0 ? re.exec(text) : null;
  if (!m) throw new Error("plugin.json: could not locate the MCP args array");
  const replacement = `"args": [${want.map((a) => JSON.stringify(a)).join(", ")}]`;
  const out = text.slice(0, m.index) + replacement + text.slice(m.index + m[0].length);

  const check = JSON.parse(out)?.mcpServers?.[SERVER_NAME]?.args;
  if (JSON.stringify(check) !== JSON.stringify(want)) {
    throw new Error("plugin.json: rewrite did not produce the expected args");
  }
  return out;
}

// Updates plugin.json in `repo`. Returns { tag, changed }.
export function updatePluginJson(repo, { write = true } = {}) {
  const file = pluginJsonPath(repo);
  const before = fs.readFileSync(file, "utf8");
  const tag = buildTag(repo);
  const after = applyBuildTag(before, tag);
  const changed = after !== before;
  if (changed && write) fs.writeFileSync(file, after);
  return { tag, changed };
}

function git(repo, args, input) {
  const r = spawnSync("git", args, { cwd: repo, input, encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${(r.stderr || "").trim()}`);
  }
  return r.stdout;
}

// Sets the tag in the STAGED plugin.json (the index), touching nothing else
// that is staged or unstaged: the index blob is rewritten directly, so other
// unstaged edits to plugin.json stay unstaged. Returns true if it changed.
export function stagePluginJsonTag(repo, tag) {
  const rel = ".claude-plugin/plugin.json";
  const staged = git(repo, ["show", `:${rel}`]);
  const next = applyBuildTag(staged, tag);
  if (next === staged) return false;
  const blob = git(repo, ["hash-object", "-w", "--no-filters", "--stdin"], next).trim();
  const mode = git(repo, ["ls-files", "-s", "--", rel]).split(" ")[0] || "100644";
  git(repo, ["update-index", "--cacheinfo", `${mode},${blob},${rel}`]);
  return true;
}

function isMain() {
  if (!process.argv[1]) return false;
  const norm = (p) => {
    const r = path.resolve(p);
    return process.platform === "win32" ? r.toLowerCase() : r;
  };
  return norm(process.argv[1]) === norm(fileURLToPath(import.meta.url));
}

if (isMain()) {
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const checkOnly = process.argv.includes("--check");
  const stage = process.argv.includes("--stage");
  try {
    const { tag, changed } = updatePluginJson(repo, { write: !checkOnly });
    if (stage && stagePluginJsonTag(repo, tag)) {
      console.log(`mcp build tag: staged plugin.json with ${tag}`);
    }
    if (!changed) {
      console.log(`mcp build tag: ${tag} (up to date)`);
    } else if (checkOnly) {
      console.error(`mcp build tag: plugin.json is stale (want ${tag}); run bun run mcp:build-tag`);
      process.exit(1);
    } else {
      console.log(`mcp build tag: plugin.json updated to ${tag}`);
    }
  } catch (e) {
    console.error(`mcp build tag: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}
