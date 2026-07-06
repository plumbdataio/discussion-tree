// Real mermaid syntax validation at diagram upsert time, so a syntactically
// broken source is rejected up front instead of only erroring client-side at
// render (the "Syntax error in text" bomb).
//
// mermaid.parse needs a DOM (it runs DOMPurify), which Bun lacks — bare
// mermaid.parse throws a bogus "DOMPurify.addHook is not a function" on valid
// *styled* diagrams. happy-dom (already a dev-dep, Bun-native) supplies a DOM
// via GlobalRegistrator. BUT registering also clobbers global fetch / WebSocket
// with happy-dom's implementations, whose fetch is broken for real HTTP — which
// would break the broker's OWN networking. So we register for the DOM and then
// RESTORE Bun's native networking globals; mermaid.parse needs none of them, so
// it still validates correctly while the broker keeps working.
//
// The setup (~1.5s: happy-dom register + mermaid import) is heavy but ONE-TIME
// per process, warmed at module load so it never spikes a live upsert request.
// A single shared broker pays it once — deliberately NOT done per-CC.

let warm: Promise<((src: string) => Promise<unknown>) | null> | null = null;

function warmParser(): Promise<((src: string) => Promise<unknown>) | null> {
  if (warm) return warm;
  warm = (async () => {
    try {
      // Snapshot the networking globals happy-dom is about to overwrite.
      const native = {
        fetch: globalThis.fetch,
        WebSocket: globalThis.WebSocket,
        Request: globalThis.Request,
        Response: globalThis.Response,
        Headers: globalThis.Headers,
      };
      const { GlobalRegistrator } = await import(
        "@happy-dom/global-registrator"
      );
      GlobalRegistrator.register();
      // Give the broker its native fetch/WebSocket/etc. back (mermaid.parse
      // needs none of them; happy-dom's fetch is broken for real HTTP).
      Object.assign(globalThis, native);
      const mermaid = (await import("mermaid")).default;
      return (src: string) => mermaid.parse(src);
    } catch {
      // mermaid / happy-dom unavailable in this runtime — skip deep validation
      // rather than block every diagram upsert on an infra problem.
      return null;
    }
  })();
  return warm;
}

// Kick the warm off at module load so the first upsert doesn't pay the ~1.5s.
void warmParser();

// Returns a human-readable error string when the source is genuinely
// unparseable, else null. Also null when the parser couldn't be warmed (infra),
// so a broken toolchain never blocks uploads — the lightweight header check in
// validateSource still applies, and the render still surfaces any residual error.
export async function validateMermaidSyntax(
  src: string,
): Promise<string | null> {
  const parse = await warmParser();
  if (!parse) return null;
  try {
    await parse(src);
    return null;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return `mermaid syntax error: ${msg
      .split("\n")
      .slice(0, 3)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 240)}`;
  }
}
