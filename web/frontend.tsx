import React, { useEffect } from "react";
import { createRoot } from "react-dom/client";
import i18n, { resolveLanguage } from "./i18n.ts";
import { BoardApp } from "./components/BoardApp.tsx";
import { GearButton } from "./components/GearButton.tsx";
import { RootDashboard } from "./components/RootDashboard.tsx";
import { SessionDashboard } from "./components/SessionDashboard.tsx";
import { useSettings } from "./utils/settings.ts";
import { installLinkInterceptor, useRoute } from "./utils/router.ts";
import {
  getBoardIdFromUrl,
  getSessionIdFromUrl,
} from "./utils/url.ts";

// Hook the click interceptor before React even mounts so the very first link
// click is already SPA-style (no full HTTP reload).
installLinkInterceptor();

function App() {
  const path = useRoute();
  const sessionId = getSessionIdFromUrl(path);
  const boardId = getBoardIdFromUrl(path);
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

  // `key` props ensure each page re-mounts (and thus refetches its data)
  // when the route's ID changes. Without the key, BoardApp's useEffect
  // wouldn't notice the boardId change since useMemo([]) only ran once.
  let page: React.ReactNode;
  if (sessionId) {
    page = <SessionDashboard key={`s:${sessionId}`} sessionId={sessionId} />;
  } else if (boardId) {
    page = <BoardApp key={`b:${boardId}`} />;
  } else if (path === "/" || path === "") {
    page = <RootDashboard />;
  } else {
    page = <BoardApp key={`b:${path}`} />;
  }
  return (
    <>
      {page}
      <GearButton />
    </>
  );
}

const root = createRoot(document.getElementById("root")!);
root.render(<App />);
