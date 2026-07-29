// "The frontend you are running is no longer the one the broker serves."
//
// The broker sends its web build id on every socket open (broker/web-build-id).
// The first one a tab sees is, by definition, the build it loaded with; a later
// socket answering with a different id means this tab is stale.
//
// This exists because HMR was turned off (it reloaded the user's page on every
// edit under web/ — see broker.ts) and the fallback, "remember to hard-refresh",
// is a step both sides forget. Noticing is now the app's job; WHEN to reload
// stays the user's, via a banner that does not go away (see UpdateBanner).

export const APP_OUTDATED_EVENT = "pd-app-outdated";

let seenBuildId: string | null = null;
let announced = false;

/**
 * Record a build id reported by the broker. Returns true the first time it
 * differs from the one this tab loaded with — later calls with the same stale
 * id return false, so a flapping socket cannot re-announce on every retry.
 */
export function noteBuildId(id: unknown): boolean {
  if (typeof id !== "string" || !id) return false;
  if (seenBuildId === null) {
    seenBuildId = id;
    return false;
  }
  if (id === seenBuildId || announced) return false;
  announced = true;
  return true;
}

/** Test seam — the module-level memory is deliberately per-tab otherwise. */
export function resetBuildIdMemory(): void {
  seenBuildId = null;
  announced = false;
}

/** Fired by the socket layer; <UpdateBanner> owns what happens next. */
export function announceOutdated(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(APP_OUTDATED_EVENT));
}

export function subscribeOutdated(cb: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  window.addEventListener(APP_OUTDATED_EVENT, cb);
  return () => window.removeEventListener(APP_OUTDATED_EVENT, cb);
}
