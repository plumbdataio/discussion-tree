// A grouping frame: a user-drawn rectangle that sits BEHIND the nodes/edges as
// a pure visual backdrop (it does NOT own the nodes it covers). The AI never
// touches frames — the human creates / moves / resizes / renames / recolours /
// deletes them, exactly like node layout. Rendered as a React Flow custom node
// (type "frame") so it gets drag + resize for free; a low/negative zIndex (set
// by MapView + `.react-flow__node-frame { z-index: -1 }` in CSS) keeps it under
// the cards and edges. All edits are SILENT (broker broadcast, no AI push).

import React, { useContext, useEffect, useRef, useState } from "react";
import { NodeResizer, useStore } from "@xyflow/react";
import type { NodeProps } from "@xyflow/react";
import { useTranslation } from "react-i18next";
import { MapContext } from "./MapNode.tsx";
import { postMapUpdateFrame } from "../utils/api.ts";

// The payload MapView packs into each frame node's `data`.
export interface MapFrameData {
  title: string;
  color: string;
  // Label font size in flow-coordinate px; null = the default base size.
  title_size: number | null;
  frame: true;
}

// Default label size + the bounds the corner-drag clamps to (flow px).
const BASE_TITLE_SIZE = 13;
const MIN_TITLE_SIZE = 9;
const MAX_TITLE_SIZE = 240;

// Preset colour swatches. "" = the default neutral frame. color is stored as a
// free-form hex, so the native colour input below reaches any colour too — and
// a richer picker can replace it later with no schema change.
const FRAME_SWATCHES = [
  "",
  "#2563eb",
  "#7c3aed",
  "#10b981",
  "#f59e0b",
  "#ef4444",
  "#0d9488",
  "#64748b",
];

const HEX6 = /^#[0-9a-fA-F]{6}$/;

// Border + translucent fill for a frame colour. "" → the neutral CSS vars.
function frameColors(color: string): { border: string; fill: string } {
  if (!color) return { border: "var(--frame-border)", fill: "var(--frame-fill)" };
  // Append a low-alpha byte so the backdrop is a faint wash, not a solid block.
  const fill = HEX6.test(color) ? `${color}1f` : color;
  return { border: color, fill };
}

function MapFrameNodeImpl(props: NodeProps) {
  const { t } = useTranslation();
  const ctx = useContext(MapContext);
  const data = props.data as unknown as MapFrameData;
  const locked = !!ctx?.locked;
  const selected = !!props.selected;
  const { border, fill } = frameColors(data.color || "");
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(data.title);
  // Same in-flight size capture pattern as MapNode's resizer; the *-Start refs
  // hold the pre-gesture values for the undo entry.
  const sizeRef = useRef({ w: 0, h: 0, x: 0, y: 0 });
  const resizeStart = useRef<{ x: number; y: number; w: number; h: number } | null>(
    null,
  );
  // Live preview of the label size while dragging its corner; null = use the
  // persisted value. Cleared once the broker echoes the new size back.
  const [liveSize, setLiveSize] = useState<number | null>(null);
  const titleSize = liveSize ?? data.title_size ?? BASE_TITLE_SIZE;
  // Current canvas zoom (so a screen-space corner drag maps to flow-space px).
  const zoom = useStore((s) => s.transform[2]);
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;

  // Keep the local draft in sync with broker updates while NOT editing.
  useEffect(() => {
    if (!editing) setDraft(data.title);
  }, [data.title, editing]);
  // Drop the live preview once the persisted size catches up (no flicker).
  useEffect(() => {
    setLiveSize(null);
  }, [data.title_size]);

  const commitTitle = () => {
    setEditing(false);
    const next = draft.trim();
    if (ctx && next !== data.title) {
      ctx.recordFrameUpdate?.(props.id, { title: data.title });
      postMapUpdateFrame(ctx.mapId, props.id, { title: next }).catch(() => {});
    }
  };
  const setColor = (color: string) => {
    if (!ctx || color === (data.color || "")) return;
    ctx.recordFrameUpdate?.(props.id, { color: data.color });
    postMapUpdateFrame(ctx.mapId, props.id, { color }).catch(() => {});
  };

  // Drag the label's bottom-right corner to scale the font linearly. Custom
  // pointer-drag (not React Flow's) so the node itself doesn't move; the screen
  // delta is divided by zoom so the feel is the same at any zoom.
  const onSizeHandleDown = (e: React.PointerEvent) => {
    if (locked || !ctx) return;
    e.stopPropagation();
    e.preventDefault();
    const start = data.title_size ?? BASE_TITLE_SIZE;
    const sx = e.clientX;
    const sy = e.clientY;
    let last = start;
    const onMove = (ev: PointerEvent) => {
      const z = zoomRef.current || 1;
      const dx = (ev.clientX - sx) / z;
      const dy = (ev.clientY - sy) / z;
      const next = Math.max(
        MIN_TITLE_SIZE,
        Math.min(MAX_TITLE_SIZE, start + (dx + dy) / 2),
      );
      last = next;
      setLiveSize(next);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      const rounded = Math.round(last);
      if (rounded !== Math.round(start)) {
        // Hold the preview until the broker echo lands (effect clears it).
        setLiveSize(rounded);
        ctx.recordFrameUpdate?.(props.id, {
          title_size: data.title_size ?? null,
        });
        postMapUpdateFrame(ctx.mapId, props.id, {
          title_size: rounded,
        }).catch(() => {});
      } else {
        setLiveSize(null);
      }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  return (
    <div
      className={`map-frame${selected ? " selected" : ""}${locked ? " locked" : ""}`}
      style={{ borderColor: border, background: fill }}
    >
      <NodeResizer
        minWidth={140}
        minHeight={100}
        isVisible={selected && !locked}
        lineClassName="map-frame-resize-line"
        handleClassName="map-frame-resize-handle"
        onResizeStart={(_e, p) => {
          resizeStart.current = { x: p.x, y: p.y, w: p.width, h: p.height };
        }}
        onResize={(_e, p) => {
          sizeRef.current = { w: p.width, h: p.height, x: p.x, y: p.y };
        }}
        onResizeEnd={() => {
          const s = sizeRef.current;
          if (ctx && s.w > 0) {
            // Record the pre-resize geometry for undo, then persist the new one.
            if (resizeStart.current) {
              ctx.recordFrameUpdate?.(props.id, {
                x: Math.round(resizeStart.current.x),
                y: Math.round(resizeStart.current.y),
                w: Math.round(resizeStart.current.w),
                h: Math.round(resizeStart.current.h),
              });
              resizeStart.current = null;
            }
            postMapUpdateFrame(ctx.mapId, props.id, {
              x: Math.round(s.x),
              y: Math.round(s.y),
              w: Math.round(s.w),
              h: Math.round(s.h),
            }).catch(() => {});
          }
        }}
      />
      {/* Top strip = the label (and the drag handle). Double-click to rename
          (unlocked only); the input opts out of dragging via nodrag. */}
      <div
        className="map-frame-bar"
        style={{ color: border, fontSize: `${titleSize}px` }}
        onDoubleClick={(e) => {
          if (locked) return;
          e.stopPropagation();
          setDraft(data.title);
          setEditing(true);
        }}
      >
        {editing ? (
          <input
            className="map-frame-title-input nodrag nopan"
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commitTitle}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                commitTitle();
              } else if (e.key === "Escape") {
                setEditing(false);
                setDraft(data.title);
              }
            }}
          />
        ) : (
          <span className="map-frame-title">
            {data.title || t("map.frame_untitled")}
          </span>
        )}
        {/* Drag the bottom-right corner of the label to scale the font. */}
        {selected && !locked && (
          <span
            className="map-frame-size-handle nodrag nopan"
            title={t("map.frame_font_size")}
            aria-label={t("map.frame_font_size")}
            onPointerDown={onSizeHandleDown}
          />
        )}
      </div>
      {/* Colour controls — only while selected AND unlocked (frames are
          user-owned; lock freezes them like node layout). */}
      {selected && !locked && (
        <div className="map-frame-toolbar nodrag nopan">
          {FRAME_SWATCHES.map((c) => (
            <button
              key={c || "default"}
              type="button"
              className={`map-frame-swatch${
                (data.color || "") === c ? " active" : ""
              }${c ? "" : " is-default"}`}
              style={c ? { background: c } : undefined}
              title={c || t("map.frame_color_default")}
              aria-label={c || t("map.frame_color_default")}
              onClick={() => setColor(c)}
            />
          ))}
          <input
            type="color"
            className="map-frame-color-input"
            value={HEX6.test(data.color || "") ? data.color : "#2563eb"}
            title={t("map.frame_color_custom")}
            aria-label={t("map.frame_color_custom")}
            onChange={(e) => setColor(e.target.value)}
          />
        </div>
      )}
    </div>
  );
}

export const MapFrameNode = React.memo(MapFrameNodeImpl);
