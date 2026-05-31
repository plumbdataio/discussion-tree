# Bun/TypeScript port of the Claude Code hooks

The shipped hooks under `scripts/*.sh` are bash scripts that shell out
to `jq` and `curl`. They work great on macOS / Linux where those tools
are universally available — but on Windows shells they require extra
setup (Git Bash / WSL).

These `.ts` versions are functionally identical drop-in replacements
written in plain TypeScript and run by Bun, so they need no external
binaries beyond `bun` itself. Use them on **Windows**, or on any
machine where you'd rather not depend on `jq` / `curl` in the PATH.

| `.sh` hook | `.ts` replacement |
|---|---|
| `scripts/session-start-hook.sh` | [`dt-session-start.ts`](dt-session-start.ts) |
| `scripts/tool-activity-hook.sh` | [`dt-tool-activity.ts`](dt-tool-activity.ts) |
| `scripts/tool-activity-clear-hook.sh` | [`dt-tool-activity-clear.ts`](dt-tool-activity-clear.ts) |

All three:

- Parse the stdin JSON natively (no `jq`).
- Talk to the broker via the built-in `fetch` with a 1-second
  `AbortController` timeout (no `curl`, no risk of hanging the tool
  call).
- Resolve `~/.discussion-tree` via `os.homedir()` (works on stock
  Windows shells where `$HOME` is unset).
- Honor `DISCUSSION_TREE_HOME` and `DISCUSSION_TREE_PORT`, just like
  the bash versions.
- Use `process.ppid` to identify CC — Claude Code spawns the hook
  directly, so the parent PID matches the same value the MCP server
  reads.

## Installing them

Register the hook in `~/.claude/settings.json` with the absolute path
to `bun` and to the script (PATH-independent):

```jsonc
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "<bun.exe absolute path> <repo>/scripts/ts/dt-session-start.ts"
          }
        ]
      }
    ],
    "PreToolUse": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "<bun.exe absolute path> <repo>/scripts/ts/dt-tool-activity.ts"
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "<bun.exe absolute path> <repo>/scripts/ts/dt-tool-activity-clear.ts"
          }
        ]
      }
    ]
  }
}
```

On macOS / Linux you can also use these in place of the bash versions
if you prefer a single-runtime setup — they're behavior-equivalent.

## Why two copies?

We keep the bash versions as the macOS / Linux default because they
ship as plain text in `scripts/*.sh` and are trivially auditable
without reading TypeScript. The `.ts` versions exist primarily so a
Windows host can run the whole discussion-tree stack without WSL or
Git Bash.
