import { useEffect, useState } from "react";

// Lightweight client-side router. There are exactly three routes
// (`/`, `/session/:id`, `/board/:id`) and a single SPA-style pageview swap
// per click — no library, just pushState + a popstate listener + a global
// link interceptor.
//
// installLinkInterceptor() is called once at startup and catches plain
// left-clicks on internal `<a>` tags, replacing the full HTTP page reload
// with `navigate(href)`. Cmd/Ctrl/Shift/middle-click and `target="_blank"`
// links are passed through to the browser unchanged so "open in new tab"
// keeps working.

const ROUTE_CHANGE_EVENT = "pd-route-change";

export function useRoute(): string {
  const [path, setPath] = useState(
    typeof window !== "undefined" ? window.location.pathname : "/",
  );
  useEffect(() => {
    const handler = () => setPath(window.location.pathname);
    window.addEventListener("popstate", handler);
    window.addEventListener(ROUTE_CHANGE_EVENT, handler);
    return () => {
      window.removeEventListener("popstate", handler);
      window.removeEventListener(ROUTE_CHANGE_EVENT, handler);
    };
  }, []);
  return path;
}

export function navigate(path: string) {
  if (typeof window === "undefined") return;
  if (window.location.pathname === path) return;
  window.history.pushState(null, "", path);
  window.dispatchEvent(new Event(ROUTE_CHANGE_EVENT));
}

// --- Resume the last page after the OS killed the installed PWA -------------
//
// iOS evicts a backgrounded home-screen app under memory pressure (routine on
// a 3GB iPhone SE2) and relaunches it at the manifest's start_url ("/"), so the
// user lands on the top page instead of the board they were on. The manifest
// has no "restore last URL" option, so we remember the path ourselves and jump
// back to it on a fresh launch.
//
// Only in standalone (installed) mode: a normal browser tab keeps its own URL
// and history, and a deliberate visit to "/" there must stay on "/". A "fresh
// launch" is told apart from an in-app visit to "/" by a sessionStorage flag,
// which an evicted-and-relaunched app no longer has.
const LAST_ROUTE_KEY = "dt-last-route";
const LAUNCHED_KEY = "dt-launched";

export function isStandaloneApp(): boolean {
  if (typeof window === "undefined") return false;
  return (
    window.matchMedia?.("(display-mode: standalone)").matches === true ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

function rememberRoute() {
  try {
    localStorage.setItem(LAST_ROUTE_KEY, window.location.pathname + window.location.search);
  } catch {
    /* storage unavailable: resuming is a convenience, never an error */
  }
}

// Call once at startup, BEFORE the first render.
export function installLastRouteResume() {
  if (typeof window === "undefined" || !isStandaloneApp()) return;
  let fresh = false;
  try {
    fresh = sessionStorage.getItem(LAUNCHED_KEY) === null;
    sessionStorage.setItem(LAUNCHED_KEY, "1");
  } catch {
    /* no sessionStorage: treat as not fresh, never redirect */
  }
  if (fresh && window.location.pathname === "/") {
    let last: string | null = null;
    try {
      last = localStorage.getItem(LAST_ROUTE_KEY);
    } catch {
      /* ignore */
    }
    // Same-origin paths only; never bounce to "/" itself.
    if (last && last.startsWith("/") && !last.startsWith("//") && last !== "/") {
      window.history.replaceState(null, "", last);
    }
  }
  rememberRoute();
  window.addEventListener("popstate", rememberRoute);
  window.addEventListener(ROUTE_CHANGE_EVENT, rememberRoute);
}

let installed = false;

export function installLinkInterceptor() {
  if (installed || typeof window === "undefined") return;
  installed = true;
  document.addEventListener("click", (e) => {
    // Defer to the browser when the user is asking for new-tab / new-window
    // semantics. matches typical SPA router behavior.
    if (e.defaultPrevented) return;
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    if ((e as MouseEvent).button !== 0) return;
    const a = (e.target as Element | null)?.closest?.("a");
    if (!a) return;
    if (a.target && a.target !== "" && a.target !== "_self") return;
    if (a.hasAttribute("download")) return;
    const href = a.getAttribute("href");
    if (!href) return;
    // Only handle same-origin path-form hrefs. External / hash-only / mailto
    // / tel / etc. links go through.
    if (!href.startsWith("/")) return;
    if (href.startsWith("//")) return; // protocol-relative
    e.preventDefault();
    navigate(href);
  });
}
