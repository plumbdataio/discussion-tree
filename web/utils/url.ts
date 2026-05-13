// Helpers used by both the initial page load and the SPA router (which calls
// these with the new path each time). Default to window.location.pathname so
// existing call sites keep working without arguments.

export function getBoardIdFromUrl(
  pathname: string = window.location.pathname,
): string | null {
  const m = pathname.match(/^\/board\/([^/]+)/);
  return m ? m[1] : null;
}

export function getSessionIdFromUrl(
  pathname: string = window.location.pathname,
): string | null {
  const m = pathname.match(/^\/session\/([^/]+)/);
  return m ? m[1] : null;
}
