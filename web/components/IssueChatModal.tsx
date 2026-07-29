import React, { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X, MessageSquare, Send, CornerUpRight } from "lucide-react";
import { useTranslation } from "react-i18next";
import { MDView } from "./MDView.tsx";
import { ResizableTextarea } from "./ResizableTextarea.tsx";
import { useLiveSocket } from "../utils/liveSocket.ts";
import { jumpToAnchor } from "../utils/anchorJump.ts";
import { navigate } from "../utils/router.ts";
import {
  fetchIssueChat,
  submitIssueChat,
  type Issue,
  type IssueChatItem,
  type IssueChatLocation,
  type IssueSession,
} from "../utils/issues.ts";

// TALKING ON AN ISSUE, rather than about it somewhere else.
//
// The tracker could already SHOW an issue's conversation; what was missing was
// somewhere to have one. Every thought about an issue had to be filed onto some
// board first, and picking that board — a decision with no good answer — was
// enough to stop the thought from being written at all.
//
// Layered over the tracker like the timeline is, for the same reason: the point
// is to talk while looking at the issue, so leaving the list is the one thing
// this must not do. (It is also why this is not a board page: navigating away
// changes document.title, which the user's time tracking reads.)
//
// The thread is created by the first message. Until then this is a composer
// with an explanation above it, not an empty room.

function ChatMessage({
  m,
  fmt,
}: {
  m: IssueChatItem;
  fmt: (iso: string) => string;
}) {
  const { t } = useTranslation();
  // status_change rows ride the same table; they say nothing here, where the
  // node's status is not even shown.
  if (m.source === "system") return null;
  return (
    <div className={`issue-chat-msg source-${m.source}`}>
      <div className="issue-chat-msg-head">
        <span className="issue-chat-who">
          {t(`issues.source.${m.source}`, { defaultValue: m.source })}
        </span>
        <span className="issue-chat-at">{fmt(m.created_at)}</span>
      </div>
      <MDView className="issue-chat-body" text={m.text} />
    </div>
  );
}

export function IssueChatModal({
  issue,
  onClose,
  onJump,
}: {
  issue: Issue;
  onClose: () => void;
  onJump: () => void;
}) {
  const { t } = useTranslation();
  const [items, setItems] = useState<IssueChatItem[] | null>(null);
  const [location, setLocation] = useState<IssueChatLocation | null>(null);
  const [session, setSession] = useState<IssueSession | null>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const load = useCallback(
    (markRead: boolean) =>
      fetchIssueChat(issue.id)
        .then((r) => {
          if (!r.ok) {
            setError(r.error ?? t("issues.error_generic"));
            return;
          }
          setItems(r.items);
          setLocation(r.location);
          setSession(r.session);
          if (!markRead) return;
          // Opening the conversation IS reading it — otherwise the unread count
          // on the row would keep pointing at messages already on screen.
          const unread = r.items
            .filter((m) => m.source === "cc" && !m.read_at)
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
  // channel is the board — which does not exist until the first message, so
  // this subscribes only once there is something to listen to.
  const onFrame = useCallback(() => {
    void load(true);
  }, [load]);
  useLiveSocket({
    channel: location ? location.board_id : null,
    onMessage: onFrame,
    onResync: onFrame,
  });

  // Escape closes this layer and leaves the tracker open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      onClose();
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const fmt = (iso: string) =>
    new Date(iso).toLocaleString([], {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });

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

  // Keep the newest message in view as the thread grows.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [items?.length]);

  const visible = (items ?? []).filter((m) => m.source !== "system");

  return createPortal(
    <div className="modal-backdrop issue-chat-backdrop" onClick={onClose}>
      <div
        className="modal-content issue-chat-modal"
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

        <div className="issue-chat-head">
          <h2 className="issue-chat-title">
            <MessageSquare size={16} strokeWidth={2} />
            {issue.title}
          </h2>
          <span className="issue-chat-sub">
            {session
              ? t("issues.chat_with", {
                  who: session.name ?? session.cwd ?? session.id,
                })
              : t("issues.chat_no_session")}
            {/* The thread is a normal board node, so it can be opened in place
                — worth surfacing, because everything else in dt works there and
                a conversation you can only read inside a modal is a dead end. */}
            {location && (
              <button
                type="button"
                className="issue-chat-open-board"
                onClick={() => {
                  onClose();
                  onJump();
                  // Anchoring on the last message is what scrolls the board to
                  // this issue's node; with no message yet there is nothing to
                  // anchor to, so just open the board.
                  const last = visible[visible.length - 1];
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

        <div className="issue-chat-scroll" ref={scrollRef}>
          {items && visible.length === 0 && (
            <div className="issue-chat-empty">{t("issues.chat_empty")}</div>
          )}
          {visible.map((m) => (
            <ChatMessage key={m.id} m={m} fmt={fmt} />
          ))}
        </div>

        <div className="issue-chat-composer">
          <ResizableTextarea
            className="issue-chat-input"
            value={draft}
            placeholder={t("issues.chat_placeholder")}
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
            disabled={!draft.trim() || sending}
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
