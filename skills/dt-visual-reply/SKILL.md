---
name: dt-visual-reply
description: >-
  Use when replying on a discussion-tree (dt) board, map, or diagram and a
  picture would land faster than prose — a before/after comparison, a route or
  topology, a measured timeline, a branching procedure, relative magnitudes, a
  UI mockup. The authoritative reference for sending images INTO dt. Covers:
  deciding whether to draw at all; choosing between dt's mermaid diagram
  surface and a rendered image; generating the image (matplotlib through uv,
  including CJK fonts that would otherwise render as tofu); uploading it to the
  broker; embedding it inline at the right point in the post. Trigger contexts:
  "explain this", "why did it break", "compare these options", "what's the
  flow", "show me the difference" — or any moment you are about to write three
  paragraphs describing a shape, a sequence, or a set of numbers.
metadata:
  version: 1.0.0
---

# Replying with a picture in discussion-tree (dt)

## Why this skill exists — read this once

**The mechanism to post images has existed for a long time and was almost
never used.** `server/instructions.ts` even says so in as many words ("HIGH
VALUE and under-used") and still it went unused. The gap was never capability;
it was recall — the procedure lived somewhere you did not look at the moment
you were writing a reply.

So this skill is a *recall device*, and the trigger is behavioural, not
technical: **when you notice you are about to describe a shape, a route, a
sequence, or a set of numbers in prose, stop and draw it instead.** If you only
remember one line from this file, remember that one.

Keeping this file accurate is part of the job — if the upload path or the tool
names change, update it here, or the next session will follow a dead procedure.

## 1. Should this be a picture at all?

**Draw when the content has a shape that prose has to serialise:**

| Signal | Example |
|---|---|
| Before / after, A vs B | what the code did before the fix vs after |
| A route or topology | which hop broke, what talks to what |
| A timeline | measured phases, what happens at t+3s |
| A branching procedure | "if X then A, else B, then rejoin" |
| Relative magnitudes | which session burned the quota, by how much |
| A UI mockup | option layouts, icon variants, spacing |

**Do NOT draw when:**

- the point fits in one sentence — a picture of one fact is noise;
- a markdown table already says it (tables render fine in dt, and they are
  searchable and copyable — prefer them for pure tabular data);
- the "picture" would just be a bulleted list with boxes around it.

**A picture never replaces the conclusion.** Always write the takeaway in text
as well: the reader may be on a phone, and text is what search and later
sessions can read. A post whose meaning exists only inside a PNG is a bad post.

## 2. Which surface: mermaid diagram, or an image in the post?

dt has two visual surfaces and they are not interchangeable.

**Use the mermaid diagram surface** (`upsert_diagram`) when the drawing is an
artifact the user will come back to: a system diagram, a decision tree, an
architecture the discussion will keep referring to. It is live-updating,
zoomable, has its own chat thread, and lives in the sidebar.

**Use an image in the post** (this skill) when the drawing is evidence *for
this reply*: a chart of real numbers, a measured timeline, a mockup, a
screenshot, anything with a visual style mermaid cannot express. It sits inline
in the thread exactly where the argument needs it.

When in doubt: will the user want to open this again next week? → diagram
surface. Is it "look at this, here's why"? → image in the post.

## 3. Generate the image

### Use `uv`, not a bare `python3`

```bash
uv run --with matplotlib python3 /path/to/figure.py
```

**Do not call a bare `python3`.** Its meaning depends on the session's PATH —
on this machine it has resolved to an unrelated project's virtualenv. `uv run
--with matplotlib` resolves the dependency itself and behaves the same from any
session. (First run builds matplotlib's font cache and takes a few seconds.)

Write the script into your scratchpad directory, not into the repo.

### Template (CJK-safe)

```python
import matplotlib
matplotlib.use("Agg")           # no GUI backend in a headless session
import matplotlib.pyplot as plt

# REQUIRED for Japanese labels. Without an explicit CJK family every CJK glyph
# renders as tofu (□□□). These families are present on this machine.
plt.rcParams["font.family"] = ["Hiragino Sans", "Arial Unicode MS"]

fig, ax = plt.subplots(figsize=(10, 4))
fig.patch.set_facecolor("white")   # dt threads render on a light card
# ... draw ...
fig.tight_layout()
fig.savefig("out.png", dpi=150, facecolor="white",
            bbox_inches="tight", pad_inches=0.25)
```

### Make it readable in a thread

- Width ~10-11in at dpi 150 — a dt thread column is narrow, so a wide, short
  figure reads better than a tall one.
- **White background explicitly** (`facecolor="white"` in both `savefig` and
  the figure). A transparent PNG looks broken in dark mode.
- Font sizes 9-13pt. Anything smaller is unreadable once the image is scaled
  into the column.
- Label directly on the drawing instead of using a legend when you can — a
  legend forces the eye to bounce.
- Drop chart junk: no grid unless it carries information, no box spines.

Matplotlib is not the only option: a headless-browser screenshot of HTML/SVG
works for UI mockups, and a plain screenshot of something you built is often
the most honest evidence. The upload path below is the same for any PNG.

## 4. Attach it to the post

The broker stores the file and hands back a URL you embed as normal markdown.

```bash
curl -s -X POST "http://127.0.0.1:${DISCUSSION_TREE_PORT:-7898}/upload-image" \
  -H 'Content-Type: application/json' \
  -d "{\"board_id\":\"<board or map id>\",\"filename\":\"fig.png\",\"data_base64\":\"$(base64 < out.png | tr -d '\n')\"}"
# -> {"ok":true,"url":"/uploads/<board_id>/img_xxx.png"}
```

**Pipe the base64 through the shell like this — never read it into your own
context.** A 10 MB image is ~13 MB of base64 text; materialising that in the
conversation is catastrophic. `$(base64 < file)` keeps the bytes inside the
shell.

Then put the returned URL in the message body, at the point in the argument
where it belongs:

```
post_to_node(board_id=..., node_id=..., message="""
...prose leading up to it...

![measured timeline](/uploads/<board_id>/img_xxx.png)

...what the reader should conclude from it...
""")
```

Same for `post_to_map_node` and `post_diagram_chat`. `board_id` accepts a map
id too — it is only used as the storage folder.

Limits: **10 MB**, extension whitelist (png/jpg/webp/gif). A matplotlib PNG is
typically ~100 KB, so the ceiling is not a practical concern.

## 5. Before you send

- [ ] Is the takeaway also written in text? (image-only posts are bad posts)
- [ ] Does the image have a white background and readable font sizes?
- [ ] Are CJK labels actually rendered — not tofu? If you cannot be sure, read
      the PNG back with the Read tool and look at it. It costs one tool call
      and catches the failure the user would otherwise have to report.
- [ ] Is the image placed at the point in the prose where it is needed, not
      dumped at the end?
