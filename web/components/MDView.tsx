import React from "react";
import ReactMarkdown from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { MarkdownAnchor, urlTransform } from "./MarkdownAnchor.tsx";
// CommonMark's flanking rules drop **bold** whose content is edged by CJK
// punctuation (a corner bracket / fullwidth paren), so it renders with literal
// asterisks. This maintained micromark-level extension fixes it at parse time —
// handling escapes / entities / multiple runs correctly, which a post-parse
// fixup cannot. Must come after remark-gfm (per its docs).
import remarkCjkFriendly from "remark-cjk-friendly";
// remark-cjk-friendly only fixes emphasis (** / *); its companion does the same
// for GFM strikethrough (~~) so a ~~struck~~ span jammed against CJK still renders.
import remarkCjkFriendlyGfmStrikethrough from "remark-cjk-friendly-gfm-strikethrough";

function MDViewImpl({
  text,
  className,
}: {
  text: string;
  className?: string;
}) {
  const cls = `md-body${className ? " " + className : ""}`;
  return (
    <div className={cls}>
      {/* remark-breaks turns single newlines into <br> instead of
          letting CommonMark collapse them to a space. Closer to what
          users type in the textarea expect to see — the "GitHub
          comment / chat" feel rather than strict CommonMark. */}
      <ReactMarkdown
        // singleTilde:false — GFM defaults to treating a SINGLE ~x~ as
        // strikethrough, so a message with two home-dir paths ("~/foo ... ~/bar")
        // strikes everything between them. Require the standard double ~~x~~ for
        // strikethrough instead, so bare ~/paths render literally.
        remarkPlugins={[
          [remarkGfm, { singleTilde: false }],
          remarkCjkFriendly,
          remarkCjkFriendlyGfmStrikethrough,
          remarkBreaks,
        ]}
        urlTransform={urlTransform}
        components={{
          a: ({ node, ...props }) => <MarkdownAnchor {...props} />,
          // remark-gfm parses tables into a bare <table>. dt's columns are
          // narrow, so wrap it in a horizontally-scrollable box (with a
          // scroll-shadow hint) instead of letting a wide table blow out the
          // layout. See .md-table-wrap in style.css.
          table: ({ node, ...props }) => (
            <div className="md-table-wrap">
              <table {...props} />
            </div>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

// Memoized: a thread renders one MDView per message. Without memo, ANY
// parent re-render (e.g. a single keystroke in the board's textarea, which
// updates the parent's draft state) re-parses every message's markdown —
// measured at 250ms+ per keystroke on a long conversation. `text` and
// `className` are the only props and both are primitives, so React's
// default shallow prop comparison is exactly what we want here.
export const MDView = React.memo(MDViewImpl);
