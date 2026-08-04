import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import {
  startBroker,
  post,
  registerSession,
  attachCC,
  type BrokerHandle,
} from "../harness/broker-harness.ts";

// Fix2: /attach-cc-session must consolidate EVERY other broker row that shares
// the attaching cc_session_id — including a row still marked alive=1 — then
// soft-delete those superseded rows. Two rows with the same cc_session_id are
// the same CC session registered twice; the newest (attaching) row is
// authoritative, all others are stale. The old code only reclaimed alive=0
// rows, so an orphaned MCP server that was still alive=1 at attach time stranded
// its boards / issues / maps / diagrams (the "zombie" window). A DIFFERENT
// cc_session_id must be left completely untouched.

const FLOW = "graph TD\n  A[Start] --> B[End]";

let broker: BrokerHandle;

beforeAll(async () => {
  broker = await startBroker();
});
afterAll(async () => {
  await broker.kill();
});

// Read the broker's SQLite file directly (read-only; the broker runs WAL, so a
// separate reader sees committed data). /api/sessions hides emptied dead husks,
// so the DB is the precise way to assert alive flags and raw ownership.
function openDb(): Database {
  return new Database(broker.dbPath, { readonly: true });
}
function aliveOf(db: Database, sid: string): number {
  return (
    db.query("SELECT alive FROM sessions WHERE id = ?").get(sid) as {
      alive: number;
    }
  ).alive;
}
function ownerOf(db: Database, table: string, id: string): string {
  return (
    db.query(`SELECT session_id FROM ${table} WHERE id = ?`).get(id) as {
      session_id: string;
    }
  ).session_id;
}
function ownedCount(db: Database, table: string, sids: string[]): number {
  const ph = sids.map(() => "?").join(",");
  return (
    db
      .query(`SELECT COUNT(*) AS n FROM ${table} WHERE session_id IN (${ph})`)
      .get(...sids) as { n: number }
  ).n;
}

async function createBoard(sid: string, title: string): Promise<string> {
  const r = await post<{ board_id: string }>(`${broker.url}/create-board`, {
    session_id: sid,
    structure: {
      title,
      concerns: [{ id: "c", title: "C", items: [{ id: "i", title: "I" }] }],
    },
  });
  return r.json.board_id;
}
async function createMap(sid: string, title: string): Promise<string> {
  const r = await post<{ map_id: string }>(`${broker.url}/create-map`, {
    session_id: sid,
    title,
  });
  return r.json.map_id;
}
async function createDiagram(sid: string, title: string): Promise<string> {
  const r = await post<{ id: string }>(`${broker.url}/upsert-diagram`, {
    session_id: sid,
    title,
    source: FLOW,
  });
  return r.json.id;
}
async function createIssue(sid: string, title: string): Promise<string> {
  const r = await post<{ issue: { id: string } }>(`${broker.url}/create-issue`, {
    session_id: sid,
    title,
  });
  return r.json.issue.id;
}

describe("attach consolidates ALL same-cc_session_id rows (zombie reclaim)", () => {
  test("an alive=1 zombie and an alive=0 husk both fold into the attaching session; a different ccid is untouched", async () => {
    const cwd = "/tmp/zombie-reclaim";
    const ccId = `cc-zombie-${Math.random().toString(36).slice(2)}`;
    const ccId2 = `cc-other-${Math.random().toString(36).slice(2)}`;

    // B: registers and attaches first, so it owns a default board. Then A
    // attaches with the same ccId — under Fix2 that already reclaims B's board
    // and soft-deletes B (alive=0). B is now our alive=0 same-ccid row.
    const sidB = await registerSession(broker.url, cwd);
    await attachCC(broker.url, sidB, ccId);

    // A: attaches with the same ccId → becomes the alive=1 holder. This is the
    // "zombie" at C-time: alive=1, same ccId, owning content.
    const sidA = await registerSession(broker.url, cwd);
    await attachCC(broker.url, sidA, ccId);
    expect(aliveOf(openDb(), sidB)).toBe(0); // A's attach already retired B

    // Give A its own content on top of the default board it now owns.
    const aMap = await createMap(sidA, "A-map");
    const aDiag = await createDiagram(sidA, "A-diagram");
    const aIssue = await createIssue(sidA, "A-issue");

    // Give the alive=0 husk B independently-owned content AFTER A's attach, so
    // it still owns rows at C-time (not just transitively via A). These must
    // also fold into C.
    const bBoard = await createBoard(sidB, "B-board");
    const bMap = await createMap(sidB, "B-map");
    const bDiag = await createDiagram(sidB, "B-diagram");
    const bIssue = await createIssue(sidB, "B-issue");

    // D: the control — a DIFFERENT cc_session_id in the same cwd, alive=1, with
    // its own content. C's attach must not touch it.
    const sidD = await registerSession(broker.url, cwd);
    await attachCC(broker.url, sidD, ccId2);
    const dBoard = await createBoard(sidD, "D-board");
    const dMap = await createMap(sidD, "D-map");
    const dDiag = await createDiagram(sidD, "D-diagram");
    const dIssue = await createIssue(sidD, "D-issue");

    // C: the new attach with the shared ccId. Consolidates A (alive=1) and B
    // (alive=0), soft-deleting both.
    const sidC = await registerSession(broker.url, cwd);
    await attachCC(broker.url, sidC, ccId);

    const db = openDb();
    try {
      // A and B are retired; C and the control D remain alive.
      expect(aliveOf(db, sidA)).toBe(0);
      expect(aliveOf(db, sidB)).toBe(0);
      expect(aliveOf(db, sidC)).toBe(1);
      expect(aliveOf(db, sidD)).toBe(1);

      // Every piece of A's and B's content now belongs to C.
      expect(ownerOf(db, "maps", aMap)).toBe(sidC);
      expect(ownerOf(db, "diagrams", aDiag)).toBe(sidC);
      expect(ownerOf(db, "issues", aIssue)).toBe(sidC);
      expect(ownerOf(db, "boards", bBoard)).toBe(sidC);
      expect(ownerOf(db, "maps", bMap)).toBe(sidC);
      expect(ownerOf(db, "diagrams", bDiag)).toBe(sidC);
      expect(ownerOf(db, "issues", bIssue)).toBe(sidC);

      // Nothing is left stranded on the superseded rows.
      expect(ownedCount(db, "boards", [sidA, sidB])).toBe(0);
      expect(ownedCount(db, "maps", [sidA, sidB])).toBe(0);
      expect(ownedCount(db, "diagrams", [sidA, sidB])).toBe(0);
      expect(ownedCount(db, "issues", [sidA, sidB])).toBe(0);

      // The different-ccid control D keeps ownership of all its content.
      expect(ownerOf(db, "boards", dBoard)).toBe(sidD);
      expect(ownerOf(db, "maps", dMap)).toBe(sidD);
      expect(ownerOf(db, "diagrams", dDiag)).toBe(sidD);
      expect(ownerOf(db, "issues", dIssue)).toBe(sidD);
    } finally {
      db.close();
    }
  });
});
