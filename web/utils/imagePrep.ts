// Prepare a pasted / dropped image so Claude can read it well, BEFORE upload.
//
// What Claude reads (Anthropic vision docs): only JPEG / PNG / GIF / WebP; the
// model reads up to a 2,576px long edge and silently downscales anything
// larger, and once a request carries more than 20 images each one must be at
// most 2000px. An iPhone photo (4032x3024, often HEIC) fails on both counts:
// HEIC is unreadable and the full resolution is wasted bytes + upload time.
//
// So the upload carries two files:
//   - the DERIVED image: <= 2000px long edge, in a Claude-readable format. This
//     is what goes into the message (inline image + the path CC reads).
//   - the ORIGINAL, unchanged (even HEIC), kept next to it for "open full size".
// When nothing needs to change (a Claude-readable image already <= 2000px) the
// file is uploaded as-is with no re-encode — recompression only ever loses.
//
// The pure decisions (sizing, format choice) are separate functions so they
// can be unit tested without a browser; the canvas pipeline below them is the
// only part that needs DOM APIs.

/** Long-edge cap for the derived image (the >20-images-per-request limit). */
export const CLAUDE_MAX_EDGE = 2000;
/** JPEG quality for photo sources. */
export const PHOTO_JPEG_QUALITY = 0.85;
/** Quality for a screenshot that had to leave PNG (keeps text crisp). */
export const SCREENSHOT_LOSSY_QUALITY = 0.92;
/**
 * A downscaled PNG larger than this is re-encoded lossy. 2000x2000 RGBA
 * screenshots are normally well under it; a photo saved as PNG is not.
 */
export const MAX_DERIVED_PNG_BYTES = 4 * 1024 * 1024;

export type SourceKind = "jpeg" | "png" | "gif" | "webp" | "heic" | "other";

const HEIC_MIMES = new Set([
  "image/heic",
  "image/heif",
  "image/heic-sequence",
  "image/heif-sequence",
]);

function extOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.slice(i + 1).toLowerCase() : "";
}

/** Classify a file by MIME type, falling back to its extension (a HEIC file
 *  often arrives with an empty `type` on browsers that don't know it). */
export function sourceKind(mime: string, name: string): SourceKind {
  const m = (mime || "").toLowerCase();
  const ext = extOf(name || "");
  if (HEIC_MIMES.has(m) || ext === "heic" || ext === "heif") return "heic";
  if (m === "image/jpeg" || m === "image/jpg" || ext === "jpg" || ext === "jpeg")
    return "jpeg";
  if (m === "image/png" || ext === "png") return "png";
  if (m === "image/gif" || ext === "gif") return "gif";
  if (m === "image/webp" || ext === "webp") return "webp";
  return "other";
}

/** True when the file is something the upload path should treat as an image. */
export function looksLikeImage(mime: string, name: string): boolean {
  if ((mime || "").toLowerCase().startsWith("image/")) return true;
  return sourceKind(mime, name) !== "other";
}

/**
 * Fit (w, h) inside a square of `max` on the long edge, preserving the aspect
 * ratio and never upscaling. Each side is at least 1px.
 */
export function fitLongEdge(
  w: number,
  h: number,
  max: number = CLAUDE_MAX_EDGE,
): { w: number; h: number; scaled: boolean } {
  const long = Math.max(w, h);
  if (!(long > max)) return { w, h, scaled: false };
  const r = max / long;
  // The long side is set exactly (rounding could otherwise land on max+1).
  if (w >= h) {
    return { w: max, h: Math.max(1, Math.round(h * r)), scaled: true };
  }
  return { w: Math.max(1, Math.round(w * r)), h: max, scaled: true };
}

export type PrepPlan =
  // Upload the file untouched (Claude-readable and small enough, or a kind we
  // deliberately don't re-encode).
  | { action: "keep" }
  // Re-encode at (w, h) in this primary format.
  | { action: "convert"; w: number; h: number; format: "jpeg" | "png" };

/**
 * Decide what to do with a decoded image of the given kind and size.
 *  - GIF is always kept: a canvas re-encode would drop its animation.
 *  - HEIC is always converted (Claude cannot read it), even when small.
 *  - Other kinds are converted only when the long edge exceeds `max`.
 *  - PNG stays PNG (screenshots: lossy would blur text); everything else is a
 *    photo and becomes JPEG. A too-large PNG result is handled at encode time.
 */
export function planPrep(
  kind: SourceKind,
  w: number,
  h: number,
  max: number = CLAUDE_MAX_EDGE,
): PrepPlan {
  if (kind === "gif" || kind === "other") return { action: "keep" };
  const fit = fitLongEdge(w, h, max);
  if (kind !== "heic" && !fit.scaled) return { action: "keep" };
  return {
    action: "convert",
    w: fit.w,
    h: fit.h,
    format: kind === "png" ? "png" : "jpeg",
  };
}

/** Filename for the derived file: same stem, extension of the output format. */
export function derivedFilename(name: string, mime: string): string {
  const base = (name || "pasted").replace(/\.[^./\\]*$/, "") || "pasted";
  const ext =
    mime === "image/jpeg"
      ? "jpg"
      : mime === "image/webp"
        ? "webp"
        : mime === "image/gif"
          ? "gif"
          : "png";
  return `${base}.${ext}`;
}

/**
 * Link target for "open full size" on an inline image. Uploads get `?full=1`,
 * which the broker answers with a redirect to the kept original when one
 * exists and the browser can display it (see broker/uploads.ts
 * resolveFullSizeUpload); anything else links to itself.
 */
export function fullSizeHref(src: string): string {
  if (!src.startsWith("/uploads/") || src.includes("?")) return src;
  return `${src}?full=1`;
}

// ---------------------------------------------------------------------------
// Browser pipeline
// ---------------------------------------------------------------------------

export type PreparedImage =
  // Upload `file` as the only file (no derived copy needed).
  | { kind: "unchanged"; file: File }
  // Upload `derived` as the message image and `original` alongside it.
  | { kind: "derived"; derived: Blob; derivedName: string; original: File }
  // HEIC this browser could not decode: upload the original alone and warn
  // that Claude cannot read it.
  | { kind: "undecodable"; file: File };

type Decoded = {
  source: CanvasImageSource;
  w: number;
  h: number;
  close: () => void;
};

async function decode(file: File): Promise<Decoded | null> {
  // createImageBitmap applies EXIF orientation with "from-image" (the default
  // in current browsers; passed explicitly for older ones).
  try {
    const bmp = await createImageBitmap(file, {
      imageOrientation: "from-image",
    });
    return { source: bmp, w: bmp.width, h: bmp.height, close: () => bmp.close() };
  } catch {
    /* fall through to <img> */
  }
  // <img> decodes some things createImageBitmap refuses (older Safari with an
  // options bag) and honors EXIF orientation via CSS image-orientation.
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = "async";
    img.src = url;
    await img.decode();
    if (!img.naturalWidth || !img.naturalHeight) return null;
    return {
      source: img,
      w: img.naturalWidth,
      h: img.naturalHeight,
      close: () => URL.revokeObjectURL(url),
    };
  } catch {
    URL.revokeObjectURL(url);
    return null;
  }
}

function canvasToBlob(
  canvas: HTMLCanvasElement,
  type: string,
  quality?: number,
): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

function newCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
}

// Downscale with good quality: halve repeatedly while more than 2x too large
// (a single big-ratio drawImage aliases fine detail), then one final draw.
function drawScaled(
  src: Decoded,
  w: number,
  h: number,
  opaque: boolean,
): HTMLCanvasElement {
  let cur: CanvasImageSource = src.source;
  let cw = src.w;
  let ch = src.h;
  while (cw > w * 2 && ch > h * 2) {
    const nw = Math.round(cw / 2);
    const nh = Math.round(ch / 2);
    const step = newCanvas(nw, nh);
    const sctx = step.getContext("2d")!;
    sctx.imageSmoothingEnabled = true;
    sctx.imageSmoothingQuality = "high";
    sctx.drawImage(cur, 0, 0, nw, nh);
    cur = step;
    cw = nw;
    ch = nh;
  }
  const out = newCanvas(w, h);
  const ctx = out.getContext("2d")!;
  if (opaque) {
    // JPEG has no alpha: a transparent pixel would otherwise turn black.
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, w, h);
  }
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(cur, 0, 0, w, h);
  return out;
}

/**
 * Produce the upload plan for one file. Never throws: anything unexpected
 * falls back to uploading the file unchanged (the pre-existing behavior).
 */
export async function prepareImageForClaude(file: File): Promise<PreparedImage> {
  const kind = sourceKind(file.type, file.name);
  if (kind === "gif" || kind === "other") return { kind: "unchanged", file };

  const decoded = await decode(file);
  if (!decoded) {
    return kind === "heic"
      ? { kind: "undecodable", file }
      : { kind: "unchanged", file };
  }
  try {
    const plan = planPrep(kind, decoded.w, decoded.h);
    if (plan.action === "keep") return { kind: "unchanged", file };

    let blob: Blob | null = null;
    if (plan.format === "png") {
      const canvas = drawScaled(decoded, plan.w, plan.h, false);
      blob = await canvasToBlob(canvas, "image/png");
      if (!blob || blob.size > MAX_DERIVED_PNG_BYTES) {
        // A photo saved as PNG: go lossy, but at screenshot quality. WebP
        // keeps alpha; a browser that can't encode WebP hands back PNG, in
        // which case use JPEG on white.
        const webp = await canvasToBlob(
          canvas,
          "image/webp",
          SCREENSHOT_LOSSY_QUALITY,
        );
        if (webp && webp.type === "image/webp") {
          blob = webp;
        } else {
          blob = await canvasToBlob(
            drawScaled(decoded, plan.w, plan.h, true),
            "image/jpeg",
            SCREENSHOT_LOSSY_QUALITY,
          );
        }
      }
    } else {
      const canvas = drawScaled(decoded, plan.w, plan.h, true);
      blob = await canvasToBlob(canvas, "image/jpeg", PHOTO_JPEG_QUALITY);
    }
    if (!blob || blob.size === 0) {
      return kind === "heic"
        ? { kind: "undecodable", file }
        : { kind: "unchanged", file };
    }
    return {
      kind: "derived",
      derived: blob,
      derivedName: derivedFilename(file.name, blob.type),
      original: file,
    };
  } catch {
    return kind === "heic"
      ? { kind: "undecodable", file }
      : { kind: "unchanged", file };
  } finally {
    decoded.close();
  }
}
