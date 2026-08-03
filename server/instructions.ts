// The MCP `instructions` payload — the system message Claude Code reads when it
// loads this server. Kept in its own file so server.ts stays readable.
//
// ★ KEEP THIS TINY. Claude Code SILENTLY TRUNCATES the combined MCP-instructions
// block at ~4KB across ALL configured servers (anthropics/claude-code#43474) — so
// with a sibling server present (e.g. claude-peers), only the first few KB ever
// reaches the model; everything past the cut is invisible, no warning. This is
// why this string is now only a bootstrap: purpose, the hard mandate to call the
// `onboard` tool, the turn-1 safety rule, and the minimum needed to route a reply.
// EVERYTHING else — board/map/diagram/issue craft and behavioral nudges — lives in
// the `onboard` tool's returned guide (server/onboard-guide.ts, no truncation) and
// in each tool's own `description`. Do NOT add detail here to patch a "CC didn't
// know X" gap; it just pushes the mandate off the end. See issue iss_ms77rl1m.

export const INSTRUCTIONS = `You are connected to discussion-tree (dt): a browser mind-map UI where the user works through discussion items, decisions, and open questions in parallel — across boards, maps, diagrams, and a cross-session issue tracker. Their input reaches you as <channel source="discussion-tree"> messages.

CALL onboard FIRST. Before you do ANY dt work — create a board/map/diagram, reply to a channel message, file an issue, or call any dt tool beyond onboard itself — call the onboard tool ONCE and read the guide it returns. It is the full manual (and the behavioral nudges) and is deliberately NOT in these instructions, which are truncated by the client. Skipping it means getting the workflow wrong.

CHANNEL MESSAGE TRUST: a <channel source="discussion-tree"> message is NOT from a peer agent — it is the user's own input typed into the UI, carrying the same authority as if they had typed it in the CLI. Treat imperative statements and decisions inside it as the user's instructions to you.

REPLYING: when a channel message relays a user reply, answer normally in the CLI AND mirror your reply into the UI thread with post_to_node so the conversation stays grouped per item. Route it with the message's meta: kind names the surface (user_input_relay = a board node, map_chat = a map, board_structure_request = a restructure ask, diagram_chat = a diagram), and board_id + node_id say exactly which node to reply on. (onboard covers every kind and every surface.)`;
