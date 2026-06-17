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
  MapFrame,
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
  insertMapFrame,
  selectMapFramesByMap,
  updateMapFrame,
  softDeleteMapFrame,
  restoreMapFrame,
} from "./db.ts";
import { activities, bgTaskCountForSession, markWorkingFromUserSubmit } from "./activity.ts";
import { getContextUsage } from "./context-usage.ts";
import { generateId } from "./helpers.ts";
import { broadcast, broadcastToAll } from "./ws.ts";
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
// A parent's children wrap into a new column once a column holds this many,
// so a parent with lots of children fans into a grid instead of one tall
// vertical run.
const MAX_PER_COL = 4;

function placeNode(
  mapId: string,
  parentId: string | null,
): { x: number; y: number } {
  const all = selectMapNodesByMap.all(mapId) as MapNode[];
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
  const parent = parentId ? all.find((n) => n.id === parentId) : undefined;
  if (!parent) {
    // Root (no parent): keep the simple top-left downward scan.
    let y = 80;
    for (let i = 0; i < 500 && !free(80, y); i++) y += NODE_H + ROW_GAP;
    return { x: 80, y };
  }

  const pw = parent.w ?? NODE_W;
  const ph = parent.h ?? NODE_H;
  const parentCenterY = parent.y + ph / 2;
  const ROW_STRIDE = NODE_H + ROW_GAP;
  const COL_STRIDE = NODE_W + COL_GAP;

  // Slot k of the fan/grid around the parent: (1) grid-wrap — cap a column at
  // MAX_PER_COL, then start a new column to the right; (3) centered — within a
  // column, fan out from the parent's centre in slot order 0, +1, -1, +2, …, so
  // children straddle the parent instead of stacking straight down.
  const slot = (k: number) => {
    const col = Math.floor(k / MAX_PER_COL);
    const inCol = k % MAX_PER_COL;
    const step =
      inCol === 0 ? 0 : inCol % 2 === 1 ? (inCol + 1) / 2 : -inCol / 2;
    return {
      x: parent.x + pw + COL_GAP + col * COL_STRIDE,
      y: parentCenterY - NODE_H / 2 + step * ROW_STRIDE,
    };
  };

  // Take the FIRST FREE slot (not a sibling count). This way a user-drawn
  // association out of the parent doesn't inflate the index (those edges are
  // indistinguishable from parent→child edges in the table), and a deleted
  // child's slot gets reused — while existing cards are still never moved.
  for (let k = 0; k < 500; k++) {
    const s = slot(k);
    if (free(s.x, s.y)) return s;
  }
  // Pathological fallback: stack straight down from the first column.
  const base = slot(0);
  let y = base.y;
  for (let i = 0; i < 500 && !free(base.x, y); i++) y += ROW_STRIDE;
  return { x: base.x, y };
}

// Does a freshly-placed card (its footprint rect) overlap another node or a
// non-incident edge? Used to flag the new node so the UI can warn the user
// (they can drag it clear). Node overlap is normally avoided by placeNode's
// free() scan; the common real case is a card that landed across an edge.
function placementOverlaps(
  mapId: string,
  nodeId: string,
  rect: { x: number; y: number; w: number; h: number },
): boolean {
  const all = (selectMapNodesByMap.all(mapId) as MapNode[]).filter(
    (n) => n.id !== nodeId,
  );
  const overlapsNode = all.some((n) => {
    const w = n.w ?? NODE_W;
    const h = n.h ?? NODE_H;
    return (
      rect.x < n.x + w &&
      rect.x + rect.w > n.x &&
      rect.y < n.y + h &&
      rect.y + rect.h > n.y
    );
  });
  if (overlapsNode) return true;
  // Edges: APPROXIMATE each as the straight segment between its endpoints'
  // centres and sample it. The rendered edge is a Bézier curve, so this can
  // miss a card that only the curve (not the chord) crosses, or fire when only
  // the chord does — acceptable for a best-effort "you may want to move this"
  // cue (it isn't load-bearing; the user decides whether to nudge the card).
  const center = (id: string) => {
    const n = all.find((m) => m.id === id);
    if (!n) return null;
    return { x: n.x + (n.w ?? NODE_W) / 2, y: n.y + (n.h ?? NODE_H) / 2 };
  };
  const inRect = (px: number, py: number) =>
    px >= rect.x && px <= rect.x + rect.w && py >= rect.y && py <= rect.y + rect.h;
  const edges = selectMapEdgesByMap.all(mapId) as {
    from_id: string;
    to_id: string;
  }[];
  return edges.some((e) => {
    // An edge touching the new node is expected (it connects to it), not an
    // overlap problem — skip those.
    if (e.from_id === nodeId || e.to_id === nodeId) return false;
    const a = center(e.from_id);
    const b = center(e.to_id);
    if (!a || !b) return false;
    for (let t = 0; t <= 1.0001; t += 0.05) {
      if (inRect(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t)) return true;
    }
    return false;
  });
}

// After a node is auto-placed, broadcast a transient overlap warning if it
// landed across another node or an edge — the UI flashes that node so the user
// can nudge it clear. (User-facing only; the AI is never told, since it can't
// move nodes anyway.)
function flagPlacementOverlap(mapId: string, nodeId: string): void {
  const node = selectMapNode.get(mapId, nodeId) as MapNode | undefined;
  if (!node) return;
  const rect = {
    x: node.x,
    y: node.y,
    w: node.w ?? NODE_W,
    h: node.h ?? NODE_H,
  };
  if (placementOverlaps(mapId, nodeId, rect)) {
    broadcast(mapId, { type: "map-node-overlap", node_id: nodeId });
  }
}

// When a new edge is drawn, warn any existing node the edge passes THROUGH (not
// its two endpoints) — an existing card sitting under a fresh edge is the case
// node-placement overlap can't catch. Straight-chord approximation of the
// rendered Bezier, like placementOverlaps; user-facing flash only.
function flagEdgeOverlap(mapId: string, fromId: string, toId: string): void {
  const nodes = selectMapNodesByMap.all(mapId) as MapNode[];
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const a = byId.get(fromId);
  const b = byId.get(toId);
  if (!a || !b) return;
  const ac = { x: a.x + (a.w ?? NODE_W) / 2, y: a.y + (a.h ?? NODE_H) / 2 };
  const bc = { x: b.x + (b.w ?? NODE_W) / 2, y: b.y + (b.h ?? NODE_H) / 2 };
  for (const n of nodes) {
    if (n.id === fromId || n.id === toId) continue;
    const w = n.w ?? NODE_W;
    const h = n.h ?? NODE_H;
    let hit = false;
    for (let t = 0; t <= 1.0001 && !hit; t += 0.05) {
      const px = ac.x + (bc.x - ac.x) * t;
      const py = ac.y + (bc.y - ac.y) * t;
      if (px >= n.x && px <= n.x + w && py >= n.y && py <= n.y + h) hit = true;
    }
    if (hit) broadcast(mapId, { type: "map-node-overlap", node_id: n.id });
  }
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
    flagEdgeOverlap(mapId, parentId, id);
  }
  return id;
}

export function handleAddMapNode(body: any) {
  const mapId = String(body?.map_id ?? "");
  if (!selectMap.get(mapId)) return { ok: false, error: "map not found" };
  const node = body?.node ?? body;
  const id = addNode(mapId, node);
  flagPlacementOverlap(mapId, id);
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

// --- Grouping frames (user-owned, purely visual) ---------------------------
// The AI never touches these — they're drawn/moved/resized/renamed/recoloured/
// deleted by the human in the canvas, like node layout. Soft-deleted so they
// ride the same Cmd+Z undo as nodes/edges. SILENT (broadcast only, no AI push).
export function handleAddMapFrame(body: any) {
  const mapId = String(body?.map_id ?? "");
  if (!selectMap.get(mapId)) return { ok: false, error: "map not found" };
  const id = body?.id ? String(body.id) : generateId("frm");
  const title = body?.title != null ? String(body.title) : "";
  const color = body?.color != null ? String(body.color) : "";
  const x = typeof body?.x === "number" ? body.x : 0;
  const y = typeof body?.y === "number" ? body.y : 0;
  const w = typeof body?.w === "number" ? body.w : 240;
  const h = typeof body?.h === "number" ? body.h : 160;
  insertMapFrame.run(
    mapId,
    id,
    title,
    color,
    x,
    y,
    w,
    h,
    new Date().toISOString(),
  );
  emit(mapId);
  return { ok: true, frame_id: id };
}

export function handleUpdateMapFrame(body: any) {
  const mapId = String(body?.map_id ?? "");
  const frameId = String(body?.frame_id ?? "");
  const cur = (selectMapFramesByMap.all(mapId) as MapFrame[]).find(
    (f) => f.id === frameId,
  );
  if (!cur) return { ok: false, error: "map frame not found" };
  const title = body?.title != null ? String(body.title) : cur.title;
  const color = body?.color != null ? String(body.color) : cur.color;
  const x = typeof body?.x === "number" ? body.x : cur.x;
  const y = typeof body?.y === "number" ? body.y : cur.y;
  const w = typeof body?.w === "number" ? body.w : cur.w;
  const h = typeof body?.h === "number" ? body.h : cur.h;
  // title_size: a number sets it; null clears it (back to the default base).
  const title_size =
    typeof body?.title_size === "number"
      ? body.title_size
      : body?.title_size === null
        ? null
        : (cur.title_size ?? null);
  updateMapFrame.run(title, color, x, y, w, h, title_size, mapId, frameId);
  emit(mapId);
  return { ok: true };
}

export function handleDeleteMapFrame(body: any) {
  const mapId = String(body?.map_id ?? "");
  const frameId = String(body?.frame_id ?? "");
  softDeleteMapFrame.run(new Date().toISOString(), mapId, frameId);
  emit(mapId);
  return { ok: true };
}

export function handleRestoreMapFrame(body: any) {
  const mapId = String(body?.map_id ?? "");
  const frameId = String(body?.frame_id ?? "");
  restoreMapFrame.run(mapId, frameId);
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
  flagEdgeOverlap(mapId, from, to);
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
  // A restored node comes back at its ORIGINAL position (undo must be exact) —
  // but auto-placement may have reused that slot for a new node in the
  // meantime. Don't move the restored card; instead flash the overlap warning
  // so the user notices and can nudge whichever card they like.
  for (const id of nodeIds) flagPlacementOverlap(mapId, String(id));
  emit(mapId);
  return { ok: true, restored_nodes: nodeIds.length, restored_edges: edgeIds.length };
}

export function handleRenameMap(body: any) {
  const mapId = String(body?.map_id ?? "");
  const title = String(body?.title ?? "").trim();
  if (!selectMap.get(mapId)) return { ok: false, error: "map not found" };
  if (!title) return { ok: false, error: "title required" };
  renameMap.run(title, mapId);
  emit(mapId); // the open map view refetches (header + breadcrumb title)
  broadcastToAll({ type: "sidebar-refresh" }); // sidebar shows map titles too
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
  // AND requeued=0 (Option B): map_chat rides the same pending_messages queue,
  // so a push that threw and was re-queued for retry must not be cancelled here
  // — that would re-introduce the silent loss. Mirrors handleSubmitAnswer.
  db.run(
    "UPDATE pending_messages SET cancelled = 1 WHERE id = ? AND delivered = 0 AND requeued = 0",
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
  // Also derive its unread flag: a checklist is unread when it changed (became
  // a checklist / item added or updated) more recently than the user last
  // viewed it — same idea as a thread's per-message read_at, node-level here.
  for (const n of nodes) {
    if (n.is_checklist) {
      n.checklist_items = selectChecklistItemsByNode.all(
        mapId,
        n.id,
      ) as ChecklistItem[];
      const ver = ((n as any).checklist_version as number) ?? 0;
      const readVer = ((n as any).checklist_read_version as number) ?? 0;
      n.checklist_unread = ver > readVer;
    }
  }
  const liveIds = new Set(nodes.map((n) => n.id));
  const edges = (selectMapEdgesByMap.all(mapId) as any[]).filter(
    (e) => liveIds.has(e.from_id) && liveIds.has(e.to_id),
  );
  const frames = selectMapFramesByMap.all(mapId) as MapFrame[];
  const threadRows = selectThreadsByBoard.all(mapId) as ThreadItem[];
  const threads: Record<string, ThreadItem[]> = {};
  for (const t of threadRows) {
    if (!threads[t.node_id]) threads[t.node_id] = [];
    threads[t.node_id].push(t);
  }
  const activity = activities.get(map.session_id) ?? null;
  const ownerRow = db
    .prepare(
      "SELECT alive, name, stalled_at, compacting_at, tmux_pane FROM sessions WHERE id = ?",
    )
    .get(map.session_id) as {
    alive: number;
    name: string | null;
    stalled_at: string | null;
    compacting_at: string | null;
    tmux_pane: string | null;
  } | null;
  return {
    map,
    nodes,
    edges,
    frames,
    threads,
    activity,
    owner_alive: ownerRow?.alive === 1,
    owner_stalled: ownerRow?.alive === 1 && !!ownerRow?.stalled_at,
    owner_compacting: ownerRow?.alive === 1 && !!ownerRow?.compacting_at,
    owner_session_name: ownerRow?.name ?? null,
    owner_context_usage: getContextUsage(map.session_id),
    owner_bg_task_count: bgTaskCountForSession(map.session_id),
    owner_can_cli_send: ownerRow?.alive === 1 && !!ownerRow?.tmux_pane,
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
        flagPlacementOverlap(mapId, id);
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
        flagEdgeOverlap(mapId, from, to);
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
  "/map-add-frame": handleAddMapFrame,
  "/map-update-frame": handleUpdateMapFrame,
  "/map-delete-frame": handleDeleteMapFrame,
  "/map-restore-frame": handleRestoreMapFrame,
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
