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
