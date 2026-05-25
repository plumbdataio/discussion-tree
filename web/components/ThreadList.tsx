import React from "react";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import { useTranslation } from "react-i18next";
import type { ThreadItem } from "../../shared/types.ts";
import { MDView } from "./MDView.tsx";
import { ThreadMessage } from "./ThreadMessage.tsx";

export type ThreadListHandle = VirtuosoHandle;

// Virtuoso-backed thread renderer. Materializes only the messages
// currently near the viewport so a long conversation no longer keeps
// hundreds of <ThreadMessage> trees in the DOM at once — same data,
// dramatically lower DOM node count, which helps iOS Safari keep the
// tab from being evicted under memory pressure.
//
// `scrollRef` is filled with the inner scroller element so existing
// helpers (e.g. ScrollToBottomButton) keep working with no API change.
//
// The optional `tentativeText` is rendered as a "pending" footer row
// — keeping it out of the virtualized item list means the optimistic
// in-flight message always appears at the bottom regardless of how far
// the user has scrolled up.
export const ThreadList = React.forwardRef<
  ThreadListHandle,
  {
    items: ThreadItem[];
    tentativeText?: string | null;
    onExpand: (item: ThreadItem) => void;
    scrollRef?: React.MutableRefObject<HTMLElement | null>;
    className?: string;
  }
>(function ThreadList(
  { items, tentativeText, onExpand, scrollRef, className },
  ref,
) {
  const { t } = useTranslation();

  return (
    <Virtuoso
      ref={ref}
      className={className}
      data={items}
      computeItemKey={(_index, item) => item.id}
      itemContent={(_index, item) => (
        <ThreadMessage item={item} onExpand={onExpand} />
      )}
      followOutput="auto"
      initialTopMostItemIndex={Math.max(items.length - 1, 0)}
      scrollerRef={(el) => {
        if (scrollRef) scrollRef.current = (el as HTMLElement) ?? null;
      }}
      components={{
        Footer: tentativeText
          ? () => (
              <div className="thread-msg from-user pending">
                <span className="who">
                  {t("item_card.you")}{" "}
                  <span className="loading-spinner" />{" "}
                  {t("item_card.sending")}
                </span>
                <MDView text={tentativeText} />
              </div>
            )
          : undefined,
      }}
    />
  );
});
