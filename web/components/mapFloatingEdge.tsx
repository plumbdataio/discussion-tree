// Floating edges for the map canvas: an edge connects to the nearest point on
// each node's border (not a fixed left/right handle), so a link naturally
// leaves whichever side faces the other node — the real mind-map feel. Adapted
// from the React Flow "floating edges" recipe for @xyflow/react v12.

import React from "react";
import {
  BaseEdge,
  getBezierPath,
  Position,
  useInternalNode,
} from "@xyflow/react";

// Where the straight line between two node centres crosses `node`'s border.
function getNodeIntersection(node: any, other: any) {
  const w = (node.measured?.width ?? 0) / 2;
  const h = (node.measured?.height ?? 0) / 2;
  const nx = node.internals.positionAbsolute.x;
  const ny = node.internals.positionAbsolute.y;
  const x2 = nx + w;
  const y2 = ny + h;
  const x1 =
    other.internals.positionAbsolute.x + (other.measured?.width ?? 0) / 2;
  const y1 =
    other.internals.positionAbsolute.y + (other.measured?.height ?? 0) / 2;
  const xx1 = (x1 - x2) / (2 * w) - (y1 - y2) / (2 * h);
  const yy1 = (x1 - x2) / (2 * w) + (y1 - y2) / (2 * h);
  const a = 1 / (Math.abs(xx1) + Math.abs(yy1) || 1);
  const xx3 = a * xx1;
  const yy3 = a * yy1;
  return { x: w * (xx3 + yy3) + x2, y: h * (-xx3 + yy3) + y2 };
}

// Which side of `node` an intersection point sits on (drives the bezier tangent).
function getEdgePosition(node: any, point: { x: number; y: number }): Position {
  const nx = Math.round(node.internals.positionAbsolute.x);
  const ny = Math.round(node.internals.positionAbsolute.y);
  const px = Math.round(point.x);
  const py = Math.round(point.y);
  if (px <= nx + 1) return Position.Left;
  if (px >= nx + (node.measured?.width ?? 0) - 1) return Position.Right;
  if (py <= ny + 1) return Position.Top;
  return Position.Bottom;
}

export function getEdgeParams(source: any, target: any) {
  const sp = getNodeIntersection(source, target);
  const tp = getNodeIntersection(target, source);
  return {
    sx: sp.x,
    sy: sp.y,
    tx: tp.x,
    ty: tp.y,
    sourcePos: getEdgePosition(source, sp),
    targetPos: getEdgePosition(target, tp),
  };
}

export function FloatingEdge({
  id,
  source,
  target,
  markerEnd,
  style,
  selected,
}: any) {
  const sourceNode = useInternalNode(source);
  const targetNode = useInternalNode(target);
  // Guard the whole geometry chain: during a remount/measure gap a node can
  // exist without internals/positionAbsolute yet. Returning null for that one
  // frame is fine now that edge identities are preserved (no remount storm).
  if (
    !sourceNode?.internals?.positionAbsolute ||
    !targetNode?.internals?.positionAbsolute
  ) {
    return null;
  }
  const { sx, sy, tx, ty, sourcePos, targetPos } = getEdgeParams(
    sourceNode,
    targetNode,
  );
  const [path] = getBezierPath({
    sourceX: sx,
    sourceY: sy,
    sourcePosition: sourcePos,
    targetPosition: targetPos,
    targetX: tx,
    targetY: ty,
  });
  // Clicking an edge selects it → highlight it (thicker + accent stroke + a
  // glow via .map-edge-selected) and, with elevateEdgesOnSelect on the canvas,
  // lift it above the nodes so a path hidden behind an unrelated card becomes
  // traceable end to end.
  const edgeStyle = selected
    ? { ...(style ?? {}), stroke: "#7c3aed", strokeWidth: 3 }
    : style;
  return (
    <BaseEdge
      id={id}
      path={path}
      markerEnd={markerEnd}
      style={edgeStyle}
      className={selected ? "map-edge-selected" : undefined}
    />
  );
}

// Drag-preview line while the user is pulling a new edge out of a node.
export function FloatingConnectionLine({
  toX,
  toY,
  fromPosition,
  toPosition,
  fromNode,
}: any) {
  if (!fromNode) return null;
  const target = {
    measured: { width: 1, height: 1 },
    internals: { positionAbsolute: { x: toX, y: toY } },
  };
  const { sx, sy } = getEdgeParams(fromNode, target);
  const [path] = getBezierPath({
    sourceX: sx,
    sourceY: sy,
    sourcePosition: fromPosition,
    targetPosition: toPosition,
    targetX: toX,
    targetY: toY,
  });
  return (
    <g>
      <path
        fill="none"
        stroke="#9ca3af"
        strokeWidth={1.5}
        className="animated"
        d={path}
      />
      <circle
        cx={toX}
        cy={toY}
        r={3}
        fill="#fff"
        stroke="#9ca3af"
        strokeWidth={1.5}
      />
    </g>
  );
}
