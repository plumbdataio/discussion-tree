// Throwaway "divergent-discussion mind-map" demo (bd_a1c660ba… feature spike).
//
// The user chats in dt as usual; THIS session (Claude) reads the chat and
// grows a free-form map by calling POST /map/op. The map lives here in memory
// (no DB — it's a spike), and every mutation is broadcast over the existing
// per-channel WS fan-out on the pseudo-board id "map-demo". A standalone page
// (served at GET /map-demo) renders the map with tldraw loaded from a CDN, so
// nothing in the Bun build/bundle changes. Nodes are positioned by the broker
// (a loose left-to-right tree layout) so Claude only supplies content +
// parent, never coordinates.

import { broadcast } from "./ws.ts";

const CHANNEL = "map-demo";

type MapNode = {
  id: string;
  text: string;
  kind: string; // free label: topic | idea | question | pro | con | decision | note
  x: number;
  y: number;
  parent: string | null;
};
type MapEdge = { id: string; from: string; to: string };

const nodes = new Map<string, MapNode>();
const edges = new Map<string, MapEdge>();
let seq = 0;
const nextId = (p: string) => `${p}${++seq}`;

function snapshot() {
  return {
    nodes: [...nodes.values()],
    edges: [...edges.values()],
  };
}

function emit() {
  broadcast(CHANNEL, { type: "map-update", state: snapshot() });
}

// Loose layout: a child sits to the right of its parent, fanned vertically by
// how many children the parent already has. Roots stack down the left edge.
const NODE_W = 200;
const NODE_H = 70;
const COL_GAP = 90;
const ROW_GAP = 28;
let rootCount = 0;
function place(parent: string | null): { x: number; y: number } {
  if (!parent || !nodes.has(parent)) {
    const y = 80 + rootCount * (NODE_H + ROW_GAP) * 2;
    rootCount++;
    return { x: 80, y };
  }
  const p = nodes.get(parent)!;
  const siblings = [...nodes.values()].filter((n) => n.parent === parent).length;
  const x = p.x + NODE_W + COL_GAP;
  // Center the fan of children vertically around the parent.
  const y = p.y + (siblings - 0) * (NODE_H + ROW_GAP);
  return { x, y };
}

function addNode(body: any): { ok: boolean; id?: string; error?: string } {
  const text = String(body.text ?? "").trim();
  if (!text) return { ok: false, error: "text required" };
  const kind = String(body.kind ?? "note");
  const parent =
    body.parent != null && nodes.has(String(body.parent))
      ? String(body.parent)
      : null;
  const id = body.id ? String(body.id) : nextId("n");
  const pos =
    typeof body.x === "number" && typeof body.y === "number"
      ? { x: body.x, y: body.y }
      : place(parent);
  nodes.set(id, { id, text, kind, x: pos.x, y: pos.y, parent });
  if (parent) {
    const eid = `${parent}->${id}`;
    edges.set(eid, { id: eid, from: parent, to: id });
  }
  emit();
  return { ok: true, id };
}

function handleMapOp(body: any): unknown {
  const action = String(body?.action ?? "");
  switch (action) {
    case "add":
      return addNode(body);
    case "update": {
      const id = String(body.id ?? "");
      const n = nodes.get(id);
      if (!n) return { ok: false, error: "node not found" };
      if (body.text != null) n.text = String(body.text);
      if (body.kind != null) n.kind = String(body.kind);
      if (typeof body.x === "number") n.x = body.x;
      if (typeof body.y === "number") n.y = body.y;
      emit();
      return { ok: true };
    }
    case "connect": {
      const from = String(body.from ?? "");
      const to = String(body.to ?? "");
      if (!nodes.has(from) || !nodes.has(to)) {
        return { ok: false, error: "from/to must be existing node ids" };
      }
      const eid = `${from}->${to}`;
      edges.set(eid, { id: eid, from, to });
      emit();
      return { ok: true, id: eid };
    }
    case "delete": {
      const id = String(body.id ?? "");
      nodes.delete(id);
      for (const [eid, e] of [...edges]) {
        if (e.from === id || e.to === id) edges.delete(eid);
      }
      emit();
      return { ok: true };
    }
    case "clear":
      nodes.clear();
      edges.clear();
      seq = 0;
      rootCount = 0;
      emit();
      return { ok: true };
    default:
      return { ok: false, error: `unknown action '${action}'` };
  }
}

export function getMapState() {
  return snapshot();
}

export const routes = {
  "/map/op": handleMapOp,
};

// --- Standalone page (tldraw via CDN, no bundler involvement) ---
// Served verbatim at GET /map-demo. Uses React.createElement (no JSX) so it
// runs as a plain ES module in the browser with nothing to transpile.
export const MAP_DEMO_HTML = `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1" />
<title>発散議論 mindmap デモ</title>
<link rel="stylesheet" href="https://esm.sh/tldraw@3.13.1/tldraw.css" />
<style>
  html, body, #root { margin:0; height:100%; }
  #root { position: fixed; inset: 0; }
  #banner { position: fixed; top: 8px; left: 50%; transform: translateX(-50%);
    z-index: 9999; background: rgba(17,24,39,.85); color:#fff; font: 12px/1.4 -apple-system, sans-serif;
    padding: 6px 12px; border-radius: 999px; pointer-events: none; }
</style>
</head>
<body>
<div id="root"></div>
<div id="banner">発散議論 mindmap デモ — dt で話すとここに地図が育ちます</div>
<script type="module">
import React from "https://esm.sh/react@18.3.1";
import { createRoot } from "https://esm.sh/react-dom@18.3.1/client";
import { Tldraw, toRichText, createShapeId } from "https://esm.sh/tldraw@3.13.1?deps=react@18.3.1,react-dom@18.3.1";

const KIND_COLOR = {
  topic: "violet", idea: "blue", question: "orange",
  pro: "green", con: "red", decision: "black", note: "grey",
};
const NODE_W = 200, NODE_H = 70;

let editor = null;
const shapeByNode = new Map(); // nodeId -> tldraw shapeId
const arrowByEdge = new Map(); // edgeId -> tldraw shapeId
const nodeCenter = new Map();  // nodeId -> {x,y}

function applyState(state) {
  if (!editor) return;
  editor.run(() => {
    const seen = new Set();
    for (const n of state.nodes) {
      seen.add(n.id);
      nodeCenter.set(n.id, { x: n.x + NODE_W / 2, y: n.y + NODE_H / 2 });
      const color = KIND_COLOR[n.kind] || "grey";
      let sid = shapeByNode.get(n.id);
      if (!sid) {
        sid = createShapeId();
        shapeByNode.set(n.id, sid);
        editor.createShape({
          id: sid, type: "geo", x: n.x, y: n.y,
          props: { geo: "rectangle", w: NODE_W, h: NODE_H, color, fill: "solid",
            size: "s", font: "sans", align: "start", verticalAlign: "middle",
            richText: toRichText(n.text) },
        });
      } else {
        editor.updateShape({ id: sid, type: "geo", x: n.x, y: n.y,
          props: { color, richText: toRichText(n.text) } });
      }
    }
    for (const [nid, sid] of [...shapeByNode]) {
      if (!seen.has(nid)) { editor.deleteShape(sid); shapeByNode.delete(nid); nodeCenter.delete(nid); }
    }
    // Rebuild edges as simple arrows between node centers.
    const seenE = new Set();
    for (const e of state.edges) {
      seenE.add(e.id);
      const a = nodeCenter.get(e.from), b = nodeCenter.get(e.to);
      if (!a || !b) continue;
      let sid = arrowByEdge.get(e.id);
      const props = { start: { x: a.x, y: a.y }, end: { x: b.x, y: b.y }, color: "grey", size: "s" };
      if (!sid) {
        sid = createShapeId();
        arrowByEdge.set(e.id, sid);
        editor.createShape({ id: sid, type: "arrow", x: 0, y: 0, props });
      } else {
        editor.updateShape({ id: sid, type: "arrow", x: 0, y: 0, props });
      }
    }
    for (const [eid, sid] of [...arrowByEdge]) {
      if (!seenE.has(eid)) { editor.deleteShape(sid); arrowByEdge.delete(eid); }
    }
  });
  // Keep everything in view as it grows.
  try { editor.zoomToFit({ animation: { duration: 200 } }); } catch (e) {}
}

async function load() {
  try {
    const r = await fetch("/api/map-demo");
    if (r.ok) applyState(await r.json());
  } catch (e) {}
}

function connectWs() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(proto + "://" + location.host + "/ws/map-demo");
  ws.onmessage = (ev) => {
    try {
      const msg = JSON.parse(ev.data);
      if (msg.type === "map-update") applyState(msg.state);
    } catch (e) {}
  };
  ws.onclose = () => setTimeout(connectWs, 1500);
}

createRoot(document.getElementById("root")).render(
  React.createElement(Tldraw, {
    onMount: (ed) => { editor = ed; load(); connectWs(); },
  })
);
</script>
</body>
</html>`;
