// A single map node, rendered as a React Flow custom node. It packs the same
// pieces a dt board node shows — title (headline) → context (markdown) →
// thread (user/cc bubbles) → an input box — into a resizable card whose border
// colour encodes the node kind. This is the "dt node stuffed into a card"
// the design called for.
//
// Per the map v1 requirements the card omits bookmark / timestamp / status /
// (desktop) send-button: ThreadMessage is reused in `compact` mode for that.

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { Handle, Position, NodeResizer, useStore } from "@xyflow/react";
import type { NodeProps } from "@xyflow/react";
import { GripVertical, Maximize2, X } from "lucide-react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import type {
  ChecklistItem,
  MapNodeKind,
  Node,
  ThreadItem,
} from "../../shared/types.ts";
import { MDView } from "./MDView.tsx";
import { ThreadMessage } from "./ThreadMessage.tsx";
import { ScrollToBottomButton } from "./ScrollToBottomButton.tsx";
import { ChecklistCard } from "./ChecklistCard.tsx";
import { MapNodeModal } from "./MapNodeModal.tsx";
import { useDraft } from "../utils/drafts.ts";
import { useMarkReadOnVisible } from "../utils/useMarkReadOnVisible.ts";
import { useVisibleDwell } from "../utils/useVisibleDwell.ts";
import { MAP_READ_ZOOM } from "../utils/readTiming.ts";
import {
  extractImageFiles,
  postMapChat,
  postMapChecklistRead,
  uploadImage,
} from "../utils/api.ts";
import { showToast } from "./Toast.tsx";

// Map-level values shared by every node card. Supplied once by MapView via the
// provider so node.data can stay minimal (good for React Flow's per-node memo).
export interface MapCtx {
  mapId: string;
  sessionId: string;
  ownerAlive: boolean;
  // When the canvas is locked, only structural mutation is frozen (position /
  // size / edges). The card itself stays fully interactive (text select,
  // scroll, type, preview), so the only thing the node needs to know is to
  // hide its resize handles.
  locked: boolean;
  // Persist a resize (the card's new size + position) — wired to NodeResizer.
  onResize: (
    nodeId: string,
    w: number,
    h: number,
    x: number,
    y: number,
  ) => void;
}
export const MapContext = createContext<MapCtx | null>(null);

// The payload MapView packs into each React Flow node's `data`.
export interface MapNodeData {
  title: string;
  context: string;
  kind: MapNodeKind;
  messages: ThreadItem[];
  // A checklist node renders its items (read-only) instead of a thread.
  is_checklist?: number;
  checklist_items?: ChecklistItem[];
  // Node-level unread for a checklist (changed since the user last viewed it).
  checklist_unread?: boolean;
  // Monotonic version the client echoes back when marking read.
  checklist_version?: number;
}


function MapCardComposer({ nodeId }: { nodeId: string }) {
  const { t } = useTranslation();
  const ctx = useContext(MapContext)!;
  const [draft, setDraft, clearDraft] = useDraft(ctx.mapId, nodeId);
  const [sending, setSending] = useState(false);
  const [uploading, setUploading] = useState(false);

  const appendImage = async (files: File[]) => {
    if (files.length === 0) return;
    setUploading(true);
    try {
      for (const f of files) {
        const { url, path } = await uploadImage(f, ctx.mapId);
        setDraft(
          (prev) =>
            `${prev}${prev && !prev.endsWith("\n") ? "\n" : ""}![image](${url})\n[image] [${path}](${url})\n`,
        );
      }
    } catch (e) {
      showToast(t("map.image_failed"), "error");
    } finally {
      setUploading(false);
    }
  };

  const send = async () => {
    const text = draft.trim();
    if (!text || sending || !ctx.ownerAlive) return;
    setSending(true);
    clearDraft();
    try {
      const res = await postMapChat(ctx.mapId, nodeId, text);
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
    <div className="map-card-input">
      <textarea
        className="map-node-input nodrag nopan nowheel"
        value={draft}
        rows={1}
        disabled={!ctx.ownerAlive}
        placeholder={
          ctx.ownerAlive
            ? t("map.node_input_placeholder")
            : t("map.input_disabled")
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
      {/* Send button is hidden on desktop (⌘Enter) and surfaced only on
          mobile via CSS, where no ⌘Enter is available. */}
      <button
        type="button"
        className="map-node-send"
        disabled={sending || uploading || !draft.trim() || !ctx.ownerAlive}
        onClick={send}
      >
        {uploading ? t("map.uploading") : t("map.send")}
      </button>
    </div>
  );
}

function MapNodeImpl(props: NodeProps) {
  const { t } = useTranslation();
  const ctx = useContext(MapContext);
  const data = props.data as unknown as MapNodeData;
  const kind = data.kind || "idea";
  const isChecklist = !!data.is_checklist;
  // A synthetic Node so the read-only ChecklistCard (built for board nodes)
  // renders verbatim inside the map card. Only title / context / checklist_items
  // are read by the card.
  const checklistNode = {
    id: props.id,
    board_id: ctx?.mapId ?? "",
    parent_id: null,
    kind: "concern",
    title: data.title,
    context: data.context,
    status: "discussing",
    position: 0,
    created_at: "",
    is_checklist: 1,
    checklist_items: data.checklist_items ?? [],
  } as unknown as Node;
  // Same unread cue as a board node card: a thick warm border so you can spot
  // which node on the canvas has new content. For a checklist node (no thread)
  // that's the node-level checklist_unread; otherwise it's unread CC messages.
  const hasUnread = isChecklist
    ? !!data.checklist_unread
    : data.messages.some((m) => m.source === "cc" && !m.read_at);
  // Expanding a message opens the WHOLE node (MapNodeModal) scrolled to that
  // message — same as a board card — instead of a lone single-message preview.
  const [nodeExpanded, setNodeExpanded] = useState(false);
  const [msgTarget, setMsgTarget] = useState<number | null>(null);
  // Fullscreen preview for a checklist node (the map counterpart of expanding
  // a thread node). Driven by the title-bar button.
  const [checklistExpanded, setChecklistExpanded] = useState(false);
  useEffect(() => {
    if (!checklistExpanded) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setChecklistExpanded(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [checklistExpanded]);
  const openExpandedMsg = useCallback((it: ThreadItem) => {
    setMsgTarget(it.id);
    setNodeExpanded(true);
  }, []);
  const cardRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const sizeRef = useRef<{ w: number; h: number; x: number; y: number }>({
    w: 0,
    h: 0,
    x: 0,
    y: 0,
  });
  // strategy A — only auto-read when the canvas is zoomed in enough that the text is
  // actually legible. Subscribe to a BOOLEAN derived from the zoom so the node
  // re-renders only when it crosses the threshold, not on every pan/zoom tick.
  const zoomGateOpen = useStore((s) => s.transform[2] >= MAP_READ_ZOOM);
  // Same visible-dwell auto-read as a board node card, now gated on zoom: while
  // the card is on screen for VISIBLE_DURATION_MS AND zoom ≥ threshold, mark its
  // unread CC messages read (map messages are thread_items, so
  // /mark-thread-items-read clears them + the sidebar unread dot).
  useMarkReadOnVisible(cardRef, data.messages, zoomGateOpen);

  // Checklist nodes have no thread, so the same visible-dwell rule (zoom-gated)
  // marks the node-level checklist read instead — identical behaviour via the
  // shared useVisibleDwell hook.
  // Dep is the VERSION (not just the unread boolean), so every checklist change
  // re-arms the dwell timer — otherwise a change arriving near the end of an
  // existing dwell would be marked read almost immediately. We echo the
  // observed version back so the broker only clears up to what was rendered.
  const checklistVersion = data.checklist_version ?? 0;
  useVisibleDwell(
    cardRef,
    isChecklist && !!data.checklist_unread,
    zoomGateOpen,
    `cl:${checklistVersion}`,
    () => {
      if (ctx)
        postMapChecklistRead(ctx.mapId, props.id, checklistVersion).catch(
          () => {},
        );
    },
  );

  // When this node has unread CC messages, scroll its thread to the OLDEST
  // unread one so the user reads forward from where they left off (instead of
  // landing at the latest). Runs when the unread set changes.
  const oldestUnreadId = hasUnread
    ? data.messages.find((m) => m.source === "cc" && !m.read_at)?.id
    : undefined;
  useEffect(() => {
    if (oldestUnreadId == null) return;
    const body = bodyRef.current;
    if (!body) return;
    const el = body.querySelector(
      `[data-unread-id="${oldestUnreadId}"]`,
    ) as HTMLElement | null;
    if (!el) return;
    // Scroll ONLY this card's thread container (not scrollIntoView, which could
    // also nudge the React Flow canvas) so the oldest unread sits at the top.
    body.scrollTop += el.getBoundingClientRect().top - body.getBoundingClientRect().top;
  }, [oldestUnreadId]);

  return (
    <div
      ref={cardRef}
      className={`map-card kind-${isChecklist ? "checklist" : kind}${
        hasUnread ? " has-unread" : ""
      }${isChecklist ? " map-card-is-checklist" : ""}${
        ctx?.locked ? " locked" : ""
      }`}
    >
      <NodeResizer
        minWidth={240}
        minHeight={160}
        isVisible={!!props.selected && !ctx?.locked}
        onResize={(_e, p) => {
          sizeRef.current = {
            w: p.width,
            h: p.height,
            x: p.x,
            y: p.y,
          };
        }}
        onResizeEnd={() => {
          const s = sizeRef.current;
          if (ctx && s.w > 0) ctx.onResize(props.id, s.w, s.h, s.x, s.y);
        }}
      />
      {/* One handle per side. With ConnectionMode.Loose every handle is both
          source and target, so the user can pull a link out of (or drop one
          onto) any edge of the card; floating edges then route border-to-border. */}
      <Handle type="source" position={Position.Top} id="t" className="map-handle" />
      <Handle type="source" position={Position.Right} id="r" className="map-handle" />
      <Handle type="source" position={Position.Bottom} id="b" className="map-handle" />
      <Handle type="source" position={Position.Left} id="l" className="map-handle" />
      {/* The title bar IS the drag handle (NOT nodrag) — previously only the
          thin padding below the card was draggable, which a checklist node
          (no composer) left with no draggable area at all. Only the buttons
          opt out via nodrag; the GripVertical at the right is the explicit
          "grab here to move" cue the bar's drag affordance. */}
      <div className="map-card-title" title={data.title}>
        <span className="map-card-kind">
          {isChecklist ? t("map.kind.checklist") : t(`map.kind.${kind}`)}
        </span>
        <span className="map-card-title-text">
          {data.title || t("map.untitled")}
        </span>
        {/* Preview: thread node → whole-node modal; checklist node →
            fullscreen list. Both sit just left of the drag handle. */}
        <button
          className="map-node-expand nodrag"
          title={isChecklist ? t("map.checklist_preview") : t("map.expand_node")}
          onClick={() => {
            if (isChecklist) {
              setChecklistExpanded(true);
              // Opening the preview is a deliberate read — clear the unread cue
              // even when auto-read (dwell) is disabled, so a checklist is never
              // permanently stuck unread.
              if (ctx && data.checklist_unread) {
                postMapChecklistRead(ctx.mapId, props.id, checklistVersion).catch(
                  () => {},
                );
              }
            } else {
              setMsgTarget(null);
              setNodeExpanded(true);
            }
          }}
        >
          <Maximize2 size={13} strokeWidth={1.75} />
        </button>
        <span
          className="map-card-drag-handle"
          title={t("map.drag_handle")}
          aria-label={t("map.drag_handle")}
        >
          <GripVertical size={15} strokeWidth={2} />
        </span>
      </div>
      {isChecklist ? (
        <div
          className="map-card-body map-card-checklist nodrag nowheel"
          ref={bodyRef}
        >
          <ChecklistCard node={checklistNode} embedded hideExpand />
        </div>
      ) : (
        <div className="map-card-body nodrag nowheel" ref={bodyRef}>
          {data.context ? (
            <div className="map-card-context">
              <MDView text={data.context} />
            </div>
          ) : null}
          {data.messages.length > 0 && (
            <div className="map-card-thread">
              {data.messages.map((m) => (
                <ThreadMessage
                  key={m.id}
                  item={m}
                  compact
                  enableAnchor={false}
                  onExpand={openExpandedMsg}
                />
              ))}
            </div>
          )}
          {/* Same "jump to latest" affordance as a board node — shows only when
              the bottom of the thread is scrolled out of view. Normal flow
              (newest at the bottom), so NOT reversed. */}
          <ScrollToBottomButton scrollRef={bodyRef} />
        </div>
      )}
      {!isChecklist && <MapCardComposer nodeId={props.id} />}
      {nodeExpanded && ctx && !isChecklist && (
        <MapNodeModal
          mapId={ctx.mapId}
          nodeId={props.id}
          title={data.title}
          context={data.context}
          kind={kind}
          messages={data.messages}
          ownerAlive={ctx.ownerAlive}
          scrollToItemId={msgTarget}
          onClose={() => {
            setNodeExpanded(false);
            setMsgTarget(null);
          }}
        />
      )}
      {isChecklist &&
        checklistExpanded &&
        createPortal(
          <div
            className="modal-backdrop"
            onClick={() => setChecklistExpanded(false)}
          >
            <div
              className="map-checklist-modal"
              role="dialog"
              aria-modal="true"
              onClick={(e) => e.stopPropagation()}
            >
              <button
                className="modal-close"
                onClick={() => setChecklistExpanded(false)}
                aria-label={t("modal.close")}
                title={t("modal.close")}
              >
                <X size={18} strokeWidth={1.75} />
              </button>
              <h2 className="map-checklist-modal-title">
                <span className="map-card-kind kind-checklist">
                  {t("map.kind.checklist")}
                </span>
                {data.title || t("map.untitled")}
              </h2>
              <ChecklistCard node={checklistNode} hideExpand />
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}

export const MapNode = React.memo(MapNodeImpl);
