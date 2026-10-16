import React, { useCallback, useRef, useState } from "react";
import { ScheduledPinned } from "./ScheduledPinned.tsx";
import { confirmBeforeSend } from "../utils/timerConfirm.ts";
import { Maximize2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { Activity, Node, ThreadItem } from "../../shared/types.ts";
import { ActivityBadge } from "./ActivityBadge.tsx";
import { MDView } from "./MDView.tsx";
import { NodeModal } from "./NodeModal.tsx";
import { ScrollToBottomButton } from "./ScrollToBottomButton.tsx";
import { ThreadComposer } from "./ThreadComposer.tsx";
import { ThreadRows } from "./ThreadRows.tsx";
import { getBoardIdFromUrl } from "../utils/url.ts";
import { useMarkReadOnVisible } from "../utils/useMarkReadOnVisible.ts";
import { useAnyPreviewModalOpen } from "../utils/previewModalLock.ts";
import { useSettings } from "../utils/settings.ts";
import { useSnapToBottom } from "../utils/useSnapToBottom.ts";
import { isUnreadThreadItem } from "../utils/threadSource.ts";
import { useDetachOnUnmount } from "../utils/useDetachOnUnmount.ts";

export function ItemCard({
  node,
  childrenByParent,
  threads,
  flashingNodes,
  activity,
  ownerAlive,
  ownerSessionId,
  scheduled,
  ownerConfirmArmed,
  onSubmit,
}: {
  node: Node;
  childrenByParent: Map<string | null, Node[]>;
  threads: Record<string, ThreadItem[]>;
  flashingNodes: Set<string>;
  activity: Activity | null;
  ownerAlive: boolean;
  // Owning broker session_id of the parent board. Forwarded to
  // ThreadMessage so the Anchor toggle can persist against the
  // right session.
  ownerSessionId: string;
  // Pending timer-send messages for the whole board; ItemCard shows the ones
  // targeting THIS node pinned below its thread.
  scheduled?: any[];
  // True when the owning session has an armed pending reservation — gate a live
  // send behind the confirm.
  ownerConfirmArmed?: boolean;
  onSubmit: (nodeId: string, text: string) => Promise<void>;
}) {
  const { t } = useTranslation();
  const boardId = getBoardIdFromUrl() ?? "misc";
  // The draft lives in ThreadComposer, so a keystroke re-renders only the
  // composer — never this card or its thread.
  // Optimistic in-flight message: shown as a faded card with a spinner. Set
  // when the user clicks Send, cleared on success / failure. On failure we
  // also restore the text into the textarea so they can retry without retyping.
  const [tentativeText, setTentativeText] = useState<string | null>(null);
  // When a single message's expand button is clicked we open the WHOLE node
  // (NodeModal) scrolled to that message — richer than a lone message preview.
  const [nodeExpanded, setNodeExpanded] = useState(false);
  const [msgTarget, setMsgTarget] = useState<number | null>(null);
  const myThread = threads[node.id] ?? [];
  const scheduledForNode = (scheduled ?? []).filter(
    (m: any) => m.node_id === node.id,
  );
  const threadRef = useRef<HTMLDivElement>(null);
  const rowsRef = useRef<HTMLDivElement>(null);
  // Empty on unmount so a textarea kept by Chrome's autofill cannot keep
  // this content alive (see useDetachOnUnmount).
  useDetachOnUnmount(rowsRef);
  const cardRef = useRef<HTMLDivElement>(null);
  const flashing = flashingNodes.has(node.id);
  const isActive = !!(activity && activity.node_id === node.id);
  const hasUnread = myThread.some((t) => isUnreadThreadItem(t));
  const [settings] = useSettings();
  const showManualReadButton = !settings.autoReadEnabled && hasUnread;

  // Pause auto-read while a preview modal occludes the board — a node hidden
  // behind a preview shouldn't be silently marked read.
  const previewOpen = useAnyPreviewModalOpen();
  useMarkReadOnVisible(cardRef, myThread, !previewOpen);

  const markNodeRead = () => {
    const ids = myThread
      .filter((t) => isUnreadThreadItem(t))
      .map((t) => t.id);
    if (ids.length === 0) return;
    fetch("/mark-thread-items-read", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ thread_item_ids: ids }),
    }).catch(() => {
      /* network blip — UI stays unread, user can retry */
    });
  };

  // Stable identity so the memoized thread rows skip reconciliation when this
  // card re-renders (sending, activity, a pending timer send, …).
  const openExpandedMsg = useCallback((it: ThreadItem) => {
    setMsgTarget(it.id);
    setNodeExpanded(true);
  }, []);

  // Snap to the bottom on mount and when the user starts their own
  // post. Following new messages / staying put on scroll-up is
  // handled by column-reverse in CSS.
  useSnapToBottom(threadRef, { reversed: true, deps: [tentativeText] });

  // Confirm a live send while this session has an armed pending timer send.
  const confirmSend = () =>
    confirmBeforeSend(
      !!ownerConfirmArmed,
      ownerSessionId,
      scheduled?.length ?? 0,
    );
  const sendToNode = (text: string) => onSubmit(node.id, text);

  return (
    <div
      ref={cardRef}
      data-node-id={node.id}
      data-concern-id={node.parent_id ?? ""}
      className={`item-card status-${node.status}${flashing ? " flashing" : ""}${isActive ? " active" : ""}${hasUnread ? " has-unread" : ""}`}
    >
      <div className="title-row">
        <h3 className="title">{node.title}</h3>
        <span className={`status-badge status-${node.status}`}>
          {t([`node_status.${node.status}`, node.status])}
        </span>
        {showManualReadButton && (
          <button
            className="mark-node-read"
            title={t("item_card.mark_read_node_title")}
            onClick={markNodeRead}
          >
            {t("item_card.mark_read_button")}
          </button>
        )}
        <button
          className="node-expand"
          title={t("item_card.expand_node")}
          onClick={() => setNodeExpanded(true)}
        >
          <Maximize2 size={14} strokeWidth={1.75} />
        </button>
      </div>
      {isActive && activity && <ActivityBadge activity={activity} />}
      {node.context && <MDView className="context" text={node.context} />}

      {/* Always render .thread, even when empty, so its flex:1 fills the
          card and the input row stays anchored to the bottom regardless
          of whether messages exist yet (= matches mobile's behaviour,
          and avoids the per-card jitter where empty threads pulled the
          input up to the title).

          Outer .thread = column-reverse with ONE child (.thread-rows), a
          normal top-to-bottom column holding the rows in natural order
          (oldest → newest → pending timer-send preview → tentative). The
          single child keeps column-reverse's bottom-anchored scrolling, and
          DOM order == visual order so drag selection / copy across messages
          run top-to-bottom. */}
      <div className="thread" ref={threadRef}>
        <div className="thread-rows" ref={rowsRef}>
          {/* Natural order. Deep history is grouped into content-visibility
              chunks (see ThreadRows); most node threads are short enough that
              nothing is chunked. gapPx mirrors the item-card .thread-rows gap. */}
          <ThreadRows
            items={myThread}
            rowsRef={rowsRef}
            gapPx={6}
            boardId={node.board_id}
            nodeId={node.id}
            sessionId={ownerSessionId}
            onExpand={openExpandedMsg}
          />
          {/* In-flow at the visual bottom, co-located with tentativeText: the
              pending timer-send preview scrolls with the thread and is
              bounded by this scroll container, so a tall scheduled message
              no longer squeezes the thread or pushes the input row
              off-screen. */}
          <ScheduledPinned scheduled={scheduledForNode} />
          {tentativeText && (
            <div className="thread-msg from-user pending">
              <span className="who">
                {t("item_card.you")} <span className="loading-spinner" />{" "}
                {t("item_card.sending")}
              </span>
              <MDView text={tentativeText} />
            </div>
          )}
        </div>
      </div>
      <ScrollToBottomButton scrollRef={threadRef} reversed />

      <ThreadComposer
        className="input-row"
        draftBoardId={boardId}
        timerBoardId={node.board_id}
        nodeId={node.id}
        ownerAlive={ownerAlive}
        placeholder={
          ownerAlive
            ? t("item_card.input_placeholder")
            : t("item_card.input_disabled")
        }
        confirmSend={confirmSend}
        onSend={sendToNode}
        onTentative={setTentativeText}
      />

      {nodeExpanded && (
        <NodeModal
          node={node}
          threadItems={myThread}
          ownerAlive={ownerAlive}
          onSubmit={onSubmit}
          scrollToItemId={msgTarget}
          onClose={() => {
            setNodeExpanded(false);
            setMsgTarget(null);
          }}
        />
      )}
    </div>
  );
}
