import React, { useCallback, useEffect, useRef, useState } from "react";
import { Wand2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { Activity, BoardView } from "../../shared/types.ts";
import { ActivityBadge } from "./ActivityBadge.tsx";
import { BoardStructureRequestModal } from "./BoardStructureRequestModal.tsx";
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
import {
  isNodeVisible,
  useNodeStatusFilter,
} from "../utils/nodeStatusFilter.ts";
import { Sidebar } from "./Sidebar.tsx";
import { postSubmitAnswer } from "../utils/api.ts";
import { readBoardCache, writeBoardCache } from "../utils/boardCache.ts";
import { translateError } from "../utils/errors.ts";
import { buildTree } from "../utils/tree.ts";

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
          el.scrollIntoView({ behavior: "smooth", block: "center" });
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

  // Keep document.title in sync with the loaded board so external trackers
  // (Clockify auto-tracker, browser tab strip, history) get something more
  // useful than the literal "discussion-tree". Resets on unmount so the
  // next page (session dashboard / root) can write its own.
  useEffect(() => {
    if (!data) return;
    const owner = data.owner_session_name ?? "";
    const boardTitle = data.board.is_default
      ? t("default_board.title")
      : data.board.title;
    document.title = owner
      ? `discussion-tree / ${owner} / ${boardTitle}`
      : `discussion-tree / ${boardTitle}`;
    return () => {
      document.title = "discussion-tree";
    };
  }, [data, t]);

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
          // Forward the activity to the sidebar so its per-session
          // indicator updates without waiting for the 10s sessions poll.
          window.dispatchEvent(
            new CustomEvent("pd-activity-update", {
              detail: { session_id: sid, activity: msg.activity ?? null },
            }),
          );
          return; // activity events don't affect board data
        } else if (msg.type === "sidebar-refresh") {
          // Sidebar polls /api/sessions on its own schedule; nudge it to
          // refetch immediately when unread counts shift.
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
  const [nodeStatusFilter] = useNodeStatusFilter();
  const filteredChildrenByParent = (() => {
    const next = new Map<string | null, typeof concerns>();
    for (const [parent, kids] of childrenByParent) {
      next.set(
        parent,
        kids.filter((n) => {
          if (n.kind !== "item") return true;
          return isNodeVisible(n.status, nodeStatusFilter);
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
        {headerActivity && <ActivityBadge activity={headerActivity} />}
        <ContextMeter usage={data.owner_context_usage} prefix="Context: " />
        {!data.board.is_default && <NodeStatusFilterButton />}
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
        {!ownerAlive && (
          <span
            className="owner-warning"
            title={t("header.owner_warning_title")}
          >
            {t("header.owner_warning")}
          </span>
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
      </header>
      <div className="app-body">
        <Sidebar currentBoardId={boardId} />
        <div className="board-container">
          {data.board.is_default ? (
            <DefaultBoardLayout
              data={data}
              ownerAlive={ownerAlive}
              onSubmit={handleSubmit}
              flashingNodes={flashingNodes}
              ownerSessionId={ownerSessionId}
            />
          ) : (
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
