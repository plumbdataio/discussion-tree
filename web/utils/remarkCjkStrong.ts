// remark plugin: rescue **strong** runs that CommonMark's flanking rules
// refuse to parse next to CJK punctuation.
//
// CommonMark decides whether a `**` can open/close emphasis from the
// characters flanking it ("flanking delimiter runs"). A `**` adjacent to a
// CJK bracket / quote — 「」 『』 （） 【】 — fails those rules, so a bold span
// whose content starts or ends with one is left as LITERAL asterisks:
//
//   x**「y」**z   ->   literal "x**「y」**z" (asterisks shown, no bold)
//   x**y**z       ->   "x<strong>y</strong>z" (fine)
//
// That is why bold "sometimes" breaks in Japanese text. By the time remark
// plugins run, every WORKING bold span is already a `strong` mdast node; only
// the FAILED runs survive verbatim inside text nodes. So we re-parse leftover
// `**...**` runs in text nodes into `strong` nodes. Conservative on purpose:
//   - only double-asterisk (the form CC uses); single `*` is too ambiguous
//   - content must be non-empty, start non-space, and contain no `*`/newline
//   - only `text` nodes are touched, so `**` inside `inlineCode`/`code` (which
//     are separate node types) is never rewritten
//
// Known residual: two bracket-edged bold spans on ONE line (e.g. `**「A」**`
// then `**【B】**`) — CommonMark mis-pairs the inner `**`, splitting the text
// node so the outer asterisks land in different siblings and we can't rejoin
// them. Rare; a full fix needs a micromark-level CJK extension.

const STRONG_RE = /\*\*(?=\S)([^*\n]+?)\*\*/g;

type MdNode = {
  type: string;
  value?: string;
  children?: MdNode[];
};

function rewriteChildren(node: MdNode): void {
  if (!node.children || node.children.length === 0) return;
  const out: MdNode[] = [];
  for (const child of node.children) {
    if (child.type === "text" && child.value && child.value.includes("**")) {
      const value = child.value;
      let last = 0;
      let matched = false;
      STRONG_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = STRONG_RE.exec(value))) {
        matched = true;
        if (m.index > last) {
          out.push({ type: "text", value: value.slice(last, m.index) });
        }
        out.push({ type: "strong", children: [{ type: "text", value: m[1] }] });
        last = m.index + m[0].length;
      }
      if (matched) {
        if (last < value.length) {
          out.push({ type: "text", value: value.slice(last) });
        }
      } else {
        out.push(child);
      }
    } else {
      rewriteChildren(child);
      out.push(child);
    }
  }
  node.children = out;
}

export function remarkCjkStrong() {
  return (tree: MdNode): void => {
    rewriteChildren(tree);
  };
}
