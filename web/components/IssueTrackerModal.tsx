import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  ClipboardList,
  Plus,
  Trash2,
  RotateCcw,
  Table2,
  Columns3,
  Search,
  X,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { MDView } from "./MDView.tsx";
import { ResizableTextarea } from "./ResizableTextarea.tsx";
import { ConfirmDialog } from "./ConfirmDialog.tsx";
import {
  DEFAULT_FILTERS,
  ISSUE_OWNERS,
  ISSUE_STATES,
  createIssue,
  deleteIssue,
  fetchIssues,
  loadFilters,
  notifyIssuesChanged,
  restoreIssue,
  sanitizeFilters,
  saveFilters,
  subscribeOpenIssueTracker,
  updateIssue,
  type Issue,
  type IssueFilters,
  type IssueOwner,
  type IssueState,
} from "../utils/issues.ts";

// The cross-session issue ledger. Rendered once (frontend.tsx) and opened from
// the sidebar; see web/utils/issues.ts for why this is a modal and not a page.
//
// The rule this view is built around: an issue row must hold something that
// lives NOWHERE else, and closing it must mean something. Its predecessor was a
// projection of node statuses — it showed only what the sidebar already showed
// and nothing could be worked in it, so it was never opened. Hence: real rows,
// edited in place, closed here.

// Owner sorts before recency so the user's own pile stays at the top even when
// CC has just touched something.
const OWNER_RANK: Record<IssueOwner, number> = { user: 0, cc: 1, external: 2 };
const STATE_RANK: Record<IssueState, number> = {
  doing: 0,
  todo: 1,
  done: 2,
  dropped: 3,
};

type Draft = {
  id: string | null;
  title: string;
  body: string;
  owner: IssueOwner;
  state: IssueState;
};

const emptyDraft = (): Draft => ({
  id: null,
  title: "",
  body: "",
  owner: "cc",
  state: "todo",
});

function OwnerStateChip({ issue }: { issue: Issue }) {
  const { t } = useTranslation();
  return (
    <span className={`issue-chip owner-${issue.owner} state-${issue.state}`}>
      <span className="issue-chip-owner">{t(`issues.owner.${issue.owner}`)}</span>
      <span className="issue-chip-sep">/</span>
      <span className="issue-chip-state">{t(`issues.state.${issue.state}`)}</span>
    </span>
  );
}

export function IssueTrackerModal() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [loading, setLoading] = useState(false);
  const [filters, setFilters] = useState<IssueFilters>(DEFAULT_FILTERS);
  const [filtersLoaded, setFiltersLoaded] = useState(false);
  const [view, setView] = useState<"table" | "board">("table");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<Issue | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refetch = useCallback(
    (includeDeleted: boolean) => {
      setLoading(true);
      fetchIssues(includeDeleted)
        .then((r) => setIssues(r.issues ?? []))
        .catch(() => {
          /* keep the previous list on a blip rather than blanking the view */
        })
        .finally(() => setLoading(false));
    },
    [],
  );

  useEffect(
    () =>
      subscribeOpenIssueTracker(() => {
        setOpen(true);
        // Filters live in the DB (not localStorage) so they are the same in
        // every browser — read them once per open, not per mount.
        loadFilters()
          .then((r) => {
            const f = r.filters ? sanitizeFilters(r.filters) : DEFAULT_FILTERS;
            setFilters(f);
            refetch(f.showDeleted);
          })
          .catch(() => refetch(false))
          .finally(() => setFiltersLoaded(true));
      }),
    [refetch],
  );

  // Persist whenever the user changes a filter — but never on the initial load,
  // which would write the defaults back over what they had saved.
  useEffect(() => {
    if (!open || !filtersLoaded) return;
    const id = setTimeout(() => {
      void saveFilters(filters);
    }, 400);
    return () => clearTimeout(id);
  }, [filters, open, filtersLoaded]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      // Esc closes the editor first, then the modal, so a half-written issue
      // isn't lost to a stray keypress.
      if (e.key !== "Escape") return;
      if (draft) setDraft(null);
      else setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, draft]);

  const sessions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const i of issues) {
      if (!i.session_id) continue;
      if (!seen.has(i.session_id)) {
        seen.set(i.session_id, i.session_name || i.session_cwd || i.session_id);
      }
    }
    return [...seen.entries()].map(([id, name]) => ({ id, name }));
  }, [issues]);

  // Text search and session narrow the pool BEFORE the owner/state counts are
  // taken, so the numbers on those chips describe what toggling them would
  // actually reveal — a count that drops to zero because of its own toggle is
  // the bug that made the previous view's lane counts useless.
  const pool = useMemo(() => {
    const q = filters.q.trim().toLowerCase();
    return issues.filter((i) => {
      if (filters.sessionId && i.session_id !== filters.sessionId) return false;
      if (q && !(`${i.title}\n${i.body}`.toLowerCase().includes(q))) return false;
      return true;
    });
  }, [issues, filters.sessionId, filters.q]);

  const ownerCounts = useMemo(() => {
    const c: Record<string, number> = { user: 0, cc: 0, external: 0 };
    for (const i of pool) if (filters.states.includes(i.state)) c[i.owner]++;
    return c;
  }, [pool, filters.states]);

  const stateCounts = useMemo(() => {
    const c: Record<string, number> = { todo: 0, doing: 0, done: 0, dropped: 0 };
    for (const i of pool) if (filters.owners.includes(i.owner)) c[i.state]++;
    return c;
  }, [pool, filters.owners]);

  const visible = useMemo(
    () =>
      pool
        .filter(
          (i) => filters.owners.includes(i.owner) && filters.states.includes(i.state),
        )
        .sort(
          (a, b) =>
            OWNER_RANK[a.owner] - OWNER_RANK[b.owner] ||
            STATE_RANK[a.state] - STATE_RANK[b.state] ||
            b.updated_at.localeCompare(a.updated_at),
        ),
    [pool, filters.owners, filters.states],
  );

  const toggle = <T extends string>(list: T[], v: T): T[] =>
    list.includes(v) ? list.filter((x) => x !== v) : [...list, v];

  const afterMutation = (includeDeleted: boolean) => {
    refetch(includeDeleted);
    notifyIssuesChanged();
  };

  const submitDraft = async () => {
    if (!draft) return;
    const title = draft.title.trim();
    if (!title) {
      setError(t("issues.error_title_required"));
      return;
    }
    const fields = {
      title,
      body: draft.body,
      owner: draft.owner,
      state: draft.state,
    };
    const r = draft.id
      ? await updateIssue(draft.id, fields)
      : await createIssue(fields);
    if (!r.ok) {
      setError(r.error ?? t("issues.error_generic"));
      return;
    }
    setError(null);
    setDraft(null);
    afterMutation(filters.showDeleted);
  };

  // Changing owner/state straight from a row is the whole point of a ledger you
  // maintain, so it does not go through the editor.
  const quickSet = async (issue: Issue, patch: Partial<Issue>) => {
    const r = await updateIssue(issue.id, patch);
    if (!r.ok) setError(r.error ?? t("issues.error_generic"));
    afterMutation(filters.showDeleted);
  };

  if (!open) return null;

  const fmt = (iso: string) =>
    new Date(iso).toLocaleString([], {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });

  const renderRowBody = (i: Issue) => (
    <div className="issue-row-detail">
      {i.body ? (
        <MDView className="issue-body" text={i.body} />
      ) : (
        <div className="issue-body-empty">{t("issues.no_body")}</div>
      )}
      <div className="issue-row-detail-actions">
        <span className="issue-timestamps">
          {t("issues.created")} {fmt(i.created_at)}
          {i.closed_at ? ` · ${t("issues.closed")} ${fmt(i.closed_at)}` : ""}
        </span>
        {i.deleted_at ? (
          <button
            type="button"
            className="issue-restore"
            onClick={() =>
              restoreIssue(i.id).then(() => afterMutation(filters.showDeleted))
            }
          >
            <RotateCcw size={13} strokeWidth={2} /> {t("issues.restore")}
          </button>
        ) : (
          <>
            <button
              type="button"
              className="issue-edit"
              onClick={() =>
                setDraft({
                  id: i.id,
                  title: i.title,
                  body: i.body,
                  owner: i.owner,
                  state: i.state,
                })
              }
            >
              {t("issues.edit")}
            </button>
            <button
              type="button"
              className="issue-delete"
              onClick={() => setConfirmDelete(i)}
            >
              <Trash2 size={13} strokeWidth={2} /> {t("issues.delete")}
            </button>
          </>
        )}
      </div>
    </div>
  );

  const selects = (i: Issue) => (
    <>
      <select
        className="issue-select"
        value={i.owner}
        aria-label={t("issues.owner_label")}
        onChange={(e) => quickSet(i, { owner: e.target.value as IssueOwner })}
        onClick={(e) => e.stopPropagation()}
      >
        {ISSUE_OWNERS.map((o) => (
          <option key={o} value={o}>
            {t(`issues.owner.${o}`)}
          </option>
        ))}
      </select>
      <select
        className="issue-select"
        value={i.state}
        aria-label={t("issues.state_label")}
        onChange={(e) => quickSet(i, { state: e.target.value as IssueState })}
        onClick={(e) => e.stopPropagation()}
      >
        {ISSUE_STATES.map((s) => (
          <option key={s} value={s}>
            {t(`issues.state.${s}`)}
          </option>
        ))}
      </select>
    </>
  );

  return (
    <div className="modal-backdrop" onClick={() => setOpen(false)}>
      <div
        className="modal-content issue-modal"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          className="modal-close"
          onClick={() => setOpen(false)}
          aria-label={t("modal.close")}
          title={t("modal.close")}
        >
          <X size={18} strokeWidth={1.75} />
        </button>

        <div className="issue-modal-head">
          <h2 className="issue-modal-title">
            <ClipboardList size={16} strokeWidth={2} /> {t("issues.title")}
            <span className="issue-count">{visible.length}</span>
          </h2>
          <div className="issue-head-actions">
            <div className="issue-view-toggle" role="group">
              <button
                type="button"
                className={view === "table" ? "active" : ""}
                onClick={() => setView("table")}
                title={t("issues.view_table")}
                aria-label={t("issues.view_table")}
              >
                <Table2 size={14} strokeWidth={2} />
              </button>
              <button
                type="button"
                className={view === "board" ? "active" : ""}
                onClick={() => setView("board")}
                title={t("issues.view_board")}
                aria-label={t("issues.view_board")}
              >
                <Columns3 size={14} strokeWidth={2} />
              </button>
            </div>
            <button
              type="button"
              className="issue-new"
              onClick={() => {
                setError(null);
                setDraft(emptyDraft());
              }}
            >
              <Plus size={14} strokeWidth={2.25} /> {t("issues.new")}
            </button>
          </div>
        </div>

        <div className="issue-filters">
          <div className="issue-filter-group">
            {ISSUE_OWNERS.map((o) => (
              <button
                key={o}
                type="button"
                className={
                  `issue-filter-chip owner-${o}` +
                  (filters.owners.includes(o) ? " on" : "")
                }
                onClick={() =>
                  setFilters((f) => ({ ...f, owners: toggle(f.owners, o) }))
                }
              >
                {t(`issues.owner.${o}`)}
                <span className="issue-filter-n">{ownerCounts[o]}</span>
              </button>
            ))}
          </div>
          <div className="issue-filter-group">
            {ISSUE_STATES.map((s) => (
              <button
                key={s}
                type="button"
                className={
                  `issue-filter-chip state-${s}` +
                  (filters.states.includes(s) ? " on" : "")
                }
                onClick={() =>
                  setFilters((f) => ({ ...f, states: toggle(f.states, s) }))
                }
              >
                {t(`issues.state.${s}`)}
                <span className="issue-filter-n">{stateCounts[s]}</span>
              </button>
            ))}
          </div>
          <div className="issue-filter-group grow">
            <label className="issue-search">
              <Search size={13} strokeWidth={2} />
              <input
                type="text"
                value={filters.q}
                placeholder={t("issues.search_placeholder")}
                onChange={(e) =>
                  setFilters((f) => ({ ...f, q: e.target.value }))
                }
              />
            </label>
            <select
              className="issue-select"
              value={filters.sessionId ?? ""}
              aria-label={t("issues.session_label")}
              onChange={(e) =>
                setFilters((f) => ({ ...f, sessionId: e.target.value || null }))
              }
            >
              <option value="">{t("issues.all_sessions")}</option>
              {sessions.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
            <button
              type="button"
              className={
                "issue-filter-chip bin" + (filters.showDeleted ? " on" : "")
              }
              onClick={() =>
                setFilters((f) => {
                  const next = !f.showDeleted;
                  refetch(next);
                  return { ...f, showDeleted: next };
                })
              }
              title={t("issues.bin_hint")}
            >
              <Trash2 size={12} strokeWidth={2} /> {t("issues.bin")}
            </button>
            <button
              type="button"
              className="issue-reset"
              onClick={() => {
                setFilters(DEFAULT_FILTERS);
                refetch(false);
              }}
            >
              {t("issues.reset")}
            </button>
          </div>
        </div>

        {error && <div className="modal-error">{error}</div>}

        {draft && (
          <div className="issue-editor">
            <input
              className="issue-editor-title"
              type="text"
              value={draft.title}
              autoFocus
              placeholder={t("issues.title_placeholder")}
              onChange={(e) =>
                setDraft((d) => d && { ...d, title: e.target.value })
              }
            />
            <ResizableTextarea
              className="issue-editor-body"
              rows={6}
              value={draft.body}
              placeholder={t("issues.body_placeholder")}
              onChange={(e) =>
                setDraft((d) => d && { ...d, body: e.target.value })
              }
              onKeyDown={(e) => {
                if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
                  e.preventDefault();
                  void submitDraft();
                }
              }}
            />
            <div className="issue-editor-actions">
              <select
                className="issue-select"
                value={draft.owner}
                aria-label={t("issues.owner_label")}
                onChange={(e) =>
                  setDraft(
                    (d) => d && { ...d, owner: e.target.value as IssueOwner },
                  )
                }
              >
                {ISSUE_OWNERS.map((o) => (
                  <option key={o} value={o}>
                    {t(`issues.owner.${o}`)}
                  </option>
                ))}
              </select>
              <select
                className="issue-select"
                value={draft.state}
                aria-label={t("issues.state_label")}
                onChange={(e) =>
                  setDraft(
                    (d) => d && { ...d, state: e.target.value as IssueState },
                  )
                }
              >
                {ISSUE_STATES.map((s) => (
                  <option key={s} value={s}>
                    {t(`issues.state.${s}`)}
                  </option>
                ))}
              </select>
              <span className="grow" />
              <button
                type="button"
                className="modal-cancel"
                onClick={() => setDraft(null)}
              >
                {t("issues.cancel")}
              </button>
              <button
                type="button"
                className="modal-submit"
                disabled={!draft.title.trim()}
                onClick={() => void submitDraft()}
              >
                {draft.id ? t("issues.save") : t("issues.create")}
              </button>
            </div>
          </div>
        )}

        {visible.length === 0 ? (
          <div className="issue-empty">
            {loading ? t("sidebar.loading") : t("issues.empty")}
          </div>
        ) : view === "table" ? (
          <table className="issue-table">
            <tbody>
              {visible.map((i) => (
                <React.Fragment key={i.id}>
                  <tr
                    className={
                      "issue-row" +
                      (i.deleted_at ? " deleted" : "") +
                      (expanded === i.id ? " expanded" : "")
                    }
                    onClick={() => setExpanded(expanded === i.id ? null : i.id)}
                  >
                    <td className="issue-cell-chip">
                      <OwnerStateChip issue={i} />
                    </td>
                    <td className="issue-cell-title">
                      {i.title}
                      {i.deleted_at && (
                        <span className="issue-deleted-tag">
                          {t("issues.deleted")}
                        </span>
                      )}
                    </td>
                    <td className="issue-cell-session">
                      {i.session_name || ""}
                    </td>
                    <td className="issue-cell-updated">{fmt(i.updated_at)}</td>
                    <td className="issue-cell-controls">
                      {/* The flex row is a div, not the td: a td with
                          display:flex leaves the table's column model, and the
                          other cells stop lining up. */}
                      <div className="issue-controls-row">
                        {!i.deleted_at && selects(i)}
                      </div>
                    </td>
                  </tr>
                  {expanded === i.id && (
                    <tr className="issue-detail-row">
                      <td colSpan={5}>{renderRowBody(i)}</td>
                    </tr>
                  )}
                </React.Fragment>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="issue-board">
            {ISSUE_STATES.filter((s) => filters.states.includes(s)).map((s) => (
              <div key={s} className={`issue-col state-${s}`}>
                <div className="issue-col-head">
                  {t(`issues.state.${s}`)}
                  <span className="issue-filter-n">
                    {visible.filter((i) => i.state === s).length}
                  </span>
                </div>
                <div className="issue-col-body">
                  {visible
                    .filter((i) => i.state === s)
                    .map((i) => (
                      <div
                        key={i.id}
                        className={
                          "issue-card" + (i.deleted_at ? " deleted" : "")
                        }
                        onClick={() =>
                          setExpanded(expanded === i.id ? null : i.id)
                        }
                      >
                        <div className="issue-card-top">
                          <OwnerStateChip issue={i} />
                          <span className="issue-card-session">
                            {i.session_name || ""}
                          </span>
                        </div>
                        <div className="issue-card-title">{i.title}</div>
                        {expanded === i.id && renderRowBody(i)}
                        {!i.deleted_at && (
                          <div className="issue-card-controls">{selects(i)}</div>
                        )}
                      </div>
                    ))}
                </div>
              </div>
            ))}
          </div>
        )}

        {confirmDelete && (
          <ConfirmDialog
            title={t("issues.delete_title")}
            message={t("issues.delete_body")}
            confirmLabel={t("issues.delete")}
            cancelLabel={t("issues.cancel")}
            tone="warn"
            onConfirm={() => {
              const target = confirmDelete;
              setConfirmDelete(null);
              void deleteIssue(target.id).then(() =>
                afterMutation(filters.showDeleted),
              );
            }}
            onCancel={() => setConfirmDelete(null)}
          />
        )}
      </div>
    </div>
  );
}
