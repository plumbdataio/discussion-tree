import React, { useEffect, useRef, useState } from "react";
import { Filter } from "lucide-react";
import { useTranslation } from "react-i18next";
import { NODE_STATUSES } from "../utils/constants.ts";
import { useNodeStatusFilter } from "../utils/nodeStatusFilter.ts";

// Board-view header trigger that drops down a per-status checkbox
// popover. Filter state is per-board (keyed by boardId) via
// useNodeStatusFilter so the items rendered by ConcernColumn /
// ItemCard pick up the change without prop drilling, and each board
// remembers its own selection. Lives next to the structure-request
// button in the BoardApp header (skipped on the default board).
export function NodeStatusFilterButton({ boardId }: { boardId: string }) {
  const { t } = useTranslation();
  const [filter, setOne, reset] = useNodeStatusFilter(boardId);
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (!wrapperRef.current) return;
      if (!wrapperRef.current.contains(e.target as Node)) setOpen(false);
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
    <div className="node-status-filter" ref={wrapperRef}>
      <button
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
      {open && (
        <div className="node-status-filter-popover" role="dialog">
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
        </div>
      )}
    </div>
  );
}
