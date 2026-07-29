// Thin HTTP client for the broker, plus the auto-spawn dance: the broker is
// a singleton per machine, so the FIRST MCP server to start is the one that
// actually launches it. All later starters just connect.

import {
  BROKER_FETCH_TIMEOUT_MS,
  BROKER_IS_REMOTE,
  BROKER_SCRIPT,
  BROKER_URL,
} from "./config.ts";
import { log } from "./log.ts";

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
