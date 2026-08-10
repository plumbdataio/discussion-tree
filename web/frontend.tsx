import React, { useEffect } from "react";
import { createRoot } from "react-dom/client";
import i18n, { resolveLanguage } from "./i18n.ts";
import { AnchorButton } from "./components/AnchorButton.tsx";
import { AppShell } from "./components/AppShell.tsx";
import { BoardApp } from "./components/BoardApp.tsx";
import { ConnectionBanner } from "./components/ConnectionBanner.tsx";
import { UpdateBanner } from "./components/UpdateBanner.tsx";
import { GearButton } from "./components/GearButton.tsx";
import { GlobalBanner } from "./components/GlobalBanner.tsx";
import { MapView } from "./components/MapView.tsx";
import { DiagramView } from "./components/DiagramView.tsx";
import { RootDashboard } from "./components/RootDashboard.tsx";
import { ScheduledEditModal } from "./components/ScheduledEditModal.tsx";
import { ScheduledListModal } from "./components/ScheduledListModal.tsx";
import { TimerConfirmModal } from "./components/TimerConfirmModal.tsx";
import { IssueTrackerModal } from "./components/IssueTrackerModal.tsx";
import { SessionDashboard } from "./components/SessionDashboard.tsx";
import { ToastContainer } from "./components/Toast.tsx";
import { useSettings } from "./utils/settings.ts";
import { installLinkInterceptor, useRoute } from "./utils/router.ts";
import {
  getBoardIdFromUrl,
  getDiagramIdFromUrl,
  getMapIdFromUrl,
  getSessionIdFromUrl,
} from "./utils/url.ts";

// Hook the click interceptor before React even mounts so the very first link
// click is already SPA-style (no full HTTP reload).
installLinkInterceptor();

function App() {
  const path = useRoute();
  const sessionId = getSessionIdFromUrl(path);
  const boardId = getBoardIdFromUrl(path);
  const mapId = getMapIdFromUrl(path);
  const diagramId = getDiagramIdFromUrl(path);
  const [settings] = useSettings();

  // Keep i18next in sync with the user's language setting. When set to
  // "system", we hand control back to the LanguageDetector by calling
  // changeLanguage(undefined) — i18next then re-runs detection.
  useEffect(() => {
    const target = resolveLanguage(settings.language);
    if (target) {
      if (i18n.language !== target) i18n.changeLanguage(target);
    } else {
      // detector picks, but only if it has not already settled — re-run
      // detection by changing to navigator.language directly.
      const nav = navigator.language?.split("-")[0];
      const detected = nav === "ja" ? "ja" : "en";
      if (i18n.language !== detected) i18n.changeLanguage(detected);
    }
  }, [settings.language]);

  // Resolve settings.theme → concrete `light` / `dark` and set it on
  // <html data-theme>. CSS keys all dark-mode overrides off
  // `:root[data-theme="dark"]`, so resolving system here means CSS doesn't
  // need a media query: a single source of truth flows from settings →
  // OS-detection → DOM attribute → CSS.
  useEffect(() => {
    const apply = () => {
      const choice = settings.theme;
      let resolved: "light" | "dark";
      if (choice === "system") {
        resolved = window.matchMedia?.("(prefers-color-scheme: dark)").matches
          ? "dark"
          : "light";
      } else {
        resolved = choice;
      }
      document.documentElement.dataset.theme = resolved;
    };
    apply();
    if (settings.theme !== "system") return;
    // Follow OS-level changes only when the user has chosen "system".
    const mql = window.matchMedia("(prefers-color-scheme: dark)");
    mql.addEventListener("change", apply);
    return () => mql.removeEventListener("change", apply);
  }, [settings.theme]);

  // Force a full remount of the MAIN page on every route change: the rendered
  // page is keyed by `path` (below), so React unmounts the previous view —
  // tearing down its DOM, state, effects, and WS subscriptions — before it
  // mounts the next. Without this, navigating board→board REUSES the same
  // <BoardApp> (only its boardId prop changes), which lets the tab's memory
  // grow as old view data lingers. The persistent shell + sidebar live in
  // <AppShell> (OUTSIDE the keyed page), so they never remount — only the main
  // view does. Trade-off: each navigation re-fetches and resets the main scroll
  // position (accepted 2026-08-10 for the memory win).
  let page: React.ReactNode;
  if (sessionId) {
    page = <SessionDashboard sessionId={sessionId} />;
  } else if (mapId) {
    page = <MapView mapId={mapId} />;
  } else if (diagramId) {
    page = <DiagramView diagramId={diagramId} />;
  } else if (boardId) {
    page = <BoardApp boardId={boardId} />;
  } else if (path === "/" || path === "") {
    page = <RootDashboard />;
  } else {
    page = <BoardApp boardId={null} />;
  }
  return (
    <>
      <GlobalBanner />
      <ConnectionBanner />
      <UpdateBanner />
      <AppShell
        currentBoardId={boardId}
        currentMapId={mapId}
        currentDiagramId={diagramId}
      >
        <React.Fragment key={path}>{page}</React.Fragment>
      </AppShell>
      <AnchorButton />
      <GearButton />
      <ScheduledListModal />
      <ScheduledEditModal />
      <TimerConfirmModal />
      <IssueTrackerModal />
      <ToastContainer />
    </>
  );
}

// Stop the browser from restoring nested scroll positions on
// reload. The default board's thread is the only place this would
// be visible (everything else opens fresh) and there auto-restore
// fights the column-reverse "snap to bottom on mount" so the user
// sees a different scroll position on every reload. Manual lets
// our own mount-time scrollIntoView own the initial position.
if ("scrollRestoration" in history) {
  history.scrollRestoration = "manual";
}

// Point at the web app manifest (served dynamically by the broker). Injected
// here rather than in index.html so the Bun HTML bundler doesn't try to
// resolve it as a build-time asset. display:standalone in the manifest, plus
// the apple-mobile-web-app meta tags, make the home-screen icon open as a
// single-instance app instead of spawning a new Safari tab each tap.
if (typeof document !== "undefined" && !document.querySelector("link[rel=manifest]")) {
  const link = document.createElement("link");
  link.rel = "manifest";
  link.href = "/manifest.webmanifest";
  document.head.appendChild(link);
}

const root = createRoot(document.getElementById("root")!);
root.render(<App />);
