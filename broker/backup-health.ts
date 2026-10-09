// DB backup health — surfaces the result of scripts/backup-db.ts in the UI.
//
// The backup runs from the OS scheduler (Task Scheduler on Windows), so a
// failing or never-running backup would otherwise be completely silent. Every
// run writes <home>/backup-status.json; this module reads that one file,
// classifies it, and pushes the result to every page.
//
// Deliberately separate from global-banner.ts: that banner is a single slot
// external tools (cc-usage etc.) overwrite at will, and a backup failure must
// not be erased by an unrelated announcement.
//
// Polling, not fs.watch: watch events are unreliable on Windows and on
// cloud-synced folders, and staleness (the task silently stopped running)
// changes the verdict with no file change at all. The GET route recomputes
// too, so a fresh page load is always current.

import * as fs from "node:fs";
import * as path from "node:path";
import type { BackupHealth } from "../shared/types.ts";
import { broadcastToAll } from "./ws.ts";

// The task runs daily; 36h tolerates a run that slipped by a few hours (the
// machine was asleep at 11:30 and StartWhenAvailable ran it later) while still
// flagging a whole missed day.
export const BACKUP_STALE_AFTER_HOURS = 36;
export const BACKUP_HEALTH_POLL_MS = 5 * 60_000;

const STATUS_FILE = "backup-status.json";
const LOG_FILE = "backup.log";

function base(): BackupHealth {
  return {
    state: "none",
    finished_at: null,
    error: null,
    dest: null,
    prune_errors: 0,
    stale_after_hours: BACKUP_STALE_AFTER_HOURS,
    log_path: null,
  };
}

// Pure classifier. `text` is the status file's content, or null when the file
// does not exist (= backup not configured on this machine → no UI at all).
export function evaluateBackupHealth(
  text: string | null,
  now: Date,
): BackupHealth {
  const h = base();
  if (text === null) return h;
  let s: any;
  try {
    s = JSON.parse(text);
  } catch {
    return { ...h, state: "unreadable", error: "invalid JSON" };
  }
  if (!s || typeof s !== "object" || typeof s.ok !== "boolean") {
    return { ...h, state: "unreadable", error: "unexpected content" };
  }
  const finishedMs =
    typeof s.finished_at === "string" ? Date.parse(s.finished_at) : NaN;
  h.finished_at = Number.isNaN(finishedMs) ? null : s.finished_at;
  h.dest = typeof s.dest === "string" ? s.dest : null;
  if (!s.ok) {
    h.state = "failed";
    h.error = typeof s.error === "string" && s.error ? s.error : null;
    return h;
  }
  // ok:true without a usable finish time cannot be judged for staleness.
  if (h.finished_at === null) {
    return { ...h, state: "unreadable", error: "missing finished_at" };
  }
  h.prune_errors =
    typeof s.prune_errors === "number" && s.prune_errors > 0
      ? s.prune_errors
      : 0;
  const ageMs = now.getTime() - finishedMs;
  h.state = ageMs > BACKUP_STALE_AFTER_HOURS * 3_600_000 ? "stale" : "ok";
  return h;
}

// --- runtime (broker process only) ---

let homeDir: string | null = null;
let lastJson: string | null = null;
let current: BackupHealth = base();
let timer: ReturnType<typeof setInterval> | null = null;

function readStatus(dir: string): string | null | { readError: string } {
  try {
    return fs.readFileSync(path.join(dir, STATUS_FILE), "utf8");
  } catch (e: any) {
    if (e?.code === "ENOENT") return null;
    return { readError: e?.message ?? String(e) };
  }
}

// Re-read the file, and broadcast only when the verdict actually changed.
export function refreshBackupHealth(now: Date = new Date()): BackupHealth {
  if (!homeDir) return current;
  const raw = readStatus(homeDir);
  const next =
    raw !== null && typeof raw === "object"
      ? { ...base(), state: "unreadable" as const, error: raw.readError }
      : evaluateBackupHealth(raw, now);
  next.log_path = next.state === "none" ? null : path.join(homeDir, LOG_FILE);
  current = next;
  const json = JSON.stringify(next);
  if (json !== lastJson) {
    // The first evaluation only seeds lastJson — no client has fetched yet, and
    // every client pulls via /get-backup-health on (re)connect anyway.
    const first = lastJson === null;
    lastJson = json;
    if (!first) broadcastToAll({ type: "backup-health-update", health: next });
  }
  return next;
}

export function startBackupHealthPoller(dir: string): void {
  homeDir = dir;
  refreshBackupHealth();
  if (timer) clearInterval(timer);
  timer = setInterval(() => refreshBackupHealth(), BACKUP_HEALTH_POLL_MS);
  // Never keep a process alive just for this poll.
  (timer as any).unref?.();
}

export function handleGetBackupHealth(): { ok: true; health: BackupHealth } {
  return { ok: true, health: refreshBackupHealth() };
}

export const routes = {
  "/get-backup-health": handleGetBackupHealth,
};
