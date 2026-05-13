// Inbound message poll loop. Drains the broker's pending_messages queue for
// our session and forwards each message to Claude Code via the experimental
// `notifications/claude/channel` MCP capability. Each user UI submission
// arrives here and is pushed to CC as a single channel message.

import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { PollMessagesResponse } from "../shared/types.ts";
import { brokerFetch } from "./broker-client.ts";
import { log } from "./log.ts";
import { getSessionId } from "./state.ts";

export async function pollAndPushMessages(mcp: Server): Promise<void> {
  const sessionId = getSessionId();
  if (!sessionId) return;
  try {
    const result = await brokerFetch<PollMessagesResponse>(
      "/poll-messages",
      { session_id: sessionId },
    );
    for (const msg of result.messages) {
      const kind = (msg as any).kind ?? "user_input_relay";
      // user_input_relay messages need to be mirrored back into the UI
      // thread via post_to_node. The MCP `instructions` payload describes
      // this rule globally, but on first contact the LLM frequently
      // replies in the CLI only and forgets the UI mirror — so we
      // append a per-message reminder to the channel content with the
      // exact ids it needs. Other message kinds (e.g. feedback_logged
      // notifications) don't expect a UI reply, so skip the reminder.
      const content =
        kind === "user_input_relay" && msg.board_id && msg.node_id
          ? `${msg.text}\n\n---\n[discussion-tree] Mirror your reply into the UI thread by calling post_to_node(board_id="${msg.board_id}", node_id="${msg.node_id}", message=<your reply>, status=<discussing|adopted|rejected|agreed|resolved|needs-reply|done>) IN ADDITION to your normal CLI response.`
          : msg.text;
      await mcp.notification({
        method: "notifications/claude/channel",
        params: {
          content,
          meta: {
            kind,
            board_id: msg.board_id,
            node_id: msg.node_id,
            node_path: msg.node_path,
            sent_at: msg.created_at,
          },
        },
      });
      log(
        `Pushed [${kind}] for ${msg.node_id || "(meta)"} ${
          msg.node_path ? `(${msg.node_path.slice(0, 60)})` : ""
        }`,
      );
    }
  } catch (e) {
    log(`Poll error: ${e instanceof Error ? e.message : String(e)}`);
  }
}
