// Map handlers — the divergence-phase counterpart to boards.ts / nodes.ts /
// threads.ts.
//
// A map is a general graph (nodes connect 1-to-many / many-to-many / not at
// all; relations are explicit edges). The AI grows the map's CONTENT (it
// creates nodes with title + context and can draw edges); the human owns
// LAYOUT (drag = position) and ASSOCIATION (drawing edges). The AI's structure
// follow is PULL: silent broker writes (drag / connect) are not pushed over the
// channel — the AI re-reads the latest map (get_map) before it acts. Only
// conversational intent (the general chat + per-node messages) rides the
// channel, exactly like a board's user_input_relay.
//
// Messages REUSE thread_items (board_id = map_id, node_id = map node id or
// MAP_GENERAL_NODE) so the entire thread / message-id / mark-read / anchor
// surface works unchanged. Node delete is LOGICAL so a node's messages + edges
// never dangle.

import type {
  ChecklistItem,
  Map as MapRow,
  MapNode,
  ThreadItem,
} from "../shared/types.ts";
import { MAP_GENERAL_NODE } from "../shared/types.ts";
import {
  db,
  selectChecklistItemsByNode,
  insertMap,
  insertMapEdge,
  insertMapNode,
  insertPending,
  insertThread,
  markDelivered,
  renameMap,
  archiveMapStmt,
  selectMap,
  selectMapEdgeByPair,
  selectMapEdgesByMap,
  selectMapNode,
  selectMapNodesByMap,
  selectThreadsByBoard,
  setPendingThreadItem,
  restoreMapEdge,
  restoreMapNode,
  softDeleteMapEdge,
  softDeleteMapNode,
  updateMapNodeContent,
  updateMapNodePos,
} from "./db.ts";
import { activities, bgTaskCountForSession, markWorkingFromUserSubmit } from "./activity.ts";
import { getContextUsage } from "./context-usage.ts";
import { generateId } from "./helpers.ts";
import { broadcast } from "./ws.ts";
import { PUBLIC_URL, SUBMIT_DELIVERY_TIMEOUT_MS } from "./config.ts";

const KINDS = new Set(["question", "idea", "research", "note", "selection"]);
function normKind(k: unknown): string {
  const s = String(k ?? "idea");
  return KINDS.has(s) ? s : "idea";
}

// A checklist map node renders its items, not a thread — so a message posted
// there would be invisible to the user. Reject the post (mirrors the board
// checklist guard in threads.ts).
const CHECKLIST_POST_REJECT =
  "map node is a checklist node — it renders its checklist items, not a thread, so a message posted here would be invisible. Post to a different node, or add a checklist line with record_map_decision.";

// Notify every browser subscribed to this map's WS channel (/ws/<map_id>).
// A map_id never collides with a board_id, so the fan-out is naturally scoped.
function emit(mapId: string) {
  broadcast(mapId, { type: "map-update" });
}

// --- Layout ----------------------------------------------------------------
// Generous spacing so edges are visible (the user asked for ~3x the original
// gaps). The AI never supplies coordinates; it supplies content + an optional
// parent hint, and the broker places the card. The human then drags it
// wherever they like and that position is remembered (no auto-relayout).
const NODE_W = 320;
const NODE_H = 340;
const COL_GAP = 420;
const ROW_GAP = 160;

// Gap kept clear around every placed card so auto-placed nodes never touch.
const PLACE_MARGIN = 28;

function placeNode(
  mapId: string,
  parentId: string | null,
): { x: number; y: number } {
  const all = selectMapNodesByMap.all(mapId) as MapNode[];
  const edges = selectMapEdgesByMap.all(mapId) as {
    from_id: string;
    to_id: string;
  }[];
  // Existing footprints (respect each node's actual resized size).
  const rects = all.map((n) => ({
    x: n.x,
    y: n.y,
    w: n.w ?? NODE_W,
    h: n.h ?? NODE_H,
  }));
  const free = (x: number, y: number) =>
    !rects.some(
      (r) =>
        x < r.x + r.w + PLACE_MARGIN &&
        x + NODE_W + PLACE_MARGIN > r.x &&
        y < r.y + r.h + PLACE_MARGIN &&
        y + NODE_H + PLACE_MARGIN > r.y,
    );
  // Scan straight DOWN from the anchor for the first slot that doesn't overlap
  // any existing card. Children anchor just right of (and level with) their
  // parent — near it, in the same row band — instead of being stacked far down
  // a fixed column. COL_GAP (the horizontal gap) is the user-tuned value, kept.
  let baseX: number;
  let baseY: number;
  const parent = parentId ? all.find((n) => n.id === parentId) : undefined;
  if (parent) {
    baseX = parent.x + (parent.w ?? NODE_W) + COL_GAP;
    baseY = parent.y;
  } else {
    // Root: a node with no incoming edge — start at the top-left band.
    baseX = 80;
    baseY = 80;
  }
  let y = baseY;
  for (let i = 0; i < 500 && !free(baseX, y); i++) {
    y += NODE_H + ROW_GAP;
  }
  return { x: baseX, y };
}

// --- Map / node / edge CRUD ------------------------------------------------

export function handleCreateMap(body: any) {
  const sessionId = String(body?.session_id ?? "");
  const title = String(body?.title ?? "").trim();
  if (!sessionId) return { ok: false, error: "session_id required" };
  if (!title) return { ok: false, error: "title required" };
  const mapId = generateId("map");
  insertMap.run(mapId, sessionId, title, new Date().toISOString());
  // Optional seed nodes (each: { id?, title?, context?, kind?, parent? }).
  if (Array.isArray(body?.nodes)) {
    for (const n of body.nodes) {
      addNode(mapId, n);
    }
  }
  emit(mapId);
  return { ok: true, map_id: mapId, url: `${PUBLIC_URL}/map/${mapId}` };
}

// Shared insert used by create (seed) + add_map_node. Returns the new node id.
function addNode(mapId: string, n: any): string {
  const id = n?.id ? String(n.id) : generateId("mn");
  const title = n?.title != null ? String(n.title) : "";
  const context = n?.context != null ? String(n.context) : "";
  const kind = normKind(n?.kind);
  const parentId =
    n?.parent != null && selectMapNode.get(mapId, String(n.parent))
      ? String(n.parent)
      : null;
  const pos =
    typeof n?.x === "number" && typeof n?.y === "number"
      ? { x: n.x, y: n.y }
      : placeNode(mapId, parentId);
  insertMapNode.run(
    mapId,
    id,
    title,
    context,
    kind,
    pos.x,
    pos.y,
    n?.w ?? null,
    n?.h ?? null,
    new Date().toISOString(),
  );
  // A parent hint also draws the edge, so the AI can build a branch in one call.
  if (parentId) {
    insertMapEdge.run(
      mapId,
      generateId("me"),
      parentId,
      id,
      new Date().toISOString(),
    );
  }
  return id;
}

export function handleAddMapNode(body: any) {
  const mapId = String(body?.map_id ?? "");
  if (!selectMap.get(mapId)) return { ok: false, error: "map not found" };
  const node = body?.node ?? body;
  const id = addNode(mapId, node);
  emit(mapId);
  return { ok: true, node_id: id };
}

export function handleUpdateMapNode(body: any) {
  const mapId = String(body?.map_id ?? "");
  const nodeId = String(body?.node_id ?? "");
  const cur = selectMapNode.get(mapId, nodeId) as MapNode | undefined;
  if (!cur) return { ok: false, error: "map node not found" };
  const title = body?.title != null ? String(body.title) : cur.title;
  const context = body?.context != null ? String(body.context) : cur.context;
  const kind = body?.kind != null ? normKind(body.kind) : cur.kind;
  updateMapNodeContent.run(title, context, kind, mapId, nodeId);
  emit(mapId);
  return { ok: true };
}

// Position / size persist. SILENT in the pull model — broadcast so other
// browsers follow, but no channel push to the AI (it re-reads on next act).
export function handleMoveMapNode(body: any) {
  const mapId = String(body?.map_id ?? "");
  const nodeId = String(body?.node_id ?? "");
  const cur = selectMapNode.get(mapId, nodeId) as MapNode | undefined;
  if (!cur) return { ok: false, error: "map node not found" };
  const x = typeof body?.x === "number" ? body.x : cur.x;
  const y = typeof body?.y === "number" ? body.y : cur.y;
  const w = typeof body?.w === "number" ? body.w : cur.w ?? null;
  const h = typeof body?.h === "number" ? body.h : cur.h ?? null;
  updateMapNodePos.run(x, y, w, h, mapId, nodeId);
  emit(mapId);
  return { ok: true };
}

// Logical delete: the node disappears from the map but its messages + the
// edges touching it stay in the DB (so nothing dangles, and an undo path stays
// open). getMapView filters deleted nodes AND drops edges whose endpoint is no
// longer live, so the canvas stays clean.
export function handleDeleteMapNode(body: any) {
  const mapId = String(body?.map_id ?? "");
  const nodeId = String(body?.node_id ?? "");
  const cur = selectMapNode.get(mapId, nodeId) as MapNode | undefined;
  if (!cur) return { ok: false, error: "map node not found" };
  softDeleteMapNode.run(new Date().toISOString(), mapId, nodeId);
  emit(mapId);
  return { ok: true };
}

export function handleConnectMap(body: any) {
  const mapId = String(body?.map_id ?? "");
  const from = String(body?.from_id ?? body?.from ?? "");
  const to = String(body?.to_id ?? body?.to ?? "");
  if (!selectMap.get(mapId)) return { ok: false, error: "map not found" };
  if (!selectMapNode.get(mapId, from) || !selectMapNode.get(mapId, to)) {
    return { ok: false, error: "from_id/to_id must be live map node ids" };
  }
  if (from === to) return { ok: false, error: "cannot connect a node to itself" };
  // Dedup: an undeleted edge for this exact pair already covers it.
  const existing = selectMapEdgeByPair.get(mapId, from, to) as
    | { id: string }
    | undefined;
  if (existing) return { ok: true, edge_id: existing.id, existed: true };
  const edgeId = generateId("me");
  insertMapEdge.run(mapId, edgeId, from, to, new Date().toISOString());
  emit(mapId);
  return { ok: true, edge_id: edgeId };
}

export function handleDisconnectMap(body: any) {
  const mapId = String(body?.map_id ?? "");
  const edgeId = String(body?.edge_id ?? "");
  if (!selectMap.get(mapId)) return { ok: false, error: "map not found" };
  softDeleteMapEdge.run(new Date().toISOString(), mapId, edgeId);
  emit(mapId);
  return { ok: true };
}

// Undo a delete: un-tombstone the given nodes and/or edges in one shot (so a
// node deleted together with its incident edges comes back whole). One emit at
// the end → the canvas refetches once. Restoring is safe because delete was
// logical — the rows were only hidden, never removed.
export function handleRestoreMap(body: any) {
  const mapId = String(body?.map_id ?? "");
  if (!selectMap.get(mapId)) return { ok: false, error: "map not found" };
  const nodeIds = Array.isArray(body?.node_ids) ? body.node_ids : [];
  const edgeIds = Array.isArray(body?.edge_ids) ? body.edge_ids : [];
  for (const id of nodeIds) restoreMapNode.run(mapId, String(id));
  for (const id of edgeIds) restoreMapEdge.run(mapId, String(id));
  emit(mapId);
  return { ok: true, restored_nodes: nodeIds.length, restored_edges: edgeIds.length };
}

export function handleRenameMap(body: any) {
  const mapId = String(body?.map_id ?? "");
  const title = String(body?.title ?? "").trim();
  if (!selectMap.get(mapId)) return { ok: false, error: "map not found" };
  if (!title) return { ok: false, error: "title required" };
  renameMap.run(title, mapId);
  emit(mapId);
  return { ok: true };
}

export function handleArchiveMap(body: any) {
  const mapId = String(body?.map_id ?? "");
  if (!selectMap.get(mapId)) return { ok: false, error: "map not found" };
  archiveMapStmt.run(body?.archived === false ? 0 : 1, mapId);
  return { ok: true };
}

// --- Messages (reuse thread_items via board_id = map_id) -------------------

// CC posts into a map node's thread (or the general chat). Mirrors
// handlePostToNode minus the board-status / concern machinery. Returns the new
// thread_items.id as message_id so the AI can cite the exact post.
export function handlePostToMapNode(body: any) {
  const mapId = String(body?.map_id ?? "");
  const nodeId = String(body?.node_id ?? MAP_GENERAL_NODE);
  const message = String(body?.message ?? "");
  if (!selectMap.get(mapId)) return { ok: false, error: "map not found" };
  if (nodeId !== MAP_GENERAL_NODE) {
    const node = selectMapNode.get(mapId, nodeId) as MapNode | undefined;
    if (!node) return { ok: false, error: "map node not found" };
    if (node.is_checklist) return { ok: false, error: CHECKLIST_POST_REJECT };
  }
  if (!message.trim()) return { ok: false, error: "message required" };
  const inserted = insertThread.run(
    mapId,
    nodeId,
    "cc",
    message,
    new Date().toISOString(),
  );
  broadcast(mapId, { type: "thread-update", node_id: nodeId, source: "cc" });
  return { ok: true, message_id: Number(inserted.lastInsertRowid) };
}

// The map's general chat + each node's input post here. Blocking, like
// handleSubmitAnswer: enqueue a pending message (kind=map_chat) and wait for
// the owning CC to poll. handlePollMessages materializes the user's reply into
// thread_items at delivery (so message_id can ride the channel push). Unlike a
// board, map_chat does NOT bump the unanswered-posts counter — the AI replies
// by GROWING THE MAP, not necessarily by posting back, so the Stop-hook nag
// would over-fire.
export async function handleMapChat(body: any): Promise<
  | { ok: true }
  | { ok: false; error: string; reason?: "no_recipient" | "timeout" }
> {
  const mapId = String(body?.map_id ?? "");
  const text = String(body?.text ?? "").trim();
  const map = selectMap.get(mapId) as MapRow | undefined;
  if (!map) return { ok: false, error: "map not found", reason: "no_recipient" };
  if (!text) return { ok: false, error: "text required" };
  const owner = db
    .prepare("SELECT alive, cc_session_id FROM sessions WHERE id = ?")
    .get(map.session_id) as
    | { alive: number; cc_session_id: string | null }
    | null;
  if (!owner || owner.alive !== 1 || !owner.cc_session_id) {
    return { ok: false, error: "errors.no_recipient", reason: "no_recipient" };
  }
  const nodeId = body?.node_id ? String(body.node_id) : MAP_GENERAL_NODE;
  // A real node id must exist; the general chat is always valid.
  if (nodeId !== MAP_GENERAL_NODE) {
    const node = selectMapNode.get(mapId, nodeId) as MapNode | undefined;
    if (!node) {
      return { ok: false, error: "map node not found", reason: "no_recipient" };
    }
    if (node.is_checklist) {
      return { ok: false, error: CHECKLIST_POST_REJECT, reason: "no_recipient" };
    }
  }
  const nodeTitle =
    nodeId === MAP_GENERAL_NODE
      ? "General chat"
      : ((selectMapNode.get(mapId, nodeId) as MapNode | undefined)?.title ||
        nodeId);
  const path = `${map.title} > ${nodeTitle}`;
  const now = new Date().toISOString();
  const insertResult = insertPending.run(
    map.session_id,
    mapId,
    nodeId,
    path,
    text,
    now,
    "map_chat",
  );
  const pendingId = Number(insertResult.lastInsertRowid);
  markWorkingFromUserSubmit(map.session_id);

  const deadline = Date.now() + SUBMIT_DELIVERY_TIMEOUT_MS;
  const checkDelivered = db.prepare(
    "SELECT delivered, thread_item_id FROM pending_messages WHERE id = ?",
  );
  while (Date.now() < deadline) {
    const row = checkDelivered.get(pendingId) as
      | { delivered: number; thread_item_id: number | null }
      | null;
    if (row?.delivered === 1) {
      // Poll already materialized the user message into the node thread; fall
      // back only if it somehow didn't.
      if (row.thread_item_id == null) {
        insertThread.run(mapId, nodeId, "user", text, now);
      }
      broadcast(mapId, {
        type: "thread-update",
        node_id: nodeId,
        source: "user",
      });
      return { ok: true };
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  db.run(
    "UPDATE pending_messages SET cancelled = 1 WHERE id = ? AND delivered = 0",
    [pendingId],
  );
  return { ok: false, error: "errors.delivery_timeout", reason: "timeout" };
}

// --- Read side -------------------------------------------------------------

export function getMapView(mapId: string) {
  const map = selectMap.get(mapId) as MapRow | undefined;
  if (!map) return null;
  const nodes = selectMapNodesByMap.all(mapId) as MapNode[];
  // Attach the checklist_items list to any checklist map node (board_id =
  // map_id), so the canvas can render it read-only without a second round-trip.
  for (const n of nodes) {
    if (n.is_checklist) {
      n.checklist_items = selectChecklistItemsByNode.all(
        mapId,
        n.id,
      ) as ChecklistItem[];
    }
  }
  const liveIds = new Set(nodes.map((n) => n.id));
  const edges = (selectMapEdgesByMap.all(mapId) as any[]).filter(
    (e) => liveIds.has(e.from_id) && liveIds.has(e.to_id),
  );
  const threadRows = selectThreadsByBoard.all(mapId) as ThreadItem[];
  const threads: Record<string, ThreadItem[]> = {};
  for (const t of threadRows) {
    if (!threads[t.node_id]) threads[t.node_id] = [];
    threads[t.node_id].push(t);
  }
  const activity = activities.get(map.session_id) ?? null;
  const ownerRow = db
    .prepare("SELECT alive, name, stalled_at FROM sessions WHERE id = ?")
    .get(map.session_id) as {
    alive: number;
    name: string | null;
    stalled_at: string | null;
  } | null;
  return {
    map,
    nodes,
    edges,
    threads,
    activity,
    owner_alive: ownerRow?.alive === 1,
    owner_stalled: ownerRow?.alive === 1 && !!ownerRow?.stalled_at,
    owner_session_name: ownerRow?.name ?? null,
    owner_context_usage: getContextUsage(map.session_id),
    owner_bg_task_count: bgTaskCountForSession(map.session_id),
  };
}

export function handleGetMap(body: any) {
  const view = getMapView(String(body?.map_id ?? ""));
  if (!view) return { ok: false, error: "map not found" };
  return { ok: true, ...view };
}

export function handleListMaps(body: any) {
  const sessionId = String(body?.session_id ?? "");
  if (!sessionId) return { ok: false, error: "session_id required" };
  // Only this session's maps. Cross-session discovery was deliberately dropped
  // (noise) — find another session's map via peers / by asking the user.
  const maps = db
    .prepare(
      "SELECT id, title, created_at FROM maps WHERE session_id = ? AND deleted_at IS NULL AND archived = 0 ORDER BY created_at",
    )
    .all(sessionId) as { id: string; title: string; created_at: string }[];
  const out = maps.map((m) => ({
    ...m,
    node_count: (
      db
        .prepare(
          "SELECT COUNT(*) AS cnt FROM map_nodes WHERE map_id = ? AND deleted_at IS NULL",
        )
        .get(m.id) as { cnt: number }
    ).cnt,
    url: `${PUBLIC_URL}/map/${m.id}`,
  }));
  return { ok: true, maps: out };
}

// Full-text-ish search across a session's maps (title / node title+context /
// message bodies). Cheap substring match — maps are small. Scopes to the
// session so a search can't leak another session's content.
export function handleSearchMaps(body: any) {
  const sessionId = String(body?.session_id ?? "");
  const q = String(body?.query ?? "").trim().toLowerCase();
  if (!sessionId) return { ok: false, error: "session_id required" };
  if (!q) return { ok: true, matches: [] };
  const maps = db
    .prepare(
      "SELECT id, title FROM maps WHERE session_id = ? AND deleted_at IS NULL",
    )
    .all(sessionId) as { id: string; title: string }[];
  const matches: any[] = [];
  for (const m of maps) {
    const hits: any[] = [];
    if (m.title.toLowerCase().includes(q)) {
      hits.push({ where: "map_title", text: m.title });
    }
    const nodes = selectMapNodesByMap.all(m.id) as MapNode[];
    for (const n of nodes) {
      if (
        n.title.toLowerCase().includes(q) ||
        n.context.toLowerCase().includes(q)
      ) {
        hits.push({
          where: "node",
          node_id: n.id,
          kind: n.kind,
          title: n.title,
          snippet: (n.context || n.title).slice(0, 160),
        });
      }
    }
    const msgs = db
      .prepare(
        "SELECT node_id, source, text FROM thread_items WHERE board_id = ?",
      )
      .all(m.id) as { node_id: string; source: string; text: string }[];
    for (const msg of msgs) {
      if (msg.text.toLowerCase().includes(q)) {
        hits.push({
          where: "message",
          node_id: msg.node_id,
          source: msg.source,
          snippet: msg.text.slice(0, 160),
        });
      }
    }
    if (hits.length > 0) matches.push({ map_id: m.id, map_title: m.title, hits });
  }
  return { ok: true, matches };
}

// Batch / transactional map mutation. Growing a map is inherently a batch
// (add several nodes + draw edges + post) and that collides with the harness
// per-turn tool-call cap — agents were hitting "Tool use limit reached"
// mid-batch, half the adds silently dropped, then mis-reporting success. One
// apply_map_ops call builds a whole branch, returns a per-op result so partial
// failures are VISIBLE (no more silent truncation), and broadcasts once.
export function handleApplyMapOps(body: any) {
  const mapId = String(body?.map_id ?? "");
  if (!selectMap.get(mapId)) return { ok: false, error: "map not found" };
  const ops = Array.isArray(body?.ops) ? body.ops : [];
  const now = () => new Date().toISOString();
  const results: any[] = [];
  let posted = false;
  for (const o of ops) {
    const op = String(o?.op ?? "");
    try {
      if (op === "add") {
        // addNode resolves parent → auto-edge + placement; no per-op emit.
        const id = addNode(mapId, o);
        results.push({ op, ok: true, node_id: id });
      } else if (op === "update") {
        const nodeId = String(o.node_id ?? "");
        const cur = selectMapNode.get(mapId, nodeId) as MapNode | undefined;
        if (!cur) {
          results.push({ op, ok: false, node_id: nodeId, error: "node not found" });
          continue;
        }
        updateMapNodeContent.run(
          o.title != null ? String(o.title) : cur.title,
          o.context != null ? String(o.context) : cur.context,
          o.kind != null ? normKind(o.kind) : cur.kind,
          mapId,
          nodeId,
        );
        results.push({ op, ok: true, node_id: nodeId });
      } else if (op === "connect") {
        const from = String(o.from_id ?? o.from ?? "");
        const to = String(o.to_id ?? o.to ?? "");
        if (from === to) {
          results.push({ op, ok: false, error: "cannot connect a node to itself" });
          continue;
        }
        if (!selectMapNode.get(mapId, from) || !selectMapNode.get(mapId, to)) {
          results.push({ op, ok: false, error: "from_id/to_id must be live node ids" });
          continue;
        }
        const ex = selectMapEdgeByPair.get(mapId, from, to) as { id: string } | undefined;
        if (ex) {
          results.push({ op, ok: true, edge_id: ex.id, existed: true });
          continue;
        }
        const eid = generateId("me");
        insertMapEdge.run(mapId, eid, from, to, now());
        results.push({ op, ok: true, edge_id: eid });
      } else if (op === "delete") {
        const nodeId = String(o.node_id ?? "");
        if (!selectMapNode.get(mapId, nodeId)) {
          results.push({ op, ok: false, node_id: nodeId, error: "node not found" });
          continue;
        }
        softDeleteMapNode.run(now(), mapId, nodeId);
        results.push({ op, ok: true, node_id: nodeId });
      } else if (op === "disconnect") {
        softDeleteMapEdge.run(now(), mapId, String(o.edge_id ?? ""));
        results.push({ op, ok: true });
      } else if (op === "post") {
        const nodeId = String(o.node_id ?? MAP_GENERAL_NODE);
        const msg = String(o.message ?? "");
        if (nodeId !== MAP_GENERAL_NODE) {
          const node = selectMapNode.get(mapId, nodeId) as MapNode | undefined;
          if (!node) {
            results.push({ op, ok: false, node_id: nodeId, error: "node not found" });
            continue;
          }
          if (node.is_checklist) {
            results.push({ op, ok: false, node_id: nodeId, error: CHECKLIST_POST_REJECT });
            continue;
          }
        }
        if (!msg.trim()) {
          results.push({ op, ok: false, error: "message required" });
          continue;
        }
        const ins = insertThread.run(mapId, nodeId, "cc", msg, now());
        posted = true;
        results.push({ op, ok: true, node_id: nodeId, message_id: Number(ins.lastInsertRowid) });
      } else {
        results.push({ op, ok: false, error: `unknown op '${op}'` });
      }
    } catch (e) {
      results.push({ op, ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  }
  emit(mapId);
  if (posted) {
    broadcast(mapId, { type: "thread-update", node_id: MAP_GENERAL_NODE, source: "cc" });
  }
  return {
    ok: true,
    applied: results.filter((r) => r.ok).length,
    total: results.length,
    results,
  };
}

export const routes = {
  "/create-map": handleCreateMap,
  "/map-apply-ops": handleApplyMapOps,
  "/map-add-node": handleAddMapNode,
  "/map-update-node": handleUpdateMapNode,
  "/map-move-node": handleMoveMapNode,
  "/map-delete-node": handleDeleteMapNode,
  "/map-connect": handleConnectMap,
  "/map-disconnect": handleDisconnectMap,
  "/map-restore": handleRestoreMap,
  "/map-rename": handleRenameMap,
  "/map-archive": handleArchiveMap,
  "/map-post": handlePostToMapNode,
  "/map-chat": handleMapChat,
  "/get-map": handleGetMap,
  "/list-maps": handleListMaps,
  "/search-maps": handleSearchMaps,
};
