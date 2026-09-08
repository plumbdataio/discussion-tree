import React, { useEffect, useState } from "react";
import {
  AlertTriangle,
  Bot,
  Clock,
  Cog,
  RefreshCw,
  Send,
  Shrink,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import type { Activity, SessionListItem } from "../../shared/types.ts";
import { HelpBubbleIcon } from "./HelpBubbleIcon.tsx";
import { contextWarnBand } from "../utils/contextBand.ts";

// @reusable-ui SessionActivityIcons — USE WHEN: rendering the per-session live
//   indicator cluster (stall / compacting / re-attach spinner / working-or-
//   blocked activity / background-task cog / subagent Bot / scheduled-message
//   timer / context-low CTX / scheduled-send marker) anywhere OTHER than the
//   sidebar row it was born in — e.g. the session dashboard header.
//   INSTEAD OF: re-inlining the same chain of conditional chips (and its
//   reattach-flash state + clear-marker fetches) a second time and letting the
//   two copies drift apart.
//
// Self-contained: it owns its own `pd-session-reattached` window-event listener
// + timed flash (keyed by session id) and issues the bg-task / subagent
// clear-marker POSTs itself, so a caller only has to hand it a SessionListItem.

// Format a scheduled-send ISO timestamp to a short local clock time for the
// marker tooltip. Falls back to the raw string if it doesn't parse.
function formatScheduleTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function SessionActivityIcons({
  session,
  activity,
  onOpenScheduledList,
  showCtxChip = true,
  className = "",
}: {
  session: SessionListItem;
  // Live activity override. The sidebar passes its WS-updated activity-map value
  // (activitiesBySession[s.id]), which can legitimately be `null` ("no activity
  // right now"). Pass `undefined` (or omit) to fall back to session.activity —
  // note the null-vs-undefined distinction is deliberate (a `null` override must
  // NOT fall back, or a cleared activity would resurrect the stale one).
  activity?: Activity | null;
  // Opens the cross-session scheduled-list modal (timer chip click). When
  // omitted, the timer chip is hidden — there is nothing for a click to open.
  onOpenScheduledList?: () => void;
  // Whether to render the context-low "CTX" chip. The sidebar shows it (its only
  // context cue); a caller that renders a full ContextMeter of its own passes
  // false so the two don't both surface context.
  showCtxChip?: boolean;
  // Appended to the wrapper's class so a caller can tune placement.
  className?: string;
}) {
  const { t } = useTranslation();

  const liveActivity = activity !== undefined ? activity : session.activity ?? null;

  // Transient "just re-attached" spinner. The MCP server's heartbeat self-heal
  // re-bound this session after its broker binding was lost; GlobalBanner relays
  // that as a `pd-session-reattached` window event. We flash a brief spinner so
  // the human sees the recovery (the agent gets a channel notice separately).
  // A nonce (not a bool) so a second event mid-flash re-arms the auto-clear.
  // Purely momentary — independent of the working / stall / compacting states.
  const REATTACH_FLASH_MS = 4000;
  const [reattachNonce, setReattachNonce] = useState(0);
  const reattaching = reattachNonce > 0;
  useEffect(() => {
    const onReattach = (e: Event) => {
      const detail = (e as CustomEvent<{ session_id?: string }>).detail;
      if (detail?.session_id === session.id) setReattachNonce((n) => n + 1);
    };
    window.addEventListener("pd-session-reattached", onReattach);
    return () =>
      window.removeEventListener("pd-session-reattached", onReattach);
  }, [session.id]);
  useEffect(() => {
    if (reattachNonce === 0) return;
    const tid = setTimeout(() => setReattachNonce(0), REATTACH_FLASH_MS);
    return () => clearTimeout(tid);
  }, [reattachNonce]);

  // Context-low warning chip. Band derived in one place (contextWarnBand):
  // <15% free shows the chip, <=10% is critical (red) to match ContextMeter.
  const ctxPct = session.context_usage?.remaining_pct;
  const ctxBand = contextWarnBand(ctxPct);

  const scheduledMessageCount =
    (session as { scheduled_message_count?: number }).scheduled_message_count ??
    0;

  return (
    // All per-session status indicators live in ONE flex row so a fixed-column
    // grid host (the sidebar's .session-header) never overflows to a second row
    // no matter how many indicators are active at once. `:empty` hides it.
    <span className={"session-indicators" + (className ? " " + className : "")}>
      {session.stalled && (
        <span
          className="session-stall-indicator"
          title={t("sidebar.stalled_title")}
          aria-label={t("sidebar.stalled_aria")}
        >
          <AlertTriangle size={15} strokeWidth={2.5} />
        </span>
      )}
      {session.compacting && !session.stalled && (
        <span
          className="session-compacting-indicator"
          title={t("sidebar.compacting_title")}
          aria-label={t("sidebar.compacting_aria")}
        >
          <Shrink size={15} strokeWidth={2.5} />
        </span>
      )}
      {reattaching && !liveActivity && (
        <span
          className="session-reattach-indicator"
          title={t("sidebar.reattached_title")}
          aria-label={t("sidebar.reattached_aria")}
        >
          <RefreshCw size={14} strokeWidth={2.75} />
        </span>
      )}
      {liveActivity && (
        <span
          className={`session-activity-indicator activity-${liveActivity.state}`}
          title={
            liveActivity.message
              ? `${liveActivity.state}: ${liveActivity.message}`
              : liveActivity.state
          }
          aria-label={liveActivity.state}
        >
          {/* "blocked" = CC waiting on the user (AskUserQuestion /
              ExitPlanMode). Show a chat-bubble-with-alert glyph + pulse
              instead of the spinning refresh icon — a spinning icon
              reads as "still working" and was easy to overlook, and a
              generic warning triangle didn't convey "the assistant
              wants to talk to you". */}
          {liveActivity.state === "blocked" ? (
            <HelpBubbleIcon size={16} strokeWidth={2} />
          ) : (
            <RefreshCw size={14} strokeWidth={2.75} />
          )}
        </span>
      )}
      {(session.bg_task_count ?? 0) > 0 && (
        <button
          type="button"
          className="session-bg-indicator"
          title={`background tasks: ${session.bg_task_count} — click to clear`}
          aria-label={`clear ${session.bg_task_count} background task marker(s)`}
          onClick={(e) => {
            // Don't let the click bubble into the session-row nav.
            e.stopPropagation();
            fetch("/bg-task-clear-session", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ session_id: session.id }),
            }).catch(() => {
              /* best-effort; the WS broadcast updates the count */
            });
          }}
        >
          <Cog size={14} strokeWidth={2.25} />
          <span className="session-bg-count">{session.bg_task_count}</span>
        </button>
      )}
      {(session.running_subagents ?? 0) > 0 && (
        <button
          type="button"
          className="session-subagent-indicator"
          title={t("sidebar.subagent_running_title", {
            count: session.running_subagents,
          })}
          aria-label={t("sidebar.subagent_running_aria", {
            count: session.running_subagents,
          })}
          onClick={(e) => {
            // Don't let the click bubble into the session-row nav.
            e.stopPropagation();
            fetch("/subagent-clear-session", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ session_id: session.id }),
            }).catch(() => {
              /* best-effort; the WS broadcast updates the count */
            });
          }}
        >
          <Bot size={14} strokeWidth={2.25} />
          <span className="session-subagent-count">
            {session.running_subagents}
          </span>
        </button>
      )}
      {scheduledMessageCount > 0 && onOpenScheduledList && (
        <button
          type="button"
          className="session-timer-indicator"
          title={t("timer.sidebar_title", { count: scheduledMessageCount })}
          aria-label={t("timer.sidebar_title", { count: scheduledMessageCount })}
          onClick={(e) => {
            // Inside the session-row link — don't navigate, just open the list.
            e.preventDefault();
            e.stopPropagation();
            onOpenScheduledList();
          }}
        >
          <Clock size={13} strokeWidth={2} />
          <span className="session-timer-count">{scheduledMessageCount}</span>
        </button>
      )}
      {/* CTX chip is rendered near the end so it sits toward the right edge of
          the right-aligned indicators cell. The working spinner (and the other
          transient indicators) appear to its LEFT, so they no longer push the
          CTX chip left/right as they toggle. */}
      {showCtxChip && ctxBand && (
        <span
          className={`session-ctx-indicator${ctxBand === "critical" ? " ctx-critical" : ""}`}
          title={t("sidebar.ctx_low_title", {
            pct: Math.round(ctxPct as number),
          })}
          aria-label={t("sidebar.ctx_low_aria")}
        >
          CTX
          <span className="ctx-bang" aria-hidden="true">
            !
          </span>
        </span>
      )}
      {session.scheduled_send_at && (
        <span
          className="session-schedule-indicator"
          title={t("sidebar.scheduled_send_title", {
            time: formatScheduleTime(session.scheduled_send_at),
          })}
          aria-label={t("sidebar.scheduled_send_aria")}
        >
          <Send size={13} strokeWidth={2} />
          <Clock
            className="session-schedule-clock"
            size={9}
            strokeWidth={3}
          />
        </span>
      )}
    </span>
  );
}
