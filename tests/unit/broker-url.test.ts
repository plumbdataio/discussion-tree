import { describe, test, expect } from "bun:test";
import { brokerBaseUrl } from "../../scripts/broker-url.ts";

// The standalone hook scripts must talk to the SAME broker the MCP server does:
// loopback for a local session, but DISCUSSION_TREE_BROKER_URL for a CC on
// another machine (whose broker is not on localhost). These lock that
// resolution — matching server/config.ts's BROKER_URL.
describe("brokerBaseUrl", () => {
  test("env unset -> loopback on default port 7898 (local behavior unchanged)", () => {
    expect(brokerBaseUrl({})).toBe("http://127.0.0.1:7898");
  });

  test("DISCUSSION_TREE_PORT overrides only the loopback port", () => {
    expect(brokerBaseUrl({ DISCUSSION_TREE_PORT: "9001" })).toBe(
      "http://127.0.0.1:9001",
    );
  });

  test("DISCUSSION_TREE_BROKER_URL wins (remote session)", () => {
    expect(
      brokerBaseUrl({ DISCUSSION_TREE_BROKER_URL: "http://mac.tailnet:7898" }),
    ).toBe("http://mac.tailnet:7898");
  });

  test("DISCUSSION_TREE_BROKER_URL takes precedence over DISCUSSION_TREE_PORT", () => {
    expect(
      brokerBaseUrl({
        DISCUSSION_TREE_BROKER_URL: "http://mac.tailnet:8000",
        DISCUSSION_TREE_PORT: "9001",
      }),
    ).toBe("http://mac.tailnet:8000");
  });

  test("trailing slashes are stripped so endpoint joins never double up", () => {
    expect(
      brokerBaseUrl({ DISCUSSION_TREE_BROKER_URL: "http://mac.tailnet:7898///" }),
    ).toBe("http://mac.tailnet:7898");
  });
});
