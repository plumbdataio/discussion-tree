import React, { useEffect, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Clock,
  Cog,
  Filter,
  GripVertical,
  Menu,
  MessageCircle,
  RefreshCw,
  Send,
  Settings,
  Share2,
} from "lucide-react";
import { HelpBubbleIcon } from "./HelpBubbleIcon.tsx";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import type { Activity, SessionListItem } from "../../shared/types.ts";
import { BOARD_STATUSES, normalizeBoardStatus } from "../utils/constants.ts";
import { isBoardVisible } from "../utils/boardFilter.ts";
import {
  type BoardStatusFilter,
  useSettings,
} from "../utils/settings.ts";

// Module-scope cache so Sidebar remounts during SPA navigation don't show a
// "Loading…" flash — the previous fetch result is reused as initial state
// while we revalidate in the background. Updated on every successful fetch.
let cachedSessions: SessionListItem[] | null = null;
let cachedInactive: SessionListItem[] = [];

// Apply the user's preferred ordering. `order` is a list of cwds (NOT session
// ids): the broker mints a fresh session row id on every CC restart, so an
// id-keyed order would drop a restarted session to the bottom every time. cwd
// is stable across restarts, so a session returns to its saved slot. Sessions
// whose cwd is listed come first (in the listed order); the rest follow in
// natural broker order. Stable for ties / unlisted (sessions sharing a cwd
// stay in natural order).
function applyOrder(
  sessions: SessionListItem[],
  order: string[],
): SessionListItem[] {
  const rank = new Map<string, number>();
  order.forEach((cwd, i) => {
    if (!rank.has(cwd)) rank.set(cwd, i);
  });
  return sessions
    .map((s, i) => ({ s, i }))
    .sort((a, b) => {
      const ra = rank.has(a.s.cwd) ? (rank.get(a.s.cwd) as number) : Infinity;
      const rb = rank.has(b.s.cwd) ? (rank.get(b.s.cwd) as number) : Infinity;
      if (ra !== rb) return ra - rb;
      return a.i - b.i;
    })
    .map((x) => x.s);
}

// Format a scheduled-send ISO timestamp to a short local clock time for the
// sidebar marker tooltip. Falls back to the raw string if it doesn't parse.
function formatScheduleTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
}

type DropPosition = "before" | "after";

type SessionItemProps = {
  s: SessionListItem;
  currentBoardId: string | null;
  currentMapId: string | null;
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
        {activity && (
          <span
            className={`session-activity-indicator activity-${activity.state}`}
            title={
              activity.message
                ? `${activity.state}: ${activity.message}`
                : activity.state
            }
            aria-label={activity.state}
          >
            {/* "blocked" = CC waiting on the user (AskUserQuestion /
                ExitPlanMode). Show a chat-bubble-with-alert glyph + pulse
                instead of the spinning refresh icon — a spinning icon
                reads as "still working" and was easy to overlook, and a
                generic warning triangle didn't convey "the assistant
                wants to talk to you". */}
            {activity.state === "blocked" ? (
              <HelpBubbleIcon size={16} strokeWidth={2} />
            ) : (
              <RefreshCw size={14} strokeWidth={2.75} />
            )}
          </span>
        )}
        {(s.bg_task_count ?? 0) > 0 && (
          <button
            type="button"
            className="session-bg-indicator"
            title={`background tasks: ${s.bg_task_count} — click to clear`}
            aria-label={`clear ${s.bg_task_count} background task marker(s)`}
            onClick={(e) => {
              // Don't let the click bubble into the session-row nav.
              e.stopPropagation();
              fetch("/bg-task-clear-session", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ session_id: s.id }),
              }).catch(() => {
                /* best-effort; the WS broadcast updates the count */
              });
            }}
          >
            <Cog size={14} strokeWidth={2.25} />
            <span className="session-bg-count">{s.bg_task_count}</span>
          </button>
        )}
        {s.scheduled_send_at && (
          <span
            className="session-schedule-indicator"
            title={t("sidebar.scheduled_send_title", {
              time: formatScheduleTime(s.scheduled_send_at),
            })}
            aria-label={t("sidebar.scheduled_send_aria")}
          >
            <Send size={13} strokeWidth={2} />
            <Clock
              className="session-schedule-clock"
              size={9}
              strokeWidth={3}
            />
          </span>
        )}
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
                      {isDefault && (
                        <MessageCircle
                          className="sidebar-default-icon"
                          size={13}
                          strokeWidth={1.75}
                        />
                      )}
                      {isDefault ? t("default_board.title") : b.title}
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
                    <Share2
                      className="sidebar-map-icon"
                      size={13}
                      strokeWidth={1.75}
                    />
                    {m.title}
                  </span>
                  {hasUnread && (
                    <span
                      className="sidebar-unread-dot"
                      title={t("sidebar.unread_dot_title", {
                        count: m.unread_count,
                      })}
                    />
                  )}
                  {!hasUnread && (
                    <span
                      className="sidebar-map-count"
                      title={t("sidebar.map_node_count", {
                        count: m.node_count,
                      })}
                    >
                      {m.node_count}
                    </span>
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
}: {
  currentBoardId: string | null;
  currentMapId?: string | null;
}) {
  const { t } = useTranslation();
  const [settings, updateSettings] = useSettings();
  const [sessions, setSessions] = useState<SessionListItem[] | null>(
    cachedSessions,
  );
  const [inactiveSessions, setInactiveSessions] = useState<SessionListItem[]>(
    cachedInactive,
  );
  const [error, setError] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
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
  // without the panel still covering it.
  useEffect(() => {
    setDrawerOpen(false);
  }, [currentBoardId]);

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
          setActivitiesBySession((prev) => {
            const next: Record<string, Activity | null> = { ...prev };
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
    // Persist by cwd (stable across CC restarts; the session row id is not).
    const cwds: string[] = [];
    for (const s of arr) if (!cwds.includes(s.cwd)) cwds.push(s.cwd);
    updateSettings({ sessionOrder: cwds });
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
      <aside className={`sidebar${drawerOpen ? " open" : ""}`}>
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
        <h2 className="sidebar-title">{t("sidebar.sessions")}</h2>

        <div className="sidebar-filter">
          <button
            type="button"
            className="sidebar-filter-toggle"
            onClick={() => setFilterOpen((v) => !v)}
          >
            {filterOpen ? (
              <ChevronDown size={12} strokeWidth={1.75} />
            ) : (
              <ChevronRight size={12} strokeWidth={1.75} />
            )}
            <Filter size={12} strokeWidth={1.75} />
            <span className="sidebar-filter-label">
              {t("sidebar.filter_label")}
            </span>
            <span className="sidebar-filter-summary">
              {t("sidebar.filter_summary", {
                visible: visibleStatusCount,
                total: BOARD_STATUSES.length,
              })}
            </span>
          </button>
          {filterOpen && (
            <div className="sidebar-filter-options">
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
        {orderedActive.map((s) => (
          <SessionItem
            key={s.id}
            s={s}
            currentBoardId={currentBoardId}
            currentMapId={currentMapId}
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
