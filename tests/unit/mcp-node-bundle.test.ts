// Guards for the Node bundle of the MCP server (scripts/mcp-node.mjs).
//
// Regression: `bun build --target=node server.ts` bundled server/state.ts (and
// config/log/broker-client) twice on LF checkouts, because server.ts starts
// with `#!/usr/bin/env bun`. The session id set by one copy was invisible to
// the other, so the session never attached. These tests fail if any server/ or
// shared/ module appears twice in the bundle the launcher builds.

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  buildBundle,
  findDuplicateModules,
} from "../../scripts/mcp-node-build.mjs";

const REPO = path.resolve(import.meta.dir, "../..");
// The bun running this test, so the build does not depend on PATH.
const BUN = process.execPath;
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dt-mcp-node-"));
afterAll(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

describe("findDuplicateModules", () => {
  test("a header over hoisted imports only is not a duplicate", () => {
    const code = [
      "// server/config.ts",
      'import { join } from "node:path";',
      "import {",
      "  homedir,",
      '} from "node:os";',
      "",
      "// shared/config.ts",
      "var A = 1;",
      "",
      "// server/config.ts",
      "var B = join(homedir());",
    ].join("\n");
    expect(findDuplicateModules(code)).toEqual([]);
  });

  test("two headers with code under them are reported", () => {
    const code = [
      "// server/state.ts",
      "var mySessionId = null;",
      "// server/tools.ts",
      "function t() {}",
      "// server/state.ts",
      "var mySessionId2 = null;",
      "// node_modules/x/index.js",
      "var x = 1;",
      "// node_modules/x/index.js",
      "var x2 = 1;",
    ].join("\n");
    expect(findDuplicateModules(code)).toEqual(["server/state.ts"]);
  });

  test("CRLF bundles are handled", () => {
    const code = "// server/a.ts\r\nvar a = 1;\r\n// server/a.ts\r\nvar a2 = 1;\r\n";
    expect(findDuplicateModules(code)).toEqual(["server/a.ts"]);
  });
});

describe("buildBundle", () => {
  test("an LF entry with a bun shebang still shares one module instance", () => {
    // Mirrors server.ts: the entry and a nested module import the same state
    // module through different relative specifiers.
    const dir = path.join(tmpRoot, "fixture");
    fs.mkdirSync(path.join(dir, "server"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "entry.ts"),
      [
        "#!/usr/bin/env bun",
        'import { setId, getId } from "./server/state.ts";',
        'import { readId } from "./server/reader.ts";',
        'setId("s1");',
        "console.log(JSON.stringify([getId(), readId()]));",
        "",
      ].join("\n"),
    );
    fs.writeFileSync(
      path.join(dir, "server", "state.ts"),
      [
        "let id: string | null = null;",
        "export function setId(v: string) { id = v; }",
        "export function getId() { return id; }",
        "",
      ].join("\n"),
    );
    fs.writeFileSync(
      path.join(dir, "server", "reader.ts"),
      'import { getId } from "./state.ts";\nexport function readId() { return getId(); }\n',
    );
    const out = path.join(dir, "dist", "bundle.mjs");
    buildBundle(path.join(dir, "entry.ts"), out, { cwd: dir, bun: BUN });
    const code = fs.readFileSync(out, "utf8");
    expect(findDuplicateModules(code)).toEqual([]);
    const run = spawnSync("node", [out], { encoding: "utf8" });
    expect(run.status).toBe(0);
    expect(JSON.parse(run.stdout.trim())).toEqual(["s1", "s1"]);
    // The temporary stub entry is cleaned up.
    expect(fs.readdirSync(path.dirname(out))).toEqual(["bundle.mjs"]);
  });

  test("the real server.ts bundle has no server/ or shared/ module twice", () => {
    const out = path.join(tmpRoot, "real", "server.mjs");
    buildBundle(path.join(REPO, "server.ts"), out, { cwd: REPO, bun: BUN });
    const code = fs.readFileSync(out, "utf8");
    // The check relies on bun's "// <path>" module comments; make sure they
    // are there so it cannot pass vacuously.
    expect(code).toContain("\n// server/state.ts\n");
    expect(findDuplicateModules(code)).toEqual([]);
  });

  test("the real server.ts bundle stays clean when checked out with LF", () => {
    // pd-002 checks out with CRLF, which hides the shebang trigger; build from
    // an LF copy of the server sources so the guard bites on every platform.
    const copy = path.join(tmpRoot, "lfcopy");
    const lf = (src: string, dst: string) => {
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.writeFileSync(dst, fs.readFileSync(src, "utf8").replace(/\r\n/g, "\n"));
    };
    lf(path.join(REPO, "server.ts"), path.join(copy, "server.ts"));
    for (const sub of ["server", "shared"]) {
      for (const f of fs.readdirSync(path.join(REPO, sub))) {
        if (f.endsWith(".ts")) lf(path.join(REPO, sub, f), path.join(copy, sub, f));
      }
    }
    fs.copyFileSync(path.join(REPO, "package.json"), path.join(copy, "package.json"));
    fs.symlinkSync(
      path.join(REPO, "node_modules"),
      path.join(copy, "node_modules"),
      process.platform === "win32" ? "junction" : "dir",
    );
    expect(fs.readFileSync(path.join(copy, "server.ts"), "utf8")).toStartWith(
      "#!/usr/bin/env bun\n",
    );
    const out = path.join(copy, ".mcp-dist", "server.mjs");
    try {
      buildBundle(path.join(copy, "server.ts"), out, { cwd: copy, bun: BUN });
    } finally {
      // Drop the link itself before the recursive cleanup ever sees it.
      fs.unlinkSync(path.join(copy, "node_modules"));
    }
    expect(findDuplicateModules(fs.readFileSync(out, "utf8"))).toEqual([]);
  });
});
