// Thin HTTP client for the broker, plus the auto-spawn dance: the broker is
// a singleton per machine, so the FIRST MCP server to start is the one that
// actually launches it. All later starters just connect.

import {
  BROKER_FETCH_TIMEOUT_MS,
  BROKER_IS_REMOTE,
  BROKER_SCRIPT,
  BROKER_URL,
  LAUNCH_LOCK_DIR,
  LAUNCH_LOCK_STALE_MS,
} from "./config.ts";
import {
  isLockStale,
  releaseLock,
  tryAcquireLock,
} from "./launch-lock.ts";
import { log } from "./log.ts";
import { dirname } from "node:path";

export async function brokerFetch<T>(
  path: string,
  body: unknown,
): Promise<T> {
  // Bounded so a wedged broker (mid-restart / thrashing) can't hang a poll or
  // tool call forever — a timeout throws, and every caller already handles a
  // broker throw (retry next tick / surface as an MCP error).
  const res = await fetch(`${BROKER_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(BROKER_FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Broker error (${path}): ${res.status} ${err}`);
  }
  return res.json() as Promise<T>;
}

// Fetch an uploaded image AS BYTES, for the tool that hands it straight to the
// model. Deliberately not brokerFetch: that one posts JSON and parses JSON, and
// what comes back here is a PNG.
//
// Base64 is what MCP's image content carries, so the encode happens here rather
// than a temp file happening anywhere.
export async function fetchImage(
  urlOrPath: string,
): Promise<
  { ok: true; data: string; mimeType: string } | { ok: false; error: string }
> {
  const raw = String(urlOrPath ?? "").trim();
  if (!raw) return { ok: false, error: "url required" };
  // Accept either the /uploads/... path from a message or a full URL to the
  // same broker; anything else is refused rather than fetched, so this cannot
  // be turned into a general-purpose fetcher.
  let url: string;
  if (raw.startsWith("/uploads/")) {
    url = `${BROKER_URL}${raw}`;
  } else if (raw.startsWith(BROKER_URL) && raw.includes("/uploads/")) {
    url = raw;
  } else {
    return {
      ok: false,
      error:
        "get_image only reads this broker's uploads — pass the /uploads/... path exactly as it appears in the message",
    };
  }

  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(BROKER_FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      return { ok: false, error: `image not available (${res.status})` };
    }
    const buf = Buffer.from(await res.arrayBuffer());
    const mimeType =
      res.headers.get("content-type") ?? guessImageMime(url);
    return { ok: true, data: buf.toString("base64"), mimeType };
  } catch (e) {
    return {
      ok: false,
      error: `could not reach the broker for this image: ${
        e instanceof Error ? e.message : String(e)
      }`,
    };
  }
}

function guessImageMime(url: string): string {
  const ext = url.split(".").pop()?.toLowerCase() ?? "";
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "gif") return "image/gif";
  if (ext === "webp") return "image/webp";
  return "image/png";
}

export async function isBrokerAlive(): Promise<boolean> {
  try {
    const res = await fetch(`${BROKER_URL}/health`, {
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// Poll /health up to `attempts` times at `intervalMs` spacing. Returns true as
// soon as the broker answers, false if it never does within the window.
async function waitForBroker(
  attempts: number,
  intervalMs: number,
): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    await new Promise((r) => setTimeout(r, intervalMs));
    if (await isBrokerAlive()) return true;
  }
  return false;
}

// The actual spawn + health-wait, factored out so both the lock-holder path and
// the stale-steal path in ensureBroker() reuse it. Throws the same "after 6
// seconds" error the original inline code did if /health never comes up.
async function spawnBrokerAndWait(): Promise<void> {
  log("Starting broker daemon...");
  // Launch from the broker script's own directory (the repo root), NOT this MCP
  // server's cwd. This process inherits the cwd of whatever project its CC
  // session runs in, and Bun.serve resolves web/index.html's asset URLs against
  // the process cwd — so spawning without an explicit cwd bakes broken chunk
  // paths (/../../../<that-project>/chunk-*.js) into the served index.html and
  // the page renders blank (observed 2026-08-06, and again 2026-08-12 when
  // several sessions' MCP servers each respawned a broker from their own project
  // dir). ensure-broker-running.sh already cds before launching; this is the
  // same fix for the MCP-server auto-spawn path. --smol matches restart-broker.sh
  // and the shell hook (keeps the long-lived broker's JSC heap small).
  const proc = Bun.spawn(["bun", "--smol", BROKER_SCRIPT], {
    cwd: dirname(BROKER_SCRIPT),
    stdio: ["ignore", "ignore", "inherit"],
  });
  proc.unref();

  // 30 × 200ms = 6s ceiling. SQLite open + Bun.serve startup is <100ms on a
  // healthy machine, so this is generous; if we don't see /health by then
  // something is genuinely wrong.
  if (await waitForBroker(30, 200)) {
    log("Broker started");
    return;
  }
  throw new Error("Failed to start broker daemon after 6 seconds");
}

export async function ensureBroker(): Promise<void> {
  if (await isBrokerAlive()) {
    log("Broker already running");
    return;
  }

  // A remote broker is not ours to start. Spawning a local one here would be
  // worse than failing: this session would attach to a second, empty broker
  // and every board it creates would be invisible to the user, who is looking
  // at the other machine.
  if (BROKER_IS_REMOTE) {
    throw new Error(
      `Broker at ${BROKER_URL} is not reachable, and it is not on this machine so it cannot be started from here. ` +
        "Check that it is running, that DISCUSSION_TREE_BIND lets it accept non-loopback connections, and that the network between the two machines is up.",
    );
  }

  // Serialize spawns across processes with an atomic single-launcher lock, so a
  // broker-down window can't trigger a thundering herd of respawns. The lock is
  // a directory (mkdir is atomic): exactly one launcher wins and spawns; the
  // rest wait for that spawn instead of piling on. Shares the SAME lock path as
  // the shell SessionStart hook (scripts/ensure-broker-running.sh) so the two
  // spawn paths coordinate through one lock. See server/launch-lock.ts.
  //
  // A filesystem hiccup taking the lock must NEVER break ensureBroker's
  // contract, so tryAcquireLock reports "error" instead of throwing and we fall
  // back to an unlocked spawn — the broker.ts bind-loser backstop (Layer 2)
  // still guarantees no lingering swarm even without the lock.
  const first = tryAcquireLock(LAUNCH_LOCK_DIR);

  if (first.status === "error" || first.status === "acquired") {
    // "acquired": we hold the lock, so we are the sole launcher — spawn, and
    // release in a finally so the lock is freed on every path (success, throw,
    // timeout). "error": lock unavailable; spawn unlocked (nothing to release).
    if (first.status === "error") return spawnBrokerAndWait();
    try {
      await spawnBrokerAndWait();
    } finally {
      releaseLock(LAUNCH_LOCK_DIR);
    }
    return;
  }

  // first.status === "held": another launcher (this path, or the shell hook) is
  // mid-spawn. Do NOT spawn a second broker — wait ~6s for theirs to come up.
  if (await waitForBroker(30, 200)) return;

  // Still down after the wait. Either the holder is unusually slow, or it
  // crashed and left a lock dir behind that would deadlock EVERY future launch.
  // If the lock is old enough to be presumed abandoned, steal it ONCE and spawn
  // ourselves. mtime is re-read here (isLockStale stats the dir), so a lock that
  // was released and freshly re-acquired by a new holder reads as young and is
  // left alone. Do NOT loop: one steal-and-retry, then fail.
  if (isLockStale(LAUNCH_LOCK_DIR, LAUNCH_LOCK_STALE_MS)) {
    releaseLock(LAUNCH_LOCK_DIR); // steal the stale lock
    const retry = tryAcquireLock(LAUNCH_LOCK_DIR);
    if (retry.status === "acquired") {
      try {
        await spawnBrokerAndWait();
      } finally {
        releaseLock(LAUNCH_LOCK_DIR);
      }
      return;
    }
    // "held": another launcher grabbed it between our steal and retry — let
    // their spawn finish rather than fighting. The port bind is atomic and the
    // Layer 2 backstop makes any bind-loser exit cleanly, so even a double
    // spawn here cannot produce a swarm.
    if (retry.status === "held" && (await waitForBroker(30, 200))) return;
  }

  throw new Error("Failed to start broker daemon after 6 seconds");
}
