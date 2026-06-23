import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Settings } from "lucide-react";
import { useTranslation } from "react-i18next";
import { NODE_STATUSES } from "../utils/constants.ts";
import {
  useNodeStatusFilter,
  useNodeUnreadOverride,
} from "../utils/nodeStatusFilter.ts";
import { postSetBoardAutoStatus } from "../utils/api.ts";
import { Toggle } from "./Toggle.tsx";

// Board-view header gear → a popover with per-board settings:
//   1. Automatic status sync toggle — off freezes the board status so a
//      status-tracking board doesn't auto-settle (and vanish behind the
//      sidebar filter) once every node is marked done.
//   2. The per-status node filter (moved here from its own header button).
// Filter state is per-board (keyed by boardId) via useNodeStatusFilter. The
// popover is portaled to <body> with fixed positioning so the mobile header's
// horizontal-scroll overflow clip can't cut it off.
export function BoardSettingsPanel({
  boardId,
  autoStatusSync,
}: {
  boardId: string;
  autoStatusSync: boolean;
}) {
  const { t } = useTranslation();
  const [filter, setOne, reset] = useNodeStatusFilter(boardId);
  const [unreadOverride, setUnreadOverride] = useNodeUnreadOverride(boardId);
  const [autoOn, setAutoOn] = useState(autoStatusSync);
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  // Follow the board refetch (e.g. another tab toggled it).
  useEffect(() => setAutoOn(autoStatusSync), [autoStatusSync]);

  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const el = triggerRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const width = 240;
      const left = Math.max(8, Math.min(r.left, window.innerWidth - width - 8));
      setPos({ top: r.bottom + 6, left });
    };
    place();
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      const target = e.target as Node;
      if (triggerRef.current?.contains(target)) return;
      if (popoverRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const enabledCount = NODE_STATUSES.filter((s) => filter[s] !== false).length;
  const total = NODE_STATUSES.length;
  const isFiltered = enabledCount < total;
  // Light up the trigger when either an active filter or a frozen board status
  // is in effect, so the gear advertises "this board has non-default settings".
  const isActive = isFiltered || !autoOn;

  const onToggleAuto = (next: boolean) => {
    setAutoOn(next); // optimistic; revert on failure
    postSetBoardAutoStatus(boardId, next).catch(() => setAutoOn(!next));
  };

  return (
    <div className="board-settings">
      <button
        ref={triggerRef}
        type="button"
        className={"board-settings-trigger" + (isActive ? " is-active" : "")}
        onClick={() => setOpen((v) => !v)}
        title={t("board_settings.trigger_title")}
        aria-haspopup="true"
        aria-expanded={open}
      >
        <Settings size={14} strokeWidth={1.75} />
        <span>
          {t("node_status_filter.summary", { visible: enabledCount, total })}
        </span>
      </button>
      {open &&
        pos &&
        createPortal(
          <div
            ref={popoverRef}
            className="board-settings-popover is-portaled"
            role="dialog"
            style={{ top: pos.top, left: pos.left }}
          >
            <div className="board-settings-section">
              <div className="board-settings-section-title">
                {t("board_settings.board_section")}
              </div>
              <div className="board-settings-toggle-row">
                <span className="board-settings-toggle-label">
                  {t("board_settings.auto_status_label")}
                </span>
                <Toggle
                  checked={autoOn}
                  onChange={onToggleAuto}
                  ariaLabel={t("board_settings.auto_status_label")}
                />
              </div>
              <p className="board-settings-help">
                {t("board_settings.auto_status_help")}
              </p>
            </div>

            <div className="board-settings-section">
              <div className="board-settings-section-title">
                {t("board_settings.filter_section")}
              </div>
              <div className="node-status-filter-list">
                {NODE_STATUSES.map((s) => (
                  <label key={s} className="node-status-filter-row">
                    <input
                      type="checkbox"
                      checked={filter[s] !== false}
                      onChange={(e) => setOne(s, e.target.checked)}
                    />
                    <span className={`node-status-filter-label status-${s}`}>
                      {t([`node_status.${s}`, s])}
                    </span>
                  </label>
                ))}
              </div>
              <label className="node-status-filter-row node-status-filter-extra">
                <input
                  type="checkbox"
                  checked={unreadOverride}
                  onChange={(e) => setUnreadOverride(e.target.checked)}
                />
                <span className="node-status-filter-label">
                  {t("node_status_filter.show_unread_always")}
                </span>
              </label>
              {isFiltered && (
                <button
                  type="button"
                  className="node-status-filter-reset"
                  onClick={() => reset()}
                >
                  {t("node_status_filter.reset")}
                </button>
              )}
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
