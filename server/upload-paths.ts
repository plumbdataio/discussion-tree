// Making an attached image readable from a DIFFERENT machine.
//
// A message with an attachment carries the file twice: as a URL the browser
// fetches (`![image](/uploads/…)`, which works anywhere the broker is
// reachable) and as an absolute path for CC to open with the Read tool
// (`[image] /Users/…/.discussion-tree/uploads/…`). The second one is written
// from the BROKER's filesystem, so a CC on another machine is told to read a
// path that does not exist there — and images are a normal part of how the user
// says things, not an extra.
//
// If that directory is reachable from this machine under some other path (a
// share, a synced folder), DISCUSSION_TREE_UPLOADS_PATH says where, and the
// path is rewritten before CC ever sees it. Rewriting beats documenting: a
// convention only holds while everyone remembers it, and the failure mode here
// is silent — CC just says it cannot read the file, or worse, answers without
// having looked.
//
// No env var set (the normal, same-machine case) → the text is returned
// untouched.

// Matches the uploads directory in an absolute path, POSIX or Windows, keeping
// whatever follows it. The `.discussion-tree/uploads` tail is the stable part —
// the home directory in front of it is exactly what differs per machine.
const UPLOADS_DIR_RE = /(?:[A-Za-z]:)?[\\/][^\s()]*?\.discussion-tree[\\/]uploads[\\/]/g;

/**
 * Rewrite absolute upload paths so they point at `mount` instead of wherever
 * the broker keeps them. Trailing separators on `mount` are ignored, and the
 * separator style of the mount is used for the joint — a Windows mount
 * ("Z:\\dt-uploads") produces backslash-joined paths, which is what the Read
 * tool wants there.
 */
export function rewriteUploadPaths(text: string, mount?: string): string {
  const base = (mount ?? "").trim();
  if (!base || !text) return text;
  const trimmed = base.replace(/[\\/]+$/, "");
  const sep = trimmed.includes("\\") ? "\\" : "/";
  return text.replace(UPLOADS_DIR_RE, `${trimmed}${sep}`);
}

/** The configured mount, or undefined when this machine has the real one. */
export const UPLOADS_MOUNT = process.env.DISCUSSION_TREE_UPLOADS_PATH;
