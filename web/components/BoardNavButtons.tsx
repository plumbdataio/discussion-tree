import React, { useEffect, useState } from "react";
import {
  Bell,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
} from "lucide-react";
import { useTranslation } from "react-i18next";

// Bottom-centre navigation cluster for horizontally-scrolling boards. Shown
// only when the board overflows horizontally. Layout (centre outward):
//   ⏮  ◀  [unread]  ▶  ⏭
// where ⏮/⏭ jump to the first/last node overall, ◀/▶ jump to the
// previous/next concern's first node, and the centre bell cycles to the next
// node with unread CC messages. The unread slot is always rendered (disabled
// when nothing is unread) so the chevrons don't shift as unread comes and goes.
//
// It reads the live DOM rather than props: cards carry data-node-id /
// data-concern-id (ItemCard) and `.has-unread`, and `.board-container` is the
// horizontal scroller — querying on click keeps the math correct without
// threading geometry through React.
export function BoardNavButtons({
  boardId,
  dataVersion,
}: {
  boardId: string;
  dataVersion: unknown;
}) {
  const { t } = useTranslation();
  const [overflow, setOverflow] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);

  const getScroller = () =>
    document.querySelector(".board-container") as HTMLElement | null;

  useEffect(() => {
    const recompute = () => {
      const el = getScroller();
      if (!el) {
        setOverflow(false);
        setUnreadCount(0);
        return;
      }
      setOverflow(el.scrollWidth > el.clientWidth + 2);
      setUnreadCount(el.querySelectorAll(".item-card.has-unread").length);
    };
    recompute();
    const el = getScroller();
    const ro =
      el && "ResizeObserver" in window ? new ResizeObserver(recompute) : null;
    ro?.observe(el!);
    el?.addEventListener("scroll", recompute, { passive: true });
    window.addEventListener("resize", recompute);
    return () => {
      ro?.disconnect();
      el?.removeEventListener("scroll", recompute);
      window.removeEventListener("resize", recompute);
    };
  }, [boardId, dataVersion]);

  // Group the cards (DOM order = left→right) by their concern.
  const concernGroups = (el: HTMLElement) => {
    const cards = Array.from(
      el.querySelectorAll("[data-node-id]"),
    ) as HTMLElement[];
    const groups: { concernId: string; cards: HTMLElement[] }[] = [];
    for (const c of cards) {
      const cid = c.getAttribute("data-concern-id") ?? "";
      const last = groups[groups.length - 1];
      if (last && last.concernId === cid) last.cards.push(c);
      else groups.push({ concernId: cid, cards: [c] });
    }
    return groups;
  };

  const scrollToCard = (
    card: HTMLElement | undefined,
    inline: ScrollLogicalPosition,
  ) => {
    card?.scrollIntoView({ behavior: "smooth", inline, block: "nearest" });
  };

  // Index of the concern currently anchored at the viewport's left edge: the
  // rightmost concern whose first card has started scrolling past the left.
  const currentConcernIdx = (
    el: HTMLElement,
    groups: { cards: HTMLElement[] }[],
  ) => {
    const left = el.getBoundingClientRect().left;
    let idx = 0;
    groups.forEach((g, i) => {
      if (g.cards[0].getBoundingClientRect().left <= left + 8) idx = i;
    });
    return idx;
  };

  const go = (which: "first" | "prev" | "next" | "last") => {
    const el = getScroller();
    if (!el) return;
    const groups = concernGroups(el);
    if (!groups.length) return;
    if (which === "first") {
      scrollToCard(groups[0].cards[0], "start");
    } else if (which === "last") {
      const g = groups[groups.length - 1];
      scrollToCard(g.cards[g.cards.length - 1], "end");
    } else {
      const cur = currentConcernIdx(el, groups);
      const target =
        which === "prev"
          ? groups[Math.max(0, cur - 1)]
          : groups[Math.min(groups.length - 1, cur + 1)];
      scrollToCard(target.cards[0], "start");
    }
  };

  const goUnread = () => {
    const el = getScroller();
    if (!el) return;
    const unread = Array.from(
      el.querySelectorAll(".item-card.has-unread"),
    ) as HTMLElement[];
    if (!unread.length) return;
    const left = el.getBoundingClientRect().left;
    // Next unread to the right of the current view; wrap to the first.
    const next =
      unread.find((c) => c.getBoundingClientRect().left > left + 8) ?? unread[0];
    scrollToCard(next, "start");
  };

  if (!overflow) return null;

  return (
    <div className="board-nav" role="navigation">
      <button
        type="button"
        className="board-nav-btn"
        onClick={() => go("first")}
        title={t("board_nav.first")}
        aria-label={t("board_nav.first")}
      >
        <ChevronsLeft size={18} strokeWidth={2} />
      </button>
      <button
        type="button"
        className="board-nav-btn"
        onClick={() => go("prev")}
        title={t("board_nav.prev")}
        aria-label={t("board_nav.prev")}
      >
        <ChevronLeft size={18} strokeWidth={2} />
      </button>
      <button
        type="button"
        className={
          "board-nav-btn board-nav-unread" + (unreadCount ? " has-unread" : "")
        }
        onClick={goUnread}
        disabled={!unreadCount}
        title={t("board_nav.unread")}
        aria-label={t("board_nav.unread")}
      >
        <Bell size={16} strokeWidth={2} />
        {unreadCount > 0 && (
          <span className="board-nav-unread-badge">{unreadCount}</span>
        )}
      </button>
      <button
        type="button"
        className="board-nav-btn"
        onClick={() => go("next")}
        title={t("board_nav.next")}
        aria-label={t("board_nav.next")}
      >
        <ChevronRight size={18} strokeWidth={2} />
      </button>
      <button
        type="button"
        className="board-nav-btn"
        onClick={() => go("last")}
        title={t("board_nav.last")}
        aria-label={t("board_nav.last")}
      >
        <ChevronsRight size={18} strokeWidth={2} />
      </button>
    </div>
  );
}
