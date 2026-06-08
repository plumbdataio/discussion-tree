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
import { insertPending, selectBoard } from "./db.ts";

const CHANNEL = "map-demo";
// PoC: the map's right-side general chat routes user messages to whichever CC
// session owns this board, via the normal pending-message channel. Hardcoded
// to the feature's design board for the spike (its owner is the dt session
// running this work). kind="map_chat" so poll.ts pushes it as a plain note
// (no UI-mirror reminder, no unanswered-counter bump).
const MAP_CHAT_BOARD = "bd_a1c660ba6aa03e09dde6f6bb8ff08edc";

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

// The map's right-side general chat. Enqueues the user's message to the
// board-owning CC session via the normal channel (kind="map_chat"), so the
// session running this map work receives it like any other UI submission and
// can respond by growing the map.
function handleMapChat(body: any): unknown {
  const text = String(body?.text ?? "").trim();
  if (!text) return { ok: false, error: "text required" };
  const board = selectBoard.get(MAP_CHAT_BOARD) as
    | { session_id: string }
    | undefined;
  if (!board) return { ok: false, error: "chat board not found" };
  insertPending.run(
    board.session_id,
    MAP_CHAT_BOARD,
    "map-chat",
    "発散議論 mindmap > 全体チャット",
    text,
    new Date().toISOString(),
    "map_chat",
  );
  return { ok: true };
}

export const routes = {
  "/map/op": handleMapOp,
  "/map/chat": handleMapChat,
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

// Node types (st-ibis): Question / Idea / Research(AI) / Selection. note/topic
// are fallbacks. Colour is the at-a-glance type cue.
const KIND_COLOR = {
  question: "orange", idea: "blue", research: "violet",
  selection: "green", note: "grey", topic: "grey",
};
const NODE_W = 200, NODE_H = 70;

let editor = null;
let applying = false;      // true while we push broker state → ignore our own edits
let didInitialFit = false; // fit the camera ONCE, then never hijack the user's view
const shapeByNode = new Map(); // nodeId -> tldraw shapeId
const nodeByShape = new Map(); // tldraw shapeId -> nodeId (reverse, for drag-save)
const arrowByEdge = new Map(); // edgeId -> tldraw shapeId
const nodePos = new Map();      // nodeId -> {x,y} per the LATEST broker state
const nodeCenter = new Map();   // nodeId -> {x,y} centre (for edge endpoints)

function applyState(state) {
  if (!editor) return;
  applying = true;
  editor.run(() => {
    const seen = new Set();
    for (const n of state.nodes) {
      seen.add(n.id);
      nodePos.set(n.id, { x: n.x, y: n.y });
      nodeCenter.set(n.id, { x: n.x + NODE_W / 2, y: n.y + NODE_H / 2 });
      const color = KIND_COLOR[n.kind] || "grey";
      let sid = shapeByNode.get(n.id);
      if (!sid) {
        sid = createShapeId();
        shapeByNode.set(n.id, sid);
        nodeByShape.set(sid, n.id);
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
      if (!seen.has(nid)) {
        editor.deleteShape(sid); shapeByNode.delete(nid);
        nodeByShape.delete(sid); nodeCenter.delete(nid); nodePos.delete(nid);
      }
    }
    // Rebuild edges as simple arrows between node centres.
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
  applying = false;
  // Fit ONCE so existing content is visible; afterwards leave the camera to the
  // user. Node coords never auto-relayout — only the user's drags move nodes,
  // and those persist back to the broker (so "it was top-right" stays true).
  if (!didInitialFit && state.nodes.length > 0) {
    didInitialFit = true;
    try { editor.zoomToFit({ animation: { duration: 200 } }); } catch (e) {}
  }
}

// Persist the user's node drags back to the broker (shared source of truth), so
// my next pull sees the layout the user arranged. Debounced per node. We detect
// a genuine drag by comparing the shape's position to the last broker position
// (nodePos): our own programmatic updates set them equal, so only real drags
// differ — no echo loop even if the listener fires after applying resets.
const saveTimers = new Map();
function scheduleSave(nodeId, x, y) {
  clearTimeout(saveTimers.get(nodeId));
  saveTimers.set(nodeId, setTimeout(() => {
    fetch("/map/op", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "update", id: nodeId, x: Math.round(x), y: Math.round(y) }),
    }).catch(() => {});
  }, 250));
}
function watchDrags() {
  editor.store.listen((entry) => {
    if (applying) return;
    const upd = entry.changes && entry.changes.updated;
    if (!upd) return;
    for (const k in upd) {
      const to = upd[k][1];
      if (to && to.typeName === "shape" && to.type === "geo") {
        const nodeId = nodeByShape.get(to.id);
        if (!nodeId) continue;
        const known = nodePos.get(nodeId);
        if (!known || Math.abs(known.x - to.x) > 0.5 || Math.abs(known.y - to.y) > 0.5) {
          scheduleSave(nodeId, to.x, to.y);
        }
      }
    }
  }, { scope: "document", source: "user" });
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
    onMount: (ed) => { editor = ed; watchDrags(); load(); connectWs(); },
  })
);
</script>
</body>
</html>`;

// --- React Flow PoC (the "A" substrate the user leans toward) ---
// Same backend (/api/map-demo + /ws/map-demo) as the tldraw page, rendered as a
// React Flow graph: rich typed node cards + a right-side general-chat panel =
// the crystallised UI image. Standalone, React Flow via CDN (no Bun bundling).
// IMPORTANT: NO backtick characters anywhere inside this template literal — a
// stray backtick terminates the string (learned the hard way). Use ' and " and
// string concatenation only.
export const MAP_DEMO_RF_HTML = `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1" />
<title>発散議論 mindmap デモ (React Flow)</title>
<link rel="stylesheet" href="https://esm.sh/@xyflow/react@12.3.5/dist/style.css" />
<style>
  html, body, #root { margin:0; height:100%; }
  #root { position: fixed; inset: 0; }
  .wrap { display:flex; height:100%; font: 14px/1.5 -apple-system, "Hiragino Sans", sans-serif; }
  .canvas { flex:1; min-width:0; position:relative; }
  .chat { width: 320px; flex:0 0 320px; border-left:1px solid #e2e2e2; display:flex; flex-direction:column; background:#fff; }
  .chat-head { padding:10px 12px; font-weight:700; border-bottom:1px solid #eee; background:#faf5ff; color:#6d28d9; }
  .chat-body { flex:1; overflow:auto; padding:12px; }
  .chat-note { color:#6b7280; font-size:12px; }
  .chat-msg { margin-top:8px; padding:7px 10px; background:#eef2ff; border:1px solid #e0e7ff; border-radius:8px; font-size:13px; color:#1e293b; white-space:pre-wrap; }
  .chat-input { padding:10px; border-top:1px solid #eee; }
  .chat-input input { width:100%; box-sizing:border-box; padding:8px 10px; border:1px solid #c4c4c4; border-radius:8px; font-size:16px; }
  .card { width:200px; border-radius:10px; border:2px solid; background:#fff; box-shadow:0 1px 4px rgba(0,0,0,.08); overflow:hidden; }
  .card-badge { font-size:10px; font-weight:700; letter-spacing:.04em; text-transform:uppercase; padding:3px 8px; color:#fff; }
  .card-text { padding:8px 10px; font-size:13px; color:#1a1a1a; }
  .card-foot { padding:5px 10px; border-top:1px dashed #e5e7eb; font-size:11px; color:#9ca3af; }
  .kind-question { border-color:#f59e0b; } .kind-question .card-badge { background:#f59e0b; }
  .kind-idea { border-color:#2563eb; } .kind-idea .card-badge { background:#2563eb; }
  .kind-research { border-color:#7c3aed; } .kind-research .card-badge { background:#7c3aed; }
  .kind-selection { border-color:#10b981; } .kind-selection .card-badge { background:#10b981; }
  .kind-note, .kind-topic { border-color:#9ca3af; } .kind-note .card-badge, .kind-topic .card-badge { background:#9ca3af; }
</style>
</head>
<body>
<div id="root"></div>
<script type="module">
import React from "https://esm.sh/react@18.3.1";
import { createRoot } from "https://esm.sh/react-dom@18.3.1/client";
import { ReactFlow, Background, Controls, Handle, Position, applyNodeChanges }
  from "https://esm.sh/@xyflow/react@12.3.5?deps=react@18.3.1,react-dom@18.3.1";

const h = React.createElement;
const KIND_LABEL = { question:"Question", idea:"Idea", research:"Research", selection:"Selection", note:"Note", topic:"Topic" };

function CardNode(props) {
  const d = props.data;
  const kind = d.kind || "note";
  return h("div", { className: "card kind-" + kind },
    h(Handle, { type:"target", position: Position.Left }),
    h("div", { className:"card-badge" }, KIND_LABEL[kind] || kind),
    h("div", { className:"card-text" }, d.text),
    h("div", { className:"card-foot" }, "スレッド (このノードの履歴)"),
    h(Handle, { type:"source", position: Position.Right })
  );
}
const nodeTypes = { card: CardNode };

function toFlow(state) {
  const nodes = state.nodes.map(function(n){
    return { id:n.id, type:"card", position:{ x:n.x, y:n.y }, data:{ text:n.text, kind:n.kind } };
  });
  const edges = state.edges.map(function(e){
    return { id:e.id, source:e.from, target:e.to };
  });
  return { nodes: nodes, edges: edges };
}

function App() {
  const st = React.useState({ nodes: [], edges: [] });
  const data = st[0], setData = st[1];
  const rf = React.useRef(null);
  const didFit = React.useRef(false);
  const ms = React.useState([]);   // local echo of messages the user sent me
  const msgs = ms[0], setMsgs = ms[1];
  const iv = React.useState("");
  const input = iv[0], setInput = iv[1];

  React.useEffect(function(){
    function apply(state){
      const f = toFlow(state);
      setData(f);
      if (!didFit.current && f.nodes.length > 0 && rf.current) {
        didFit.current = true;
        setTimeout(function(){ try { rf.current.fitView({ duration: 200, padding: 0.2 }); } catch(e){} }, 50);
      }
    }
    fetch("/api/map-demo").then(function(r){ return r.json(); }).then(apply).catch(function(){});
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(proto + "://" + location.host + "/ws/map-demo");
    ws.onmessage = function(ev){ try { const m = JSON.parse(ev.data); if (m.type === "map-update") apply(m.state); } catch(e){} };
    return function(){ try { ws.close(); } catch(e){} };
  }, []);

  function onNodesChange(changes){
    setData(function(d){ return { nodes: applyNodeChanges(changes, d.nodes), edges: d.edges }; });
  }
  function onNodeDragStop(evt, node){
    fetch("/map/op", { method:"POST", headers:{ "Content-Type":"application/json" },
      body: JSON.stringify({ action:"update", id: node.id, x: Math.round(node.position.x), y: Math.round(node.position.y) }) }).catch(function(){});
  }
  function send(){
    const t = input.trim();
    if (!t) return;
    setMsgs(function(m){ return m.concat([t]); });
    setInput("");
    fetch("/map/chat", { method:"POST", headers:{ "Content-Type":"application/json" },
      body: JSON.stringify({ text: t }) }).catch(function(){});
  }

  return h("div", { className:"wrap" },
    h("div", { className:"canvas" },
      h(ReactFlow, {
        nodes: data.nodes, edges: data.edges, nodeTypes: nodeTypes,
        onNodesChange: onNodesChange, onNodeDragStop: onNodeDragStop,
        onInit: function(inst){ rf.current = inst; },
        proOptions: { hideAttribution: true }, minZoom: 0.2,
      }, h(Background, null), h(Controls, null))
    ),
    h("aside", { className:"chat" },
      h("div", { className:"chat-head" }, "general チャット (マップ全体)"),
      h("div", { className:"chat-body" },
        h("p", { className:"chat-note" }, "ここに送ると、地図を維持している私 (Claude) に届きます。私は応答を地図の変化 (ノードの増減) として返します。"),
        msgs.map(function(m, i){ return h("div", { key:i, className:"chat-msg" }, m); })
      ),
      h("div", { className:"chat-input" },
        h("input", {
          value: input, placeholder:"私にメッセージ… (Enter で送信)",
          onChange: function(e){ setInput(e.target.value); },
          onKeyDown: function(e){ if (e.key === "Enter") send(); },
        })
      )
    )
  );
}

createRoot(document.getElementById("root")).render(h(App));
</script>
</body>
</html>`;
