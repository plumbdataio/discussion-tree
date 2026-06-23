import React, { useEffect, useRef, useState } from "react";
import mermaid from "mermaid";
import panzoom from "panzoom";
import { useTranslation } from "react-i18next";
import { AlertTriangle, Maximize2, Shrink, Workflow } from "lucide-react";
import type { ThreadItem } from "../../shared/types.ts";
import { Sidebar } from "./Sidebar.tsx";
import { ContextMeter } from "./ContextMeter.tsx";
import { CliCommandButton } from "./CliCommandButton.tsx";
import { ThreadMessage } from "./ThreadMessage.tsx";
import { MapNodeModal } from "./MapNodeModal.tsx";
import { useDraft } from "../utils/drafts.ts";
import { useMarkReadOnVisible } from "../utils/useMarkReadOnVisible.ts";
import { useDocumentTitle } from "../utils/useDocumentTitle.ts";
import {
  extractImageFiles,
  postDiagramChat,
  uploadImage,
} from "../utils/api.ts";
import { showToast } from "./Toast.tsx";

// Synthetic node id for the diagram's chat thread (matches the broker's
// DIAGRAM_CHAT_NODE so thread_items / read-state line up).
const DIAGRAM_CHAT_NODE = "__chat__";

// The shape /api/diagram/:id returns (see broker getDiagramView): the diagram
// row + its chat thread + the same owner_* enrichment a board/map view carries.
interface DiagramViewData {
  diagram: {
    id: string;
    session_id: string;
    title: string;
    source: string;
    created_at: string;
    updated_at: string;
  };
  thread: ThreadItem[];
  activity?: { state: string } | null;
  owner_alive?: boolean;
  owner_stalled?: boolean;
  owner_compacting?: boolean;
  owner_session_name?: string | null;
  owner_context_usage?: { remaining_pct: number; set_at: string } | null;
  owner_can_cli_send?: boolean;
}

// Read-only Mermaid diagram surface (a 3rd surface alongside boards & maps).
// Reuses the shared .app/.header/.sidebar chrome and the map's right-hand chat
// panel so a diagram feels like the rest of dt. The source is owned by CC via
// the upsert_diagram MCP tool; this page renders it and live-re-renders on the
// diagram's WS channel whenever CC upserts. The right chat lets the user ask CC
// to edit it (→ upsert → live re-render).
export function DiagramView({ diagramId }: { diagramId: string }) {
  const { t } = useTranslation();
  const [view, setView] = useState<DiagramViewData | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [svg, setSvg] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [wsConnected, setWsConnected] = useState(false);
  const renderSeq = useRef(0);
  const canvasRef = useRef<HTMLDivElement>(null);
  const pzRef = useRef<{
    dispose: () => void;
    moveTo: (x: number, y: number) => void;
    zoomAbs: (x: number, y: number, z: number) => void;
  } | null>(null);

  const source = view?.diagram?.source ?? null;

  const fetchDiagram = () => {
    fetch(`/api/diagram/${diagramId}`)
      .then((r) => {
        if (r.status === 404) {
          setNotFound(true);
          return null;
        }
        return r.ok ? r.json() : Promise.reject(r.status);
      })
      .then((j: DiagramViewData | null) => {
        if (!j) return;
        setView(j);
        setNotFound(false);
      })
      .catch(() => {
        /* transient — the WS reconnect will retry */
      });
  };

  useEffect(fetchDiagram, [diagramId]);

  // Browser-tab breadcrumb (same format as every other page).
  useDocumentTitle([
    view?.owner_session_name,
    view ? view.diagram.title || t("diagram.untitled") : undefined,
  ]);

  // Live update + reconnect: the broker broadcasts on the diagram's id channel
  // (diagram-update on upsert, thread-update on a chat post, diagram-deleted on
  // delete). Mirror the map's resilient connect/retry so a freeze/resume or a
  // broker bounce re-subscribes instead of going silent.
  useEffect(() => {
    let ws: WebSocket | null = null;
    let closed = false;
    let retry: ReturnType<typeof setTimeout> | null = null;
    const connect = () => {
      if (closed) return;
      const proto = location.protocol === "https:" ? "wss" : "ws";
      ws = new WebSocket(`${proto}://${location.host}/ws/${diagramId}`);
      ws.onopen = () => setWsConnected(true);
      ws.onclose = () => {
        setWsConnected(false);
        if (!closed) retry = setTimeout(connect, 1500);
      };
      ws.onmessage = (e) => {
        try {
          const m = JSON.parse(e.data as string);
          if (m?.type === "diagram-update" || m?.type === "thread-update") {
            fetchDiagram();
          } else if (m?.type === "diagram-deleted") {
            setNotFound(true);
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
        /* race with teardown */
      }
    };
  }, [diagramId]);

  // Render the Mermaid source to SVG whenever it changes. The render is async
  // and the source can change again mid-flight (a fresh upsert), so a sequence
  // guard drops stale results. Parse failures surface as an inline error.
  useEffect(() => {
    if (source == null) return;
    const seq = ++renderSeq.current;
    const dark = document.documentElement.dataset.theme === "dark";
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme: dark ? "dark" : "default",
    });
    mermaid
      .render(`dg-render-${seq}`, source)
      .then(({ svg }) => {
        if (seq !== renderSeq.current) return;
        setSvg(svg);
        setError(null);
      })
      .catch((e) => {
        if (seq !== renderSeq.current) return;
        setError(String(e?.message ?? e));
        setSvg("");
      });
  }, [source]);

  // Wheel-zoom + drag-pan the rendered SVG. Re-attach whenever the SVG is
  // replaced (a fresh render). Double-click (handler on the canvas) resets.
  useEffect(() => {
    pzRef.current?.dispose();
    pzRef.current = null;
    if (!svg) return;
    const el = canvasRef.current?.querySelector("svg") as SVGElement | null;
    if (!el) return;
    el.style.maxWidth = "none";
    try {
      pzRef.current = panzoom(el, {
        maxZoom: 8,
        minZoom: 0.2,
        bounds: true,
        boundsPadding: 0.1,
      }) as unknown as typeof pzRef.current;
    } catch {
      /* zoom/pan is an enhancement — never let it break the render */
    }
    return () => {
      pzRef.current?.dispose();
      pzRef.current = null;
    };
  }, [svg]);

  const resetView = () => {
    pzRef.current?.zoomAbs(0, 0, 1);
    pzRef.current?.moveTo(0, 0);
  };

  if (notFound) {
    return (
      <div className="app">
        <div className="app-body">
          <Sidebar currentBoardId={null} currentMapId={null} />
          <div className="map-missing">{t("diagram.not_found")}</div>
        </div>
      </div>
    );
  }
  if (!view) {
    return (
      <div className="app">
        <div className="app-body">
          <Sidebar currentBoardId={null} currentMapId={null} />
          <div className="map-missing">{t("map.loading")}</div>
        </div>
      </div>
    );
  }

  const ownerAlive = view.owner_alive !== false;

  return (
    <div className="app">
      <header className="header">
        <a className="breadcrumb" href={`/session/${view.diagram.session_id}`}>
          {t("header.back_to_session")}
        </a>
        <h1>
          <Workflow
            className="map-title-icon"
            size={18}
            strokeWidth={1.9}
            aria-label={t("diagram.badge_title")}
          />
          {view.diagram.title || t("diagram.untitled")}
        </h1>
        <ContextMeter usage={view.owner_context_usage} prefix="Context: " />
        {!ownerAlive && (
          <span
            className="owner-warning"
            title={t("header.owner_warning_title")}
          >
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
        {view.owner_compacting && !view.owner_stalled && (
          <span
            className="header-compacting-badge"
            title={t("header.compacting_title")}
          >
            <Shrink size={15} strokeWidth={2.5} />
            <span>{t("header.compacting")}</span>
          </span>
        )}
        <div className="header-right">
          <CliCommandButton
            sessionId={view.diagram.session_id}
            canCliSend={!!view.owner_can_cli_send}
            busy={
              view.activity?.state === "working" ||
              view.activity?.state === "blocked"
            }
          />
          <span className="ws-status">
            <span className={`ws-dot ${wsConnected ? "connected" : ""}`} />
            {wsConnected ? t("header.live") : t("header.offline")}
          </span>
        </div>
      </header>
      <div className="app-body">
        <Sidebar currentBoardId={null} currentMapId={null} />
        <div className="diagram-main">
          <div className="diagram-canvas-wrap">
            {error ? (
              <div className="diagram-error">
                <strong>{t("diagram.parse_error")}</strong>
                <pre>{error}</pre>
              </div>
            ) : (
              <div
                ref={canvasRef}
                className="diagram-canvas"
                title={t("diagram.zoom_hint")}
                onDoubleClick={resetView}
                // mermaid sanitizes with securityLevel:strict; the SVG is its output.
                dangerouslySetInnerHTML={{ __html: svg }}
              />
            )}
          </div>
          <DiagramChat
            diagramId={diagramId}
            sessionId={view.diagram.session_id}
            ownerAlive={ownerAlive}
            thread={view.thread}
          />
        </div>
      </div>
    </div>
  );
}

// The diagram's right-hand chat panel — the same thread + composer model as the
// map's general chat (ThreadMessage markdown, image upload, draft persistence,
// mark-read on dwell, whole-thread expand modal), posting to the diagram's
// synthetic "__chat__" node. CC replies by upserting the source (live
// re-render) and/or posting back into this thread.
function DiagramChat({
  diagramId,
  sessionId,
  ownerAlive,
  thread,
}: {
  diagramId: string;
  sessionId: string;
  ownerAlive: boolean;
  thread: ThreadItem[];
}) {
  const { t } = useTranslation();
  const [draft, setDraft, clearDraft] = useDraft(diagramId, DIAGRAM_CHAT_NODE);
  const [sending, setSending] = useState(false);
  const [uploading, setUploading] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  // Whole-thread preview — reuses the map's node modal (with the diagram chat
  // endpoint), optionally scrolled to one message.
  const [expanded, setExpanded] = useState(false);
  const [msgTarget, setMsgTarget] = useState<number | null>(null);
  // Auto-read the chat's CC messages while the panel is on screen.
  useMarkReadOnVisible(bodyRef, thread);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [thread.length]);

  const appendImage = async (files: File[]) => {
    if (!files.length) return;
    setUploading(true);
    try {
      for (const f of files) {
        const { url, path } = await uploadImage(f, diagramId);
        setDraft(
          (prev) =>
            `${prev}${prev && !prev.endsWith("\n") ? "\n" : ""}![image](${url})\n[image] [${path}](${url})\n`,
        );
      }
    } catch {
      showToast(t("diagram.image_failed"), "error");
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
      const res = await postDiagramChat(diagramId, text);
      if (!res.ok) {
        setDraft(text);
        showToast(t("diagram.send_failed"), "error");
      }
    } catch {
      setDraft(text);
      showToast(t("diagram.send_failed"), "error");
    } finally {
      setSending(false);
    }
  };

  return (
    <aside className="map-chat">
      <div className="map-chat-head">
        <span>{t("diagram.chat_title")}</span>
        <button
          type="button"
          className="map-node-expand"
          title={t("diagram.expand_node")}
          onClick={() => {
            setMsgTarget(null);
            setExpanded(true);
          }}
        >
          <Maximize2 size={14} strokeWidth={1.75} />
        </button>
      </div>
      <div className="map-chat-body" ref={bodyRef}>
        <p className="map-chat-note">{t("diagram.chat_note")}</p>
        {thread.map((it) => (
          <ThreadMessage
            key={it.id}
            item={it}
            boardId={diagramId}
            nodeId={DIAGRAM_CHAT_NODE}
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
            ownerAlive
              ? t("diagram.chat_placeholder")
              : t("diagram.input_disabled")
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
            {uploading ? t("diagram.uploading") : t("diagram.send")}
          </button>
        </div>
      </div>
      {expanded && (
        <MapNodeModal
          mapId={diagramId}
          nodeId={DIAGRAM_CHAT_NODE}
          title={t("diagram.chat_title")}
          context=""
          messages={thread}
          ownerAlive={ownerAlive}
          scrollToItemId={msgTarget}
          sendChat={(text) => postDiagramChat(diagramId, text)}
          onClose={() => {
            setExpanded(false);
            setMsgTarget(null);
          }}
        />
      )}
    </aside>
  );
}
