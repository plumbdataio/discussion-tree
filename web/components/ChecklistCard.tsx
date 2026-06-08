import React, { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import {
  CheckSquare,
  ChevronDown,
  ChevronUp,
  LayoutGrid,
  Link2,
  Maximize2,
  MessageSquare,
  Network,
  RefreshCw,
  Square,
  X,
  XSquare,
} from "lucide-react";
import type {
  ChecklistItem,
  ChecklistItemSource,
  ChecklistItemStatus,
  ChecklistSourceKind,
  Node,
} from "../../shared/types.ts";
import { MDView } from "./MDView.tsx";
import { jumpToAnchor } from "../utils/anchorJump.ts";

// Read-only renderer for a decision-checklist node (is_checklist=1). The
// node's checklist_items are mutated only through CC tools — this surface
// just displays them. The status icon is a display indicator, NOT a
// clickable toggle (UI is deliberately read-only per the design decision).
const STATUS_ICON: Record<
  ChecklistItemStatus,
  React.ComponentType<{ size?: number; strokeWidth?: number }>
> = {
  done: CheckSquare,
  "in-progress": RefreshCw,
  pending: Square,
  dropped: XSquare,
};

// Source kind → icon + label. A source cites where the decision was made:
// a whole board, a node, or a specific message.
const SOURCE_ICON: Record<
  ChecklistSourceKind,
  React.ComponentType<{ size?: number; strokeWidth?: number }>
> = {
  board: LayoutGrid,
  node: Network,
  message: MessageSquare,
};
const SOURCE_LABEL: Record<ChecklistSourceKind, string> = {
  board: "ボード",
  node: "ノード",
  message: "メッセージ",
};

function whoLabel(source?: string): string | null {
  if (source === "cc") return "CC";
  if (source === "user") return "あなた";
  if (source === "system") return "システム";
  return source ?? null;
}

// The action that opens a source: a message jumps straight to that thread item
// (via the anchor-jump channel); a node / board is a plain SPA link the global
// interceptor handles (so Cmd-click still opens a new tab). Kept as a single
// interactive element so the preview content (which may contain markdown
// links) isn't nested inside another link/button.
function SourceAction({
  source,
  kind,
}: {
  source: ChecklistItemSource;
  kind: ChecklistSourceKind;
}) {
  if (kind === "message") {
    return (
      <button
        type="button"
        className="checklist-source-open"
        onClick={() => jumpToAnchor(source.board_id, Number(source.ref_id))}
      >
        このメッセージへ移動
      </button>
    );
  }
  const href =
    kind === "board" ? `/board/${source.ref_id}` : `/board/${source.board_id}`;
  return (
    <a className="checklist-source-open" href={href}>
      {kind === "board" ? "このボードを開く" : "このノードのボードを開く"}
    </a>
  );
}

// One source inside the modal: the cited content (title / message body) plus
// where it lives and an action to open it.
function SourceRow({ source }: { source: ChecklistItemSource }) {
  const kind = (source.kind in SOURCE_ICON ? source.kind : "node") as
    | ChecklistSourceKind;
  const Icon = SOURCE_ICON[kind];
  const label = SOURCE_LABEL[kind];
  const p = source.preview;
  const who = whoLabel(p?.source);
  return (
    <div className={`checklist-source-row checklist-source-${kind}`}>
      <div className="checklist-source-head">
        <span className="checklist-source-icon" aria-hidden="true">
          <Icon size={13} strokeWidth={2} />
        </span>
        <span className="checklist-source-label">{label}</span>
        {who && <span className="checklist-source-who">{who}</span>}
        {kind !== "board" && p?.board_title && (
          <span className="checklist-source-board" title={p.board_title}>
            {p.board_title}
          </span>
        )}
        <span className="checklist-source-ref" title={source.ref_id}>
          {source.ref_id}
        </span>
      </div>
      {p?.missing ? (
        <div className="checklist-source-missing">参照先が見つかりません</div>
      ) : (
        <>
          {p?.title && <div className="checklist-source-name">{p.title}</div>}
          {p?.text && (
            <MDView className="checklist-source-preview" text={p.text} />
          )}
        </>
      )}
      <div className="checklist-source-actions">
        <SourceAction source={source} kind={kind} />
      </div>
    </div>
  );
}

function SourceList({ sources }: { sources: ChecklistItemSource[] }) {
  return (
    <ul className="checklist-sources">
      {sources.map((s) => (
        <li key={s.id}>
          <SourceRow source={s} />
        </li>
      ))}
    </ul>
  );
}

// Status sort rank — ascending groups "not yet checked" (pending →
// in-progress) first, then done, then dropped. Distinct from position
// (the raw array order).
const STATUS_RANK: Record<ChecklistItemStatus, number> = {
  pending: 0,
  "in-progress": 1,
  done: 2,
  dropped: 3,
};

type SortBy = "position" | "status";
type SortDir = "asc" | "desc";
type Sort = { by: SortBy; dir: SortDir };

const SORT_KEY = "dt-checklist-sort";
const SORT_EVENT = "dt-checklist-sort-change";

function readSort(): Sort {
  try {
    const raw = localStorage.getItem(SORT_KEY);
    if (raw) {
      const p = JSON.parse(raw) as Partial<Sort>;
      if (
        (p.by === "position" || p.by === "status") &&
        (p.dir === "asc" || p.dir === "desc")
      ) {
        return { by: p.by, dir: p.dir };
      }
    }
  } catch {
    /* fall through to default */
  }
  return { by: "position", dir: "asc" };
}

// Shared sort preference for every checklist on the page: persisted to
// localStorage (so it survives reloads / tabs) and synced live across all
// mounted ChecklistCards via a window event. The user picks it once.
function useChecklistSort(): readonly [Sort, (next: Sort) => void] {
  const [sort, setSort] = useState<Sort>(readSort);
  useEffect(() => {
    const h = () => setSort(readSort());
    window.addEventListener(SORT_EVENT, h);
    return () => window.removeEventListener(SORT_EVENT, h);
  }, []);
  const update = (next: Sort) => {
    try {
      localStorage.setItem(SORT_KEY, JSON.stringify(next));
    } catch {
      /* best effort */
    }
    setSort(next);
    window.dispatchEvent(new Event(SORT_EVENT));
  };
  return [sort, update] as const;
}

function sortItems(items: ChecklistItem[], sort: Sort): ChecklistItem[] {
  const sign = sort.dir === "asc" ? 1 : -1;
  return [...items].sort((a, b) => {
    let cmp: number;
    if (sort.by === "status") {
      cmp = STATUS_RANK[a.status] - STATUS_RANK[b.status];
      if (cmp === 0) cmp = a.position - b.position; // stable tiebreak
    } else {
      cmp = a.position - b.position;
    }
    return cmp * sign;
  });
}

function SortControls({
  sort,
  update,
}: {
  sort: Sort;
  update: (next: Sort) => void;
}) {
  // Clicking the active field flips its direction; clicking the other field
  // switches to it (ascending).
  const onClick = (by: SortBy) => {
    if (sort.by === by) {
      update({ by, dir: sort.dir === "asc" ? "desc" : "asc" });
    } else {
      update({ by, dir: "asc" });
    }
  };
  const Arrow = sort.dir === "asc" ? ChevronUp : ChevronDown;
  return (
    <div className="checklist-sort" role="group" aria-label="並べ替え">
      {(["position", "status"] as const).map((by) => {
        const active = sort.by === by;
        return (
          <button
            key={by}
            type="button"
            className={"checklist-sort-btn" + (active ? " active" : "")}
            onClick={() => onClick(by)}
            title={
              by === "position"
                ? "配列順で並べ替え"
                : "ステータス順で並べ替え"
            }
          >
            <span>{by === "position" ? "順序" : "状態"}</span>
            {active && <Arrow size={12} strokeWidth={2.5} />}
          </button>
        );
      })}
    </div>
  );
}

function ChecklistBody({ node, sort }: { node: Node; sort: Sort }) {
  const items = node.checklist_items ?? [];
  // Which item's sources modal is open (one at a time per body instance). A
  // modal — not an inline/popover — because the source list can grow and a
  // small popover would feel cramped.
  const [openId, setOpenId] = useState<number | null>(null);
  useEffect(() => {
    if (openId == null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpenId(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openId]);
  if (items.length === 0) {
    return <div className="checklist-empty">まだ項目がありません</div>;
  }
  const ordered = sortItems(items, sort);
  const openItem = openId == null ? null : items.find((i) => i.id === openId);
  const openSources = openItem?.sources ?? [];
  return (
    <>
      <ul className="checklist-items">
        {ordered.map((it) => {
          const Icon = STATUS_ICON[it.status] ?? Square;
          const sources = it.sources ?? [];
          return (
            <li
              key={it.id}
              className={`checklist-item checklist-status-${it.status}`}
            >
              <span
                className="checklist-glyph"
                aria-label={it.status}
                title={it.status}
              >
                <Icon size={17} strokeWidth={2} />
              </span>
              <span className="checklist-item-body">
                <MDView className="checklist-summary" text={it.summary} />
                {it.status === "dropped" && it.drop_reason && (
                  <span className="checklist-drop-reason">
                    却下理由: {it.drop_reason}
                  </span>
                )}
              </span>
              {sources.length > 0 && (
                <button
                  type="button"
                  className={
                    "checklist-source-toggle" + (openId === it.id ? " open" : "")
                  }
                  aria-haspopup="dialog"
                  aria-label={`出典 ${sources.length} 件を表示`}
                  title={`出典 ${sources.length} 件を表示`}
                  onClick={() => setOpenId(it.id)}
                >
                  <Link2 size={13} strokeWidth={2} />
                  <span className="checklist-source-count">
                    {sources.length}
                  </span>
                </button>
              )}
            </li>
          );
        })}
      </ul>
      {openItem &&
        openSources.length > 0 &&
        createPortal(
          <div
            className="modal-backdrop checklist-sources-backdrop"
            onClick={() => setOpenId(null)}
          >
            <div
              className="checklist-sources-modal"
              role="dialog"
              aria-modal="true"
              aria-label="出典"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="checklist-sources-modal-header">
                <h3 className="checklist-sources-modal-title">
                  出典 {openSources.length} 件
                </h3>
                <button
                  type="button"
                  className="checklist-modal-close"
                  onClick={() => setOpenId(null)}
                  aria-label="閉じる"
                  title="閉じる"
                >
                  <X size={18} strokeWidth={1.75} />
                </button>
              </div>
              <MDView
                className="checklist-sources-modal-summary"
                text={openItem.summary}
              />
              <SourceList sources={openSources} />
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}

export function ChecklistCard({ node }: { node: Node }) {
  const [expanded, setExpanded] = useState(false);
  const [sort, updateSort] = useChecklistSort();
  useEffect(() => {
    if (!expanded) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setExpanded(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [expanded]);

  return (
    <div className="checklist-card">
      <div className="checklist-card-header">
        <h3 className="checklist-card-title">{node.title}</h3>
        <div className="checklist-card-actions">
          <SortControls sort={sort} update={updateSort} />
          <button
            type="button"
            className="checklist-expand"
            title="拡大表示"
            aria-label="チェックリストを拡大表示"
            onClick={() => setExpanded(true)}
          >
            <Maximize2 size={14} strokeWidth={1.75} />
          </button>
        </div>
      </div>
      {node.context && (
        <MDView className="checklist-card-context" text={node.context} />
      )}
      <ChecklistBody node={node} sort={sort} />

      {expanded &&
        createPortal(
          <div
            className="modal-backdrop"
            onClick={() => setExpanded(false)}
          >
            <div
              className="checklist-modal"
              role="dialog"
              aria-modal="true"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="checklist-modal-header">
                <h2 className="checklist-modal-title">{node.title}</h2>
                <div className="checklist-card-actions">
                  <SortControls sort={sort} update={updateSort} />
                  <button
                    type="button"
                    className="checklist-modal-close"
                    onClick={() => setExpanded(false)}
                    aria-label="閉じる"
                    title="閉じる"
                  >
                    <X size={18} strokeWidth={1.75} />
                  </button>
                </div>
              </div>
              {node.context && (
                <MDView className="checklist-card-context" text={node.context} />
              )}
              <ChecklistBody node={node} sort={sort} />
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
