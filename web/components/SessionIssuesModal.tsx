import React, { useCallback, useEffect, useState } from "react";
import { Inbox, List, LayoutGrid, SlidersHorizontal } from "lucide-react";
import { useTranslation } from "react-i18next";
import { subscribeOpenSessionIssues } from "../utils/sessionIssues.ts";

// Phase 1 of the per-session issue view (variant A): a global modal that
// projects the session's item nodes into status lanes. Rendered once in
// frontend.tsx; opened from the sidebar's per-session "issues" entry. Being a
// modal (not a route) means document.title never changes, so the Clockify
// title-based time tracker keeps attributing to the session you're on.
//
// Filters (which lanes, whether to include closed/settled boards, an optional
// "updated within" cutoff) are PROJECTION-side and persisted PER SESSION in the
// DB (not localStorage), so the same session reads the same way on any browser.
// The view mode (table/kanban) stays in localStorage — that's a global UI pref.

type IssueLane = "wait" | "prog" | "todo" | "done";
type Issue = {
  board_id: string;
  board_title: string;
  is_default: number;
  board_status: string;
  board_closed: number;
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
  filters: unknown;
};

type IssueFilters = {
  lanes: Record<IssueLane, boolean>;
  includeClosedBoards: boolean;
  maxAgeDays: number | null;
};

const LANES: IssueLane[] = ["wait", "prog", "todo", "done"];
const AGE_OPTIONS: (number | null)[] = [null, 90, 30, 7];
const VIEW_KEY = "pd-issues-view";

// Defaults chosen to fight the "old stuff clutters forever" problem WITHOUT
// baking a personal date cutoff into the code: the noisy settled lane is hidden,
// and items on boards that were wrapped up (closed / settled) drop out. The age
// cutoff defaults to "all" — it's opt-in, and its value lives in the user's DB.
const DEFAULT_FILTERS: IssueFilters = {
  lanes: { wait: true, prog: true, todo: true, done: false },
  includeClosedBoards: false,
  maxAgeDays: null,
};

function normalizeFilters(raw: unknown): IssueFilters {
  const f = (raw ?? {}) as Partial<IssueFilters>;
  const lanes = (f.lanes ?? {}) as Partial<Record<IssueLane, boolean>>;
  return {
    lanes: {
      wait: lanes.wait ?? DEFAULT_FILTERS.lanes.wait,
      prog: lanes.prog ?? DEFAULT_FILTERS.lanes.prog,
      todo: lanes.todo ?? DEFAULT_FILTERS.lanes.todo,
      done: lanes.done ?? DEFAULT_FILTERS.lanes.done,
    },
    includeClosedBoards:
      f.includeClosedBoards ?? DEFAULT_FILTERS.includeClosedBoards,
    maxAgeDays: f.maxAgeDays === undefined ? DEFAULT_FILTERS.maxAgeDays : f.maxAgeDays,
  };
}

function boardIsClosed(i: Issue): boolean {
  return i.board_closed === 1 || i.board_status === "settled";
}

function applyFilters(issues: Issue[], f: IssueFilters): Issue[] {
  const cutoff =
    f.maxAgeDays != null ? Date.now() - f.maxAgeDays * 86400000 : null;
  return issues.filter((i) => {
    if (!f.lanes[i.lane]) return false;
    if (!f.includeClosedBoards && boardIsClosed(i)) return false;
    if (cutoff != null) {
      const ts = i.updated_at ? new Date(i.updated_at).getTime() : 0;
      if (!(ts >= cutoff)) return false;
    }
    return true;
  });
}

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
  const [filters, setFilters] = useState<IssueFilters>(DEFAULT_FILTERS);
  const [showFilters, setShowFilters] = useState(true);

  const refetch = useCallback((sid: string) => {
    setLoading(true);
    fetch(`/api/session-issues/${sid}`)
      .then((r) => r.json())
      .then((j: IssuesData) => {
        setData(j);
        setFilters(normalizeFilters(j.filters));
      })
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

  // Persist filters per session in the DB whenever they change.
  const persist = useCallback(
    (next: IssueFilters) => {
      setFilters(next);
      if (!sessionId) return;
      fetch("/session-issue-filters", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: sessionId, filters: next }),
      }).catch(() => {
        /* best-effort; the in-memory state is already applied */
      });
    },
    [sessionId],
  );

  if (!open) return null;

  const rawIssues = data?.issues ?? [];
  const rawCounts = data?.counts ?? { wait: 0, prog: 0, todo: 0, done: 0 };
  const name = data?.session_name ?? fallbackName ?? "?";
  const visible = applyFilters(rawIssues, filters);

  const laneLabel = (l: IssueLane) => t(`issues.lane_${l}`);
  const boardName = (i: Issue) =>
    i.is_default ? t("default_board.title") : i.board_title;
  const close = () => setOpen(false);

  const toggleLane = (l: IssueLane) =>
    persist({ ...filters, lanes: { ...filters.lanes, [l]: !filters.lanes[l] } });

  const ageLabel = (d: number | null) =>
    d == null ? t("issues.age_all") : t("issues.age_days", { count: d });

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
            {rawCounts.wait > 0 && (
              <span className="issues-wait-badge">
                <span className="issue-dot issue-lane-wait" />
                {t("issues.waiting_on_you", { count: rawCounts.wait })}
              </span>
            )}
            <button
              type="button"
              className={"issues-filter-btn" + (showFilters ? " active" : "")}
              onClick={() => setShowFilters((s) => !s)}
              aria-label={t("issues.filters")}
              title={t("issues.filters")}
            >
              <SlidersHorizontal size={14} strokeWidth={2} />
            </button>
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

        {showFilters && (
          <div className="issues-filter-bar">
            <div className="issues-lane-chips">
              {LANES.map((l) => (
                <button
                  key={l}
                  type="button"
                  className={
                    `issue-chip issue-lane-${l}` +
                    (filters.lanes[l] ? " on" : "")
                  }
                  onClick={() => toggleLane(l)}
                  aria-pressed={filters.lanes[l]}
                >
                  <span className="issue-dot" />
                  {laneLabel(l)}
                  <span className="issue-chip-count">{rawCounts[l]}</span>
                </button>
              ))}
            </div>
            <label className="issues-filter-check">
              <input
                type="checkbox"
                checked={filters.includeClosedBoards}
                onChange={(e) =>
                  persist({ ...filters, includeClosedBoards: e.target.checked })
                }
              />
              {t("issues.include_closed")}
            </label>
            <label className="issues-filter-age">
              {t("issues.age_within")}
              <select
                value={filters.maxAgeDays == null ? "all" : String(filters.maxAgeDays)}
                onChange={(e) =>
                  persist({
                    ...filters,
                    maxAgeDays:
                      e.target.value === "all" ? null : Number(e.target.value),
                  })
                }
              >
                {AGE_OPTIONS.map((d) => (
                  <option key={String(d)} value={d == null ? "all" : String(d)}>
                    {ageLabel(d)}
                  </option>
                ))}
              </select>
            </label>
          </div>
        )}

        {rawIssues.length === 0 ? (
          <div className="issues-empty">
            {loading ? t("sidebar.loading") : t("issues.empty")}
          </div>
        ) : visible.length === 0 ? (
          <div className="issues-empty">{t("issues.empty_filtered")}</div>
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
                  visible
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
            {LANES.filter((l) => filters.lanes[l]).map((lane) => {
              const list = visible.filter((i) => i.lane === lane);
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
