import React, { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, Cog, Shrink, Wand2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { Activity, BoardView } from "../../shared/types.ts";
import { ActivityBadge } from "./ActivityBadge.tsx";
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
  subscribePendingJump,
} from "../utils/anchorJump.ts";
import { NodeStatusFilterButton } from "./NodeStatusFilterButton.tsx";
import { BoardSettingsPanel } from "./BoardSettingsPanel.tsx";
import { BoardNavButtons } from "./BoardNavButtons.tsx";
import {
  isNodeVisible,
  isNodeVisibleWithUnread,
  useNodeStatusFilter,
  useNodeUnreadOverride,
} from "../utils/nodeStatusFilter.ts";
import { Sidebar } from "./Sidebar.tsx";
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

  // Consume any pending anchor jump targeting this board: scroll the
  // matching thread item into view and pulse-highlight it for a couple
  // of seconds. Runs whenever the board's data changes (= initial
  // load, hot board switch) and whenever the jump channel notifies
  // (= same-board click in the modal).
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
        });
      });
    };
    tryConsume();
    return subscribePendingJump(tryConsume);
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
    return <div className="error">{error}</div>;
  }
  if (!data) {
    return <div className="empty">{t("sidebar.loading")}</div>;
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
    <div className="app">
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
          <CliCommandButton
            sessionId={ownerSessionId}
            canCliSend={!!data.owner_can_cli_send}
            busy={
              activeActivity?.state === "working" ||
              activeActivity?.state === "blocked"
            }
          />
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
          <span className="ws-status">
            <span className={`ws-dot ${wsConnected ? "connected" : ""}`} />
            {wsConnected ? t("header.live") : t("header.offline")}
          </span>
        </div>
      </header>
      <div className="app-body">
        <Sidebar currentBoardId={boardId} />
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
      </div>
      {structureRequestOpen && boardId && (
        <BoardStructureRequestModal
          boardId={boardId}
          boardView={data}
          onClose={() => setStructureRequestOpen(false)}
        />
      )}
    </div>
  );
}
