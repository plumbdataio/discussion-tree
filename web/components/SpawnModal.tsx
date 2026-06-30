// Sidebar "+" modal: create (or resume) a Claude Code session in a detached
// tmux session, driven entirely from discussion-tree. claude is launched
// through the user's login shell, so their normal claude environment (PATH, any
// cwd -> CLAUDE_CONFIG_DIR wrapper) applies — dt only needs the launch flags,
// which are authored here once and persisted server-side. First run shows the
// options section expanded; afterwards it collapses and you just pick a cwd (or
// a session to resume). Gated behind the tmux-integration setting in the sidebar.

import React, { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, ChevronRight, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  getSpawnConfig,
  spawnSession,
  type SpawnConfigResponse,
  type SpawnSettings,
} from "../utils/api.ts";
import { showToast } from "./Toast.tsx";

export function SpawnModal({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const [boot, setBoot] = useState<SpawnConfigResponse | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);

  // Persisted launch config (edited in the collapsible section below).
  const [baseArgsText, setBaseArgsText] = useState("");
  const [shell, setShell] = useState("");
  const [tmuxBin, setTmuxBin] = useState("");
  const [configOpen, setConfigOpen] = useState(false);
  // Carried through unchanged.
  const [tmuxSession, setTmuxSession] = useState("dt-fleet");
  const [enterCount, setEnterCount] = useState(2);
  const [enterIntervalMs, setEnterIntervalMs] = useState(5000);

  // Per-spawn choices.
  const [mode, setMode] = useState<"new" | "resume">("new");
  const [cwd, setCwd] = useState("");
  const [resumeCcId, setResumeCcId] = useState("");

  const [confirming, setConfirming] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    let cancelled = false;
    getSpawnConfig().then((b) => {
      if (cancelled) return;
      if (!b) {
        setLoadFailed(true);
        return;
      }
      setBoot(b);
      const s = b.settings ?? b.defaults;
      setBaseArgsText((s.base_args ?? []).join("\n"));
      setShell(s.shell ?? "");
      setTmuxBin(s.tmux_bin ?? "");
      setTmuxSession(s.tmux_session || "dt-fleet");
      setEnterCount(s.enter_count ?? 2);
      setEnterIntervalMs(s.enter_interval_ms ?? 5000);
      // First run (nothing saved) → reveal the options section.
      setConfigOpen(b.settings === null);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const buildConfig = (): SpawnSettings => ({
    base_args: baseArgsText
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean),
    shell: shell.trim(),
    tmux_bin: tmuxBin.trim(),
    tmux_session: tmuxSession.trim() || "dt-fleet",
    enter_count: enterCount,
    enter_interval_ms: enterIntervalMs,
  });

  const canSpawn =
    mode === "new" ? !!cwd.trim() : !!resumeCcId;

  const doSpawn = async () => {
    if (sending) return;
    setSending(true);
    setError(null);
    const config = buildConfig();
    const body =
      mode === "new"
        ? { mode, config, cwd: cwd.trim() }
        : { mode, config, resume_cc_session_id: resumeCcId };
    const res = await spawnSession(body);
    setSending(false);
    if (res.ok) {
      showToast(t("spawn.spawned_ok"), "ok");
      onClose();
    } else {
      setConfirming(false);
      setError(res.error ?? "?");
    }
  };

  const resumable = boot?.resumable ?? [];
  const knownCwds = boot?.known_cwds ?? [];
  const selectedResume = resumable.find((r) => r.cc_session_id === resumeCcId);

  return createPortal(
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal-content spawn-modal"
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
        <h2 className="settings-title">{t("spawn.modal_title")}</h2>

        {loadFailed && (
          <p className="cli-command-note cli-command-note-warn">
            {t("spawn.load_failed")}
          </p>
        )}

        <div className="spawn-mode-tabs">
          <button
            type="button"
            className={mode === "new" ? "active" : ""}
            onClick={() => setMode("new")}
          >
            {t("spawn.mode_new")}
          </button>
          <button
            type="button"
            className={mode === "resume" ? "active" : ""}
            onClick={() => setMode("resume")}
          >
            {t("spawn.mode_resume")}
          </button>
        </div>

        {mode === "new" ? (
          <div className="cli-command-field">
            <label className="settings-label">{t("spawn.cwd_label")}</label>
            <input
              className="settings-input"
              list="spawn-cwds"
              value={cwd}
              onChange={(e) => setCwd(e.target.value)}
              placeholder="/Users/you/Code/project"
            />
            <datalist id="spawn-cwds">
              {knownCwds.map((c) => (
                <option key={c} value={c} />
              ))}
            </datalist>
            <p className="spawn-hint">{t("spawn.cwd_hint")}</p>
          </div>
        ) : (
          <div className="cli-command-field">
            <label className="settings-label">{t("spawn.resume_label")}</label>
            <select
              className="settings-select"
              value={resumeCcId}
              onChange={(e) => setResumeCcId(e.target.value)}
            >
              <option value="">{t("spawn.resume_placeholder")}</option>
              {resumable.map((r) => (
                <option key={r.cc_session_id} value={r.cc_session_id}>
                  {(r.name || r.cc_session_id.slice(0, 8)) +
                    (r.cwd ? ` — ${r.cwd}` : "") +
                    (r.alive ? " (alive)" : "")}
                </option>
              ))}
            </select>
            {selectedResume?.alive ? (
              <p className="cli-command-note cli-command-note-warn">
                {t("spawn.resume_alive_warn")}
              </p>
            ) : null}
          </div>
        )}

        <div className="spawn-config">
          <button
            type="button"
            className="spawn-config-toggle"
            onClick={() => setConfigOpen((v) => !v)}
          >
            {configOpen ? (
              <ChevronDown size={14} strokeWidth={1.9} />
            ) : (
              <ChevronRight size={14} strokeWidth={1.9} />
            )}
            <span>{t("spawn.options_title")}</span>
          </button>
          {configOpen && (
            <div className="spawn-config-body">
              <div className="cli-command-field">
                <label className="settings-label">
                  {t("spawn.base_args_label")}
                </label>
                <textarea
                  className="cli-command-args"
                  rows={5}
                  value={baseArgsText}
                  onChange={(e) => setBaseArgsText(e.target.value)}
                />
                <p className="spawn-hint">{t("spawn.base_args_hint")}</p>
              </div>
              <div className="cli-command-field">
                <label className="settings-label">{t("spawn.shell_label")}</label>
                <input
                  className="settings-input"
                  value={shell}
                  onChange={(e) => setShell(e.target.value)}
                  placeholder="$SHELL"
                />
                <p className="spawn-hint">{t("spawn.shell_hint")}</p>
              </div>
              <div className="cli-command-field">
                <label className="settings-label">
                  {t("spawn.tmux_bin_label")}
                </label>
                <input
                  className="settings-input"
                  value={tmuxBin}
                  onChange={(e) => setTmuxBin(e.target.value)}
                  placeholder="tmux"
                />
              </div>
            </div>
          )}
        </div>

        {error && (
          <p className="cli-command-note cli-command-note-warn">
            {t("spawn.spawn_failed", { error })}
          </p>
        )}

        {confirming ? (
          <div className="spawn-confirm">
            <p className="cli-command-note cli-command-note-warn">
              {t("spawn.confirm_text")}
            </p>
            <div className="cli-command-actions">
              <button
                type="button"
                className="cli-command-cancel"
                onClick={() => setConfirming(false)}
              >
                {t("spawn.cancel")}
              </button>
              <button
                type="button"
                className="cli-command-send"
                disabled={sending}
                onClick={doSpawn}
              >
                {sending ? t("spawn.spawning") : t("spawn.confirm_spawn")}
              </button>
            </div>
          </div>
        ) : (
          <div className="cli-command-actions">
            <button
              type="button"
              className="cli-command-cancel"
              onClick={onClose}
            >
              {t("spawn.cancel")}
            </button>
            <button
              type="button"
              className="cli-command-send"
              disabled={!canSpawn}
              onClick={() => {
                setError(null);
                setConfirming(true);
              }}
            >
              {t("spawn.spawn")}
            </button>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
