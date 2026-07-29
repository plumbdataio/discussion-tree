import "./happydom.ts";
import { describe, test, expect, beforeEach } from "bun:test";
import { noteBuildId, resetBuildIdMemory } from "../../web/utils/appUpdate.ts";

// Replaces HMR, which reloaded the user's page on every edit under web/ and made
// the app unusable while an agent worked in it. The broker states which frontend
// it serves on every socket open; a tab that reconnects to a different one knows
// it is stale. The mistake to guard against is announcing at the wrong moment —
// a flapping socket must not nag once per retry, and the very first frame is not
// news, it is the tab learning what it loaded with.

beforeEach(() => resetBuildIdMemory());

describe("app update — deciding a tab is stale", () => {
  test("the first id seen is the tab's own build, not an update", () => {
    expect(noteBuildId("abc")).toBe(false);
  });

  test("the same id on every reconnect stays quiet", () => {
    noteBuildId("abc");
    expect(noteBuildId("abc")).toBe(false);
    expect(noteBuildId("abc")).toBe(false);
  });

  test("a different id announces exactly once", () => {
    noteBuildId("abc");
    expect(noteBuildId("def")).toBe(true);
    // A socket that keeps dropping would otherwise re-announce on every retry.
    expect(noteBuildId("def")).toBe(false);
    // Even a THIRD build does not re-announce: the banner is already up and
    // says the same thing.
    expect(noteBuildId("ghi")).toBe(false);
  });

  test("a missing or malformed id is ignored rather than treated as new", () => {
    // A frame without a build id must not be mistaken for "the frontend
    // changed" — that would put the banner up on any protocol change.
    expect(noteBuildId(undefined)).toBe(false);
    expect(noteBuildId("")).toBe(false);
    expect(noteBuildId(42)).toBe(false);
    // ...and none of those should have been recorded as the tab's own build,
    // so the first real id is still just "what we loaded with".
    expect(noteBuildId("abc")).toBe(false);
    expect(noteBuildId("def")).toBe(true);
  });
});
