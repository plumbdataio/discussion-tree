import React, { useEffect, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Filter,
  GripVertical,
  Menu,
  MessageCircle,
  Settings,
  ChartNetwork,
  Network,
  Plus,
  ClipboardList,
} from "lucide-react";
import { DiagramIcon } from "./DiagramIcon.tsx";
import { SessionActivityIcons } from "./SessionActivityIcons.tsx";
import { SpawnModal } from "./SpawnModal.tsx";
import { IssueTrackerButton } from "./IssueTrackerButton.tsx";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import type { Activity, SessionListItem } from "../../shared/types.ts";
import { BOARD_STATUSES, normalizeBoardStatus } from "../utils/constants.ts";
import { isBoardVisible } from "../utils/boardFilter.ts";
import { applyOrder, sessionOrderKey } from "../utils/sessionOrder.ts";
import {
  type BoardStatusFilter,
  useSettings,
} from "../utils/settings.ts";
import { useTmuxIntegration } from "../utils/tmuxIntegration.ts";
import { openScheduledList } from "../utils/scheduledList.ts";
import { boardTitle } from "../utils/boardTitle.ts";

// Module-scope cache so Sidebar remounts during SPA navigation don't show a
// "Loading…" flash — the previous fetch result is reused as initial state
// while we revalidate in the background. Updated on every successful fetch.
let cachedSessions: SessionListItem[] | null = null;
let cachedInactive: SessionListItem[] = [];

// Session ordering (applyOrder / sessionOrderKey) lives in
// ../utils/sessionOrder.ts so it's unit-testable.

type DropPosition = "before" | "after";

type SessionItemProps = {
  s: SessionListItem;
  currentBoardId: string | null;
  currentMapId: string | null;
  currentDiagramId: string | null;
  filter: BoardStatusFilter;
  inactive: boolean;
  collapsed: boolean;
  onToggleCollapse: (id: string) => void;
  // null = no drag in progress; otherwise the id of the dragged session.
  draggingId: string | null;
  onDragStart: (id: string) => void;
  onDragEnd: () => void;
  onDropOn: (targetId: string, position: DropPosition) => void;
  draggable: boolean;
  // Live activity (working / blocked / etc) for this session — used to render
  // a small spinning indicator next to the name so the user can see when
  // OTHER sessions are busy while they're looking at one in particular.
  activity: Activity | null;
};

function SessionItem({
  s,
  currentBoardId,
  currentMapId,
  currentDiagramId,
  filter,
  inactive,
  collapsed,
  onToggleCollapse,
  draggingId,
  onDragStart,
  onDragEnd,
  onDropOn,
  draggable,
  activity,
}: SessionItemProps) {
  const { t } = useTranslation();
  // null while the cursor isn't over this item; otherwise records whether the
  // drop would land BEFORE the current item or AFTER it. Computed from the
  // mouse Y vs the item's rect midpoint on every dragover.
  const [dropPosition, setDropPosition] = useState<DropPosition | null>(null);

  // Visibility = default board OR currently-open board OR passes the status
  // filter. See isBoardVisible for why the first two bypass the filter.
  const visibleBoards = s.boards.filter((b) =>
    isBoardVisible(b, filter, currentBoardId),
  );

  // "Waiting on you" total for the session — the sum of every board's
  const isDragging = draggingId === s.id;
  const dragActive = !!draggingId && draggingId !== s.id;
  const hasCurrentBoard =
    currentBoardId != null &&
    s.boards.some((b) => b.id === currentBoardId);

  return (
    <div
      key={s.id}
      className={
        `session` +
        (inactive ? " inactive-session" : "") +
        (isDragging ? " dragging" : "") +
        (hasCurrentBoard ? " has-current-board" : "") +
        (dropPosition && dragActive
          ? ` drop-${dropPosition}`
          : "")
      }
      draggable={draggable}
      onDragStart={(e) => {
        if (!draggable) return;
        // Tells the browser this is a "move" rather than "copy" interaction
        // — affects the cursor style during the drag.
        e.dataTransfer.effectAllowed = "move";
        try {
          e.dataTransfer.setData("text/plain", s.id);
        } catch {
          /* some browsers throw on certain data types — ignore */
        }
        onDragStart(s.id);
      }}
      onDragEnd={() => {
        setDropPosition(null);
        onDragEnd();
      }}
      onDragEnter={(e) => {
        if (!dragActive) return;
        e.preventDefault();
      }}
      onDragOver={(e) => {
        if (!dragActive) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        // Compare cursor Y against the item's midpoint to decide whether the
        // drop should land BEFORE or AFTER this item. This is what makes
        // "move to the very bottom" work — drop on the lower half of the
        // last item and it goes after, not before.
        const rect = e.currentTarget.getBoundingClientRect();
        const pos: DropPosition =
          e.clientY < rect.top + rect.height / 2 ? "before" : "after";
        setDropPosition((cur) => (cur === pos ? cur : pos));
      }}
      onDragLeave={(e) => {
        // Only clear when the cursor actually leaves the element (not when
        // it crosses into a child). relatedTarget is null when leaving the
        // window or, for nested elements, the entered element.
        const next = e.relatedTarget as Node | null;
        if (!next || !e.currentTarget.contains(next)) {
          setDropPosition(null);
        }
      }}
      onDrop={(e) => {
        if (!dragActive) return;
        e.preventDefault();
        const rect = e.currentTarget.getBoundingClientRect();
        const pos: DropPosition =
          e.clientY < rect.top + rect.height / 2 ? "before" : "after";
        setDropPosition(null);
        onDropOn(s.id, pos);
      }}
    >
      <div className="session-header">
        <button
          type="button"
          className="session-collapse-toggle"
          aria-label={collapsed ? "Expand" : "Collapse"}
          onClick={() => onToggleCollapse(s.id)}
        >
          {collapsed ? (
            <ChevronRight size={12} strokeWidth={1.75} />
          ) : (
            <ChevronDown size={12} strokeWidth={1.75} />
          )}
        </button>
        <a className="session-name" href={"/session/" + s.id}>
          {s.name ?? <em className="unnamed">{s.id}</em>}
        </a>
        {/* All per-session status indicators live in ONE grid cell (a flex
            row) so the fixed 4-column .session-header (chevron | name |
            indicators | drag-handle) never overflows to a second row no
            matter how many indicators are active at once. Shared with the
            session dashboard header via SessionActivityIcons; `activity` is the
            live WS-updated value (activitiesBySession[s.id]), so it's passed
            explicitly rather than read off `s`. */}
        <SessionActivityIcons
          session={s}
          activity={activity}
          onOpenScheduledList={openScheduledList}
        />
        {draggable && (
          <span className="session-drag-handle" aria-hidden="true">
            <GripVertical size={12} strokeWidth={1.75} />
          </span>
        )}
        <span className="session-cwd" title={s.cwd}>
          {s.cwd.split("/").slice(-2).join("/")}
        </span>
      </div>
      {collapsed && visibleBoards.length > 0 && (
        <div className="session-summary">
          {(
            [
              "discussing",
              "settled",
              "completed",
              "withdrawn",
              "paused",
            ] as const
          ).map(
            (status) => {
              const n = visibleBoards.filter(
                (b) => normalizeBoardStatus(b.status) === status,
              ).length;
              if (n === 0) return null;
              return (
                <span
                  key={status}
                  className={`session-summary-chip sb-summary-${status}`}
                  title={t([`board_status.${status}`, status])}
                >
                  {n}
                </span>
              );
            },
          )}
        </div>
      )}
      {!collapsed &&
        (visibleBoards.length === 0 ? (
          <div className="empty empty-boards">{t("sidebar.no_boards")}</div>
        ) : (
          <ul className="boards">
            {visibleBoards.map((b) => {
              const hasUnread = (b.unread_count ?? 0) > 0;
              // needs-reply is a node-level status: at least one node in this
              // board is flagged for the user's attention. Distinct from
              // unread (= new CC messages). Surfaced so the user notices it
              // without having to open the board.
              const needsReplyCount = b.stats?.needs_reply ?? 0;
              const hasNeedsReply = needsReplyCount > 0;
              // Normalize at the boundary: maps legacy 'active' / unknowns /
              // null to a renderable status so the i18n fallback never shows
              // the raw enum string (e.g. "ACTIVE") in the badge.
              const status = normalizeBoardStatus(b.status);
              // Coerce SQLite's 0/1 number into a real boolean before using
              // `&&` — `0 && <X />` evaluates to `0`, which React renders as
              // a literal "0" character.
              const isDefault = Boolean(b.is_default);
              return (
                <li
                  key={b.id}
                  className={
                    (isDefault ? "is-default " : "") +
                    (b.id === currentBoardId ? "current " : "") +
                    (hasUnread ? "has-unread " : "") +
                    (hasNeedsReply ? "has-needs-reply" : "")
                  }
                >
                  <a href={"/board/" + b.id} className="sidebar-board-link">
                    <span className="sidebar-board-title">
                      {isDefault ? (
                        <MessageCircle
                          className="sidebar-default-icon"
                          size={13}
                          strokeWidth={1.75}
                        />
                      ) : (
                        <Network
                          className="sidebar-board-icon"
                          size={13}
                          strokeWidth={1.75}
                        />
                      )}
                      {boardTitle(b, t)}
                    </span>
                    {/* needs-reply takes visual priority over the status
                        badge — it's an actionable flag, not just metadata. */}
                    {hasNeedsReply && (
                      <span
                        className="sidebar-needs-reply-badge"
                        title={t("sidebar.needs_reply_title", {
                          count: needsReplyCount,
                        })}
                      >
                        {needsReplyCount}
                      </span>
                    )}
                    {hasUnread && (
                      <span
                        className="sidebar-unread-dot"
                        title={t("sidebar.unread_dot_title", {
                          count: b.unread_count,
                        })}
                      />
                    )}
                    {!isDefault && !hasUnread && !hasNeedsReply && (
                      <span
                        className={`sidebar-board-status sb-status-${status}`}
                      >
                        {t([`board_status.${status}`, status])}
                      </span>
                    )}
                  </a>
                </li>
              );
            })}
          </ul>
        ))}
      {/* Maps (divergence surface) owned by this session. Distinct icon +
          list so "board vs map" reads at a glance. */}
      {!collapsed && (s.maps?.length ?? 0) > 0 && (
        <ul className="maps">
          {s.maps!.map((m) => {
            const hasUnread = (m.unread_count ?? 0) > 0;
            return (
              <li
                key={m.id}
                className={
                  (m.id === currentMapId ? "current " : "") +
                  (hasUnread ? "has-unread" : "")
                }
              >
                <a href={"/map/" + m.id} className="sidebar-map-link">
                  <span className="sidebar-map-title">
                    <ChartNetwork
                      className="sidebar-map-icon"
                      size={13}
                      strokeWidth={1.75}
                    />
                    {m.title}
                  </span>
                  {/* Navigate by the same red badge as boards: show the
                      unread CC-message count, not the (meaningless) node
                      count. Nothing when there's nothing new to look at. */}
                  {hasUnread && (
                    <span
                      className="sidebar-unread-count"
                      title={t("sidebar.unread_dot_title", {
                        count: m.unread_count,
                      })}
                    >
                      {m.unread_count}
                    </span>
                  )}
                </a>
              </li>
            );
          })}
        </ul>
      )}
      {/* Mermaid diagrams owned by this session — a 3rd surface. Reuses the
          map list styling; distinct icon so it reads apart from maps. */}
      {!collapsed && (s.diagrams?.length ?? 0) > 0 && (
        <ul className="maps diagrams">
          {s.diagrams!.map((d) => {
            const hasUnread = (d.unread_count ?? 0) > 0;
            return (
              <li
                key={d.id}
                className={
                  (d.id === currentDiagramId ? "current " : "") +
                  (hasUnread ? "has-unread" : "")
                }
              >
                <a href={"/diagram/" + d.id} className="sidebar-map-link">
                  <span className="sidebar-map-title">
                    <DiagramIcon
                      className="sidebar-diagram-icon"
                      size={13}
                      strokeWidth={1.75}
                    />
                    {d.title}
                  </span>
                  {/* Plain red unread dot — same as boards (the ask was
                      "like boards": a dot, not maps' numbered count). */}
                  {hasUnread && (
                    <span
                      className="sidebar-unread-dot"
                      title={t("sidebar.unread_dot_title", {
                        count: d.unread_count,
                      })}
                    />
                  )}
                </a>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

export function Sidebar({
  currentBoardId,
  currentMapId = null,
  currentDiagramId = null,
}: {
  currentBoardId: string | null;
  currentMapId?: string | null;
  currentDiagramId?: string | null;
}) {
  const { t } = useTranslation();
  const [settings, updateSettings] = useSettings();
  const [tmuxIntegration] = useTmuxIntegration();
  const [spawnOpen, setSpawnOpen] = useState(false);
  const [sessions, setSessions] = useState<SessionListItem[] | null>(
    cachedSessions,
  );
  const [inactiveSessions, setInactiveSessions] = useState<SessionListItem[]>(
    cachedInactive,
  );
  const [error, setError] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  // Hover-peek: when the sidebar is collapsed, hovering the reopen tab (or the
  // peeked sidebar) opens it temporarily; it closes again when the pointer
  // leaves. The reopen button stays put — clicking it opens permanently.
  // Closing is deferred a beat so moving from the tab INTO the sidebar (which
  // re-opens) doesn't flicker — and so leaving the tab toward the header still
  // closes it (the deferred close isn't cancelled).
  const [peek, setPeek] = useState(false);
  const peekTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const openPeek = () => {
    if (peekTimer.current) clearTimeout(peekTimer.current);
    peekTimer.current = null;
    setPeek(true);
  };
  const closePeekSoon = () => {
    if (peekTimer.current) clearTimeout(peekTimer.current);
    peekTimer.current = setTimeout(() => setPeek(false), 120);
  };
  const [inactiveOpen, setInactiveOpen] = useState(false);
  const [filterOpen, setFilterOpen] = useState(false);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  // session_id → Activity (or null) map. Seeded from /api/sessions on fetch
  // and updated live by `pd-activity-update` events dispatched by BoardApp's
  // WebSocket handler.
  const [activitiesBySession, setActivitiesBySession] = useState<
    Record<string, Activity | null>
  >({});

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as {
        session_id: string;
        activity: Activity | null;
      };
      setActivitiesBySession((prev) => ({
        ...prev,
        [detail.session_id]: detail.activity,
      }));
    };
    window.addEventListener("pd-activity-update", handler);
    return () => window.removeEventListener("pd-activity-update", handler);
  }, []);

  // Close the mobile drawer on navigation so the user lands on the new view
  // without the panel still covering it. Keyed on all three surface ids so a
  // map→diagram (or any cross-surface) hop closes it too, not just board nav.
  useEffect(() => {
    setDrawerOpen(false);
  }, [currentBoardId, currentMapId, currentDiagramId]);

  // While the drawer is open on mobile, freeze the page underneath so a touch
  // scroll inside the sidebar doesn't bleed through and move the board.
  useEffect(() => {
    if (!drawerOpen) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [drawerOpen]);

  useEffect(() => {
    let cancelled = false;
    const fetchSessions = async () => {
      try {
        const res = await fetch("/api/sessions");
        if (!res.ok) throw new Error("HTTP " + res.status);
        const data = (await res.json()) as {
          sessions: SessionListItem[];
          inactive_sessions?: SessionListItem[];
        };
        if (!cancelled) {
          cachedSessions = data.sessions;
          cachedInactive = data.inactive_sessions ?? [];
          setSessions(cachedSessions);
          setInactiveSessions(cachedInactive);
          setError(null);
          // Seed the activity map from the just-fetched sessions so we have
          // an initial value even before any WS frame arrives. WS updates
          // continue to overlay this in real time.
          //
          // Rebuild the map from ONLY the sessions the broker still lists,
          // rather than spreading `prev`, so it cannot grow without bound: the
          // broker mints a fresh session_id on every CC restart, so the WS
          // `pd-activity-update` handler (and this seed) would otherwise keep
          // every dead id forever in this always-mounted component. Carry a
          // prior value forward for a still-listed session (so a live update
          // that arrived between polls isn't dropped), then overlay the
          // freshly-fetched activity for the active ones.
          setActivitiesBySession((prev) => {
            const liveIds = new Set<string>();
            for (const s of data.sessions) liveIds.add(s.id);
            for (const s of data.inactive_sessions ?? []) liveIds.add(s.id);
            const next: Record<string, Activity | null> = {};
            for (const id of Object.keys(prev)) {
              if (liveIds.has(id)) next[id] = prev[id];
            }
            for (const s of data.sessions) {
              next[s.id] = s.activity ?? null;
            }
            return next;
          });
        }
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e));
        }
      }
    };
    fetchSessions();
    // Skip the 10s poll while the tab is in the background — iOS Safari
    // suspends/discards inactive tabs under memory pressure, and a
    // ticking interval keeps the renderer "active" enough to count
    // against that budget. Resume immediately on visibilitychange so
    // the UI catches up the moment the user returns.
    const tick = () => {
      if (document.hidden) return;
      fetchSessions();
    };
    const interval = setInterval(tick, 10000);
    const onVisibility = () => {
      if (!document.hidden) fetchSessions();
    };
    document.addEventListener("visibilitychange", onVisibility);
    // BoardApp dispatches this when the broker tells it unread counts shifted.
    const onRefresh = () => fetchSessions();
    window.addEventListener("pd-sidebar-refresh", onRefresh);
    return () => {
      cancelled = true;
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pd-sidebar-refresh", onRefresh);
    };
  }, []);

  const filter = settings.boardStatusFilter;
  const visibleStatusCount = BOARD_STATUSES.filter(
    (s) => filter[s as keyof BoardStatusFilter],
  ).length;

  const toggleStatus = (status: keyof BoardStatusFilter) => {
    updateSettings({
      boardStatusFilter: { ...filter, [status]: !filter[status] },
    });
  };

  const toggleCollapse = (sid: string) => {
    updateSettings({
      collapsedSessions: {
        ...settings.collapsedSessions,
        [sid]: !settings.collapsedSessions[sid],
      },
    });
  };

  const orderedActive = applyOrder(sessions ?? [], settings.sessionOrder);

  // --- Session visibility filter (keyed by cc_session_id; see
  // settings.shownSessions) ------------------------------------------------
  // cc_session_id (falling back to cwd before attach) is stable across
  // /compact and `claude -r` resume — only a genuinely fresh CC launch mints a
  // new one — so the filter survives the restarts that matter while staying
  // per-session. null = show all (new sessions appear); a non-null array is an
  // allow-list (only those show; new sessions stay hidden until added).
  const shownSessions = settings.shownSessions;
  const sessionKey = (s: SessionListItem) => s.cc_session_id ?? s.cwd;
  // ACTIVE sessions only — inactive sessions already have their own
  // collapsible "Inactive (N)" section at the bottom, so they stay out of this
  // filter entirely (not listed, not hidden by it).
  const allKeys = Array.from(new Set((sessions ?? []).map(sessionKey)));
  const isSessionShown = (key: string) =>
    shownSessions === null || shownSessions.includes(key);
  const shownSessionCount = allKeys.filter(isSessionShown).length;
  const toggleSession = (key: string) => {
    if (isSessionShown(key)) {
      // Hide: materialize the full set first if we were showing all, so the
      // rest stay explicit (= partial mode, where new sessions hide).
      const base = shownSessions === null ? allKeys : shownSessions;
      updateSettings({ shownSessions: base.filter((k) => k !== key) });
    } else {
      // Show: add it; if every known session is now visible, collapse back to
      // null (= show all) so future new sessions appear too.
      const next = [...(shownSessions ?? []), key];
      const allVisible = allKeys.every((k) => next.includes(k));
      updateSettings({ shownSessions: allVisible ? null : next });
    }
  };
  const visibleActive = orderedActive.filter((s) =>
    isSessionShown(sessionKey(s)),
  );

  // Short, readable label for a session checkbox: its name, else the last two
  // cwd path segments. Full cwd goes in the row's title.
  const shortCwd = (cwd: string) =>
    cwd.split("/").filter(Boolean).slice(-2).join("/") || cwd;
  // De-duplicated list of sessions (active + inactive) for the filter list,
  // keyed the same way as the filter so toggles line up.
  const filterSessions = (() => {
    const seen = new Set<string>();
    const out: { key: string; label: string; cwd: string }[] = [];
    for (const s of sessions ?? []) {
      const key = sessionKey(s);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ key, label: s.name || shortCwd(s.cwd), cwd: s.cwd });
    }
    return out.sort((a, b) => a.label.localeCompare(b.label));
  })();

  const reorderTo = (
    fromId: string,
    toId: string,
    position: DropPosition,
  ) => {
    if (fromId === toId) return;
    const arr = [...orderedActive];
    const fromIdx = arr.findIndex((s) => s.id === fromId);
    const toIdx = arr.findIndex((s) => s.id === toId);
    if (fromIdx < 0 || toIdx < 0) return;
    const [moved] = arr.splice(fromIdx, 1);
    // After removing fromIdx, indices >= fromIdx are shifted left by one.
    const adjustedTo = fromIdx < toIdx ? toIdx - 1 : toIdx;
    const insertAt = position === "before" ? adjustedTo : adjustedTo + 1;
    arr.splice(insertAt, 0, moved);
    // Persist by cc_session_id (stable across CC restarts / `/mcp` AND unique,
    // so two sessions sharing a cwd order independently). No cwd fallback: an
    // attached session always has a cc_session_id, and a (non-occurring) null is
    // skipped rather than ordered by cwd.
    const keys: string[] = [];
    for (const s of arr) {
      const k = sessionOrderKey(s);
      if (k != null && !keys.includes(k)) keys.push(k);
    }
    updateSettings({ sessionOrder: keys });
  };

  return (
    <>
      <button
        className="sidebar-toggle"
        type="button"
        aria-label={t("sidebar.toggle_label")}
        onClick={() => setDrawerOpen((v) => !v)}
      >
        <Menu size={20} strokeWidth={1.75} />
      </button>
      {drawerOpen && (
        <div
          className="sidebar-backdrop"
          onClick={() => setDrawerOpen(false)}
        />
      )}
      {/* Desktop reopen affordance — only visible (via CSS) when the sidebar
          is collapsed AND we're on a wide screen. The mobile hamburger above
          owns the narrow-screen case. */}
      {settings.sidebarCollapsed && (
        <button
          type="button"
          className={"sidebar-reopen" + (peek ? " peeked" : "")}
          aria-label={t("sidebar.expand_label")}
          title={t("sidebar.expand_label")}
          onMouseEnter={openPeek}
          onMouseLeave={closePeekSoon}
          onClick={() => updateSettings({ sidebarCollapsed: false })}
        >
          <ChevronsRight size={22} strokeWidth={2.25} />
        </button>
      )}
      <aside
        className={
          `sidebar${drawerOpen ? " open" : ""}` +
          (settings.sidebarCollapsed ? " collapsed" : "") +
          (settings.sidebarCollapsed && peek ? " peek" : "")
        }
        onMouseEnter={settings.sidebarCollapsed ? openPeek : undefined}
        onMouseLeave={settings.sidebarCollapsed ? closePeekSoon : undefined}
      >
        {/* Mobile-only quick actions — replaces the .gear-fab corner
            button which is hidden at <=768px. The .anchor-fab stays
            in the header on mobile (it occupies the slot the gear
            vacated), so the bookmark list is reached without first
            opening the drawer. Click dispatches a CustomEvent that
            GearButton listens for, keeping its modal state local. */}
        <div className="sidebar-quick-actions">
          <button
            type="button"
            className="sidebar-quick-action"
            onClick={() => {
              window.dispatchEvent(new Event("pd-open-settings"));
              setDrawerOpen(false);
            }}
          >
            <Settings size={14} strokeWidth={1.75} />
            <span>{t("settings.title")}</span>
          </button>
        </div>
        <div className="sidebar-title-row">
          <h2 className="sidebar-title">{t("sidebar.sessions")}</h2>
          <div className="sidebar-title-actions">
            {/* Icon-only. The filter used to own a whole row of its own — a
                label plus an "n of m" count — in a sidebar that must not grow
                taller. The count is gone on request, but a filtered list that
                gives no sign it is filtered is a trap, so a dot marks "not
                everything is shown". It is absolutely positioned, so it never
                shifts its siblings. */}
            <button
              type="button"
              className={
                "sidebar-filter-btn" + (filterOpen ? " open" : "")
              }
              aria-label={t("sidebar.filter_label")}
              title={t("sidebar.filter_label")}
              aria-expanded={filterOpen}
              onClick={() => setFilterOpen((v) => !v)}
            >
              <Filter size={15} strokeWidth={2} />
              {(visibleStatusCount < BOARD_STATUSES.length ||
                shownSessionCount < allKeys.length) && (
                <span className="sidebar-filter-dot" />
              )}
            </button>
            <IssueTrackerButton />
            {tmuxIntegration && (
              <button
                type="button"
                className="sidebar-spawn-btn"
                aria-label={t("spawn.button_title")}
                title={t("spawn.button_title")}
                onClick={() => setSpawnOpen(true)}
              >
                <Plus size={16} strokeWidth={2.25} />
              </button>
            )}
            {spawnOpen && <SpawnModal onClose={() => setSpawnOpen(false)} />}
            <button
              type="button"
              className="sidebar-collapse-btn"
              aria-label={
                settings.sidebarCollapsed
                  ? t("sidebar.expand_label")
                  : t("sidebar.collapse_label")
              }
              title={
                settings.sidebarCollapsed
                  ? t("sidebar.expand_label")
                  : t("sidebar.collapse_label")
              }
              onClick={() => {
                updateSettings({
                  sidebarCollapsed: !settings.sidebarCollapsed,
                });
                setDrawerOpen(false);
              }}
            >
              {settings.sidebarCollapsed ? (
                <ChevronsRight size={16} strokeWidth={2.25} />
              ) : (
                <ChevronsLeft size={16} strokeWidth={2.25} />
              )}
            </button>
          </div>
        </div>

        <div className="sidebar-filter">
          {filterOpen && (
            <div className="sidebar-filter-options">
              <div className="sidebar-filter-group-head">
                {t("sidebar.status_filter_label")}
              </div>
              {BOARD_STATUSES.map((status) => (
                <label key={status} className="sidebar-filter-option">
                  <input
                    type="checkbox"
                    checked={filter[status as keyof BoardStatusFilter]}
                    onChange={() =>
                      toggleStatus(status as keyof BoardStatusFilter)
                    }
                  />
                  <span>{t([`board_status.${status}`, status])}</span>
                </label>
              ))}
              {filterSessions.length > 0 && (
                <div className="sidebar-filter-group">
                  <div className="sidebar-filter-group-head">
                    <span>{t("sidebar.session_filter_label")}</span>
                    <span className="sidebar-filter-summary">
                      {t("sidebar.filter_summary", {
                        visible: shownSessionCount,
                        total: allKeys.length,
                      })}
                    </span>
                  </div>
                  {filterSessions.map((fs) => (
                    <label
                      key={fs.key}
                      className="sidebar-filter-option"
                      title={fs.cwd}
                    >
                      <input
                        type="checkbox"
                        checked={isSessionShown(fs.key)}
                        onChange={() => toggleSession(fs.key)}
                      />
                      <span className="sidebar-filter-cwd">{fs.label}</span>
                    </label>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {error && <div className="sidebar-error">{error}</div>}
        {!sessions && !error && (
          <div className="empty">{t("sidebar.loading")}</div>
        )}
        {sessions && sessions.length === 0 && (
          <div className="empty">{t("sidebar.no_active_sessions")}</div>
        )}
        {visibleActive.map((s) => (
          <SessionItem
            key={s.id}
            s={s}
            currentBoardId={currentBoardId}
            currentMapId={currentMapId}
            currentDiagramId={currentDiagramId}
            filter={filter}
            inactive={false}
            collapsed={!!settings.collapsedSessions[s.id]}
            onToggleCollapse={toggleCollapse}
            draggingId={draggingId}
            onDragStart={setDraggingId}
            onDragEnd={() => setDraggingId(null)}
            onDropOn={(targetId, position) =>
              reorderTo(draggingId ?? "", targetId, position)
            }
            draggable
            activity={activitiesBySession[s.id] ?? null}
          />
        ))}

        {inactiveSessions.length > 0 && (
          <div className="inactive-sessions">
            <button
              type="button"
              className="inactive-toggle"
              onClick={() => setInactiveOpen((v) => !v)}
            >
              {inactiveOpen ? (
                <ChevronDown size={14} strokeWidth={1.75} />
              ) : (
                <ChevronRight size={14} strokeWidth={1.75} />
              )}
              <span>
                {t("sidebar.inactive_label", {
                  count: inactiveSessions.length,
                })}
              </span>
            </button>
            {inactiveOpen &&
              inactiveSessions.map((s) => (
                <SessionItem
                  key={s.id}
                  s={s}
                  currentBoardId={currentBoardId}
                  currentMapId={currentMapId}
                  currentDiagramId={currentDiagramId}
                  filter={filter}
                  inactive
                  collapsed={!!settings.collapsedSessions[s.id]}
                  onToggleCollapse={toggleCollapse}
                  draggingId={null}
                  onDragStart={() => undefined}
                  onDragEnd={() => undefined}
                  onDropOn={() => undefined}
                  draggable={false}
                  activity={null}
                />
              ))}
          </div>
        )}
      </aside>
    </>
  );
}
