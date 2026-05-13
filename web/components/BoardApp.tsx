import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Activity, BoardView } from "../../shared/types.ts";
import { ActivityBadge } from "./ActivityBadge.tsx";
import { ConcernColumn } from "./ConcernColumn.tsx";
import { DefaultBoardLayout } from "./DefaultBoardLayout.tsx";
import { Sidebar } from "./Sidebar.tsx";
import { postSubmitAnswer } from "../utils/api.ts";
import { translateError } from "../utils/errors.ts";
import { buildTree } from "../utils/tree.ts";
import { getBoardIdFromUrl } from "../utils/url.ts";

export function BoardApp() {
  const { t } = useTranslation();
  const boardId = useMemo(getBoardIdFromUrl, []);
  const [data, setData] = useState<BoardView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [wsConnected, setWsConnected] = useState(false);
  const [flashingNodes, setFlashingNodes] = useState<Set<string>>(new Set());
  const [activitiesBySession, setActivitiesBySession] = useState<
    Record<string, Activity | null>
  >({});

  const fetchBoard = useCallback(async () => {
    if (!boardId) return;
    try {
      const res = await fetch(`/api/board/${boardId}`);
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        setError(translateError(t, j, `HTTP ${res.status}`));
        return;
      }
      const view = (await res.json()) as BoardView;
      setData(view);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [boardId, t]);

  useEffect(() => {
    if (!boardId) {
      setError(t("errors.not_found"));
      return;
    }
    fetchBoard();
  }, [boardId, fetchBoard, t]);

  useEffect(() => {
    if (!boardId) return;
    const proto = window.location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${window.location.host}/ws/${boardId}`);
    ws.addEventListener("open", () => setWsConnected(true));
    ws.addEventListener("close", () => setWsConnected(false));
    ws.addEventListener("message", (e) => {
      let msg: any = null;
      try {
        msg = JSON.parse(e.data);
      } catch {
        /* ignore parse errors */
      }
      if (msg) {
        if (
          msg.type === "thread-update" &&
          msg.source === "cc" &&
          typeof msg.node_id === "string"
        ) {
          const id: string = msg.node_id;
          setFlashingNodes((prev) => {
            const next = new Set(prev);
            next.add(id);
            return next;
          });
          setTimeout(() => {
            setFlashingNodes((prev) => {
              const next = new Set(prev);
              next.delete(id);
              return next;
            });
          }, 1500);
        } else if (msg.type === "activity") {
          const sid: string = msg.session_id;
          setActivitiesBySession((prev) => ({
            ...prev,
            [sid]: msg.activity ?? null,
          }));
          // Forward the activity to the sidebar so its per-session
          // indicator updates without waiting for the 10s sessions poll.
          window.dispatchEvent(
            new CustomEvent("pd-activity-update", {
              detail: { session_id: sid, activity: msg.activity ?? null },
            }),
          );
          return; // activity events don't affect board data
        } else if (msg.type === "sidebar-refresh") {
          // Sidebar polls /api/sessions on its own schedule; nudge it to
          // refetch immediately when unread counts shift.
          window.dispatchEvent(new Event("pd-sidebar-refresh"));
          return;
        }
      }
      fetchBoard();
    });
    return () => ws.close();
  }, [boardId, fetchBoard]);

  const handleSubmit = useCallback(
    async (nodeId: string, text: string) => {
      if (!boardId) throw new Error("no board");
      const res = await postSubmitAnswer(boardId, nodeId, text);
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        // Translate broker-side i18n error codes via t() so the user sees the
        // failure reason in their preferred language.
        throw new Error(translateError(t, j, `HTTP ${res.status}`));
      }
      // Optimistic refresh; WS will also nudge us.
      fetchBoard();
    },
    [boardId, fetchBoard, t]
  );

  if (error) {
    return <div className="error">{error}</div>;
  }
  if (!data) {
    return <div className="empty">{t("sidebar.loading")}</div>;
  }

  const childrenByParent = buildTree(data.nodes);
  const concerns = childrenByParent.get(null) ?? [];
  const ownerAlive = data.owner_alive !== false; // default to true if undefined (legacy)

  // Pick the activity belonging to this board's owning session, falling back to
  // the board view's initial value if the WS hasn't delivered one yet.
  const ownerSessionId = data.board.session_id;
  const sessionActivity = activitiesBySession[ownerSessionId];
  const activeActivity: Activity | null =
    sessionActivity !== undefined ? sessionActivity : data.activity ?? null;
  const isRelevant =
    !!activeActivity &&
    (!activeActivity.board_id || activeActivity.board_id === data.board.id);
  const headerActivity =
    isRelevant && !activeActivity!.node_id ? activeActivity : null;
  const nodeActivity =
    isRelevant && activeActivity!.node_id ? activeActivity : null;

  return (
    <div className="app">
      <header className="header">
        <a
          className="breadcrumb"
          href={"/session/" + data.board.session_id}
        >
          {t("header.back_to_session")}
        </a>
        <h1>
          {data.board.is_default ? t("default_board.title") : data.board.title}
        </h1>
        <span className="meta">
          {t("header.board_meta", {
            id: data.board.id,
            count: concerns.length,
          })}
          {data.board.closed ? t("header.board_meta_closed") : ""}
        </span>
        {headerActivity && <ActivityBadge activity={headerActivity} />}
        {!ownerAlive && (
          <span
            className="owner-warning"
            title={t("header.owner_warning_title")}
          >
            {t("header.owner_warning")}
          </span>
        )}
        {(() => {
          const unread = Object.values(data.threads)
            .flat()
            .filter((it) => it.source === "cc" && !it.read_at).length;
          if (unread === 0) return null;
          return (
            <button
              type="button"
              className="mark-all-read"
              title={t("header.unread_count_title", { count: unread })}
              onClick={() => {
                if (
                  !window.confirm(
                    t("header.unread_confirm", { count: unread }),
                  )
                )
                  return;
                fetch("/mark-board-read", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ board_id: data.board.id }),
                })
                  .then(() => fetchBoard())
                  .catch(() => alert(t("header.mark_all_read_failed")));
              }}
            >
              {t("header.unread_count_button", { count: unread })}
            </button>
          );
        })()}
        <span className="ws-status">
          <span className={`ws-dot ${wsConnected ? "connected" : ""}`} />
          {wsConnected ? t("header.live") : t("header.offline")}
        </span>
      </header>
      <div className="app-body">
        <Sidebar currentBoardId={boardId} />
        <div className="board-container">
          {data.board.is_default ? (
            <DefaultBoardLayout
              data={data}
              ownerAlive={ownerAlive}
              onSubmit={handleSubmit}
              flashingNodes={flashingNodes}
            />
          ) : (
            <div className="concerns-row">
              {concerns.map((c) => (
                <ConcernColumn
                  key={c.id}
                  concern={c}
                  childrenByParent={childrenByParent}
                  threads={data.threads}
                  flashingNodes={flashingNodes}
                  activity={nodeActivity}
                  ownerAlive={ownerAlive}
                  onSubmit={handleSubmit}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
