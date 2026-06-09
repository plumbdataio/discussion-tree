---
name: dt-checklist
description: >-
  Use when you need to create or maintain a checklist, to-do list, task
  tracker, list of work phases/steps, or acceptance criteria on a
  discussion-tree (dt) board — any list of lines you will check off. The
  authoritative reference for dt's checklist mechanism. Covers: the
  is_checklist node concept; creating one (add_item then mark_checklist_node);
  adding lines (record_decision, which start pending); advancing status
  (update_decision: pending -> in-progress -> done / dropped, where dropped
  needs a drop_reason); reading current state (the checklist_items array via
  get_board); and the rule against hand-building a fake checklist out of
  concern/item nodes. Trigger contexts: "make a checklist", "track the
  steps/phases on the board", "todo list", "acceptance criteria", "check this
  off as we go" — while working in discussion-tree.
metadata:
  version: 1.0.0
---

# Making a checklist in discussion-tree (dt)

dt has a **first-class checklist mechanism**. Do NOT hand-build a checklist as
a concern with item children styled like checkboxes. That looks like a
checklist in the tree but is **not** one: no real per-item status, no
read-only protection, nothing surfaces as `checklist_items`, and it can't be
rolled up or verified later. Use the real tools every time — for BOTH decision
checklists (acceptance criteria as a board settles) and plain task / phase /
to-do checklists.

## How to make one

1. **Create the node** — `add_item` one normal node on the board (title = the
   checklist's name, e.g. "論理削除タスク チェックリスト"). Place it leftmost
   under its concern by convention.
2. **Flag it** — `mark_checklist_node(board_id, node_id)`. This turns that one
   node into a real checklist (`is_checklist=1`). Checklist nodes are never
   auto-created; you make a normal node and flag it.
3. **Add each line** — `record_decision(board_id, node_id=<the checklist node>,
   summary, sources=[...])`. Each line starts `pending`. Write the summary as a
   short, verifiable line ("X であること / X を完了すること。背景: …") so it can
   be checked off and audited later. One line per item; keep them granular.
4. **Advance status** — `update_decision(item_id, status=...)`:
   `pending → in-progress → done`, or `dropped` (which REQUIRES a non-empty
   `drop_reason`). The checklist UI is read-only, so these tools are the only
   way to change items.

## Notes

- `get_board` returns the `checklist_items` array on the `is_checklist` node,
  so you can read current statuses and re-verify `done` items against the
  actual work.
- "The work is truly finished" means every item is `done` (or `dropped` with a
  reason) — not merely that the board's nodes settled.
- Don't bolt a checklist onto a board nobody asked to track. But when a
  checklist IS wanted, `mark_checklist_node` is how you make it — never a
  hand-built concern/item tree.
