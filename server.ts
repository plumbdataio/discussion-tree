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

import { tryAutoAttach } from "./server/auto-attach.ts";
import { brokerFetch, ensureBroker } from "./server/broker-client.ts";
import {
  HEARTBEAT_INTERVAL_MS,
  POLL_INTERVAL_MS,
} from "./server/config.ts";
import { INSTRUCTIONS } from "./server/instructions.ts";
import { log } from "./server/log.ts";
import { pollAndPushMessages } from "./server/poll.ts";
import { getSessionId, myCwd, setSessionId } from "./server/state.ts";
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

async function main() {
  await ensureBroker();

  const reg = await brokerFetch<RegisterResponse>("/register", {
    pid: process.pid,
    cwd: myCwd,
  });
  setSessionId(reg.session_id);
  log(`Registered as session ${reg.session_id} (cwd: ${myCwd})`);

  await tryAutoAttach();

  await mcp.connect(new StdioServerTransport());
  log("MCP connected");

  const pollTimer = setInterval(() => pollAndPushMessages(mcp), POLL_INTERVAL_MS);
  const heartbeatTimer = setInterval(async () => {
    const sid = getSessionId();
    if (!sid) return;
    try {
      await brokerFetch("/heartbeat", { session_id: sid });
    } catch {
      /* non-critical — broker may be momentarily unreachable */
    }
  }, HEARTBEAT_INTERVAL_MS);

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

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
}

main().catch((e) => {
  log(`Fatal: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
