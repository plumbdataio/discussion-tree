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
// /health, exit now instead of starting a second one. The cold-start race where
// none is up yet is handled by the bind itself — Bun.serve throws EADDRINUSE for
// whichever loses the race (verified 2026-08-12: Bun rejects a second bind on
// the same port by default), so at most one broker ever listens.
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
