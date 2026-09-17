import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  startBroker,
  post,
  get,
  registerSession,
  attachCC,
  type BrokerHandle,
} from "../harness/broker-harness.ts";

let broker: BrokerHandle;

beforeAll(async () => {
  broker = await startBroker();
});
afterAll(async () => {
  await broker.kill();
});

type LimitsBody = {
  cc_session_id?: string;
  five_hour_pct?: number;
  five_hour_resets_at?: number;
  seven_day_pct?: number;
  seven_day_resets_at?: number;
};

describe("/report-usage-limits + /api/sessions surfacing", () => {
  test("a reported set of limits is surfaced as the account-global value", async () => {
    const sid = await registerSession(broker.url);
    const ccId = await attachCC(broker.url, sid);

    const resetsFive = Math.floor(Date.now() / 1000) + 3600;
    const resetsSeven = Math.floor(Date.now() / 1000) + 7 * 86400;
    const r = await post<{ ok: boolean; session_id?: string }>(
      `${broker.url}/report-usage-limits`,
      {
        cc_session_id: ccId,
        five_hour_pct: 24,
        five_hour_resets_at: resetsFive,
        seven_day_pct: 41,
        seven_day_resets_at: resetsSeven,
      } satisfies LimitsBody,
    );
    expect(r.json.ok).toBe(true);
    expect(r.json.session_id).toBe(sid);

    const list = await get<{ usage_limits: any }>(`${broker.url}/api/sessions`);
    expect(list.json.usage_limits).not.toBeNull();
    expect(list.json.usage_limits.five_hour_pct).toBe(24);
    expect(list.json.usage_limits.five_hour_resets_at).toBe(resetsFive);
    expect(list.json.usage_limits.seven_day_pct).toBe(41);
    expect(list.json.usage_limits.seven_day_resets_at).toBe(resetsSeven);
    expect(typeof list.json.usage_limits.set_at).toBe("string");
  });

  test("a partial report (only 7d present) is accepted; only 7d surfaces against a clean store", async () => {
    // Own broker with an empty store: the per-window getter would otherwise pull
    // a still-valid 5h reported by another session in the shared broker, so to
    // assert "no 5h present" we isolate to a store that only has this 7d report.
    const b = await startBroker();
    try {
      const sid = await registerSession(b.url);
      const ccId = await attachCC(b.url, sid);
      const r = await post<{ ok: boolean }>(`${b.url}/report-usage-limits`, {
        cc_session_id: ccId,
        seven_day_pct: 55,
      });
      expect(r.json.ok).toBe(true);
      const list = await get<{ usage_limits: any }>(`${b.url}/api/sessions`);
      expect(list.json.usage_limits.seven_day_pct).toBe(55);
      expect(list.json.usage_limits.five_hour_pct ?? null).toBeNull();
    } finally {
      await b.kill();
    }
  });

  test("a later report overwrites the previous one for the same session", async () => {
    const sid = await registerSession(broker.url);
    const ccId = await attachCC(broker.url, sid);
    await post(`${broker.url}/report-usage-limits`, {
      cc_session_id: ccId,
      five_hour_pct: 10,
    });
    await post(`${broker.url}/report-usage-limits`, {
      cc_session_id: ccId,
      five_hour_pct: 80,
    });
    const list = await get<{ usage_limits: any }>(`${broker.url}/api/sessions`);
    expect(list.json.usage_limits.five_hour_pct).toBe(80);
  });

  test("the freshest report across sessions wins (account-global, one chip)", async () => {
    const sidA = await registerSession(broker.url);
    const ccA = await attachCC(broker.url, sidA);
    const sidB = await registerSession(broker.url);
    const ccB = await attachCC(broker.url, sidB);

    await post(`${broker.url}/report-usage-limits`, {
      cc_session_id: ccA,
      five_hour_pct: 11,
    });
    // Small delay so set_at strictly increases (ISO ms resolution).
    await new Promise((r) => setTimeout(r, 5));
    await post(`${broker.url}/report-usage-limits`, {
      cc_session_id: ccB,
      five_hour_pct: 99,
    });
    const list = await get<{ usage_limits: any }>(`${broker.url}/api/sessions`);
    expect(list.json.usage_limits.five_hour_pct).toBe(99);
  });

  test("missing cc_session_id is rejected (ok=false)", async () => {
    const r = await post<{ ok: boolean }>(`${broker.url}/report-usage-limits`, {
      five_hour_pct: 50,
    });
    expect(r.json.ok).toBe(false);
  });

  test("unknown cc_session_id is rejected", async () => {
    const r = await post<{ ok: boolean }>(`${broker.url}/report-usage-limits`, {
      cc_session_id: "no-such-cc",
      five_hour_pct: 50,
    });
    expect(r.json.ok).toBe(false);
  });

  test("a report with no usable pct field is rejected", async () => {
    const sid = await registerSession(broker.url);
    const ccId = await attachCC(broker.url, sid);
    // Only a reset time, no percentage — nothing to show, so ok=false.
    const r = await post<{ ok: boolean }>(`${broker.url}/report-usage-limits`, {
      cc_session_id: ccId,
      five_hour_resets_at: Math.floor(Date.now() / 1000) + 3600,
    });
    expect(r.json.ok).toBe(false);
  });

  test("out-of-range percentages are dropped to absent", async () => {
    // Own broker with an empty store so the dropped 5h isn't masked by another
    // session's still-valid 5h that the per-window getter would surface.
    const b = await startBroker();
    try {
      const sid = await registerSession(b.url);
      const ccId = await attachCC(b.url, sid);
      // 5h is out of range (dropped), 7d is valid -> still accepted, 5h absent.
      const r = await post<{ ok: boolean }>(`${b.url}/report-usage-limits`, {
        cc_session_id: ccId,
        five_hour_pct: 150,
        seven_day_pct: 33,
      });
      expect(r.json.ok).toBe(true);
      const list = await get<{ usage_limits: any }>(`${b.url}/api/sessions`);
      expect(list.json.usage_limits.seven_day_pct).toBe(33);
      expect(list.json.usage_limits.five_hour_pct ?? null).toBeNull();
    } finally {
      await b.kill();
    }
  });

  test("reported limits survive a broker restart (DB-persisted)", async () => {
    const home = mkdtempSync(join(tmpdir(), "pd-limits-persist-"));
    const env = {
      DISCUSSION_TREE_HOME: home,
      DISCUSSION_TREE_DB: join(home, "db.sqlite"),
    };

    const a = await startBroker(env);
    const reg = await post<{ session_id: string }>(`${a.url}/register`, {
      pid: process.pid,
      cwd: "/tmp/pd-limits-persist",
    });
    const sid = reg.json.session_id;
    const ccId = await attachCC(a.url, sid);
    await post(`${a.url}/report-usage-limits`, {
      cc_session_id: ccId,
      five_hour_pct: 37,
      seven_day_pct: 60,
    });
    await a.kill();

    const b = await startBroker(env);
    await post(`${b.url}/heartbeat`, { session_id: sid });
    const list = await get<{ usage_limits: any }>(`${b.url}/api/sessions`);
    expect(list.json.usage_limits.five_hour_pct).toBe(37);
    expect(list.json.usage_limits.seven_day_pct).toBe(60);
    await b.kill();
    rmSync(home, { recursive: true, force: true });
  });
});

// --- Per-window, reset-driven staleness (getGlobalUsageLimits) ---------------
//
// getGlobalUsageLimits evaluates the 5h and 7d windows independently, deciding
// staleness from each window's own resets_at (not a fixed 6h age cutoff). To
// exercise that we need controlled set_at / resets_at values, but the POST path
// stamps set_at = now, so we seed the usage_limits table directly and start a
// fresh broker over that DB. The broker warms `limits` from the DB on startup,
// so /api/sessions.usage_limits reflects the getter over the seeded snapshots.

const USAGE_LIMITS_DDL = `
  CREATE TABLE IF NOT EXISTS usage_limits (
    session_id TEXT PRIMARY KEY,
    five_hour_pct REAL,
    five_hour_resets_at INTEGER,
    seven_day_pct REAL,
    seven_day_resets_at INTEGER,
    set_at TEXT NOT NULL
  )
`;

type SeedRow = {
  session_id: string;
  five_hour_pct?: number | null;
  five_hour_resets_at?: number | null;
  seven_day_pct?: number | null;
  seven_day_resets_at?: number | null;
  set_at: string;
};

// Create a tmp home + db, seed usage_limits rows into it, then start a broker
// pointed at that DB. Returns the broker plus a cleanup that kills it and
// removes the seeded home dir.
async function startBrokerWithSeededLimits(
  rows: SeedRow[],
): Promise<{ broker: BrokerHandle; cleanup: () => Promise<void> }> {
  const home = mkdtempSync(join(tmpdir(), "pd-limits-seed-"));
  const dbPath = join(home, "db.sqlite");
  const seed = new Database(dbPath);
  seed.run(USAGE_LIMITS_DDL);
  const insert = seed.prepare(
    `INSERT INTO usage_limits
       (session_id, five_hour_pct, five_hour_resets_at, seven_day_pct, seven_day_resets_at, set_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  for (const r of rows) {
    insert.run(
      r.session_id,
      r.five_hour_pct ?? null,
      r.five_hour_resets_at ?? null,
      r.seven_day_pct ?? null,
      r.seven_day_resets_at ?? null,
      r.set_at,
    );
  }
  seed.close();

  const broker = await startBroker({
    DISCUSSION_TREE_HOME: home,
    DISCUSSION_TREE_DB: dbPath,
  });
  return {
    broker,
    cleanup: async () => {
      await broker.kill();
      rmSync(home, { recursive: true, force: true });
    },
  };
}

const HOUR = 3600_000;
const nowSec = () => Math.floor(Date.now() / 1000);
const isoAgo = (ms: number) => new Date(Date.now() - ms).toISOString();

async function readGlobalLimits(broker: BrokerHandle): Promise<any> {
  const list = await get<{ usage_limits: any }>(`${broker.url}/api/sessions`);
  return list.json.usage_limits;
}

describe("getGlobalUsageLimits — per-window, reset-driven staleness", () => {
  test("before-reset: a 7d value reported >6h ago is still shown when its resets_at is in the future", async () => {
    // The old fixed 6h cutoff would have returned null for this snapshot.
    const resetsSeven = nowSec() + 3 * 86400;
    const { broker, cleanup } = await startBrokerWithSeededLimits([
      {
        session_id: "seed-old-7d",
        seven_day_pct: 41,
        seven_day_resets_at: resetsSeven,
        set_at: isoAgo(12 * HOUR),
      },
    ]);
    try {
      const ul = await readGlobalLimits(broker);
      expect(ul).not.toBeNull();
      expect(ul.seven_day_pct).toBe(41);
      expect(ul.seven_day_resets_at).toBe(resetsSeven);
      expect(ul.five_hour_pct ?? null).toBeNull();
    } finally {
      await cleanup();
    }
  });

  test("after-reset: a five_hour_resets_at in the past yields five_hour_pct 0 and no resets_at", async () => {
    const { broker, cleanup } = await startBrokerWithSeededLimits([
      {
        session_id: "seed-reset-5h",
        five_hour_pct: 24,
        five_hour_resets_at: nowSec() - 60,
        set_at: isoAgo(10 * 60_000),
      },
    ]);
    try {
      const ul = await readGlobalLimits(broker);
      expect(ul).not.toBeNull();
      expect(ul.five_hour_pct).toBe(0);
      expect(ul.five_hour_resets_at ?? null).toBeNull();
    } finally {
      await cleanup();
    }
  });

  test("per-window: 5h comes from an older snapshot while 7d comes from the newest one", async () => {
    const resetsFive = nowSec() + 3600;
    const resetsSeven = nowSec() + 5 * 86400;
    const olderSetAt = isoAgo(2 * HOUR);
    const newerSetAt = isoAgo(60_000);
    const { broker, cleanup } = await startBrokerWithSeededLimits([
      {
        session_id: "seed-older-5h",
        five_hour_pct: 30,
        five_hour_resets_at: resetsFive,
        set_at: olderSetAt,
      },
      {
        session_id: "seed-newer-7d",
        seven_day_pct: 50,
        seven_day_resets_at: resetsSeven,
        set_at: newerSetAt,
      },
    ]);
    try {
      const ul = await readGlobalLimits(broker);
      expect(ul.five_hour_pct).toBe(30);
      expect(ul.five_hour_resets_at).toBe(resetsFive);
      expect(ul.seven_day_pct).toBe(50);
      expect(ul.seven_day_resets_at).toBe(resetsSeven);
      // set_at is the greatest among contributing entries (the newer 7d one).
      expect(ul.set_at).toBe(newerSetAt);
    } finally {
      await cleanup();
    }
  });

  test("resets_at absent: value is shown when set_at is within the window length", async () => {
    const { broker, cleanup } = await startBrokerWithSeededLimits([
      {
        session_id: "seed-absent-in",
        five_hour_pct: 15,
        five_hour_resets_at: null,
        set_at: isoAgo(1 * HOUR), // within 5h of now
      },
    ]);
    try {
      const ul = await readGlobalLimits(broker);
      expect(ul.five_hour_pct).toBe(15);
      expect(ul.five_hour_resets_at ?? null).toBeNull();
    } finally {
      await cleanup();
    }
  });

  test("resets_at absent: value zeroes when set_at is older than the window length", async () => {
    const { broker, cleanup } = await startBrokerWithSeededLimits([
      {
        session_id: "seed-absent-out",
        five_hour_pct: 15,
        five_hour_resets_at: null,
        set_at: isoAgo(6 * HOUR), // older than the 5h window
      },
    ]);
    try {
      const ul = await readGlobalLimits(broker);
      expect(ul.five_hour_pct).toBe(0);
      expect(ul.five_hour_resets_at ?? null).toBeNull();
    } finally {
      await cleanup();
    }
  });

  test("empty store: no snapshots yields null usage_limits", async () => {
    const { broker, cleanup } = await startBrokerWithSeededLimits([]);
    try {
      const ul = await readGlobalLimits(broker);
      expect(ul).toBeNull();
    } finally {
      await cleanup();
    }
  });

  test("both windows absent: a row carrying neither pct yields null", async () => {
    const { broker, cleanup } = await startBrokerWithSeededLimits([
      {
        session_id: "seed-no-pct",
        five_hour_pct: null,
        seven_day_pct: null,
        set_at: isoAgo(60_000),
      },
    ]);
    try {
      const ul = await readGlobalLimits(broker);
      expect(ul).toBeNull();
    } finally {
      await cleanup();
    }
  });

  test("same-window: the freshest snapshot wins when several carry that window (pre-reset)", async () => {
    const resetsFive = nowSec() + 3600;
    const { broker, cleanup } = await startBrokerWithSeededLimits([
      {
        session_id: "seed-5h-old",
        five_hour_pct: 11,
        five_hour_resets_at: resetsFive,
        set_at: isoAgo(2 * HOUR),
      },
      {
        session_id: "seed-5h-new",
        five_hour_pct: 80,
        five_hour_resets_at: resetsFive,
        set_at: isoAgo(60_000),
      },
    ]);
    try {
      const ul = await readGlobalLimits(broker);
      expect(ul.five_hour_pct).toBe(80);
    } finally {
      await cleanup();
    }
  });
});

// --- Per-account usage limits (getUsageLimitsForAccount) ----------------------
//
// Each session reports its subscription (account = CLAUDE_CONFIG_DIR). The
// broker groups by account so a session's page shows ITS OWN subscription's 5h
// / 7d, sessions on the same account share a value, and the reset-driven combine
// still applies per account. /api/sessions carries this on each session row
// (sessions[].usage_limits), which is what these tests read.

// A random account string, unique per call, so tests sharing the module-level
// broker never collide (getUsageLimitsForAccount matches the account exactly, so
// distinct strings are fully isolated from each other and from null-account
// rows left by the tests above).
const acct = (tag: string) =>
  `/cfg/${tag}-${Math.random().toString(36).slice(2)}`;

// Read one session's per-account usage_limits from /api/sessions (searches both
// the active and inactive lists). null when the session isn't listed or carries
// no value.
async function readSessionLimits(
  b: BrokerHandle,
  sessionId: string,
): Promise<any> {
  const list = await get<{
    sessions: any[];
    inactive_sessions?: any[];
  }>(`${b.url}/api/sessions`);
  const all = [...list.json.sessions, ...(list.json.inactive_sessions ?? [])];
  const s = all.find((x) => x.id === sessionId);
  return s ? s.usage_limits ?? null : null;
}

describe("getUsageLimitsForAccount — per-account grouping", () => {
  test("two accounts: each session's page shows only its own account's value", async () => {
    const sidA = await registerSession(broker.url);
    const ccA = await attachCC(broker.url, sidA);
    const sidB = await registerSession(broker.url);
    const ccB = await attachCC(broker.url, sidB);
    const acctA = acct("A");
    const acctB = acct("B");
    await post(`${broker.url}/report-usage-limits`, {
      cc_session_id: ccA,
      five_hour_pct: 20,
      seven_day_pct: 30,
      account: acctA,
    });
    await post(`${broker.url}/report-usage-limits`, {
      cc_session_id: ccB,
      five_hour_pct: 70,
      seven_day_pct: 80,
      account: acctB,
    });
    const ulA = await readSessionLimits(broker, sidA);
    const ulB = await readSessionLimits(broker, sidB);
    expect(ulA.five_hour_pct).toBe(20);
    expect(ulA.seven_day_pct).toBe(30);
    expect(ulB.five_hour_pct).toBe(70);
    expect(ulB.seven_day_pct).toBe(80);
  });

  test("same account: an idle session shows a sibling's fresher value", async () => {
    const shared = acct("shared");
    const sid1 = await registerSession(broker.url);
    const cc1 = await attachCC(broker.url, sid1);
    const sid2 = await registerSession(broker.url);
    const cc2 = await attachCC(broker.url, sid2);
    // sid1 reports first (older / lower), then its sibling sid2 reports fresher.
    await post(`${broker.url}/report-usage-limits`, {
      cc_session_id: cc1,
      five_hour_pct: 10,
      account: shared,
    });
    // Small delay so set_at strictly increases (ISO ms resolution).
    await new Promise((r) => setTimeout(r, 5));
    await post(`${broker.url}/report-usage-limits`, {
      cc_session_id: cc2,
      five_hour_pct: 90,
      account: shared,
    });
    // sid1's OWN row is older, but its page shows the account's freshest = 90.
    const ul1 = await readSessionLimits(broker, sid1);
    expect(ul1.five_hour_pct).toBe(90);
  });

  test("reset-driven per account: value before resets_at, 0 after", async () => {
    const acctFuture = acct("reset-future");
    const acctPast = acct("reset-past");
    const sidF = await registerSession(broker.url);
    const ccF = await attachCC(broker.url, sidF);
    const sidP = await registerSession(broker.url);
    const ccP = await attachCC(broker.url, sidP);
    const future = nowSec() + 3600;
    const past = nowSec() - 60;
    await post(`${broker.url}/report-usage-limits`, {
      cc_session_id: ccF,
      five_hour_pct: 40,
      five_hour_resets_at: future,
      account: acctFuture,
    });
    await post(`${broker.url}/report-usage-limits`, {
      cc_session_id: ccP,
      five_hour_pct: 40,
      five_hour_resets_at: past,
      account: acctPast,
    });
    const ulF = await readSessionLimits(broker, sidF);
    const ulP = await readSessionLimits(broker, sidP);
    // Before its reset: the reported value + resets_at pass through.
    expect(ulF.five_hour_pct).toBe(40);
    expect(ulF.five_hour_resets_at).toBe(future);
    // After its reset: the window rolled over to 0, resets_at cleared.
    expect(ulP.five_hour_pct).toBe(0);
    expect(ulP.five_hour_resets_at ?? null).toBeNull();
  });

  test("a session that reported no account has null per-session usage_limits", async () => {
    const sid = await registerSession(broker.url);
    const ccId = await attachCC(broker.url, sid);
    await post(`${broker.url}/report-usage-limits`, {
      cc_session_id: ccId,
      five_hour_pct: 55,
    });
    // Its own row has no account, so accountForSession is null → no per-session
    // value (the page shows no chip rather than borrowing another subscription).
    const ul = await readSessionLimits(broker, sid);
    expect(ul ?? null).toBeNull();
    // ...but the account-agnostic top-level global still reflects reports.
    const list = await get<{ usage_limits: any }>(`${broker.url}/api/sessions`);
    expect(list.json.usage_limits).not.toBeNull();
  });

  test("global stays account-agnostic while per-session isolates by account", async () => {
    // Fresh broker so the store holds only these two reports.
    const b = await startBroker();
    try {
      const sid1 = await registerSession(b.url);
      const cc1 = await attachCC(b.url, sid1);
      const sid2 = await registerSession(b.url);
      const cc2 = await attachCC(b.url, sid2);
      // Two DIFFERENT accounts, each carrying only one window.
      await post(`${b.url}/report-usage-limits`, {
        cc_session_id: cc1,
        seven_day_pct: 22,
        account: acct("x"),
      });
      await new Promise((r) => setTimeout(r, 5));
      await post(`${b.url}/report-usage-limits`, {
        cc_session_id: cc2,
        five_hour_pct: 66,
        account: acct("y"),
      });
      const list = await get<{ usage_limits: any; sessions: any[] }>(
        `${b.url}/api/sessions`,
      );
      // Top-level global (unfiltered) surfaces BOTH windows even though they
      // came from different accounts — proves getGlobalUsageLimits still works.
      expect(list.json.usage_limits.five_hour_pct).toBe(66);
      expect(list.json.usage_limits.seven_day_pct).toBe(22);
      // Each session's per-account value shows ONLY its own account's window.
      const s1 = list.json.sessions.find((s: any) => s.id === sid1);
      const s2 = list.json.sessions.find((s: any) => s.id === sid2);
      expect(s1.usage_limits.seven_day_pct).toBe(22);
      expect(s1.usage_limits.five_hour_pct ?? null).toBeNull();
      expect(s2.usage_limits.five_hour_pct).toBe(66);
      expect(s2.usage_limits.seven_day_pct ?? null).toBeNull();
    } finally {
      await b.kill();
    }
  });

  test("account survives a broker restart (re-warmed from DB)", async () => {
    const home = mkdtempSync(join(tmpdir(), "pd-limits-acct-"));
    const env = {
      DISCUSSION_TREE_HOME: home,
      DISCUSSION_TREE_DB: join(home, "db.sqlite"),
    };
    const a = await startBroker(env);
    const reg = await post<{ session_id: string }>(`${a.url}/register`, {
      pid: process.pid,
      cwd: "/tmp/pd-limits-acct",
    });
    const sid = reg.json.session_id;
    const ccId = await attachCC(a.url, sid);
    await post(`${a.url}/report-usage-limits`, {
      cc_session_id: ccId,
      five_hour_pct: 44,
      account: acct("persist"),
    });
    await a.kill();

    const b2 = await startBroker(env);
    await post(`${b2.url}/heartbeat`, { session_id: sid });
    // The per-session value depends on the account being re-warmed from the DB
    // (accountForSession reads the in-memory row that startup rebuilds).
    const ul = await readSessionLimits(b2, sid);
    expect(ul.five_hour_pct).toBe(44);
    await b2.kill();
    rmSync(home, { recursive: true, force: true });
  });
});
