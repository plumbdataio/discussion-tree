export function postSubmitAnswer(
  boardId: string,
  nodeId: string,
  text: string,
) {
  return fetch("/submit-answer", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ board_id: boardId, node_id: nodeId, text }),
  });
}

export function postBoardStructureRequest(boardId: string, text: string) {
  return fetch("/submit-answer", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      board_id: boardId,
      // node_id is unused for structure requests — the broker substitutes a
      // synthetic placeholder — but the existing endpoint validates presence.
      node_id: "__board__",
      text,
      kind: "board_structure_request",
    }),
  });
}

// Toggle a board's automatic status rollup. Off freezes the board status so a
// status-tracking board doesn't auto-settle and slip behind the sidebar filter.
export function postSetBoardAutoStatus(boardId: string, enabled: boolean) {
  return fetch("/set-board-auto-status", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ board_id: boardId, enabled }),
  });
}

// --- Maps ---
// The map's general chat + per-node inputs post here. Blocking on the broker
// (mirrors /submit-answer): resolves once the owning CC polls. node_id
// "__general__" (or omitted) targets the map-wide chat.
export function postMapChat(mapId: string, nodeId: string, text: string) {
  return fetch("/map-chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ map_id: mapId, node_id: nodeId, text }),
  });
}

// --- Diagrams ---
// The diagram's right-side chat posts here (mirrors postMapChat). Blocking on
// the broker until the owning CC polls; CC replies by upserting the diagram
// source (live re-render) and/or posting back to the chat thread.
export function postDiagramChat(diagramId: string, text: string) {
  return fetch("/diagram-chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ diagram_id: diagramId, text }),
  });
}

// Persist a node's position/size after a drag/resize. SILENT in the pull
// model — the broker records it and broadcasts to other browsers, but does
// not push to the CC (it re-reads on next act).
export function postMapMoveNode(
  mapId: string,
  nodeId: string,
  x: number,
  y: number,
  w?: number,
  h?: number,
) {
  return fetch("/map-move-node", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ map_id: mapId, node_id: nodeId, x, y, w, h }),
  });
}

// The human draws an edge in the UI → persist it. Also silent (pull model).
export function postMapConnect(mapId: string, fromId: string, toId: string) {
  return fetch("/map-connect", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ map_id: mapId, from_id: fromId, to_id: toId }),
  });
}

export function postMapDisconnect(mapId: string, edgeId: string) {
  return fetch("/map-disconnect", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ map_id: mapId, edge_id: edgeId }),
  });
}

// Logical-delete a node from the UI (Backspace/Delete). The row + its messages
// stay in the DB so the delete can be undone; getMapView just hides it.
export function postMapDeleteNode(mapId: string, nodeId: string) {
  return fetch("/map-delete-node", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ map_id: mapId, node_id: nodeId }),
  });
}

// Mark a checklist map node read (the user dwelled on it / opened it) — clears
// its node-level unread cue, mirroring marking a thread's CC messages read.
// `version` is the checklist version the client observed: the broker advances
// read state only up to it, so a change that arrived after render stays unread.
export function postMapChecklistRead(
  mapId: string,
  nodeId: string,
  version: number,
) {
  return fetch("/map-checklist-read", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ map_id: mapId, node_id: nodeId, version }),
  });
}

// Undo a delete: un-tombstone the given nodes and/or edges in one call.
export function postMapRestore(
  mapId: string,
  opts: { nodeIds?: string[]; edgeIds?: string[] },
) {
  return fetch("/map-restore", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      map_id: mapId,
      node_ids: opts.nodeIds ?? [],
      edge_ids: opts.edgeIds ?? [],
    }),
  });
}

// Grouping frames — user-drawn rectangles behind the nodes. All silent (pull
// model): broadcast to other browsers, no AI push.
export function postMapAddFrame(
  mapId: string,
  f: { title?: string; color?: string; x: number; y: number; w: number; h: number },
) {
  return fetch("/map-add-frame", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ map_id: mapId, ...f }),
  });
}

export function postMapUpdateFrame(
  mapId: string,
  frameId: string,
  patch: {
    title?: string;
    color?: string;
    x?: number;
    y?: number;
    w?: number;
    h?: number;
    title_size?: number | null;
  },
) {
  return fetch("/map-update-frame", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ map_id: mapId, frame_id: frameId, ...patch }),
  });
}

export function postMapDeleteFrame(mapId: string, frameId: string) {
  return fetch("/map-delete-frame", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ map_id: mapId, frame_id: frameId }),
  });
}

export function postMapRestoreFrame(mapId: string, frameId: string) {
  return fetch("/map-restore-frame", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ map_id: mapId, frame_id: frameId }),
  });
}

// Inject a TUI command (e.g. /compact) into the owning CC's tmux pane. The
// broker enforces an allowlist + "session idle" guard; returns { ok, error }.
export async function postCliSend(
  sessionId: string,
  command: string,
  args: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const r = await fetch("/cli-send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: sessionId, command, args }),
    });
    return (await r.json()) as { ok: boolean; error?: string };
  } catch {
    return { ok: false, error: "network" };
  }
}

// De-duplicated history of args previously sent with a CLI command (newest
// first), so the command modal can offer past prompts to re-use.
export async function getCliHistory(
  command: string,
): Promise<{ args: string; last_used_at: string }[]> {
  try {
    const r = await fetch("/cli-history", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command }),
    });
    const j = (await r.json()) as {
      ok: boolean;
      history?: { args: string; last_used_at: string }[];
    };
    return j.ok ? j.history ?? [] : [];
  } catch {
    return [];
  }
}

export async function uploadImage(
  file: File,
  boardId: string,
): Promise<{ url: string; path: string }> {
  const data = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      const idx = result.indexOf(",");
      resolve(idx >= 0 ? result.slice(idx + 1) : result);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });

  const res = await fetch("/upload-image", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      board_id: boardId,
      filename: file.name || "pasted",
      mime: file.type,
      data_base64: data,
    }),
  });
  if (!res.ok) throw new Error(`upload failed: HTTP ${res.status}`);
  const json = (await res.json()) as {
    ok: boolean;
    path?: string;
    url?: string;
    error?: string;
  };
  if (!json.ok || !json.path || !json.url) {
    throw new Error(json.error ?? "upload failed");
  }
  return { url: json.url, path: json.path };
}

export function extractImageFiles(
  items: DataTransferItemList | FileList | null,
): File[] {
  if (!items) return [];
  const result: File[] = [];
  if (items instanceof FileList) {
    for (let i = 0; i < items.length; i++) {
      const f = items[i];
      if (f && f.type.startsWith("image/")) result.push(f);
    }
    return result;
  }
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (it && it.kind === "file") {
      const f = it.getAsFile();
      if (f && f.type.startsWith("image/")) result.push(f);
    }
  }
  return result;
}
