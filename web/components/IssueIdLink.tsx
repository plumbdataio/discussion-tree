import React from "react";
import { openIssueTracker } from "../utils/issues.ts";
import { useIssueBrief } from "../utils/issueTitles.ts";

// @reusable-ui IssueIdLink — USE WHEN: rendering an issue id that appeared in
//   message text. INSTEAD OF a plain code span or a hand-rolled button: it
//   resolves the id to the issue's TITLE and opens the tracker on it.
//
// Why a component rather than a branch inside MDView's `code` renderer: it
// needs a hook (the title arrives asynchronously), and MDView's component map
// is re-created on every render, so a hook called there would be a hook in a
// component whose identity changes — React would tear down its state each time.
//
// The id is what CC writes and the title is what the user reads. Keeping both
// halves visible would double the length of a sentence mentioning three issues,
// so the id moves to the tooltip.
export function IssueIdLink({ id }: { id: string }) {
  const brief = useIssueBrief(id);
  return (
    <button
      type="button"
      className={"md-issue-link" + (brief ? " resolved" : "")}
      onClick={() => openIssueTracker(id)}
      title={brief ? `${brief.id}` : id}
    >
      {/* Until the lookup lands — and for an id that resolves to nothing, e.g.
          a placeholder in a sentence about the format — the text stays exactly
          as written. Never a spinner or an empty box: the id is already
          meaningful to CC, and the sentence has to keep reading. */}
      {brief ? brief.title : id}
    </button>
  );
}
