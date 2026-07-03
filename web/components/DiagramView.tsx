import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import mermaid from "mermaid";
import panzoom from "panzoom";
import { useTranslation } from "react-i18next";
import {
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  Maximize2,
  Shrink,
  X,
} from "lucide-react";
import { DiagramIcon } from "./DiagramIcon.tsx";
import { MDView } from "./MDView.tsx";
import type { Activity, ThreadItem } from "../../shared/types.ts";
import { AppLayout } from "./AppShell.tsx";
import { ContextMeter } from "./ContextMeter.tsx";
import { ActivityBadge } from "./ActivityBadge.tsx";
import { CliCommandButton } from "./CliCommandButton.tsx";
import { useHeaderActivity } from "../utils/useHeaderActivity.ts";
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
    context: string;
    created_at: string;
    updated_at: string;
  };
  thread: ThreadItem[];
  activity?: Activity | null;
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

  // Zoom/pan hint — a custom tooltip with a deliberately long hover delay. The
  // native `title` showed after ~1s (browser-controlled, not adjustable) which
  // felt too eager. Native-like behaviour: it appears only after the pointer
  // rests ~2.5s and hides the moment it moves or leaves, so it never shows
  // mid-pan.
  const [hintShown, setHintShown] = useState(false);
  const hintTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const armHint = () => {
    if (hintTimer.current) clearTimeout(hintTimer.current);
    setHintShown(false); // hide while moving; re-show after the pointer rests
    hintTimer.current = setTimeout(() => setHintShown(true), 2500);
  };
  const clearHint = () => {
    if (hintTimer.current) clearTimeout(hintTimer.current);
    hintTimer.current = null;
    setHintShown(false);
  };
  useEffect(
    () => () => {
      if (hintTimer.current) clearTimeout(hintTimer.current);
    },
    [],
  );

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
      // CJK wrapping. mermaid sizes a flowchart node from its measured label and
      // caps the label at wrappingWidth, BUT the label markup is a table-cell
      // div with inline `white-space: nowrap`, so by default it never wraps — and
      // CJK has no spaces, so mermaid's space-based SVG wrap never kicks in
      // either (the old workaround set wrappingWidth huge → every node became one
      // long line). Fix: a readable wrap width PLUS a themeCSS override forcing
      // `white-space: normal` on the label. themeCSS is injected into the SVG
      // that mermaid measures against, so the node box is sized to the WRAPPED
      // text (a post-render stylesheet would wrap the text but leave the box at
      // its nowrap width). `overflow-wrap: anywhere` breaks an over-long
      // unbreakable run (e.g. a URL); CJK already breaks per character.
      // (htmlLabels stays the mermaid default of HTML <foreignObject> labels —
      // set explicitly to document that the themeCSS above depends on it; it
      // renders under securityLevel:strict here, confirmed in the DOM.)
      flowchart: { wrappingWidth: 220, htmlLabels: true },
      // Same wrap fix for EDGE labels: mermaid has no wrappingWidth for edges, so
      // a long CJK edge label renders as one line and gets clipped by its band.
      // Force wrap + a max-width so the label wraps and mermaid measures/sizes the
      // band (and htmlLabels foreignObject) against the wrapped text, like nodes.
      // word-break:auto-phrase = the browser's Japanese phrase-based line breaking
      // (bunsetsu boundaries), so CJK wraps at natural points instead of mid-word
      // like overflow-wrap:anywhere does. overflow-wrap stays as the fallback for
      // an unbreakable run (e.g. a long URL).
      themeCSS:
        ".nodeLabel, .nodeLabel p, .edgeLabel, .edgeLabel p { white-space: normal !important; word-break: auto-phrase; overflow-wrap: anywhere; } .edgeLabel { max-width: 220px; }",
    });
    let cancelled = false;
    // Wait for webfonts before rendering so CJK glyph metrics are final at
    // measure time (a render before the font loads measures with a fallback and
    // mis-sizes the boxes). The sequence guard drops a stale render if `source`
    // changed mid-flight; `cancelled` drops it if the effect was torn down.
    document.fonts.ready
      .then(() => {
        if (cancelled || seq !== renderSeq.current) return undefined;
        return mermaid.render(`dg-render-${seq}`, source);
      })
      .then((res) => {
        if (!res || cancelled || seq !== renderSeq.current) return;
        setSvg(res.svg);
        setError(null);
      })
      .catch((e) => {
        if (cancelled || seq !== renderSeq.current) return;
        setError(String(e?.message ?? e));
        setSvg("");
      });
    return () => {
      cancelled = true;
    };
  }, [source]);

  // Inject the rendered SVG into the canvas IMPERATIVELY (not via
  // dangerouslySetInnerHTML) and attach wheel-zoom + drag-pan. This subtree is
  // owned by mermaid + panzoom, NOT React: if React managed it, an unrelated
  // re-render (a chat/thread update that doesn't touch `source`) would recreate
  // the <svg> node and silently detach panzoom — leaving zoom/pan dead until
  // the next source change. Keyed on `svg`, so it runs once per render and the
  // node stays put across every other re-render. Double-click resets (handler
  // on the canvas div).
  useEffect(() => {
    pzRef.current?.dispose();
    pzRef.current = null;
    const host = canvasRef.current;
    if (!host) return;
    if (!svg) {
      host.innerHTML = "";
      return;
    }
    host.innerHTML = svg;
    const el = host.querySelector("svg") as SVGElement | null;
    if (!el) return;
    el.style.maxWidth = "none";
    try {
      // Double-click keeps panzoom's default (a light zoom-in). We deliberately
      // do NOT reset the view on double-click: an accidental double-click wiping
      // the user's carefully-framed zoom/pan is far more annoying than a small
      // zoom (which is trivial to undo), so reset is intentionally absent.
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

  // The owning session's live working/blocked chip (same source as the sidebar
  // + board header). Called unconditionally so the hook order is stable.
  const headerActivity = useHeaderActivity(
    view?.diagram.session_id,
    view?.activity,
  );

  // Loading / not-found render the SAME shell (header bar + sidebar) as the
  // loaded page — only the main pane changes — so the header doesn't pop in
  // after the fetch and the layout doesn't shift.
  if (notFound || !view) {
    return (
      <AppLayout
        header={
          <header className="header">
            <span className="breadcrumb">{t("header.back_to_session")}</span>
            <h1>
              <DiagramIcon
                className="diagram-title-icon"
                size={18}
                strokeWidth={1.9}
              />
              {t("map.loading")}
            </h1>
            <div className="header-right">
              <span className="ws-status">
                <span className="ws-dot" />
                {t("header.offline")}
              </span>
            </div>
          </header>
        }
      >
        <div className="diagram-main">
          <div className="diagram-canvas-wrap">
            <div className="map-missing">
              {notFound ? t("diagram.not_found") : t("map.loading")}
            </div>
          </div>
        </div>
      </AppLayout>
    );
  }

  const ownerAlive = view.owner_alive !== false;

  return (
    <AppLayout
      header={
        <header className="header">
        <a className="breadcrumb" href={`/session/${view.diagram.session_id}`}>
          {t("header.back_to_session")}
        </a>
        <h1>
          <DiagramIcon
            className="diagram-title-icon"
            size={18}
            strokeWidth={1.9}
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
        {headerActivity && <ActivityBadge activity={headerActivity} />}
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
      }
    >
        <div className="diagram-main">
          <div className="diagram-left">
            {view.diagram.context.trim() && (
              <DiagramContextBar context={view.diagram.context} />
            )}
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
                  onMouseEnter={armHint}
                  onMouseMove={armHint}
                  onMouseLeave={clearHint}
                  // The SVG is injected imperatively in the [svg] effect (mermaid
                  // sanitizes with securityLevel:strict) so React never recreates
                  // it on an unrelated re-render and detaches panzoom.
                />
              )}
              {!error && hintShown && (
                <div className="diagram-zoom-hint">{t("diagram.zoom_hint")}</div>
              )}
            </div>
          </div>
          <DiagramChat
            diagramId={diagramId}
            sessionId={view.diagram.session_id}
            ownerAlive={ownerAlive}
            thread={view.thread}
          />
        </div>
    </AppLayout>
  );
}

// A compact description / background bar at the top of the diagram. CC writes
// it via upsert_diagram(context); there's no user edit path. The diagonal-arrows
// button opens the full markdown in a modal, mirroring the expand affordance on
// board / map nodes.
function DiagramContextBar({ context }: { context: string }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  // Collapsed = fold the whole bar to a thin strip so the canvas gets the full
  // height. Persisted globally (the user folds it to reclaim screen space and
  // wants it to stay that way across diagrams / reloads).
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem("pd-diagram-context-collapsed") === "1";
    } catch {
      return false;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(
        "pd-diagram-context-collapsed",
        collapsed ? "1" : "0",
      );
    } catch {
      /* private mode — non-fatal */
    }
  }, [collapsed]);
  useEffect(() => {
    if (!expanded) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setExpanded(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [expanded]);
  return (
    <div className={`diagram-context${collapsed ? " collapsed" : ""}`}>
      <div className="diagram-context-controls">
        <button
          type="button"
          className="diagram-context-btn"
          title={collapsed ? t("diagram.context_show") : t("diagram.context_hide")}
          aria-label={
            collapsed ? t("diagram.context_show") : t("diagram.context_hide")
          }
          onClick={() => setCollapsed((c) => !c)}
        >
          {collapsed ? (
            <ChevronDown size={15} strokeWidth={1.9} />
          ) : (
            <ChevronUp size={15} strokeWidth={1.9} />
          )}
        </button>
        {!collapsed && (
          <button
            type="button"
            className="diagram-context-btn"
            title={t("diagram.context_expand")}
            aria-label={t("diagram.context_expand")}
            onClick={() => setExpanded(true)}
          >
            <Maximize2 size={14} strokeWidth={1.75} />
          </button>
        )}
      </div>
      {collapsed ? (
        <button
          type="button"
          className="diagram-context-collapsed-label"
          onClick={() => setCollapsed(false)}
          title={t("diagram.context_show")}
        >
          {t("diagram.context_label")}
        </button>
      ) : (
        <div className="diagram-context-body">
          <MDView text={context} />
        </div>
      )}
      {expanded &&
        createPortal(
          <div className="modal-backdrop" onClick={() => setExpanded(false)}>
            <div
              className="modal-content diagram-context-modal"
              onClick={(e) => e.stopPropagation()}
            >
              <button
                className="modal-close"
                onClick={() => setExpanded(false)}
                aria-label={t("modal.close")}
                title={t("modal.close")}
              >
                <X size={18} strokeWidth={1.75} />
              </button>
              <MDView text={context} />
            </div>
          </div>,
          document.body,
        )}
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
