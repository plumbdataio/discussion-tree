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
import { AlertTriangle, ChartNetwork, Lock, Maximize2, Unlock } from "lucide-react";
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
import { MapNodeModal } from "./MapNodeModal.tsx";
import { Sidebar } from "./Sidebar.tsx";
import { ContextMeter } from "./ContextMeter.tsx";
import { ThreadMessage } from "./ThreadMessage.tsx";
import { useDraft } from "../utils/drafts.ts";
import { useMarkReadOnVisible } from "../utils/useMarkReadOnVisible.ts";
import { useDocumentTitle } from "../utils/useDocumentTitle.ts";
import {
  extractImageFiles,
  postMapChat,
  postMapConnect,
  postMapDeleteNode,
  postMapDisconnect,
  postMapMoveNode,
  postMapRestore,
  uploadImage,
} from "../utils/api.ts";
import { showToast } from "./Toast.tsx";

const NODE_W_DEFAULT = 320;
const NODE_H_DEFAULT = 340;

// Stable type maps (React Flow warns if these identities change each render).
const nodeTypes = { mapCard: MapNode };
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
  const didFit = useRef(false);
  const rf = useRef<any>(null);
  // Undo stack for deletions. A single Delete can remove a node AND its
  // incident edges, so each entry batches them and is restored as a unit
  // (Cmd/Ctrl+Z, or the "Undo" button on the delete toast).
  const undoStack = useRef<
    { nodeIds: string[]; edgeIds: string[]; label: string }[]
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
      return next;
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
      const el = document.querySelector(`.react-flow__node[data-id="${id}"]`);
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

  // Restore a batched deletion (node(s) + their edges): un-tombstone on the
  // broker, then refetch so the canvas shows them again.
  const restoreEntry = useCallback(
    (entry: { nodeIds: string[]; edgeIds: string[]; label: string }) => {
      const i = undoStack.current.indexOf(entry);
      if (i >= 0) undoStack.current.splice(i, 1);
      postMapRestore(mapId, { nodeIds: entry.nodeIds, edgeIds: entry.edgeIds })
        .then(() => fetchMap())
        .catch(() => {});
      showToast(t("map.restored"), "ok");
    },
    [mapId, fetchMap, t],
  );

  // A canvas delete (Backspace/Delete) removes the selected node(s) AND their
  // incident edges in one shot — onDelete hands us both together. Persist the
  // logical delete, then stash ONE undo entry so Cmd/Ctrl+Z (or the toast
  // button) brings the whole thing back. (onNodesChange / onEdgesChange still
  // apply the local removal; they no longer persist.)
  const onDelete = useCallback(
    ({ nodes, edges }: { nodes: RFNode[]; edges: RFEdge[] }) => {
      const nodeIds = nodes.map((n) => n.id);
      const edgeIds = edges.map((e) => e.id);
      if (!nodeIds.length && !edgeIds.length) return;
      const label = nodeIds.length
        ? ((nodes[0].data as any)?.title as string) || t("map.untitled")
        : "";
      const entry = { nodeIds, edgeIds, label };
      // Persist EVERY delete BEFORE exposing the undo entry. Otherwise an
      // immediate Cmd+Z could fire /map-restore before a still-in-flight delete
      // POST lands, and that late delete would re-tombstone the row (a silent,
      // partial-restore failure). The card already vanished locally via
      // onNodesChange, so this only delays the toast + undo availability by the
      // round-trip — not the visual removal.
      Promise.all([
        ...nodeIds.map((id) => postMapDeleteNode(mapId, id)),
        ...edgeIds.map((id) => postMapDisconnect(mapId, id)),
      ])
        .then(() => {
          undoStack.current.push(entry);
          showToast(
            nodeIds.length
              ? t("map.deleted_node", { title: label })
              : t("map.deleted_edge"),
            "ok",
            { label: t("map.undo_delete"), onClick: () => restoreEntry(entry) },
          );
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
            <span className="ws-status">
              <span className={`ws-dot ${wsConnected ? "connected" : ""}`} />
              {wsConnected ? t("header.live") : t("header.offline")}
            </span>
          </div>
        </header>
        <div className="app-body">
          <Sidebar currentBoardId={null} currentMapId={mapId} />
          <div className="map-main">
            <div className="map-canvas">
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
