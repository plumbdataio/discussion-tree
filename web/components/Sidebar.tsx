import React, { useEffect, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Filter,
  GripVertical,
  Menu,
  MessageCircle,
  RefreshCw,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import type { Activity, SessionListItem } from "../../shared/types.ts";
import { BOARD_STATUSES } from "../utils/constants.ts";
import {
  type BoardStatusFilter,
  useSettings,
} from "../utils/settings.ts";

// Module-scope cache so Sidebar remounts during SPA navigation don't show a
// "Loading…" flash — the previous fetch result is reused as initial state
// while we revalidate in the background. Updated on every successful fetch.
let cachedSessions: SessionListItem[] | null = null;
let cachedInactive: SessionListItem[] = [];

// Apply the user's preferred ordering: ids listed in `order` come first in
// the listed order, anything missing follows in the natural broker order.
function applyOrder(
  sessions: SessionListItem[],
  order: string[],
): SessionListItem[] {
  const byId = new Map<string, SessionListItem>();
  for (const s of sessions) byId.set(s.id, s);
  const used = new Set<string>();
  const result: SessionListItem[] = [];
  for (const id of order) {
    const s = byId.get(id);
    if (s) {
      result.push(s);
      used.add(id);
    }
  }
  for (const s of sessions) {
    if (!used.has(s.id)) result.push(s);
  }
  return result;
}

type SessionItemProps = {
  s: SessionListItem;
  currentBoardId: string | null;
  filter: BoardStatusFilter;
  inactive: boolean;
  collapsed: boolean;
  onToggleCollapse: (id: string) => void;
  // null = no drag in progress; otherwise the id of the dragged session.
  draggingId: string | null;
  onDragStart: (id: string) => void;
  onDragEnd: () => void;
  onDropOn: (targetId: string) => void;
  draggable: boolean;
  // Live activity (working / blocked / etc) for this session — used to render
  // a small spinning indicator next to the name so the user can see when
  // OTHER sessions are busy while they're looking at one in particular.
  activity: Activity | null;
};

function SessionItem({
  s,
  currentBoardId,
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
  const [dragOver, setDragOver] = useState(false);

  // Default boards bypass the status filter — they're the conversation
  // surface and the user always wants visibility there. For non-default
  // boards we filter by `status` (defaulting to "active" when unset).
  const visibleBoards = s.boards.filter((b) => {
    if (b.is_default) return true;
    const status = (b.status ?? "active") as keyof BoardStatusFilter;
    return filter[status] !== false;
  });

  const isDragging = draggingId === s.id;

  return (
    <div
      key={s.id}
      className={
        `session` +
        (inactive ? " inactive-session" : "") +
        (isDragging ? " dragging" : "") +
        (dragOver && draggingId && draggingId !== s.id ? " drag-over" : "")
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
        setDragOver(false);
        onDragEnd();
      }}
      onDragEnter={(e) => {
        if (!draggable || !draggingId || draggingId === s.id) return;
        e.preventDefault();
        setDragOver(true);
      }}
      onDragOver={(e) => {
        if (!draggable || !draggingId || draggingId === s.id) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
      }}
      onDragLeave={() => {
        setDragOver(false);
      }}
      onDrop={(e) => {
        if (!draggable || !draggingId || draggingId === s.id) return;
        e.preventDefault();
        setDragOver(false);
        onDropOn(s.id);
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
            <RefreshCw size={14} strokeWidth={2.75} />
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
          {(["active", "completed", "withdrawn", "paused"] as const).map(
            (status) => {
              const n = visibleBoards.filter(
                (b) => (b.status ?? "active") === status,
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
              const status = b.status ?? "active";
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
                    (hasUnread ? "has-unread" : "")
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
                    {hasUnread && (
                      <span
                        className="sidebar-unread-dot"
                        title={t("sidebar.unread_dot_title", {
                          count: b.unread_count,
                        })}
                      />
                    )}
                    {!isDefault && !hasUnread && (
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
    </div>
  );
}

export function Sidebar({
  currentBoardId,
}: {
  currentBoardId: string | null;
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
    const interval = setInterval(fetchSessions, 10000);
    // BoardApp dispatches this when the broker tells it unread counts shifted.
    const onRefresh = () => fetchSessions();
    window.addEventListener("pd-sidebar-refresh", onRefresh);
    return () => {
      cancelled = true;
      clearInterval(interval);
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

  const reorderTo = (fromId: string, toId: string) => {
    if (fromId === toId) return;
    const ids = orderedActive.map((s) => s.id);
    const fromIdx = ids.indexOf(fromId);
    const toIdx = ids.indexOf(toId);
    if (fromIdx < 0 || toIdx < 0) return;
    ids.splice(fromIdx, 1);
    // When dragging downward, removing fromIdx shifts the target one slot
    // earlier; when dragging upward, the target's index is unchanged.
    const insertAt = fromIdx < toIdx ? toIdx - 1 : toIdx;
    ids.splice(insertAt, 0, fromId);
    updateSettings({ sessionOrder: ids });
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
            filter={filter}
            inactive={false}
            collapsed={!!settings.collapsedSessions[s.id]}
            onToggleCollapse={toggleCollapse}
            draggingId={draggingId}
            onDragStart={setDraggingId}
            onDragEnd={() => setDraggingId(null)}
            onDropOn={(targetId) => reorderTo(draggingId ?? "", targetId)}
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
