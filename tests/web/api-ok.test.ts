import "./happydom.ts";
import { describe, test, expect } from "bun:test";
import { okOrThrow } from "../../web/utils/api.ts";

// fetch() rejects on a NETWORK failure only — a 4xx/5xx RESOLVES. Three places
// acted on that resolution as if it meant success: a settings toggle stayed
// flipped after the broker refused it, a map edge stayed drawn after the write
// failed, and undo said "restored" over a restore that never happened. The user
// finds out on the next reload, when the thing they were told had worked is
// gone. (Found by codex, 2026-07-29.)

const res = (status: number, body = "") =>
  Promise.resolve(new Response(body, { status }));

describe("okOrThrow — a refusal is a failure", () => {
  test("passes a 2xx straight through", async () => {
    const r = await okOrThrow(res(200, "fine"));
    expect(r.status).toBe(200);
    expect(await r.text()).toBe("fine");
  });

  test("throws on 4xx and 5xx, which a bare .catch() never saw", async () => {
    expect(okOrThrow(res(400))).rejects.toThrow();
    expect(okOrThrow(res(500))).rejects.toThrow();
  });

  test("carries the server's reason, so the failure is diagnosable", async () => {
    // Without this the UI can only say "something went wrong", and the broker
    // has usually said exactly what.
    expect(okOrThrow(res(409, "board is archived"))).rejects.toThrow(
      /409.*board is archived/,
    );
  });

  test("a network rejection still propagates", async () => {
    expect(okOrThrow(Promise.reject(new Error("offline")))).rejects.toThrow(
      "offline",
    );
  });
});
