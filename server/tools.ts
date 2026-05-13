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
      "Create a discussion board with concerns and items as a JSON tree. Returns the URL to share with the user.",
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
      "Add a top-level concern (a discussion topic) to an existing board, optionally with items.",
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
      "Add a discussion item under a concern. Boards are intentionally 2-level (concern → items) — sub-items are not supported. If a topic feels like it needs a sub-item, either split it into its own concern or restructure with update_node / move_node.",
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
      "Update title / context / kind of an existing node. Use for typo fixes, evolving descriptions, or converting concern↔item when the structure was misjudged at creation. At least one of title / context / kind must be provided. The UI broadcasts a structure-update so clients refetch. Does NOT modify thread messages or status — for those use post_to_node / set_node_status.",
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
      "Set a human-readable name for the current Claude Code session, visible in the UI sidebar so the user can distinguish multiple parallel CC sessions. Call this once near the start of a session, ideally with a short topic name (e.g. parallel-discussion development / wyndoc API design / etc). Without this the sidebar shows the session by its broker id, which is opaque.",
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
      "Call ONCE at the start of every Claude Code session, passing your CC session_id (visible in SessionStart hook context, a UUID). The broker associates the current MCP-server session with this stable cc_session_id and transfers ownership of boards / undelivered messages from any prior dead MCP session that had the same cc_session_id. Without this, user UI submissions orphan after every CC restart and must be SQL-redirected manually.",
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
      "Set the BOARD-level status (independent from node-level status). Use this when the board's overall purpose is settled, regardless of whether every internal node has been formally marked. Values: 'active' (default, work in progress), 'completed' (purpose fulfilled, work done — even if some nodes remain in pending/needs-reply because the work proceeded outside the board), 'withdrawn' (proposal abandoned / no longer pursued), 'paused' (temporarily on hold). This is shown distinctly from node aggregation in the UI.",
    inputSchema: {
      type: "object" as const,
      properties: {
        board_id: { type: "string" as const },
        status: {
          type: "string" as const,
          enum: ["active", "completed", "withdrawn", "paused"],
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
    name: "request_improvement",
    description:
      "Submit a concrete friction point about parallel-discussion-mcp itself to the user's review queue (REQUESTS.md). Use this when you wanted to express something the current tools/UI did not support — a missing node kind, an unsupported workflow, a rendering gap. The user reviews accumulated requests and decides which to implement. Be specific about the actual situation; do not speculate.",
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
];

function textResult(text: string, isError = false) {
  return {
    content: [{ type: "text" as const, text }],
    ...(isError ? { isError: true } : {}),
  };
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
          `Board created: ${res.board_id}\nURL: ${res.url}\n\nShare the URL with the user. They can answer each node individually; their answers arrive here as <channel source="parallel-discussion"> messages.`,
        );
      }

      case "add_concern": {
        const sessionId = ensureSession();
        const a = args as { board_id: string; concern: any };
        const res = await brokerFetch<{ node_id: string }>("/add-concern", {
          session_id: sessionId,
          board_id: a.board_id,
          concern: a.concern,
        });
        return textResult(`Concern added: ${res.node_id}`);
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
        const res = await brokerFetch<{ node_id: string }>("/add-item", {
          session_id: sessionId,
          board_id: a.board_id,
          concern_id: a.concern_id,
          item: a.item,
        });
        return textResult(`Item added: ${res.node_id}`);
      }

      case "post_to_node": {
        const sessionId = ensureSession();
        const a = args as {
          board_id: string;
          node_id: string;
          message: string;
          status: string;
        };
        await brokerFetch("/post-to-node", {
          session_id: sessionId,
          board_id: a.board_id,
          node_id: a.node_id,
          message: a.message,
          status: a.status,
        });
        return textResult(
          `Posted to node ${a.node_id} (board ${a.board_id}, status=${a.status})`,
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
        const res = await brokerFetch<{
          ok: boolean;
          error?: string;
          deleted_count?: number;
        }>("/delete-node", {
          session_id: sessionId,
          board_id: a.board_id,
          node_id: a.node_id,
        });
        if (!res.ok) return textResult(res.error ?? "Delete failed", true);
        return textResult(
          `Soft-deleted node ${a.node_id} (and ${(res.deleted_count ?? 1) - 1} descendant(s)). Thread history preserved.`,
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
        await brokerFetch("/set-node-status", {
          session_id: sessionId,
          board_id: a.board_id,
          node_id: a.node_id,
          status: a.status,
        });
        return textResult(`Status of ${a.node_id} set to ${a.status}`);
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

      default:
        return textResult(`Unknown tool: ${name}`, true);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return textResult(`Error: ${msg}`, true);
  }
}
