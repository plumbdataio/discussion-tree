import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { SessionListItem } from "../../shared/types.ts";
import { Sidebar } from "./Sidebar.tsx";

export function RootDashboard() {
  const { t } = useTranslation();
  const [sessions, setSessions] = useState<SessionListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/sessions")
      .then((r) => r.json())
      .then((d: { sessions: SessionListItem[] }) => setSessions(d.sessions))
      .catch((e) => setError(String(e)));
  }, []);

  if (error) return <div className="error">{error}</div>;
  if (!sessions) return <div className="empty">{t("sidebar.loading")}</div>;

  return (
    <div className="app">
      <header className="header">
        <h1>parallel-discussion</h1>
        <span className="meta">
          {t("root_dashboard.active_sessions_meta", { count: sessions.length })}
        </span>
      </header>
      <div className="app-body">
        <Sidebar currentBoardId={null} />
        <div className="dashboard">
          <h2 className="dashboard-title">{t("sidebar.sessions")}</h2>
          {sessions.length === 0 && (
            <div className="empty">{t("sidebar.no_active_sessions")}</div>
          )}
          <div className="board-cards">
            {sessions.map((s) => (
              <a
                key={s.id}
                href={"/session/" + s.id}
                className="board-card"
              >
                <h3 className="card-title">
                  {s.name ?? <em className="unnamed">{s.id}</em>}
                </h3>
                <div className="session-card-cwd" title={s.cwd}>
                  {s.cwd}
                </div>
                <div className="card-stats">
                  <span className="stat">
                    {t("root_dashboard.boards_count_stat", {
                      count: s.boards.length,
                    })}
                  </span>
                </div>
              </a>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
