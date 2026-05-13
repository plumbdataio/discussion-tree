// Spawn an isolated broker subprocess for a single test file.
//
// Each call returns a fresh broker bound to:
//   - a tmp directory for PARALLEL_DISCUSSION_HOME (uploads / cc-sessions)
//   - a tmp file for PARALLEL_DISCUSSION_DB
//   - an OS-assigned port (PARALLEL_DISCUSSION_PORT=0)
//
// We capture stderr until the "listening on http://127.0.0.1:<port>" log line
// to learn the actual port. The kill() returned MUST be called by the caller
// in afterAll/afterEach — otherwise tmp dirs and broker processes leak.

import { rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BROKER_SCRIPT = new URL("../../broker.ts", import.meta.url).pathname;

export type BrokerHandle = {
  url: string;            // e.g. "http://127.0.0.1:54321"
  port: number;
  homeDir: string;        // PARALLEL_DISCUSSION_HOME for this broker
  dbPath: string;
  kill: () => Promise<void>;
};

export async function startBroker(
  extraEnv: Record<string, string> = {},
): Promise<BrokerHandle> {
  const homeDir = mkdtempSync(join(tmpdir(), "pd-broker-home-"));
  const dbPath = join(homeDir, "db.sqlite");

  const proc = Bun.spawn(["bun", BROKER_SCRIPT], {
    env: {
      ...process.env,
      PARALLEL_DISCUSSION_PORT: "0",
      PARALLEL_DISCUSSION_HOME: homeDir,
      PARALLEL_DISCUSSION_DB: dbPath,
      // Drop legacy detection — point DB explicitly at our tmp path.
      ...extraEnv,
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  // Drain stderr line-by-line until we see the listening URL or the process exits.
  const port = await readPortFromStderr(proc.stderr);
  if (!port) {
    proc.kill();
    throw new Error("broker failed to start (no listening line on stderr)");
  }
  const url = `http://127.0.0.1:${port}`;

  // Sanity health probe with retry (up to 2s).
  await waitForHealth(url, 2000);

  return {
    url,
    port,
    homeDir,
    dbPath,
    kill: async () => {
      proc.kill();
      try {
        await proc.exited;
      } catch {
        /* ignore */
      }
      rmSync(homeDir, { recursive: true, force: true });
    },
  };
}

async function readPortFromStderr(
  stream: ReadableStream<Uint8Array>,
): Promise<number | null> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) return null;
    buf += decoder.decode(value, { stream: true });
    const m = buf.match(/listening on http:\/\/127\.0\.0\.1:(\d+)/);
    if (m) {
      // Return reader to the stream so future log lines aren't lost
      // (bun spawn doesn't require us to close the reader explicitly).
      reader.releaseLock();
      return parseInt(m[1], 10);
    }
  }
  reader.releaseLock();
  return null;
}

async function waitForHealth(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown = null;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${url}/health`);
      if (r.ok) return;
    } catch (e) {
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`broker /health did not respond within ${timeoutMs}ms: ${lastErr}`);
}

// Convenience HTTP helpers — every test repeats POST/JSON, so factor it out.
export async function post<T = any>(
  url: string,
  body: unknown,
): Promise<{ status: number; json: T }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  let json: any = null;
  try {
    json = await res.json();
  } catch {
    /* not JSON */
  }
  return { status: res.status, json };
}

export async function get<T = any>(
  url: string,
): Promise<{ status: number; json: T }> {
  const res = await fetch(url);
  let json: any = null;
  try {
    json = await res.json();
  } catch {
    /* not JSON */
  }
  return { status: res.status, json };
}

// Register a session quickly (most tests need at least one session).
export async function registerSession(
  url: string,
  cwd = "/tmp/pd-test",
): Promise<string> {
  const r = await post<{ session_id: string }>(`${url}/register`, {
    pid: 99000 + Math.floor(Math.random() * 1000),
    cwd,
  });
  if (r.status !== 200 || !r.json.session_id) {
    throw new Error(`register failed: ${r.status} ${JSON.stringify(r.json)}`);
  }
  return r.json.session_id;
}

// Attach cc_session_id (creates the default board as a side effect).
export async function attachCC(
  url: string,
  sessionId: string,
  ccSessionId = `cc-${Math.random().toString(36).slice(2, 10)}`,
): Promise<string> {
  await post(`${url}/attach-cc-session`, {
    session_id: sessionId,
    cc_session_id: ccSessionId,
  });
  return ccSessionId;
}
