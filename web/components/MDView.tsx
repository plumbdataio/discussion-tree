import React from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { MarkdownAnchor, urlTransform } from "./MarkdownAnchor.tsx";

export function MDView({
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
