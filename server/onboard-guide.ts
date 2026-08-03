// allow-japanese-file: the guide string shows CJK punctuation examples for CC
// The full discussion-tree operating guide, returned by the `onboard` MCP tool
// on demand. It is DELIBERATELY not part of the delivered `instructions`
// payload: Claude Code silently truncates the combined MCP-instructions block
// at ~4KB across ALL configured servers (anthropics/claude-code#43474), so the
// delivered bootstrap (server/instructions.ts) stays tiny and COMPELS the agent
// to call `onboard`, which returns this text with no truncation. See issue
// iss_ms77rl1m.
//
// Placement contract (keep it honest — no 多重帳簿 / duplication):
//   - Turn-1 essentials → server/instructions.ts (the bootstrap).
//   - How to use ONE specific tool → that tool's `description` in server/tools.ts.
//   - Everything else (general dt working knowledge + behavioral nudges) → here.
// This guide REFERENCES tool names; it does not re-paste their descriptions.

export const ONBOARD_GUIDE = `discussion-tree (dt) — the full operating guide.

dt gives the user a browser mind-map UI with three surfaces — BOARDS (a settled 2-level concern → item tree for structuring a decision), MAPS (a free-form graph for divergent exploration BEFORE a decision), and DIAGRAMS (one Mermaid source on its own page) — plus a cross-session ISSUE tracker. The user works items in parallel; their input reaches you as <channel source="discussion-tree"> messages. Every dt tool carries its own description in the tool list — read the relevant one before you call it; this guide is the connective tissue and the behavioral craft.

SESSION ATTACHMENT:
The MCP server attaches itself to your CC session automatically at startup (via a SessionStart hook hint + retries + a heartbeat-driven self-healing loop). You do NOT need to call attach_cc_session preemptively. If the auto-attach can't complete (e.g. a transient broker failure that outlives the retry window), you will receive a channel notification telling you to call attach_cc_session manually with the cc_session_id it gives you. That is the only situation where you should invoke that tool. Recovery happens on its own otherwise — if you see "Self-healed: re-attached to CC session ..." land in the channel, you can briefly mention it and move on (if it happens repeatedly, that's a sign the broker is unstable and worth flagging). Also call set_session_name once near startup so the sidebar shows a human-readable name instead of an opaque id.

THE FLOW:
When the user has multiple discussion items or open decisions to work through in parallel, create a board with create_board. The user gets a URL to the browser UI where they can answer each item independently. Their answers come back to you as channel messages, one per submission.

MESSAGE METADATA (routing an incoming channel message):
Each channel message has meta with one of these kinds. One optional key can appear on any of them: since_last_message (e.g. "3h12m", "2d4h") — how long THIS node had been silent before this message arrived. It is present only when that gap was an hour or more, so its presence at all means the exchange is resuming after a break rather than continuing.
- kind="user_input_relay" — a reply targeting a specific node. meta also has board_id, node_id, node_path, sent_at. Use node_path to immediately know which discussion item the user is responding to (e.g. "Architecture > broker: singleton or session-local"). Reply both in the CLI and via post_to_node on that node.
- kind="board_structure_request" — a free-text instruction to RESTRUCTURE a board (add/edit/remove concerns or items, rename, reorganize). meta has board_id but NO meaningful node_id (it carries a synthetic "__board__"). Interpret the text as structure-change instructions, apply them via add_concern / add_item / update_node / move_node / reorder_node / delete_node, then post a short confirmation summary to the per-board board-log node (see BOARD-LOG NODE). Do NOT try to mirror the request itself into a user content node — the request is already auto-recorded on the log node by the broker.
- kind="map_chat" — a message typed into a MAP (see MAPS). meta has map_id (carried in the board_id field), node_id (a map node id, or "__general__" for the map-wide chat), node_path, sent_at, and message_id. This is the user talking to you ABOUT the map; respond by GROWING THE MAP (add_map_node / connect_map_nodes / update_map_node) and mirror any conversational reply with post_to_map_node on that node.
- kind="diagram_chat" — a message typed into a DIAGRAM's right-side chat (see DIAGRAMS). board_id is the diagram's id; act on it by editing the diagram via upsert_diagram and reply with post_diagram_chat.

BOARD-LOG NODE:
Every non-default board has an auto-created "Board log" concern with a single "Structure changes" item under it, both flagged with is_log=1 in the get_board response. The broker auto-appends the raw user request to this log item whenever a board_structure_request arrives. Your job on receipt: apply the structural changes the user asked for, then post_to_node onto that same log item with a SHORT summary of "what I did" (e.g. "Added concern X, renamed item Y to Z, declined the request to delete W because it's still discussing"). The log item refuses delete / move / reorder; it's permanent per board so the audit trail stays intact.

REPLY BEFORE YOU ACT:
When a relayed message both asks something and implies work — especially when the question itself sets the direction, or is something you could immediately start acting on — answer FIRST (CLI + post_to_node), THEN do the work. The user is waiting on your reply and generally prefers to confirm the direction before you charge ahead; "the answer was X, so I went and did Y" when they were still waiting to weigh in is exactly the failure to avoid. Acting first is only appropriate when the next step is genuinely unambiguous and the user clearly wants momentum over confirmation.

NODE-LOCAL CONTENT (strict):
A post_to_node call addresses ONE node only. Stay rigorously inside that node's scope:
  - Do NOT mention the status, decision, or proposal for any OTHER node — even as an aside ("by the way, for node X I think we should…").
  - When you want to put forward proposals on multiple nodes at once, make multiple post_to_node calls (one per node) — never bundle them into a single post on whichever node happens to be open.
  - Cross-node summaries belong in a designated "decision" / "final" node, not in topic-specific threads.
  - Use plain user-facing language (the user's language — match what they're writing in), referring to nodes by their human-readable title or purpose rather than internal IDs.

BOARD STRUCTURE (concern → item, exactly 2 levels):
A board has TWO layers with DISTINCT jobs (create_board's description states the rule you must never break; this is the surrounding craft). A CONCERN is a category header only — it groups items and has NO reply thread. An ITEM is the actual discussion unit — it has its own thread and is the ONLY valid target for post_to_node. So every question / option / decision you want a reaction to MUST be an item; a concern with no items is a header the user can't answer. The tree is intentionally exactly 2 levels — sub-items are not supported; if a topic wants nesting, split it into a separate concern. Use create_board(structure) to set everything up in one call, add_concern / add_item to extend mid-discussion. Structure example:
{
  "title": "API design review",
  "concerns": [
    {
      "id": "auth",
      "title": "Authentication scheme",
      "context": "How clients authenticate. (Scope note only — every decision lives in an item below, never here.)",
      "items": [
        { "id": "auth-mech", "title": "JWT vs session", "context": "Trade-offs, and my recommendation, go here." },
        { "id": "auth-jwt", "title": "JWT expiry duration", "context": "..." },
        { "id": "auth-refresh", "title": "Refresh-token storage" }
      ]
    },
    { "id": "errors", "title": "Error design", "items": [] }
  ]
}

COHESION GRANULARITY (1 board = 1 actionable feature / decision):
A board is the single settle-able unit: when ALL its concerns and items settle, one piece of downstream work can proceed. So do NOT mix topics that can settle independently into one board — if Topic A and Topic B can each settle on their own and either can be implemented without waiting for the other, they belong in separate boards. Multiple concerns in one board are appropriate only when they are sub-axes that ALL need to settle together (e.g. "frontend FW" + "backend FW" + "deployment target" all needed before coding can start). If a concern feels independently actionable from the others, split it into its own board.

NODE GRANULARITY (one node = one thing to evaluate):
Each node should represent ONE decision / answer / option the user can comment on INDEPENDENTLY. When you have alternatives to weigh (A vs B vs C), do NOT bundle them into a single node titled "A or B or C — pick one". Create ONE node PER alternative under a shared concern, so the user can comment on each and you can record per-option pros/cons. Add a separate "decision" / "final" node where the chosen alternative is recorded.

NODE / CONCERN TITLE FORMATTING:
Board readability depends heavily on title consistency. When you add nodes to the SAME board:
  - Keep titles SHORT — aim for under 40 characters; never exceed 60. Long detail belongs in 'context', not 'title'.
  - Do NOT repeat context the board or concern already provides. If the board scopes one subsystem and the concern scopes one feature, child items shouldn't restate the subsystem name — drop those prefixes.
  - Pick ONE grammatical pattern per board and stick to it. Mixing forms ("X policy" / "X not set" / "X check" / "how to handle X" / "whether to do X") inside one board reads as random. Choose a single form up front, e.g. decision items → noun phrase ("X policy", "X selection"); confirmation items → noun phrase ("X check", "X smoke test"); open questions → question form ("how to handle X"). Don't mix patterns within one concern.
  - Match the language to the user's working language (Japanese in a JP session, English in an EN session). Don't switch mid-board.
  - No trailing punctuation.
  - Don't pack two topics into one node. If a title wants "X and Y", it's two nodes.
These apply equally to add_concern, add_item, create_board (every title in the tree), and update_node. When extending a board, look at the current sibling titles FIRST and match their pattern.

BOARD ROLE EXPLANATION:
When sharing a newly-created board URL with the user (in post_to_node or CLI), include a brief role description for each concern, and especially call out any node meant for recording decisions/summaries (e.g. "this 'final' node is where I will accumulate decisions as we discuss"). Don't expect the user to infer node roles from titles alone.

DEFAULT CONVERSATION BOARD:
The broker auto-creates one "default" board per cc_session_id (a Conversation board) with a single fixed node — surfaced in the sidebar with a chat-bubble icon. It is the universal inbox for everything that doesn't belong to a specific option-decision board: short questions, status updates, progress notes, casual back-and-forth. The user might be on a different device (phone via Tailscale) when you reply, so mirroring CLI conversation here gives them a permanent browsable log.
  - Reply normally to user posts on the default board.
  - PROACTIVELY mirror non-board-specific conversation: when CLI talk doesn't belong to a specific decision board, post_to_node a concise copy into the default board so the user can review it later from anywhere.
  - When CLI conversation grows multiple parallel decision points, spin them out into a proper option-decision board via create_board (don't pile decisions into the default board's single node).
  - The default board structure is LOCKED at the broker — add_concern / add_item / delete_node / move_node / reorder_node are rejected for it. Don't try.

BOARD-STATUS ROLLUP FEEDBACK:
When a post_to_node / set_node_status / add_concern / add_item / delete_node call changes the board's auto-rollup status, the tool response includes a "Board <id> status rolled up: <from> → <to>" line. Watch for it: when a board flips to "settled" it means every item on that board has landed on a verdict — proactively tell the user the board is fully settled (and, if appropriate, that the downstream work it was gating can now proceed). A flip back to "discussing" means something re-opened.

CHECKLISTS (settled decisions — and any task / phase / to-do list):
A board or map node can be a checklist node: an ordinary node you flag (mark_checklist_node / mark_map_checklist_node) that then holds a read-only checklist_items array instead of a normal thread. This is the ONLY real checklist mechanism — do NOT hand-build a fake one out of a concern full of checkbox-styled items (that has no per-item status, no read-only protection, and can't be rolled up). Lifecycle: add ONE node → flag it → add each line with record_decision (board) / record_map_decision (map), which starts pending → advance with update_decision / update_map_decision (pending → in-progress → done / dropped; dropped needs a drop_reason). On a board, when a node's decision lands AND a checklist node exists, ALSO record it as a short verifiable acceptance-criterion line so a later reviewer can confirm it was implemented. Track EXECUTION progress AFTER a decision (implemented / verified) with these checklist statuses, NOT with a node's status. The UI is read-only, so keeping the list current is YOUR job — the user cannot tick a box. Full reference: the bundled skill dt-checklist.

MAPS (divergence before a board):
A map is the exploration-phase counterpart to a board — a free-form GENERAL GRAPH for a discussion still flying off in all directions (branches, cross-links, dead-ends, isolated thoughts). You diverge on a map and, once a sub-question is explored enough, GRADUATE it into a board (the convergence / decision phase). Create one with create_map only when the user asks for that kind of free exploration, or when a CLI discussion is clearly diverging — never auto-create.
  - NODES are cards coloured by kind: question | idea | research (YOUR node — where you drop what you looked up; the asymmetry is deliberate) | note | selection (reserved). A "decision" is NOT a node — decisions are what you produce by graduating a map into a board.
  - DIVISION OF LABOUR: YOU build content (nodes, their title+context, edges via connect_map_nodes). The USER owns layout (dragging cards) and association (drawing their own edges). Relations are EXPLICIT edges, never inferred from proximity.
  - PULL MODEL (important): the user's structural edits — dragging a card, drawing/removing an edge, deleting a node — are SILENT; they are NOT pushed over the channel. The broker's map state is the single source of truth: always get_map BEFORE you act on structure rather than trusting memory. Only CHAT (general panel + per-node inputs) reaches you, as map_chat messages.
  - BUILD IN BULK with apply_map_ops (a batch of adds + edges + posts in one call) — firing many separate add_map_node / connect_map_nodes calls in one turn hits the per-turn tool-call cap, silently drops half your adds, and makes you mis-report what you built.
  - EDIT & PRUNE — a map is a LIVING surface, not append-only. As the discussion sharpens, REFINE existing nodes with update_map_node instead of stacking near-duplicates, and delete_map_node when a node is abandoned / superseded / merged / wrong. Agents chronically under-use these; keeping the graph honest is YOUR job.
  - VALUE: the point isn't a finished diagram — it's that the user co-builds the map WITH you through conversation (spatial memory). Prefer growing it a few nodes at a time in response to chat over dumping a huge pre-built graph.
  - A map node can also be a checklist (see CHECKLISTS). To find a map's id use list_maps / search_maps — you never need the browser URL, and a map_chat message already carries the id.

DIAGRAMS (the 3rd surface):
A "diagram" is dt's canonical name for ONE Mermaid source rendered on its own /diagram/:id page (flowchart / sequenceDiagram / classDiagram / stateDiagram / erDiagram / etc.). When the user says "diagram" they mean exactly this surface — use the same word back; do NOT call it a "chart" or "graph". upsert_diagram creates (omit id) or replaces (pass an existing id) the WHOLE source — no partial edits, one Mermaid diagram per source; pass context to set the markdown description shown at the TOP of the page. get_diagram reads it back; list_diagrams / rename_diagram / archive_diagram / delete_diagram manage them. The page has a right-side chat: a diagram_chat channel message means the user typed there — edit the diagram via upsert_diagram (the open page re-renders live) and reply with post_diagram_chat. A diagram chat DOES count toward the unanswered-node nag.

ISSUES (the cross-session tracker):
The issue tracker is the ledger of outstanding work that lives nowhere else — file with create_issue the MOMENT something must not be forgotten (a promise, a follow-up, a defect noticed in passing, deferred work); read with list_issues. State is two axes: owner (who holds the ball) and state (todo / doing / waiting_* / done / dropped) — there is deliberately no "blocked". Each issue also has its OWN conversation thread: post_to_issue says something ABOUT one issue (a blocking question, a finding, a proposal) which the user reads and answers from the tracker without leaving it; its thread lives on an ORDINARY board (one issue, one board) and every message there links to the issue automatically. Replies come back as an ordinary channel message — answer those with post_to_node. Keep issues linked: every posting tool takes issue_ids so one issue's conversation reads as a single timeline across boards; review_message_links + link_message_to_issues (and the bundled skill dt-issue-links) are the pre/post-compaction hygiene for that.

WAITING RULE:
Time-based auto-progression (e.g. "I will proceed in 30 seconds if there is no objection") is FORBIDDEN — heavy or hard-to-reverse changes always require the user's explicit OK ("go" / "OK" / "proceed", or the equivalent in their language) before execution. (Creating a board is NOT heavy — see PROACTIVE BOARD CREATION in create_board's description; don't let this rule bleed into board creation.)

MESSAGE FORMATTING — MARKDOWN RENDERS IN THE UI:
Everything you post to a node / map chat / board thread is rendered as GitHub-Flavored Markdown (react-markdown + remark-gfm). You never see the rendered result, so it's easy to under-use formatting out of uncertainty about whether it will show — but it all renders correctly: **bold**, \`inline code\`, fenced code blocks (with a language hint), bullet / numbered lists, headings, links, blockquotes, and tables (\`| col | col |\` over a \`|---|---|\` separator row). Use whatever genuinely makes the content clearest. (Bold whose content is wrapped in Japanese brackets — \`**「…」**\` — is auto-rescued, so it's safe too.)
  ONE DELIBERATE DEVIATION — dt keeps exactly one spelling for each of bold and italic, because the discarded spellings collide with the code tokens these threads are full of. **Bold is \`**…**\` and italic is \`_…_\`.** A lone \`*\` and a doubled \`__\` are rendered LITERALLY, so a glob (a config-dir wildcard, a build glob) and a dunder (\`__init__.py\`, \`src/__tests__/\`) survive verbatim instead of being eaten as emphasis delimiters and shown to the user as a path that doesn't exist. Same reasoning as \`~\` (a bare \`~/path\` never strikes through). So: write \`**bold**\`, and \`_italic_\` if you truly need italic — \`*this*\` will show its asterisks. Paths and globs need no escaping; just write them (backticks still recommended for readability).

DON'T append a trailing "Status / Pending" line at the end of every post — that footer pattern was useful when statuses were limited but is now redundant given the rich status enum. Express where a node stands via its status field (set_node_status, or the status arg of post_to_node) and, for transient waits, via set_activity.

YOU CAN SEND IMAGES, not just receive them — and you almost certainly send too few. THE TRIGGER IS BEHAVIOURAL, not technical: the moment you catch yourself about to describe a SHAPE in prose — a before/after, a route or topology, a measured timeline, a branching procedure, relative magnitudes, a UI/icon mockup, a screenshot of what you built — stop and draw it instead. A markdown image \`![alt](/uploads/<board_id>/<file>.png)\` renders inline in the thread exactly like a user's pasted image, at whatever point in your text you place it, so the figure sits right where the argument needs it. The user reviews a visual far faster than a paragraph describing one. Do NOT draw when the point fits in one sentence or a markdown table already says it, and never let the picture carry the conclusion alone — write the takeaway in text too. FULL PROCEDURE — how to GENERATE the figure (matplotlib via \`uv run --with matplotlib\`, including the CJK font setting without which Japanese labels render as tofu), and when to use the mermaid diagram surface instead: the bundled skill dt-visual-reply. Short version: dt already serves \`~/.discussion-tree/uploads/<board_id>/\` on the web at \`/uploads/<board_id>/…\`, so you do NOT upload and you do NOT base64 anything — you write the PNG into that folder and link it. The file being in the folder IS the publish step.
  1. Copy your finished image into \`\${DISCUSSION_TREE_HOME:-~/.discussion-tree}/uploads/<board_id>/agent_<unique>.png\` (\`mkdir -p\` the dir first; <board_id> = the board / map / diagram id you're posting to; unique filename via timestamp + \$RANDOM so you never clobber; \`agent_\` prefix marks it as yours).
  2. Embed that URL where it belongs in the post body: post_to_node(..., message: "...prose...\\n\\n![comparison](/uploads/<board_id>/agent_<unique>.png)"). Same for post_to_map_node / post_diagram_chat.
  e.g. (shell): \`DIR="\${DISCUSSION_TREE_HOME:-\$HOME/.discussion-tree}/uploads/<id>"; mkdir -p "\$DIR"; N="agent_\$(date +%s)_\$RANDOM.png"; cp fig.png "\$DIR/\$N"; echo "/uploads/<id>/\$N"\` → embed that path. (Off-box fallback only: POST base64 to /upload-image {board_id, filename, data_base64} → use the returned url.)

NON-ASCII STRINGS — RAW UTF-8 ONLY:
When passing non-ASCII text (Japanese, Chinese, Korean, …) into MCP tool args (create_board.structure, add_concern, add_item, update_node, post_to_node, etc.), always write the characters as raw UTF-8. Do NOT use \\uXXXX escape sequences — past attempts produced wrong code points and shipped typos to the UI. Both encodings are valid JSON; the discipline is on the LLM side. Exception: only when raw is genuinely impossible (control chars, ZWJ, etc.).

PAST DISCUSSIONS ARE QUERYABLE:
Boards aren't write-only logs — they're a persistent record this session and its siblings can READ. When the user references something from a previous discussion ("what did we decide about X?", "the board where we settled on Y"), use list_boards / search_boards to find it and get_board to pull the actual content back into context. Don't ask the user to re-explain history that's already on a board. Typical recall: search_boards("auth scheme") → pick the best board_id → get_board(board_id, node_ids=[matched_node]).

UNANSWERED NODES (per-node reply tracking):
The broker tracks which UI submissions you have NOT replied to yet — the "unanswered set", spanning all three surfaces. The tool that CLEARS an entry differs per surface: a board node → post_to_node; a map's per-node thread → post_to_map_node; a diagram chat → post_diagram_chat. (A map's general chat "__general__" is deliberately NOT tracked — there you answer by growing the graph.) In every case only a NON-EMPTY message clears it: a status-only post does NOT, and neither do set_node_status / record_decision / other tools. When your turn ends, a Stop hook NAMES anything still in the set (and the tool to reply with), catching the case where you answered only in the CLI and forgot to mirror. Replying on a DIFFERENT node than the user asked on is legitimate — but the original node stays flagged, so if that was deliberate (handled elsewhere, or the user doesn't want a reply) call reset_unanswered_posts to clear the whole set and yield.

FRICTION REPORTING:
If you find yourself wanting to express something the current tools/UI don't support — a kind of node, a workflow, a metadata field, a rendering that would help — call request_improvement with concrete details. Only log when you actually couldn't express something you needed; do not speculate or wishlist.`;
