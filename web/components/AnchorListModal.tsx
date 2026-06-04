import React, { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Leaf, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { Favorite, SessionListItem } from "../../shared/types.ts";
import {
  loadFavoritesForSessions,
  removeFavoriteByThreadItem as removeFavoriteRow,
  useAllFavorites,
} from "../utils/favorites.ts";
import { jumpToAnchor } from "../utils/anchorJump.ts";
import { ConfirmDialog } from "./ConfirmDialog.tsx";
import { MDView } from "./MDView.tsx";
import { showToast } from "./Toast.tsx";
import { formatThreadTimestamp } from "../utils/format.ts";

const LS_FILTER_SESSION = "dt-anchor-filter-session";
const LS_SORT_DIR = "dt-anchor-sort-dir";
const ALL_SESSIONS = "__all__";
type SortDir = "desc" | "asc";

function readLS(key: string, fallback: string): string {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}
function writeLS(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private mode etc */
  }
}

// We used to truncate-with-ellipsis here, but the user prefers seeing
// the whole pinned message in the list (so they can recognise it
// without a jump). MDView still handles overflow-wrap, and the modal
// body scrolls, so a long row is just a tall row.

export function AnchorListModal({
  sessions,
  onClose,
}: {
  sessions: ReadonlyArray<SessionListItem>;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const all = useAllFavorites();

  const [filterSession, setFilterSession] = useState<string>(() =>
    readLS(LS_FILTER_SESSION, ALL_SESSIONS),
  );
  const [sortDir, setSortDir] = useState<SortDir>(() =>
    readLS(LS_SORT_DIR, "asc") === "desc" ? "desc" : "asc",
  );
  const [confirm, setConfirm] = useState<Favorite | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  // Persist filter / sort whenever they change.
  useEffect(() => {
    writeLS(LS_FILTER_SESSION, filterSession);
  }, [filterSession]);
  useEffect(() => {
    writeLS(LS_SORT_DIR, sortDir);
  }, [sortDir]);

  // Pull anchors for every session the user has access to so the
  // "All sessions" view is whole on mount. The favorites store dedupes
  // and the broker scopes by session_id, so this is safe to call once
  // per modal open.
  useEffect(() => {
    const ids = sessions.map((s) => s.id);
    if (ids.length > 0) loadFavoritesForSessions(ids);
  }, [sessions]);

  // Escape to close.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Filter + sort the visible set.
  const visible = useMemo(() => {
    const filtered =
      filterSession === ALL_SESSIONS
        ? all.slice()
        : all.filter((f) => f.session_id === filterSession);
    filtered.sort((a, b) => {
      const cmp = a.created_at.localeCompare(b.created_at);
      return sortDir === "desc" ? -cmp : cmp;
    });
    return filtered;
  }, [all, filterSession, sortDir]);

  // Match the conversational thread convention: when the newest items
  // are at the bottom (= ascending sort), open the modal already
  // scrolled to the bottom so the user lands on the latest pin
  // without flicking. Reset to top on descending sort, since that
  // puts the newest items up there.
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    if (sortDir === "asc") {
      el.lastElementChild?.scrollIntoView({ block: "end" });
    } else {
      el.scrollTop = 0;
    }
  }, [sortDir, visible.length]);

  const sessionName = (sid: string): string => {
    const s = sessions.find((x) => x.id === sid);
    return s?.name ?? sid;
  };

  const clearFilters = () => {
    setFilterSession(ALL_SESSIONS);
    setSortDir("asc");
  };
  const filtersActive = filterSession !== ALL_SESSIONS || sortDir !== "asc";

  const handleRowClick = (fav: Favorite) => {
    onClose();
    jumpToAnchor(fav.board_id, fav.thread_item_id);
  };

  const handleUnanchor = async (fav: Favorite) => {
    setConfirm(null);
    try {
      await removeFavoriteRow({
        sessionId: fav.session_id,
        threadItemId: fav.thread_item_id,
      });
      showToast(t("anchor.removed"));
    } catch {
      showToast(t("anchor.failed"), "error");
    }
  };

  return createPortal(
    <div className="modal-backdrop anchor-list-backdrop" onClick={onClose}>
      <div
        className="anchor-list-modal"
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="anchor-list-header">
          <h2 className="anchor-list-title">
            <Leaf size={18} strokeWidth={2} aria-hidden="true" />
            {t("anchor.list_title")}
          </h2>
          <button
            type="button"
            className="anchor-list-close"
            title={t("anchor.close")}
            aria-label={t("anchor.close")}
            onClick={onClose}
          >
            <X size={18} strokeWidth={1.75} />
          </button>
        </div>

        <div className="anchor-list-filters">
          <label className="anchor-filter">
            <span className="anchor-filter-label">{t("anchor.session")}</span>
            <select
              value={filterSession}
              onChange={(e) => setFilterSession(e.target.value)}
            >
              <option value={ALL_SESSIONS}>{t("anchor.all_sessions")}</option>
              {sessions.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name ?? s.id}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="anchor-sort-toggle"
            onClick={() => setSortDir((d) => (d === "desc" ? "asc" : "desc"))}
            title={t(
              sortDir === "desc"
                ? "anchor.sort_newest_first"
                : "anchor.sort_oldest_first",
            )}
          >
            {sortDir === "desc" ? "↑ " : "↓ "}
            {t(
              sortDir === "desc"
                ? "anchor.sort_newest_first"
                : "anchor.sort_oldest_first",
            )}
          </button>
          {filtersActive && (
            <button
              type="button"
              className="anchor-clear-filters"
              onClick={clearFilters}
            >
              {t("anchor.clear_filters")}
            </button>
          )}
        </div>

        <div className="anchor-list-body" ref={bodyRef}>
          {visible.length === 0 ? (
            <div className="anchor-empty">{t("anchor.empty")}</div>
          ) : (
            visible.map((fav) => {
              // Collapse consecutive duplicates so default boards (which
              // intentionally use the same title for board / concern /
              // node — "会話" / "Conversation") don't render as
              // "discussion-tree › 会話 › 会話 › 会話".
              const segs = [
                fav.session_name ?? sessionName(fav.session_id),
                fav.board_title ?? fav.board_id,
                fav.concern_title,
                fav.node_title ?? fav.node_id,
              ].filter((s): s is string => Boolean(s));
              const path = segs
                .filter((s, i) => i === 0 || s !== segs[i - 1])
                .join(" › ");
              const sourceLabel =
                fav.source === "user" ? t("item_card.you") : t("item_card.claude");
              return (
                <div
                  key={fav.id}
                  className={`anchor-list-row anchor-list-row-from-${fav.source ?? "cc"}`}
                  onClick={() => handleRowClick(fav)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      handleRowClick(fav);
                    }
                  }}
                >
                  <div className="anchor-row-path">
                    {path}{" "}
                    <span className="anchor-row-source">[{sourceLabel}]</span>{" "}
                    <span
                      className="anchor-row-time"
                      title={fav.thread_item_created_at ?? fav.created_at}
                    >
                      {formatThreadTimestamp(
                        fav.thread_item_created_at ?? fav.created_at,
                      )}
                    </span>
                  </div>
                  <MDView
                    className="anchor-row-body"
                    text={fav.text ?? ""}
                  />
                  <div className="anchor-row-footer">
                    <button
                      type="button"
                      className="anchor-row-unpin"
                      onClick={(e) => {
                        e.stopPropagation();
                        setConfirm(fav);
                      }}
                      title={t("anchor.unanchor")}
                    >
                      <Leaf size={14} strokeWidth={2.25} />
                      <span>{t("anchor.unanchor")}</span>
                    </button>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>

      {confirm && (
        <ConfirmDialog
          title={t("anchor.unanchor_confirm_title")}
          message={t("anchor.unanchor_confirm_message")}
          confirmLabel={t("anchor.unanchor")}
          cancelLabel={t("anchor.cancel")}
          tone="warn"
          onConfirm={() => handleUnanchor(confirm)}
          onCancel={() => setConfirm(null)}
        />
      )}
    </div>,
    document.body,
  );
}
