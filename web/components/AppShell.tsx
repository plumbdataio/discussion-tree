import React, { createContext, useContext, useState } from "react";
import { createPortal } from "react-dom";
import { Sidebar } from "./Sidebar.tsx";

type ShellSlots = { header: HTMLElement | null; main: HTMLElement | null };
const ShellSlotsContext = createContext<ShellSlots>({
  header: null,
  main: null,
});

// The persistent application chrome. The `.app` frame, the top header slot and
// the sidebar are owned HERE and rendered exactly once for the SPA's lifetime.
// A route change swaps only the page (passed as `children`); the sidebar
// instance is never unmounted, so its scroll position and in-flight fetch
// survive navigation — no flash, no scroll-to-top, no layout shift. (The old
// design re-rendered an entire `.app > .header + .app-body > Sidebar` tree
// inside every page, so any cross-surface navigation remounted the sidebar.)
//
// Each page fills the header + main through <AppLayout>, which portals its two
// fragments into the host nodes below. The hosts are `display:contents` so the
// portaled `<header>` / main pane land in the exact flex slots the old per-page
// markup produced — zero visual change.
export function AppShell({
  currentBoardId,
  currentMapId,
  currentDiagramId,
  children,
}: {
  currentBoardId: string | null;
  currentMapId: string | null;
  currentDiagramId: string | null;
  children: React.ReactNode;
}) {
  // Host elements captured via callback refs → state so <AppLayout> can portal
  // into them. Callback refs fire during the commit phase (before paint), and
  // the resulting setState is flushed before the browser paints, so the very
  // first frame already has the page's header + main in place.
  const [headerHost, setHeaderHost] = useState<HTMLElement | null>(null);
  const [mainHost, setMainHost] = useState<HTMLElement | null>(null);
  return (
    <ShellSlotsContext.Provider value={{ header: headerHost, main: mainHost }}>
      <div className="app">
        <div className="app-header-slot" ref={setHeaderHost} />
        <div className="app-body">
          <Sidebar
            currentBoardId={currentBoardId}
            currentMapId={currentMapId}
            currentDiagramId={currentDiagramId}
          />
          <div className="app-main-slot" ref={setMainHost} />
        </div>
      </div>
      {children}
    </ShellSlotsContext.Provider>
  );
}

// Used by every page in place of the old hand-rolled `.app` markup. `header` is
// the page's `<header className="header">` element (the page keeps ownership so
// it can attach its own ref / dynamic classes); `children` is its main pane.
// Both are portaled into AppShell's persistent host nodes. Until the hosts are
// captured (the single extra render on first mount) this renders nothing — that
// render happens before paint, so it is not visible.
export function AppLayout({
  header,
  children,
}: {
  header: React.ReactNode;
  children: React.ReactNode;
}) {
  const { header: headerHost, main: mainHost } = useContext(ShellSlotsContext);
  return (
    <>
      {headerHost && createPortal(header, headerHost)}
      {mainHost && createPortal(children, mainHost)}
    </>
  );
}
