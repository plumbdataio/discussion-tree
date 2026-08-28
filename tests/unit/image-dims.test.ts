import { describe, test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  imageDimensions,
  parseDims,
  clearImageDimsCache,
} from "../../broker/image-dims.ts";

// Minimal but structurally-valid header bytes for each format. The parser only
// reads the header, so these are enough to exercise it without pulling in an
// image library — the dimensions are encoded where a real file would carry them.

function png(w: number, h: number): Buffer {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8); // IHDR chunk length
  b.write("IHDR", 12, "ascii");
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  b[24] = 8; // bit depth
  b[25] = 2; // color type (truecolor)
  return b;
}

function gif(w: number, h: number): Buffer {
  const b = Buffer.alloc(13);
  b.write("GIF89a", 0, "ascii");
  b.writeUInt16LE(w, 6);
  b.writeUInt16LE(h, 8);
  return b;
}

// A leading APP0 segment before SOF0 exercises the marker-walking loop.
function jpeg(w: number, h: number): Buffer {
  const parts: number[] = [0xff, 0xd8]; // SOI
  parts.push(0xff, 0xe0, 0x00, 0x10); // APP0, length 16
  for (let i = 0; i < 14; i++) parts.push(0x00);
  parts.push(0xff, 0xc0, 0x00, 0x0b, 0x08); // SOF0, length 11, precision 8
  parts.push((h >> 8) & 0xff, h & 0xff);
  parts.push((w >> 8) & 0xff, w & 0xff);
  parts.push(0x01, 0x00, 0x11, 0x00); // 1 component
  return Buffer.from(parts);
}

function webpBase(fourcc: string): Buffer {
  const b = Buffer.alloc(30);
  b.write("RIFF", 0, "ascii");
  b.writeUInt32LE(22, 4);
  b.write("WEBP", 8, "ascii");
  b.write(fourcc, 12, "ascii");
  b.writeUInt32LE(10, 16);
  return b;
}

function webpVP8(w: number, h: number): Buffer {
  const b = webpBase("VP8 ");
  b[20] = 0x30; // frame tag (arbitrary)
  b[23] = 0x9d;
  b[24] = 0x01;
  b[25] = 0x2a; // start code
  b.writeUInt16LE(w & 0x3fff, 26);
  b.writeUInt16LE(h & 0x3fff, 28);
  return b;
}

function webpVP8L(w: number, h: number): Buffer {
  const b = webpBase("VP8L");
  b[20] = 0x2f; // signature
  const bits = ((w - 1) & 0x3fff) | (((h - 1) & 0x3fff) << 14);
  b.writeUInt32LE(bits >>> 0, 21);
  return b;
}

function webpVP8X(w: number, h: number): Buffer {
  const b = webpBase("VP8X");
  b[20] = 0x10; // flags
  const w1 = w - 1;
  const h1 = h - 1;
  b[24] = w1 & 0xff;
  b[25] = (w1 >> 8) & 0xff;
  b[26] = (w1 >> 16) & 0xff;
  b[27] = h1 & 0xff;
  b[28] = (h1 >> 8) & 0xff;
  b[29] = (h1 >> 16) & 0xff;
  return b;
}

describe("parseDims — header parsing per format", () => {
  test("PNG", () => {
    expect(parseDims(png(3, 7))).toEqual({ w: 3, h: 7 });
    expect(parseDims(png(1920, 1080))).toEqual({ w: 1920, h: 1080 });
  });
  test("GIF", () => {
    expect(parseDims(gif(5, 9))).toEqual({ w: 5, h: 9 });
  });
  test("JPEG (SOF0 after an APP0 segment)", () => {
    expect(parseDims(jpeg(4, 8))).toEqual({ w: 4, h: 8 });
    expect(parseDims(jpeg(800, 600))).toEqual({ w: 800, h: 600 });
  });
  test("WebP VP8 (lossy)", () => {
    expect(parseDims(webpVP8(100, 200))).toEqual({ w: 100, h: 200 });
  });
  test("WebP VP8L (lossless)", () => {
    expect(parseDims(webpVP8L(7, 3))).toEqual({ w: 7, h: 3 });
  });
  test("WebP VP8X (extended)", () => {
    expect(parseDims(webpVP8X(6, 10))).toEqual({ w: 6, h: 10 });
  });
});

describe("parseDims — rejects bad input", () => {
  test("random garbage returns null", () => {
    expect(parseDims(Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]))).toBe(
      null,
    );
  });
  test("plain text returns null", () => {
    expect(parseDims(Buffer.from("not an image at all, just words"))).toBe(null);
  });
  test("truncated / empty buffer returns null", () => {
    expect(parseDims(Buffer.alloc(0))).toBe(null);
    expect(parseDims(Buffer.from([0x89, 0x50]))).toBe(null);
  });
  test("PNG with zero dimensions returns null", () => {
    expect(parseDims(png(0, 0))).toBe(null);
  });
});

describe("imageDimensions — reads real files + caches", () => {
  test("PNG and GIF from disk", () => {
    const dir = mkdtempSync(join(tmpdir(), "pd-imgdims-"));
    try {
      const p = join(dir, "a.png");
      const g = join(dir, "a.gif");
      writeFileSync(p, png(42, 24));
      writeFileSync(g, gif(11, 13));
      expect(imageDimensions(p)).toEqual({ w: 42, h: 24 });
      expect(imageDimensions(g)).toEqual({ w: 11, h: 13 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("missing file returns null", () => {
    expect(imageDimensions(join(tmpdir(), "does-not-exist-xyz.png"))).toBe(null);
  });

  test("result is cached by path (survives the file being removed)", () => {
    const dir = mkdtempSync(join(tmpdir(), "pd-imgdims-cache-"));
    const p = join(dir, "c.png");
    writeFileSync(p, png(64, 48));
    expect(imageDimensions(p)).toEqual({ w: 64, h: 48 });
    // Delete the file; the cached value must still come back.
    rmSync(dir, { recursive: true, force: true });
    expect(imageDimensions(p)).toEqual({ w: 64, h: 48 });
    // After clearing the cache, the now-missing file yields null.
    clearImageDimsCache();
    expect(imageDimensions(p)).toBe(null);
  });
});
