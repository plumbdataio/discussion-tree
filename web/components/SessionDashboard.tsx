import React, { useEffect, useState } from "react";
import {
  Archive,
  ArchiveRestore,
  ChevronDown,
  ChevronRight,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import type { SessionListItem } from "../../shared/types.ts";
import { AppLayout } from "./AppShell.tsx";
import { ContextMeter } from "./ContextMeter.tsx";
import { EditableSessionName } from "./EditableSessionName.tsx";
import { MultiSelectDropdown } from "./MultiSelectDropdown.tsx";
import { SessionActivityIcons } from "./SessionActivityIcons.tsx";
import { UsageLimitsChip } from "./UsageLimitsChip.tsx";
import { useUsageLimits } from "../utils/usageLimits.ts";
import { BOARD_STATUSES, normalizeBoardStatus } from "../utils/constants.ts";
import { isBoardVisible, statusListToFilter } from "../utils/boardFilter.ts";
import { openScheduledList } from "../utils/scheduledList.ts";
import { useDocumentTitle } from "../utils/useDocumentTitle.ts";
import { boardTitle } from "../utils/boardTitle.ts";

export function SessionDashboard({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation();
  // Account-global 5h/7d usage, fed by the Sidebar's poll via the shared store.
  const usageLimits = useUsageLimits();
  const [data, setData] = useState<SessionListItem | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [showArchived, setShowArchived] = useState(false);
  // Board status filter, local to this screen (independent of the sidebar's
  // own persisted filter). Defaults to discussing-only so a session with many
  // settled/completed boards opens on just the live ones. Held as the list of
  // enabled statuses (MultiSelectDropdown's shape); an empty list means "no
  // filter" = show every status (matches the dropdown's allLabel semantics).
  const [statusFilter, setStatusFilter] = useState<string[]>(["discussing"]);

  // The component now persists across /session/A → /session/B navigation (no
  // `key` remount under the SPA shell), so clear the view when the session id
  // changes — otherwise a prior not-found `error` would stick (the success path
  // can't render past `if (error) return`) and session A's data would flash
  // under session B's URL until the refetch resolves. (Keyed on sessionId only,
  // so an in-place refreshKey bump from archive/unarchive doesn't blank the
  // page.)
  useEffect(() => {
    setData(null);
    setError(null);
  }, [sessionId]);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/sessions")
      .then((r) => r.json())
      .then((d: { sessions: SessionListItem[] }) => {
        if (cancelled) return;
        const found = d.sessions.find((s) => s.id === sessionId);
        if (found) {
          setData(found);
          setError(null);
        } else {
          setError(
            t("session_dashboard.session_not_found", { id: sessionId }),
          );
        }
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, refreshKey, t]);

  // Keep the board-list live like the sidebar: the header now shows the
  // session's activity/subagent/bg/timer chips and each card shows unread /
  // needs-reply, all of which change under the user. Without a refresh they'd
  // freeze at the last fetch (a "working" spinner could sit stale). Poll on the
  // same 10s cadence as the sidebar, and refresh immediately on the shared
  // `pd-sidebar-refresh` window event (rename / read / status changes dispatch
  // it) so the two views never disagree for long. A refetch replaces `data` in
  // place (setData(null) only runs on sessionId change), so no blank flash.
  useEffect(() => {
    const id = setInterval(() => setRefreshKey((k) => k + 1), 10000);
    const onRefresh = () => setRefreshKey((k) => k + 1);
    window.addEventListener("pd-sidebar-refresh", onRefresh);
    return () => {
      clearInterval(id);
      window.removeEventListener("pd-sidebar-refresh", onRefresh);
    };
  }, []);

  // Browser-tab + auto-tracker friendly title (shared hook). The root
  // dashboard, which has no session, keeps the bare "discussion-tree".
  useDocumentTitle([data?.name]);

  const handleArchive = async (boardId: string, title: string) => {
    if (!confirm(t("session_dashboard.archive_confirm", { title }))) return;
    const res = await fetch("/archive-board", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ board_id: boardId }),
    });
    if (!res.ok) {
      alert(
        t("session_dashboard.archive_failed_http", { status: res.status }),
      );
      return;
    }
    setRefreshKey((k) => k + 1);
  };

  const handleUnarchive = async (boardId: string) => {
    const res = await fetch("/unarchive-board", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ board_id: boardId }),
    });
    if (!res.ok) {
      alert(
        t("session_dashboard.unarchive_failed_http", { status: res.status }),
      );
      return;
    }
    setRefreshKey((k) => k + 1);
  };

  if (error)
    return (
      <AppLayout
        header={
          <header className="header">
            <a className="breadcrumb" href="/">
              {t("session_dashboard.back_to_top")}
            </a>
          </header>
        }
      >
        <div className="error">{error}</div>
      </AppLayout>
    );
  if (!data)
    return (
      <AppLayout
        header={
          <header className="header">
            <a className="breadcrumb" href="/">
              {t("session_dashboard.back_to_top")}
            </a>
            <h1>{t("sidebar.loading")}</h1>
          </header>
        }
      >
        <div className="empty">{t("sidebar.loading")}</div>
      </AppLayout>
    );

  const boardStatusLabel = (status: string | undefined) => {
    const s = normalizeBoardStatus(status);
    return t([`board_status.${s}`, s]);
  };

  // Enabled statuses → the BoardStatusFilter object isBoardVisible expects
  // (empty selection = no filter = every status on).
  const boardFilterObj = statusListToFilter(statusFilter);
  // No board is "open" on this screen, so currentBoardId = null. Same semantics
  // as the sidebar (default conversation board always shows), and the same
  // array order — neither the sidebar nor this screen sorts data.boards.
  const visibleBoards = data.boards.filter((b) =>
    isBoardVisible(b, boardFilterObj, null),
  );
  // Per-status counts for the dropdown, taken from the full list BEFORE this
  // axis's selection applies (so a count doesn't drop to 0 when you deselect
  // it and stops telling you what turning it back on would reveal).
  const statusCounts: Record<string, number> = {};
  for (const b of data.boards) {
    const s = normalizeBoardStatus(b.status);
    statusCounts[s] = (statusCounts[s] ?? 0) + 1;
  }
  const statusOptions = BOARD_STATUSES.map((s) => ({
    value: s,
    label: t([`board_status.${s}`, s]),
    count: statusCounts[s] ?? 0,
  }));

  return (
    <AppLayout
      header={
        <header className="header">
          <a className="breadcrumb" href="/">
            {t("session_dashboard.back_to_top")}
          </a>
          <h1 className="session-name-h1">
            <EditableSessionName
              sessionId={data.id}
              name={data.name ?? null}
              onSaved={(newName) => {
                setData({ ...data, name: newName === "" ? null : newName });
                // Nudge the sidebar in this tab; other tabs catch up on poll.
                window.dispatchEvent(new Event("pd-sidebar-refresh"));
              }}
            />
          </h1>
          <ContextMeter usage={data.context_usage} prefix="Context: " />
          {/* Account-global 5h/7d usage, between Context and the working cluster
              (where the old statusline userscript put it). */}
          <UsageLimitsChip limits={usageLimits} />
          {/* Same live indicator cluster the sidebar shows for this session.
              CTX chip suppressed here because the ContextMeter above already
              carries context — see SessionActivityIcons' showCtxChip. */}
          <SessionActivityIcons
            session={data}
            onOpenScheduledList={openScheduledList}
            showCtxChip={false}
          />
        </header>
      }
    >
      <div className="dashboard">
          <div className="dashboard-toolbar">
            <h2 className="dashboard-title">
              {t("session_dashboard.boards_title")}
            </h2>
            <MultiSelectDropdown
              label={t("sidebar.status_filter_label")}
              options={statusOptions}
              selected={statusFilter}
              onChange={setStatusFilter}
              allLabel={t("session_dashboard.status_filter_all")}
            />
          </div>
          {data.boards.length === 0 ? (
            <div className="empty">{t("session_dashboard.no_boards_help")}</div>
          ) : visibleBoards.length === 0 ? (
            <div className="empty">
              {t("session_dashboard.no_boards_match_filter")}
            </div>
          ) : null}
          <div className="board-cards">
            {visibleBoards.map((b) => (
              <div
                key={b.id}
                className={`board-card-wrap board-status-${b.status ?? "discussing"}`}
              >
                <a href={"/board/" + b.id} className="board-card">
                  <div className="card-header">
                    <h3 className="card-title">
                      {boardTitle(b, t)}
                    </h3>
                    {/* needs-reply badge + unread dot, matching the sidebar's
                        board-row cues (same classes). The needs-reply count is
                        shown here as the ① badge instead of the text stat below
                        so it isn't surfaced twice. */}
                    <span className="card-header-flags">
                      {b.stats.needs_reply > 0 && (
                        <span
                          className="sidebar-needs-reply-badge"
                          title={t("sidebar.needs_reply_title", {
                            count: b.stats.needs_reply,
                          })}
                        >
                          {b.stats.needs_reply}
                        </span>
                      )}
                      {(b.unread_count ?? 0) > 0 && (
                        <span
                          className="sidebar-unread-dot"
                          title={t("sidebar.unread_dot_title", {
                            count: b.unread_count,
                          })}
                        />
                      )}
                      <span className="board-status-pill">
                        <span className="board-status-dot" />
                        {boardStatusLabel(b.status)}
                      </span>
                    </span>
                  </div>
                  <div className="card-stats-label">
                    {t("session_dashboard.node_stats_label")}
                  </div>
                  <div className="card-stats">
                    <span className="stat">
                      {t("session_dashboard.open_total", {
                        open: b.stats.open,
                        total: b.stats.total,
                      })}
                    </span>
                    {b.stats.decided > 0 && (
                      <span className="stat decided">
                        {t("session_dashboard.decided_count", {
                          count: b.stats.decided,
                        })}
                      </span>
                    )}
                  </div>
                </a>
                <button
                  className="card-archive"
                  title={t("session_dashboard.archive_button")}
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    handleArchive(b.id, b.title);
                  }}
                >
                  <Archive size={16} strokeWidth={1.75} />
                </button>
              </div>
            ))}
          </div>

          {(data.archived_boards?.length ?? 0) > 0 && (
            <div className="archived-section">
              <button
                type="button"
                className="archived-toggle"
                onClick={() => setShowArchived((v) => !v)}
              >
                {showArchived ? (
                  <ChevronDown size={14} strokeWidth={1.75} />
                ) : (
                  <ChevronRight size={14} strokeWidth={1.75} />
                )}
                <span>
                  {t("session_dashboard.archived_label", {
                    count: data.archived_boards!.length,
                  })}
                </span>
              </button>
              {showArchived && (
                <div className="board-cards archived">
                  {data.archived_boards!.map((b) => (
                    <div
                      key={b.id}
                      className={`board-card-wrap board-status-${b.status ?? "discussing"} archived-card`}
                    >
                      <a href={"/board/" + b.id} className="board-card">
                        <div className="card-header">
                          <h3 className="card-title">
                      {b.is_default ? t("default_board.title") : b.title}
                    </h3>
                          <span className="board-status-pill">
                            <span className="board-status-dot" />
                            {boardStatusLabel(b.status)}
                          </span>
                        </div>
                        <div className="card-stats">
                          <span className="stat">
                            {t("session_dashboard.open_total", {
                              open: b.stats.open,
                              total: b.stats.total,
                            })}
                          </span>
                        </div>
                      </a>
                      <button
                        className="card-archive card-unarchive"
                        title={t("session_dashboard.unarchive_button")}
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          handleUnarchive(b.id);
                        }}
                      >
                        <ArchiveRestore size={16} strokeWidth={1.75} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
      </div>
    </AppLayout>
  );
}
