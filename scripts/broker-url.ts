// Shared broker base-URL resolver for the standalone discussion-tree hook
// scripts (topic-drift-hook.ts and the Windows/Bun ports under scripts/ts/).
//
// Mirrors server/config.ts's BROKER_URL: honor DISCUSSION_TREE_BROKER_URL when
// set (a CC on another machine pointed at a broker running elsewhere), else fall
// back to loopback on DISCUSSION_TREE_PORT (default 7898) — identical to these
// hooks' prior hard-coded `http://127.0.0.1:${port}` when the env var is unset.
//
// Kept as a tiny local module rather than importing server/config.ts so these
// hooks stay standalone (the scripts/ts/* ports are deliberately dependency-free
// for Windows). The `env` parameter defaults to process.env and exists so the
// resolution can be unit-tested with the env var set vs unset.
export function brokerBaseUrl(
  env: Record<string, string | undefined> = process.env,
): string {
  const base =
    env.DISCUSSION_TREE_BROKER_URL ??
    `http://127.0.0.1:${env.DISCUSSION_TREE_PORT ?? "7898"}`;
  // Strip trailing slashes so `${brokerBaseUrl()}/endpoint` never doubles up.
  return base.replace(/\/+$/, "");
}
