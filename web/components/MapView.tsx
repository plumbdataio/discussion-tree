// The map page: a React Flow canvas (the divergence graph) beside a right-hand
// general chat panel (the map-wide thread). Reuses the dt chrome (header +
// sidebar) and node/thread/markdown components so a map feels like the rest of
// dt. The broker is the single source of truth — we fetch /api/map/:id and
// subscribe to /ws/:id, rebuilding the graph on every update. The human's
// drags / edge-draws are persisted silently (pull model); the AI re-reads.

import "@xyflow/react/dist/style.css";

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ReactFlow,
  Background,
  Controls,
  ControlButton,
  ConnectionMode,
  MarkerType,
  applyNodeChanges,
  applyEdgeChanges,
  reconnectEdge,
} from "@xyflow/react";
import {
  AlertTriangle,
  ChartNetwork,
  Frame,
  Lock,
  Maximize2,
  ScrollText,
  Unlock,
} from "lucide-react";
import { FloatingEdge, FloatingConnectionLine } from "./mapFloatingEdge.tsx";
import type {
  Node as RFNode,
  Edge as RFEdge,
  NodeChange,
  EdgeChange,
  Connection,
} from "@xyflow/react";
import { useTranslation } from "react-i18next";
import type { MapView as MapViewData, ThreadItem } from "../../shared/types.ts";
import { MAP_GENERAL_NODE } from "../../shared/types.ts";
import { MapNode, MapContext, type MapCtx } from "./MapNode.tsx";
import { MapFrameNode } from "./MapFrameNode.tsx";
import { MapNodeModal } from "./MapNodeModal.tsx";
import { CliCommandButton } from "./CliCommandButton.tsx";
import { MapTimelineModal } from "./MapTimelineModal.tsx";
import { Sidebar } from "./Sidebar.tsx";
import { ContextMeter } from "./ContextMeter.tsx";
import { ThreadMessage } from "./ThreadMessage.tsx";
import { useDraft } from "../utils/drafts.ts";
import { useMarkReadOnVisible } from "../utils/useMarkReadOnVisible.ts";
import { useDocumentTitle } from "../utils/useDocumentTitle.ts";
import {
  extractImageFiles,
  postMapAddFrame,
  postMapChat,
  postMapConnect,
  postMapDeleteFrame,
  postMapDeleteNode,
  postMapDisconnect,
  postMapMoveNode,
  postMapRestore,
  postMapRestoreFrame,
  postMapUpdateFrame,
  uploadImage,
} from "../utils/api.ts";
import { showToast } from "./Toast.tsx";

const NODE_W_DEFAULT = 320;
const NODE_H_DEFAULT = 340;

// Stable type maps (React Flow warns if these identities change each render).
const nodeTypes = { mapCard: MapNode, frame: MapFrameNode };
const edgeTypes = { floating: FloatingEdge };

const defaultEdgeOptions = {
  type: "floating",
  markerEnd: { type: MarkerType.ArrowClosed, width: 18, height: 18 },
  style: { strokeWidth: 1.5, stroke: "#9ca3af" },
};

// Reconcile edges against the previous set instead of rebuilding from scratch.
// Reusing the SAME object reference for an unchanged edge keeps React Flow from
// remounting its <FloatingEdge> — a remount briefly renders the edge before the
// node measurements are ready (useInternalNode → return null), which is what
// made "delete one edge / mark a node read" look like ALL edges blink away.
function mergeEdges(prev: RFEdge[], view: MapViewData): RFEdge[] {
  const prevById = new Map(prev.map((e) => [e.id, e]));
  return view.edges.map((e) => {
    const ex = prevById.get(e.id);
    if (ex && ex.source === e.from_id && ex.target === e.to_id) return ex;
    return {
      id: e.id,
      source: e.from_id,
      target: e.to_id,
      type: "floating",
      markerEnd: { type: MarkerType.ArrowClosed, width: 18, height: 18 },
    } as RFEdge;
  });
}

export function MapView({ mapId }: { mapId: string }) {
  const { t } = useTranslation();
  const [view, setView] = useState<MapViewData | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [wsConnected, setWsConnected] = useState(false);
  const [rfNodes, setRfNodes] = useState<RFNode[]>([]);
  const [rfEdges, setRfEdges] = useState<RFEdge[]>([]);
  // The canvas starts LOCKED (read-only: no select / drag / connect) so the
  // map can't be disturbed by accident; the bottom-left lock toggle and the
  // "L" hotkey flip it. interactive = !locked.
  const [locked, setLocked] = useState(true);
  // Whole-map chronological preview (header button) + the node jump it triggers.
  const [timelineOpen, setTimelineOpen] = useState(false);
  const [jump, setJump] = useState<{ nodeId: string; itemId: number } | null>(
    null,
  );
  // Ids currently being dragged — their local position wins over a broker
  // snapshot so an in-flight drag isn't yanked back by a concurrent WS update.
  const draggingIds = useRef<Set<string>>(new Set());
  // Ids currently being resized — same idea for dimensions. CRUCIAL: while a
  // node is mid-resize we must NOT rebuild it from the broker snapshot, because
  // that drops React Flow's `selected` flag → NodeResizer (isVisible on
  // selected) unmounts mid-gesture → the live d3-drag handler throws. (This is
  // why resize only crashed on a live map with an active CC pushing WS frames.)
  const resizingIds = useRef<Set<string>>(new Set());
  // Nodes whose content changed in the latest snapshot — flashed (strategy C) after
  // render so the user notices an update WITHOUT the camera jumping to it.
  const pendingFlash = useRef<Set<string>>(new Set());
  // New nodes the broker said landed across another card / an edge — warned
  // (amber) after render so the user can drag them clear. Applied like the
  // strategy-C flash (DOM class, no re-render).
  const pendingOverlap = useRef<Set<string>>(new Set());
  const didFit = useRef(false);
  const rf = useRef<any>(null);
  // The canvas element — used to compute the viewport centre when adding a frame.
  const canvasRef = useRef<HTMLDivElement>(null);
  // Undo stack for deletions. A single Delete can remove node(s) AND their
  // incident edges AND grouping frame(s), so each entry batches them and is
  // restored as a unit (Cmd/Ctrl+Z, or the "Undo" button on the delete toast).
  const undoStack = useRef<
    { nodeIds: string[]; edgeIds: string[]; frameIds: string[]; label: string }[]
  >([]);

  // A cheap content signature so we can flash only the nodes that actually
  // changed between snapshots (title / context / thread tail).
  const sigOf = (n: RFNode["data"], msgs: ThreadItem[]) => {
    // Checklist nodes have no thread; their content lives in checklist_items,
    // so fold each item's id+status+summary length into the signature too (a
    // status change or edit then flashes the node, same as a new message does).
    const cl = (n as any).checklist_items as
      | { id: number; status: string; summary: string }[]
      | undefined;
    const clSig = cl
      ? cl.map((i) => `${i.id}:${i.status}:${i.summary.length}`).join(",")
      : "";
    return `${(n as any).title}\u0000${(n as any).context}\u0000${msgs.length}\u0000${msgs.length ? msgs[msgs.length - 1].id : 0}\u0000${clSig}`;
  };

  // Reconcile RF nodes against a fresh broker snapshot instead of rebuilding
  // them. Reusing the previous node object (spread) keeps React Flow's UI-only
  // state — `selected`, `dragging`, `measured` — so a background WS frame can't
  // deselect a node mid-resize (crash) or drop a measurement (edge flicker).
  // A node the user is actively dragging/resizing keeps its in-flight
  // position + size; everyone else takes the broker's authoritative values.
  const applySnapshot = useCallback((v: MapViewData) => {
    setView(v);
    setRfNodes((prev) => {
      const prevById = new Map(prev.map((n) => [n.id, n]));
      const changed = new Set<string>();
      const next = v.nodes.map((n) => {
        const existing = prevById.get(n.id);
        const messages = v.threads[n.id] ?? [];
        const data = {
          title: n.title,
          context: n.context,
          kind: n.kind,
          messages,
          is_checklist: n.is_checklist,
          checklist_items: n.checklist_items,
          checklist_unread: n.checklist_unread,
          checklist_version: n.checklist_version,
        };
        if (existing && sigOf(existing.data, (existing.data as any).messages ?? []) !== sigOf(data as any, messages)) {
          changed.add(n.id);
        }
        const inflight =
          (draggingIds.current.has(n.id) || resizingIds.current.has(n.id)) &&
          !!existing;
        if (inflight) {
          // Keep the user's in-progress geometry; only refresh content.
          return { ...existing!, id: n.id, type: "mapCard", data } as RFNode;
        }
        return {
          ...(existing ?? {}),
          id: n.id,
          type: "mapCard",
          position: { x: n.x, y: n.y },
          data,
          width: n.w ?? NODE_W_DEFAULT,
          height: n.h ?? NODE_H_DEFAULT,
          style: { width: n.w ?? NODE_W_DEFAULT, height: n.h ?? NODE_H_DEFAULT },
        } as RFNode;
      });
      // Stash changed ids for the post-render flash effect (strategy C). Done inside
      // the updater so `changed` is actually computed (React defers updaters).
      // Skip the first paint — only live updates glow.
      if (didFit.current) for (const id of changed) pendingFlash.current.add(id);
      // Grouping frames — packed as RF nodes of type "frame" with a low zIndex
      // (CSS forces -1) so they render BEHIND the cards/edges. Reconciled by id
      // like cards (preserve selected / in-flight geometry through WS snapshots).
      // Frame ids never collide with node ids, so the same prevById map is safe.
      const frameNodes = (v.frames ?? []).map((f) => {
        const existing = prevById.get(f.id);
        const fdata = { title: f.title, color: f.color, frame: true };
        const inflight =
          (draggingIds.current.has(f.id) || resizingIds.current.has(f.id)) &&
          !!existing;
        if (inflight) {
          return { ...existing!, id: f.id, type: "frame", data: fdata, zIndex: -1 } as RFNode;
        }
        return {
          ...(existing ?? {}),
          id: f.id,
          type: "frame",
          position: { x: f.x, y: f.y },
          data: fdata,
          width: f.w,
          height: f.h,
          style: { width: f.w, height: f.h },
          zIndex: -1,
        } as RFNode;
      });
      // Frames first in the array (belt-and-suspenders with zIndex) so they paint
      // behind everything else.
      return [...frameNodes, ...next];
    });
    setRfEdges((prev) => mergeEdges(prev, v));
  }, []);

  const fetchMap = useCallback(async () => {
    try {
      const r = await fetch(`/api/map/${mapId}`);
      if (r.status === 404) {
        setNotFound(true);
        return;
      }
      if (!r.ok) return;
      const v = (await r.json()) as MapViewData;
      applySnapshot(v);
    } catch {
      /* transient — WS reconnect will retry */
    }
  }, [mapId, applySnapshot]);

  // Browser-tab breadcrumb title (shared hook — same format on every page).
  useDocumentTitle([
    view?.owner_session_name,
    view ? view.map.title || t("map.untitled") : undefined,
  ]);

  // Initial load + WS subscription (refetch on any map / thread update).
  useEffect(() => {
    didFit.current = false;
    fetchMap();
    let ws: WebSocket | null = null;
    let closed = false;
    let retry: ReturnType<typeof setTimeout> | null = null;
    const connect = () => {
      if (closed) return;
      const proto = location.protocol === "https:" ? "wss" : "ws";
      ws = new WebSocket(`${proto}://${location.host}/ws/${mapId}`);
      ws.onopen = () => setWsConnected(true);
      ws.onclose = () => {
        setWsConnected(false);
        if (!closed) retry = setTimeout(connect, 1500);
      };
      ws.onmessage = (ev) => {
        // Any frame (map-update / thread-update) means refetch the snapshot —
        // that also refreshes the header's owner_stalled chip.
        fetchMap();
        // A stall update also drives the sidebar's per-session warning, which
        // (on a map page) only this socket can nudge.
        try {
          const msg = JSON.parse(ev.data as string);
          if (msg?.type === "session-stall-update") {
            window.dispatchEvent(new Event("pd-sidebar-refresh"));
          } else if (
            msg?.type === "map-node-overlap" &&
            typeof msg.node_id === "string"
          ) {
            // A freshly-placed node landed across another card / an edge. Queue
            // a transient warning flash applied once the node has rendered (the
            // fetchMap above brings it in) — see the pendingOverlap effect.
            pendingOverlap.current.add(msg.node_id);
          }
        } catch {
          /* non-JSON frame — ignore */
        }
      };
    };
    connect();
    return () => {
      closed = true;
      if (retry) clearTimeout(retry);
      try {
        ws?.close();
      } catch {
        /* ignore */
      }
    };
  }, [mapId, fetchMap]);

  // Fit the view once, after the first non-empty snapshot renders. React Flow
  // measures node sizes asynchronously, so a single early fitView can fit to a
  // zero-size bounding box (zoomed way in). Retry a few times until the fit
  // sticks, then stop touching the camera (the user owns it after that).
  useEffect(() => {
    if (didFit.current || rfNodes.length === 0) return;
    let tries = 0;
    const attempt = () => {
      if (didFit.current) return;
      tries++;
      try {
        rf.current?.fitView({ duration: 200, padding: 0.25 });
      } catch {
        /* not ready yet */
      }
      if (tries >= 4) {
        didFit.current = true;
      } else {
        setTimeout(attempt, 120);
      }
    };
    const id = setTimeout(attempt, 120);
    return () => clearTimeout(id);
  }, [rfNodes.length]);

  // strategy C — flash changed nodes after the snapshot paints. Toggling a class on
  // the already-mounted DOM node (keyed by React Flow's data-id) avoids a
  // re-render/remount, so the camera never moves: the update just glows.
  useEffect(() => {
    if (pendingFlash.current.size === 0) return;
    const ids = Array.from(pendingFlash.current);
    pendingFlash.current.clear();
    const timers: ReturnType<typeof setTimeout>[] = [];
    for (const id of ids) {
      const el = document.querySelector(`.react-flow__node[data-id="${CSS.escape(id)}"]`);
      if (!el) continue;
      el.classList.remove("map-node-flash");
      // force reflow so re-adding the class restarts the animation
      void (el as HTMLElement).offsetWidth;
      el.classList.add("map-node-flash");
      timers.push(
        setTimeout(() => el.classList.remove("map-node-flash"), 1400),
      );
    }
    return () => timers.forEach(clearTimeout);
  }, [rfNodes]);

  // Overlap warning — a new node landed across another card / an edge. Same
  // DOM-class approach as the flash, but longer (3.5s) and amber, so the user
  // notices and can drag it clear. Drained once the node is in the DOM.
  useEffect(() => {
    if (pendingOverlap.current.size === 0) return;
    const ids = Array.from(pendingOverlap.current);
    const timers: ReturnType<typeof setTimeout>[] = [];
    const applied: string[] = [];
    for (const id of ids) {
      const el = document.querySelector(`.react-flow__node[data-id="${CSS.escape(id)}"]`);
      if (!el) continue; // not rendered yet — leave it queued for the next paint
      pendingOverlap.current.delete(id);
      applied.push(id);
      el.classList.remove("map-node-overlap-warn");
      void (el as HTMLElement).offsetWidth;
      el.classList.add("map-node-overlap-warn");
      timers.push(
        setTimeout(() => el.classList.remove("map-node-overlap-warn"), 3500),
      );
    }
    return () => timers.forEach(clearTimeout);
  }, [rfNodes]);

  // Center + zoom the canvas onto a node and flash it. Used after the timeline
  // preview closes: a message there can live on a tiny, far-off card, and the
  // user couldn't tell WHICH one — this pans to it, enlarges it, and glows it.
  const focusNode = useCallback((nodeId: string) => {
    rf.current?.fitView({
      nodes: [{ id: nodeId }],
      duration: 600,
      padding: 0.35,
      maxZoom: 1.2,
    });
    const el = document.querySelector(
      `.react-flow__node[data-id="${CSS.escape(nodeId)}"]`,
    );
    if (!el) return;
    el.classList.remove("map-node-flash");
    void (el as HTMLElement).offsetWidth; // restart the animation
    el.classList.add("map-node-flash");
    setTimeout(() => el.classList.remove("map-node-flash"), 1600);
  }, []);

  // "L" toggles the canvas lock (OS-safe: bare key, ignored while typing or
  // when a modifier is held so it never collides with browser/OS shortcuts).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key !== "l" && e.key !== "L") return;
      const t = e.target as HTMLElement | null;
      const tag = t?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || t?.isContentEditable) return;
      e.preventDefault();
      setLocked((v) => !v);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const onNodesChange = useCallback((changes: NodeChange[]) => {
    for (const c of changes) {
      if (c.type === "position" && "dragging" in c) {
        if (c.dragging) draggingIds.current.add(c.id);
        else draggingIds.current.delete(c.id);
      }
      // React Flow flags resize drags with `resizing` on dimension changes.
      if (c.type === "dimensions" && "resizing" in c && c.id) {
        if ((c as any).resizing) resizingIds.current.add(c.id);
        else resizingIds.current.delete(c.id);
      }
    }
    setRfNodes((ns) => applyNodeChanges(changes, ns));
  }, []);

  const onEdgesChange = useCallback((changes: EdgeChange[]) => {
    // Local visual state only. Edge deletes are persisted + made undoable in
    // onDelete (which fires with the node and its incident edges together);
    // reconnects persist in onReconnect. So nothing to persist here.
    setRfEdges((es) => applyEdgeChanges(changes, es));
  }, []);

  const onNodeDragStop = useCallback(
    (_e: any, node: RFNode) => {
      draggingIds.current.delete(node.id);
      if (node.type === "frame") {
        // Frames persist via their own endpoint (they're not map_nodes).
        postMapUpdateFrame(mapId, node.id, {
          x: Math.round(node.position.x),
          y: Math.round(node.position.y),
        }).catch(() => {});
        return;
      }
      postMapMoveNode(
        mapId,
        node.id,
        Math.round(node.position.x),
        Math.round(node.position.y),
      ).catch(() => {});
    },
    [mapId],
  );

  const onConnect = useCallback(
    (params: Connection) => {
      if (!params.source || !params.target) return;
      // Optimistic edge; the broker broadcast + refetch will reconcile the id.
      setRfEdges((es) =>
        es.concat([
          {
            id: `tmp-${params.source}-${params.target}`,
            source: params.source!,
            target: params.target!,
          },
        ]),
      );
      postMapConnect(mapId, params.source, params.target).catch(() => {});
    },
    [mapId],
  );

  // Drag an edge's endpoint to a different node = reconnect: drop the
  // old edge, draw the new one. The broker broadcast + refetch reconciles ids.
  const onReconnect = useCallback(
    (oldEdge: RFEdge, conn: any) => {
      if (!conn.source || !conn.target) return;
      postMapDisconnect(mapId, oldEdge.id).catch(() => {});
      postMapConnect(mapId, conn.source, conn.target).catch(() => {});
      setRfEdges((es) => reconnectEdge(oldEdge, conn, es));
    },
    [mapId],
  );

  // Restore a batched deletion (node(s) + their edges + frame(s)): un-tombstone
  // on the broker, then refetch so the canvas shows them again.
  const restoreEntry = useCallback(
    (entry: {
      nodeIds: string[];
      edgeIds: string[];
      frameIds: string[];
      label: string;
    }) => {
      const i = undoStack.current.indexOf(entry);
      if (i >= 0) undoStack.current.splice(i, 1);
      const jobs: Promise<unknown>[] = [];
      if (entry.nodeIds.length || entry.edgeIds.length) {
        jobs.push(
          postMapRestore(mapId, {
            nodeIds: entry.nodeIds,
            edgeIds: entry.edgeIds,
          }),
        );
      }
      for (const id of entry.frameIds) jobs.push(postMapRestoreFrame(mapId, id));
      Promise.all(jobs)
        .then(() => fetchMap())
        .catch(() => {});
      showToast(t("map.restored"), "ok");
    },
    [mapId, fetchMap, t],
  );

  // Add a grouping frame at the current viewport centre. User-only (the AI
  // never creates frames); works regardless of lock — but a frame can only be
  // moved/resized once unlocked, like everything else on the canvas.
  const addFrame = useCallback(() => {
    const inst = rf.current;
    const el = canvasRef.current;
    if (!inst || !el) return;
    const rect = el.getBoundingClientRect();
    const w = 380;
    const h = 280;
    const c = inst.screenToFlowPosition({
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
    });
    postMapAddFrame(mapId, {
      x: Math.round(c.x - w / 2),
      y: Math.round(c.y - h / 2),
      w,
      h,
    }).catch(() => {});
  }, [mapId]);

  // A canvas delete (Backspace/Delete) removes the selected node(s) AND their
  // incident edges in one shot — onDelete hands us both together. Persist the
  // logical delete, then stash ONE undo entry so Cmd/Ctrl+Z (or the toast
  // button) brings the whole thing back. (onNodesChange / onEdgesChange still
  // apply the local removal; they no longer persist.)
  const onDelete = useCallback(
    ({ nodes, edges }: { nodes: RFNode[]; edges: RFEdge[] }) => {
      // Cards and grouping frames both arrive in `nodes` — split by type so each
      // hits its own delete/restore endpoint.
      const cardNodes = nodes.filter((n) => n.type !== "frame");
      const frameNodes = nodes.filter((n) => n.type === "frame");
      const nodeIds = cardNodes.map((n) => n.id);
      const frameIds = frameNodes.map((n) => n.id);
      const edgeIds = edges.map((e) => e.id);
      if (!nodeIds.length && !edgeIds.length && !frameIds.length) return;
      const label = nodeIds.length
        ? ((cardNodes[0].data as any)?.title as string) || t("map.untitled")
        : frameIds.length
          ? ((frameNodes[0].data as any)?.title as string) ||
            t("map.frame_untitled")
          : "";
      const entry = { nodeIds, edgeIds, frameIds, label };
      // Persist EVERY delete BEFORE exposing the undo entry. Otherwise an
      // immediate Cmd+Z could fire /map-restore before a still-in-flight delete
      // POST lands, and that late delete would re-tombstone the row (a silent,
      // partial-restore failure). The card already vanished locally via
      // onNodesChange, so this only delays the toast + undo availability by the
      // round-trip — not the visual removal.
      Promise.all([
        ...nodeIds.map((id) => postMapDeleteNode(mapId, id)),
        ...edgeIds.map((id) => postMapDisconnect(mapId, id)),
        ...frameIds.map((id) => postMapDeleteFrame(mapId, id)),
      ])
        .then(() => {
          undoStack.current.push(entry);
          const msg = nodeIds.length
            ? t("map.deleted_node", { title: label })
            : frameIds.length
              ? t("map.deleted_frame")
              : t("map.deleted_edge");
          showToast(msg, "ok", {
            label: t("map.undo_delete"),
            onClick: () => restoreEntry(entry),
          });
        })
        .catch(() => {});
    },
    [mapId, t, restoreEntry],
  );

  // Cmd/Ctrl+Z = undo the most recent deletion. Ignored while typing (so it
  // doesn't hijack text undo in an input); shift is reserved for a future redo.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.shiftKey) return;
      if (e.key !== "z" && e.key !== "Z") return;
      const tgt = e.target as HTMLElement | null;
      const tag = tgt?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tgt?.isContentEditable) return;
      const entry = undoStack.current.pop();
      if (!entry) return;
      e.preventDefault();
      restoreEntry(entry);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [restoreEntry]);

  // Persist a card resize (wired through MapContext → NodeResizer).
  const onResize = useCallback<MapCtx["onResize"]>(
    (nodeId, w, h, x, y) => {
      postMapMoveNode(
        mapId,
        nodeId,
        Math.round(x),
        Math.round(y),
        Math.round(w),
        Math.round(h),
      ).catch(() => {});
    },
    [mapId],
  );

  const ownerAlive = view?.owner_alive !== false;
  const ctx: MapCtx | null = useMemo(
    () =>
      view
        ? {
            mapId,
            sessionId: view.map.session_id,
            ownerAlive,
            locked,
            onResize,
          }
        : null,
    [mapId, view, ownerAlive, locked, onResize],
  );

  if (notFound) {
    return (
      <div className="app">
        <div className="app-body">
          <Sidebar currentBoardId={null} currentMapId={mapId} />
          <div className="map-missing">{t("map.not_found")}</div>
        </div>
      </div>
    );
  }
  if (!view || !ctx) {
    return (
      <div className="app">
        <div className="app-body">
          <Sidebar currentBoardId={null} currentMapId={mapId} />
          <div className="map-missing">{t("map.loading")}</div>
        </div>
      </div>
    );
  }

  const generalThread = view.threads[MAP_GENERAL_NODE] ?? [];

  return (
    <MapContext.Provider value={ctx}>
      <div className="app">
        <header className="header">
          <a className="breadcrumb" href={`/session/${view.map.session_id}`}>
            {t("header.back_to_session")}
          </a>
          <h1>
            <ChartNetwork
              className="map-title-icon"
              size={18}
              strokeWidth={1.9}
              aria-label={t("map.badge_title")}
            />
            {view.map.title}
          </h1>
          <ContextMeter usage={view.owner_context_usage} prefix="Context: " />
          {!ownerAlive && (
            <span className="owner-warning" title={t("header.owner_warning_title")}>
              {t("header.owner_warning")}
            </span>
          )}
          {view.owner_stalled && (
            <span
              className="header-stall-warning"
              title={t("header.stalled_title")}
            >
              <AlertTriangle size={15} strokeWidth={2.5} />
              <span>{t("header.stalled")}</span>
            </span>
          )}
          <div className="header-right">
            <CliCommandButton
              sessionId={view.map.session_id}
              canCliSend={!!view.owner_can_cli_send}
              busy={
                view.activity?.state === "working" ||
                view.activity?.state === "blocked"
              }
            />
            <button
              type="button"
              className="map-timeline-btn"
              title={t("map.frame_add")}
              aria-label={t("map.frame_add")}
              onClick={addFrame}
            >
              <Frame size={16} strokeWidth={1.9} />
            </button>
            <button
              type="button"
              className="map-timeline-btn"
              title={t("map.timeline_button")}
              aria-label={t("map.timeline_button")}
              onClick={() => setTimelineOpen(true)}
            >
              <ScrollText size={16} strokeWidth={1.9} />
            </button>
            <span className="ws-status">
              <span className={`ws-dot ${wsConnected ? "connected" : ""}`} />
              {wsConnected ? t("header.live") : t("header.offline")}
            </span>
          </div>
        </header>
        <div className="app-body">
          <Sidebar currentBoardId={null} currentMapId={mapId} />
          <div className="map-main">
            <div className="map-canvas" ref={canvasRef}>
              <ReactFlow
                nodes={rfNodes}
                edges={rfEdges}
                nodeTypes={nodeTypes}
                edgeTypes={edgeTypes}
                connectionMode={ConnectionMode.Loose}
                connectionLineComponent={FloatingConnectionLine}
                defaultEdgeOptions={defaultEdgeOptions}
                onNodesChange={onNodesChange}
                onEdgesChange={onEdgesChange}
                onNodeDragStop={onNodeDragStop}
                onConnect={onConnect}
                onReconnect={onReconnect}
                onDelete={onDelete}
                // No delete via keyboard while locked (structure frozen). When
                // unlocked, Backspace/Delete removes the selection; onDelete
                // persists it and makes it undoable (Cmd/Ctrl+Z).
                deleteKeyCode={locked ? null : ["Backspace", "Delete"]}
                onInit={(inst) => {
                  rf.current = inst;
                }}
                nodesDraggable={!locked}
                nodesConnectable={!locked}
                // Stay selectable even when locked, so the card keeps full
                // pointer-events (text selection / scroll / typing / preview).
                // Lock only freezes STRUCTURE: drag (above), connect (above),
                // resize (NodeResizer hidden when locked), and edge edit (below).
                elementsSelectable
                // Clicking an edge selects it; lift the selected edge above the
                // nodes so a path that runs behind an unrelated card is visible
                // (and highlighted by FloatingEdge) end to end.
                elevateEdgesOnSelect
                edgesReconnectable={!locked}
                minZoom={0.15}
                maxZoom={2}
                proOptions={{ hideAttribution: true }}
              >
                <Background gap={24} />
                {/* A CUSTOM lock toggle (not React Flow's built-in interactive
                    button): because elementsSelectable stays true, RF's
                    aggregate isInteractive is always true, so its built-in
                    toggle can't unlock. This one drives our `locked` state
                    directly (and the "L" hotkey does the same). */}
                <Controls showInteractive={false}>
                  <ControlButton
                    onClick={() => setLocked((v) => !v)}
                    title={locked ? t("map.unlock") : t("map.lock")}
                    aria-label={locked ? t("map.unlock") : t("map.lock")}
                  >
                    {locked ? <Lock size={14} /> : <Unlock size={14} />}
                  </ControlButton>
                </Controls>
              </ReactFlow>
            </div>
            <MapGeneralChat
              mapId={mapId}
              sessionId={view.map.session_id}
              ownerAlive={ownerAlive}
              thread={generalThread}
            />
          </div>
        </div>
        {timelineOpen && (
          <MapTimelineModal
            nodes={view.nodes}
            threads={view.threads}
            onJump={(nodeId, itemId) => {
              setTimelineOpen(false);
              setJump({ nodeId, itemId });
            }}
            onClose={() => setTimelineOpen(false)}
          />
        )}
        {jump &&
          (() => {
            const isGeneral = jump.nodeId === MAP_GENERAL_NODE;
            const node = view.nodes.find((n) => n.id === jump.nodeId);
            // The target node was deleted out from under the timeline.
            if (!isGeneral && !node) return null;
            return (
              <MapNodeModal
                mapId={mapId}
                nodeId={jump.nodeId}
                title={
                  isGeneral
                    ? t("map.general_chat")
                    : node!.title || t("map.untitled")
                }
                context={isGeneral ? "" : node!.context}
                kind={isGeneral ? undefined : node!.kind}
                messages={view.threads[jump.nodeId] ?? []}
                ownerAlive={ownerAlive}
                scrollToItemId={jump.itemId}
                onClose={() => {
                  const nid = jump.nodeId;
                  setJump(null);
                  // After reading the message, reveal WHERE it lives: pan/zoom
                  // to its card and flash it. (The general chat has no card.)
                  if (nid !== MAP_GENERAL_NODE) {
                    requestAnimationFrame(() => focusNode(nid));
                  }
                }}
              />
            );
          })()}
      </div>
    </MapContext.Provider>
  );
}

// The map-wide general chat (right panel). Same thread + composer model as a
// board node, posting to the synthetic "__general__" node.
function MapGeneralChat({
  mapId,
  sessionId,
  ownerAlive,
  thread,
}: {
  mapId: string;
  sessionId: string;
  ownerAlive: boolean;
  thread: ThreadItem[];
}) {
  const { t } = useTranslation();
  const [draft, setDraft, clearDraft] = useDraft(mapId, MAP_GENERAL_NODE);
  const [sending, setSending] = useState(false);
  const [uploading, setUploading] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  // Whole-thread preview — the same affordance a node card has: opens the
  // general chat in a MapNodeModal, optionally scrolled to one message.
  const [expanded, setExpanded] = useState(false);
  const [msgTarget, setMsgTarget] = useState<number | null>(null);
  // Auto-read the general chat's CC messages while the panel is on screen
  // (same visible-dwell as board cards; map messages are thread_items).
  useMarkReadOnVisible(bodyRef, thread);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [thread.length]);

  const appendImage = async (files: File[]) => {
    if (!files.length) return;
    setUploading(true);
    try {
      for (const f of files) {
        const { url, path } = await uploadImage(f, mapId);
        setDraft(
          (prev) =>
            `${prev}${prev && !prev.endsWith("\n") ? "\n" : ""}![image](${url})\n[image] [${path}](${url})\n`,
        );
      }
    } catch {
      showToast(t("map.image_failed"), "error");
    } finally {
      setUploading(false);
    }
  };

  const send = async () => {
    const text = draft.trim();
    if (!text || sending || !ownerAlive) return;
    setSending(true);
    clearDraft();
    try {
      const res = await postMapChat(mapId, MAP_GENERAL_NODE, text);
      if (!res.ok) {
        setDraft(text);
        showToast(t("map.send_failed"), "error");
      }
    } catch {
      setDraft(text);
      showToast(t("map.send_failed"), "error");
    } finally {
      setSending(false);
    }
  };

  return (
    <aside className="map-chat">
      <div className="map-chat-head">
        <span>{t("map.general_chat")}</span>
        {/* Expand the whole general chat into a full preview modal (matches a
            node card's expand button). */}
        <button
          type="button"
          className="map-node-expand"
          title={t("map.expand_node")}
          onClick={() => {
            setMsgTarget(null);
            setExpanded(true);
          }}
        >
          <Maximize2 size={14} strokeWidth={1.75} />
        </button>
      </div>
      <div className="map-chat-body" ref={bodyRef}>
        <p className="map-chat-note">{t("map.general_chat_note")}</p>
        {thread.map((it) => (
          <ThreadMessage
            key={it.id}
            item={it}
            boardId={mapId}
            nodeId={MAP_GENERAL_NODE}
            sessionId={sessionId}
            enableAnchor={false}
            onExpand={(it) => {
              setMsgTarget(it.id);
              setExpanded(true);
            }}
          />
        ))}
        <div ref={bottomRef} />
      </div>
      <div className="map-chat-input">
        <textarea
          value={draft}
          rows={2}
          disabled={!ownerAlive}
          placeholder={
            ownerAlive ? t("map.chat_placeholder") : t("map.input_disabled")
          }
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
              e.preventDefault();
              send();
            }
          }}
          onPaste={(e) => {
            const imgs = extractImageFiles(e.clipboardData?.items ?? null);
            if (imgs.length) {
              e.preventDefault();
              appendImage(imgs);
            }
          }}
          onDrop={(e) => {
            const imgs = extractImageFiles(e.dataTransfer?.files ?? null);
            if (imgs.length) {
              e.preventDefault();
              appendImage(imgs);
            }
          }}
        />
        <div className="map-chat-send-row">
          <button
            type="button"
            disabled={sending || uploading || !draft.trim() || !ownerAlive}
            onClick={send}
          >
            {uploading ? t("map.uploading") : t("map.send")}
          </button>
        </div>
      </div>
      {expanded && (
        <MapNodeModal
          mapId={mapId}
          nodeId={MAP_GENERAL_NODE}
          title={t("map.general_chat")}
          context=""
          messages={thread}
          ownerAlive={ownerAlive}
          scrollToItemId={msgTarget}
          onClose={() => {
            setExpanded(false);
            setMsgTarget(null);
          }}
        />
      )}
    </aside>
  );
}
