// Sidebar session ordering. The user drags sessions into a preferred order; we
// persist and re-apply it. Split out from Sidebar.tsx so it's unit-testable.
//
// The key a session is ordered/persisted by is its cc_session_id (preferred),
// falling back to cwd. Why not the broker session ROW id: the broker mints a
// fresh row id on every CC restart, so an id-keyed order would drop a restarted
// session to the bottom every time. cc_session_id is stable across restarts and
// `/mcp` (reclaim carries it over) AND unique per session — so two sessions that
// share a cwd can be ordered independently, which a plain cwd key could not (it
// collapsed them into one slot). cwd stays as the fallback for a session that
// hasn't attached yet (no cc_session_id) and for legacy cwd-keyed saved orders.

type OrderableSession = { cc_session_id: string | null; cwd: string };

// The stable-unique key a session is persisted under.
export function sessionOrderKey(s: OrderableSession): string {
  return s.cc_session_id ?? s.cwd;
}

// Apply a saved order (a list of keys). A session resolves its rank by
// cc_session_id first, then by cwd — so a legacy cwd-keyed order keeps working
// until the next reorder migrates it to cc_session_id keys. Listed sessions come
// first in listed order; the rest follow in natural (incoming) order, stable for
// ties and for unlisted sessions.
export function applyOrder<T extends OrderableSession>(
  sessions: T[],
  order: string[],
): T[] {
  const rank = new Map<string, number>();
  order.forEach((key, i) => {
    if (!rank.has(key)) rank.set(key, i);
  });
  const rankOf = (s: OrderableSession): number => {
    if (s.cc_session_id != null && rank.has(s.cc_session_id))
      return rank.get(s.cc_session_id) as number;
    if (rank.has(s.cwd)) return rank.get(s.cwd) as number;
    return Infinity;
  };
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
