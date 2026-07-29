import { useEffect, useState } from "react";


// What an issue id in a message MEANS.
//
// Ids became clickable on 2026-07-29, and the user's response was immediate:
// "there is basically nothing I can judge from an id alone". CC keeps writing
// ids (that is what makes the link possible at all) and the reader gets the
// title — so this maps one to the other at render time.
//
// Batched, because a single message can mention several ids and a thread can
// hold dozens of messages: every new id seen in a frame is collected and asked
// for in ONE call on the next tick, rather than one request per code span.
// Cached forever per page — a title changing mid-session is not worth a
// revalidation strategy, and the tracker is where titles get edited anyway.

export type IssueBrief = { id: string; title: string; state: string };

// Local rather than shared: issues.ts keeps its own copy private, and one tiny
// fetch wrapper per module beats exporting a general-purpose one that then
// tempts every caller to route through it.
async function post<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  return (await r.json()) as T;
}

const cache = new Map<string, IssueBrief | null>();
const pending = new Set<string>();
const listeners = new Set<() => void>();
let flushScheduled = false;

function notify() {
  for (const l of listeners) l();
}

function flush() {
  flushScheduled = false;
  const ids = [...pending];
  pending.clear();
  if (ids.length === 0) return;
  post<{ ok: boolean; titles: Record<string, IssueBrief> }>("/issue-titles", {
    ids,
  })
    .then((r) => {
      for (const id of ids) cache.set(id, r.titles?.[id] ?? null);
      notify();
    })
    .catch(() => {
      // Leave them uncached so a later render can retry; showing the raw id
      // meanwhile is the correct fallback, not an error state.
      for (const id of ids) cache.delete(id);
    });
}

function request(id: string) {
  if (cache.has(id) || pending.has(id)) return;
  pending.add(id);
  if (flushScheduled) return;
  flushScheduled = true;
  queueMicrotask(flush);
}

/**
 * The issue an id refers to, or null while it is being looked up (and for an
 * id that resolves to nothing — a placeholder in a sentence ABOUT the format,
 * which must keep rendering as written).
 */
export function useIssueBrief(id: string): IssueBrief | null {
  const [, bump] = useState(0);
  useEffect(() => {
    const l = () => bump((n) => n + 1);
    listeners.add(l);
    request(id);
    return () => {
      listeners.delete(l);
    };
  }, [id]);
  return cache.get(id) ?? null;
}
