// Child process that validates mermaid source with a REAL mermaid.parse, kept
// entirely OUT of the broker's own process. mermaid.parse needs a DOM (DOMPurify),
// which happy-dom's GlobalRegistrator supplies — but registering clobbers 20+
// globals (fetch / URL / setTimeout / AbortController / ...). Doing that in the
// broker once broke it (470MB + slow /api; reverted in 86d2970). So it lives
// here instead: the broker (broker/mermaid-validate.ts) spawns this child,
// streams newline-delimited JSON requests {id, source} on stdin, and reads
// {id, ok, error} back on stdout. All the pollution dies with this child.
//
// The child idle-exits after IDLE_MS so its ~50MB footprint isn't held while
// nothing is being validated; the broker respawns it on the next request.

// Snapshot the native timers BEFORE happy-dom overwrites them, so the idle timer
// is reliable regardless of happy-dom's timer semantics.
const nativeSetTimeout = globalThis.setTimeout.bind(globalThis);
const nativeClearTimeout = globalThis.clearTimeout.bind(globalThis);

const IDLE_MS = 60_000;

const { GlobalRegistrator } = await import("@happy-dom/global-registrator");
GlobalRegistrator.register();
const mermaid = (await import("mermaid")).default;
mermaid.initialize({ startOnLoad: false, securityLevel: "strict" });

let idleTimer: ReturnType<typeof nativeSetTimeout> | null = null;
function armIdle() {
  if (idleTimer) nativeClearTimeout(idleTimer);
  idleTimer = nativeSetTimeout(() => process.exit(0), IDLE_MS);
}

function reply(obj: unknown) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

async function handle(line: string) {
  let req: { id?: unknown; source?: unknown };
  try {
    req = JSON.parse(line);
  } catch {
    return;
  }
  const id = req?.id;
  const source = typeof req?.source === "string" ? req.source : "";
  try {
    await mermaid.parse(source);
    reply({ id, ok: true });
  } catch (e) {
    reply({ id, ok: false, error: e instanceof Error ? e.message : String(e) });
  }
}

// Signal warm-up is done, then start the idle clock.
reply({ ready: true });
armIdle();

let buf = "";
// Bun's ReadableStream is async-iterable at runtime; the DOM lib types don't
// declare it, hence the cast.
for await (const chunk of Bun.stdin.stream() as unknown as AsyncIterable<Uint8Array>) {
  buf += Buffer.from(chunk).toString("utf8");
  let nl: number;
  while ((nl = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (line.trim()) {
      armIdle();
      await handle(line);
    }
  }
}
process.exit(0);
