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
      } else if (kind === "board_structure_request" && msg.board_id) {
        reminderParts.push(
          `[discussion-tree] The user submitted a STRUCTURE-CHANGE request for board "${msg.board_id}". Interpret the message above as instructions to modify the board's structure: use add_concern, add_item, update_node, move_node, reorder_node, or delete_node as appropriate. Apply the changes, then append a SHORT SUMMARY of what you did (or chose NOT to do, with reason) to that board's dedicated audit-trail node — to find it, call get_board(board_id="${msg.board_id}") and look for the item node with is_log=1 (titled "Structure changes" under the "Board log" concern). Post your summary there via post_to_node. The user's original request is already auto-recorded on that same log node, so your post pairs with it. Do NOT post into any user content node, and do NOT treat this as a normal thread reply.`,
        );
      } else if (kind === "map_chat" && msg.board_id) {
        const target =
          msg.node_id && msg.node_id !== "__general__"
            ? `map node "${msg.node_id}"`
            : `the map-wide general chat`;
        reminderParts.push(
          `[discussion-tree] This is a MAP message (${target}) on map "${msg.board_id}". First call get_map(map_id="${msg.board_id}") to see the current graph (the user may have dragged / connected / deleted nodes since you last looked — those edits are silent). Then RESPOND BY GROWING THE MAP: add_map_node / connect_map_nodes / update_map_node as the conversation calls for, and mirror any conversational reply with post_to_map_node(map_id="${msg.board_id}", node_id="${msg.node_id || "__general__"}", message=<reply>). Keep it incremental — a few nodes at a time, not a giant pre-built graph.`,
        );
      }
      const content =
        reminderParts.length > 0
          ? `${msg.text}\n\n---\n${reminderParts.join("\n\n")}`
          : msg.text;
      await mcp.notification({
        method: "notifications/claude/channel",
        params: {
          content,
          // CHANNEL META CONSTRAINT: every value here must be a STRING. A
          // first cut surfaced message_id as a NUMBER and that silently killed
          // ALL channel delivery for any freshly-restarted CC (the broker still
          // marked messages delivered, so they were lost). The custom keys
          // node_path / sent_at prove extra KEYS are fine — it was the non-
          // string value that broke it. So message_id rides along, stringified.
          // thread_items.id of this user message — lets a reply cite the exact
          // human message (sources=[{kind:"message", id:<message_id>}]). Present
          // for user_input_relay; omitted for structure-requests / notes.
          meta: {
            kind,
            board_id: msg.board_id,
            node_id: msg.node_id,
            node_path: msg.node_path,
            sent_at: msg.created_at,
            ...(msg.thread_item_id != null
              ? { message_id: String(msg.thread_item_id) }
              : {}),
            // For map_chat, board_id IS the map_id; surface it under its own
            // key too so the meta reads unambiguously. String, per the
            // channel-meta constraint (a non-string value silently kills all
            // channel delivery).
            ...(kind === "map_chat" ? { map_id: String(msg.board_id) } : {}),
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
