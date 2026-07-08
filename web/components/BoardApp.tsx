import React, { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, Cog, ScrollText, Shrink, Wand2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { Activity, BoardView } from "../../shared/types.ts";
import { ActivityBadge } from "./ActivityBadge.tsx";
import { AppLayout } from "./AppShell.tsx";
import { BoardStructureRequestModal } from "./BoardStructureRequestModal.tsx";
import { CliCommandButton } from "./CliCommandButton.tsx";
import { ContextMeter } from "./ContextMeter.tsx";
import { ConcernColumn } from "./ConcernColumn.tsx";
import { DefaultBoardLayout } from "./DefaultBoardLayout.tsx";
import {
  applyFavoriteAdded,
  applyFavoriteRemoved,
  loadFavoritesForSession,
} from "../utils/favorites.ts";
import {
  consumePendingJump,
  jumpToAnchor,
  subscribePendingJump,
} from "../utils/anchorJump.ts";
import { NodeStatusFilterButton } from "./NodeStatusFilterButton.tsx";
import { TimelineModal } from "./TimelineModal.tsx";
import { buildTimelineEntries } from "../utils/timeline.ts";
import { BoardSettingsPanel } from "./BoardSettingsPanel.tsx";
import { BoardNavButtons } from "./BoardNavButtons.tsx";
import {
  isNodeVisible,
  isNodeVisibleWithUnread,
  useNodeStatusFilter,
  useNodeUnreadOverride,
} from "../utils/nodeStatusFilter.ts";
import { postSubmitAnswer } from "../utils/api.ts";
import { readBoardCache, writeBoardCache } from "../utils/boardCache.ts";
import { translateError } from "../utils/errors.ts";
import { buildTree } from "../utils/tree.ts";
import { useDocumentTitle } from "../utils/useDocumentTitle.ts";

// boardId is passed as a prop (not read from the URL internally) so this
// component does NOT need a `key` to re-mount on navigation. All data
// effects below depend on boardId, so they re-run on a prop change while
// the component instance — and the Sidebar / header it renders — stays
// mounted. Re-mounting was what caused the full-page white flash on board
// switches.
export function BoardApp({ boardId }: { boardId: string | null }) {
  const { t } = useTranslation();
  const [data, setData] = useState<BoardView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [wsConnected, setWsConnected] = useState(false);
  const [flashingNodes, setFlashingNodes] = useState<Set<string>>(new Set());
  const [activitiesBySession, setActivitiesBySession] = useState<
    Record<string, Activity | null>
  >({});
  const [structureRequestOpen, setStructureRequestOpen] = useState(false);
  const [timelineOpen, setTimelineOpen] = useState(false);
  // Tracks whether the (mobile) horizontally-scrolling header has content
  // hidden to either side. Drives the faint left/right arrow affordances
  // injected via CSS `::before` / `::after`. Re-evaluated on scroll, on
  // header resize, and on every data fetch (chip set can change).
  const [headerCanLeft, setHeaderCanLeft] = useState(false);
  const [headerCanRight, setHeaderCanRight] = useState(false);
  const headerRef = useRef<HTMLElement | null>(null);
  // Bumped by Page Lifecycle "resume" events so the WS effect below
  // re-runs (re-establishes a fresh socket) after the browser unfreezes
  // the tab — the previous socket would have been closed by the
  // freeze handler.
  const [wsEpoch, setWsEpoch] = useState(0);
  // Per-status node filter — read here so the hook order is stable
  // across the early-return branches below. The downstream filtering
  // happens after `data` is known to be present. Keyed by boardId so
  // each board keeps its own filter (boardId is the URL board id, the
  // same value the BoardSettingsPanel filter below is keyed on).
  const [nodeStatusFilter] = useNodeStatusFilter(boardId ?? "");
  // "Show unread even if the status filter would hide it" toggle + a STICKY set
  // of the nodes that toggle has revealed. Once a filtered-out node is shown for
  // having unread, it stays shown even after the unread clears — otherwise
  // reading it would make it vanish out from under the user mid-view. The set is
  // reset only on board change or when the toggle flips (not on every read-clear)
  // so the visible list is stable while the user is looking at it.
  const [unreadOverride] = useNodeUnreadOverride(boardId ?? "");
  const unreadStickyRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    unreadStickyRef.current = new Set();
  }, [boardId, unreadOverride]);
  useEffect(() => {
    if (!unreadOverride || !data) return;
    const sticky = unreadStickyRef.current;
    for (const n of data.nodes) {
      if (n.kind !== "item") continue;
      if (isNodeVisible(n.status, nodeStatusFilter)) continue;
      const hasUnread = (data.threads[n.id] ?? []).some(
        (it) => it.source === "cc" && !it.read_at,
      );
      if (hasUnread) sticky.add(n.id);
    }
  }, [data, unreadOverride, nodeStatusFilter]);

  const fetchBoard = useCallback(async () => {
    if (!boardId) return;
    try {
      const res = await fetch(`/api/board/${boardId}`);
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        setError(translateError(t, j, `HTTP ${res.status}`));
        return;
      }
      const view = (await res.json()) as BoardView;
      setData(view);
      // Persist for next cold start (iOS tab eviction / hard reload).
      writeBoardCache(boardId, view).catch(() => {
        /* best effort */
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [boardId, t]);

  useEffect(() => {
    if (!boardId) {
      setError(t("errors.not_found"));
      return;
    }
    // Stale-while-revalidate: render the cached snapshot immediately so
    // a reloaded tab has something on screen before the network round-
    // trip completes, then overwrite once the fresh fetch lands.
    let cancelled = false;
    readBoardCache(boardId).then((cached) => {
      if (cancelled || !cached) return;
      setData((prev) => prev ?? cached);
    });
    fetchBoard();
    return () => {
      cancelled = true;
    };
  }, [boardId, fetchBoard, t]);

  // Load the anchor (favorites) set for the board owner the moment we
  // know who owns it. The ThreadMessage rows subscribe to the store so
  // any cached pins show up the instant they render.
  useEffect(() => {
    const sid = data?.board?.session_id;
    if (!sid) return;
    loadFavoritesForSession(sid, true);
  }, [data?.board?.session_id]);

  // Timers for the jump node-flash (see the pulse in the consume effect
  // below). Held in a ref so a board switch / unmount clears them without
  // leaking a setState into a torn-down tree — same discipline as the WS
  // incoming-message flash above.
  const jumpFlashTimers = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());
  useEffect(() => {
    const timers = jumpFlashTimers.current;
    return () => {
      for (const h of timers) clearTimeout(h);
      timers.clear();
    };
  }, []);

  // Port of the map's timeline focus-flash: after a jump lands on a message,
  // pulse the FRAME of the node that holds it so the user can see which card
  // it lives in. Reuses the board's existing `.item-card.flashing` pulse (the
  // same glow a new CC message triggers). Used for BOTH the timeline modal and
  // the anchor (bookmark) list, since both funnel through the consume effect.
  const flashNode = useCallback((nodeId: string) => {
    setFlashingNodes((prev) => {
      const next = new Set(prev);
      next.add(nodeId);
      return next;
    });
    const handle = setTimeout(() => {
      jumpFlashTimers.current.delete(handle);
      setFlashingNodes((prev) => {
        const next = new Set(prev);
        next.delete(nodeId);
        return next;
      });
    }, 1600);
    jumpFlashTimers.current.add(handle);
  }, []);

  // Consume any pending anchor jump targeting this board: scroll the matching
  // thread item into view, pulse-highlight the message, and flash the frame of
  // the node it belongs to. Runs whenever the board's data changes (= initial
  // load, hot board switch) and whenever the jump channel notifies (= same-board
  // click in the timeline / bookmark modal).
  useEffect(() => {
    if (!boardId || !data) return;
    const tryConsume = () => {
      const tid = consumePendingJump(boardId);
      if (tid == null) return;
      // Two rAFs so the layout has had a chance to settle: data →
      // render → paint → measure.
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          const el = document.querySelector(
            `[data-thread-item-id="${tid}"]`,
          ) as HTMLElement | null;
          if (!el) return;
          // Instant jump (no smooth animation) — a long thread made the smooth
          // scroll take ~1s and feel like waiting. The highlight still marks it.
          el.scrollIntoView({ behavior: "instant", block: "center" });
          el.classList.add("highlight-jump");
          setTimeout(() => {
            el.classList.remove("highlight-jump");
          }, 2000);
          // Flash the enclosing node card too (concern boards only — the
          // default board's single thread has no per-node card to frame).
          const card = el.closest("[data-node-id]") as HTMLElement | null;
          const nodeId = card?.getAttribute("data-node-id");
          if (nodeId) flashNode(nodeId);
        });
      });
    };
    tryConsume();
    return subscribePendingJump(tryConsume);
  }, [boardId, data, flashNode]);

  // Initial board position: when a CONCERN board first opens, bring the most
  // relevant node into horizontal view — the node holding the OLDEST unread CC
  // message if anything is unread (the first thing to read), otherwise the node
  // holding the LATEST message. Fires ONCE per board open (a ref guards against
  // WS data updates re-yanking the view) and never for the default board or the
  // structure-change log node. It positions the COLUMN only — deliberately not
  // the thread inside the card, since a hidden mid-thread scroll reads as "why
  // isn't this at the bottom?".
  const initialPositionedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!boardId || !data) return;
    if (data.board.id !== boardId) return; // wait for THIS board's data
    if (initialPositionedRef.current === boardId) return; // once per open
    initialPositionedRef.current = boardId;
    if (data.board.is_default) return; // default board keeps its own behavior

    // The structure-change log node(s) are not a discussion topic — exclude.
    const logNodeIds = new Set(
      data.nodes.filter((n) => n.is_log === 1).map((n) => n.id),
    );
    // Only consider nodes whose card is actually rendered — that respects the
    // status filter (filtered-out nodes have no card), so we never target a node
    // the user can't see and then silently no-op. (Effects run after commit, so
    // the cards for THIS data are already in the DOM here.)
    const renderedNodeIds = new Set(
      Array.from(
        document.querySelectorAll(".board-container .item-card[data-node-id]"),
      ).map((el) => el.getAttribute("data-node-id")),
    );
    // created_at is an ISO string, so lexicographic compare = chronological.
    let oldestUnread: { nodeId: string; at: string } | null = null;
    let latest: { nodeId: string; at: string } | null = null;
    for (const [nodeId, items] of Object.entries(data.threads)) {
      if (logNodeIds.has(nodeId) || !renderedNodeIds.has(nodeId)) continue;
      for (const it of items) {
        if (!latest || it.created_at > latest.at) {
          latest = { nodeId, at: it.created_at };
        }
        if (it.source === "cc" && !it.read_at) {
          if (!oldestUnread || it.created_at < oldestUnread.at) {
            oldestUnread = { nodeId, at: it.created_at };
          }
        }
      }
    }
    const targetNodeId = (oldestUnread ?? latest)?.nodeId;
    if (!targetNodeId) return;

    // Center the target column horizontally, no vertical move, no animation.
    // (Center, not left edge: the eye lands at the viewport centre on a jump, so
    // a left-edge target forces a gaze shift, and centring also keeps the
    // neighbouring columns visible so the node's relation to them reads.)
    // A heavy board keeps reflowing after first paint (late markdown / image
    // loads in earlier columns shift the target), so re-assert each frame until
    // the position stops moving or ~800ms passes — and bail the instant the user
    // scrolls so we never fight them for the viewport.
    const sel = `.item-card[data-node-id="${CSS.escape(targetNodeId)}"]`;
    let aborted = false;
    const stop = () => {
      aborted = true;
    };
    const scroller = document.querySelector(".board-container");
    scroller?.addEventListener("wheel", stop, { passive: true });
    scroller?.addEventListener("touchstart", stop, { passive: true });
    window.addEventListener("keydown", stop);
    const cleanup = () => {
      scroller?.removeEventListener("wheel", stop);
      scroller?.removeEventListener("touchstart", stop);
      window.removeEventListener("keydown", stop);
    };
    const startedAt = performance.now();
    let lastLeft = NaN;
    let stableFrames = 0;
    let rafId = 0;
    const settle = () => {
      if (aborted) return cleanup();
      const card = document.querySelector(sel) as HTMLElement | null;
      if (!card || !document.querySelector(".board-container")) return cleanup();
      card.scrollIntoView({
        behavior: "instant",
        inline: "center",
        block: "nearest",
      });
      const left = card.getBoundingClientRect().left;
      stableFrames = Math.abs(left - lastLeft) < 1 ? stableFrames + 1 : 0;
      lastLeft = left;
      if (stableFrames < 2 && performance.now() - startedAt < 800) {
        rafId = requestAnimationFrame(settle);
      } else {
        cleanup();
      }
    };
    rafId = requestAnimationFrame(() => {
      rafId = requestAnimationFrame(settle);
    });
    // Deterministic teardown: React runs this on unmount, board switch, AND a
    // same-board data refresh (the `data` dep). The first two are the point —
    // kill the rAF chain + drop listeners so a stale board's loop can't run
    // against the next board and the window keydown listener can't leak. A
    // same-board refresh mid-settle also stops the loop early; that's fine — the
    // target is already placed and the next invocation short-circuits at the ref
    // guard (no re-position, no duplicate loop).
    return () => {
      aborted = true;
      cancelAnimationFrame(rafId);
      cleanup();
    };
  }, [boardId, data]);

  // Browser-tab breadcrumb title so external trackers (Clockify auto-tracker,
  // tab strip, history) get something more useful than the bare app name.
  // Shared hook — same format on every page.
  useDocumentTitle([
    data?.owner_session_name,
    data
      ? data.board.is_default
        ? t("default_board.title")
        : data.board.title
      : undefined,
  ]);

  useEffect(() => {
    if (!boardId) return;
    const proto = window.location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${window.location.host}/ws/${boardId}`);
    ws.addEventListener("open", () => setWsConnected(true));
    ws.addEventListener("close", () => setWsConnected(false));
    // Track in-flight flash timers so unmount / board switch clears them
    // and we don't leak setState calls into a torn-down tree.
    const flashTimers = new Set<ReturnType<typeof setTimeout>>();
    // Page Lifecycle: close the socket cleanly when the browser is about
    // to freeze the tab. A frozen tab can't send WS frames anyway, and
    // a still-open socket can mislead the OS into thinking we're active.
    const onFreeze = () => {
      try {
        ws.close();
      } catch {
        /* ignore — close may race with native teardown */
      }
    };
    document.addEventListener("freeze", onFreeze as any);
    ws.addEventListener("message", (e) => {
      let msg: any = null;
      try {
        msg = JSON.parse(e.data);
      } catch {
        /* ignore parse errors */
      }
      if (msg) {
        if (
          msg.type === "thread-update" &&
          msg.source === "cc" &&
          typeof msg.node_id === "string"
        ) {
          const id: string = msg.node_id;
          setFlashingNodes((prev) => {
            const next = new Set(prev);
            next.add(id);
            return next;
          });
          const handle = setTimeout(() => {
            flashTimers.delete(handle);
            setFlashingNodes((prev) => {
              const next = new Set(prev);
              next.delete(id);
              return next;
            });
          }, 1500);
          flashTimers.add(handle);
        } else if (msg.type === "activity") {
          const sid: string = msg.session_id;
          setActivitiesBySession((prev) => ({
            ...prev,
            [sid]: msg.activity ?? null,
          }));
          // NOTE: the sidebar's pd-activity-update is dispatched SOLELY by
          // GlobalBanner now (its always-on socket covers every page). Forwarding
          // here too would mean two independent sockets feeding the same event —
          // ordering is only guaranteed within one socket, so a quick
          // working→clear could land out of order and strand the spinner.
          return; // activity events don't affect board data
        } else if (msg.type === "sidebar-refresh") {
          // Sidebar polls /api/sessions on its own schedule; nudge it to
          // refetch immediately when unread counts shift.
          window.dispatchEvent(new Event("pd-sidebar-refresh"));
          return;
        } else if (msg.type === "session-stall-update") {
          // A session stalled on an API error (StopFailure) or recovered.
          // Refresh the sidebar (per-session warning icon) and the board
          // (header owner_stalled chip). Rare event, so a full refetch is fine.
          window.dispatchEvent(new Event("pd-sidebar-refresh"));
          fetchBoard();
          return;
        } else if (msg.type === "session-compacting-update") {
          // A session started or finished compacting its context. Same shape as
          // the stall update — refresh the sidebar (per-session badge) and the
          // board (header owner_compacting chip).
          window.dispatchEvent(new Event("pd-sidebar-refresh"));
          fetchBoard();
          return;
        } else if (msg.type === "bg-tasks-update") {
          // BG marker rides on the same sidebar-poll pipe — nudge the
          // sidebar to refetch /api/sessions (carries bg_task_count).
          window.dispatchEvent(new Event("pd-sidebar-refresh"));
          // The board header ALSO shows owner_bg_task_count, so refetch
          // the board too — otherwise clearing the counter (or any
          // change) leaves the header chip stale until a manual reload.
          // bg-tasks-update is infrequent, so a full board refetch is
          // cheap enough.
          fetchBoard();
          return;
        } else if (msg.type === "schedule-marker-update") {
          // A scheduled-send marker was set or cleared — it rides on the
          // sidebar's /api/sessions payload (scheduled_send_at), so just
          // nudge the sidebar to refetch. No board-level data depends on it.
          window.dispatchEvent(new Event("pd-sidebar-refresh"));
          return;
        } else if (msg.type === "favorite-added" && msg.favorite) {
          // Update the local anchor store; don't trigger a board re-fetch.
          applyFavoriteAdded(msg.favorite);
          return;
        } else if (
          msg.type === "favorite-removed" &&
          typeof msg.thread_item_id === "number"
        ) {
          applyFavoriteRemoved(msg.thread_item_id);
          return;
        }
      }
      fetchBoard();
    });
    return () => {
      document.removeEventListener("freeze", onFreeze as any);
      ws.close();
      for (const h of flashTimers) clearTimeout(h);
      flashTimers.clear();
    };
  }, [boardId, fetchBoard, wsEpoch]);

  // Page Lifecycle: the browser unfreezes the tab. Re-fetch the board so
  // we catch up on any state that moved while we slept, and bump
  // wsEpoch so the WS effect above tears down + re-establishes the
  // socket (the freeze handler closed it).
  useEffect(() => {
    const onResume = () => {
      fetchBoard();
      setWsEpoch((n) => n + 1);
    };
    document.addEventListener("resume", onResume as any);
    return () => document.removeEventListener("resume", onResume as any);
  }, [fetchBoard]);

  // Watch the header for "is there content out of view?" so the CSS-level
  // arrow affordances only show when there's actually somewhere to flick.
  // Reruns when the board data changes — chips (activity / context-meter /
  // structure-request button) come and go with the data.
  useEffect(() => {
    const el = headerRef.current;
    if (!el) return;
    const check = () => {
      const left = el.scrollLeft > 1;
      const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
      setHeaderCanLeft((prev) => (prev === left ? prev : left));
      setHeaderCanRight((prev) => (prev === right ? prev : right));
    };
    check();
    el.addEventListener("scroll", check, { passive: true });
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => {
      el.removeEventListener("scroll", check);
      ro.disconnect();
    };
  }, [data]);

  const handleSubmit = useCallback(
    async (nodeId: string, text: string) => {
      if (!boardId) throw new Error("no board");
      const res = await postSubmitAnswer(boardId, nodeId, text);
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        // Translate broker-side i18n error codes via t() so the user sees the
        // failure reason in their preferred language.
        throw new Error(translateError(t, j, `HTTP ${res.status}`));
      }
      // Optimistic refresh; WS will also nudge us.
      fetchBoard();
    },
    [boardId, fetchBoard, t]
  );

  if (error) {
    return (
      <AppLayout
        header={
          <header className="header">
            <span className="breadcrumb">{t("header.back_to_session")}</span>
          </header>
        }
      >
        <div className="error">{error}</div>
      </AppLayout>
    );
  }
  if (!data) {
    // Render the same header shell as the loaded board — only the main pane
    // shows "loading" — so a navigation doesn't blank it. (The sidebar itself
    // is persistent in AppShell and never reloads on navigation.)
    return (
      <AppLayout
        header={
          <header className="header">
            <span className="breadcrumb">{t("header.back_to_session")}</span>
            <h1>{t("sidebar.loading")}</h1>
          </header>
        }
      >
        <div className="map-missing">{t("sidebar.loading")}</div>
      </AppLayout>
    );
  }

  const childrenByParent = buildTree(data.nodes);
  // Hide the per-board structure-change log concern from the main
  // concerns row — its content lives inside the
  // BoardStructureRequestModal instead, so it shouldn't add noise to
  // the user's actual discussion topics.
  const concerns = (childrenByParent.get(null) ?? []).filter(
    (c) => c.is_log !== 1,
  );

  // Per-status node filter (header dropdown). Walk the children map
  // and drop items whose status the user has unchecked. Concerns are
  // never filtered out individually — the rule is "hide a concern only
  // when every item under it has been filtered away" so an empty
  // concern with no items at all stays visible.
  //
  // (nodeStatusFilter hook was hoisted to the top of the component
  // alongside the other hooks; reading it here is a plain object
  // access.)
  const filteredChildrenByParent = (() => {
    const next = new Map<string | null, typeof concerns>();
    for (const [parent, kids] of childrenByParent) {
      next.set(
        parent,
        kids.filter((n) => {
          if (n.kind !== "item") return true;
          const hasUnread = (data.threads[n.id] ?? []).some(
            (it) => it.source === "cc" && !it.read_at,
          );
          return isNodeVisibleWithUnread(
            n.status,
            nodeStatusFilter,
            unreadOverride,
            hasUnread,
            unreadStickyRef.current.has(n.id),
          );
        }),
      );
    }
    return next;
  })();
  const visibleConcerns = concerns.filter((c) => {
    const kids = childrenByParent.get(c.id) ?? [];
    if (kids.length === 0) return true; // empty concern: keep visible
    return (filteredChildrenByParent.get(c.id) ?? []).length > 0;
  });
  // Count unread Claude responses in the structure-change log so the
  // modal trigger can advertise that there's something new to read.
  const logItem = data.nodes.find(
    (n) => n.is_log === 1 && n.kind === "item",
  );
  const logUnreadCount = logItem
    ? (data.threads[logItem.id] ?? []).filter(
        (it) => it.source === "cc" && !it.read_at,
      ).length
    : 0;
  const ownerAlive = data.owner_alive !== false; // default to true if undefined (legacy)

  // Pick the activity belonging to this board's owning session, falling back to
  // the board view's initial value if the WS hasn't delivered one yet.
  const ownerSessionId = data.board.session_id;
  const sessionActivity = activitiesBySession[ownerSessionId];
  const activeActivity: Activity | null =
    sessionActivity !== undefined ? sessionActivity : data.activity ?? null;
  const isRelevant =
    !!activeActivity &&
    (!activeActivity.board_id || activeActivity.board_id === data.board.id);
  const headerActivity =
    isRelevant && !activeActivity!.node_id ? activeActivity : null;
  const nodeActivity =
    isRelevant && activeActivity!.node_id ? activeActivity : null;

  return (
    <AppLayout
      header={
        <header
          ref={headerRef}
          className={
            "header" +
            (headerCanLeft ? " can-scroll-left" : "") +
            (headerCanRight ? " can-scroll-right" : "")
          }
        >
        <a
          className="breadcrumb"
          href={"/session/" + data.board.session_id}
        >
          {t("header.back_to_session")}
        </a>
        <h1>
          {data.board.is_default ? t("default_board.title") : data.board.title}
        </h1>
        {Boolean(data.board.closed) && (
          <span className="closed-badge" title={t("header.board_meta_closed")}>
            {t("header.board_meta_closed")}
          </span>
        )}
        <ContextMeter usage={data.owner_context_usage} prefix="Context: " />
        {!ownerAlive && (
          <span
            className="owner-warning"
            title={t("header.owner_warning_title")}
          >
            {t("header.owner_warning")}
          </span>
        )}
        {data.owner_stalled && (
          <span
            className="header-stall-warning"
            title={t("header.stalled_title")}
          >
            <AlertTriangle size={15} strokeWidth={2.5} />
            <span>{t("header.stalled")}</span>
          </span>
        )}
        {data.owner_compacting && !data.owner_stalled && (
          <span
            className="header-compacting-badge"
            title={t("header.compacting_title")}
          >
            <Shrink size={15} strokeWidth={2.5} />
            <span>{t("header.compacting")}</span>
          </span>
        )}
        {/* Working / activity badge sits at the right end of the LEFT
            (display) cluster. The action buttons live in .header-right,
            which is right-anchored (margin-left:auto). So when Working or
            the BG marker appears/disappears, only the gap between the two
            groups resizes — the buttons never shift left-then-right. */}
        {headerActivity && <ActivityBadge activity={headerActivity} />}
        <div className="header-right">
          {/* "Mark all read" unread indicator lives FIRST in this
              right-anchored cluster (.header-right has margin-left:auto, so it
              grows leftward): inserting at the front extends the row LEFT and
              leaves every action button to its right pinned in place, so its
              appear/disappear never shifts what the user is reaching for. */}
          {(() => {
            const unread = Object.values(data.threads)
              .flat()
              .filter((it) => it.source === "cc" && !it.read_at).length;
            if (unread === 0) return null;
            return (
              <button
                type="button"
                className="mark-all-read"
                title={t("header.unread_count_title", { count: unread })}
                onClick={() => {
                  if (
                    !window.confirm(
                      t("header.unread_confirm", { count: unread }),
                    )
                  )
                    return;
                  fetch("/mark-board-read", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ board_id: data.board.id }),
                  })
                    .then(() => fetchBoard())
                    .catch(() => alert(t("header.mark_all_read_failed")));
                }}
              >
                {t("header.unread_count_button", { count: unread })}
              </button>
            );
          })()}
          <CliCommandButton
            sessionId={ownerSessionId}
            canCliSend={!!data.owner_can_cli_send}
            busy={
              activeActivity?.state === "working" ||
              activeActivity?.state === "blocked"
            }
          />
          {/* The default board is one flat thread, so a chronological
              "all comments" view is identical to the normal view — only
              concern boards (messages scattered across nodes) benefit. */}
          {!data.board.is_default && (
            <button
              type="button"
              className="board-timeline-btn"
              title={t("timeline.button")}
              aria-label={t("timeline.button")}
              onClick={() => setTimelineOpen(true)}
            >
              <ScrollText size={14} strokeWidth={1.9} />
            </button>
          )}
          {(data.owner_bg_task_count ?? 0) > 0 && (
            <button
              type="button"
              className="header-bg-indicator"
              title={`background tasks: ${data.owner_bg_task_count} — click to clear`}
              aria-label={`clear ${data.owner_bg_task_count} background task marker(s)`}
              onClick={() => {
                fetch("/bg-task-clear-session", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ session_id: data.board.session_id }),
                }).catch(() => {
                  /* best-effort; the WS broadcast updates the count */
                });
              }}
            >
              <Cog size={14} strokeWidth={2.25} />
              <span className="header-bg-count">{data.owner_bg_task_count}</span>
            </button>
          )}
          {!data.board.is_default && (
            <NodeStatusFilterButton boardId={boardId ?? ""} />
          )}
          {!data.board.is_default && (
            <BoardSettingsPanel
              boardId={boardId ?? ""}
              autoStatusSync={data.board.auto_status_sync !== 0}
            />
          )}
          {!data.board.is_default && (
            <button
              type="button"
              className={
                "board-request-trigger" +
                (logUnreadCount > 0 ? " has-unread" : "")
              }
              onClick={() => setStructureRequestOpen(true)}
              title={t("structure_request.trigger_title")}
              aria-label={t("structure_request.trigger_title")}
            >
              <Wand2 size={14} strokeWidth={1.75} />
              <span>{t("structure_request.trigger_label")}</span>
              {logUnreadCount > 0 && <span className="unread-dot" />}
            </button>
          )}
          <span className="ws-status">
            <span className={`ws-dot ${wsConnected ? "connected" : ""}`} />
            {wsConnected ? t("header.live") : t("header.offline")}
          </span>
        </div>
        </header>
      }
    >
        {((data as any).owner_scheduled_count ?? 0) > 0 && (
          <div className="scheduled-banner">
            {t("timer.banner", {
              count: (data as any).owner_scheduled_count,
            })}
          </div>
        )}
        <div className="board-container">
          {data.board.is_default ? (
            // key={data.board.id} forces a fresh mount whenever the
            // user navigates between default boards (e.g. pd ↔ zc
            // general). Without it, React keeps the same
            // DefaultBoardLayout instance across the nav and its
            // mount-time scroll snap never re-runs, leaving the user
            // staring at the top of the new board's thread.
            <DefaultBoardLayout
              key={data.board.id}
              data={data}
              ownerAlive={ownerAlive}
              onSubmit={handleSubmit}
              flashingNodes={flashingNodes}
              ownerSessionId={ownerSessionId}
            />
          ) : (
            <>
              <div className="concerns-row">
                {visibleConcerns.map((c) => (
                  <ConcernColumn
                    key={c.id}
                    concern={c}
                    childrenByParent={filteredChildrenByParent}
                    threads={data.threads}
                    flashingNodes={flashingNodes}
                    activity={nodeActivity}
                    ownerAlive={ownerAlive}
                    ownerSessionId={ownerSessionId}
                    onSubmit={handleSubmit}
                  />
                ))}
              </div>
              <BoardNavButtons boardId={boardId ?? ""} dataVersion={data} />
            </>
          )}
        </div>
      {structureRequestOpen && boardId && (
        <BoardStructureRequestModal
          boardId={boardId}
          boardView={data}
          onClose={() => setStructureRequestOpen(false)}
        />
      )}
      {timelineOpen && (
        <TimelineModal
          entries={buildTimelineEntries(data.threads, (nodeId) => {
            const n = data.nodes.find((x) => x.id === nodeId);
            return n
              ? { title: n.title || t("timeline.untitled"), kind: n.kind }
              : null;
          })}
          onJump={(_nodeId, itemId) => {
            // The board scrolls to a message by id (same channel the anchor
            // list uses); the consume effect handles the scroll + the node
            // frame flash, so the node id isn't needed here.
            setTimelineOpen(false);
            jumpToAnchor(data.board.id, itemId);
          }}
          onClose={() => setTimelineOpen(false)}
        />
      )}
    </AppLayout>
  );
}
