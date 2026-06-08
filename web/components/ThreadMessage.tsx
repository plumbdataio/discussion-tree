import React from "react";
import { Leaf, Maximize2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { ThreadItem } from "../../shared/types.ts";
import { MDView } from "./MDView.tsx";
import { renderSystemMessage } from "./SystemMessage.tsx";
import { showToast } from "./Toast.tsx";
import { formatThreadTimestamp } from "../utils/format.ts";
import { toggleFavorite, useFavorited } from "../utils/favorites.ts";

// One rendered .thread-msg row, factored out and memoized so a parent
// re-render (e.g. every textarea keystroke updating draft state) doesn't
// reconcile N message DOM trees. Without this, on long threads typing
// each character forced React to walk every <div className="thread-msg">
// even though MDView itself was already memoized — the wrapper markup
// (Maximize2 button, who/timestamp span) still re-rendered.
//
// boardId / nodeId / sessionId are required when anchor (= "favorite")
// toggling is enabled. The BoardStructureRequestModal renders log-node
// threads where pinning makes no sense — it passes `enableAnchor={false}`
// instead of plumbing a fake session_id.
function ThreadMessageImpl({
  item,
  boardId,
  nodeId,
  sessionId,
  enableAnchor = true,
  compact = false,
  onExpand,
}: {
  item: ThreadItem;
  boardId?: string;
  nodeId?: string;
  sessionId?: string;
  enableAnchor?: boolean;
  // Map node cards are tight on space: hide the timestamp + expand button +
  // anchor so the bubble is just who-label + markdown body (per the map v1
  // "no bookmark / no timestamp / no status" requirement). Defaults off, so
  // every existing board call site is unchanged.
  compact?: boolean;
  onExpand: (item: ThreadItem) => void;
}) {
  const { t } = useTranslation();
  // Hook order: must run on every render, including the system-message
  // early-return branch. Subscribing on system rows is harmless — they
  // can't be pinned and the comparator skips re-renders anyway.
  const isPinned = useFavorited(item.id);

  if (item.source === "system") {
    return (
      <div className="thread-msg from-system">
        {renderSystemMessage(item.text)}
      </div>
    );
  }

  const isUnread = item.source === "cc" && !item.read_at;
  const showAnchor = !compact && enableAnchor && boardId && nodeId && sessionId;

  const handleAnchor = async () => {
    if (!showAnchor) return;
    try {
      const { added } = await toggleFavorite({
        sessionId: sessionId!,
        boardId: boardId!,
        nodeId: nodeId!,
        threadItemId: item.id,
      });
      showToast(added ? t("anchor.added") : t("anchor.removed"));
    } catch (e) {
      showToast(t("anchor.failed"), "error");
    }
  };

  return (
    <div
      className={`thread-msg from-${item.source}${isUnread ? " unread" : ""}${isPinned ? " is-pinned" : ""}`}
      data-unread-id={isUnread ? item.id : undefined}
      data-thread-item-id={item.id}
    >
      {showAnchor && (
        <button
          className={`msg-anchor${isPinned ? " is-on" : ""}`}
          title={isPinned ? t("anchor.remove_title") : t("anchor.add_title")}
          aria-pressed={isPinned}
          onClick={handleAnchor}
        >
          <Leaf size={18} strokeWidth={isPinned ? 2.5 : 1.75} />
        </button>
      )}
      {!compact && (
        <button
          className="msg-expand"
          title={t("item_card.expand_message")}
          onClick={() => onExpand(item)}
        >
          <Maximize2 size={12} strokeWidth={1.75} />
        </button>
      )}
      <span className="who">
        {item.source === "user" ? t("item_card.you") : t("item_card.claude")}
        {!compact && (
          <span className="thread-msg-time" title={item.created_at}>
            {formatThreadTimestamp(item.created_at)}
          </span>
        )}
      </span>
      <MDView text={item.text} />
    </div>
  );
}

// Custom comparator: skip re-render unless the message's content,
// read state, source, or anchor-context props actually changed. The
// parent passes a stable onExpand (memoized via useCallback in
// callers), so comparing it by reference is safe.
//
// We intentionally don't include the pinned bool in the comparator —
// useFavorited subscribes to the store directly so a pin/unpin
// triggers React's normal hook re-render without needing the parent
// to feed a new prop.
export const ThreadMessage = React.memo(
  ThreadMessageImpl,
  (prev, next) =>
    prev.item.id === next.item.id &&
    prev.item.text === next.item.text &&
    prev.item.read_at === next.item.read_at &&
    prev.item.source === next.item.source &&
    prev.item.created_at === next.item.created_at &&
    prev.boardId === next.boardId &&
    prev.nodeId === next.nodeId &&
    prev.sessionId === next.sessionId &&
    prev.enableAnchor === next.enableAnchor &&
    prev.compact === next.compact &&
    prev.onExpand === next.onExpand,
);
