import { useEffect } from "react";

// Single source of truth for the browser-tab / external-tracker title across
// every page (board / session dashboard / map). Each page passes its breadcrumb
// parts (most-general first, e.g. [ownerName, boardTitle]); falsy parts are
// dropped, so a page can pass values that aren't loaded yet without branching.
//
// Why a hook and not a single setter up in frontend.tsx: the title material
// (board title, map title, session name) is fetched by the page components, so
// only they have it — App just knows the route + ids. This hook keeps the
// "discussion-tree / …" format and the unmount reset in ONE place while each
// page stays responsible for its own crumbs.
const ROOT_TITLE = "discussion-tree";

export function useDocumentTitle(
  parts: Array<string | null | undefined>,
): void {
  const title = [ROOT_TITLE, ...parts.filter(Boolean)].join(" / ");
  useEffect(() => {
    document.title = title;
    // Reset on unmount so the next page writes its own title instead of
    // inheriting this one during the brief gap before it loads its data.
    return () => {
      document.title = ROOT_TITLE;
    };
  }, [title]);
}
