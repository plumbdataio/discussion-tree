import React, { useEffect, useState } from "react";
import {
  Archive,
  ArchiveRestore,
  ChevronDown,
  ChevronRight,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import type { SessionListItem } from "../../shared/types.ts";
import { EditableSessionName } from "./EditableSessionName.tsx";
import { Sidebar } from "./Sidebar.tsx";
import { normalizeBoardStatus } from "../utils/constants.ts";

export function SessionDashboard({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation();
  const [data, setData] = useState<SessionListItem | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [showArchived, setShowArchived] = useState(false);

  useEffect(() => {
    fetch("/api/sessions")
      .then((r) => r.json())
      .then((d: { sessions: SessionListItem[] }) => {
        const found = d.sessions.find((s) => s.id === sessionId);
        if (found) setData(found);
        else
          setError(t("session_dashboard.session_not_found", { id: sessionId }));
      })
      .catch((e) => setError(String(e)));
  }, [sessionId, refreshKey, t]);

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

  if (error) return <div className="error">{error}</div>;
  if (!data) return <div className="empty">{t("sidebar.loading")}</div>;

  const boardStatusLabel = (status: string | undefined) => {
    const s = normalizeBoardStatus(status);
    return t([`board_status.${s}`, s]);
  };

  return (
    <div className="app">
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
        <span className="meta">
          {t("session_dashboard.session_meta_boards", {
            cwd: data.cwd,
            count: data.boards.length,
          })}
        </span>
      </header>
      <div className="app-body">
        <Sidebar currentBoardId={null} />
        <div className="dashboard">
          <h2 className="dashboard-title">{t("session_dashboard.boards_title")}</h2>
          {data.boards.length === 0 && (
            <div className="empty">{t("session_dashboard.no_boards_help")}</div>
          )}
          <div className="board-cards">
            {data.boards.map((b) => (
              <div
                key={b.id}
                className={`board-card-wrap board-status-${b.status ?? "discussing"}`}
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
                  <div className="card-stats-label">
                    {t("session_dashboard.node_stats_label")}
                  </div>
                  <div className="card-stats">
                    {b.stats.needs_reply > 0 && (
                      <span className="stat needs-reply">
                        {t("session_dashboard.needs_reply_count", {
                          count: b.stats.needs_reply,
                        })}
                      </span>
                    )}
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
      </div>
    </div>
  );
}
