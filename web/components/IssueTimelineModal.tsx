import React, { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X, CornerUpRight, MessagesSquare, Send } from "lucide-react";
import { useTranslation } from "react-i18next";
import { MDView } from "./MDView.tsx";
import { ResizableTextarea } from "./ResizableTextarea.tsx";
import { useLiveSocket } from "../utils/liveSocket.ts";
import { jumpToAnchor } from "../utils/anchorJump.ts";
import { navigate } from "../utils/router.ts";
import {
  fetchIssueTimeline,
  submitIssueChat,
  type Issue,
  type IssueChatLocation,
  type IssueSession,
  type IssueTimelineMessage,
} from "../utils/issues.ts";

// ONE ISSUE'S CONVERSATION — read it here, and continue it here.
//
// Links were never collected so a row could be clicked; they were collected so
// one decision's conversation could be read as a single column, no matter which
// board, map or diagram each part of it happened on. This is that column.
//
// The composer at the bottom was added on 2026-07-29, replacing a second modal
// that did only the writing. The user's argument for merging: reading what was
// said and saying the next thing are ONE activity, and two buttons ("talk" /
// "read the conversation") make you decide between them every single time. In
// the merged form the dedicated board is, in their words, a virtual board —
// part of this view rather than a place you have to know about.
//
// What is written here goes to the issue's own thread (created by the first
// message) and comes straight back into this timeline, because posting there
// links to the issue by construction. Messages said ELSEWHERE still need CC to
// attach them — merging the views does not change that, and nothing here should
// imply otherwise.
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
  const [location, setLocation] = useState<IssueChatLocation | null>(null);
  const [session, setSession] = useState<IssueSession | null>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const load = useCallback(
    (markRead: boolean) =>
      fetchIssueTimeline(issue.id)
        .then((r) => {
          if (!r.ok) {
            setError(r.error ?? t("issues.error_generic"));
            return;
          }
          setMessages(r.messages ?? []);
          setLocation(r.location);
          setSession(r.session);
          if (!markRead) return;
          // Reading the conversation IS reading it — but only the part written
          // HERE. Marking messages on other boards read would clear their
          // unread dots without the user having seen them in place.
          const unread = (r.messages ?? [])
            .filter((m) => m.on_issue_thread && m.source === "cc" && !m.read_at)
            .map((m) => m.id);
          if (unread.length === 0) return;
          fetch("/mark-thread-items-read", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ thread_item_ids: unread }),
          }).catch(() => {
            /* network blip — the row stays unread, which is recoverable */
          });
        })
        .catch(() => setError(t("issues.error_generic"))),
    [issue.id, t],
  );

  useEffect(() => {
    void load(true);
  }, [load]);

  // Live, not polled: a reply written by CC has to appear while the user is
  // looking at it, and dt's rule is to be pushed to rather than to ask. The
  // channel is the issue's own board — which does not exist until the first
  // message, so this subscribes only once there is something to listen to.
  const onFrame = useCallback(() => {
    void load(true);
  }, [load]);
  useLiveSocket({
    channel: location ? location.board_id : null,
    onMessage: onFrame,
    onResync: onFrame,
  });

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

  const send = async () => {
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    setError(null);
    try {
      const r = await submitIssueChat(issue.id, text);
      if (!r.ok) {
        // no_recipient / timeout come back from the shared submit path; the
        // draft is deliberately kept so nothing typed is lost.
        setError(
          r.reason === "no_recipient"
            ? t("issues.chat_no_recipient")
            : r.reason === "timeout"
              ? t("issues.chat_timeout")
              : (r.error ?? t("issues.error_generic")),
        );
      } else {
        setDraft("");
      }
      await load(false);
    } catch {
      setError(t("issues.error_generic"));
    } finally {
      setSending(false);
    }
  };

  // Keep the newest message in view as the conversation grows.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages?.length]);

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
            {/* The issue's own thread is an ordinary board node, so it can be
                opened in place — worth surfacing, because everything else in dt
                works there and a conversation readable only inside a modal is a
                dead end. */}
            {location && (
              <button
                type="button"
                className="issue-chat-open-board"
                onClick={() => {
                  onClose();
                  onJump();
                  // Anchoring on the last message here is what scrolls the
                  // board to this issue's node.
                  const last = (messages ?? [])
                    .filter((m) => m.on_issue_thread)
                    .pop();
                  if (last) jumpToAnchor(location.board_id, last.id);
                  else navigate(`/board/${location.board_id}`);
                }}
                title={t("issues.chat_open_board_hint")}
              >
                <CornerUpRight size={12} strokeWidth={2} />
                {t("issues.chat_open_board")}
              </button>
            )}
          </span>
        </div>

        {error && <div className="modal-error">{error}</div>}

        <div className="issue-timeline-scroll" ref={scrollRef}>
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
                  <div
                    className={
                      "issue-timeline-path" + (m.on_issue_thread ? " here" : "")
                    }
                  >
                    {/* Said on this issue's own thread. Named for what it is
                        rather than by its container's path: the container is
                        hidden everywhere else, and printing "Issue
                        conversations > <this issue>" would both re-introduce it
                        and repeat the title already at the top of the modal. */}
                    <span>
                      {m.on_issue_thread ? t("issues.timeline_here") : m.path}
                    </span>
                    {!m.on_issue_thread && (
                      <span className={`issue-timeline-surface ${m.surface}`}>
                        {t(`issues.surface.${m.surface}`)}
                      </span>
                    )}
                  </div>
                )}
                <TimelineMessage m={m} fmt={fmt} onGo={go} />
              </React.Fragment>
            );
          })}
        </div>

        <div className="issue-chat-composer">
          <ResizableTextarea
            className="issue-chat-input"
            value={draft}
            placeholder={
              session
                ? t("issues.chat_placeholder_to", {
                    who: session.name ?? session.cwd ?? session.id,
                  })
                : t("issues.chat_no_session")
            }
            disabled={!session}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              // Same chord as every other composer in dt.
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                void send();
              }
            }}
          />
          <button
            type="button"
            className="issue-chat-send"
            disabled={!draft.trim() || sending || !session}
            onClick={() => void send()}
          >
            <Send size={14} strokeWidth={2} />
            {sending ? t("issues.chat_sending") : t("issues.chat_send")}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
