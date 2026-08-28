// Read an image's intrinsic pixel dimensions from its file HEADER only — no
// full decode. Used to hand the frontend a width/height for each chat image so
// the browser can reserve the correct aspect-ratio box BEFORE the (lazy) image
// loads. Without that, a lazy image's height jumps from ~0 to its real height
// on load, and because the chat scroller runs with overflow-anchor:none the
// browser does not compensate — everything below shifts and the scroll position
// leaps. Reserving the box up front removes the height change entirely.
//
// Supports PNG, JPEG, GIF and WebP (VP8 / VP8L / VP8X) — the formats the upload
// endpoint accepts (see ALLOWED_IMAGE_EXTS). Returns null on any parse failure
// or unknown format; callers simply omit that image and it keeps its current
// (unreserved) behavior.

import * as fs from "node:fs";

export interface ImageDims {
  w: number;
  h: number;
}

// How many bytes to pull off disk to find the header. PNG/GIF/WebP need only
// the first few dozen bytes; JPEG's SOF marker sits after the APPn segments
// (EXIF, an embedded thumbnail), which are small in practice. This bound keeps
// a pathological file from being read whole while still covering real photos.
const MAX_HEADER_SCAN = 768 * 1024;

// Uploads are immutable once written, so the absolute path is a safe cache key.
// A null result is cached too (a file that never parses shouldn't be re-read on
// every board load). Unbounded, but keyed by on-disk files whose count grows
// slowly; the entries are tiny.
const cache = new Map<string, ImageDims | null>();

export function imageDimensions(absPath: string): ImageDims | null {
  const cached = cache.get(absPath);
  if (cached !== undefined) return cached;
  const dims = readDims(absPath);
  cache.set(absPath, dims);
  return dims;
}

// Exposed for tests — lets a test re-read a fixture it rewrote at the same path.
export function clearImageDimsCache(): void {
  cache.clear();
}

function readDims(absPath: string): ImageDims | null {
  let fd: number | null = null;
  try {
    const stat = fs.statSync(absPath);
    if (!stat.isFile() || stat.size < 12) return null;
    const len = Math.min(stat.size, MAX_HEADER_SCAN);
    const buf = Buffer.allocUnsafe(len);
    fd = fs.openSync(absPath, "r");
    const read = fs.readSync(fd, buf, 0, len, 0);
    return parseDims(read === len ? buf : buf.subarray(0, read));
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

// Exported so a caller that already holds the bytes (e.g. a test) can parse
// without a filesystem round-trip.
export function parseDims(b: Buffer): ImageDims | null {
  if (isPng(b)) return pngDims(b);
  if (isGif(b)) return gifDims(b);
  if (isJpeg(b)) return jpegDims(b);
  if (isWebp(b)) return webpDims(b);
  return null;
}

function valid(w: number, h: number): ImageDims | null {
  if (!Number.isFinite(w) || !Number.isFinite(h)) return null;
  if (w <= 0 || h <= 0) return null;
  // A sane upper bound rejects garbage read out of a corrupt header.
  if (w > 100000 || h > 100000) return null;
  return { w, h };
}

// --- PNG: 8-byte signature, then the IHDR chunk (length + "IHDR" + w + h). ---
function isPng(b: Buffer): boolean {
  return (
    b.length >= 24 &&
    b[0] === 0x89 &&
    b[1] === 0x50 &&
    b[2] === 0x4e &&
    b[3] === 0x47 &&
    b[4] === 0x0d &&
    b[5] === 0x0a &&
    b[6] === 0x1a &&
    b[7] === 0x0a
  );
}
function pngDims(b: Buffer): ImageDims | null {
  // IHDR must be the first chunk: length(4) "IHDR"(4) width(4) height(4).
  if (b[12] !== 0x49 || b[13] !== 0x48 || b[14] !== 0x44 || b[15] !== 0x52)
    return null;
  return valid(b.readUInt32BE(16), b.readUInt32BE(20));
}

// --- GIF: "GIF" + version, then the Logical Screen Descriptor (w,h LE16). ---
function isGif(b: Buffer): boolean {
  return b.length >= 10 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46;
}
function gifDims(b: Buffer): ImageDims | null {
  return valid(b.readUInt16LE(6), b.readUInt16LE(8));
}

// --- JPEG: FF D8, then a chain of marker segments; a SOF marker holds w/h. ---
function isJpeg(b: Buffer): boolean {
  return b.length >= 4 && b[0] === 0xff && b[1] === 0xd8;
}
function jpegDims(b: Buffer): ImageDims | null {
  const n = b.length;
  let off = 2; // past SOI
  while (off < n) {
    // A marker is a run of one or more 0xFF bytes ending in a code byte.
    if (b[off] !== 0xff) {
      off++;
      continue;
    }
    while (off < n && b[off] === 0xff) off++;
    if (off >= n) break;
    const marker = b[off];
    off++;
    // Standalone markers carry no length payload: TEM (01), RSTn (D0-D7),
    // SOI (D8), EOI (D9).
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) continue;
    if (off + 2 > n) break;
    const segLen = b.readUInt16BE(off); // includes the 2 length bytes
    if (segLen < 2) return null;
    // SOF markers (C0-CF) carry the frame size — EXCEPT C4 (DHT), C8 (JPG),
    // CC (DAC), which reuse that range for other tables.
    const isSOF =
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc;
    if (isSOF) {
      // segment body: precision(1) height(2) width(2)
      if (off + 7 > n) return null;
      return valid(b.readUInt16BE(off + 5), b.readUInt16BE(off + 3));
    }
    off += segLen;
  }
  return null;
}

// --- WebP: RIFF container, then a VP8 / VP8L / VP8X chunk. ---
function isWebp(b: Buffer): boolean {
  return (
    b.length >= 30 &&
    b[0] === 0x52 &&
    b[1] === 0x49 &&
    b[2] === 0x46 &&
    b[3] === 0x46 && // "RIFF"
    b[8] === 0x57 &&
    b[9] === 0x45 &&
    b[10] === 0x42 &&
    b[11] === 0x50 // "WEBP"
  );
}
function webpDims(b: Buffer): ImageDims | null {
  const fourcc = b.toString("ascii", 12, 16);
  if (fourcc === "VP8 ") {
    // Lossy. VP8 bitstream starts at 20: frame tag(3), start code
    // 9d 01 2a at 23, then width/height as 14-bit little-endian.
    if (b.length < 30) return null;
    if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null;
    return valid(b.readUInt16LE(26) & 0x3fff, b.readUInt16LE(28) & 0x3fff);
  }
  if (fourcc === "VP8L") {
    // Lossless. Signature byte 2f at 20, then a 32-bit LE pack of
    // (width-1):14 (height-1):14.
    if (b.length < 25) return null;
    if (b[20] !== 0x2f) return null;
    const bits = b.readUInt32LE(21);
    return valid((bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1);
  }
  if (fourcc === "VP8X") {
    // Extended. Canvas width-1 (24-bit LE) at 24, height-1 at 27.
    if (b.length < 30) return null;
    const w = (b[24] | (b[25] << 8) | (b[26] << 16)) + 1;
    const h = (b[27] | (b[28] << 8) | (b[29] << 16)) + 1;
    return valid(w, h);
  }
  return null;
}
