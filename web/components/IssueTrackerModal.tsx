import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ClipboardList,
  Plus,
  Trash2,
  RotateCcw,
  Table2,
  Columns3,
  Search,
  Check,
  MessagesSquare,
  X,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { MDView } from "./MDView.tsx";
import { ResizableTextarea } from "./ResizableTextarea.tsx";
import { ConfirmDialog } from "./ConfirmDialog.tsx";
import { MultiSelectDropdown } from "./MultiSelectDropdown.tsx";
import { IssueTimelineModal } from "./IssueTimelineModal.tsx";
import {
  DEFAULT_FILTERS,
  ISSUE_OWNERS,
  ISSUE_STATES,
  NO_SESSION,
  createIssue,
  deleteIssue,
  fetchIssueSessions,
  fetchIssues,
  loadFilters,
  approveIssueClose,
  rejectIssueClose,
  isAwaitingApproval,
  isVisible,
  notifyIssuesChanged,
  ownerMatches,
  restoreIssue,
  sanitizeFilters,
  saveFilters,
  sessionMatches,
  stateMatches,
  subscribeOpenIssueTracker,
  updateIssue,
  type Issue,
  type IssueFilters,
  type IssueOwner,
  type IssueSession,
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
  sessionId: string | null;
};

// Ids are routinely shortened in prose ("iss_ms5kq850"), so a link carries a
// prefix rather than the full id. The timestamp half is unique in practice.
function matchesFocus(i: Issue, focusId: string | null): boolean {
  return !!focusId && i.id.startsWith(focusId);
}

const emptyDraft = (sessionId: string | null): Draft => ({
  id: null,
  title: "",
  body: "",
  owner: "cc",
  state: "todo",
  sessionId,
});

// A session is named by whoever set it; fall back to the last path segment of
// its cwd, which is what the sidebar shows for unnamed ones.
export function sessionLabel(s: {
  name?: string | null;
  cwd?: string | null;
  id: string;
}): string {
  if (s.name) return s.name;
  if (s.cwd) return s.cwd.split("/").filter(Boolean).pop() || s.cwd;
  return s.id;
}

// The chip is both the current value and the control for it: the header used to
// carry two <select>s per row, which put the editing affordance far from the
// thing being edited and ate a whole column. Clicking here opens both axes at
// once, which is how they are actually changed (owner moves when state does).
function OwnerStateChip({
  issue,
  onSet,
}: {
  issue: Issue;
  onSet?: (patch: Partial<Issue>) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  // TWO pills, not one. A single "owner / state" pill took its colour from the
  // owner alone, so the state — the half that changes as work progresses — was
  // black text on the same background whatever it said. Splitting them lets
  // each axis carry its own colour, which is the only way state reads at a
  // glance in a list sorted by owner.
  const chip = (
    <span className="issue-chips">
      <span className={`issue-chip owner-${issue.owner}`}>
        {t(`issues.owner.${issue.owner}`)}
      </span>
      <span className={`issue-chip state-${issue.state}`}>
        {t(`issues.state.${issue.state}`)}
      </span>
    </span>
  );
  if (!onSet) return chip;

  return (
    <span className="issue-chip-wrap" ref={wrapRef}>
      <button
        type="button"
        className="issue-chip-button"
        title={t("issues.chip_hint")}
        aria-label={t("issues.chip_hint")}
        aria-expanded={open}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
      >
        {chip}
      </button>
      {open && (
        <div className="issue-chip-menu" onClick={(e) => e.stopPropagation()}>
          <div className="issue-chip-menu-row">
            <span className="issue-chip-menu-label">{t("issues.owner_label")}</span>
            {ISSUE_OWNERS.map((o) => (
              <button
                key={o}
                type="button"
                className={`issue-seg owner-${o}${issue.owner === o ? " on" : ""}`}
                onClick={() => onSet({ owner: o })}
              >
                {t(`issues.owner.${o}`)}
              </button>
            ))}
          </div>
          <div className="issue-chip-menu-row">
            <span className="issue-chip-menu-label">{t("issues.state_label")}</span>
            {ISSUE_STATES.map((s) => (
              <button
                key={s}
                type="button"
                className={`issue-seg state-${s}${issue.state === s ? " on" : ""}`}
                onClick={() => onSet({ state: s })}
              >
                {t(`issues.state.${s}`)}
              </button>
            ))}
          </div>
        </div>
      )}
    </span>
  );
}

export function IssueTrackerModal() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [sessions, setSessions] = useState<IssueSession[]>([]);
  const [loading, setLoading] = useState(false);
  const [filters, setFilters] = useState<IssueFilters>(DEFAULT_FILTERS);
  const [filtersLoaded, setFiltersLoaded] = useState(false);
  const [view, setView] = useState<"table" | "board">("table");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<Issue | null>(null);
  const [timelineOf, setTimelineOf] = useState<Issue | null>(null);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Reset per editor session so the warning appears again for the next issue.
  const [sessionWarned, setSessionWarned] = useState(false);

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
      subscribeOpenIssueTracker((focusId) => {
        setOpen(true);
        // Arriving from a link in a message: show that issue expanded, and show
        // it even if the saved filters would exclude it (it is often closed, or
        // owned by another session). Landing on "no results" after following a
        // link would make the links not worth having.
        setFocusId(focusId);
        setExpanded(null); // resolved to a real id once the list arrives
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
        // Sessions come from the broker rather than from the issues on screen:
        // a session you have not filed anything against yet still has to be
        // pickable, otherwise a new issue cannot be filed where you are working.
        fetchIssueSessions()
          .then((r) => setSessions(r.sessions ?? []))
          .catch(() => {
            /* the dropdown just stays empty; filing without a session works */
          });
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

  // Names for sessions referenced by an issue but missing from the broker list
  // (deleted rows can outlive their session), so a row never renders blank.
  const sessionNames = useMemo(() => {
    const m = new Map<string, string>();
    for (const s of sessions) m.set(s.id, sessionLabel(s));
    for (const i of issues) {
      if (i.session_id && !m.has(i.session_id)) {
        m.set(
          i.session_id,
          sessionLabel({
            id: i.session_id,
            name: i.session_name,
            cwd: i.session_cwd,
          }),
        );
      }
    }
    return m;
  }, [sessions, issues]);

  // Text search narrows the pool BEFORE the owner/state counts are taken, so
  // the numbers describe what toggling them would actually reveal — a count
  // that drops to zero because of its own toggle is the bug that made the
  // previous view's lane counts useless. Session is on the same footing as
  // owner and state now, so it is counted the same way rather than pre-applied.
  const pool = useMemo(() => {
    const q = filters.q.trim().toLowerCase();
    return issues.filter((i) =>
      q ? `${i.title}\n${i.body}`.toLowerCase().includes(q) : true,
    );
  }, [issues, filters.q]);

  // Empty means unfiltered on every axis — see the predicates in utils/issues.
  const inSessions = useCallback((i: Issue) => sessionMatches(i, filters), [filters]);
  const inOwners = useCallback((i: Issue) => ownerMatches(i, filters), [filters]);
  const inStates = useCallback((i: Issue) => stateMatches(i, filters), [filters]);

  const ownerCounts = useMemo(() => {
    const c: Record<string, number> = { user: 0, cc: 0, external: 0 };
    for (const i of pool) if (inStates(i) && inSessions(i)) c[i.owner]++;
    return c;
  }, [pool, inStates, inSessions]);

  const stateCounts = useMemo(() => {
    const c: Record<string, number> = { todo: 0, doing: 0, done: 0, dropped: 0 };
    for (const i of pool) if (inOwners(i) && inSessions(i)) c[i.state]++;
    return c;
  }, [pool, inOwners, inSessions]);

  const sessionCounts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const i of pool) {
      if (inOwners(i) && inStates(i)) {
        const key = i.session_id ?? NO_SESSION;
        c[key] = (c[key] ?? 0) + 1;
      }
    }
    return c;
  }, [pool, inOwners, inStates]);

  // Expand whatever the link resolved to, once the rows are in hand.
  useEffect(() => {
    if (!focusId || issues.length === 0) return;
    const hit = issues.find((i) => matchesFocus(i, focusId));
    if (hit) setExpanded(hit.id);
  }, [focusId, issues]);

  const visible = useMemo(
    () =>
      pool
        .filter((i) => matchesFocus(i, focusId) || isVisible(i, filters))
        .sort(
          (a, b) =>
            // A close waiting to be signed off goes first, whatever else is on
            // screen: it is the one row that cannot wait for the user to think
            // of looking for it.
            // The issue that was linked to goes first — the user pressed it.
            Number(matchesFocus(b, focusId)) - Number(matchesFocus(a, focusId)) ||
            Number(isAwaitingApproval(b)) - Number(isAwaitingApproval(a)) ||
            OWNER_RANK[a.owner] - OWNER_RANK[b.owner] ||
            STATE_RANK[a.state] - STATE_RANK[b.state] ||
            b.updated_at.localeCompare(a.updated_at),
        ),
    [pool, filters, focusId],
  );

  // Only sessions that actually hold an issue — a live session with nothing
  // filed against it is a row reading "0" in a list of a dozen, and narrowing
  // to it can only ever empty the view. (Filing a NEW issue is the other way
  // round and offers every live session; see sessionPicker.) Anything already
  // selected stays listed even at zero, or the filter could not be undone.
  const sessionOptions = useMemo(() => {
    const withIssues = new Set(
      issues.map((i) => i.session_id ?? NO_SESSION),
    );
    const named = new Map(sessions.map((s) => [s.id, sessionLabel(s)]));
    return [...new Set([...withIssues, ...filters.sessionIds])]
      .map((id) => ({
        value: id,
        label:
          id === NO_SESSION
            ? t("issues.session_none")
            : named.get(id) ?? sessionNames.get(id) ?? id,
        count: sessionCounts[id] ?? 0,
      }))
      .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  }, [sessions, issues, sessionCounts, sessionNames, filters.sessionIds, t]);

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
    // Filing against no session is allowed but almost never intended: nobody is
    // notified, and the issue cannot be found by the session filter later. Warn
    // once and let a second press through, rather than blocking a case that may
    // turn out to have a use.
    if (!draft.id && !draft.sessionId && !sessionWarned) {
      setSessionWarned(true);
      setError(t("issues.warn_no_session"));
      return;
    }
    const fields = {
      title,
      body: draft.body,
      owner: draft.owner,
      state: draft.state,
      session_id: draft.sessionId,
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

  // Signing off on a close CC made. One click, no confirmation dialog: the
  // reading happens above the button (the summary is on screen), so a modal
  // asking "are you sure" would add a step without adding a thought.
  const approve = async (issue: Issue) => {
    const r = await approveIssueClose(issue.id);
    if (!r.ok) setError(r.error ?? t("issues.error_generic"));
    afterMutation(filters.showDeleted);
  };

  // Declining the close. Goes through its own endpoint rather than a state
  // edit, because the broker has to notify the CC that closed it — an
  // unannounced rejection leaves CC believing the work is finished, which is
  // the exact failure this flow was added to prevent.
  const sendBack = async (issue: Issue) => {
    const r = await rejectIssueClose(issue.id);
    if (!r.ok) setError(r.error ?? t("issues.error_generic"));
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

  // Relative, because "3h ago" reads as a last-touched time without a column
  // header saying so — and a header row was exactly what was not wanted. The
  // absolute times, and which is which, live in the hover title.
  const ago = (iso: string) => {
    const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
    if (mins < 1) return t("issues.ago_now");
    if (mins < 60) return t("issues.ago_min", { n: mins });
    const hours = Math.round(mins / 60);
    if (hours < 24) return t("issues.ago_hour", { n: hours });
    const days = Math.round(hours / 24);
    if (days < 100) return t("issues.ago_day", { n: days });
    return fmt(iso);
  };

  const timeHint = (i: Issue) =>
    t("issues.time_hint", { updated: fmt(i.updated_at), created: fmt(i.created_at) });

  const renderRowBody = (i: Issue) => (
    <div className="issue-row-detail">
      {i.body ? (
        <MDView className="issue-body" text={i.body} />
      ) : (
        <div className="issue-body-empty">{t("issues.no_body")}</div>
      )}
      <div className="issue-row-detail-actions">
        <span className="issue-timestamps">
          {t("issues.created")} {fmt(i.created_at)} · {t("issues.updated")}{" "}
          {fmt(i.updated_at)}
          {i.closed_at ? ` · ${t("issues.closed")} ${fmt(i.closed_at)}` : ""}
        </span>
        {/* The reason links are collected at all: read the whole conversation
            for this issue in one column, wherever it happened.

            The count is on the button, not discovered after opening: most
            issues predate the linking machinery or belong to another session's
            CC, so an unconditional "read the conversation" led straight to an
            empty modal and read as a broken feature. A number also shows the
            links accumulating, which is the thing worth watching. */}
        <button
          type="button"
          className="issue-timeline-open"
          disabled={!i.link_count}
          title={i.link_count ? undefined : t("issues.timeline_none_hint")}
          onClick={() => setTimelineOf(i)}
        >
          <MessagesSquare size={13} strokeWidth={2} /> {t("issues.timeline")}
          <span className="issue-timeline-count">{i.link_count ?? 0}</span>
        </button>
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
                  sessionId: i.session_id,
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

  // WHAT the approval is for, above the button that grants it.
  //
  // The sign-off exists so the user registers that something finished — with
  // the work delegated end to end, nothing is ever handed back and nothing is
  // remembered as complete. A bare "Approve" button would be signed blind and
  // would record consent without producing the memory, so the issue's own
  // account of what was done is on screen, clamped to a few lines.
  const renderApproval = (i: Issue) => (
    <div className="issue-approval">
      <div className="issue-approval-head">
        <Check size={13} strokeWidth={2.5} />
        {t(`issues.approval_lead.${i.state === "dropped" ? "dropped" : "done"}`)}
      </div>
      {i.body ? (
        <MDView className="issue-approval-body" text={i.body} />
      ) : (
        <div className="issue-body-empty">{t("issues.no_body")}</div>
      )}
      <div className="issue-approval-actions">
        <button
          type="button"
          className="issue-approve"
          onClick={(e) => {
            e.stopPropagation();
            void approve(i);
          }}
        >
          {t("issues.approve")}
        </button>
        <button
          type="button"
          className="issue-approval-reopen"
          onClick={(e) => {
            e.stopPropagation();
            void sendBack(i);
          }}
        >
          {t("issues.approval_reopen")}
        </button>
      </div>
    </div>
  );

  const sessionPicker = (
    value: string | null,
    onPick: (id: string | null) => void,
  ) => (
    <select
      className="issue-select"
      value={value ?? ""}
      aria-label={t("issues.session_label")}
      onChange={(e) => onPick(e.target.value || null)}
    >
      <option value="">{t("issues.session_none")}</option>
      {sessions.map((s) => (
        <option key={s.id} value={s.id}>
          {sessionLabel(s)}
          {s.alive ? "" : ` (${t("issues.session_ended")})`}
        </option>
      ))}
    </select>
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
                // Default to the session whose issues are on screen when that
                // is unambiguous — filing where you are looking is the common
                // case, and getting it wrong is how issues ended up on the
                // wrong session before.
                const only =
                  filters.sessionIds.length === 1 ? filters.sessionIds[0] : null;
                setSessionWarned(false);
                setDraft(emptyDraft(only === NO_SESSION ? null : only));
              }}
            >
              <Plus size={14} strokeWidth={2.25} /> {t("issues.new")}
            </button>
          </div>
        </div>

        <div className="issue-filters">
          <MultiSelectDropdown
            label={t("issues.owner_label")}
            allLabel={t("issues.all_owners")}
            selected={filters.owners}
            onChange={(next) =>
              setFilters((f) => ({ ...f, owners: next as IssueOwner[] }))
            }
            options={ISSUE_OWNERS.map((o) => ({
              value: o,
              label: t(`issues.owner.${o}`),
              count: ownerCounts[o],
              className: `owner-${o}`,
            }))}
          />
          <MultiSelectDropdown
            label={t("issues.state_label")}
            allLabel={t("issues.all_states")}
            selected={filters.states}
            onChange={(next) =>
              setFilters((f) => ({ ...f, states: next as IssueState[] }))
            }
            options={ISSUE_STATES.map((s) => ({
              value: s,
              label: t(`issues.state.${s}`),
              count: stateCounts[s],
              className: `state-${s}`,
            }))}
          />
          <MultiSelectDropdown
            className="ms-session"
            label={t("issues.session_label")}
            allLabel={t("issues.all_sessions")}
            selected={filters.sessionIds}
            onChange={(next) => setFilters((f) => ({ ...f, sessionIds: next }))}
            options={sessionOptions}
          />
          <label className="issue-search">
            <Search size={13} strokeWidth={2} />
            <input
              type="text"
              name="issue-search"
              value={filters.q}
              placeholder={t("issues.search_placeholder")}
              onChange={(e) => setFilters((f) => ({ ...f, q: e.target.value }))}
            />
          </label>
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

        {error && <div className="modal-error">{error}</div>}

        {draft && (
          <div className="issue-editor">
            <input
              className="issue-editor-title"
              type="text"
              name="issue-title"
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
              {sessionPicker(draft.sessionId, (id) =>
                setDraft((d) => d && { ...d, sessionId: id }),
              )}
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

        <div className="issue-scroll">
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
                        (isAwaitingApproval(i) ? " awaiting" : "") +
                        (expanded === i.id ? " expanded" : "")
                      }
                      onClick={() => setExpanded(expanded === i.id ? null : i.id)}
                    >
                      <td className="issue-cell-chip">
                        <OwnerStateChip
                          issue={i}
                          onSet={
                            i.deleted_at
                              ? undefined
                              : (patch) => void quickSet(i, patch)
                          }
                        />
                      </td>
                      <td className="issue-cell-session">
                        {i.session_id ? sessionNames.get(i.session_id) ?? "" : ""}
                      </td>
                      <td className="issue-cell-title">
                        {i.title}
                        {i.deleted_at && (
                          <span className="issue-deleted-tag">
                            {t("issues.deleted")}
                          </span>
                        )}
                      </td>
                      <td className="issue-cell-updated" title={timeHint(i)}>
                        {ago(i.updated_at)}
                      </td>
                    </tr>
                    {isAwaitingApproval(i) && expanded !== i.id && (
                      <tr className="issue-detail-row approval">
                        <td colSpan={4}>{renderApproval(i)}</td>
                      </tr>
                    )}
                    {expanded === i.id && (
                      <tr className="issue-detail-row">
                        <td colSpan={4}>
                          {isAwaitingApproval(i) && renderApproval(i)}
                          {renderRowBody(i)}
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="issue-board">
              {ISSUE_STATES.filter(
                (s) => filters.states.length === 0 || filters.states.includes(s),
              ).map((s) => (
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
                            "issue-card" +
                            (i.deleted_at ? " deleted" : "") +
                            (isAwaitingApproval(i) ? " awaiting" : "")
                          }
                          onClick={() =>
                            setExpanded(expanded === i.id ? null : i.id)
                          }
                        >
                          <div className="issue-card-top">
                            <OwnerStateChip
                              issue={i}
                              onSet={
                                i.deleted_at
                                  ? undefined
                                  : (patch) => void quickSet(i, patch)
                              }
                            />
                            <span
                              className="issue-card-session"
                              title={timeHint(i)}
                            >
                              {i.session_id
                                ? sessionNames.get(i.session_id) ?? ""
                                : ""}
                            </span>
                          </div>
                          <div className="issue-card-title">{i.title}</div>
                          {isAwaitingApproval(i) && renderApproval(i)}
                          {expanded === i.id && renderRowBody(i)}
                        </div>
                      ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {timelineOf && (
          <IssueTimelineModal
            issue={timelineOf}
            onClose={() => setTimelineOf(null)}
            onJump={() => setOpen(false)}
          />
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
