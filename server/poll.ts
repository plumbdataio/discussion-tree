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
    return `Other active boards here: ${list}. Put new decision points on the relevant board (add_concern / add_item), not the CLI.`;
  } catch {
    return "";
  }
}

// Build a COMPACT current-map snapshot to ride along with a map_chat push, so
// the owning CC RECEIVES the current shape (passive) instead of having to
// remember to call get_map (active — agents forget, the same failure class as
// forgotten UI mirrors). Only the shape (id · kind · title + edges), not full
// context/threads — those stay a deliberate get_map. Big maps fall back to a
// count + a get_map pointer so the push doesn't balloon.
async function fetchMapShape(mapId: string): Promise<string> {
  try {
    const res = await brokerFetch<{
      ok: boolean;
      nodes?: { id: string; kind: string; title: string }[];
      edges?: { from_id: string; to_id: string }[];
    }>("/get-map", { map_id: mapId });
    if (!res.ok || !res.nodes) return "";
    const nodes = res.nodes;
    const edges = res.edges ?? [];
    if (nodes.length === 0) {
      return "Current map: no nodes yet — this is a blank map to start growing.";
    }
    if (nodes.length > 40) {
      return `Current map has ${nodes.length} nodes / ${edges.length} edges — too many to inline; call get_map(map_id="${mapId}") for the structure.`;
    }
    const oneLine = (s: string) =>
      (s ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
    const nodeLines = nodes
      .map((n) => `  ${n.id} · ${n.kind} · ${oneLine(n.title) || "(untitled)"}`)
      .join("\n");
    const edgeLines = edges.length
      ? edges.map((e) => `  ${e.from_id} → ${e.to_id}`).join("\n")
      : "  (none)";
    return `Current map structure (so you don't need a separate get_map for the shape):\nNodes (id · kind · title):\n${nodeLines}\nEdges (from → to):\n${edgeLines}\n(get_map only for full node context / threads.)`;
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
          `[discussion-tree] Also mirror your reply via post_to_node(board_id="${msg.board_id}", node_id="${msg.node_id}", status=…).`,
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
        // Ride the current map shape along with the push (passive receipt) so
        // the CC doesn't have to remember a get_map before acting on structure.
        const shape = await fetchMapShape(msg.board_id);
        reminderParts.push(
          `[discussion-tree] Map message (${target}). Respond by GROWING THE MAP (add_map_node / connect_map_nodes / update_map_node) and/or reply via post_to_map_node(map_id="${msg.board_id}", node_id="${msg.node_id || "__general__"}"). Incremental, a few nodes at a time.${shape ? `\n\n${shape}` : ""}`,
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
      // The channel write to CC resolved → this session is alive and about to
      // process the turn. Tell the broker so it can clear any stall warning and
      // cancel the pending auto-continue. Tied to push-success (not the broker's
      // `delivered` flag, which flips at queue-drain BEFORE this notification is
      // attempted) so a failed push leaves the honest stalled state. Echo the
      // stalled_at observed at drain so the clear is identity-guarded: a delayed
      // ack can't wipe a NEWER stall recorded after this push. Best-effort and
      // idempotent broker-side, so a duplicate ack per drain is harmless.
      void brokerFetch("/channel-pushed", {
        session_id: sessionId,
        stalled_at: result.stalled_at ?? null,
      }).catch(() => {});
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
