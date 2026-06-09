// MCP tool definitions and the call-tool dispatcher.
//
// Each tool is a thin wrapper that:
//   1. Validates session is registered (ensureSession).
//   2. Forwards args to a broker HTTP endpoint via brokerFetch.
//   3. Wraps the response into the MCP textResult shape Claude Code expects.
//
// Definitions and handlers live in the same file because they're 1:1
// coupled — the schema describes what the args look like, and the handler
// just unpacks them and POSTs to the broker.

import type { CreateBoardResponse } from "../shared/types.ts";
import { brokerFetch } from "./broker-client.ts";
import { ensureSession } from "./state.ts";

export const TOOLS = [
  {
    name: "create_board",
    description:
      "Create a discussion board with concerns and items as a JSON tree. Returns the URL to share with the user. TITLE STYLE: short titles (<40 chars), one consistent grammar across siblings, no redundant board/concern prefix on child items — see NODE / CONCERN TITLE FORMATTING in the server instructions.",
    inputSchema: {
      type: "object" as const,
      properties: {
        structure: {
          type: "object" as const,
          description:
            "Board structure with top-level title and concerns array. Each concern can have items, each item can have nested items.",
          properties: {
            title: {
              type: "string" as const,
              description: "Board title (overall topic of discussion)",
            },
            concerns: {
              type: "array" as const,
              description: "Top-level concern nodes (discussion topics)",
              items: {
                type: "object" as const,
                properties: {
                  id: { type: "string" as const, description: "Optional stable ID" },
                  title: { type: "string" as const },
                  context: { type: "string" as const, description: "Optional context/background" },
                  items: {
                    type: "array" as const,
                    description: "Discussion items hanging below this concern",
                  },
                },
                required: ["title"],
              },
            },
          },
          required: ["title", "concerns"],
        },
      },
      required: ["structure"],
    },
  },
  {
    name: "add_concern",
    description:
      "Add a top-level concern (a discussion topic) to an existing board, optionally with items. NOTE: the default conversation board (the auto-created 'Conversation' board, one per cc_session_id) has a FIXED structure of one concern + one item; add_concern / add_item / move_node / reorder_node / delete_node all REJECT it. If a user message on the default board needs structured option-evaluation, create_board a NEW board for it instead of trying to grow the default board. TITLE STYLE: short (<40 chars), no redundant board/concern prefix, match sibling grammar — see NODE / CONCERN TITLE FORMATTING in the server instructions.",
    inputSchema: {
      type: "object" as const,
      properties: {
        board_id: { type: "string" as const },
        concern: {
          type: "object" as const,
          properties: {
            id: { type: "string" as const },
            title: { type: "string" as const },
            context: { type: "string" as const },
            items: { type: "array" as const },
          },
          required: ["title"],
        },
      },
      required: ["board_id", "concern"],
    },
  },
  {
    name: "add_item",
    description:
      "Add a discussion item under a concern. Boards are intentionally 2-level (concern → items) — sub-items are not supported. If a topic feels like it needs a sub-item, either split it into its own concern or restructure with update_node / move_node. NOTE: the default conversation board has a FIXED structure of one concern + one item; add_item rejects it (along with add_concern / move_node / reorder_node / delete_node). For structured option-evaluation derived from a default-board conversation, create_board a NEW board instead of growing the default board. TITLE STYLE: short (<40 chars), drop board/concern prefix, match sibling grammar — see NODE / CONCERN TITLE FORMATTING in the server instructions.",
    inputSchema: {
      type: "object" as const,
      properties: {
        board_id: { type: "string" as const },
        concern_id: {
          type: "string" as const,
          description: "ID of the parent concern.",
        },
        item: {
          type: "object" as const,
          properties: {
            id: { type: "string" as const },
            title: { type: "string" as const },
            context: { type: "string" as const },
          },
          required: ["title"],
        },
      },
      required: ["board_id", "concern_id", "item"],
    },
  },
  {
    name: "post_to_node",
    description:
      "Post your reply to a node's UI thread AND set the node's status in one call. The status parameter is REQUIRED — it represents where this node stands AFTER your post, forcing you to make the status decision explicit each time you respond. Use 'discussing' for ongoing back-and-forth without a decision yet; 'adopted' / 'rejected' / 'agreed' / 'resolved' to mark a decision; 'needs-reply' to flag for user attention. The broker inserts the message first, then logs the status transition (if changed), so the timeline reads naturally: message → status change.",
    inputSchema: {
      type: "object" as const,
      properties: {
        board_id: { type: "string" as const },
        node_id: { type: "string" as const },
        message: { type: "string" as const },
        status: {
          type: "string" as const,
          enum: [
            "pending",
            "discussing",
            "resolved",
            "agreed",
            "adopted",
            "rejected",
            "needs-reply",
            "done",
          ],
          description:
            "Status the node should be in AFTER this post. 'discussing' if ongoing without decision; 'adopted'/'rejected'/'agreed'/'resolved' for decisions; 'needs-reply' to flag for user attention.",
        },
      },
      required: ["board_id", "node_id", "message", "status"],
    },
  },
  {
    name: "update_node",
    description:
      "Update title / context / kind of an existing node. Use for typo fixes, evolving descriptions, or converting concern↔item when the structure was misjudged at creation. At least one of title / context / kind must be provided. The UI broadcasts a structure-update so clients refetch. Does NOT modify thread messages or status — for those use post_to_node / set_node_status. TITLE STYLE on rename: check sibling titles and match their grammar — see NODE / CONCERN TITLE FORMATTING in the server instructions.",
    inputSchema: {
      type: "object" as const,
      properties: {
        board_id: { type: "string" as const },
        node_id: { type: "string" as const },
        title: {
          type: "string" as const,
          description: "New title (optional — pass only if changing)",
        },
        context: {
          type: "string" as const,
          description: "New context/description (optional — pass only if changing). Markdown is supported.",
        },
        kind: {
          type: "string" as const,
          enum: ["concern", "item"],
          description: "Convert concern↔item. Optional — only pass if changing the node's kind.",
        },
      },
      required: ["board_id", "node_id"],
    },
  },
  {
    name: "delete_node",
    description:
      "Soft-delete a node (and its descendants) — sets a deleted_at timestamp, hiding the subtree from the UI but preserving thread history. Use when a node became obsolete (e.g. an option was rejected and the user no longer wants to see it) or the structure was misjudged. Conversation in the deleted nodes can still be recovered via SQL by clearing deleted_at. Prefer this over leaving a long-rejected node visible.",
    inputSchema: {
      type: "object" as const,
      properties: {
        board_id: { type: "string" as const },
        node_id: { type: "string" as const },
      },
      required: ["board_id", "node_id"],
    },
  },
  {
    name: "move_node",
    description:
      "Reparent a node within the same board. Pass `new_parent_id` to attach under a different parent, or omit / pass null to make the node a top-level concern. Cycle prevention: cannot move a node under itself or its own descendants. The node keeps its kind / title / status / thread; only its parent_id and position change (it's appended at the end of the new sibling group). Use when the structure was misjudged and a sub-topic actually belongs elsewhere.",
    inputSchema: {
      type: "object" as const,
      properties: {
        board_id: { type: "string" as const },
        node_id: { type: "string" as const },
        new_parent_id: {
          type: ["string", "null"] as any,
          description: "Target parent node id. Pass null or omit to make this node a top-level concern.",
        },
      },
      required: ["board_id", "node_id"],
    },
  },
  {
    name: "reorder_node",
    description:
      "Change a node's order within its current sibling group. `new_position` is 0-based and clamped to the valid range. Use to bring an important option to the front, or to reorder concerns by priority. Only affects siblings under the same parent — for moving across parents use move_node.",
    inputSchema: {
      type: "object" as const,
      properties: {
        board_id: { type: "string" as const },
        node_id: { type: "string" as const },
        new_position: {
          type: "integer" as const,
          minimum: 0,
        },
      },
      required: ["board_id", "node_id", "new_position"],
    },
  },
  {
    name: "set_node_status",
    description:
      "Update a node's status. Status values capture different stages depending on the board's goal (option-decision board / Q&A board / agreement-building / etc): 'pending' (not started), 'discussing' (in progress), 'resolved' (handled, generic done), 'agreed' (consensus reached on this point), 'adopted' (this option was chosen as THE alternative), 'rejected' (this option was NOT chosen / dismissed; node greyed out in UI), 'needs-reply' (user is flagging this for the assistant's attention; vivid border in UI), 'done' (TODO-style completion — useful for feature-tracker boards where each item is a deliverable).",
    inputSchema: {
      type: "object" as const,
      properties: {
        board_id: { type: "string" as const },
        node_id: { type: "string" as const },
        status: {
          type: "string" as const,
          enum: [
            "pending",
            "discussing",
            "resolved",
            "agreed",
            "adopted",
            "rejected",
            "needs-reply",
            "done",
          ],
        },
      },
      required: ["board_id", "node_id", "status"],
    },
  },
  {
    name: "set_session_name",
    description:
      "Set a human-readable name for the current Claude Code session, visible in the UI sidebar so the user can distinguish multiple parallel CC sessions. Call this once near the start of a session, ideally with a short topic name (e.g. discussion-tree development / wyndoc API design / etc). Without this the sidebar shows the session by its broker id, which is opaque.",
    inputSchema: {
      type: "object" as const,
      properties: {
        name: {
          type: "string" as const,
          description:
            "A short human-readable name for this session (1 to 5 words is ideal). Shown next to the list of this session's boards in the sidebar.",
        },
      },
      required: ["name"],
    },
  },
  {
    name: "attach_cc_session",
    description:
      "FALLBACK ONLY — the MCP server normally attaches itself automatically (via SessionStart hook hint + startup retries + heartbeat self-healing). Call this tool ONLY after the server channel-notifies you that automatic attach failed and explicitly asks you to attach manually. Passing the cc_session_id (UUID, visible in the channel notification or your SessionStart hook context) binds the broker session and reclaims boards / pending messages from prior dead MCP sessions with the same cc_session_id.",
    inputSchema: {
      type: "object" as const,
      properties: {
        cc_session_id: {
          type: "string" as const,
          description:
            "Your Claude Code session_id (UUID format, e.g. 6ed58d45-25d4-49d6-a0d3-cacef73bdf44) from the SessionStart hook context",
        },
      },
      required: ["cc_session_id"],
    },
  },
  {
    name: "attach_to_board",
    description:
      "Take over a board's ownership for the current Claude Code session. Use this when a previous CC session created the board and you want this current session to receive the user's submitted answers (channel push). Auto-attach by cwd-match also happens at register time, so you usually don't need to call this explicitly — but you can if the cwd-match heuristic missed.",
    inputSchema: {
      type: "object" as const,
      properties: {
        board_id: { type: "string" as const },
      },
      required: ["board_id"],
    },
  },
  {
    name: "set_board_status",
    description:
      "Set the BOARD-level status. Two of the five values are AUTO-managed by the broker (recomputed from item-node statuses on every mutation) and should not normally be set by hand: 'discussing' (some item nodes still in-progress) and 'settled' (every item node landed in a settled status — adopted / agreed / rejected / resolved / done). The remaining three are EXPLICIT lifecycle decisions the broker leaves alone once set: 'completed' (purpose fulfilled / work done, even if some nodes remain in pending because the work proceeded outside the board), 'withdrawn' (proposal abandoned / no longer pursued), 'paused' (temporarily on hold). Use this tool to declare one of those three; let the broker handle discussing ↔ settled on its own. Legacy value 'active' is accepted and normalized to 'discussing' for backwards compatibility.",
    inputSchema: {
      type: "object" as const,
      properties: {
        board_id: { type: "string" as const },
        status: {
          type: "string" as const,
          enum: [
            "discussing",
            "settled",
            "completed",
            "withdrawn",
            "paused",
            "active",
          ],
        },
      },
      required: ["board_id", "status"],
    },
  },
  {
    name: "close_board",
    description:
      "Mark a board as closed when discussion is complete. Does not delete it.",
    inputSchema: {
      type: "object" as const,
      properties: {
        board_id: { type: "string" as const },
      },
      required: ["board_id"],
    },
  },
  {
    name: "set_activity",
    description:
      "Mark a 'blocked' state — you are waiting on the user's explicit OK before a heavy change. Set BEFORE asking, clear (empty state) right after the OK lands. Generic 'CC is working' badge is auto-emitted by a PreToolUse hook on every tool call, so do NOT use this tool for posting/editing/running/thinking states — only for waits.",
    inputSchema: {
      type: "object" as const,
      properties: {
        state: {
          type: "string" as const,
          description:
            "Activity type. Practically only 'blocked' is intended — waiting on user OK before a heavy change. Omit / pass empty to clear once the wait ends. Generic 'working' state is set automatically by the PreToolUse hook; you do not need to set it here.",
        },
        board_id: {
          type: "string" as const,
          description:
            "Board the activity is bound to. Required when node_id is set.",
        },
        node_id: {
          type: "string" as const,
          description:
            "Node within the board the activity is bound to. When set, the badge appears on that specific node card. When omitted, the badge appears in the global header (for cross-cutting work not tied to a single node).",
        },
        message: {
          type: "string" as const,
          description:
            "Brief human-readable description of what you are doing, e.g., 'editing frontend.tsx', 'awaiting OK before broker restart'. Shown next to the blink.",
        },
      },
      required: [],
    },
  },
  {
    name: "list_boards",
    description:
      "List boards visible to this Claude Code session. Use this when the user references a past discussion ('what did we decide about X?', 'check the previous board') or when you need to recall an earlier decision without re-asking. Returns a lightweight summary per board (id, title, status, concern/item counts, last activity, owning session name) — NOT the full thread; follow up with get_board to load the actual content of a specific board. Default scope is this_session (only boards owned by your own CC session); pass scope='all' to also see boards owned by OTHER alive CC sessions on this machine — useful when collaborating across parallel CC sessions, but more expensive in context.",
    inputSchema: {
      type: "object" as const,
      properties: {
        scope: {
          type: "string" as const,
          enum: ["this_session", "all"],
          description:
            "Default 'this_session'. Use 'all' to include alive sibling sessions.",
        },
      },
    },
  },
  {
    name: "get_board",
    description:
      "Load a single board's full structure (concerns + items) and recent thread for each node. Use this AFTER list_boards or search_boards to pull a specific past discussion back into context. By default each node's thread is truncated to the most recent 20 items (older content tends to be summarized in later posts anyway, and full threads can be huge). Pass max_items_per_node=-1 to retrieve everything, or node_ids=['x','y'] to scope the read to specific nodes (cheapest option when you only care about one decision's history). thread_truncated[node_id] in the response tells you the FULL count when truncation happened, so you can decide whether to re-load with -1.",
    inputSchema: {
      type: "object" as const,
      properties: {
        board_id: { type: "string" as const },
        max_items_per_node: {
          type: "number" as const,
          description:
            "Default 20 (most recent items per node). Pass -1 for no limit.",
        },
        node_ids: {
          type: "array" as const,
          items: { type: "string" as const },
          description:
            "Restrict the thread payload to these nodes only (the structure list still includes every node). Useful when only one decision is relevant.",
        },
      },
      required: ["board_id"],
    },
  },
  {
    name: "search_boards",
    description:
      "Full-text-style search across boards visible to this Claude Code session. Matches board titles, node titles + context (markdown), and thread message bodies. Returns up to ~25 matches with snippets and the location (board_id / node_id / thread_item_id). Use this when the user asks about a past discussion but you don't know which board it lives on, or when looking for any past mention of a topic. Default scope is this_session; pass scope='all' to include sibling sessions' boards.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: { type: "string" as const },
        scope: {
          type: "string" as const,
          enum: ["this_session", "all"],
        },
        limit: {
          type: "number" as const,
          description: "Max matches (default 25, capped at 100).",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "reset_unanswered_posts",
    description:
      "Force the unanswered-user-post counter for THIS session to zero. post_to_node already zeroes the counter every time it's called (bundled-reply pattern: one CC post covers every outstanding submission so far), so you rarely need this — it's an escape hatch for cases where you want to yield without posting at all (e.g. the user explicitly told you not to mirror this turn). No arguments — it always targets the current session.",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "report_bg_task_done",
    description:
      "Optional fast-path to clear a background Bash task's BG marker immediately rather than waiting for the Stop hook (which auto-clears completed tasks from the transcript at every turn end). When you see a `<task-notification>` with `<status>completed</status>`, pass its `<tool-use-id>` (the `toolu_…` value — NOT the short `<task-id>`). The broker registered each BG task under that tool_use_id, so the short task-id will not match. Bundling several ids in one call is fine. Forgetting is no longer fatal — the Stop hook is the safety net.",
    inputSchema: {
      type: "object" as const,
      properties: {
        task_ids: {
          type: "array" as const,
          items: { type: "string" as const },
          description:
            "The `<tool-use-id>` (toolu_…) values from completed `<task-notification>` blocks — NOT the short `<task-id>`. Pass them as-is; the broker matches by exact string against the tool_use_id it registered.",
        },
      },
      required: ["task_ids"],
    },
  },
  {
    name: "clear_bg_tasks",
    description:
      "Reset the background-task counter for your session to zero. Use this as a fallback when the BG marker in the UI shows a stale count — e.g. you missed some `<task-notification status=\"completed\">` messages so report_bg_task_done never cleared them, but you are now confident none of your background Bash tasks are still running. Unlike report_bg_task_done (which clears specific task-ids), this clears ALL of them at once. The user can also clear it themselves by clicking the BG marker chip in the UI.",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "request_improvement",
    description:
      "Submit a concrete friction point about discussion-tree-mcp itself to the user's review queue (REQUESTS.md). Use this when you wanted to express something the current tools/UI did not support — a missing node kind, an unsupported workflow, a rendering gap. The user reviews accumulated requests and decides which to implement. Be specific about the actual situation; do not speculate.",
    inputSchema: {
      type: "object" as const,
      properties: {
        title: {
          type: "string" as const,
          description: "Short summary of the friction (under ~80 chars)",
        },
        blocker: {
          type: "string" as const,
          description:
            "Concrete situation: what you were trying to do for the user, and what the current API/UI did not let you express",
        },
        suggested_change: {
          type: "string" as const,
          description: "Optional: what change would unblock you?",
        },
        board_id: {
          type: "string" as const,
          description: "Optional: board ID where the friction was encountered",
        },
      },
      required: ["title", "blocker"],
    },
  },
  {
    name: "record_decision",
    description:
      "Append a decision to a decision-checklist node as a new checklist item (status=pending). Use this whenever a node settles to a verdict (adopted / agreed / resolved / rejected): capture the decision as a short, verifiable acceptance-criterion-style line (\"X であること。背景: …\") so the board accumulates an implementation checklist for later verification. The target node_id MUST be a node already flagged as a checklist node (is_checklist=1) — checklist nodes are NOT auto-created. Cite where the decision was made via `sources` (preferred): an array of lowest-level pointers, each {kind, id} where kind is board | node | message. A message id is a thread_items.id — get one from post_to_node's returned message_id (your own post) or a received channel message's meta.message_id (a human reply). For a node ref, board is optional — it is auto-resolved when the node id is unique across all boards, and only required (board:\"bd_…\") when that id exists on more than one board. (source_node_id is the legacy single-node shorthand, still accepted.)",
    inputSchema: {
      type: "object" as const,
      properties: {
        board_id: {
          type: "string" as const,
          description: "Board that contains the checklist node.",
        },
        node_id: {
          type: "string" as const,
          description: "The is_checklist node to append the decision to.",
        },
        summary: {
          type: "string" as const,
          description:
            "The decision as a verifiable acceptance-criterion line (2-3 sentences: what to check + why).",
        },
        sources: {
          type: "array" as const,
          description:
            "Where this decision was made: lowest-level references only. Each item is {kind, id} with kind = board | node | message (board=boards.id, node=nodes.id, message=thread_items.id). For node refs, board is optional (auto-resolved when the id is unique across boards; required only on collision).",
          items: {
            type: "object" as const,
            properties: {
              kind: { type: "string" as const },
              id: { type: "string" as const },
              board: { type: "string" as const },
            },
            required: ["kind", "id"],
          },
        },
        source_node_id: {
          type: "string" as const,
          description:
            "Legacy shorthand for sources=[{kind:'node', id}] — the node where this decision was made.",
        },
      },
      required: ["board_id", "node_id", "summary"],
    },
  },
  {
    name: "update_decision",
    description:
      "Update a checklist item: change its status, edit the summary, and/or set a drop reason. status is one of pending / in-progress / done / dropped. status=dropped REQUIRES a non-empty drop_reason (the broker rejects the call otherwise); moving off dropped clears the reason. The checklist UI is read-only, so this tool is the only way to change an item.",
    inputSchema: {
      type: "object" as const,
      properties: {
        item_id: {
          type: "number" as const,
          description: "The checklist item id to update.",
        },
        status: {
          type: "string" as const,
          description: "New status: pending | in-progress | done | dropped.",
        },
        summary: {
          type: "string" as const,
          description: "Optional: replacement summary text.",
        },
        drop_reason: {
          type: "string" as const,
          description:
            "Required when status=dropped: why the decision was abandoned.",
        },
      },
      required: ["item_id"],
    },
  },
  {
    name: "mark_checklist_node",
    description:
      "Flag an existing node as a decision-checklist node (is_checklist=1) so record_decision can append items to it. Checklist nodes are ordinary nodes (created with add_item) that you deliberately turn into a checklist — they are NEVER auto-created. Place the checklist node leftmost under its concern by convention. Pass is_checklist=false to turn it back into a normal node.",
    inputSchema: {
      type: "object" as const,
      properties: {
        board_id: {
          type: "string" as const,
          description: "Board containing the node.",
        },
        node_id: {
          type: "string" as const,
          description: "The node to flag as a checklist node.",
        },
        is_checklist: {
          type: "boolean" as const,
          description: "Default true. Pass false to unflag.",
        },
      },
      required: ["board_id", "node_id"],
    },
  },

  // --- Maps (divergent-discussion mind-map) ---
  // A map is the DIVERGENCE-phase surface that precedes a board (the
  // convergence / decision phase). It's a general graph: nodes connect
  // 1-to-many / many-to-many or stay isolated, and relations are explicit
  // edges. YOU build the content (create nodes with title + context, draw
  // edges); the HUMAN owns layout (drag) + association (drawing edges) in the
  // UI. Their drags / edge-draws are SILENT (pull model) — re-read with
  // get_map before you act on structure. Only chat (general + per-node)
  // arrives over the channel (kind=map_chat).
  {
    name: "create_map",
    description:
      "Create a divergent-discussion MAP — a free-form graph for the exploration phase BEFORE a decision is structured into a board. Use when the user wants to think out loud across branching, not-yet-settled topics (the user usually asks; you can also offer one when a discussion is clearly diverging). Returns a URL. Maps are NOT auto-created. You grow the map by adding nodes / edges; the user arranges layout and draws links in the UI.",
    inputSchema: {
      type: "object" as const,
      properties: {
        title: { type: "string" as const, description: "Short map title." },
        nodes: {
          type: "array" as const,
          description:
            "Optional seed nodes. Each: { title, context?, kind?, parent? } — parent is another seed node's id to auto-draw a branch.",
          items: {
            type: "object" as const,
            properties: {
              id: { type: "string" as const },
              title: { type: "string" as const },
              context: { type: "string" as const },
              kind: {
                type: "string" as const,
                enum: ["question", "idea", "research", "note", "selection"],
              },
              parent: { type: "string" as const },
            },
          },
        },
      },
      required: ["title"],
    },
  },
  {
    name: "apply_map_ops",
    description:
      "Apply a BATCH of map mutations in ONE call — add / update / connect / delete / disconnect / post. Use this (not many separate add_map_node / connect_map_nodes calls) whenever you grow a map by more than a node or two: it sidesteps the per-turn tool-call limit (which otherwise silently drops half your adds and leaves you mis-reporting success), and returns a per-op result so you can SEE exactly what applied. Ops run in array order, so an 'add' with an explicit `id` can be referenced by a later 'connect'/'post' in the SAME batch.",
    inputSchema: {
      type: "object" as const,
      properties: {
        map_id: { type: "string" as const },
        ops: {
          type: "array" as const,
          description: "Ordered list of operations to apply atomically-ish.",
          items: {
            type: "object" as const,
            properties: {
              op: {
                type: "string" as const,
                enum: [
                  "add",
                  "update",
                  "connect",
                  "delete",
                  "disconnect",
                  "post",
                ],
              },
              id: {
                type: "string" as const,
                description:
                  "add: optional explicit node id so a later connect/post in this batch can reference it.",
              },
              node_id: {
                type: "string" as const,
                description: "update / delete / post target node id.",
              },
              title: { type: "string" as const },
              context: { type: "string" as const },
              kind: {
                type: "string" as const,
                enum: ["question", "idea", "research", "note", "selection"],
              },
              parent: {
                type: "string" as const,
                description:
                  "add: existing node id → also draws parent→new edge and places the card beside it.",
              },
              from_id: { type: "string" as const, description: "connect" },
              to_id: { type: "string" as const, description: "connect" },
              edge_id: { type: "string" as const, description: "disconnect" },
              message: { type: "string" as const, description: "post" },
            },
            required: ["op"],
          },
        },
      },
      required: ["map_id", "ops"],
    },
  },
  {
    name: "add_map_node",
    description:
      "Add one node to a map. The node renders as a card (title = headline, context = markdown body) coloured by kind. kind: question (an open question) | idea (a proposal) | research (YOUR findings — the AI node) | note (neutral) | selection (reserved). Pass parent = an existing node id to BOTH place the new node beside it AND draw an edge from parent → new (build a branch in one call). You never supply coordinates — the broker places the card and the user drags it where they like (the position is then remembered).",
    inputSchema: {
      type: "object" as const,
      properties: {
        map_id: { type: "string" as const },
        title: { type: "string" as const, description: "Short headline." },
        context: {
          type: "string" as const,
          description: "Markdown body (the detail). Optional.",
        },
        kind: {
          type: "string" as const,
          enum: ["question", "idea", "research", "note", "selection"],
        },
        parent: {
          type: "string" as const,
          description:
            "Optional existing node id — draws an edge parent → new and places the card next to it.",
        },
      },
      required: ["map_id", "title"],
    },
  },
  {
    name: "update_map_node",
    description:
      "Edit a map node's title / context / kind. Position and size are owned by the user (set in the UI), so they're not editable here.",
    inputSchema: {
      type: "object" as const,
      properties: {
        map_id: { type: "string" as const },
        node_id: { type: "string" as const },
        title: { type: "string" as const },
        context: { type: "string" as const },
        kind: {
          type: "string" as const,
          enum: ["question", "idea", "research", "note", "selection"],
        },
      },
      required: ["map_id", "node_id"],
    },
  },
  {
    name: "delete_map_node",
    description:
      "Logically delete a map node (it disappears from the canvas; its messages + touching edges are kept in the DB so nothing dangles). Use when a branch is abandoned.",
    inputSchema: {
      type: "object" as const,
      properties: {
        map_id: { type: "string" as const },
        node_id: { type: "string" as const },
      },
      required: ["map_id", "node_id"],
    },
  },
  {
    name: "connect_map_nodes",
    description:
      "Draw a directed edge from_id → to_id (explicit relation). The map is a general graph: a node can have many parents and many children, or none. Duplicate edges are ignored.",
    inputSchema: {
      type: "object" as const,
      properties: {
        map_id: { type: "string" as const },
        from_id: { type: "string" as const },
        to_id: { type: "string" as const },
      },
      required: ["map_id", "from_id", "to_id"],
    },
  },
  {
    name: "disconnect_map_nodes",
    description:
      "Remove an edge by its edge_id (logical delete). Get edge ids from get_map.",
    inputSchema: {
      type: "object" as const,
      properties: {
        map_id: { type: "string" as const },
        edge_id: { type: "string" as const },
      },
      required: ["map_id", "edge_id"],
    },
  },
  {
    name: "post_to_map_node",
    description:
      "Post YOUR reply into a map node's thread (or the map-wide general chat). Mirror your CLI reply here so it shows on the card, exactly like post_to_node mirrors onto a board node. Omit node_id (or pass \"__general__\") to post into the general chat panel. Returns message_id.",
    inputSchema: {
      type: "object" as const,
      properties: {
        map_id: { type: "string" as const },
        node_id: {
          type: "string" as const,
          description:
            'Map node id, or "__general__" / omit for the map-wide chat.',
        },
        message: { type: "string" as const },
      },
      required: ["map_id", "message"],
    },
  },
  {
    name: "get_map",
    description:
      "Load a map's full state: nodes (with positions + kind), edges, and every node's thread. ALWAYS call this before acting on map structure — the user may have dragged / connected / deleted things since you last looked (their structural edits are silent by design).",
    inputSchema: {
      type: "object" as const,
      properties: { map_id: { type: "string" as const } },
      required: ["map_id"],
    },
  },
  {
    name: "list_maps",
    description:
      "List divergent-discussion maps. Default scope is this_session (only maps owned by your own CC session); pass scope='all' to also see maps owned by OTHER alive CC sessions on this machine — useful for handover / cross-session work, since any map is operable from any session given its map_id. Returns id, title, node_count, owning session_id + name, and a shareable url.",
    inputSchema: {
      type: "object" as const,
      properties: {
        scope: {
          type: "string" as const,
          enum: ["this_session", "all"],
          description:
            "this_session (default) = only your maps; all = include sibling sessions' maps.",
        },
      },
    },
  },
  {
    name: "search_maps",
    description:
      "Search this session's maps by substring across map titles, node titles/contexts, and message bodies. Use to recall an earlier exploration.",
    inputSchema: {
      type: "object" as const,
      properties: { query: { type: "string" as const } },
      required: ["query"],
    },
  },
  {
    name: "claim_map",
    description:
      "Take ownership of a map for THIS session (handover). After list_maps(scope='all') finds a map a dead/previous session owned, claim it so the user's map-chat messages route to you and you can keep growing it. Idempotent; only needs the map_id.",
    inputSchema: {
      type: "object" as const,
      properties: { map_id: { type: "string" as const } },
      required: ["map_id"],
    },
  },
];

function textResult(text: string, isError = false) {
  return {
    content: [{ type: "text" as const, text }],
    ...(isError ? { isError: true } : {}),
  };
}

// Broker handlers that mutate node status / structure return this when the
// board's discussing/settled auto-rollup actually moved as a result.
type BoardStatusChangeResponse = {
  board_status_changed?: { from: string; to: string };
};

// Render a board-status transition as a suffix appended to the tool's text
// result, so the LLM (which otherwise only learns of rollup changes via the
// UI-only WebSocket) can tell the user the board just settled / re-opened.
function boardStatusChangeNote(
  boardId: string,
  res: BoardStatusChangeResponse | null | undefined,
): string {
  const c = res?.board_status_changed;
  if (!c) return "";
  const detail =
    c.to === "settled"
      ? " — every item on this board has now landed on a settled status (adopted / agreed / rejected / resolved / done)."
      : c.to === "discussing"
        ? " — at least one item is back in progress."
        : "";
  return `\n\nBoard ${boardId} status rolled up: ${c.from} → ${c.to}${detail}`;
}

// Returns a value compatible with the CallToolRequestSchema response shape.
export async function dispatchToolCall(
  name: string,
  args: any,
): Promise<ReturnType<typeof textResult>> {
  try {
    switch (name) {
      case "create_board": {
        const sessionId = ensureSession();
        const a = args as { structure: any };
        const res = await brokerFetch<CreateBoardResponse | { error: string }>(
          "/create-board",
          { session_id: sessionId, structure: a.structure },
        );
        if ("error" in res) return textResult(res.error, true);
        return textResult(
          `Board created: ${res.board_id}\nURL: ${res.url}\n\nShare the URL with the user. They can answer each node individually; their answers arrive here as <channel source="discussion-tree"> messages.`,
        );
      }

      case "add_concern": {
        const sessionId = ensureSession();
        const a = args as { board_id: string; concern: any };
        const res = await brokerFetch<
          {
            ok?: boolean;
            error?: string;
            node_id?: string;
          } & BoardStatusChangeResponse
        >("/add-concern", {
          session_id: sessionId,
          board_id: a.board_id,
          concern: a.concern,
        });
        if (res && res.ok === false) {
          return textResult(res.error ?? "add_concern failed", true);
        }
        return textResult(
          `Concern added: ${res.node_id}` +
            boardStatusChangeNote(a.board_id, res),
        );
      }

      case "add_item": {
        const sessionId = ensureSession();
        const a = args as {
          board_id: string;
          concern_id: string;
          item: any;
        };
        // Defensive client-side guard: the broker also rejects sub-items, but
        // surfacing this earlier gives the LLM a clearer error.
        if (a.item && Array.isArray((a.item as any).items)) {
          return textResult(
            "Sub-items are not supported — pass only top-level items under a concern.",
            true,
          );
        }
        const res = await brokerFetch<
          {
            ok?: boolean;
            error?: string;
            node_id?: string;
          } & BoardStatusChangeResponse
        >("/add-item", {
          session_id: sessionId,
          board_id: a.board_id,
          concern_id: a.concern_id,
          item: a.item,
        });
        if (res && res.ok === false) {
          return textResult(res.error ?? "add_item failed", true);
        }
        return textResult(
          `Item added: ${res.node_id}` +
            boardStatusChangeNote(a.board_id, res),
        );
      }

      case "post_to_node": {
        const sessionId = ensureSession();
        const a = args as {
          board_id: string;
          node_id: string;
          message: string;
          status: string;
        };
        const res = await brokerFetch<
          BoardStatusChangeResponse & {
            ok?: boolean;
            error?: string;
            message_id?: number;
          }
        >("/post-to-node", {
          session_id: sessionId,
          board_id: a.board_id,
          node_id: a.node_id,
          message: a.message,
          status: a.status,
        });
        if (res && res.ok === false) {
          return textResult(res.error ?? "post_to_node failed", true);
        }
        // Surface message_id so you can reference this exact post later (e.g.
        // as a checklist source via record_decision sources=[{kind:"message", id}]).
        const idNote =
          res?.message_id != null ? `, message_id=${res.message_id}` : "";
        return textResult(
          `Posted to node ${a.node_id} (board ${a.board_id}, status=${a.status}${idNote})` +
            boardStatusChangeNote(a.board_id, res),
        );
      }

      case "update_node": {
        const sessionId = ensureSession();
        const a = args as {
          board_id: string;
          node_id: string;
          title?: string;
          context?: string;
          kind?: "concern" | "item";
        };
        const res = await brokerFetch<{ ok: boolean; error?: string }>(
          "/update-node",
          {
            session_id: sessionId,
            board_id: a.board_id,
            node_id: a.node_id,
            title: a.title,
            context: a.context,
            kind: a.kind,
          },
        );
        if (!res.ok) return textResult(res.error ?? "Update failed", true);
        const fields = [
          a.title !== undefined ? "title" : null,
          a.context !== undefined ? "context" : null,
          a.kind !== undefined ? "kind" : null,
        ]
          .filter(Boolean)
          .join("/");
        return textResult(`Updated ${fields} of ${a.node_id}`);
      }

      case "delete_node": {
        const sessionId = ensureSession();
        const a = args as { board_id: string; node_id: string };
        const res = await brokerFetch<
          {
            ok: boolean;
            error?: string;
            deleted_count?: number;
          } & BoardStatusChangeResponse
        >("/delete-node", {
          session_id: sessionId,
          board_id: a.board_id,
          node_id: a.node_id,
        });
        if (!res.ok) return textResult(res.error ?? "Delete failed", true);
        return textResult(
          `Soft-deleted node ${a.node_id} (and ${(res.deleted_count ?? 1) - 1} descendant(s)). Thread history preserved.` +
            boardStatusChangeNote(a.board_id, res),
        );
      }

      case "move_node": {
        const sessionId = ensureSession();
        const a = args as {
          board_id: string;
          node_id: string;
          new_parent_id?: string | null;
        };
        const res = await brokerFetch<{ ok: boolean; error?: string }>(
          "/move-node",
          {
            session_id: sessionId,
            board_id: a.board_id,
            node_id: a.node_id,
            new_parent_id: a.new_parent_id ?? null,
          },
        );
        if (!res.ok) return textResult(res.error ?? "Move failed", true);
        return textResult(
          a.new_parent_id
            ? `Moved ${a.node_id} under ${a.new_parent_id}`
            : `Moved ${a.node_id} to top level`,
        );
      }

      case "reorder_node": {
        const sessionId = ensureSession();
        const a = args as {
          board_id: string;
          node_id: string;
          new_position: number;
        };
        const res = await brokerFetch<{
          ok: boolean;
          error?: string;
          position?: number;
        }>("/reorder-node", {
          session_id: sessionId,
          board_id: a.board_id,
          node_id: a.node_id,
          new_position: a.new_position,
        });
        if (!res.ok) return textResult(res.error ?? "Reorder failed", true);
        return textResult(
          `Reordered ${a.node_id} to position ${res.position ?? a.new_position}`,
        );
      }

      case "set_node_status": {
        const sessionId = ensureSession();
        const a = args as {
          board_id: string;
          node_id: string;
          status: string;
        };
        const res = await brokerFetch<
          BoardStatusChangeResponse & { ok?: boolean; error?: string }
        >("/set-node-status", {
          session_id: sessionId,
          board_id: a.board_id,
          node_id: a.node_id,
          status: a.status,
        });
        if (res && res.ok === false) {
          return textResult(res.error ?? "set_node_status failed", true);
        }
        return textResult(
          `Status of ${a.node_id} set to ${a.status}` +
            boardStatusChangeNote(a.board_id, res),
        );
      }

      case "set_session_name": {
        const sessionId = ensureSession();
        const a = args as { name: string };
        await brokerFetch("/set-session-name", {
          session_id: sessionId,
          name: a.name,
        });
        return textResult("Session named: " + a.name);
      }

      case "attach_cc_session": {
        const sessionId = ensureSession();
        const a = args as { cc_session_id: string };
        const res = await brokerFetch<{
          ok: boolean;
          reclaimed: {
            boards: number;
            messages: number;
            orphan_boards?: number;
            orphan_messages?: number;
          };
        }>("/attach-cc-session", {
          session_id: sessionId,
          cc_session_id: a.cc_session_id,
        });
        const r = res.reclaimed;
        const parts = [
          `Attached to CC session ${a.cc_session_id}.`,
          `Reclaimed ${r.boards} board(s) / ${r.messages} message(s) from prior MCP sessions with same cc_session_id.`,
        ];
        if ((r.orphan_boards ?? 0) + (r.orphan_messages ?? 0) > 0) {
          parts.push(
            `Plus reclaimed ${r.orphan_boards} board(s) / ${r.orphan_messages} message(s) from earlier orphan sessions (same cwd, no cc_session_id) — these were likely created before attach_cc_session was called.`,
          );
        }
        return textResult(parts.join(" "));
      }

      case "attach_to_board": {
        const sessionId = ensureSession();
        const a = args as { board_id: string };
        await brokerFetch("/attach-to-board", {
          session_id: sessionId,
          board_id: a.board_id,
        });
        return textResult("Attached to board " + a.board_id);
      }

      case "set_board_status": {
        const sessionId = ensureSession();
        const a = args as { board_id: string; status: string };
        const res = await brokerFetch<{ ok: boolean; error?: string }>(
          "/set-board-status",
          {
            session_id: sessionId,
            board_id: a.board_id,
            status: a.status,
          },
        );
        if (!res.ok) return textResult(res.error ?? "Failed", true);
        return textResult(`Board ${a.board_id} status: ${a.status}`);
      }

      case "close_board": {
        const sessionId = ensureSession();
        const a = args as { board_id: string };
        await brokerFetch("/close-board", {
          session_id: sessionId,
          board_id: a.board_id,
        });
        return textResult(`Board ${a.board_id} closed`);
      }

      case "set_activity": {
        const sessionId = ensureSession();
        const a = args as {
          state?: string;
          board_id?: string;
          node_id?: string;
          message?: string;
        };
        const res = await brokerFetch<{
          ok: boolean;
          cleared?: boolean;
          activity?: any;
        }>("/set-activity", {
          session_id: sessionId,
          state: a.state,
          board_id: a.board_id,
          node_id: a.node_id,
          message: a.message,
        });
        if (res.cleared) return textResult("Activity cleared.");
        return textResult(
          `Activity: ${a.state}${a.message ? ` — ${a.message}` : ""}`,
        );
      }

      case "list_boards": {
        const sessionId = ensureSession();
        const a = args as { scope?: "this_session" | "all" };
        const res = await brokerFetch<{
          ok: boolean;
          boards?: any[];
          error?: string;
        }>("/list-boards", { session_id: sessionId, scope: a.scope });
        if (!res.ok) {
          return textResult(res.error ?? "list_boards failed", true);
        }
        return textResult(JSON.stringify(res.boards, null, 2));
      }

      case "get_board": {
        const a = args as {
          board_id: string;
          max_items_per_node?: number;
          node_ids?: string[];
        };
        const res = await brokerFetch<{
          ok: boolean;
          board?: any;
          nodes?: any[];
          threads?: Record<string, any[]>;
          thread_truncated?: Record<string, number>;
          error?: string;
        }>("/get-board-view", {
          board_id: a.board_id,
          max_items_per_node: a.max_items_per_node,
          node_ids: a.node_ids,
        });
        if (!res.ok) {
          return textResult(res.error ?? "get_board failed", true);
        }
        return textResult(
          JSON.stringify(
            {
              board: res.board,
              nodes: res.nodes,
              threads: res.threads,
              thread_truncated: res.thread_truncated,
            },
            null,
            2,
          ),
        );
      }

      case "search_boards": {
        const sessionId = ensureSession();
        const a = args as {
          query: string;
          scope?: "this_session" | "all";
          limit?: number;
        };
        const res = await brokerFetch<{
          ok: boolean;
          matches?: any[];
          error?: string;
        }>("/search-boards", {
          session_id: sessionId,
          query: a.query,
          scope: a.scope,
          limit: a.limit,
        });
        if (!res.ok) {
          return textResult(res.error ?? "search_boards failed", true);
        }
        return textResult(JSON.stringify(res.matches, null, 2));
      }

      case "reset_unanswered_posts": {
        const sessionId = ensureSession();
        const res = await brokerFetch<{ ok: boolean }>("/reset-unanswered", {
          session_id: sessionId,
        });
        if (!res?.ok) {
          return textResult("reset_unanswered_posts failed", true);
        }
        return textResult("Unanswered-post counter reset to 0");
      }

      case "report_bg_task_done": {
        const sessionId = ensureSession();
        const a = args as { task_ids: string[] };
        const res = await brokerFetch<{
          ok: boolean;
          cleared: number;
          remaining: number;
        }>("/bg-task-done", {
          session_id: sessionId,
          task_ids: a.task_ids,
        });
        if (!res?.ok) {
          return textResult("report_bg_task_done failed", true);
        }
        return textResult(
          `BG tasks cleared: ${res.cleared}; remaining in-flight: ${res.remaining}`,
        );
      }

      case "clear_bg_tasks": {
        const sessionId = ensureSession();
        const res = await brokerFetch<{ ok: boolean; cleared: number }>(
          "/bg-task-clear-session",
          { session_id: sessionId },
        );
        if (!res?.ok) {
          return textResult("clear_bg_tasks failed", true);
        }
        return textResult(
          `BG task counter reset; cleared ${res.cleared} ${
            res.cleared === 1 ? "entry" : "entries"
          }.`,
        );
      }

      case "record_decision": {
        const a = args as {
          board_id: string;
          node_id: string;
          summary: string;
          source_node_id?: string;
          sources?: { kind: string; id: string; board?: string }[];
        };
        const res = await brokerFetch<{
          ok: boolean;
          item_id?: number;
          error?: string;
        }>("/record-decision", {
          board_id: a.board_id,
          node_id: a.node_id,
          summary: a.summary,
          source_node_id: a.source_node_id ?? null,
          sources: a.sources,
        });
        if (!res?.ok) {
          return textResult(
            `record_decision failed: ${res?.error ?? "unknown error"}`,
            true,
          );
        }
        return textResult(
          `Decision recorded as checklist item #${res.item_id} (status=pending).`,
        );
      }

      case "update_decision": {
        const a = args as {
          item_id: number;
          status?: string;
          summary?: string;
          drop_reason?: string;
        };
        const res = await brokerFetch<{ ok: boolean; error?: string }>(
          "/update-decision",
          {
            item_id: a.item_id,
            status: a.status,
            summary: a.summary,
            drop_reason: a.drop_reason,
          },
        );
        if (!res?.ok) {
          return textResult(
            `update_decision failed: ${res?.error ?? "unknown error"}`,
            true,
          );
        }
        return textResult(`Checklist item #${a.item_id} updated.`);
      }

      case "mark_checklist_node": {
        const a = args as {
          board_id: string;
          node_id: string;
          is_checklist?: boolean;
        };
        const res = await brokerFetch<{ ok: boolean; error?: string }>(
          "/set-node-checklist",
          {
            board_id: a.board_id,
            node_id: a.node_id,
            is_checklist: a.is_checklist,
          },
        );
        if (!res?.ok) {
          return textResult(
            `mark_checklist_node failed: ${res?.error ?? "unknown error"}`,
            true,
          );
        }
        return textResult(
          a.is_checklist === false
            ? `Node ${a.node_id} is no longer a checklist node.`
            : `Node ${a.node_id} is now a checklist node; use record_decision to add items.`,
        );
      }

      case "request_improvement": {
        const sessionId = ensureSession();
        const a = args as {
          title: string;
          blocker: string;
          suggested_change?: string;
          board_id?: string;
        };
        const res = await brokerFetch<{ ok: boolean; file: string }>(
          "/log-request",
          {
            session_id: sessionId,
            title: a.title,
            blocker: a.blocker,
            suggested_change: a.suggested_change,
            board_id: a.board_id,
          },
        );
        return textResult(
          `Improvement request logged to ${res.file}\n(User will review and decide whether to implement.)`,
        );
      }

      // --- Maps ---
      case "create_map": {
        const sessionId = ensureSession();
        const a = args as { title: string; nodes?: any[] };
        const res = await brokerFetch<{
          ok: boolean;
          map_id?: string;
          url?: string;
          error?: string;
        }>("/create-map", {
          session_id: sessionId,
          title: a.title,
          nodes: a.nodes,
        });
        if (!res.ok) return textResult(res.error ?? "create_map failed", true);
        return textResult(
          `Map created. map_id = ${res.map_id}\n\nThis map_id is your handle to the map — pass it to every map call (add_map_node, connect_map_nodes, get_map, post_to_map_node). KEEP REFERENCING this exact id for the rest of the conversation. You do NOT need the browser URL for anything; if you ever lose the id, call list_maps to get it back (never read it off a screenshot / address bar).\n\nShareable URL for the user (optional): ${res.url}\n\nGrow the map with add_map_node / connect_map_nodes; the user arranges layout and draws links in the UI (their structural edits are silent — call get_map before acting on structure).`,
        );
      }

      case "apply_map_ops": {
        ensureSession();
        const a = args as { map_id: string; ops: any[] };
        const res = await brokerFetch<{
          ok: boolean;
          applied?: number;
          total?: number;
          results?: any[];
          error?: string;
        }>("/map-apply-ops", a);
        if (!res.ok)
          return textResult(res.error ?? "apply_map_ops failed", true);
        return textResult(
          `Applied ${res.applied}/${res.total} map ops.\n${JSON.stringify(res.results, null, 2)}`,
        );
      }

      case "add_map_node": {
        ensureSession();
        const a = args as {
          map_id: string;
          title: string;
          context?: string;
          kind?: string;
          parent?: string;
        };
        const res = await brokerFetch<{
          ok: boolean;
          node_id?: string;
          error?: string;
        }>("/map-add-node", {
          map_id: a.map_id,
          node: {
            title: a.title,
            context: a.context,
            kind: a.kind,
            parent: a.parent,
          },
        });
        if (!res.ok) return textResult(res.error ?? "add_map_node failed", true);
        return textResult(`Map node added: ${res.node_id}`);
      }

      case "update_map_node": {
        ensureSession();
        const a = args as {
          map_id: string;
          node_id: string;
          title?: string;
          context?: string;
          kind?: string;
        };
        const res = await brokerFetch<{ ok: boolean; error?: string }>(
          "/map-update-node",
          a,
        );
        if (!res.ok)
          return textResult(res.error ?? "update_map_node failed", true);
        return textResult(`Map node ${a.node_id} updated.`);
      }

      case "delete_map_node": {
        ensureSession();
        const a = args as { map_id: string; node_id: string };
        const res = await brokerFetch<{ ok: boolean; error?: string }>(
          "/map-delete-node",
          a,
        );
        if (!res.ok)
          return textResult(res.error ?? "delete_map_node failed", true);
        return textResult(`Map node ${a.node_id} deleted (logical).`);
      }

      case "connect_map_nodes": {
        ensureSession();
        const a = args as { map_id: string; from_id: string; to_id: string };
        const res = await brokerFetch<{
          ok: boolean;
          edge_id?: string;
          existed?: boolean;
          error?: string;
        }>("/map-connect", a);
        if (!res.ok)
          return textResult(res.error ?? "connect_map_nodes failed", true);
        return textResult(
          res.existed
            ? `Edge already existed: ${res.edge_id}`
            : `Edge drawn: ${a.from_id} → ${a.to_id} (${res.edge_id})`,
        );
      }

      case "disconnect_map_nodes": {
        ensureSession();
        const a = args as { map_id: string; edge_id: string };
        const res = await brokerFetch<{ ok: boolean; error?: string }>(
          "/map-disconnect",
          a,
        );
        if (!res.ok)
          return textResult(res.error ?? "disconnect_map_nodes failed", true);
        return textResult(`Edge ${a.edge_id} removed.`);
      }

      case "post_to_map_node": {
        ensureSession();
        const a = args as {
          map_id: string;
          node_id?: string;
          message: string;
        };
        const res = await brokerFetch<{
          ok: boolean;
          message_id?: number;
          error?: string;
        }>("/map-post", a);
        if (!res.ok)
          return textResult(res.error ?? "post_to_map_node failed", true);
        return textResult(
          `Posted to map node ${a.node_id ?? "__general__"} (message_id=${res.message_id}).`,
        );
      }

      case "get_map": {
        ensureSession();
        const a = args as { map_id: string };
        const res = await brokerFetch<{ ok: boolean; error?: string }>(
          "/get-map",
          a,
        );
        if (!res.ok) return textResult(res.error ?? "get_map failed", true);
        return textResult(JSON.stringify(res, null, 2));
      }

      case "list_maps": {
        const sessionId = ensureSession();
        const a = args as { scope?: "this_session" | "all" };
        const res = await brokerFetch<{
          ok: boolean;
          maps?: any[];
          error?: string;
        }>("/list-maps", { session_id: sessionId, scope: a.scope });
        if (!res.ok) return textResult(res.error ?? "list_maps failed", true);
        return textResult(JSON.stringify(res.maps, null, 2));
      }

      case "search_maps": {
        const sessionId = ensureSession();
        const a = args as { query: string };
        const res = await brokerFetch<{
          ok: boolean;
          matches?: any[];
          error?: string;
        }>("/search-maps", { session_id: sessionId, query: a.query });
        if (!res.ok) return textResult(res.error ?? "search_maps failed", true);
        return textResult(JSON.stringify(res.matches, null, 2));
      }

      case "claim_map": {
        const sessionId = ensureSession();
        const a = args as { map_id: string };
        const res = await brokerFetch<{ ok: boolean; error?: string }>(
          "/claim-map",
          { session_id: sessionId, map_id: a.map_id },
        );
        if (!res.ok) return textResult(res.error ?? "claim_map failed", true);
        return textResult(`Claimed map ${a.map_id} for this session.`);
      }

      default:
        return textResult(`Unknown tool: ${name}`, true);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return textResult(`Error: ${msg}`, true);
  }
}
