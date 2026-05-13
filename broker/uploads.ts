// Image upload + the /open-file launcher. Both are scoped to UPLOADS_DIR;
// the latter additionally restricts via path.resolve to prevent the broker
// from becoming a generic local-file launcher.

import * as fs from "node:fs";
import * as path from "node:path";
import {
  ALLOWED_IMAGE_EXTS,
  MAX_UPLOAD_BYTES,
  UPLOADS_DIR,
} from "./config.ts";
import { generateRandomId } from "./helpers.ts";

export function handleUploadImage(body: {
  board_id?: string;
  filename?: string;
  data_base64?: string;
  mime?: string;
}):
  | { ok: true; path: string; url: string }
  | { ok: false; error: string } {
  const dataB64 = body.data_base64;
  if (!dataB64) return { ok: false, error: "data_base64 required" };

  // board_id is folded into the path; sanitize aggressively because it lands
  // in the filesystem.
  const safeBoard = (body.board_id ?? "misc").replace(/[^a-zA-Z0-9_-]/g, "_");
  const filename = body.filename ?? "image";
  const extFromName = filename.split(".").pop()?.toLowerCase() ?? "";
  const ext = ALLOWED_IMAGE_EXTS.has(extFromName) ? extFromName : "png";

  let buf: Buffer;
  try {
    buf = Buffer.from(dataB64, "base64");
  } catch {
    return { ok: false, error: "invalid base64" };
  }
  if (buf.length === 0) return { ok: false, error: "empty payload" };
  if (buf.length > MAX_UPLOAD_BYTES) {
    return {
      ok: false,
      error: `file too large (max ${MAX_UPLOAD_BYTES} bytes)`,
    };
  }

  const dir = path.join(UPLOADS_DIR, safeBoard);
  fs.mkdirSync(dir, { recursive: true });
  const id = generateRandomId("img");
  const filenameOnDisk = `${id}.${ext}`;
  const fullPath = path.join(dir, filenameOnDisk);
  fs.writeFileSync(fullPath, buf);
  const url = `/uploads/${safeBoard}/${filenameOnDisk}`;
  return { ok: true, path: fullPath, url };
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
  // macOS `open` — opens the file in its default application. We don't wait
  // for the GUI app to launch.
  Bun.spawn(["open", resolved]).unref();
  return { ok: true };
}

export const routes = {
  "/upload-image": handleUploadImage,
  "/open-file": handleOpenFile,
};
