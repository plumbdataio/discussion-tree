import { describe, test, expect } from "bun:test";
import { TOOLS, dispatchToolCall } from "../../server/tools.ts";
import { INSTRUCTIONS } from "../../server/instructions.ts";
import { ONBOARD_GUIDE } from "../../server/onboard-guide.ts";

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

describe("instructions bootstrap + onboard tool", () => {
  // The delivered MCP `instructions` payload must stay tiny: the client
  // truncates the combined block at ~4KB across all servers, so the detail
  // lives behind the `onboard` tool instead. Guard against silent regrowth.
  test("delivered INSTRUCTIONS is a small bootstrap (< 2KB)", () => {
    expect(Buffer.byteLength(INSTRUCTIONS, "utf8")).toBeLessThan(2048);
  });

  test("bootstrap compels calling onboard", () => {
    expect(INSTRUCTIONS).toContain("onboard");
  });

  test("onboard tool is registered with no required args", () => {
    const t: any = findTool("onboard");
    // No arguments — it always returns the full guide.
    expect(t.inputSchema.required ?? []).toEqual([]);
  });

  test("onboard returns a non-empty guide as text", async () => {
    const res: any = await dispatchToolCall("onboard", {});
    expect(res.isError).toBeUndefined();
    const text = res.content?.[0]?.text ?? "";
    expect(text).toBe(ONBOARD_GUIDE);
    expect(text.length).toBeGreaterThan(1000);
  });
});
