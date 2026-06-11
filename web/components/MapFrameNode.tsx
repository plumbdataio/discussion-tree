// A grouping frame: a user-drawn rectangle that sits BEHIND the nodes/edges as
// a pure visual backdrop (it does NOT own the nodes it covers). The AI never
// touches frames — the human creates / moves / resizes / renames / recolours /
// deletes them, exactly like node layout. Rendered as a React Flow custom node
// (type "frame") so it gets drag + resize for free; a low/negative zIndex (set
// by MapView + `.react-flow__node-frame { z-index: -1 }` in CSS) keeps it under
// the cards and edges. All edits are SILENT (broker broadcast, no AI push).

import React, { useContext, useEffect, useRef, useState } from "react";
import { NodeResizer } from "@xyflow/react";
import type { NodeProps } from "@xyflow/react";
import { useTranslation } from "react-i18next";
import { MapContext } from "./MapNode.tsx";
import { postMapUpdateFrame } from "../utils/api.ts";

// The payload MapView packs into each frame node's `data`.
export interface MapFrameData {
  title: string;
  color: string;
  frame: true;
}

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
  // Same in-flight size capture pattern as MapNode's resizer.
  const sizeRef = useRef({ w: 0, h: 0, x: 0, y: 0 });

  // Keep the local draft in sync with broker updates while NOT editing.
  useEffect(() => {
    if (!editing) setDraft(data.title);
  }, [data.title, editing]);

  const commitTitle = () => {
    setEditing(false);
    const next = draft.trim();
    if (ctx && next !== data.title) {
      postMapUpdateFrame(ctx.mapId, props.id, { title: next }).catch(() => {});
    }
  };
  const setColor = (color: string) => {
    if (ctx) postMapUpdateFrame(ctx.mapId, props.id, { color }).catch(() => {});
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
        onResize={(_e, p) => {
          sizeRef.current = { w: p.width, h: p.height, x: p.x, y: p.y };
        }}
        onResizeEnd={() => {
          const s = sizeRef.current;
          if (ctx && s.w > 0) {
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
        style={{ color: border }}
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
