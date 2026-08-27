// Sidebar session ordering. The user drags sessions into a preferred order; we
// persist and re-apply it. Split out from Sidebar.tsx so it's unit-testable.
//
// A session is ordered/persisted PURELY by its cc_session_id. Why not the broker
// session ROW id: the broker mints a fresh row id on every CC restart, so an
// id-keyed order would drop a restarted session to the bottom every time.
// cc_session_id is stable across restarts and `/mcp` (reclaim carries it over)
// AND unique per session — so two sessions that share a cwd order independently,
// which a plain cwd key could not (it collapsed them into one slot). An attached
// session ALWAYS has a cc_session_id, so there is no cwd fallback for a "missing
// cc_session_id" (that case does not occur). cwd survives in ONE place only —
// applyOrder's read path — purely to migrate a LEGACY cwd-keyed saved order
// (written by older builds) so it isn't wiped; it self-retires the moment the
// user next reorders (which persists cc_session_id keys).

type OrderableSession = { cc_session_id: string | null; cwd: string };

// The key a session is persisted under: its cc_session_id, no fallback. null
// only if a session were persisted pre-attach (does not happen); callers skip a
// null key rather than ordering by cwd.
export function sessionOrderKey(s: OrderableSession): string | null {
  return s.cc_session_id;
}

// Apply a saved order (a list of keys). A session resolves its rank by
// cc_session_id; a legacy cwd-keyed saved order still resolves via the cwd read
// path (one-time migration) until the next reorder rewrites it to cc_session_id
// keys. Listed sessions come first in listed order; the rest follow in natural
// (incoming) order, stable for ties and for unlisted sessions.
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
