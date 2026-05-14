import React from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { MarkdownAnchor, urlTransform } from "./MarkdownAnchor.tsx";

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
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        urlTransform={urlTransform}
        components={{
          a: ({ node, ...props }) => <MarkdownAnchor {...props} />,
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
