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

// CommonMark's flanking failure only happens when a CJK punctuation char (a
// bracket / quote / fullwidth punctuation) sits at the boundary of the bold
// content — that is precisely what trips the open/close rules. Gating on this
// keeps the rescue from also "un-escaping" a deliberately escaped run: a user's
// `\*\*literal\*\*` parses to a plain text node `**literal**` too, but its
// boundary is an ASCII letter, so it (correctly) stays literal. (Bold with only
// CJK *letters* at the edges already parses fine, so it never arrives here as
// literal text — only the bracket/punctuation-edged failures do.) Ranges:
// CJK symbols & punctuation, plus fullwidth/halfwidth punctuation.
// Built from code points (not literal glyphs) so this file stays ASCII: ranges
// are CJK symbols & punctuation (0x3000-0x303F) and fullwidth / halfwidth
// punctuation (0xFF01-0F, 0xFF1A-20, 0xFF3B-40, 0xFF5B-65) — the bracket /
// quote / paren glyphs that break flanking.
const _cp = (n: number) => String.fromCharCode(n);
const CJK_PUNCT = new RegExp(
  "[" +
    _cp(0x3000) + "-" + _cp(0x303f) +
    _cp(0xff01) + "-" + _cp(0xff0f) +
    _cp(0xff1a) + "-" + _cp(0xff20) +
    _cp(0xff3b) + "-" + _cp(0xff40) +
    _cp(0xff5b) + "-" + _cp(0xff65) +
    "]",
);
function cjkEdged(s: string): boolean {
  return CJK_PUNCT.test(s[0]) || CJK_PUNCT.test(s[s.length - 1]);
}

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
        // Only rescue runs whose failure came from a CJK punctuation boundary;
        // leave escaped (`\*\*x\*\*`) or other literal ** runs untouched.
        if (!cjkEdged(m[1])) continue;
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
