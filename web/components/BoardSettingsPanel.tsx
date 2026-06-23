import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { SlidersHorizontal } from "lucide-react";
import { useTranslation } from "react-i18next";
import { postSetBoardAutoStatus } from "../utils/api.ts";
import { Toggle } from "./Toggle.tsx";

// Board-view header control (a sliders icon, distinct from the per-status
// filter button and the app-wide settings gear) → a popover of per-board
// settings. Currently just the automatic-status-sync toggle: off freezes the
// board status so a status-tracking board doesn't auto-settle (and vanish
// behind the sidebar filter) once every node is marked done. Portaled to
// <body> with fixed positioning so the mobile header's horizontal-scroll
// overflow clip can't cut it off.
export function BoardSettingsPanel({
  boardId,
  autoStatusSync,
}: {
  boardId: string;
  autoStatusSync: boolean;
}) {
  const { t } = useTranslation();
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
      const width = 260;
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

  const onToggleAuto = (next: boolean) => {
    setAutoOn(next); // optimistic; revert on failure
    postSetBoardAutoStatus(boardId, next).catch(() => setAutoOn(!next));
  };

  return (
    <div className="board-settings">
      <button
        ref={triggerRef}
        type="button"
        // Highlight when a setting is off the default (status sync frozen) so
        // the icon advertises "this board has a non-default setting".
        className={"board-settings-trigger" + (!autoOn ? " is-active" : "")}
        onClick={() => setOpen((v) => !v)}
        title={t("board_settings.trigger_title")}
        aria-label={t("board_settings.trigger_title")}
        aria-haspopup="true"
        aria-expanded={open}
      >
        <SlidersHorizontal size={14} strokeWidth={1.75} />
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
            <div className="board-settings-section-title">
              {t("board_settings.trigger_title")}
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
          </div>,
          document.body,
        )}
    </div>
  );
}
