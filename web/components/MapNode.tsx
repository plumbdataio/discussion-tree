// A single map node, rendered as a React Flow custom node. It packs the same
// pieces a dt board node shows — title (headline) → context (markdown) →
// thread (user/cc bubbles) → an input box — into a resizable card whose border
// colour encodes the node kind. This is the "dt node stuffed into a card"
// the design called for.
//
// Per the map v1 requirements the card omits bookmark / timestamp / status /
// (desktop) send-button: ThreadMessage is reused in `compact` mode for that.

import React, { createContext, useContext, useRef, useState } from "react";
import { Handle, Position, NodeResizer } from "@xyflow/react";
import type { NodeProps } from "@xyflow/react";
import { useTranslation } from "react-i18next";
import type { MapNodeKind, ThreadItem } from "../../shared/types.ts";
import { MDView } from "./MDView.tsx";
import { ThreadMessage } from "./ThreadMessage.tsx";
import { useDraft } from "../utils/drafts.ts";
import { useMarkReadOnVisible } from "../utils/useMarkReadOnVisible.ts";
import {
  extractImageFiles,
  postMapChat,
  uploadImage,
} from "../utils/api.ts";
import { showToast } from "./Toast.tsx";

// Map-level values shared by every node card. Supplied once by MapView via the
// provider so node.data can stay minimal (good for React Flow's per-node memo).
export interface MapCtx {
  mapId: string;
  sessionId: string;
  ownerAlive: boolean;
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
}

const noopExpand = () => {};

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
  const cardRef = useRef<HTMLDivElement>(null);
  const sizeRef = useRef<{ w: number; h: number; x: number; y: number }>({
    w: 0,
    h: 0,
    x: 0,
    y: 0,
  });
  // Same visible-dwell auto-read as a board node card: while the card is on
  // screen for VISIBLE_DURATION_MS, mark its unread CC messages read (map
  // messages are thread_items, so /mark-thread-items-read clears them + the
  // sidebar unread dot). React Flow transforms the node, but getBoundingClientRect
  // still reports screen coords, so visibility detection works inside the canvas.
  useMarkReadOnVisible(cardRef, data.messages);

  return (
    <div ref={cardRef} className={`map-card kind-${kind}`}>
      <NodeResizer
        minWidth={240}
        minHeight={160}
        isVisible={!!props.selected}
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
      <Handle type="target" position={Position.Left} />
      <div className="map-card-title nodrag" title={data.title}>
        <span className="map-card-kind">{t(`map.kind.${kind}`)}</span>
        {data.title || t("map.untitled")}
      </div>
      <div className="map-card-body nodrag nowheel">
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
                onExpand={noopExpand}
              />
            ))}
          </div>
        )}
      </div>
      <MapCardComposer nodeId={props.id} />
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

export const MapNode = React.memo(MapNodeImpl);
