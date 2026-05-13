// Thin HTTP client for the broker, plus the auto-spawn dance: the broker is
// a singleton per machine, so the FIRST MCP server to start is the one that
// actually launches it. All later starters just connect.

import { BROKER_SCRIPT, BROKER_URL } from "./config.ts";
import { log } from "./log.ts";

export async function brokerFetch<T>(
  path: string,
  body: unknown,
): Promise<T> {
  const res = await fetch(`${BROKER_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Broker error (${path}): ${res.status} ${err}`);
  }
  return res.json() as Promise<T>;
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

export async function ensureBroker(): Promise<void> {
  if (await isBrokerAlive()) {
    log("Broker already running");
    return;
  }

  log("Starting broker daemon...");
  const proc = Bun.spawn(["bun", BROKER_SCRIPT], {
    stdio: ["ignore", "ignore", "inherit"],
  });
  proc.unref();

  // 30 × 200ms = 6s ceiling. SQLite open + Bun.serve startup is <100ms on a
  // healthy machine, so this is generous; if we don't see /health by then
  // something is genuinely wrong.
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 200));
    if (await isBrokerAlive()) {
      log("Broker started");
      return;
    }
  }
  throw new Error("Failed to start broker daemon after 6 seconds");
}
