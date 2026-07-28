---
name: dt-issue-links
description: Attach discussion-tree messages to the issues they belong to, so one issue's conversation can be read as a single timeline no matter which board, map or diagram each part of it happened on. Use when posting to dt (every post takes issue_ids), when compacting or having just compacted (the post-compact hook asks for a review of the window that was lost), when the user asks what was decided about something and the answer is scattered, or when filing or closing an issue and its discussion should be findable. Keywords: issue_ids, link_message_to_issues, review_message_links, compact, compaction, issue timeline, which board did we discuss this on.
---

# Attaching messages to issues

An issue's discussion never stays in one place. It starts on the general board,
moves to a dedicated board, picks up a diagram, and comes back. Neither the user
nor a post-compaction you can follow that by memory. Links are what make it
readable as one timeline — and collecting them is the hard part, because it
depends on noticing in the moment.

Two mechanisms cover the two ways it fails.

## 1. Every post decides, because the parameter is required

`post_to_node`, `post_to_map_node` and `post_diagram_chat` all require
`issue_ids`. You cannot post without answering the question.

- **Pass the ids** of every issue the message is about. A message that genuinely
  covers two issues gets both — it is not split.
- **Pass `[]`** when it belongs to none. That is a real answer, not a cop-out —
  small talk, acknowledgements and pure process messages usually belong nowhere.
  What is not acceptable is passing `[]` *without looking*.
- **An unknown id rejects the whole post** and names the id. Nothing is written,
  so fix the argument and send it again. (A deleted issue reads as unknown.)

Do not call `list_issues` before every post. Keep the handful of ids you are
working on in mind, and look them up when the conversation moves somewhere new.

## 2. After a compaction, review what was missed

The window you just compacted is the part you can no longer read, so it is the
last moment its messages can be linked. The post-compact hook counts what is
still unattached and tells you when there is something to do; it stays silent
otherwise.

```
review_message_links()                    # defaults to exactly that window
link_message_to_issues(message_id, issue_ids=[...])
```

`review_message_links` returns a *head* of each message plus the board and node
it was said on — not the text. The head identifies which message it is; the path
is what reminds you what the exchange was about. Ask for more with `head_chars`
if a head is genuinely ambiguous, rather than pulling whole threads.

It takes `from` and `to`. Both matter: if a compaction happened without the
review, pass `to` = that compact time to recover the window afterwards. Without
it that window is simply lost.

## Before you rely on the tools being there

`issue_ids`, `review_message_links` and `link_message_to_issues` arrive with a
plugin version. Check they exist before reporting that anything was linked — a
session that has not picked up the new tool list will post happily and link
nothing, and it is easy to describe that as working.

`/reload-plugins` reloads skills but NOT the MCP tool list (measured twice).
`/mcp` reconnects the server and does pick it up, which is the cheapest fix; a
session restart also works.

## What belongs to an issue

Ask what the message *is*, not what it mentions.

- **Link** it when it moves the issue: a decision, a measurement, a rejected
  option and why, a correction, a request that changes the shape of the work.
- **Do not link** it when it merely happens nearby: acknowledgements, status
  pings, "done, pushed", or a passing mention of an unrelated issue.
- **Prefer linking to guessing.** A message on the wrong issue is visible and
  removable (`unlink_issue_id`); one that was never linked is invisible, and
  nobody ever finds out it is missing.

## Reading the result — the reason any of this is done

`get_issue_timeline(issue_id)` returns that issue's whole conversation in the
order it was said, across every board, map and diagram, with full text.

**Reach for it before answering from memory about an issue you have not touched
this session** — after a compaction, or when the user refers to a decision made
somewhere you cannot see. The issue body is a summary someone wrote at one
moment; the timeline is what was actually said. Guessing from the body is how a
confident wrong answer gets produced.

Pass `head_chars` when you only need to locate the thread rather than read it.
The user has the same view in the UI: an issue row → "会話を見る".

## A note on scope

Both mechanisms above assume a session that runs long enough to be compacted. In
a short, single-purpose session the required parameter still applies and is
enough on its own — there is no window to review, because nothing was lost.
