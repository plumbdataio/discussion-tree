import "./happydom.ts";
import { describe, test, expect, beforeAll, afterEach } from "bun:test";
import { createRoot, type Root } from "react-dom/client";
import { createElement, act } from "react";
import i18n from "../../web/i18n.ts";
import { SessionActivityIcons } from "../../web/components/SessionActivityIcons.tsx";
import { ActivityBadge } from "../../web/components/ActivityBadge.tsx";
import { clearWorkingActivity } from "../../web/utils/clearWorkingActivity.ts";
import type { Activity } from "../../shared/types.ts";

// Clicking the hook-managed "working" spinner (sidebar row / header badge)
// dismisses it via /clear-working-activity — the escape hatch for a Stop-hook
// clear that never reached the broker. Explicit states stay non-clickable, and
// the click must not reach the surrounding session-row link.

type Call = { url: string; init: RequestInit | undefined };
let calls: Call[] = [];
const realFetch = globalThis.fetch;
function mockFetch() {
  calls = [];
  globalThis.fetch = (async (url: any, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({ ok: true, cleared: true }));
  }) as typeof fetch;
}

let root: Root | null = null;
let host: HTMLElement | null = null;
async function render(el: any) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root!.render(el));
  return host;
}

beforeAll(async () => {
  if (!i18n.isInitialized) {
    await new Promise<void>((resolve) => i18n.on("initialized", () => resolve()));
  }
  await i18n.changeLanguage("en");
});
afterEach(async () => {
  globalThis.fetch = realFetch;
  if (root) await act(async () => root!.unmount());
  host?.remove();
  root = null;
  host = null;
});

const session: any = { id: "sess-1", name: "s", alive: 1 };
const working: Activity = {
  session_id: "sess-1",
  state: "working",
  message: "Bash",
  set_at: "2026-10-23T00:00:00Z",
};
const blocked: Activity = { ...working, state: "blocked", message: "Q?" };

function rowLink(child: any, onRowClick: () => void) {
  return createElement("a", { href: "#/s/sess-1", onClick: onRowClick }, child);
}

describe("SessionActivityIcons working spinner", () => {
  test("click clears via /clear-working-activity and does not reach the row", async () => {
    mockFetch();
    let rowClicks = 0;
    const h = await render(
      rowLink(createElement(SessionActivityIcons, { session, activity: working }), () => rowClicks++),
    );
    const btn = h.querySelector("button.session-activity-indicator") as HTMLButtonElement;
    expect(btn).not.toBeNull();
    expect(btn.getAttribute("aria-label")).toBe("Clear the working indicator");
    expect(btn.title).toContain("Click to clear the working indicator");
    await act(async () => btn.click());
    expect(rowClicks).toBe(0);
    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe("/clear-working-activity");
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ session_id: "sess-1" });
  });

  test("an explicit state (blocked) is not a button and posts nothing", async () => {
    mockFetch();
    const h = await render(createElement(SessionActivityIcons, { session, activity: blocked }));
    expect(h.querySelector("button.session-activity-indicator")).toBeNull();
    const span = h.querySelector("span.session-activity-indicator.activity-blocked");
    expect(span).not.toBeNull();
    await act(async () => (span as HTMLElement).click());
    expect(calls.length).toBe(0);
  });
});

describe("ActivityBadge (header)", () => {
  test("clearable working badge clears on click", async () => {
    mockFetch();
    let parentClicks = 0;
    const h = await render(
      createElement(
        "div",
        { onClick: () => parentClicks++ },
        createElement(ActivityBadge, { activity: working, clearable: true }),
      ),
    );
    const btn = h.querySelector("button.activity-badge") as HTMLButtonElement;
    expect(btn).not.toBeNull();
    await act(async () => btn.click());
    expect(parentClicks).toBe(0);
    expect(calls.map((c) => c.url)).toEqual(["/clear-working-activity"]);
  });

  test("not clearable without the prop, nor for a non-working state", async () => {
    mockFetch();
    const h = await render(
      createElement(
        "div",
        null,
        createElement(ActivityBadge, { activity: working }),
        createElement(ActivityBadge, { activity: blocked, clearable: true }),
      ),
    );
    expect(h.querySelector("button")).toBeNull();
    expect(h.querySelectorAll("span.activity-badge").length).toBe(2);
  });

  test("ja tooltip text", async () => {
    await i18n.changeLanguage("ja");
    try {
      const h = await render(createElement(ActivityBadge, { activity: working, clearable: true }));
      const btn = h.querySelector("button.activity-badge") as HTMLButtonElement;
      expect(btn.title).toBe(i18n.t("activity.clear_working_hint"));
      expect(btn.title.length).toBeGreaterThan(0);
      expect(btn.title).not.toBe("activity.clear_working_hint");
    } finally {
      // The badge is still mounted (unmounted in afterEach) -> re-renders.
      await act(async () => {
        await i18n.changeLanguage("en");
      });
    }
  });
});

describe("clearWorkingActivity", () => {
  test("empty session id posts nothing; fetch failure is swallowed", async () => {
    let n = 0;
    const f = (async () => {
      n++;
      throw new Error("offline");
    }) as unknown as typeof fetch;
    await clearWorkingActivity("", f);
    expect(n).toBe(0);
    await clearWorkingActivity("sess-1", f); // must not reject
    expect(n).toBe(1);
  });
});
