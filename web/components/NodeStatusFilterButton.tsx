import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Filter } from "lucide-react";
import { useTranslation } from "react-i18next";
import { NODE_STATUSES } from "../utils/constants.ts";
import {
  useNodeStatusFilter,
  useNodeUnreadOverride,
} from "../utils/nodeStatusFilter.ts";

// Board-view header trigger that drops down a per-status checkbox
// popover. Filter state is per-board (keyed by boardId) via
// useNodeStatusFilter so the items rendered by ConcernColumn /
// ItemCard pick up the change without prop drilling, and each board
// remembers its own selection. The trigger label shows the current
// "visible/total" count so the filter state reads at a glance from the
// header; board-level settings live in the separate BoardSettingsPanel.
//
// The popover is portaled to <body> with fixed positioning: on mobile the
// header is a horizontal scroll container (overflow-x:auto forces overflow-y
// to clip), so an in-flow absolute popover would be cut off below the header
// edge. Portaling escapes both that clip and any header stacking context.
export function NodeStatusFilterButton({ boardId }: { boardId: string }) {
  const { t } = useTranslation();
  const [filter, setOne, reset] = useNodeStatusFilter(boardId);
  const [unreadOverride, setUnreadOverride] = useNodeUnreadOverride(boardId);
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const el = triggerRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const width = 220;
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

  return (
    <div className="node-status-filter">
      <button
        ref={triggerRef}
        type="button"
        className={
          "node-status-filter-trigger" + (isFiltered ? " is-filtered" : "")
        }
        onClick={() => setOpen((v) => !v)}
        title={t("node_status_filter.trigger_title")}
        aria-haspopup="true"
        aria-expanded={open}
      >
        <Filter size={14} strokeWidth={1.75} />
        <span>
          {t("node_status_filter.summary", {
            visible: enabledCount,
            total,
          })}
        </span>
      </button>
      {open &&
        pos &&
        createPortal(
          <div
            ref={popoverRef}
            className="node-status-filter-popover is-portaled"
            role="dialog"
            style={{ top: pos.top, left: pos.left }}
          >
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
                onClick={() => {
                  reset();
                  setOpen(false);
                }}
              >
                {t("node_status_filter.reset")}
              </button>
            )}
          </div>,
          document.body,
        )}
    </div>
  );
}
