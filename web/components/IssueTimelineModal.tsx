import React, { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { X, CornerUpRight, MessagesSquare } from "lucide-react";
import { useTranslation } from "react-i18next";
import { MDView } from "./MDView.tsx";
import { jumpToAnchor } from "../utils/anchorJump.ts";
import { navigate } from "../utils/router.ts";
import {
  fetchIssueTimeline,
  type Issue,
  type IssueTimelineMessage,
} from "../utils/issues.ts";

// WHY THIS EXISTS. Links were never collected so a row could be clicked — they
// were collected so one decision's conversation could be read as a single
// column, no matter which board, map or diagram each part of it happened on.
// This is that column; everything else about the link machinery is upstream of
// it.
//
// Rendered over the tracker rather than replacing it: the list stays visible
// behind, so "back to the ledger" is Escape and not a navigation.
//
// Every row must be able to reach the place it was said. The user's own
// messages are not guaranteed to be linked (only CC's posts carry issue_ids by
// construction), so the accepted design is: land on CC's message and read the
// surrounding exchange in place. A timeline you cannot leave would make that
// impossible, which is why the jump is not optional.

function surfacePath(m: IssueTimelineMessage): string | null {
  switch (m.surface) {
    case "board":
      return `/board/${m.container_id}`;
    case "map":
      return `/map/${m.container_id}`;
    case "diagram":
      return `/diagram/${m.container_id}`;
    default:
      // A container that no longer exists. Better to show the message with no
      // way back than to hide it: the text is still the record.
      return null;
  }
}

// One entry, shown in full.
//
// An earlier cut clamped long messages to ~9 lines with a "show all" toggle,
// on the reasoning that 19 of 25 messages were long enough to fill the viewport
// alone. The user rejected it outright: expanding them one by one to read a
// conversation is worse than scrolling past them, and a "expand everything"
// button would just be the same chore behind one more click. Reading is what
// this view is for — so it reads.
function TimelineMessage({
  m,
  fmt,
  onGo,
}: {
  m: IssueTimelineMessage;
  fmt: (iso: string) => string;
  onGo: (m: IssueTimelineMessage) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className={`issue-timeline-msg source-${m.source}`}>
      <div className="issue-timeline-msg-head">
        <span className="issue-timeline-who">
          {t(`issues.source.${m.source}`, { defaultValue: m.source })}
        </span>
        <span className="issue-timeline-at">{fmt(m.at)}</span>
        {surfacePath(m) && (
          <button
            type="button"
            className="issue-timeline-jump"
            onClick={() => onGo(m)}
            title={t("issues.timeline_jump_hint")}
          >
            <CornerUpRight size={12} strokeWidth={2} />
            {t("issues.timeline_jump")}
          </button>
        )}
      </div>
      <MDView className="issue-timeline-body" text={m.text} />
    </div>
  );
}

export function IssueTimelineModal({
  issue,
  onClose,
  onJump,
}: {
  issue: Issue;
  onClose: () => void;
  onJump: () => void;
}) {
  const { t } = useTranslation();
  const [messages, setMessages] = useState<IssueTimelineMessage[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    fetchIssueTimeline(issue.id)
      .then((r) => {
        if (!live) return;
        if (!r.ok) setError(r.error ?? t("issues.error_generic"));
        else setMessages(r.messages ?? []);
      })
      .catch(() => live && setError(t("issues.error_generic")));
    return () => {
      live = false;
    };
  }, [issue.id, t]);

  // Capture Escape so it closes the timeline and leaves the tracker open,
  // rather than both at once.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      onClose();
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const go = (m: IssueTimelineMessage) => {
    const path = surfacePath(m);
    if (!path) return;
    // Close both layers first: the destination is behind them, and a modal
    // still covering it would make the jump look like it did nothing.
    onClose();
    onJump();
    if (m.surface === "board") {
      // Boards can scroll to the exact message and flash it.
      jumpToAnchor(m.container_id, m.id);
    } else {
      navigate(path);
    }
  };

  const fmt = (iso: string) =>
    new Date(iso).toLocaleString([], {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });

  return createPortal(
    <div className="modal-backdrop issue-timeline-backdrop" onClick={onClose}>
      <div
        className="modal-content issue-timeline-modal"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          className="modal-close"
          onClick={onClose}
          aria-label={t("modal.close")}
          title={t("modal.close")}
        >
          <X size={18} strokeWidth={1.75} />
        </button>

        <div className="issue-timeline-head">
          <h2 className="issue-timeline-title">
            <MessagesSquare size={16} strokeWidth={2} />
            {issue.title}
          </h2>
          <span className="issue-timeline-sub">
            {messages
              ? t("issues.timeline_count", { n: messages.length })
              : t("sidebar.loading")}
          </span>
        </div>

        {error && <div className="modal-error">{error}</div>}

        <div className="issue-timeline-scroll">
          {messages && messages.length === 0 && (
            <div className="issue-empty">{t("issues.timeline_empty")}</div>
          )}
          {messages?.map((m, idx) => {
            // The path is the reader's orientation, so repeat it only when the
            // conversation actually moves — a column that says the same board
            // on every row stops being read.
            const showPath = idx === 0 || messages[idx - 1].path !== m.path;
            return (
              <React.Fragment key={m.id}>
                {showPath && (
                  <div className="issue-timeline-path">
                    <span>{m.path}</span>
                    <span className={`issue-timeline-surface ${m.surface}`}>
                      {t(`issues.surface.${m.surface}`)}
                    </span>
                  </div>
                )}
                <TimelineMessage m={m} fmt={fmt} onGo={go} />
              </React.Fragment>
            );
          })}
        </div>
      </div>
    </div>,
    document.body,
  );
}
