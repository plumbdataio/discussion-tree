#!/bin/sh
# Build smoke-check for the entry points: the MCP server (server.ts) and the
# broker (broker.ts). Because broker.ts imports the web bundle, this transitively
# builds the whole frontend too, so a broken .tsx / CSS import is caught here as
# well — more coverage than just the two server files.
#
# WHY THIS EXISTS:
# Bun runs TypeScript by transpiling it (stripping types) WITHOUT type-checking,
# so a *syntax* error — e.g. an unescaped backtick inside a template literal —
# is not caught until the module fails to PARSE at load time. A server module
# that won't load takes the MCP server down, and because the server is spawned
# fresh per Claude Code session, a bad commit can knock sessions offline after a
# plugin update. `bun build` parses every module and resolves every import
# WITHOUT executing anything, so it catches that whole class before it can be
# committed. (Type-only errors are intentionally NOT gated here: Bun ignores
# them at runtime, and gating on them would be noisy.)
#
# Run from the pre-commit hook (cannot be bypassed in the normal flow) and from
# restart-broker.sh (so a broken working tree is never deployed).
set -e

cd "$(dirname "$0")/.."

OUT="$(mktemp -d)"
trap 'rm -rf "$OUT"' EXIT

if ! bun build server.ts broker.ts --target=bun --outdir "$OUT" >"$OUT/.log" 2>&1; then
  echo "check-build: bun build FAILED — refusing to proceed." >&2
  echo "(A parse/import error here would break module loading at runtime.)" >&2
  echo "----" >&2
  cat "$OUT/.log" >&2
  exit 1
fi
