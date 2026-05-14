import { describe, test, expect } from "bun:test";
import { TOOLS } from "../../server/tools.ts";

function findTool(name: string) {
  const t = TOOLS.find((x: any) => x.name === name);
  if (!t) throw new Error(`tool ${name} not registered`);
  return t;
}

describe("MCP tool input schemas", () => {
  test("set_board_status enum covers the current 5-value taxonomy + legacy 'active'", () => {
    const t: any = findTool("set_board_status");
    const enums: string[] = t.inputSchema.properties.status.enum;
    // The auto-managed pair and the explicit-lifecycle trio.
    for (const expected of [
      "discussing",
      "settled",
      "completed",
      "withdrawn",
      "paused",
    ]) {
      expect(enums).toContain(expected);
    }
    // Legacy 'active' is still in the enum so older LLMs/agents that pass it
    // don't get a schema rejection at the MCP layer; broker normalizes it.
    expect(enums).toContain("active");
  });

  test("set_node_status enum is the current 8-value node taxonomy", () => {
    const t: any = findTool("set_node_status");
    const enums: string[] = t.inputSchema.properties.status.enum;
    for (const expected of [
      "pending",
      "discussing",
      "resolved",
      "agreed",
      "adopted",
      "rejected",
      "needs-reply",
      "done",
    ]) {
      expect(enums).toContain(expected);
    }
  });
});
