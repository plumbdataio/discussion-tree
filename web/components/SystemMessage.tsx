import React from "react";
import { Terminal } from "lucide-react";
import { useTranslation } from "react-i18next";

// A system thread item's text is an opaque marker string. Parse it into a
// discriminated shape so the classification is unit-testable without rendering.
export type ParsedSystemMessage =
  | { kind: "status_change"; from: string; to: string }
  | { kind: "cli_command"; command: string }
  | { kind: "stall_notice"; reason: StallNoticeReason }
  | { kind: "text"; text: string };

// Stall causes the broker drops a one-time notice for, stored as a marker
// ("stall_notice:<reason>", see broker/activity.ts) and rendered here as a
// localized sentence. Only known reasons are recognized; an unknown one falls
// through to plain text.
const STALL_NOTICE_REASONS = ["credits"] as const;
export type StallNoticeReason = (typeof STALL_NOTICE_REASONS)[number];

export function parseSystemMessage(text: string): ParsedSystemMessage {
  const m = text.match(/^status_change:([^:]+):([^:]+)$/);
  if (m) return { kind: "status_change", from: m[1], to: m[2] };
  // A CLI command issued from the WebUI (e.g. "cli_command:/compact").
  const cmd = text.match(/^cli_command:(.+)$/);
  if (cmd) return { kind: "cli_command", command: cmd[1] };
  const stall = text.match(/^stall_notice:([a-z_]+)$/);
  if (stall && (STALL_NOTICE_REASONS as readonly string[]).includes(stall[1])) {
    return { kind: "stall_notice", reason: stall[1] as StallNoticeReason };
  }
  return { kind: "text", text };
}

export function renderSystemMessage(text: string): React.ReactNode {
  const parsed = parseSystemMessage(text);
  switch (parsed.kind) {
    case "status_change":
      return <StatusChangeMessage from={parsed.from} to={parsed.to} />;
    case "cli_command":
      return <CliCommandMessage command={parsed.command} />;
    case "stall_notice":
      return <StallNoticeMessage reason={parsed.reason} />;
    default:
      return parsed.text;
  }
}

function StallNoticeMessage({ reason }: { reason: StallNoticeReason }) {
  const { t } = useTranslation();
  return <span>{t(`system_message.stall_${reason}`)}</span>;
}

function CliCommandMessage({ command }: { command: string }) {
  const { t } = useTranslation();
  return (
    <>
      <Terminal size={13} strokeWidth={1.75} />
      <span>{t("system_message.cli_command", { command })}</span>
    </>
  );
}

function StatusChangeMessage({ from, to }: { from: string; to: string }) {
  const { t } = useTranslation();
  return (
    <>
      {t("system_message.status_label")}{" "}
      <strong>{t([`node_status.${from}`, from])}</strong>
      {" → "}
      <strong>{t([`node_status.${to}`, to])}</strong>
    </>
  );
}
