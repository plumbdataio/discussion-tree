import { describe, test, expect } from "bun:test";
import {
  parseLsofPids,
  parseGetNetTcpPids,
  parseNetstatListenPids,
  decideAfterKill,
} from "../../scripts/restart-broker.ts";

// restart-broker.ts finds the broker by "who LISTENs on the port" on macOS
// (lsof) and Windows (Get-NetTCPConnection, netstat fallback). These lock the
// parsers against real-shaped output, including the traps: IPv4+IPv6 rows for
// one pid, client sockets that merely talk TO the port, a localised netstat
// state column, and Windows' System pids.

describe("parseLsofPids", () => {
  test("one pid per line, deduped, junk ignored", () => {
    expect(parseLsofPids("12345\n12345\n678\n\n")).toEqual([12345, 678]);
    expect(parseLsofPids("")).toEqual([]);
    expect(parseLsofPids("lsof: WARNING: can't stat()\n4321\n")).toEqual([4321]);
  });
});

describe("parseGetNetTcpPids", () => {
  test("CRLF output with an IPv4 and IPv6 listener of the same pid", () => {
    expect(parseGetNetTcpPids("9876\r\n9876\r\n")).toEqual([9876]);
    expect(parseGetNetTcpPids("\r\n")).toEqual([]);
  });

  test("never returns System Idle (0) or System (4)", () => {
    expect(parseGetNetTcpPids("0\r\n4\r\n5000\r\n")).toEqual([5000]);
  });
});

describe("parseNetstatListenPids", () => {
  const sample = [
    "",
    "Active Connections",
    "",
    "  Proto  Local Address          Foreign Address        State           PID",
    "  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1100",
    "  TCP    127.0.0.1:7898         0.0.0.0:0              LISTENING       22044",
    "  TCP    127.0.0.1:7898         127.0.0.1:53211        ESTABLISHED     22044",
    "  TCP    127.0.0.1:53211        127.0.0.1:7898         ESTABLISHED     31337",
    "  TCP    127.0.0.1:17898        0.0.0.0:0              LISTENING       555",
    "  TCP    [::1]:7898             [::]:0                 LISTENING       22044",
    "  TCP    [::]:445               [::]:0                 LISTENING       4",
    "",
  ].join("\r\n");

  test("listener rows for the port only (not clients, not a longer port number)", () => {
    expect(parseNetstatListenPids(sample, 7898)).toEqual([22044]);
    expect(parseNetstatListenPids(sample, "17898")).toEqual([555]);
    expect(parseNetstatListenPids(sample, 445)).toEqual([]); // System pid 4 is never killed
    expect(parseNetstatListenPids(sample, 9999)).toEqual([]);
  });

  test("works when the State column is localised", () => {
    const localized = "  TCP    127.0.0.1:7898   0.0.0.0:0   ABHOEREN   777\r\n";
    expect(parseNetstatListenPids(localized, 7898)).toEqual([777]);
  });
});

describe("decideAfterKill", () => {
  test("a running supervisor restarts the broker; otherwise we spawn", () => {
    expect(decideAfterKill(true)).toBe("wait-for-supervisor");
    expect(decideAfterKill(false)).toBe("spawn");
  });
});
