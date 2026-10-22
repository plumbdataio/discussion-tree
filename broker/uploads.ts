// Image upload + the /open-file launcher. Both are scoped to UPLOADS_DIR;
// the latter additionally restricts via path.resolve to prevent the broker
// from becoming a generic local-file launcher.

import * as fs from "node:fs";
import * as path from "node:path";
import {
  ALLOWED_IMAGE_EXTS,
  MAX_UPLOAD_BYTES,
  STORAGE_ONLY_IMAGE_EXTS,
  UPLOADS_DIR,
} from "./config.ts";
import { generateRandomId } from "./helpers.ts";

// Upload naming: the message image is `<id>.<ext>`; when the client also sends
// the untouched original (a large photo it downscaled, or a HEIC it converted
// to JPEG — see web/utils/imagePrep.ts) that is stored as `<id>.orig.<ext>` in
// the same folder. The pairing lives in the file names only (no DB row), so it
// survives reloads and old messages simply have no `.orig.` sibling.
//
// No server-side resizing: Bun has no image codec, and the one dependency that
// would do it (sharp / libvips, native) is a heavy addition to a long-lived
// broker that runs on two OSes. The images this path would catch are few —
// browser uploads are already prepared client-side, and CC usually copies its
// files straight into uploads/ without calling this endpoint at all.

const ORIGINAL_MARK = ".orig.";

function storableExt(ext: string): boolean {
  return ALLOWED_IMAGE_EXTS.has(ext) || STORAGE_ONLY_IMAGE_EXTS.has(ext);
}

function extOf(filename: string): string {
  return filename.split(".").pop()?.toLowerCase() ?? "";
}

function decodeB64(dataB64: string): Buffer | { error: string } {
  let buf: Buffer;
  try {
    buf = Buffer.from(dataB64, "base64");
  } catch {
    return { error: "invalid base64" };
  }
  if (buf.length === 0) return { error: "empty payload" };
  if (buf.length > MAX_UPLOAD_BYTES) {
    return { error: `file too large (max ${MAX_UPLOAD_BYTES} bytes)` };
  }
  return buf;
}

export function handleUploadImage(body: {
  board_id?: string;
  filename?: string;
  data_base64?: string;
  mime?: string;
  // Optional (newer clients): the untouched original of `data_base64`.
  original_base64?: string;
  original_filename?: string;
}):
  | {
      ok: true;
      path: string;
      url: string;
      original_path?: string;
      original_url?: string;
    }
  | { ok: false; error: string } {
  const dataB64 = body.data_base64;
  if (!dataB64) return { ok: false, error: "data_base64 required" };

  // board_id is folded into the path; sanitize aggressively because it lands
  // in the filesystem.
  const safeBoard = (body.board_id ?? "misc").replace(/[^a-zA-Z0-9_-]/g, "_");
  const filename = body.filename ?? "image";
  const extFromName = extOf(filename);
  const ext = storableExt(extFromName) ? extFromName : "png";

  const buf = decodeB64(dataB64);
  if (!Buffer.isBuffer(buf)) return { ok: false, error: buf.error };

  let origBuf: Buffer | null = null;
  let origExt = "";
  if (body.original_base64) {
    const o = decodeB64(body.original_base64);
    if (!Buffer.isBuffer(o)) return { ok: false, error: `original: ${o.error}` };
    origBuf = o;
    const e = extOf(body.original_filename ?? "");
    // An original whose type we don't know is still kept, under a neutral
    // extension, so "open full size" can at least offer it for download.
    origExt = storableExt(e) ? e : "bin";
  }

  const dir = path.join(UPLOADS_DIR, safeBoard);
  fs.mkdirSync(dir, { recursive: true });
  const id = generateRandomId("img");
  const filenameOnDisk = `${id}.${ext}`;
  const fullPath = path.join(dir, filenameOnDisk);
  // Original first: if the derived write then fails, no message ever points
  // at a half-written pair (an orphan original is harmless).
  let original: { original_path: string; original_url: string } | {} = {};
  if (origBuf) {
    const origName = `${id}${ORIGINAL_MARK}${origExt}`;
    const origPath = path.join(dir, origName);
    fs.writeFileSync(origPath, origBuf);
    original = {
      original_path: origPath,
      original_url: `/uploads/${safeBoard}/${origName}`,
    };
  }
  fs.writeFileSync(fullPath, buf);
  const url = `/uploads/${safeBoard}/${filenameOnDisk}`;
  return { ok: true, path: fullPath, url, ...original };
}

// Can this browser show a HEIC image in a tab? Only WebKit does: every iOS /
// iPadOS browser (all WebKit), and Safari on the Mac. iPadOS in desktop mode
// reports a Mac Safari UA, which is also right.
export function uaCanDisplayHeic(ua: string | null | undefined): boolean {
  const s = ua ?? "";
  if (/\b(iPhone|iPad|iPod)\b/.test(s)) return true;
  return (
    /\bMacintosh\b/.test(s) &&
    /\bVersion\/\d/.test(s) &&
    /\bSafari\//.test(s) &&
    !/\b(Chrome|Chromium|CriOS|Edg|EdgiOS|OPR|Firefox|FxiOS)\//.test(s)
  );
}

/**
 * "Open full size" for an uploaded image (GET /uploads/<rel>?full=1).
 * Returns the /uploads/ URL to send the browser to: the stored original when
 * one exists and this browser can display it, else null (= serve the
 * requested file itself — old uploads and small images have no original).
 */
export function resolveFullSizeUpload(
  rel: string,
  ua: string | null | undefined,
): string | null {
  const slash = rel.lastIndexOf("/");
  if (slash <= 0) return null;
  const board = rel.slice(0, slash);
  const name = rel.slice(slash + 1);
  if (name.includes(ORIGINAL_MARK)) return null;
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return null;
  const stem = name.slice(0, dot);
  if (!/^[A-Za-z0-9_-]+$/.test(stem) || !/^[A-Za-z0-9_-]+$/.test(board)) {
    return null;
  }
  const candidates = [
    ...ALLOWED_IMAGE_EXTS,
    ...STORAGE_ONLY_IMAGE_EXTS,
    "bin",
  ];
  for (const e of candidates) {
    const origName = `${stem}${ORIGINAL_MARK}${e}`;
    if (!fs.existsSync(path.join(UPLOADS_DIR, board, origName))) continue;
    if (STORAGE_ONLY_IMAGE_EXTS.has(e) && !uaCanDisplayHeic(ua)) return null;
    if (e === "bin") return null;
    return `/uploads/${board}/${origName}`;
  }
  return null;
}

export function handleOpenFile(body: { path?: string }):
  | { ok: true }
  | { ok: false; error: string } {
  const target = body.path;
  if (!target || typeof target !== "string") {
    return { ok: false, error: "path required" };
  }
  // Restrict to files within UPLOADS_DIR — without this gate the endpoint
  // would let any client open any file on the host.
  const resolved = path.resolve(target);
  const allowedRoot = path.resolve(UPLOADS_DIR);
  if (!resolved.startsWith(allowedRoot + path.sep)) {
    return { ok: false, error: "path outside allowed directory" };
  }
  if (!fs.existsSync(resolved)) {
    return { ok: false, error: "file not found" };
  }
  // Hand the file to the OS so its default app opens it. Per-platform:
  //   darwin  -> open <path>
  //   win32   -> cmd /c start "" <path>   (empty "" is the window title)
  //   linux   -> xdg-open <path>
  // We don't wait for the GUI app to launch.
  const platform = process.platform;
  const argv =
    platform === "darwin"
      ? ["open", resolved]
      : platform === "win32"
        ? ["cmd", "/c", "start", "", resolved]
        : ["xdg-open", resolved];
  Bun.spawn(argv).unref();
  return { ok: true };
}

export const routes = {
  "/upload-image": handleUploadImage,
  "/open-file": handleOpenFile,
};
