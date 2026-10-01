import React from "react";
import { friendlyModelName } from "../utils/modelName.ts";

// @reusable-ui ModelChip — USE WHEN: showing which Claude model a session is
// running (e.g. "Opus 5.5", following a `/model` switch) INSTEAD OF printing the
// raw model id or hand-rolling a label. Feed it the raw id from the shared
// useSessionModel(sessionId) store (web/utils/sessionModel.ts, populated by the
// Sidebar's poll); it renders nothing for null and shows the raw id on hover.
// In a page header, place it right after UsageLimitsChip — left of the transient
// warning / activity badges — so it never moves the chips before it.

function ModelChipImpl({ model }: { model: string | null | undefined }) {
  if (!model) return null;
  return (
    <span className="model-chip" title={model}>
      {friendlyModelName(model)}
    </span>
  );
}

export const ModelChip = React.memo(ModelChipImpl);
