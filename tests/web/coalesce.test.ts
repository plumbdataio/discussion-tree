import { describe, test, expect } from "bun:test";
import { coalesce } from "../../web/utils/coalesce.ts";

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
  };
}

// One "sidebar-refresh" burst (the broker's back-to-back broadcasts, plus any
// other dispatcher) must cost ONE /api/sessions fetch.
describe("coalesce", () => {
  test("a burst of triggers runs the function once", () => {
    const t = fakeTimers();
    let calls = 0;
    const trigger = coalesce(() => calls++, 50, t);
    trigger();
    trigger();
    trigger();
    expect(calls).toBe(0);
    t.fire();
    expect(calls).toBe(1);
  });

  test("a trigger after the burst ran starts a new one", () => {
    const t = fakeTimers();
    let calls = 0;
    const trigger = coalesce(() => calls++, 50, t);
    trigger();
    t.fire();
    trigger();
    t.fire();
    expect(calls).toBe(2);
  });

  test("cancel drops a pending run", () => {
    const t = fakeTimers();
    let calls = 0;
    const trigger = coalesce(() => calls++, 50, t);
    trigger();
    trigger.cancel();
    t.fire();
    expect(calls).toBe(0);
  });
});
