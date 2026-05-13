import React from "react";
import { defaultUrlTransform } from "react-markdown";

// react-markdown v9 strips URLs whose scheme is outside its safe-protocol whitelist
// (http, https, mailto, tel). We extend it to permit file:// links so that
// "open original" links from the image-paste flow remain clickable.
export const urlTransform = (url: string) => {
  if (/^file:\/\//i.test(url)) return url;
  return defaultUrlTransform(url);
};

// Browsers block plain `file://` navigation from http origins, so we route the
// click through the broker which spawns `open <path>` on the host.
export function MarkdownAnchor(
  props: React.AnchorHTMLAttributes<HTMLAnchorElement>,
) {
  const { href, onClick, ...rest } = props;
  if (href && /^file:\/\//i.test(href)) {
    const localPath = decodeURI(href.replace(/^file:\/\//i, ""));
    return (
      <a
        {...rest}
        href={href}
        onClick={(e) => {
          e.preventDefault();
          fetch("/open-file", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ path: localPath }),
          }).catch(() => {
            /* surfacing errors here would be noisy; fail silently */
          });
        }}
      />
    );
  }
  return <a {...rest} href={href} target="_blank" rel="noopener noreferrer" />;
}
