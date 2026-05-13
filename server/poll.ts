// Inbound message poll loop. Drains the broker's pending_messages queue for
// our session and forwards each message to Claude Code via the experimental
// `notifications/claude/channel` MCP capability. Each user UI submission
// arrives here and is pushed to CC as a single channel message.

import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { PollMessagesResponse } from "../shared/types.ts";
import { brokerFetch } from "./broker-client.ts";
import { BROKER_URL } from "./config.ts";
import { log } from "./log.ts";
import { getSessionId } from "./state.ts";

// Fetch the list of OTHER, currently-active option-decision boards owned by
// this session — used to nudge the LLM not to put new decision points into
// the CLI when a relevant board already exists. Default boards and
// completed/withdrawn/paused boards are excluded. Best-effort; if the
// broker is momentarily unreachable we just return an empty list.
async function fetchActiveBoardSummary(sessionId: string): Promise<string> {
  try {
    const res = await fetch(`${BROKER_URL}/api/sessions`);
    if (!res.ok) return "";
    const data = (await res.json()) as {
      sessions: {
        id: string;
        boards: {
          id: string;
          title: string;
          status: string;
          is_default?: number;
        }[];
      }[];
    };
    const me = data.sessions.find((s) => s.id === sessionId);
    const active = (me?.boards ?? []).filter(
      (b) =>
        !b.is_default && (b.status === "discussing" || b.status === "settled"),
    );
    if (active.length === 0) return "";
    const list = active
      .map((b) => `${b.id} ("${b.title}", ${b.status})`)
      .join("; ");
    return `Active option-decision boards in this session: ${list}. New decision points / option-presentations belong in add_concern or add_item on the relevant board — NOT in the CLI.`;
  } catch {
    return "";
  }
}

export async function pollAndPushMessages(mcp: Server): Promise<void> {
  const sessionId = getSessionId();
  if (!sessionId) return;
  try {
    const result = await brokerFetch<PollMessagesResponse>(
      "/poll-messages",
      { session_id: sessionId },
    );
    // Fetch active-boards summary once per drain, only when there's at least
    // one user_input_relay to attach it to — keeps the broker traffic
    // proportional to actual events.
    const hasRelay = result.messages.some(
      (m) => ((m as any).kind ?? "user_input_relay") === "user_input_relay",
    );
    const activeBoardLine = hasRelay
      ? await fetchActiveBoardSummary(sessionId)
      : "";

    for (const msg of result.messages) {
      const kind = (msg as any).kind ?? "user_input_relay";
      // user_input_relay messages need to be mirrored back into the UI
      // thread via post_to_node. The MCP `instructions` payload describes
      // this rule globally, but on first contact the LLM frequently
      // replies in the CLI only and forgets the UI mirror — so we
      // append a per-message reminder to the channel content with the
      // exact ids it needs. Other message kinds (e.g. feedback_logged
      // notifications) don't expect a UI reply, so skip the reminder.
      const reminderParts: string[] = [];
      if (kind === "user_input_relay" && msg.board_id && msg.node_id) {
        reminderParts.push(
          `[discussion-tree] Mirror your reply into the UI thread by calling post_to_node(board_id="${msg.board_id}", node_id="${msg.node_id}", message=<your reply>, status=<discussing|adopted|rejected|agreed|resolved|needs-reply|done>) IN ADDITION to your normal CLI response.`,
        );
        if (activeBoardLine) reminderParts.push(activeBoardLine);
      }
      const content =
        reminderParts.length > 0
          ? `${msg.text}\n\n---\n${reminderParts.join("\n\n")}`
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
