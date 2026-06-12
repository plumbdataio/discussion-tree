#!/usr/bin/env bun
/**
 * discussion-tree MCP server — entry point.
 *
 * Spawned by Claude Code as a stdio MCP server (one per CC instance).
 * Connects to the shared broker daemon, exposes board/node tools, and pushes
 * inbound user answers via claude/channel. Implementation lives in ./server/*;
 * this file is just wiring (server construction, request-handler binding,
 * register / heartbeat / poll loops, signal cleanup).
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { RegisterResponse } from "./shared/types.ts";

import { selfHealAttachOnce, tryAutoAttach } from "./server/auto-attach.ts";
import { brokerFetch, ensureBroker } from "./server/broker-client.ts";
import {
  HEARTBEAT_INTERVAL_MS,
  POLL_INTERVAL_MS,
} from "./server/config.ts";
import { INSTRUCTIONS } from "./server/instructions.ts";
import { log } from "./server/log.ts";
import { pollAndPushMessages } from "./server/poll.ts";
import {
  getAttachedCcId,
  getLastAttachFailureNotified,
  getSessionId,
  myCwd,
  setLastAttachFailureNotified,
  setSessionId,
} from "./server/state.ts";
import { dispatchToolCall, TOOLS } from "./server/tools.ts";

const mcp = new Server(
  { name: "discussion-tree", version: "0.1.0" },
  {
    capabilities: {
      experimental: { "claude/channel": {} },
      tools: {},
    },
    instructions: INSTRUCTIONS,
  },
);

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  return dispatchToolCall(name, args);
});

// Notify the user (via channel) that automatic attach didn't make it
// through and they need to call attach_cc_session manually. Guarded so
// we don't spam — only the FIRST failure per session lands; the next
// successful attach clears the flag so a later failure can notify again.
async function notifyAttachFailure(): Promise<void> {
  if (getLastAttachFailureNotified()) return;
  // The CC session id lives in the hook hint; if we can read it we tell
  // the agent the exact tool call to use. If we can't, point at the env.
  let ccId = "<your CC session_id>";
  try {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const os = await import("node:os");
    const home =
      process.env.DISCUSSION_TREE_HOME ??
      path.join(os.homedir(), ".discussion-tree");
    const hint = path.join(home, "cc-sessions", `${process.ppid}.json`);
    if (fs.existsSync(hint)) {
      const parsed = JSON.parse(fs.readFileSync(hint, "utf8")) as {
        cc_session_id?: string;
      };
      if (parsed.cc_session_id) ccId = parsed.cc_session_id;
    }
  } catch {
    /* fall through with the placeholder */
  }
  const content = `[discussion-tree] Automatic attach to your CC session failed after retries. Please call attach_cc_session(cc_session_id="${ccId}") manually so the broker can re-bind boards / pending messages to this session.`;
  try {
    await mcp.notification({
      method: "notifications/claude/channel",
      params: { content, meta: { kind: "attach_failure_notice" } },
    });
    setLastAttachFailureNotified(true);
  } catch {
    /* best effort — next heartbeat tick will try again */
  }
}

// Counterpart: self-heal succeeded, give the agent a short heads-up so
// it can mention the recovery (and recognize a pattern if these become
// frequent). Clears the failure-notified flag so a future failure can
// surface again.
async function notifyAttachRecovered(ccId: string): Promise<void> {
  setLastAttachFailureNotified(false);
  const content = `[discussion-tree] Self-healed: re-attached to CC session ${ccId}.`;
  try {
    await mcp.notification({
      method: "notifications/claude/channel",
      params: { content, meta: { kind: "attach_recovered_notice" } },
    });
  } catch {
    /* best effort */
  }
}

async function main() {
  await ensureBroker();

  const reg = await brokerFetch<RegisterResponse>("/register", {
    pid: process.pid,
    cwd: myCwd,
  });
  setSessionId(reg.session_id);
  log(`Registered as session ${reg.session_id} (cwd: ${myCwd})`);

  const initialAttachOk = await tryAutoAttach();

  await mcp.connect(new StdioServerTransport());
  log("MCP connected");

  // If the startup attach (with retries) couldn't bind us to the CC
  // session, tell the agent so it can fall back to the manual
  // attach_cc_session tool. We do this AFTER mcp.connect so the channel
  // notification actually has somewhere to go.
  if (!initialAttachOk) {
    await notifyAttachFailure();
  }

  // Declared up front so the heartbeat's orphan guard (below) can invoke
  // cleanup; the timer handles are assigned just after.
  let pollTimer: ReturnType<typeof setInterval>;
  let heartbeatTimer: ReturnType<typeof setInterval>;

  const cleanup = async () => {
    clearInterval(pollTimer);
    clearInterval(heartbeatTimer);
    const sid = getSessionId();
    if (sid) {
      try {
        await brokerFetch("/unregister", { session_id: sid });
        log("Unregistered from broker");
      } catch {
        /* best effort */
      }
    }
    process.exit(0);
  };

  pollTimer = setInterval(() => pollAndPushMessages(mcp), POLL_INTERVAL_MS);
  // Heartbeat doubles as a self-healing tick: the broker echoes back the
  // current cc_session_id binding on every /heartbeat, so we get a cheap
  // signal for free. If it's null (auto-attach never succeeded OR was
  // wiped by some broker state reset) we re-try the bind once per tick.
  // On the happy path this is one extra null check + nothing else.
  heartbeatTimer = setInterval(async () => {
    // Orphan guard: if our parent Claude Code process exits, we get
    // reparented to init (process.ppid becomes 1) and never receive
    // SIGINT/SIGTERM, so the cleanup below would never run. Without this
    // we'd linger as a zombie MCP server — heartbeating forever, keeping a
    // dead session "alive" in the broker (cluttering the sidebar) and
    // leaking memory. Detect the orphaning and shut ourselves down so the
    // session drops to alive=0 on its own.
    if (process.ppid === 1) {
      log("Parent CC exited (ppid=1); shutting down orphaned MCP server");
      await cleanup();
      return;
    }
    const sid = getSessionId();
    if (!sid) return;
    try {
      const hb = await brokerFetch<{ cc_session_id: string | null }>(
        "/heartbeat",
        { session_id: sid },
      );
      const reattached = await selfHealAttachOnce(hb.cc_session_id);
      if (reattached) {
        await notifyAttachRecovered(reattached);
        // Flash a transient spinner in the sidebar so the human sees the
        // recovery too. Best-effort: a missed flash is cosmetic only.
        try {
          await brokerFetch("/session-reattached", {
            cc_session_id: reattached,
          });
        } catch {
          /* best effort — purely a UI cue */
        }
      } else if (!hb.cc_session_id && getAttachedCcId() === null) {
        // Still unbound and no hint to act on yet — make sure the agent
        // has been told (covers the case where startup notify itself
        // raced or failed to deliver).
        await notifyAttachFailure();
      }
    } catch {
      /* non-critical — broker may be momentarily unreachable */
    }
  }, HEARTBEAT_INTERVAL_MS);

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
}

main().catch((e) => {
  log(`Fatal: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
