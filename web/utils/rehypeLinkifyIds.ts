import type { Element, ElementContent, Root, Text } from "hast";
import { BD_ID_RE, ISSUE_ID_RE } from "./issues.ts";

// Raw (un-backticked) issue / board ids in a message become links. The code
// span path (MDView's `code` override) only ever fired inside backticks, which
// people kept forgetting, so an id typed in plain prose stayed dead text. A
// react-markdown component override cannot rewrite an arbitrary text node — it
// only sees the element it is mapped to — so this rehype plugin walks the hast
// text nodes and splits each match out into its own element.
//
// FALSE POSITIVES are avoided exactly as the backtick path avoids them: the
// tight anchored patterns in issues.ts do the deciding, so "iss_xxx" / "bd_yyy"
// / a sentence ABOUT the id format stay literal. Scanning (finding token
// boundaries) is kept separate from validation (the anchored test) so the same
// patterns — and their tests — govern both the raw and the code-span paths.

// Text inside these is left untouched:
//   code / pre — the `code` override already linkifies issue ids in a code
//                span, and code must not be rewritten anyway;
//   a          — an existing link, so rewriting its text would nest a link
//                inside a link.
const SKIP_TAGS = new Set(["code", "pre", "a"]);

// Finds every `iss_`/`bd_` token; the trailing run is greedy so the whole id
// (including an issue's `_<hex>` suffix) is captured, then handed to the
// anchored patterns to accept or reject. The leading (?<!\w) stops a match
// starting mid-token, e.g. the "iss_x" inside "foo_iss_x". Non-ASCII (CJK)
// neighbours are not \w, so an id jammed against Japanese text still matches.
const SCAN_RE = /(?<![A-Za-z0-9_])(?:iss|bd)_[a-z0-9_]+/gi;

function text(value: string): Text {
  return { type: "text", value };
}

// Turn one matched token into the element that renders it, or null to leave it
// as plain text (a placeholder / non-id that slipped through the scan).
function tokenToElement(token: string): Element | null {
  if (/^iss_/i.test(token)) {
    if (!ISSUE_ID_RE.test(token)) return null;
    // Reuse the existing `code` override: an issue id in a code span already
    // becomes <IssueIdLink> (title cache + tracker modal). Emitting a code
    // node funnels the raw id through that exact path — no new component
    // wiring — and that override re-tests ISSUE_ID_RE, so a stray match is
    // guarded twice.
    return {
      type: "element",
      tagName: "code",
      properties: {},
      children: [text(token)],
    };
  }
  if (!BD_ID_RE.test(token)) return null;
  // Board ids get a plain internal link to the board route; MDView's `a`
  // override renders /board/* as a same-tab SPA link. No existence check.
  return {
    type: "element",
    tagName: "a",
    properties: { href: `/board/${token}` },
    children: [text(token)],
  };
}

// Split a text value into text / link / text… , or null when nothing matched
// (so the caller can leave the original node untouched). Exported for tests.
export function linkifyTextValue(value: string): ElementContent[] | null {
  const out: ElementContent[] = [];
  let last = 0;
  let matched = false;
  for (const m of value.matchAll(SCAN_RE)) {
    const token = m[0];
    const start = m.index;
    const el = tokenToElement(token);
    if (!el) continue;
    matched = true;
    if (start > last) out.push(text(value.slice(last, start)));
    out.push(el);
    last = start + token.length;
  }
  if (!matched) return null;
  if (last < value.length) out.push(text(value.slice(last)));
  return out;
}

function walk(node: Root | Element, inSkip: boolean): void {
  // Root's children may in principle hold non-element content, but message
  // markdown never produces any, and we only ever read `.type` / `.value` and
  // splice in Text / Element (both valid in either container).
  const kids = node.children as ElementContent[];
  for (let i = 0; i < kids.length; i++) {
    const child = kids[i];
    if (child.type === "element") {
      walk(child, inSkip || SKIP_TAGS.has(child.tagName));
    } else if (child.type === "text" && !inSkip) {
      const replaced = linkifyTextValue(child.value);
      if (replaced) {
        kids.splice(i, 1, ...replaced);
        // Skip past the nodes just inserted; they are code/a (link) elements,
        // never text, so there is nothing more to linkify in them.
        i += replaced.length - 1;
      }
    }
  }
}

export function rehypeLinkifyIds() {
  return (tree: Root): void => {
    walk(tree, false);
  };
}
