// MCP side of a queued cli-send: every tmux step's exit code is checked, the
// error reaches the broker in the ack, and failures go to the failure log.
// tmux is faked: probePane/sendToPane take the tmux argv prefix (`base`), so a
// bun script stands in for the binary and no real pane is ever touched.

import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  injectIntoPane,
  ownTmuxPaneFromEnv,
  paneTarget,
  probePane,
  sendToPane,
} from "../../shared/tmux-inject.ts";
import { runCliInjects, type CliInjectDeps } from "../../server/poll.ts";
import { logFailureLine } from "../../shared/failure-log.ts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dt-fake-tmux-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

// A fake tmux: records each argv to calls.log; list-panes prints FAKE_PANES;
// exits FAKE_FAIL_CODE (with a stderr line) when argv contains FAKE_FAIL_ON.
const fake = path.join(tmp, "fake-tmux.ts");
const callsLog = path.join(tmp, "calls.log");
fs.writeFileSync(
  fake,
  `
import * as fs from "node:fs";
const argv = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(callsLog)}, JSON.stringify(argv) + "\\n");
const failOn = process.env.FAKE_FAIL_ON;
if (failOn && argv.includes(failOn)) {
  process.stderr.write("psmux: ambiguous pane id %2: present in sessions a, b\\n");
  process.exit(Number(process.env.FAKE_FAIL_CODE || 1));
}
if (argv.includes("list-panes")) process.stdout.write(process.env.FAKE_PANES || "");
`,
);
const base = [process.execPath, fake];

function calls(): string[][] {
  try {
    return fs
      .readFileSync(callsLog, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}
function reset(env: Record<string, string | undefined>) {
  fs.rmSync(callsLog, { force: true });
  for (const k of ["FAKE_FAIL_ON", "FAKE_FAIL_CODE", "FAKE_PANES"]) {
    delete process.env[k];
  }
  Object.assign(process.env, env);
}

describe("psmux pane targeting", () => {
  test("paneTarget qualifies with the session only when one is known", () => {
    expect(paneTarget("%2", "perf-review")).toBe("perf-review:.%2");
    expect(paneTarget("%2", null)).toBe("%2");
  });

  test("ownTmuxPaneFromEnv reads PSMUX_SESSION", () => {
    expect(
      ownTmuxPaneFromEnv({
        TMUX: "/tmp/psmux-21056/default,58723,0",
        TMUX_PANE: "%2",
        PSMUX_SESSION: "perf-review",
      }),
    ).toEqual({
      pane: "%2",
      socket: "/tmp/psmux-21056/default",
      session: "perf-review",
    });
    expect(ownTmuxPaneFromEnv({}).session).toBeNull();
  });

  test("probePane matches the pane id within the given session", async () => {
    // Real psmux output: two sessions each own a %2.
    reset({
      FAKE_PANES:
        "%2\tnode\tperf-review\n%2\tpwsh\twin-admin\n%1\tnode\tother\n",
    });
    expect(await probePane(base, "%2", "perf-review")).toBe("ok");
    expect(await probePane(base, "%2", "win-admin")).toBe("shell");
    expect(await probePane(base, "%2", "gone")).toBe("missing");
  });

  test("injectIntoPane sends every step to the qualified target", async () => {
    reset({ FAKE_PANES: "%2\tnode\tperf-review\n%2\tnode\twin-admin\n" });
    const r = await injectIntoPane(
      null,
      "%2",
      "/compact",
      "",
      "perf-review",
      base,
    );
    expect(r).toEqual({ ok: true });
    const targets = calls()
      .filter((a) => a.includes("-t"))
      .map((a) => a[a.indexOf("-t") + 1]);
    expect(targets).toEqual([
      "perf-review:.%2",
      "perf-review:.%2",
      "perf-review:.%2",
    ]);
  });
});

describe("tmux step failures are reported", () => {
  test("a failing send-keys stops the sequence and returns the details", async () => {
    reset({ FAKE_FAIL_ON: "C-u", FAKE_FAIL_CODE: "1" });
    const f = await sendToPane(base, "%2", "/compact");
    expect(f).toMatchObject({ step: "send-keys C-u", code: 1 });
    expect(f!.stderr).toContain("ambiguous pane id");
    // Nothing after the failing step ran (no paste, no Enter).
    expect(calls().length).toBe(1);
  });

  test("injectIntoPane returns tmux_failed with the failure", async () => {
    reset({ FAKE_PANES: "%2\tnode\ts\n", FAKE_FAIL_ON: "paste-buffer" });
    const r = await injectIntoPane(null, "%2", "/compact", "x", "s", base);
    expect(r.ok).toBe(false);
    expect(r.error).toBe("tmux_failed");
    expect(r.failure?.step).toBe("paste-buffer");
  });

  test("a missing binary is a failure, not a hang", async () => {
    reset({});
    const f = await sendToPane([path.join(tmp, "no-such-tmux")], "%2", "/x");
    expect(f?.code).toBe(127);
  });
});

describe("runCliInjects ack", () => {
  function deps(over: Partial<CliInjectDeps>) {
    const acks: any[] = [];
    const logs: any[] = [];
    const d: CliInjectDeps = {
      inject: async () => ({ ok: true }),
      ack: async (b) => {
        acks.push(b);
      },
      logFailure: (f) => logs.push(f),
      env: {
        TMUX: "/tmp/psmux-1/default,1,0",
        TMUX_PANE: "%2",
        PSMUX_SESSION: "perf-review",
      },
      ...over,
    };
    return { d, acks, logs };
  }
  const flush = () => new Promise((r) => setTimeout(r, 10));

  test("success acks ok without an error and logs nothing", async () => {
    let seen: unknown[] = [];
    const { d, acks, logs } = deps({
      inject: async (...a) => {
        seen = a;
        return { ok: true };
      },
    });
    await runCliInjects([{ id: 7, command: "/compact", args: "" }], d);
    await flush();
    expect(seen).toEqual([
      "/tmp/psmux-1/default",
      "%2",
      "/compact",
      "",
      "perf-review",
    ]);
    expect(acks).toEqual([{ id: 7, ok: true }]);
    expect(logs).toEqual([]);
  });

  test("a tmux failure acks the reason and logs pane/socket/argv/stderr", async () => {
    const { d, acks, logs } = deps({
      inject: async () => ({
        ok: false,
        error: "tmux_failed",
        failure: {
          step: "send-keys C-u",
          argv: ["tmux", "send-keys", "-t", "%2", "C-u"],
          code: 1,
          stderr: "psmux: ambiguous pane id %2",
        },
      }),
    });
    await runCliInjects([{ id: 8, command: "/compact", args: "" }], d);
    await flush();
    expect(acks).toEqual([
      {
        id: 8,
        ok: false,
        error:
          "tmux_failed: send-keys C-u exited 1 (psmux: ambiguous pane id %2)",
      },
    ]);
    expect(logs[0]).toMatchObject({
      step: "send-keys C-u",
      pane: "%2",
      socket: "/tmp/psmux-1/default",
      psmux_session: "perf-review",
      command: "/compact",
      status: 1,
      stderr: "psmux: ambiguous pane id %2",
    });
  });

  test("a probe failure acks the error code", async () => {
    const { d, acks, logs } = deps({
      inject: async () => ({ ok: false, error: "pane_gone" }),
    });
    await runCliInjects([{ id: 9, command: "/compact", args: "" }], d);
    await flush();
    expect(acks).toEqual([{ id: 9, ok: false, error: "pane_gone" }]);
    expect(logs[0].step).toBe("probe");
  });

  test("not inside tmux acks not_in_tmux and logs it", async () => {
    const { d, acks, logs } = deps({ env: {} });
    await runCliInjects([{ id: 10, command: "/compact", args: "" }], d);
    await flush();
    expect(acks).toEqual([{ id: 10, ok: false, error: "not_in_tmux" }]);
    expect(logs[0].step).toBe("skipped: not inside tmux");
  });

  test("an inject that throws still acks", async () => {
    const { d, acks } = deps({
      inject: async () => {
        throw new Error("boom");
      },
    });
    await runCliInjects([{ id: 11, command: "/compact", args: "" }], d);
    await flush();
    expect(acks).toEqual([{ id: 11, ok: false, error: "exception: boom" }]);
  });
});

describe("failure log", () => {
  test("appends one JSON line to DT_HOOK_FAILURE_LOG", () => {
    const file = path.join(tmp, "failures.log");
    logFailureLine("mcp cli-inject", { step: "x", pane: "%2" }, {
      DT_HOOK_FAILURE_LOG: file,
    });
    const line = JSON.parse(fs.readFileSync(file, "utf8").trim());
    expect(line).toMatchObject({ hook: "mcp cli-inject", step: "x", pane: "%2" });
  });

  test("is off under NODE_ENV=test without an explicit path", () => {
    // Would throw if it tried to write somewhere unexpected; it just no-ops.
    logFailureLine("t", {}, { NODE_ENV: "test" });
  });
});
