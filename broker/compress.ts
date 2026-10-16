// gzip for the broker's larger responses.
//
// The browser reaches the broker through Tailscale serve, which forwards the
// bytes as-is, so whatever the broker sends uncompressed crosses the phone's
// mobile link uncompressed. The default board's full view was 4.3MB of JSON
// (2026-10-16) — JSON of chat text compresses ~5-8x.
//
// gzip, not brotli: Bun's gzipSync is fast enough to run per request on a
// multi-MB body, while brotli at its default quality is an order of magnitude
// slower to encode for a modest extra saving. Every browser decodes gzip
// natively (off the JS thread), so the client side costs nothing we write.
//
// Skipped: bodies under MIN_COMPRESS_BYTES (header + CPU overhead beats the
// saving), clients that don't advertise gzip, and anything that isn't text
// (uploaded images are already compressed; SSE / WebSocket never come here).

export const MIN_COMPRESS_BYTES = 1024;

export function acceptsGzip(req: Request): boolean {
  const ae = req.headers.get("accept-encoding");
  if (!ae) return false;
  // Honour an explicit "gzip;q=0" refusal; anything else naming gzip (or *)
  // is an acceptance.
  for (const part of ae.split(",")) {
    const [rawName, ...params] = part.trim().split(";");
    const name = rawName.trim().toLowerCase();
    if (name !== "gzip" && name !== "*") continue;
    const q = params
      .map((p) => p.trim())
      .find((p) => p.toLowerCase().startsWith("q="));
    if (q && Number(q.slice(2)) === 0) continue;
    return true;
  }
  return false;
}

const encoder = new TextEncoder();

// Build a response from an already-serialized text body, gzipped when worth it.
export function compressedText(
  req: Request,
  text: string,
  init: ResponseInit & { contentType: string },
): Response {
  const { contentType, ...rest } = init;
  const headers = new Headers(rest.headers);
  headers.set("content-type", contentType);
  // The body differs by Accept-Encoding whenever compression is in play, so
  // caches must key on it even for the uncompressed variant.
  headers.append("vary", "Accept-Encoding");
  const bytes = encoder.encode(text);
  if (bytes.byteLength >= MIN_COMPRESS_BYTES && acceptsGzip(req)) {
    headers.set("content-encoding", "gzip");
    return new Response(Bun.gzipSync(bytes, { level: 6 }), {
      ...rest,
      headers,
    });
  }
  return new Response(bytes, { ...rest, headers });
}

// Drop-in for Response.json(data, init) that gzips large bodies.
export function jsonResponse(
  req: Request,
  data: unknown,
  init: ResponseInit = {},
): Response {
  return compressedText(req, JSON.stringify(data), {
    ...init,
    contentType: "application/json;charset=utf-8",
  });
}

// Prebuilt frontend assets are content-hashed and immutable, so each one is
// gzipped at most once per broker process and served from memory afterwards.
const assetCache = new Map<string, Uint8Array<ArrayBuffer> | null>();

const COMPRESSIBLE_ASSET = /\.(js|mjs|css|html|json|svg|map|txt)$/i;

export async function compressedAsset(
  req: Request,
  absPath: string,
  headers: Record<string, string>,
): Promise<Response> {
  const file = Bun.file(absPath);
  if (!COMPRESSIBLE_ASSET.test(absPath) || !acceptsGzip(req)) {
    return new Response(file, {
      headers: { ...headers, vary: "Accept-Encoding" },
    });
  }
  let gz = assetCache.get(absPath);
  if (gz === undefined) {
    const raw = new Uint8Array(await file.arrayBuffer());
    gz =
      raw.byteLength >= MIN_COMPRESS_BYTES
        ? Bun.gzipSync(raw, { level: 9 })
        : null;
    assetCache.set(absPath, gz);
  }
  if (!gz) {
    return new Response(file, {
      headers: { ...headers, vary: "Accept-Encoding" },
    });
  }
  return new Response(gz, {
    headers: {
      ...headers,
      "content-type": file.type,
      "content-encoding": "gzip",
      vary: "Accept-Encoding",
    },
  });
}
