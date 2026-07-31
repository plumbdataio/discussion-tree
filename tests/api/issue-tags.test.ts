import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  startBroker,
  post,
  registerSession,
  type BrokerHandle,
} from "../harness/broker-harness.ts";

// Tags are free-text labels an issue carries, many per issue. The broker is the
// one gate they pass through: it trims, drops empties, rejects anything over the
// length cap, dedupes, and returns the set (sorted) on every read. update takes
// the FULL desired set and REPLACES it, so add and remove are the same write.

let broker: BrokerHandle;

beforeAll(async () => {
  broker = await startBroker();
});
afterAll(async () => {
  await broker.kill();
});

type Issue = {
  id: string;
  title: string;
  tags?: string[];
  session_id: string | null;
};

const create = async (fields: Record<string, unknown> = {}) => {
  const r = await post<{ ok: boolean; issue: Issue; error?: string }>(
    `${broker.url}/create-issue`,
    { title: "tagged issue", ...fields },
  );
  return r.json;
};

const update = (id: string, fields: Record<string, unknown>) =>
  post<{ ok: boolean; issue?: Issue; error?: string }>(
    `${broker.url}/update-issue`,
    { issue_id: id, ...fields },
  );

describe("issue tags — create", () => {
  test("create stores tags and returns them sorted", async () => {
    const r = await create({ tags: ["ui", "perf"] });
    expect(r.ok).toBe(true);
    // Sorted on read, so the chips render in a stable order regardless of input.
    expect(r.issue.tags).toEqual(["perf", "ui"]);
  });

  test("trims, drops empties, and dedupes within an issue", async () => {
    const r = await create({ tags: ["  ui  ", "ui", "", "   ", "bug"] });
    expect(r.issue.tags).toEqual(["bug", "ui"]);
  });

  test("no tags field means no tags", async () => {
    const r = await create({});
    expect(r.issue.tags).toEqual([]);
  });

  test("a tag over the length cap is rejected, and nothing is filed", async () => {
    const long = "x".repeat(21);
    const r = await create({ title: "too long a tag", tags: ["ok", long] });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/too long|20/i);
    // The whole create was rejected — the issue must not exist with only "ok".
    const list = await post<{ issues: Issue[] }>(`${broker.url}/list-issues`, {
      include_closed: true,
    });
    expect(list.json.issues.some((i) => i.title === "too long a tag")).toBe(false);
  });

  test("exactly the cap length is allowed", async () => {
    const r = await create({ tags: ["x".repeat(20)] });
    expect(r.ok).toBe(true);
    expect(r.issue.tags).toEqual(["x".repeat(20)]);
  });

  test("tags must be an array", async () => {
    const r = await create({ tags: "ui" });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/array/i);
  });
});

describe("issue tags — update replaces the whole set", () => {
  test("passing tags replaces, covering both add and remove", async () => {
    const { issue } = await create({ tags: ["a", "b"] });
    // Drop "b", add "c" — one full-set write does both.
    const r = await update(issue.id, { tags: ["a", "c"] });
    expect(r.json.ok).toBe(true);
    expect(r.json.issue!.tags).toEqual(["a", "c"]);
  });

  test("an empty array clears every tag", async () => {
    const { issue } = await create({ tags: ["a", "b"] });
    const r = await update(issue.id, { tags: [] });
    expect(r.json.issue!.tags).toEqual([]);
  });

  test("omitting tags leaves them untouched", async () => {
    // The same rule session_id follows: an omitted field is not a change. A
    // quick owner edit from a row must not wipe the issue's tags.
    const { issue } = await create({ tags: ["keep"] });
    const r = await update(issue.id, { owner: "user" });
    expect(r.json.issue!.tags).toEqual(["keep"]);
  });

  test("a bad tag on update rejects the edit and leaves the row untouched", async () => {
    const { issue } = await create({ tags: ["safe"] });
    const r = await update(issue.id, {
      title: "new title",
      tags: ["y".repeat(30)],
    });
    expect(r.json.ok).toBe(false);
    // Neither the title nor the tags moved.
    const after = await post<{ issue: Issue & { title: string } }>(
      `${broker.url}/get-issue`,
      { issue_id: issue.id },
    );
    expect(after.json.issue.title).toBe("tagged issue");
    expect(after.json.issue.tags).toEqual(["safe"]);
  });
});

describe("issue tags — reads carry them", () => {
  test("list returns each issue's tags without an N+1", async () => {
    const a = await create({ tags: ["red"] });
    const b = await create({ tags: ["blue", "green"] });
    const list = await post<{ issues: Issue[] }>(`${broker.url}/list-issues`, {
      include_closed: true,
    });
    const ra = list.json.issues.find((i) => i.id === a.issue.id)!;
    const rb = list.json.issues.find((i) => i.id === b.issue.id)!;
    expect(ra.tags).toEqual(["red"]);
    expect(rb.tags).toEqual(["blue", "green"]);
  });

  test("get-issue returns tags", async () => {
    const { issue } = await create({ tags: ["one", "two"] });
    const r = await post<{ issue: Issue }>(`${broker.url}/get-issue`, {
      issue_id: issue.id,
    });
    expect(r.json.issue.tags).toEqual(["one", "two"]);
  });
});

describe("issue tags — the list-query tag filter (OR)", () => {
  test("keeps issues carrying ANY of the given tags", async () => {
    const s = await registerSession(broker.url, "/tmp/tag-filter");
    const alpha = await create({ tags: ["alpha"], session_id: s });
    const beta = await create({ tags: ["beta"], session_id: s });
    const both = await create({ tags: ["alpha", "beta"], session_id: s });
    const none = await create({ tags: ["gamma"], session_id: s });

    const r = await post<{ issues: Issue[] }>(`${broker.url}/list-issues`, {
      session_id: s,
      tags: ["alpha"],
    });
    const ids = r.json.issues.map((i) => i.id);
    expect(ids).toContain(alpha.issue.id);
    expect(ids).toContain(both.issue.id);
    expect(ids).not.toContain(beta.issue.id);
    expect(ids).not.toContain(none.issue.id);

    // Two tags selected = union.
    const two = await post<{ issues: Issue[] }>(`${broker.url}/list-issues`, {
      session_id: s,
      tags: ["alpha", "beta"],
    });
    const twoIds = two.json.issues.map((i) => i.id);
    expect(twoIds).toContain(alpha.issue.id);
    expect(twoIds).toContain(beta.issue.id);
    expect(twoIds).toContain(both.issue.id);
    expect(twoIds).not.toContain(none.issue.id);
  });

  test("an empty tag filter narrows nothing", async () => {
    const s = await registerSession(broker.url, "/tmp/tag-filter-empty");
    const one = await create({ tags: ["solo"], session_id: s });
    const r = await post<{ issues: Issue[] }>(`${broker.url}/list-issues`, {
      session_id: s,
      tags: [],
    });
    expect(r.json.issues.map((i) => i.id)).toContain(one.issue.id);
  });
});
