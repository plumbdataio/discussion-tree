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
  ConnectionMode,
  MarkerType,
  applyNodeChanges,
  applyEdgeChanges,
} from "@xyflow/react";
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
import { Sidebar } from "./Sidebar.tsx";
import { ContextMeter } from "./ContextMeter.tsx";
import { ThreadMessage } from "./ThreadMessage.tsx";
import { useDraft } from "../utils/drafts.ts";
import { useMarkReadOnVisible } from "../utils/useMarkReadOnVisible.ts";
import {
  extractImageFiles,
  postMapChat,
  postMapConnect,
  postMapDisconnect,
  postMapMoveNode,
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

function buildEdges(view: MapViewData): RFEdge[] {
  return view.edges.map((e) => ({
    id: e.id,
    source: e.from_id,
    target: e.to_id,
    type: "floating",
    markerEnd: { type: MarkerType.ArrowClosed, width: 18, height: 18 },
  }));
}

export function MapView({ mapId }: { mapId: string }) {
  const { t } = useTranslation();
  const [view, setView] = useState<MapViewData | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [wsConnected, setWsConnected] = useState(false);
  const [rfNodes, setRfNodes] = useState<RFNode[]>([]);
  const [rfEdges, setRfEdges] = useState<RFEdge[]>([]);
  // Ids currently being dragged — their local position wins over a broker
  // snapshot so an in-flight drag isn't yanked back by a concurrent WS update.
  const draggingIds = useRef<Set<string>>(new Set());
  const didFit = useRef(false);
  const rf = useRef<any>(null);

  // Rebuild RF nodes from a fresh broker snapshot, preserving the live position
  // of any node the user is mid-drag on.
  const applySnapshot = useCallback((v: MapViewData) => {
    setView(v);
    setRfNodes((prev) => {
      const prevById = new Map(prev.map((n) => [n.id, n]));
      return v.nodes.map((n) => {
        const keepPos =
          draggingIds.current.has(n.id) && prevById.has(n.id)
            ? prevById.get(n.id)!.position
            : { x: n.x, y: n.y };
        return {
          id: n.id,
          type: "mapCard",
          position: keepPos,
          data: {
            title: n.title,
            context: n.context,
            kind: n.kind,
            messages: v.threads[n.id] ?? [],
          },
          width: n.w ?? NODE_W_DEFAULT,
          height: n.h ?? NODE_H_DEFAULT,
          style: {
            width: n.w ?? NODE_W_DEFAULT,
            height: n.h ?? NODE_H_DEFAULT,
          },
        } as RFNode;
      });
    });
    setRfEdges(buildEdges(v));
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
      ws.onmessage = () => {
        // Any frame (map-update / thread-update) means refetch the snapshot.
        fetchMap();
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

  const onNodesChange = useCallback((changes: NodeChange[]) => {
    for (const c of changes) {
      if (c.type === "position" && "dragging" in c) {
        if (c.dragging) draggingIds.current.add(c.id);
        else draggingIds.current.delete(c.id);
      }
    }
    setRfNodes((ns) => applyNodeChanges(changes, ns));
  }, []);

  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      for (const c of changes) {
        if (c.type === "remove") {
          postMapDisconnect(mapId, c.id).catch(() => {});
        }
      }
      setRfEdges((es) => applyEdgeChanges(changes, es));
    },
    [mapId],
  );

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
            onResize,
          }
        : null,
    [mapId, view, ownerAlive, onResize],
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
            <span className="map-title-badge" title={t("map.badge_title")}>
              {t("map.badge")}
            </span>
            {view.map.title}
          </h1>
          <ContextMeter usage={view.owner_context_usage} prefix="Context: " />
          {!ownerAlive && (
            <span className="owner-warning" title={t("header.owner_warning_title")}>
              {t("header.owner_warning")}
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
                onInit={(inst) => {
                  rf.current = inst;
                }}
                nodesDraggable
                nodesConnectable
                elementsSelectable
                minZoom={0.15}
                maxZoom={2}
                proOptions={{ hideAttribution: true }}
              >
                <Background gap={24} />
                <Controls showInteractive={false} />
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
      <div className="map-chat-head">{t("map.general_chat")}</div>
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
            onExpand={() => {}}
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
    </aside>
  );
}
