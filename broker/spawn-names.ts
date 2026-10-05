// Pure tmux-session-name helpers, split out from spawn.ts so they carry no DB /
// tmux side effects and can be unit-tested directly.

// tmux forbids "." and ":" in session names and chokes on whitespace, so reduce
// any user/derived name to a safe token. Falls back to "cc" if it empties out.
export function sanitizeSessionName(raw: string): string {
  const s = String(raw ?? "")
    .trim()
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return s || "cc";
}

// Last path segment. On win32 both "\" and "/" separate segments (a Windows cwd
// is "C:\Users\x\proj"); elsewhere only "/" does, since "\" is a legal
// filename character on POSIX.
function basename(p: string, platform: NodeJS.Platform): string {
  const sep = platform === "win32" ? /[\\/]+/ : /\/+/;
  const trailing = platform === "win32" ? /[\\/]+$/ : /\/+$/;
  const parts = String(p ?? "")
    .replace(trailing, "")
    .split(sep);
  return parts[parts.length - 1] || "";
}

// The session name to use when the modal leaves the field blank: the dt session
// name (resume) or the cwd's last path segment (new), sanitized.
export function defaultSessionName(
  hint: string | null,
  cwd: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const base = (hint && hint.trim()) || basename(cwd, platform);
  return sanitizeSessionName(base);
}
