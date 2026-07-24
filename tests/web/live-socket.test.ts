import "./happydom.ts";
import { describe, test, expect } from "bun:test";
import {
  RECONNECT_BASE_MS,
  RECONNECT_MAX_MS,
  anyDisconnected,
  applyWsState,
  reconnectDelay,
  type WsStateMap,
} from "../../web/utils/liveSocket.ts";

const LOW = () => 0; // jitter dialled all the way down
const HIGH = () => 1; // jitter dialled all the way up

describe("reconnectDelay", () => {
  test("first retry is quick but never instant", () => {
    // Equal jitter: half the window is fixed, so the floor is base/2 — a
    // zero-delay retry would hammer a broker that just went down.
    expect(reconnectDelay(0, LOW)).toBe(RECONNECT_BASE_MS / 2);
    expect(reconnectDelay(0, HIGH)).toBe(RECONNECT_BASE_MS);
  });

  test("doubles per attempt until the cap", () => {
    expect(reconnectDelay(1, HIGH)).toBe(2000);
    expect(reconnectDelay(2, HIGH)).toBe(4000);
    expect(reconnectDelay(3, HIGH)).toBe(8000);
  });

  test("never exceeds the cap, however long the tab has been retrying", () => {
    for (const attempt of [4, 8, 20, 500, 1e9]) {
      expect(reconnectDelay(attempt, HIGH)).toBeLessThanOrEqual(
        RECONNECT_MAX_MS,
      );
      expect(reconnectDelay(attempt, LOW)).toBe(RECONNECT_MAX_MS / 2);
    }
  });

  test("jitter stays inside [cap/2, cap]", () => {
    for (let attempt = 0; attempt < 8; attempt++) {
      const cap = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** attempt);
      const d = reconnectDelay(attempt, () => 0.37);
      expect(d).toBeGreaterThanOrEqual(cap / 2);
      expect(d).toBeLessThanOrEqual(cap);
    }
  });

  test("tolerates junk attempt values instead of returning NaN", () => {
    expect(reconnectDelay(-5, HIGH)).toBe(RECONNECT_BASE_MS);
    expect(reconnectDelay(NaN, HIGH)).toBe(RECONNECT_BASE_MS);
    expect(reconnectDelay(1.9, HIGH)).toBe(2000);
  });
});

describe("applyWsState", () => {
  test("records a socket's state", () => {
    const next = applyWsState({}, { id: "ws1", connected: false });
    expect(next).toEqual({ ws1: false });
  });

  test("returns the same object when nothing changed (lets React bail out)", () => {
    const prev: WsStateMap = { ws1: true };
    expect(applyWsState(prev, { id: "ws1", connected: true })).toBe(prev);
  });

  test("drops a socket that went away rather than leaving it 'disconnected'", () => {
    // A page navigation unmounts its socket; keeping the last known state would
    // strand a phantom "disconnected" entry and pin the banner open forever.
    const prev: WsStateMap = { ws1: false, ws2: true };
    const next = applyWsState(prev, { id: "ws1", connected: false, gone: true });
    expect(next).toEqual({ ws2: true });
    expect(anyDisconnected(next)).toBe(false);
  });

  test("ignores a gone event for an unknown socket", () => {
    const prev: WsStateMap = { ws2: true };
    expect(applyWsState(prev, { id: "nope", connected: false, gone: true })).toBe(
      prev,
    );
  });

  test("ignores malformed events", () => {
    const prev: WsStateMap = { ws1: true };
    expect(applyWsState(prev, undefined as any)).toBe(prev);
    expect(applyWsState(prev, { connected: false } as any)).toBe(prev);
  });
});

describe("anyDisconnected", () => {
  test("nothing tracked means nothing to report", () => {
    expect(anyDisconnected({})).toBe(false);
  });

  test("one down socket is enough", () => {
    expect(anyDisconnected({ ws1: true, ws2: false })).toBe(true);
    expect(anyDisconnected({ ws1: true, ws2: true })).toBe(false);
  });
});
