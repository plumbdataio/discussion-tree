import React, { useCallback, useEffect, useState } from "react";
import { Inbox, List, LayoutGrid } from "lucide-react";
import { useTranslation } from "react-i18next";
import { subscribeOpenSessionIssues } from "../utils/sessionIssues.ts";

// Phase 1 of the per-session issue view (variant A): a global modal that
// projects the session's item nodes into status lanes. Rendered once in
// frontend.tsx; opened from the sidebar's per-session "issues" entry. Being a
// modal (not a route) means document.title never changes, so the Clockify
// title-based time tracker keeps attributing to the session you're on.

type IssueLane = "wait" | "prog" | "todo" | "done";
type Issue = {
  board_id: string;
  board_title: string;
  is_default: number;
  node_id: string;
  title: string;
  status: string;
  lane: IssueLane;
  updated_at: string | null;
};
type IssuesData = {
  session_name: string | null;
  issues: Issue[];
  counts: Record<IssueLane, number>;
};

const LANES: IssueLane[] = ["wait", "prog", "todo", "done"];
const VIEW_KEY = "pd-issues-view";

function useView(): [("table" | "kanban"), (v: "table" | "kanban") => void] {
  const [view, setView] = useState<"table" | "kanban">(() => {
    if (typeof localStorage === "undefined") return "table";
    return localStorage.getItem(VIEW_KEY) === "kanban" ? "kanban" : "table";
  });
  const set = useCallback((v: "table" | "kanban") => {
    setView(v);
    try {
      localStorage.setItem(VIEW_KEY, v);
    } catch {
      /* private mode — in-memory only */
    }
  }, []);
  return [view, set];
}

// Short relative age from an ISO timestamp: "5m" / "3h" / "2d". Blank when
// there's no activity yet (a freshly-added node with no thread).
function formatAge(iso: string | null): string {
  if (!iso) return "—";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "—";
  const s = Math.max(0, (Date.now() - then) / 1000);
  if (s < 60) return "now";
  const m = s / 60;
  if (m < 60) return `${Math.floor(m)}m`;
  const h = m / 60;
  if (h < 24) return `${Math.floor(h)}h`;
  return `${Math.floor(h / 24)}d`;
}

export function SessionIssuesModal() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [fallbackName, setFallbackName] = useState<string | null>(null);
  const [data, setData] = useState<IssuesData | null>(null);
  const [loading, setLoading] = useState(false);
  const [view, setView] = useView();

  const refetch = useCallback((sid: string) => {
    setLoading(true);
    fetch(`/api/session-issues/${sid}`)
      .then((r) => r.json())
      .then((j) => setData(j as IssuesData))
      .catch(() => {
        /* keep the previous list on a blip */
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(
    () =>
      subscribeOpenSessionIssues((target) => {
        setSessionId(target.sessionId);
        setFallbackName(target.sessionName);
        setData(null);
        setOpen(true);
        refetch(target.sessionId);
      }),
    [refetch],
  );

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  if (!open) return null;

  const issues = data?.issues ?? [];
  const counts = data?.counts ?? { wait: 0, prog: 0, todo: 0, done: 0 };
  const name = data?.session_name ?? fallbackName ?? "?";

  const laneLabel = (l: IssueLane) => t(`issues.lane_${l}`);
  const boardName = (i: Issue) =>
    i.is_default ? t("default_board.title") : i.board_title;

  const close = () => setOpen(false);

  const Card = ({ i }: { i: Issue }) => (
    <a
      href={"/board/" + i.board_id}
      className={`issue-card issue-lane-${i.lane}`}
      onClick={close}
      title={i.title}
    >
      <span className="issue-card-title">{i.title}</span>
      <span className="issue-card-foot">
        <span className="issue-src">{boardName(i)}</span>
        <span className="issue-age">{formatAge(i.updated_at)}</span>
      </span>
    </a>
  );

  return (
    <div className="modal-backdrop" onClick={close}>
      <div
        className="modal-content node-modal session-issues-modal"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          className="modal-close"
          onClick={close}
          aria-label={t("modal.close")}
          title={t("modal.close")}
        >
          ×
        </button>

        <div className="node-modal-header issues-header">
          <h2 className="node-modal-title">
            <Inbox size={16} strokeWidth={2} /> {t("issues.title")}
            <span className="issues-session">{name}</span>
          </h2>
          <div className="issues-header-right">
            {counts.wait > 0 && (
              <span className="issues-wait-badge">
                <span className="issue-dot issue-lane-wait" />
                {t("issues.waiting_on_you", { count: counts.wait })}
              </span>
            )}
            <div className="issues-view-toggle" role="tablist">
              <button
                type="button"
                className={view === "table" ? "active" : ""}
                onClick={() => setView("table")}
                aria-label={t("issues.view_table")}
                title={t("issues.view_table")}
              >
                <List size={14} strokeWidth={2} />
              </button>
              <button
                type="button"
                className={view === "kanban" ? "active" : ""}
                onClick={() => setView("kanban")}
                aria-label={t("issues.view_kanban")}
                title={t("issues.view_kanban")}
              >
                <LayoutGrid size={14} strokeWidth={2} />
              </button>
            </div>
          </div>
        </div>

        {issues.length === 0 ? (
          <div className="issues-empty">
            {loading ? t("sidebar.loading") : t("issues.empty")}
          </div>
        ) : view === "table" ? (
          <div className="issues-table-scroll">
            <table className="issues-table">
              <thead>
                <tr>
                  <th className="col-status">{t("issues.col_status")}</th>
                  <th className="col-issue">{t("issues.col_issue")}</th>
                  <th className="col-src">{t("issues.col_source")}</th>
                  <th className="col-age">{t("issues.col_updated")}</th>
                </tr>
              </thead>
              <tbody>
                {LANES.flatMap((lane) =>
                  issues
                    .filter((i) => i.lane === lane)
                    .map((i) => (
                      <tr
                        key={i.board_id + "/" + i.node_id}
                        className={`issue-row issue-lane-${i.lane}`}
                      >
                        <td className="col-status">
                          <span className={`issue-pill issue-lane-${i.lane}`}>
                            <span className="issue-dot" />
                            {laneLabel(i.lane)}
                          </span>
                        </td>
                        <td className="col-issue">
                          <a
                            href={"/board/" + i.board_id}
                            className="issue-link"
                            onClick={close}
                          >
                            {i.title}
                          </a>
                        </td>
                        <td className="col-src">{boardName(i)}</td>
                        <td className="col-age">
                          <span className="issue-age">
                            {formatAge(i.updated_at)}
                          </span>
                        </td>
                      </tr>
                    )),
                )}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="issues-kanban">
            {LANES.map((lane) => {
              const list = issues.filter((i) => i.lane === lane);
              return (
                <div key={lane} className={`issue-col issue-lane-${lane}`}>
                  <div className="issue-col-head">
                    <span className="issue-dot" />
                    <span className="issue-col-label">{laneLabel(lane)}</span>
                    <span className="issue-col-count">{list.length}</span>
                  </div>
                  <div className="issue-col-cards">
                    {list.map((i) => (
                      <Card key={i.board_id + "/" + i.node_id} i={i} />
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
