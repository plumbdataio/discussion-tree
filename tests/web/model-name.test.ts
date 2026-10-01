import { describe, test, expect } from "bun:test";
import { friendlyModelName } from "../../web/utils/modelName.ts";

describe("friendlyModelName", () => {
  test.each([
    ["claude-opus-5-5", "Opus 5.5"],
    ["claude-sonnet-5", "Sonnet 5"],
    ["claude-haiku-4-5-20251001", "Haiku 4.5"],
    ["claude-fable-5-1", "Fable 5.1"],
    ["claude-opus-4-1-20250805", "Opus 4.1"],
    ["claude-3-5-sonnet-20241022", "Sonnet 3.5"],
    ["claude-3-opus-20240229", "Opus 3"],
    ["us.anthropic.claude-opus-4-1-20250805-v1:0", "Opus 4.1"],
    ["anthropic.claude-sonnet-4-5-20250929-v1:0", "Sonnet 4.5"],
    ["claude-opus-4-1@20250805", "Opus 4.1"],
    ["claude-opus-5-5[1m]", "Opus 5.5"],
  ])("%s -> %s", (raw, want) => {
    expect(friendlyModelName(raw)).toBe(want);
  });

  test.each([
    "gpt-5",
    "some-model",
    "claude-",
    "claude-opus",
    "claude-opus-5-5-5",
    "claude-opus-preview",
    "",
  ])("unrecognised id %p is returned unchanged", (raw) => {
    expect(friendlyModelName(raw)).toBe(raw);
  });
});
