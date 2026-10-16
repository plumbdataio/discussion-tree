import { describe, test, expect } from "bun:test";
import { createBoardCacheWriter } from "../../web/utils/boardCache.ts";
import type { BoardView } from "../../shared/types.ts";

// Manual timer so the debounce is tested without real waiting.
function fakeTimers() {
  let next = 1;
  const pending = new Map<number, () => void>();
  return {
    set: (fn: () => void, _ms: number) => {
      const id = next++;
      pending.set(id, fn);
      return id;
    },
    clear: (h: unknown) => {
      pending.delete(h as number);
    },
    fire() {
      const fns = [...pending.values()];
      pending.clear();
      for (const f of fns) f();
    },
    get count() {
      return pending.size;
    },
  };
}

const v = (n: number) => ({ board: { id: `v${n}` } }) as unknown as BoardView;

function setup() {
  const timers = fakeTimers();
  const writes: [string, BoardView][] = [];
  const w = createBoardCacheWriter({
    write: (id, view) => writes.push([id, view]),
    delayMs: 3000,
    setTimer: timers.set,
    clearTimer: timers.clear,
  });
  return { timers, writes, w };
}

describe("createBoardCacheWriter", () => {
  test("a burst of views writes only the last one, after the quiet period", () => {
    const { timers, writes, w } = setup();
    const a = v(1), b = v(2), c = v(3);
    w.schedule("bd", a);
    w.schedule("bd", b);
    w.schedule("bd", c);
    expect(writes).toEqual([]);
    expect(timers.count).toBe(1); // trailing: one live timer, re-armed
    timers.fire();
    expect(writes).toEqual([["bd", c]]);
  });

  test("flush writes immediately (tab hidden / pagehide) and cancels the timer", () => {
    const { timers, writes, w } = setup();
    const a = v(1);
    w.schedule("bd", a);
    w.flush();
    expect(writes).toEqual([["bd", a]]);
    expect(timers.count).toBe(0);
    w.flush(); // nothing pending: no second write
    expect(writes.length).toBe(1);
  });

  test("re-scheduling the view already written is skipped", () => {
    const { timers, writes, w } = setup();
    const a = v(1);
    w.schedule("bd", a);
    timers.fire();
    w.schedule("bd", a);
    expect(timers.count).toBe(0);
    timers.fire();
    expect(writes.length).toBe(1);
  });

  test("each board keeps its own latest view", () => {
    const { timers, writes, w } = setup();
    const a = v(1), b = v(2), c = v(3);
    w.schedule("bd1", a);
    w.schedule("bd2", b);
    w.schedule("bd1", c);
    timers.fire();
    expect(writes).toEqual([
      ["bd1", c],
      ["bd2", b],
    ]);
  });
});
