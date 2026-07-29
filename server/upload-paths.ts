// Seeing an attached image from a DIFFERENT machine.
//
// A message with an attachment carries the file twice: as a URL the browser
// fetches (`![image](/uploads/…)`, which works anywhere the broker is
// reachable) and as an absolute path for CC's Read tool
// (`[image] /Users/…/.discussion-tree/uploads/…`). The second one is written
// from the BROKER's filesystem. On the same machine that is exactly right —
// the file is there, and Read opens it with nothing in between.
//
// From another machine that path does not exist, and handing it over unchanged
// means CC tries to open a file that isn't there. So on a remote session the
// path is replaced with the way that DOES work: the get_image tool, which
// fetches the bytes from the broker and returns them as an image. Nothing is
// written to disk on either side.
//
// A shared folder was implemented first and removed before it was ever used:
// it needs setting up on both machines, and when a mount goes away it fails
// silently — CC just says it cannot read the file. The tool needs no setup and
// fails the same way the conversation does, which is the failure the user can
// already see.

// The uploads directory inside an absolute path, POSIX or Windows, capturing
// what follows it. The `.discussion-tree/uploads` tail is the stable part; the
// home directory in front of it is what differs per machine.
const UPLOAD_PATH_RE =
  /(?:[A-Za-z]:)?[\\/][^\s()\]]*?\.discussion-tree[\\/]uploads[\\/]([^\s()\]]+)/g;

/**
 * Rewrite absolute upload paths into a get_image call.
 *
 * Only for sessions whose broker is on another machine — pass `remote: false`
 * (the default) and the text comes back untouched, which is what a local
 * session wants: its Read tool can open the real file.
 */
export function rewriteUploadPaths(text: string, remote: boolean): string {
  if (!remote || !text) return text;
  return text.replace(
    UPLOAD_PATH_RE,
    (_all, rel: string) => `get_image("/uploads/${rel}")`,
  );
}
