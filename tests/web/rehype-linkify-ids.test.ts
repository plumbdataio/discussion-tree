import { describe, test, expect } from "bun:test";
import type { Element, ElementContent, Root, Text } from "hast";
import {
  linkifyTextValue,
  rehypeLinkifyIds,
} from "../../web/utils/rehypeLinkifyIds.ts";

// Raw ids in message text become links. The walker's whole job is to catch the
// un-backticked form WITHOUT reintroducing the dead-link false positives that
// forced the backtick requirement in the first place — so most of these pin
// what must NOT linkify.

const FULL_ISSUE = "iss_ms5kq850_516a7f9936c503d13860dbd0";
const SHORT_ISSUE = "iss_ms5kq850";
const SHORT_BOARD = "bd_vlap7p27";
const FULL_BOARD = "bd_00ae8dc01fc1004e37e469794d6797ec";

function isText(n: ElementContent): n is Text {
  return n.type === "text";
}
function isElement(n: ElementContent): n is Element {
  return n.type === "element";
}

describe("linkifyTextValue — what becomes a link", () => {
  test("a real issue id in prose becomes a code node (the IssueIdLink path)", () => {
    const out = linkifyTextValue(`see ${SHORT_ISSUE} for details`);
    expect(out).not.toBeNull();
    const parts = out!;
    expect(parts).toHaveLength(3);
    expect(isText(parts[0]) && parts[0].value).toBe("see ");
    const el = parts[1] as Element;
    // Reuses MDView's `code` override, which resolves an issue id to a title
    // and opens the tracker — identical to the backtick path.
    expect(el.tagName).toBe("code");
    expect((el.children[0] as Text).value).toBe(SHORT_ISSUE);
    expect(isText(parts[2]) && parts[2].value).toBe(" for details");
  });

  test("the full issue id (with hex suffix) is captured whole", () => {
    const out = linkifyTextValue(`fixed ${FULL_ISSUE}`);
    const el = out![1] as Element;
    expect(el.tagName).toBe("code");
    expect((el.children[0] as Text).value).toBe(FULL_ISSUE);
  });

  test("a board id becomes an internal /board/ link, no title lookup", () => {
    const out = linkifyTextValue(`board ${SHORT_BOARD} has it`);
    const el = out![1] as Element;
    expect(el.tagName).toBe("a");
    expect(el.properties?.href).toBe(`/board/${SHORT_BOARD}`);
    expect((el.children[0] as Text).value).toBe(SHORT_BOARD);
    expect(linkifyTextValue(FULL_BOARD)![0]).toMatchObject({
      tagName: "a",
      properties: { href: `/board/${FULL_BOARD}` },
    });
  });

  test("several ids in one line each get their own link", () => {
    const out = linkifyTextValue(`${SHORT_ISSUE} then ${SHORT_BOARD}`)!;
    const els = out.filter(isElement);
    expect(els.map((e) => e.tagName)).toEqual(["code", "a"]);
  });

  test("an id at the very start and one at the very end both match", () => {
    const start = linkifyTextValue(`${SHORT_ISSUE} leads`)!;
    expect(isElement(start[0]) && (start[0] as Element).tagName).toBe("code");
    const end = linkifyTextValue(`ends at ${SHORT_BOARD}`)!;
    expect(isElement(end[end.length - 1])).toBe(true);
  });

  test("trailing punctuation is not swallowed into the id", () => {
    const out = linkifyTextValue(`done: ${SHORT_ISSUE}.`)!;
    const el = out[1] as Element;
    expect((el.children[0] as Text).value).toBe(SHORT_ISSUE);
    // The period stays as its own trailing text node.
    expect(isText(out[2]) && out[2].value).toBe(".");
  });

  test("an id jammed against CJK text still matches", () => {
    // CC writes ids without a space after Japanese all the time; a CJK char is
    // not a word char, so the boundary lets the match start.
    const out = linkifyTextValue(`課題${SHORT_ISSUE}`)!; // allow-japanese: CJK-neighbour linkify test
    const el = out[out.length - 1] as Element;
    expect(el.tagName).toBe("code");
  });
});

describe("linkifyTextValue — what stays literal (no dead links)", () => {
  test("placeholders used when explaining the format do not linkify", () => {
    expect(linkifyTextValue("write it as iss_xxx or iss_yyy")).toBeNull();
    expect(linkifyTextValue("a board is bd_xxx")).toBeNull();
    expect(linkifyTextValue("use bd_... for boards")).toBeNull();
    expect(linkifyTextValue("the field is called issue_ids")).toBeNull();
  });

  test("ordinary prose with no ids is left untouched", () => {
    expect(linkifyTextValue("nothing to see here")).toBeNull();
    expect(linkifyTextValue("discuss the issue and the board")).toBeNull();
  });

  test("an id embedded mid-token is not matched", () => {
    // Preceded by a word char, so it is part of a larger token, not a bare id.
    expect(linkifyTextValue("prefixiss_ms5kq850")).toBeNull();
    expect(linkifyTextValue("foo_bd_vlap7p27")).toBeNull();
  });

  test("a too-short board token is rejected even though it starts with bd_", () => {
    expect(linkifyTextValue("bd_todo is not an id")).toBeNull();
  });
});

// Building a minimal hast tree by hand and running the plugin, to pin that it
// skips text inside code/a (double-linkify) but rewrites text in a paragraph.
function p(...children: ElementContent[]): Element {
  return { type: "element", tagName: "p", properties: {}, children };
}
function wrap(tag: string, value: string): Element {
  return {
    type: "element",
    tagName: tag,
    properties: {},
    children: [{ type: "text", value }],
  };
}
function tree(...children: ElementContent[]): Root {
  return { type: "root", children };
}
function run(root: Root): Root {
  rehypeLinkifyIds()(root);
  return root;
}

describe("rehypeLinkifyIds — walking the tree", () => {
  test("linkifies a bare id sitting in a paragraph text node", () => {
    const root = run(tree(p({ type: "text", value: `re ${SHORT_ISSUE}` })));
    const para = root.children[0] as Element;
    expect(para.children.map((c) => (c as Element).tagName ?? "text")).toContain(
      "code",
    );
  });

  test("leaves an id inside an existing code span alone (already handled)", () => {
    const root = run(tree(p(wrap("code", SHORT_ISSUE))));
    const code = (root.children[0] as Element).children[0] as Element;
    expect(code.tagName).toBe("code");
    // Still a single text child — not split into a nested link.
    expect(code.children).toHaveLength(1);
    expect((code.children[0] as Text).value).toBe(SHORT_ISSUE);
  });

  test("leaves an id inside an existing link alone (no nested links)", () => {
    const root = run(tree(p(wrap("a", `go to ${SHORT_BOARD}`))));
    const a = (root.children[0] as Element).children[0] as Element;
    expect(a.tagName).toBe("a");
    expect(a.children).toHaveLength(1);
    expect((a.children[0] as Text).value).toBe(`go to ${SHORT_BOARD}`);
  });

  test("skips descendants of pre, but still rewrites a sibling paragraph", () => {
    const root = run(
      tree(wrap("pre", SHORT_ISSUE), p({ type: "text", value: SHORT_BOARD })),
    );
    const pre = root.children[0] as Element;
    expect(pre.children).toHaveLength(1); // untouched
    const para = root.children[1] as Element;
    expect((para.children[0] as Element).tagName).toBe("a"); // rewritten
  });
});
