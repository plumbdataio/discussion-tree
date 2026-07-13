// Broker-side client for the isolated mermaid validator (mermaid-validate-worker.ts).
// It spawns the worker as a SEPARATE process (never a static import), so the
// worker's happy-dom global pollution can never reach the broker. Requests are
// newline-delimited JSON {id, source} on the child's stdin; replies {id, ok,
// error} come back on its stdout. The child idle-exits on its own; this client
// respawns it lazily on the next request.
//
// Fail-open everywhere: if the worker can't spawn, dies, or is slow, validation
// returns null (= "no objection") so a broken toolchain never blocks a diagram
// upsert. The lightweight header check in diagrams.ts still applies, and the
// client-side render surfaces any residual parse error in its own panel.
import type { Subprocess } from "bun";

const WORKER_PATH = `${import.meta.dir}/mermaid-validate-worker.ts`;
const REQUEST_TIMEOUT_MS = 8_000;

type Pending = {
  resolve: (v: string | null) => void;
  timer: ReturnType<typeof setTimeout>;
};

let proc: Subprocess<"pipe", "pipe", "ignore"> | null = null;
let seq = 0;
const pending = new Map<number, Pending>();

// Resolve every in-flight request as fail-open (null) and forget the process.
function abandon() {
  for (const [, p] of pending) {
    clearTimeout(p.timer);
    p.resolve(null);
  }
  pending.clear();
  proc = null;
}

function ensureProc(): boolean {
  if (proc && proc.exitCode === null) return true;
  try {
    proc = Bun.spawn({
      cmd: [process.execPath, WORKER_PATH],
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
    });
  } catch {
    proc = null;
    return false;
  }
  const self = proc;
  // Read stdout line-by-line, matching replies to pending requests by id.
  (async () => {
    let b = "";
    try {
      // Bun's ReadableStream is async-iterable at runtime; the DOM lib types
      // don't declare it, hence the cast.
      for await (const chunk of self.stdout as unknown as AsyncIterable<Uint8Array>) {
        b += Buffer.from(chunk).toString("utf8");
        let nl: number;
        while ((nl = b.indexOf("\n")) !== -1) {
          const line = b.slice(0, nl);
          b = b.slice(nl + 1);
          if (line.trim()) onLine(line);
        }
      }
    } catch {
      /* stream closed on exit */
    }
  })();
  // On exit (idle-exit or crash), fail-open anything still waiting — but only if
  // this is still the current process (a newer one may have replaced it).
  self.exited.then(() => {
    if (proc === self) abandon();
  });
  return true;
}

function onLine(line: string) {
  let msg: { id?: unknown; ok?: unknown; error?: unknown; ready?: unknown };
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg?.ready) return; // warm-up signal
  if (typeof msg?.id !== "number") return;
  const p = pending.get(msg.id);
  if (!p) return;
  pending.delete(msg.id);
  clearTimeout(p.timer);
  p.resolve(msg.ok ? null : formatError(msg.error));
}

function formatError(error: unknown): string {
  const msg = typeof error === "string" ? error : String(error);
  return `mermaid syntax error: ${msg
    .split("\n")
    .slice(0, 3)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240)}`;
}

// Returns a human-readable error when the source is genuinely unparseable, else
// null (valid, OR the validator couldn't run — fail open).
export async function validateMermaidSyntax(src: string): Promise<string | null> {
  if (!ensureProc() || !proc) return null;
  const sink = proc.stdin;
  const id = ++seq;
  return new Promise<string | null>((resolve) => {
    const timer = setTimeout(() => {
      if (pending.delete(id)) resolve(null); // fail open on a slow/stuck worker
    }, REQUEST_TIMEOUT_MS);
    pending.set(id, { resolve, timer });
    try {
      sink.write(`${JSON.stringify({ id, source: src })}\n`);
      sink.flush();
    } catch {
      pending.delete(id);
      clearTimeout(timer);
      resolve(null); // fail open if the pipe is gone
    }
  });
}
