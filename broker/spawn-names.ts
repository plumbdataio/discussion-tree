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

function basename(p: string): string {
  const parts = String(p ?? "")
    .replace(/\/+$/, "")
    .split("/");
  return parts[parts.length - 1] || "";
}

// The session name to use when the modal leaves the field blank: the dt session
// name (resume) or the cwd's last path segment (new), sanitized.
export function defaultSessionName(hint: string | null, cwd: string): string {
  const base = (hint && hint.trim()) || basename(cwd);
  return sanitizeSessionName(base);
}
