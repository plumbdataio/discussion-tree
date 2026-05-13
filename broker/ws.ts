// WebSocket fan-out. Boards have per-board subscriber sets so /post-to-node /
// /set-node-status etc. can broadcast updates only to clients viewing that
// board. Activity / sidebar-refresh events go to ALL connected clients
// because they affect chrome (header badge, sidebar dot) regardless of the
// board the user is currently looking at.

const wsClients = new Map<string, Set<any>>();

export function subscribe(boardId: string, ws: any) {
  if (!wsClients.has(boardId)) wsClients.set(boardId, new Set());
  wsClients.get(boardId)!.add(ws);
}

export function unsubscribe(boardId: string, ws: any) {
  wsClients.get(boardId)?.delete(ws);
}

// Per-board broadcast (the hot path for thread / structure / status updates).
export function broadcast(boardId: string, payload: unknown) {
  const clients = wsClients.get(boardId);
  if (!clients) return;
  const json = JSON.stringify(payload);
  for (const ws of clients) {
    try {
      ws.send(json);
    } catch {
      /* ignore — closed sockets clean themselves up via unsubscribe */
    }
  }
}

// Cross-board broadcast — used for activity transitions and sidebar-refresh.
// Frontend filters: it only displays the activity badge when the activity's
// session_id matches the current board's owning session.
export function broadcastToAll(payload: unknown) {
  const json = JSON.stringify(payload);
  for (const clients of wsClients.values()) {
    for (const ws of clients) {
      try {
        ws.send(json);
      } catch {
        /* ignore */
      }
    }
  }
}
