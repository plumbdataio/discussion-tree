// CC's "API/UI doesn't let me express X" feedback channel.
// /log-request appends to REQUESTS.md and pushes a notification message into
// every other alive session's pending queue so they surface the new entry
// in their UIs without polling the markdown file.

import { REQUESTS_FILE } from "./config.ts";
import { db } from "./db.ts";

async function notifyAllSessionsOfFeedback(body: any) {
  const sessions = db
    .query("SELECT id FROM sessions WHERE alive = 1")
    .all() as { id: string }[];
  if (sessions.length === 0) return;
  const now = new Date().toISOString();
  const lines = [`[feedback logged] ${body.title}`, "", body.blocker];
  if (body.suggested_change) {
    lines.push("");
    lines.push(`**Suggested**: ${body.suggested_change}`);
  }
  if (body.board_id) {
    lines.push("");
    lines.push(`**Board**: \`${body.board_id}\``);
  }
  const text = lines.join("\n");
  for (const s of sessions) {
    if (s.id === body.session_id) continue; // don't echo back to the requester
    db.run(
      "INSERT INTO pending_messages (session_id, board_id, node_id, node_path, text, created_at, kind) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [s.id, "", "", "REQUESTS.md", text, now, "feedback_logged"],
    );
  }
}

export async function handleLogRequest(body: any) {
  const ts = new Date().toISOString();
  const lines: string[] = [];
  lines.push(`## ${ts} — ${body.title}`);
  lines.push("");
  lines.push(`**Blocker**`);
  lines.push("");
  lines.push(body.blocker);
  lines.push("");
  if (body.suggested_change) {
    lines.push(`**Suggested change**`);
    lines.push("");
    lines.push(body.suggested_change);
    lines.push("");
  }
  if (body.board_id) {
    lines.push(`**Board**: \`${body.board_id}\``);
    lines.push("");
  }
  lines.push(`**Session**: \`${body.session_id ?? "unknown"}\``);
  lines.push("");
  lines.push("---");
  lines.push("");

  const entry = lines.join("\n");
  const file = Bun.file(REQUESTS_FILE);
  let existing = "";
  if (await file.exists()) {
    existing = await file.text();
  } else {
    existing =
      "# parallel-discussion improvement requests\n\n" +
      "Accumulates points where Claude Code, while operating parallel-discussion, " +
      "felt the current API/UI could not express what it wanted to convey. The user " +
      "reviews these and implements the higher-priority ones.\n\n" +
      "---\n\n";
  }
  await Bun.write(REQUESTS_FILE, existing + entry);
  await notifyAllSessionsOfFeedback(body);
  return { ok: true, file: REQUESTS_FILE };
}

export const routes = {
  "/log-request": handleLogRequest,
};
