// Sidebar session ordering. The user drags sessions into a preferred order; we
// persist and re-apply it. Split out from Sidebar.tsx so it's unit-testable.
//
// Ordering is keyed PURELY on cc_session_id. Not the broker session ROW id: the
// broker mints a fresh row id on every CC restart, so an id-keyed order would
// drop a restarted session to the bottom every time. cc_session_id is stable
// across restarts and `/mcp` (reclaim carries it over) AND unique per session —
// so two sessions sharing a cwd order independently, which a cwd key could not
// (it collapsed them into one slot). An attached session always has a
// cc_session_id, so cwd appears nowhere here.

type OrderableSession = { cc_session_id: string | null };

// The key a session is persisted under: its cc_session_id. null only for a
// (non-occurring) pre-attach session, which the caller skips.
export function sessionOrderKey(s: OrderableSession): string | null {
  return s.cc_session_id;
}

// Apply a saved order (a list of cc_session_ids). Listed sessions come first in
// listed order; the rest follow in natural (incoming) order, stable for ties and
// for unlisted sessions.
export function applyOrder<T extends OrderableSession>(
  sessions: T[],
  order: string[],
): T[] {
  const rank = new Map<string, number>();
  order.forEach((key, i) => {
    if (!rank.has(key)) rank.set(key, i);
  });
  const rankOf = (s: OrderableSession): number =>
    s.cc_session_id != null && rank.has(s.cc_session_id)
      ? (rank.get(s.cc_session_id) as number)
      : Infinity;
  return sessions
    .map((s, i) => ({ s, i }))
    .sort((a, b) => {
      const ra = rankOf(a.s);
      const rb = rankOf(b.s);
      if (ra !== rb) return ra - rb;
      return a.i - b.i;
    })
    .map((x) => x.s);
}
