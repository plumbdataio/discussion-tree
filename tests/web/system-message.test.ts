import "./happydom.ts";
import { describe, test, expect } from "bun:test";
import { parseSystemMessage } from "../../web/components/SystemMessage.tsx";

// System thread items carry an opaque marker string. parseSystemMessage
// classifies it: status-change transitions, CLI commands issued from the WebUI
// (e.g. a /compact send → green "system command" chip), or plain passthrough.

describe("parseSystemMessage", () => {
  test("classifies a status_change marker", () => {
    expect(parseSystemMessage("status_change:pending:done")).toEqual({
      kind: "status_change",
      from: "pending",
      to: "done",
    });
  });

  test("classifies a cli_command marker and keeps the command verbatim", () => {
    expect(parseSystemMessage("cli_command:/compact")).toEqual({
      kind: "cli_command",
      command: "/compact",
    });
  });

  test("cli_command captures everything after the prefix (incl. spaces)", () => {
    expect(parseSystemMessage("cli_command:/compact keep the plan")).toEqual({
      kind: "cli_command",
      command: "/compact keep the plan",
    });
  });

  test("falls back to plain text for an unrecognized marker", () => {
    expect(parseSystemMessage("just some note")).toEqual({
      kind: "text",
      text: "just some note",
    });
  });

  test("a malformed status_change (missing parts) is not misclassified", () => {
    // Only the exact 2-part shape is a transition; anything else is plain text.
    expect(parseSystemMessage("status_change:pending").kind).toBe("text");
  });
});
