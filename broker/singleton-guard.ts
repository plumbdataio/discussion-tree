// Single-broker guard — imported FIRST by broker.ts, before any module that
// opens the SQLite file, so a duplicate broker bails BEFORE touching the DB.
//
// WHY: the broker is a singleton per machine, but during an outage several MCP
// servers can each try to (re)spawn one at the same moment (ensureBroker() only
// checks isBrokerAlive(), and a thundering herd all see it dead at once). On
// 2026-08-12 that left FIVE brokers alive — each launched from a different,
// WRONG cwd — all serving a broken index.html (blank page) and hammering the
// same SQLite file into "database is locked" crashes.
//
// This is the proactive half of the fix: if a healthy broker already answers
// /health, exit now instead of starting a second one. The cold-start race —
// several launchers all seeing /health down and all getting past this guard — is
// NOT fully handled here. The port bind decides WHO listens: Bun.serve throws for
// whichever loses the race (verified 2026-08-12: Bun rejects a second bind on the
// same port by default, no reusePort), so at most one broker ever listens. But a
// bind loser has already opened the DB and started timers, so it must also be
// made to EXIT — that is the try/catch around Bun.serve in broker.ts (Layer 2).
// Together: this guard turns away the "already healthy" case cheaply; the bind
// picks the single listener; the catch makes every loser exit cleanly instead of
// lingering as a stuck process. The MCP-side launch lock (server/launch-lock.ts)
// makes the herd rare in the first place.
import { PORT } from "./config.ts";

const alreadyUp = await fetch(`http://127.0.0.1:${PORT}/health`, {
  signal: AbortSignal.timeout(1500),
})
  .then((r) => r.ok)
  .catch(() => false);

if (alreadyUp) {
  console.error(
    `[broker] a healthy broker already owns :${PORT}; not starting a second one`,
  );
  process.exit(0);
}
