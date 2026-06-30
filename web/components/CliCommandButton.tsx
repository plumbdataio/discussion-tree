// Header button that injects a TUI command (currently only /compact) into the
// owning CC's tmux pane via the broker's /cli-send. Opt-in: hidden unless the
// user enabled tmux integration in settings. channels can only carry user
// messages, so a slash command typed here is the only way to trigger e.g.
// /compact from the WebUI.
//
// The button is always shown (when opted in) so it's discoverable; the modal
// then explains/blocks the cases the broker would reject anyway — the owning
// CC isn't in tmux (canCliSend=false), or it's mid-turn / waiting on input
// (busy=true), where the command would be eaten as a chat message.

import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { SquareTerminal, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useSettings } from "../utils/settings.ts";
import { getCliHistory, postCliSend } from "../utils/api.ts";
import { showToast } from "./Toast.tsx";

// The commands the user can pick. Mirrors the broker allowlist; today just one.
const CLI_COMMANDS = ["/compact"] as const;

export function CliCommandButton({
  sessionId,
  canCliSend,
  busy,
}: {
  sessionId: string | undefined;
  canCliSend: boolean;
  busy: boolean;
}) {
  const { t } = useTranslation();
  const [settings] = useSettings();
  const [open, setOpen] = useState(false);

  if (!settings.tmuxIntegration || !sessionId) return null;

  return (
    <>
      <button
        type="button"
        className="cli-command-btn"
        title={t("cli.button_title")}
        aria-label={t("cli.button_title")}
        onClick={() => setOpen(true)}
      >
        <SquareTerminal size={16} strokeWidth={1.9} />
      </button>
      {open && (
        <CliCommandModal
          sessionId={sessionId}
          canCliSend={canCliSend}
          busy={busy}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

function CliCommandModal({
  sessionId,
  canCliSend,
  busy,
  onClose,
}: {
  sessionId: string;
  canCliSend: boolean;
  busy: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [command, setCommand] = useState<string>(CLI_COMMANDS[0]);
  // Starts empty, then auto-fills with the most recently used prompt on the
  // first history load (see below); the user can still pick another from the
  // list or clear it.
  const [args, setArgs] = useState<string>("");
  const [sending, setSending] = useState(false);
  const [history, setHistory] = useState<
    { args: string; last_used_at: string }[]
  >([]);
  // Auto-fill the latest prompt only once, and never over the top of something
  // the user has already typed.
  const didAutofill = useRef(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Load the de-duplicated arg history for the selected command (newest first).
  useEffect(() => {
    let cancelled = false;
    getCliHistory(command).then((h) => {
      if (cancelled) return;
      setHistory(h);
      // Pre-fill with the most recently used prompt (h[0]; the broker orders by
      // last_used_at DESC) so the common "re-run my last compact prompt" path
      // needs no typing. Once only, and only while the textarea is untouched.
      if (!didAutofill.current && h.length > 0) {
        didAutofill.current = true;
        setArgs((cur) => (cur === "" ? h[0].args : cur));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [command]);

  const send = async () => {
    if (sending || busy || !canCliSend) return;
    setSending(true);
    const res = await postCliSend(sessionId, command, args);
    setSending(false);
    if (res.ok) {
      showToast(t("cli.sent_ok"), "ok");
      onClose();
      return;
    }
    // Map the broker's error code to a message; fall back to generic.
    const key = `cli.err_${res.error ?? "generic"}`;
    const msg = t(key);
    showToast(msg === key ? t("cli.err_generic") : msg, "error");
  };

  const disabled = sending || busy || !canCliSend;

  return createPortal(
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal-content cli-command-modal"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          className="modal-close"
          onClick={onClose}
          aria-label={t("modal.close")}
          title={t("modal.close")}
        >
          <X size={18} strokeWidth={1.75} />
        </button>
        <h2 className="settings-title">{t("cli.modal_title")}</h2>

        <div className="cli-command-field">
          <label className="settings-label" htmlFor="cli-command-select">
            {t("cli.command_label")}
          </label>
          <select
            id="cli-command-select"
            className="settings-select"
            value={command}
            onChange={(e) => setCommand(e.target.value)}
          >
            {CLI_COMMANDS.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </div>

        <div className="cli-command-field">
          <label className="settings-label" htmlFor="cli-command-args">
            {t("cli.args_label")}
          </label>
          <textarea
            id="cli-command-args"
            className="cli-command-args"
            rows={10}
            value={args}
            onChange={(e) => setArgs(e.target.value)}
          />
        </div>

        {history.length > 0 && (
          <div className="cli-command-field">
            <label className="settings-label">{t("cli.history_title")}</label>
            <ul className="cli-history-list">
              {history.map((h, i) => (
                <li key={i}>
                  <button
                    type="button"
                    className={`cli-history-item${args === h.args ? " active" : ""}`}
                    title={h.args}
                    onClick={() => setArgs(h.args)}
                  >
                    {h.args.length > 90 ? h.args.slice(0, 90) + "…" : h.args}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        {!canCliSend && (
          <p className="cli-command-note cli-command-note-warn">
            {t("cli.needs_tmux")}
          </p>
        )}
        {canCliSend && busy && (
          <p className="cli-command-note">{t("cli.busy_note")}</p>
        )}

        <div className="cli-command-actions">
          <button type="button" className="cli-command-cancel" onClick={onClose}>
            {t("cli.cancel")}
          </button>
          <button
            type="button"
            className="cli-command-send"
            disabled={disabled}
            onClick={send}
          >
            {sending ? t("cli.sending") : t("cli.send")}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
