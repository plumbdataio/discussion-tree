import React from "react";
import { Maximize2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { ThreadItem } from "../../shared/types.ts";
import { MDView } from "./MDView.tsx";
import { renderSystemMessage } from "./SystemMessage.tsx";
import { formatThreadTimestamp } from "../utils/format.ts";

// One rendered .thread-msg row, factored out and memoized so a parent
// re-render (e.g. every textarea keystroke updating draft state) doesn't
// reconcile N message DOM trees. Without this, on long threads typing
// each character forced React to walk every <div className="thread-msg">
// even though MDView itself was already memoized — the wrapper markup
// (Maximize2 button, who/timestamp span) still re-rendered.
function ThreadMessageImpl({
  item,
  onExpand,
}: {
  item: ThreadItem;
  onExpand: (item: ThreadItem) => void;
}) {
  const { t } = useTranslation();

  if (item.source === "system") {
    return (
      <div className="thread-msg from-system">
        {renderSystemMessage(item.text)}
      </div>
    );
  }

  const isUnread = item.source === "cc" && !item.read_at;
  return (
    <div
      className={`thread-msg from-${item.source}${isUnread ? " unread" : ""}`}
      data-unread-id={isUnread ? item.id : undefined}
    >
      <button
        className="msg-expand"
        title={t("item_card.expand_message")}
        onClick={() => onExpand(item)}
      >
        <Maximize2 size={12} strokeWidth={1.75} />
      </button>
      <span className="who">
        {item.source === "user" ? t("item_card.you") : t("item_card.claude")}
        <span className="thread-msg-time" title={item.created_at}>
          {formatThreadTimestamp(item.created_at)}
        </span>
      </span>
      <MDView text={item.text} />
    </div>
  );
}

// Custom comparator: skip re-render unless the message's content,
// read state, or source actually changed. The parent passes a stable
// onExpand (memoized via useCallback in callers), so comparing it by
// reference is safe.
export const ThreadMessage = React.memo(
  ThreadMessageImpl,
  (prev, next) =>
    prev.item.id === next.item.id &&
    prev.item.text === next.item.text &&
    prev.item.read_at === next.item.read_at &&
    prev.item.source === next.item.source &&
    prev.item.created_at === next.item.created_at &&
    prev.onExpand === next.onExpand,
);
