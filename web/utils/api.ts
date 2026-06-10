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

// Mark a checklist map node read (the user dwelled on it) — clears its
// node-level unread cue, mirroring marking a thread's CC messages read.
export function postMapChecklistRead(mapId: string, nodeId: string) {
  return fetch("/map-checklist-read", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ map_id: mapId, node_id: nodeId }),
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
