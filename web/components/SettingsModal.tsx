import React, { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { SupportedLanguage } from "../i18n.ts";
import { type ThemeChoice, useSettings } from "../utils/settings.ts";

type PowerPref = "off" | "while-broker" | "while-mcp-active";

export function SettingsModal({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const [settings, update] = useSettings();
  // Sleep-prevention is a per-broker (i.e. per-machine) setting, so it lives
  // server-side rather than in localStorage. Fetch on mount and POST on
  // change. `platform` is returned by the broker so we can grey out the
  // selector on platforms we don't (yet) implement a wake-lock for.
  const [powerPref, setPowerPref] = useState<PowerPref>("off");
  const [powerPlatform, setPowerPlatform] = useState<string>("");
  // Shown once, when the user FIRST enables CLI command-send: it only works for
  // CC launched inside tmux, which isn't obvious. (9787)
  const [showCliExplainer, setShowCliExplainer] = useState(false);
  useEffect(() => {
    fetch("/get-power-config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    })
      .then((r) => r.json())
      .then((d: { pref?: PowerPref; platform?: string }) => {
        if (d.pref) setPowerPref(d.pref);
        if (d.platform) setPowerPlatform(d.platform);
      })
      .catch(() => {
        /* ignore — broker may be momentarily unreachable */
      });
  }, []);
  const updatePower = (next: PowerPref) => {
    setPowerPref(next);
    fetch("/set-power-config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pref: next }),
    }).catch(() => {
      /* ignore */
    });
  };

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose]);

  // Portal into document.body so .board-container's layout containment
  // can't trap the fixed backdrop.
  return createPortal(
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal-content settings-modal"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          className="modal-close"
          onClick={onClose}
          aria-label={t("modal.close")}
          title={t("settings.close")}
        >
          <X size={18} strokeWidth={1.75} />
        </button>
        <h2 className="settings-title">{t("settings.title")}</h2>

        <div className="settings-row">
          <label className="settings-label" htmlFor="settings-auto-read">
            {t("settings.auto_read_label")}
          </label>
          <div className="settings-control">
            <input
              id="settings-auto-read"
              type="checkbox"
              checked={settings.autoReadEnabled}
              onChange={(e) =>
                update({ autoReadEnabled: e.target.checked })
              }
            />
          </div>
          <p className="settings-help">{t("settings.auto_read_help")}</p>
        </div>

        <div className="settings-row">
          <label className="settings-label" htmlFor="settings-language">
            {t("settings.language_label")}
          </label>
          <div className="settings-control">
            <select
              id="settings-language"
              className="settings-select"
              value={settings.language}
              onChange={(e) =>
                update({ language: e.target.value as SupportedLanguage })
              }
            >
              <option value="system">{t("settings.language_system")}</option>
              <option value="ja">{t("settings.language_ja")}</option>
              <option value="en">{t("settings.language_en")}</option>
            </select>
          </div>
          <p className="settings-help">{t("settings.language_help")}</p>
        </div>

        <div className="settings-row">
          <label className="settings-label" htmlFor="settings-theme">
            {t("settings.theme_label")}
          </label>
          <div className="settings-control">
            <select
              id="settings-theme"
              className="settings-select"
              value={settings.theme}
              onChange={(e) =>
                update({ theme: e.target.value as ThemeChoice })
              }
            >
              <option value="system">{t("settings.theme_system")}</option>
              <option value="light">{t("settings.theme_light")}</option>
              <option value="dark">{t("settings.theme_dark")}</option>
            </select>
          </div>
          <p className="settings-help">{t("settings.theme_help")}</p>
        </div>

        <div className="settings-row">
          <label className="settings-label" htmlFor="settings-power">
            {t("settings.power_label")}
          </label>
          <div className="settings-control">
            <select
              id="settings-power"
              className="settings-select"
              value={powerPref}
              onChange={(e) => updatePower(e.target.value as PowerPref)}
            >
              <option value="off">{t("settings.power_off")}</option>
              <option value="while-mcp-active">
                {t("settings.power_while_mcp")}
              </option>
              <option value="while-broker">
                {t("settings.power_while_broker")}
              </option>
            </select>
          </div>
          <p className="settings-help">
            {t("settings.power_help", { platform: powerPlatform || "?" })}
          </p>
        </div>

        <div className="settings-row">
          <label className="settings-label" htmlFor="settings-cli-command">
            {t("settings.cli_command_label")}
          </label>
          <div className="settings-control">
            <input
              id="settings-cli-command"
              type="checkbox"
              checked={settings.cliCommandSend}
              onChange={(e) => {
                update({ cliCommandSend: e.target.checked });
                // Explain the tmux requirement the moment it's switched on.
                if (e.target.checked) setShowCliExplainer(true);
              }}
            />
          </div>
          <p className="settings-help">{t("settings.cli_command_help")}</p>
        </div>

        <p className="settings-footer">{t("settings.footer")}</p>
      </div>
      {showCliExplainer &&
        createPortal(
          <div
            className="modal-backdrop"
            onClick={() => setShowCliExplainer(false)}
          >
            <div
              className="modal-content cli-explainer-modal"
              onClick={(e) => e.stopPropagation()}
            >
              <h2 className="settings-title">{t("cli.explainer_title")}</h2>
              <p className="settings-help cli-explainer-body">
                {t("cli.explainer_body")}
              </p>
              <div className="cli-explainer-actions">
                <button
                  type="button"
                  className="cli-explainer-ok"
                  onClick={() => setShowCliExplainer(false)}
                >
                  {t("cli.explainer_ok")}
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </div>,
    document.body,
  );
}
