# 🌳 discussion-tree

**discussion-tree turns a single Claude Code session into a structured, parallel decision tree.**

CLI is serial. The moment you have three things to figure out at once with Claude Code, the conversation has to interleave them — and somewhere along the way, context drifts. discussion-tree lays the questions out as a mind-map in the browser: each item gets its own card, you answer each one independently, and Claude Code receives every answer back through the MCP channel. The CLI side stays linear; the user side gets to see "which thread is this?" at a glance.

## Key features

- **Parallel decisions inside a single CC session.** Not multi-instance orchestration — just splits one Claude Code session's discussion into independent settle-able branches. Each board = one actionable feature / decision.
- **DB-backed context that doesn't evaporate.** Every board, node, status change, and message is persisted in SQLite. You can revisit a discussion from last week and Claude Code can re-read its own past reasoning, same as you do — the project becomes a permanent shared memory rather than a stream of CLI turns lost to scrollback.
- **Mobile / off-device access via Tailscale Serve.** Open the same board UI from your phone on the train, answer a node, and the next CC turn picks up your reply on the desktop. The broker stays bound to localhost; Tailscale handles the network and auth.
- **Live UI.** WebSocket pushes — node status changes, Claude's incoming replies, the working badge from the PreToolUse hook — repaint instantly across every open tab and device.
- **Default conversation board.** Each CC session auto-gets a chat-style board so you have a casual surface for "talk to Claude in the browser instead of CLI" without creating a structured board first.
- **Optimistic submit + delivery confirmation.** Posting from the UI shows a tentative card immediately; the broker blocks until the MCP server has actually picked the message up. If CC isn't reachable, the text is preserved in the textarea so you don't lose it.
- **Image paste / drop.** Screenshots paste straight into the textarea, get uploaded to a per-board directory under `$PARALLEL_DISCUSSION_HOME/uploads/`, and the message text includes the absolute path so Claude reads the image with its `Read` tool before replying.
- **Per-device UI settings.** Light / dark / system theme, language (English / Japanese / system), auto-mark-as-read, sidebar status filter. Per-device localStorage so your phone and laptop can behave differently.
- **Inspired by [claude-peers-mcp](https://github.com/zerocolored/claude-peers-mcp).** Same broker-daemon-plus-MCP-server topology; the topic split (intra-session, structured) is where discussion-tree diverges.

## Concepts

The data model is intentionally shallow. Two structural levels and that's it:

- **Session** — one Claude Code session_id. Stable across MCP-server restarts via `attach_cc_session`. The sidebar groups boards by session.
  - **Board** — one settle-able unit ("1 board = 1 actionable feature / decision"). Each session also gets one auto-created **default conversation board** (a chat surface with a single fixed node).
    - **Concern** — top-level discussion topic within a board. Visually a column header in the UI.
      - **Item** — a node hanging under a concern. The unit of discussion / decision. Has a **status** (`pending` / `discussing` / `resolved` / `agreed` / `adopted` / `rejected` / `needs-reply` / `done`) and a **thread** of messages.
        - **Thread item** — one message in the item's conversation log. `source` is `user`, `cc`, or `system` (status-change auto-entries). Has a `read_at` so the unread dot in the sidebar can light up.

The hierarchy is deliberately exactly 2 levels (concern → items): no sub-items. If a topic feels like it needs nesting, you split it into a separate concern, or split the whole thing into a new board. This keeps the UI readable at a glance and forces "1 decision per node" granularity.

## Quick start

### 1. Clone & install

```bash
git clone https://github.com/plumbdataio/discussion-tree.git ~/discussion-tree
cd ~/discussion-tree
bun install
```

### 2. Register the MCP server (user scope)

```bash
claude mcp add --scope user --transport stdio discussion-tree -- bun ~/discussion-tree/server.ts
```

### 3. Install the SessionStart hook (auto-attach)

This hook lets Claude Code session restarts inherit existing boards instead of orphaning user submissions. After setup, every CC session auto-binds to the right ownership; you don't need to call `attach_cc_session` manually.

#### 3-1. Place the hook script under `~/.claude/hooks/`

This is the location Claude Code's docs treat as standard (if you use `CLAUDE_CONFIG_DIR`, use the equivalent path under it). Symlinking the bundled template is easiest — `git pull` keeps it current.

```bash
mkdir -p ~/.claude/hooks
ln -s ~/discussion-tree/scripts/session-start-hook.sh ~/.claude/hooks/discussion-tree-session-start.sh
```

If you'd rather pin a copy:

```bash
cp ~/discussion-tree/scripts/session-start-hook.sh ~/.claude/hooks/discussion-tree-session-start.sh
chmod +x ~/.claude/hooks/discussion-tree-session-start.sh
```

#### 3-2. Register in `~/.claude/settings.json`

Append to the `hooks.SessionStart` array:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "$HOME/.claude/hooks/discussion-tree-session-start.sh"
          }
        ]
      }
    ]
  }
}
```

To uninstall, drop the symlink and remove this block.

Dependency: `jq` (`brew install jq` etc.).

#### 3-3. Verify

After starting a fresh CC session, `<CC PID>.json` briefly appears under `$PARALLEL_DISCUSSION_HOME/cc-sessions/` and is consumed at MCP-server startup. The broker logs `Auto-attached to CC session <uuid>` on success.

> **Why `$PPID` works on both sides:** inside the hook, `$PPID` is Claude Code's PID. The MCP server reads `process.ppid`, also CC's PID. Same key on both sides.

### 4. Launch Claude Code with the channel enabled

```bash
claude --dangerously-load-development-channels server:discussion-tree
```

Aliasing recommended:

```bash
alias claudedt='claude --dangerously-load-development-channels server:discussion-tree'
```

### 5. Try it out

Inside a CC session:

> "I have three things to settle — would you make a board with discussion-tree?"

CC calls `create_board`, returns a URL → open in the browser → answer per node → within a second the answer arrives in the CC session as a channel push.

## Optional: auto activity badge (PreToolUse / Stop hook)

Hook setup that surfaces "CC is doing something now" in the UI without requiring the LLM to call `set_activity`. A `working` badge lights up on every tool call and clears at turn end.

Register two hooks in `~/.claude/settings.json`:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "/absolute/path/to/discussion-tree/scripts/tool-activity-hook.sh"
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "/absolute/path/to/discussion-tree/scripts/tool-activity-clear-hook.sh"
          }
        ]
      }
    ]
  }
}
```

The broker has a 60-second safety-net auto-clear, so even if `Stop` fails to fire the badge eventually disappears. LLM-set badges (`set_activity(state="blocked", ...)`) are untouched by this.

Dependencies: `jq`, `curl`.

## Optional: topic-drift nudge (Stop hook)

The MCP `instructions` ask the LLM to push parallel decision points into boards (via `add_concern` / `create_board`) instead of burying them in the CLI thread. Instructions alone don't fire deterministically — when the model has already chosen to enumerate alternatives in-line, only a hook can interrupt that turn.

This hook scans the latest assistant message at end-of-turn (`Stop`). If it spots option-presentation patterns (e.g. `1. … / 2. … / 3. …`, `A. … / B. …`, `Option A`, `案A`) and the current session has discussing/settled boards, it writes a `<system-reminder>` to stdout. Claude Code surfaces hook stdout into the next turn's context, so the next reply will be reminded to surface those decisions on a board.

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "bun /absolute/path/to/discussion-tree/scripts/topic-drift-hook.ts"
          }
        ]
      }
    ]
  }
}
```

Stays silent if there are no active boards (= no surface to redirect into), and quiet on plain replies. Set `PARALLEL_DISCUSSION_TOPIC_DRIFT_DEBUG=1` to log decisions to stderr.

## Mobile / accessing from another device (Tailscale Serve)

Setup for opening the UI from a phone or another machine. **Tailscale Serve** proxies over your tailnet only; the broker stays bound to `127.0.0.1` and is safely reachable from your other devices without any public exposure.

> ⚠️ **Never enable Funnel.**
> Tailscale exposes two modes: Serve (tailnet-only) and Funnel (public internet). Funnel exposes the URL to the world. The broker has no auth, so anyone could browse boards, post, upload images, and trigger `/open-file`. Use Serve only.

### 1. Install Tailscale (macOS GUI)

```bash
brew install --cask tailscale-app
```

The `tailscale` brew formula's daemon can't register `*.ts.net` DNS resolution to the system resolver — so browsers can't open `https://<host>.<tailnet>.ts.net`. The cask version's System Extension handles DNS correctly.

> Linux / Windows / iOS / Android work normally with the standard packages.

### 2. Enable Serve (one-time)

```bash
tailscale serve status
```

The first time, this prints a `https://login.tailscale.com/f/serve?node=...` link. Open it and enable Serve. **Untick "Tailscale Funnel"** if it shows.

### 3. Publish the broker

```bash
tailscale serve --bg http://localhost:7898
tailscale serve status
```

Use the `https://<your-machine>.<tailnet>.ts.net` URL from any device on your tailnet.

When sharing board URLs, set `PARALLEL_DISCUSSION_PUBLIC_URL=https://<your-machine>.<tailnet>.ts.net` so `create_board` returns reachable URLs instead of `localhost`.

## How it works

```
   Browser (mind-map UI)            broker daemon                Claude Code
   :7898 + SQLite                   localhost:7898               stdio MCP server
       │                                  ▲
       │   submit answer                  │
       ├─────────────────────────────────►│   poll @ 1Hz
       │                                  │   ──────────────►   channel push
       │       CC reply (post_to_node)    │
       │◄─────────────────────────────────│
```

- **Broker** (`broker.ts` + `broker/`): HTTP + WebSocket daemon on `localhost:7898`, holds SQLite (`$PARALLEL_DISCUSSION_HOME/db.sqlite`). Auto-launched on the first MCP-server startup; a singleton across CC sessions.
- **MCP server** (`server.ts` + `server/`): stdio MCP process spawned per CC session. Exposes tools, polls the broker for unread messages, forwards them to CC via `notifications/claude/channel`.
- **Web UI** (`web/`): React SPA. Bundled by Bun.serve via the HTML import, live-updated over WebSocket.

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `PARALLEL_DISCUSSION_PORT` | `7898` | broker port |
| `PARALLEL_DISCUSSION_HOME` | `~/.parallel-discussion` | umbrella state directory (DB, uploads, cc-sessions) |
| `PARALLEL_DISCUSSION_DB` | `$PARALLEL_DISCUSSION_HOME/db.sqlite`<br>(legacy `~/.parallel-discussion.db` if it already exists) | SQLite file path |
| `PARALLEL_DISCUSSION_PUBLIC_URL` | `http://localhost:$PORT` | base URL returned by `create_board` (override when reaching the broker through Tailscale Serve / a custom hostname) |
| `PARALLEL_DISCUSSION_REQUESTS_FILE` | `<repo>/REQUESTS.md` | location for `request_improvement` output |

> The env-var prefix is `PARALLEL_DISCUSSION_` (project's working title). Kept stable so the broker / MCP server / SessionStart hook agree across upgrades.

The defaults need no setup. To relocate state, set `PARALLEL_DISCUSSION_HOME` somewhere Claude Code (and therefore the MCP server, broker, and SessionStart hook it spawns) will inherit. Pick whichever fits your workflow:

- **Once-off**: prefix the launch — `PARALLEL_DISCUSSION_HOME=/path claude`
- **Persistent**: add `export PARALLEL_DISCUSSION_HOME=/path` to `~/.zshenv` (`.zshenv` covers interactive AND launcher-spawned shells; `.zshrc` covers only the former)
- **Project-scoped**: drop a `.envrc` with the export and use [direnv](https://direnv.net/)
- **GUI-launched CC** (Dock etc.): `launchctl setenv PARALLEL_DISCUSSION_HOME /path` (or persist via a `~/Library/LaunchAgents/*.plist`)

## Requirements

- [Bun](https://bun.sh) ≥ 1.0
- Claude Code (a version supporting `--dangerously-load-development-channels`)

## Acknowledgements

The broker-daemon + per-session MCP-server architecture is directly inspired by [claude-peers-mcp](https://github.com/zerocolored/claude-peers-mcp). discussion-tree's contribution is the orthogonal split: instead of routing messages between *peer* CC instances, it splits *one* CC session's conversation into structured parallel threads — same machinery, different axis.

## License

MIT — see [LICENSE](LICENSE).
