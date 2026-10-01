// Find the Claude model a Claude Code session is currently running by reading
// the TAIL of its transcript JSONL. Each assistant entry carries the API model
// id, e.g. {"type":"assistant","message":{"model":"claude-opus-5-5",...},...},
// so the latest main-thread assistant entry reflects any `/model` switch.
//
// Transcripts can grow past 100 MB, so we never read the whole file: we read a
// fixed window from the end, and only if no assistant entry fits in it (one huge
// tool payload can fill the window) widen once to a larger window. The first
// line of a window is usually cut mid-way; it simply fails to parse and is
// skipped. Every failure returns null — callers are best-effort hooks.

import * as fs from "node:fs";

export const TAIL_WINDOWS = [256 * 1024, 2 * 1024 * 1024];

// Pick the model from the last eligible assistant line in `text`. Lines are
// scanned from the end so the newest entry wins. Skipped:
//  - lines that fail to parse (the truncated first line of a tail window),
//  - sidechain (subagent) entries — a subagent may run a different model than
//    the session itself,
//  - synthetic models ("<synthetic>", written for locally generated messages
//    such as API-error notices), and empty / non-string models.
export function lastModelFromJsonl(text: string): string | null {
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    // Cheap prefilter before JSON.parse: most lines are user / tool entries.
    if (!line || !line.includes('"assistant"') || !line.includes('"model"')) {
      continue;
    }
    let entry: any;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!entry || typeof entry !== "object" || entry.type !== "assistant") {
      continue;
    }
    if (entry.isSidechain === true) continue;
    const model = entry.message?.model;
    if (typeof model !== "string") continue;
    const m = model.trim();
    if (!m || m.startsWith("<")) continue;
    return m;
  }
  return null;
}

// Read at most `maxBytes` from the end of `file` as UTF-8. A multi-byte char
// split at the window start just garbles the (already truncated) first line.
export function readTail(file: string, maxBytes: number): string {
  const fd = fs.openSync(file, "r");
  try {
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, maxBytes);
    if (len <= 0) return "";
    const buf = Buffer.alloc(len);
    let off = 0;
    while (off < len) {
      const n = fs.readSync(fd, buf, off, len - off, size - len + off);
      if (n <= 0) break;
      off += n;
    }
    return buf.subarray(0, off).toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}

// The current model of the transcript at `file`, or null when unknown.
export function modelFromTranscript(
  file: string,
  windows: number[] = TAIL_WINDOWS,
): string | null {
  try {
    const size = fs.statSync(file).size;
    for (const w of windows) {
      const found = lastModelFromJsonl(readTail(file, w));
      if (found) return found;
      // The window already covered the whole file — a wider one adds nothing.
      if (w >= size) break;
    }
  } catch {
    /* missing / unreadable transcript */
  }
  return null;
}
