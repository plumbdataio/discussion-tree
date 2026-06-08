#!/usr/bin/env bun
/**
 * discussion-tree broker daemon — entry point.
 *
 * Singleton HTTP + WebSocket server backed by SQLite. Each handler module
 * under ./broker/ exports its own `routes` table; this file just merges
 * them, wires Bun.serve, and runs periodic maintenance. Auto-launched by
 * the MCP server when no broker is already listening.
 */

import indexHtml from "./web/index.html";
import {
  DB_PATH,
  HOME_DIR,
  PORT,
  PUBLIC_URL,
  STALE_SESSION_SWEEP_MS,
  UPLOADS_DIR,
} from "./broker/config.ts";
import {
  routes as activityRoutes,
  startActivityWatchdog,
} from "./broker/activity.ts";
import { routes as boardsRoutes } from "./broker/boards.ts";
import { routes as checklistRoutes } from "./broker/checklist.ts";
import { routes as favoritesRoutes } from "./broker/favorites.ts";
import { routes as feedbackRoutes } from "./broker/feedback.ts";
import { routes as globalBannerRoutes } from "./broker/global-banner.ts";
import { routes as mapRoutes, getMapView } from "./broker/maps.ts";
import { getBoardView } from "./broker/helpers.ts";
import { routes as nodesRoutes } from "./broker/nodes.ts";
import { initPower, routes as powerRoutes } from "./broker/power.ts";
import { routes as readsRoutes } from "./broker/reads.ts";
import { routes as contextUsageRoutes } from "./broker/context-usage.ts";
import {
  cleanStaleSessions,
  handleListSessions,
  routes as sessionsRoutes,
} from "./broker/sessions.ts";
import { routes as threadsRoutes } from "./broker/threads.ts";
import { routes as uploadsRoutes } from "./broker/uploads.ts";
import { subscribe, unsubscribe } from "./broker/ws.ts";

// --- Periodic maintenance ---

cleanStaleSessions();
setInterval(cleanStaleSessions, STALE_SESSION_SWEEP_MS);
startActivityWatchdog();
initPower();

// --- POST route registry ---
//
// Merge each module's routes into a single path-to-handler map. The fetch
// handler dispatches to whichever entry matches `url.pathname`. Adding a
// new endpoint is now a one-line change inside the relevant module — no
// touch on this file required.

type RouteHandler = (body: any) => unknown | Promise<unknown>;

const POST_ROUTES: Record<string, RouteHandler> = {
  ...sessionsRoutes,
  ...boardsRoutes,
  ...checklistRoutes,
  ...nodesRoutes,
  ...threadsRoutes,
  ...activityRoutes,
  ...uploadsRoutes,
  ...feedbackRoutes,
  ...powerRoutes,
  ...readsRoutes,
  ...contextUsageRoutes,
  ...favoritesRoutes,
  ...globalBannerRoutes,
  ...mapRoutes,
};

// --- HTTP + WebSocket server ---

// DISCUSSION_TREE_BIND lets you expose the broker to other devices
// (e.g. via Tailscale Serve from a different LAN host) without
// touching code. Default stays 127.0.0.1 so the safe path is the
// default. Anything else means "no auth, anyone who can reach this
// port can drive every MCP tool" — warn loudly so it's not done
// accidentally.
const BIND_HOST = process.env.DISCUSSION_TREE_BIND ?? "127.0.0.1";
if (BIND_HOST !== "127.0.0.1" && BIND_HOST !== "localhost") {
  console.error(
    `[discussion-tree broker] WARNING: binding to ${BIND_HOST} — the broker has NO authentication, anything that can reach this port can read/write boards. Make sure only trusted hosts can reach it (Tailscale ACL / firewall).`,
  );
}

const server = Bun.serve({
  port: PORT,
  hostname: BIND_HOST,
  routes: {
    "/": indexHtml,
    "/board/:id": indexHtml,
    "/session/:id": indexHtml,
    "/map/:id": indexHtml,
  },
  async fetch(req, server) {
    const url = new URL(req.url);
    const path = url.pathname;

    // WebSocket upgrade for /ws/<board_id>.
    if (path.startsWith("/ws/")) {
      const boardId = path.slice("/ws/".length);
      const ok = server.upgrade(req, { data: { boardId } });
      if (ok) return undefined as any;
      return new Response("Upgrade failed", { status: 400 });
    }

    if (path === "/health") {
      return Response.json({ status: "ok" });
    }

    // Web app manifest — display:standalone is what makes the home-screen
    // icon open in its own single-instance window (no duplicate Safari tabs).
    if (req.method === "GET" && path === "/manifest.webmanifest") {
      return new Response(
        JSON.stringify({
          name: "discussion-tree",
          short_name: "dt",
          start_url: "/",
          scope: "/",
          display: "standalone",
          background_color: "#ffffff",
          theme_color: "#a855f7",
        }),
        { headers: { "content-type": "application/manifest+json" } },
      );
    }

    if (req.method === "GET" && path.startsWith("/api/board/")) {
      const id = path.slice("/api/board/".length);
      const view = getBoardView(id);
      if (!view) return Response.json({ error: "Not found" }, { status: 404 });
      return Response.json(view);
    }

    if (req.method === "GET" && path === "/api/sessions") {
      return Response.json(handleListSessions());
    }

    // Divergent-discussion map read API — the map view (/map/:id, served by
    // the SPA above) fetches this and subscribes to /ws/<map_id> for updates.
    if (req.method === "GET" && path.startsWith("/api/map/")) {
      const id = path.slice("/api/map/".length);
      const view = getMapView(id);
      if (!view) return Response.json({ error: "Not found" }, { status: 404 });
      return Response.json(view);
    }

    if (req.method === "GET" && path.startsWith("/uploads/")) {
      // Serve uploaded images. WHATWG-URL has already collapsed any `..`
      // segments before we get here, but the explicit checks below still
      // defend against pathological raw clients.
      const rel = path.slice("/uploads/".length);
      if (rel.includes("..") || rel.startsWith("/")) {
        return new Response("Forbidden", { status: 403 });
      }
      const file = Bun.file(`${UPLOADS_DIR}/${rel}`);
      if (!(await file.exists())) {
        return new Response("Not found", { status: 404 });
      }
      return new Response(file);
    }

    if (req.method === "POST") {
      let body: any;
      try {
        body = await req.json();
      } catch {
        return Response.json({ error: "invalid json" }, { status: 400 });
      }
      const handler = POST_ROUTES[path];
      if (!handler) {
        return Response.json({ error: "not found" }, { status: 404 });
      }
      try {
        return Response.json(await handler(body));
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return Response.json({ error: msg }, { status: 500 });
      }
    }

    return new Response("discussion-tree broker", { status: 200 });
  },
  websocket: {
    open(ws) {
      const { boardId } = ws.data as { boardId: string };
      subscribe(boardId, ws);
    },
    close(ws) {
      const { boardId } = ws.data as { boardId: string };
      unsubscribe(boardId, ws);
    },
    message() {
      // No inbound WS messages used.
    },
  },
});

console.error(
  `[discussion-tree broker] listening on http://127.0.0.1:${server.port}`,
);
console.error(
  `[discussion-tree broker] state: ${HOME_DIR} · db: ${DB_PATH} · public: ${PUBLIC_URL}`,
);
