# Configuration, API and architecture

Every environment variable the server reads, every route it answers, and the
shape of the thing underneath. Ahead of them, the security model, because most
of what follows is a knob that moves a line in it — the reporting policy and the
full trust model live in [SECURITY.md](../SECURITY.md).

- [Security model](#security-model)
- [Configuration (env)](#configuration-env)
- [API](#api)
- [Architecture](#architecture)

---

## Security model
agentglass is a **workspace, not just a viewer**: it can open a real shell,
write to your repos and control Docker. It ships safe for its intended home —
**your own single-user machine** — and you should know exactly where the lines
are:

- **It only listens on your own machine.** The server binds `127.0.0.1` —
  nothing on your network can reach it.
- **The desktop app is authenticated even there.** It mints a shared secret on
  first launch (`0600`, in your config dir) and runs its server behind it, remote
  access or not, so that reaching the port and being let through it stop being
  the same thing. `localhost` belongs to the *machine*, not to your account:
  without this, a second Unix user on the box — or a browser extension holding
  `http://localhost/*` — opened `http://localhost:4000` and got the cockpit,
  shell included. This does **not** make the app the only way in, and isn't
  meant to: a browser still gets there with `?token=`, which is what the phone
  and the QR flow are built on. It closes the callers that can reach the port
  and can't read the file. Running the server yourself (`bun run server`) on
  loopback with no `AGENTGLASS_TOKEN` set is unchanged — still no auth, because
  there "can reach localhost" is a choice you made knowingly.
- **Shared-secret token.** Set `AGENTGLASS_TOKEN` and every route
  requires it — `Authorization: Bearer <token>` for the API, `?token=<token>` on
  the dashboard URL (it's stored and stripped from the address bar). The
  append-only telemetry sinks (`/ingest`, the OTLP receivers) are the one
  exception, and only for a sender **on this machine**: a local hook has no way
  to carry a secret, while appending from the network is not inert — an event
  raises a notification on your desk and on your paired phone, and lands in the
  database for good. From off-box those sinks need the token like everything
  else (the hook scripts send it when `AGENTGLASS_TOKEN` is in their env). This is what makes a
  shared machine or a network bind safe, and it stops *other local processes*
  from opening the shell. Binding a non-loopback address **without** a token
  refuses to run unauthenticated: it mints one, prints it, and saves it
  `0600` under your config dir on POSIX (Linux/macOS). Windows has no POSIX
  mode bits, so there the file falls back to your account's default ACL.
- **Websites you visit can't touch it.** Every request is origin-checked, the
  shell and the live stream require a verified local origin, and a Host-header
  guard blocks DNS-rebinding tricks (browsers can't forge `Host`). Running it
  behind a reverse proxy? Allow its name via `AGENTGLASS_ALLOWED_HOSTS`.
- **⚠️ Shared / multi-user machines are still not the default home.** The
  desktop app's token (above) is what stops another account on the box reaching
  your shell, and it is on by default now rather than something to remember. If
  you run the **server yourself** on a shared box, that is on you: set
  `AGENTGLASS_TOKEN`. Either way, consider disabling the
  capability surfaces you don't use: `AGENTGLASS_TERMINAL_DISABLED=1`, `AGENTGLASS_FS_BROWSE_DISABLED=1`,
  `AGENTGLASS_CHAT_DISABLED=1`, `AGENTGLASS_CODEX_DISABLED=1`,
  `AGENTGLASS_ANTIGRAVITY_DISABLED=1`, `AGENTGLASS_GIT_WRITE_DISABLED=1`,
  `AGENTGLASS_DOCKER_WRITE_DISABLED=1`.
- **⚠️ Exposing it to a network is a three-part deliberate act.** `AGENTGLASS_BIND=0.0.0.0`
  hands the shell, git write and Docker control to that network. Do it only with
  a token set **and** `AGENTGLASS_TRUST_LAN=1` (off by default, LAN browsers are
  refused as cross-origin without it), and only on a network you fully trust.
  Settings › Remote does all three as one switch, and shows you a QR code —
  including a warning in these words, because the switch is the same decision.
  If a device still can't reach it, the host firewall is dropping the packets:
  the panel names it and prints the command that opens the port to your subnet
  only. Tailnet (Tailscale) addresses count as private under `TRUST_LAN` too.
- **⚠️ Browser-driven autonomy is opt-in.** The Chat panel's unattended modes —
  `bypassPermissions` for Claude (`claude --dangerously-skip-permissions`),
  `full-access` for Codex (`codex --dangerously-bypass-approvals-and-sandbox`)
  and `always-proceed` for Antigravity (`agy --dangerously-skip-permissions`) —
  are honored only when `AGENTGLASS_CHAT_BYPASS=1`. One opt-in covers all three,
  since it is the same decision. Without it Claude is downgraded to a prompting
  default, Codex to its read-only sandbox, and Antigravity to asking.
- **Your data stays local.** Events live in a local SQLite file, written
  owner-only (`0700` dir, `0600` file) on POSIX; on Windows, which has no POSIX
  mode bits, it falls back to your account's default ACL. Outbound calls are few and all of them are yours to
  switch off: the optional Anthropic plan-usage meter (`api.anthropic.com`,
  using your own credentials), the update check against the GitHub releases API,
  the **Pull requests** panel through your own authenticated `gh` CLI, the AI
  **Explain** walkthrough through a local `claude` (or your `ANTHROPIC_API_KEY`),
  and anything *you* configure (webhook alerts).
- **The phone is not an exception.** An alert reaches it over the socket it
  already holds to your machine, so there is no third party in that path at all
  — no push service, no device token registered anywhere, nothing to revoke but
  the device itself. agentglass used to post to whichever push service the
  phone's browser nominated (Google's, Mozilla's, Apple's), encrypted end to end
  so the service relayed something it could not read; that route is gone, and
  the VAPID key it used to mint (`~/.config/agentglass/push.json`) is no longer
  written or read. An existing one is dead weight and can be deleted.

---
---

## Configuration (env)

| Var | Default | Meaning |
|---|---|---|
| `AGENTGLASS_PORT` | `4000` | Server HTTP/WS port. |
| `AGENTGLASS_BIND` | `127.0.0.1` | Address the server binds to. Loopback-only by default. Exposing (`0.0.0.0`) requires `AGENTGLASS_TOKEN` **and** `AGENTGLASS_TRUST_LAN=1`, and only on a trusted network. See [Security model](#security-model). |
| `AGENTGLASS_TOKEN` | — | Shared secret required on every route but the telemetry intake sinks. Pass as `Authorization: Bearer <t>` or `?token=<t>`. Locks the server to you on a shared machine and makes a network bind safe. Exposing — **or setting `AGENTGLASS_TRUST_LAN=1`** — auto-mints + prints a token (saved `0600` in the config dir on POSIX; the default ACL on Windows). `/health` is exempt alongside the intake sinks, so a shell can probe which server owns the port. |
| `AGENTGLASS_TRUST_LAN` | — | `1` → also trust RFC1918 (private-LAN) addresses as origins/hosts, not just loopback. Required for LAN browsers to reach an exposed instance. Off by default: a shell-granting server trusts only `localhost` unless told otherwise. **Setting it makes a token mandatory** — even on the default loopback bind — because it widens the CSRF origin gate to any private-IP page; with no `AGENTGLASS_TOKEN` set the server mints, persists and prints one. |
| `AGENTGLASS_ALLOWED_HOSTS` | — | Comma-separated extra hostnames accepted by the DNS-rebinding guard (requests must arrive under a localhost/private `Host`). Only needed behind a reverse proxy. |
| `AGENTGLASS_WEB_DIR` | — | Directory holding the built dashboard (`index.html` + `assets/`) to serve from the API port. Defaults to `web/dist` beside the source. The desktop app sets it to the bundle it ships, which is what lets its own server hand a phone a dashboard instead of a bare API. |
| `AGENTGLASS_DB` | `~/.local/share/agentglass/agentglass.db` | SQLite file path. The default lives under `$XDG_DATA_HOME` (or `~/.local/share`), created `0700`. A pre-existing `agentglass.db` **in the working directory** wins — but only for a checkout that already has one: a fresh clone has no such file, so `bun run dev` there lands on the shared history under `$XDG_DATA_HOME`, the same file the installed app uses. Isolating `XDG_DATA_HOME` alone is not enough either if you also want the *installed* app's database left alone — set this variable. A second server on the same file runs with its transcript scanner disabled (see the claim above), so it will not corrupt anything, but it also will not scan. |
| `AGENTGLASS_DB_CLAIM` | `1` | `0` → do not claim the database file at boot, and do not stand the scanner down when someone else holds it. The escape hatch for the case where the claim itself is in the way; leaving it on is what keeps two processes from double-counting events, tokens and cost. |
| `AGENTGLASS_ROOT` | — | Scope the whole cockpit to one project (repo + worktrees) or a folder of projects. Unset = every project on the machine. Also set by passing a directory to the desktop app; the in-app **project picker** sets/clears the same scope at runtime and persists it as `root` in the config file (note: the env var, when set, wins again on the next launch). |
| `AGENTGLASS_REPO_DIRS` | — | Colon-separated dirs to sweep for git repos (git / terminal / chat panels). Also settable as `repoDirs` in the config file. |
| `AGENTGLASS_PROJECTS_DIR` | `~/.claude/projects` | Root the transcript scanner reads Claude Code session logs from. Several roots can be listed, separated by the platform's `PATH` delimiter (`:` on Linux/macOS, `;` on Windows). |
| `AGENTGLASS_SCAN_INTERVAL_MS` | `3000` | Transcript scan poll interval (min 500). |
| `AGENTGLASS_SCAN_DISABLED` | — | `1` → turn off the machine-wide transcript scanner (rely on hooks / OTel only). |
| `AGENTGLASS_RETENTION_DAYS` | `8` | Days of **raw events** to keep (pruned hourly, with resolved gates and answered reminders). Covers the full 7d stats window. Expiring days are folded into a daily rollup first, so spend history outlives the rows. `0` = keep events for ever, and also keep the Clone's shifts, acts and runs for ever. It does **not** move the Clone's and Lantern's own windows (30 and 90 days, fixed) — see SECURITY.md, *What agentglass stores*. |
| `AGENTGLASS_PRICING` | — | Path to a JSON pricing override (see `server/src/pricing.ts`). |
| `AGENTGLASS_WEBHOOK` | — | POST `{text}` here (a Slack/Discord-shaped incoming webhook) for alerts, Lantern watch notices and PR nudges sent with `send: true`. Loopback URLs work directly; remote URLs require `AGENTGLASS_ALLOW_REMOTE=1`, and the destination host is logged once at boot. What travels is the notification's title and body — agent names, a checkout's base name, a PR's number, title, URL and reviewer logins — never a transcript, a diff or a token. Blanked out of every Clone run. |
| `AGENTGLASS_NOTIFY` | — | `1` → fire desktop alerts. A connected client (browser or desktop app) raises a **native OS notification** on any platform; `notify-send` is the fallback for a headless server with nothing attached to show it. Does **not** gate the phone, which hears every alert on the socket it already holds and decides for itself — see [Alerts on the phone](WORKSPACE.md#alerts-on-the-phone-and-what-they-honestly-cover). |
| `AGENTGLASS_SERVER` | `http://127.0.0.1:4000` | Used by the hook/seed scripts. Refused unless it points at this machine — see the next row. A `localhost` value is accepted and rewritten to `127.0.0.1` before connecting: the server binds IPv4-only, so on a host that resolves `localhost` to `::1` first, every event pays a refused connect before falling back. |
| `AGENTGLASS_ALLOW_REMOTE` | — | `1` → allow configured outbound destinations beyond loopback and known service hosts. This lets hook scripts post to a non-local `AGENTGLASS_SERVER`, enables remote `AGENTGLASS_WEBHOOK` URLs, and permits a custom remote `ANTHROPIC_BASE_URL` for walkthroughs. Off by default and deliberately awkward because these payloads can contain notifications, transcripts, or repository diffs. |
| `AGENTGLASS_WALKTHROUGH_DISABLED` | — | `1` → disable AI walkthrough generation even when the Claude CLI or an Anthropic API key is available. |
| `VITE_CW_SERVER` | `http://<host>:4000` | UI → server URL (build/dev time). Unset, the UI resolves same-origin when the server itself served it (single-port mode), `:4000` otherwise. |
| `AGENTGLASS_GIT_WRITE_DISABLED` | — | `1` → make the **Source control** panel read-only (no stage / commit / push). Also makes the **Pull requests** panel read-only — no merge, close, review submit or branch update. |
| `AGENTGLASS_DOCKER_WRITE_DISABLED` | — | `1` → make the **Docker** panel read-only (no start / stop / restart / rm). |
| `AGENTGLASS_BUDGET_WRITE_DISABLED` | — | `1` → refuse changes to spend budgets from the app (`POST /budgets/set`). Reading them still works. |
| `AGENTGLASS_TASK_WRITE_DISABLED` | — | `1` → make the **Tasks** view's local list read-only: no add, done, edit, delete or tag change reaches your Taskwarrior store. Reminders, which are the app's own, are unaffected. |
| `AGENTGLASS_CLICKUP_WRITE` | — | `1` → allow **writes to a ClickUp board** (status, assignee, comments, checklists). Off by default, the opposite of the local list — a status change on a shared board fires automations and notifies people. Also a runtime toggle (`POST /clickup/writes`). See SECURITY.md. |
| `AGENTGLASS_BROWSER_READONLY` | — | `1` → when an agent drives the built-in browser (`agentglass-browser`, the MCP server), every **acting** verb — clicks, typing, `eval`, `cdp`, init scripts, uploads — is refused; reading, screenshots, the console and network logs keep working. |
| `AGENTGLASS_UNDERSTUDY` | — | `0` → force the **Clone** off whatever its settings file says. It can force off, never on: recording must not start because of a variable inherited from a shell. |
| `AGENTGLASS_PRIVATE_TERMS` | `~/.config/agentglass/private-terms.txt` | The Clone's private-terms list — one pattern per line of names that must never leave a private repository. With the app's own file absent, `~/.config/git/private-terms.txt` is honoured. Without any list the Clone refuses to learn. |
| `AGENTGLASS_STATE_DIR` | `~/.local/state/agentglass` | Where a server keeps its mutable state — the tmux socket and config, pane records, the judge's private room, and (unless `AGENTGLASS_DB` names a file) its database. A second server pointed here runs beside the real one without touching its history. |
| `AGENTGLASS_DISK_DISABLED` | — | `1` → disable the finder's **Machine** tab (`/disk/*`): searching and reading documents that are in no checkout. Bounded to your home directory with hidden paths refused — see SECURITY.md. |
| `AGENTGLASS_DISK_ROOTS` | `$HOME` | `:`-separated extra folders the **Machine** tab may search, for work that lives off your home directory (`/mnt/data/notes:/srv/docs`). Added to your home directory, never replacing it. |
| `AGENTGLASS_TMUX_OBSERVE_ONLY` | — | `1` (or `true`/`yes`/`on`) → every tmux command that would change **your** sessions becomes a no-op that logs what it would have run; reads keep working, so the whole cockpit still draws. See [docs/BLAST-RADIUS.md](BLAST-RADIUS.md). |
| `AGENTGLASS_NO_STATUS_NUDGE` | — | Read by the hook, not the server: set in a session's environment, that session is never shown the Lantern's one-line "say what you are working on" reminder. |
| `AGENTGLASS_TERMINAL_DISABLED` | — | `1` → disable the in-browser **Terminal** entirely (no PTY shells are spawned). Also settable as `"terminalDisabled": true` in `config.json`, so it is reachable from a desktop-launched app that inherits no env; the env var overrides the file when set. Moot on Windows, where the terminal is already off — the PTY backend is POSIX-only. |
| `AGENTGLASS_PANE_QUIET_MS` · `AGENTGLASS_PANE_QUIET_STOP_MS` | `600000` · `1200000` | The Clone's quiet clock: a live agent with no new output and no transcript is warned after the first, stopped after the second (10 and 20 minutes). |
| `AGENTGLASS_PANE_STALL_CHECK_MS` | `8000` | How long a prompt only a person can answer must sit on the Clone's screen before the run is ended for it. |
| `AGENTGLASS_RESTORE_SETTLE_MS` | `2000` | How long the tmux restore waits before checking what it rebuilt is still standing. |
| `AGENTGLASS_EDITOR_DISABLED` | — | `1` → refuse **open in editor**, so the app cannot hand a path to a live nvim or `$EDITOR`. |
| `AGENTGLASS_GPU` | — | `1` → opt an Electron window back into full GPU compositing. The desktop shell composites the final frame on the CPU on Linux by default, because some GPU/compositor stacks paint the window white. Unrelated to the terminal's own renderer setting. |
| `AGENTGLASS_MAX_TERMINALS` | `200` | Ceiling on concurrent PTY sessions. |
| `AGENTGLASS_AUTOFETCH_SECONDS` | `60` | How often the git panel fetches in the background. |
| `AGENTGLASS_GIT_TIMEOUT_SECONDS` | `120` | Ceiling on a single git subprocess. |
| `AGENTGLASS_FS_BROWSE_DISABLED` | — | `1` → disable directory completion in the project picker (`/fs/complete`). Separate from the terminal switch on purpose: disabling the shell should not leave the directory tree readable. |
| `AGENTGLASS_CHAT_DISABLED` | — | `1` → disable the **Chat** panel (no `claude` sessions can be started from the browser). |
| `AGENTGLASS_CLAUDE_MODELS` | — | Path to the Claude model catalogue, overriding the copy in the checkout. See **Which models the Chat panel offers**. |
| `AGENTGLASS_CODEX_DISABLED` | — | `1` → disable the **Codex** agent in the Chat panel, leaving Claude chat available. Codex is offered whenever a `codex` executable is on the server's `PATH`. |
| `AGENTGLASS_ANTIGRAVITY_DISABLED` | — | `1` → disable the **Antigravity** agent in the Chat panel, leaving the other two available. Antigravity is offered whenever an `agy` executable is on the server's `PATH`. Independent of the Gemini CLI, which is a different product and is not driven from the chat panel at all. |
| `CODEX_HOME` | `~/.codex` | Codex's own override for where it keeps its state. agentglass reads the model cache and the rollout history (resumed-thread transcripts) from there. |
| `AGENTGLASS_CHAT_BYPASS` | — | `1` → allow the Chat panel's unattended modes: `bypassPermissions` for Claude (`--dangerously-skip-permissions`), `full-access` for Codex (`--dangerously-bypass-approvals-and-sandbox`) and `always-proceed` for Antigravity (`--dangerously-skip-permissions`). Off by default; one opt-in covers all three, since it is the same decision. |
| `AGENTGLASS_CHAT_ENGINE` | `process` | `tmux` → new chats run as a live `claude` in a pane on agentglass's own tmux server instead of one `claude -p` per turn. Faster per turn (the CLI's session start is paid once, not every message) and the session is attachable from your own terminal; costs a warm CLI (~380MB, growing with use) for as long as the chat is warm. Per-chat in **Settings → Preferences → How new chats run**. |
| `AGENTGLASS_TMUX_SOCKET` | `agentglass` | Socket name for that server (`tmux -L <name>`). It is always launched with a config of our own (`-f`), never your `~/.tmux.conf` — otherwise tpm/resurrect/continuum would come with it and continuum's autosave would overwrite your own saved layout in the shared `~/.tmux/resurrect/`. |
| `AGENTGLASS_TMUX_IDLE_MINUTES` | `30` | Minutes a chat pane may sit unused before its CLI is reclaimed. The next turn resumes the session transparently (one slower turn). `0` disables eviction and keeps every warm chat resident. |
| `AGENTGLASS_COMMIT_DISABLED` | — | `1` → disable the diff viewer's **Commit…** composer. |
| `AGENTGLASS_GATE_TIMEOUT` | `60` | Seconds the `PreToolUse` gate hook waits for an approve/deny before auto-allowing. |
| `AGENTGLASS_GATE_FAILCLOSED` | — | `1` → a gate timeout (server) or an unreachable control plane (hook) **denies** the tool call instead of allowing it. Off by default (fail-open — never block agents by accident). |
| `AGENTGLASS_RATE_MAX` | `300` | Max intake requests (`/ingest`, OTLP receivers) per source-address+route within the window, before `429`. |
| `AGENTGLASS_RATE_WINDOW_MS` | `10000` | Rate-limit window in ms for the intake sinks. |
| `AGENTGLASS_CODE_DIR` | `~/code` | Where the skills explorer scans for per-project `.claude` skills/commands. |
| `AGENTGLASS_WALKTHROUGH_MODEL` | `claude-haiku-4-5` | Model for the AI **Explain** walkthrough (uses a local `claude` CLI, else `ANTHROPIC_API_KEY`). |
| `CLAUDE_CREDENTIALS` | `~/.claude/.credentials.json` | OAuth token for the Anthropic plan-usage meters (never leaves your machine except to `api.anthropic.com`). |

**Scope is a boundary, not just a filter.** With a project open, git writes, the
terminal and chat are all refused outside it — the same rule that decides what the
dashboard shows. This is a *behaviour* boundary, not cosmetic: with a project
open, opening the app on `~/code` and then jumping to `/tmp` in the terminal is
refused, and git writes outside the root are blocked — on their own, by the
scope boundary. (The `AGENTGLASS_GIT_WRITE_DISABLED`/`AGENTGLASS_TERMINAL_DISABLED`
knobs are a separate, global off-switch, not what enforces the root.)
For genuinely multi-repo work, scope to the parent folder (`~/code`) rather
than one repo: every repo beneath it is then in scope. An unscoped instance
covering every repo is unaffected.

Prefer a file over env vars? Drop a `~/.config/agentglass/config.json` (or
`$XDG_CONFIG_HOME/agentglass/config.json`) with `root`, `repoDirs`,
`terminalDisabled` and/or `chatBypass`; env vars override it. The last two
matter for a desktop-launched app, which inherits no shell environment and so
cannot be configured by `export` at all.

> **Pricing is a user-editable default.** Numbers in `pricing.ts` are per 1M
> tokens and matched against `model_name` by substring. Anthropic (Claude) rates
> are verified; other providers are marked *approx* — verify current rates and
> tune, or point `AGENTGLASS_PRICING` at your own JSON.

### Every other `AGENTGLASS_*` the code reads

The table above is the set a person is likely to want. These are the rest, so
that nothing the code reads goes unnamed. None is required.

**The driven browser and its CLIs** (`agentglass-browser`, `agentglass-browser-mcp`)

| var | default | what it does |
|---|---|---|
| `AGENTGLASS_BROWSER_ORIGINS` | `*` | Allow-list of `host` or `host:port` entries the browser may be pointed at (`localhost:8001,localhost:8002`). Unset reaches anywhere — a deliberate default, written down in `browserdrive.ts`. Read on every call. |
| `AGENTGLASS_BROWSER_PROFILES` | `*` | Allow-list of profile names an agent may use (`support,agent`). Same shape as the origins list. |
| `AGENTGLASS_BROWSER_AUDIT_LOG` | `$AGENTGLASS_STATE_DIR/browser-audit.log` | Where every browser act is appended (rotates once at 4 MiB). |
| `AGENTGLASS_PROFILE` | derived from the session | The CLI's default profile name when `--profile` is not given. |
| `AGENTGLASS_BROWSER_SHOW` | off | `1` makes every CLI verb bring the browser view to the front, the way `--show` does for one call. |
| `AGENTGLASS_BROWSER_WAIT` | `2.5` | Seconds the CLI's `tail` verbs wait for more output before returning. |
| `AGENTGLASS_BROWSER_STATE_DIR` | `$XDG_STATE_HOME/agentglass` | Where `--since-last` keeps its cursor. |

**Where things live**

| var | default | what it does |
|---|---|---|
| `AGENTGLASS_BENCH_NOTES` | `$XDG_DATA_HOME/agentglass` | The directory whose `bench-notes/` holds the bench's notes. |
| `AGENTGLASS_CACHE_DIR` | `~/.cache/agentglass` | Pull-request and repository caches. |
| `AGENTGLASS_TASK_DIR`, `AGENTGLASS_TASK_PATH` | bundled | The local task tracker binary: a directory to search, or the exact path (beats everything). |
| `AGENTGLASS_TMUX_DIR`, `AGENTGLASS_TMUX_PATH` | bundled | The engine's tmux: a directory to search, or the exact path. `tmuxPath` in Settings is the same knob. |
| `AGENTGLASS_BUN` | on `PATH` | The bun binary the Clone's runs use, when the one on `PATH` is not the one you mean. |
| `AGENTGLASS_CLAUDE_HOME` | `$CLAUDE_CONFIG_DIR` or `~/.claude` | Where the Claude Code CLI keeps its config and transcripts. |
| `AGENTGLASS_REPOS` | — | Extra repositories, `:`-separated, listed beside the ones found under the workspace. |
| `AGENTGLASS_REPO_DEPTH` | `4` | How deep the workspace is walked for repositories (1–8). |
| `AGENTGLASS_CLICKUP_BASE` | `https://api.clickup.com/api/v2` | The tracker API base, for a proxy or a test double. |
| `AGENTGLASS_CODEX_USAGE_MODEL` | — | Pins the model the Codex usage gauge prices against. |

**Timeouts and sizes** (milliseconds unless said; the defaults were measured)

| var | default |
|---|---|
| `AGENTGLASS_CHAT_STARTUP_TIMEOUT_MS`, `AGENTGLASS_CODEX_STARTUP_TIMEOUT_MS`, `AGENTGLASS_ANTIGRAVITY_STARTUP_TIMEOUT_MS` | `20000`, `20000`, `30000` — how long a chat CLI may take to show its prompt |
| `AGENTGLASS_PANE_READY_TIMEOUT_MS`, `AGENTGLASS_PANE_PASTE_TIMEOUT_MS` | `45000`, `10000` — a seated agent's pane coming up, and a paste being taken |
| `AGENTGLASS_REPO_CACHE_MS` | `15000` — how long the repository list is trusted before it is walked again |
| `AGENTGLASS_PRESSURE_WINDOW_MS`, `AGENTGLASS_LOOPWATCH_SIZE` | `10000`, `200` — the loop watcher's window and how many samples it keeps |
| `AGENTGLASS_GITLOG_SIZE` | `400` — entries the git activity ring keeps; `0` disables it |
| `AGENTGLASS_SCAN_BATCH_LINES`, `AGENTGLASS_SCAN_BATCH_BYTES`, `AGENTGLASS_SCAN_MAX_LINE_BYTES` | `500`, `1 MiB`, `16 KiB` — transcript scanning batches; the line cap protects the ingest thread from one enormous line |
| `AGENTGLASS_SPAWN_LIMIT`, `AGENTGLASS_SPAWN_GUARD_MS` | cores − 2 (max 16), `300000` — how many child processes may run at once, and how long a stuck spawn is waited on before it is written off |

**Shell integration**

| var | what it does |
|---|---|
| `AGENTGLASS_SHELL_MARKERS` | `0` or `off` disables the prompt markers the terminal uses to find command boundaries. |
| `AGENTGLASS_SHELL_INTEGRATION`, `AGENTGLASS_ZDOTDIR_ORIG` | Set by the terminal for the shells it starts; not for you to set. |

**Set by the app for its own children** — read by hooks, the CLIs or a spawned server, never meant for a person's shell: `AGENTGLASS_INTERNAL` (a hook talking to its own server), `AGENTGLASS_ROLE` (the session's role, `lantern` for the observer), `AGENTGLASS_AGENT_NAME` (a named agent's name in its pane), `AGENTGLASS_PTY_SIZE_FILE` (the terminal's size handshake), `AGENTGLASS_UPDATE_SRC` / `_LOG` / `_ORIGIN` / `_STAMP` / `_TAG` (the self-updater's hand-off to the installer), `AGENTGLASS_DEBUG_PORT` (the desktop shell's own remote-debugging switch; exists only when set, never read off argv). The installer's `--postinstall` hooks honour `AGENTGLASS_NO_HOOKS=1`, `AGENTGLASS_NO_OPENCODE=1` and `AGENTGLASS_NO_OTEL=1` to skip wiring the Claude Code hooks, the OpenCode plugin and the OTLP exporter respectively.

---

## API

Every route is behind the token and the origin/Host gates described in [Security model](#security-model); the exceptions are named on their row. **Gated** means refused by the named switch; a write outside the open project is refused by scope. Families are grouped by prefix; `{a,b}` lists the verbs under one.

| Route | Description |
|---|---|
| `POST /ingest` | Ingest one hook event `{source_app, session_id, hook_event_type, event_id?, reported_cost_usd?, payload?, …}`. `event_id` makes retries idempotent. Token-exempt on loopback; rate-limited. |
| `POST /v1/traces` · `/v1/logs` (also under `/otlp`) | OTLP/HTTP receivers, JSON or protobuf: `gen_ai.*` spans and GenAI log records become events. `/v1/metrics` answers 501 — there is no metrics receiver. |
| `GET /events/recent?limit=` · `/events/filter-options` | Latest events; distinct apps, event types and models. |
| `GET /projects` · `POST /projects/{clone,new,hidden}` | Known projects in scope plus the current workspace; clone a URL into a folder, create a project, hide one from the picker. |
| `POST /workspace` | Scope the cockpit to a project or folder at runtime (`{root}`; `null` = whole machine). Persisted; what the project picker calls. |
| `GET /sessions?limit=` · `/session?id=` · `/agent/sessions?root=` | Session rollups; one session in full; resumable agent sessions for a repo, joined with the live panes. |
| `GET /stats?window=` · `/insights` · `/search?q=` | The analytics summary; derived warnings (loops, fast burn, failure rate); full-text search over prompts, commands and outputs. |
| `GET /usage` · `/usage/daily?days=` · `/usage/providers` · `POST /usage/codex/refresh` | Plan-limit windows; daily totals across the retention seam (rollup + live events); every provider's quota; a Codex quota refresh (spends a little quota, so opt-in). |
| `POST /statusline` | A live Claude Code session hands over its plan-limit windows. Authenticated like any route, not an intake sink. |
| `GET /skills` | Skills and commands scanned from `~/.claude` and `$AGENTGLASS_CODE_DIR/*/.claude`, joined with recorded usage. |
| `GET /changes?limit=` · `POST /walkthrough` | Recent Edit/Write diff hunks for the Diff view; the AI **Explain** walkthrough of a set of diffs (the one route that sends code to a model). |
| `GET /git/{tree,repos,branches,log,graph,worktrees,stashes,refs,tags,reflog,blame,file-diff,commit-diff,grep,pickaxe,stats,…}` · `POST /git/status` | Reads of a working tree and its history. `/repos` honours the scope; `?all=1` lists the machine. |
| `POST /git/{stage,unstage,discard,commit*,amend,push,pull,fetch,checkout,branch-*,stash-*,tag-*,apply-hunk,merge,rebase*,cherry-pick*,revert,squash,reset,snapshot-*,submodule-*,bisect-*,worktree-*}` | Mutating git — **gated** by `AGENTGLASS_GIT_WRITE_DISABLED`, recorded. `worktree-chown` is the one route that elevates (visible prompt, `chown` only). |
| `GET /git/{conflicts,conflict-blocks,merge-session,base-candidates,…}` · `POST /git/{resolve,resolve-blocks,sync-base,merge-abort,merge-continue,undo-merge,…}` | Mid-merge state; take a side per file or block; sync a branch from its base; undo the last merge while that is exactly reversible. Write-gated. |
| `GET /docker/{capability,overview,stats,logs,logs/stream,inspect,top,disk,volume,volume/peek,env-diff}` | Containers, images, volumes, networks; stats, logs, config, processes; a peek inside a volume (`busybox`/`alpine` only); two containers' env compared with secrets masked. |
| `POST /docker/{start,stop,restart,rm,images/rm,prune/cache}` | Container actions and disk reclaim — **gated** by `AGENTGLASS_DOCKER_WRITE_DISABLED`. |
| `GET /update/{status,log}` · `POST /update/run` | The running version, the newest release tag, and building it. **Desktop-shell origin only** — the one route that executes arbitrary code. |
| `WS /terminal/pty?root=&cols=&rows=` · `GET /terminal/commands?root=` | A real PTY shell in a checkout; Makefile targets and `package.json` scripts by folder. Off on Windows, by `terminalDisabled`, or by `AGENTGLASS_TERMINAL_DISABLED` — `commands` says which. |
| `GET /terminal/{panes,pane-dirs,agents,tab-hints,tmux-status,tmux/windows}` · `POST /terminal/{panes/focus,agent,dictate,image,tmux-conf,tmux-settings,tmux-reset,tmux-restore,tmux/windows}` | The engine's panes, agent kinds, tmux health; focus a pane, mint an agent ticket (cwd in scope, `yolo` only if Settings allow), dictate, stash an image (≤ 8 MB), write/reset tmux config, restore the layout, window ops. |
| `GET /chat/{enabled,attach,panes,active}` · `POST /chat/{send,pane/close,pane/pin,pane/key}` | Drive a local `claude` session (streamed JSONL) — **gated** by `AGENTGLASS_CHAT_DISABLED`. `send` takes `engine` (`process` \| `tmux`); `pane/key` sends one allowed key into a prompt. |
| `GET /codex/{enabled,transcript?id=}` · `POST /codex/send` | The same for a local `codex` (`codex exec --json`, `resume` for follow-ups) — **gated** by `AGENTGLASS_CODEX_DISABLED`. The transcript is read from `$CODEX_HOME/sessions`. |
| `GET /antigravity/enabled` · `POST /antigravity/send` | The same for a local `agy` (`--conversation` for follow-ups) — **gated** by `AGENTGLASS_ANTIGRAVITY_DISABLED`. Its turns are also turned into events, since it reports to nothing else. |
| `GET /prs/{capability,list,detail,diff,commit-diff,inbox,rollup,counts,for-branch,behind,spend,codeowners,check-jobs,job-log,conflict-files,…}` | Pull requests through `gh`, per repository: the list for a tab, one PR in full, diffs, the inbox, check rollups, job logs, a conflict preview. Cached. |
| `POST /prs/{review,review-with,line-comment,apply-suggestion,comment*,reply,thread-resolved,react,edit,labels,assignees,milestone,reviewers,draft,update-branch,rerun*,merge,close,inbox/act,conflict,…}` | Pull-request actions — **gated** by `AGENTGLASS_GIT_WRITE_DISABLED` and the scope, recorded. `conflict` cuts a worktree and merges the PR into it locally. |
| `POST /prs/review-prompt` · `POST /prs/nudge` | The prompt to review a PR with Claude and where to run it (a read; scope still applies). The chase for a PR waiting on somebody — `{root, number, send}` returns the text; `send: true` also posts it down `AGENTGLASS_WEBHOOK`. |
| `GET /pr-prompts` · `POST /pr-prompts/{save,remove,reset}` · `GET /saved-replies` · `POST /saved-replies/{save,remove}` | The **Review with Claude** prompt catalogue (a `reset` restores a built-in), and reusable review sentences. Config files of your own edits; no database. |
| `GET /issues/{list,detail,work}` · `POST /issues/{start,finish,claim,comment,state}` | GitHub issues through `gh`; which ones this machine holds a worktree for. Start one as a worktree / branch / Claude window, finish, claim, comment, open or close — **gated** like PR writes. |
| `GET /tasks/{list,provider,reminders}` · `POST /tasks/write/{add,bulk,delete,done,edit,note,priority,reopen,tags}` · `POST /tasks/{remind,reminder/*}` | Your Taskwarrior list (writes carry a fingerprint precondition → 409; off under `AGENTGLASS_TASK_WRITE_DISABLED`) and the app's own reminders. |
| `GET /clickup/{views,spaces,folders,list-views,view,list,task,prs,find,where,members,sprints,search,search/stream,warm,file,…}` | ClickUp boards, lists, saved views and cards, read with the token from Settings → Integrations. `file` proxies an attachment from ClickUp's hosts only. |
| `POST /clickup/{card,create,move,status,priority,assign,tag,field*,task,comment*,checklist*,views/*,folders/*,writes}` | Changing a card on a shared board — **off unless `AGENTGLASS_CLICKUP_WRITE=1`** (or the `writes` toggle); each write re-reads the card and refuses if it moved. |
| `GET /providers` · `/providers/workspaces?id=` · `POST /providers/{connect,disconnect,workspace}` | Integration status and workspaces. `connect` is the only route that receives a service token, and no route returns one. |
| `GET /files/{tree,find,grep,read,measure,temp,refs,exist}` | A checkout's tree one level at a time, filename and content search, one file at a ref, a ref's copy in a temp file for the editor. Scoped to the fleet's repos; the whole prefix is 403 under `AGENTGLASS_FS_BROWSE_DISABLED`. |
| `GET /disk/{places,find,grep}` · `GET /browse?path=` · `GET /fs/complete?prefix=` | The finder's **Machine** tab — under your home, nothing hidden, symlinks resolved first; one listing across project and machine; path completion. Off under `AGENTGLASS_FS_BROWSE_DISABLED`; `/disk` also under `AGENTGLASS_DISK_DISABLED`. |
| `GET /preview/{facts,raw}?path=` · `POST /preview/open` | File metadata, raw bytes (own CSP, `nosniff`, `no-store`), and hand the file to the desktop opener. The real, symlink-resolved path is what is judged and read. |
| `GET /editor/{capability,target,where}` · `POST /editor/open` | Which editor would open a path, the cursor in an nvim this server started, and opening a file at a line — **gated** by `AGENTGLASS_EDITOR_DISABLED`. |
| `GET /machine/{ports,resources,space,locks,process?pid=}` · `POST /machine/{kill,unlock,env}` | What is listening and who started it; load with the fleet's processes broken out; stale `index.lock` files; one process with secrets masked. `kill`/`unlock` recorded; `env` reveals one masked value, **desktop-origin only**. |
| `GET /runs?root=` · `/run/activity?id=` | Multi-checkout runs, including legs this app did not start, and each leg's activity by directory. |
| `GET /recipes?root=` · `/recipes/render` · `POST /recipes/{save,remove}` | Saved command lines and what a recipe *would* run. Nothing here executes anything. |
| `GET /hooks/status` · `POST /hooks/{install,uninstall}` · `POST /agents/connect` | Whether the Claude Code hooks are wired into `~/.claude/settings.json`, and wiring or removing them; connect one agent from the roster (hooks or OTel, with a scrubbed env). What **Settings ▸ Hooks** calls. |
| `GET /dependencies?force=1` · `GET /browser-use/status` · `POST /browser-use/install` | Every outside tool probed for the Requirements pane; whether an agent could drive the built-in browser and what is missing; install that skill. |
| `GET /agents/board` | The **Lantern**: every hooked session — name, worktree, branch, whether it is **stopped on you** and why, what it said it is on, `facts` and `git` for the cards, and `watch`. Read-only; the Lantern's own chat is `role: "lantern"` and never "needs you". |
| `POST /agents/status` | A session saying what it is on — `{name, doing, worktree?, branch?, left?, session?}`; `{name, done: true}` clears it, from the same session only. Fields capped (512 / 4096). Tokenless on loopback: a hook carries it. |
| `GET` · `POST /lantern/settings` · `POST /lantern/ticket` | The status reminder (`{nudge, minutes}`) and the server-side **watch** (`{watch, watchMinutes}`) that notifies when somebody is still stopped on you; a ticket opening a chat with the board as its first message. |
| `GET /agents/named` · `POST /agents/named/{start,prompt,wait,read,keys,stop}` | **Named agents** — seat a CLI by name in a checkout (`--yolo` only if Settings allow; permission-shaped args refused with a 400 naming the flag), prompt it, wait for a state, read its screen, press a key, kill it. `agentglass-agent` is the CLI in front (`send-keys` → `keys`). |
| `GET` · `POST /agents/schedule` · `POST /agents/schedule/cancel` | **Scheduled starts** — `{name, cwd, when, prompt?, yolo?, kind?}`, `when` as `08:00`, `2026-09-06 08:00` or `+30m`. The named-agent rules are checked when written and again when it fires. The machine must be awake. |
| `POST /agents/handoff` · `GET /agents/working` | Hand a session's conversation to another agent as a brief (`{session, kind}`), seated on the floating bench; whether anything is working — what the desktop's `agent` power mode polls. |
| `GET /bench/{note,live}?root=` · `POST /bench/{note,edit,end}` | The floating bench: a per-checkout note (empty text deletes it), which slots still run, open a file in the checkout's editor, end one slot's tmux session (`{root, slot}`). |
| `GET /understudy/{sources,shift,standing,scorecard,help,ask,work/next,work/ask,work/watch}` | The **Clone**: what it may learn from and its consent state, the running shift and caps, the header counts, the agreement scorecard, open questions, the queue and what is in flight. |
| `POST /understudy/{enable,mode,judge,halt,open-project,allow,never,recommend,propose-scope,learn,source/*,shift/start,shift/stop,help/answered}` | Turn it on (**desktop-origin only**, token required), set a mode, toggle the judge, halt, choose sources, open and close a shift. `learn` alone opens files and refuses without a private-terms list. |
| `POST /understudy/work/{ask,unask,run,loop,discard}` | Queue a task or take it back; cut a worktree and seat an agent (needs a running shift with actions left, a repo in the open project); chain runs; delete a worktree the runs table recorded, once its run has finished. |
| `GET /plugins` · `/plugins/catalogue?url=` · `/plugins/catalogues` · `POST /plugins/{install,install-from-catalogue,update,enable,disable,remove,master,catalogues/*}` | Installed plugins and the master switch; browse a catalogue (`https://` only); install, update, enable, disable, remove. Nothing runs at install; writes need `full`. See [docs/PLUGINS.md](PLUGINS.md). |
| `POST /browser/<verb>` · `GET /browser/{audit,places,places/all}` · `POST /browser/{places,places/forget,visit}` | The relay the browser CLIs drive the built-in browser through (acting verbs off under `AGENTGLASS_BROWSER_READONLY=1`); an audit of every op, secrets redacted; imported history, and forgetting it. |
| `GET /pair/state` · `POST /pair/{ticket,cancel,accept,reject,forget}` · `GET /pair/{info,collect,whoami}` · `POST /pair/claim` | Pairing a phone. The desk's half (invite, accept at a scope, revoke) is **at-machine only**; the phone's half is credential-free by design. See SECURITY.md, *Pairing a device*. |
| `GET /remote/status` · `POST /remote/device` | How this server is exposed (bind, port, trust-LAN, token set); block or unblock one address and close its sockets (loopback-only). |
| `GET /theme/{current,status}` · `POST /theme/sync` | The palette a paired phone should wear, and pushing the cockpit's colours out to tmux and nvim. |
| `GET /notifications` (WS) · `/notifications/capability` · `POST /notifications/open` | Mirroring the desktop's own notifications into the app; the monitor runs only while a socket is open. |
| `GET /budgets` · `POST /budgets/set` | Spend budgets with current spend; the write is **gated** by `AGENTGLASS_BUDGET_WRITE_DISABLED`. |
| `POST /scratch/image` · `GET /notify/reach` · `GET /privacy` · `GET /api/loopwatch?since=` | Save a screenshot to a temp file an agent can read; whether alerts can reach a webhook; where the app keeps things (paths only); every moment the process stopped answering. |
| `GET /health` | Liveness plus `service: "agentglass"`, so a client can tell this server from a stranger on the port. Token-exempt. |
| `POST /gate` · `GET /gate/{pending,status?id=,history}` · `POST /gate/decide` | The `PreToolUse` gate: hold a call, read the queue, long-poll a decision, the history; answer one. `decide` needs a paired device with `answer` or a vouched origin — a plugin or machine token alone cannot. |
| `GET /actions?limit=&before=` | Every write the cockpit performed — git, docker, pull requests, gate decisions — with the address it came from. Append-only; unscoped on purpose. |
| `POST /control` | Drive the dashboard's own UI (view, theme, zoom, new chat) from outside. Validated, rebroadcast on `/stream`; grants nothing the keyboard lacks. See [`docs/EXTENDING.md`](EXTENDING.md). |
| `GET /export?format=csv\|json` · `?kind=daily` | Download all events (bounded by retention), or the daily totals with the rollup included. |
| `WS /stream` | Live frames — `initial` · `openTools` · `event` · `session` · `git` · `ci` · `alert` · `control`. Read-only: the socket never accepts commands. |

### The CLIs in front of the API

Three command-line tools live in `bin/` and are symlinked into `~/.local/bin` by
the Linux installer; on macOS the `.dmg` carries them at
`agentglass.app/Contents/Resources/bin/`, which the app puts on the PATH of every
agent it seats — add it to your own shell's PATH (or `ln -s` them into
`~/.local/bin`) to call them by hand. Each reads `AGENTGLASS_SERVER` (default
`http://localhost:4000`) and `AGENTGLASS_TOKEN`, and refuses to send the token
over plain `http://` to any host that is not this machine.

- **`agentglass-agent`** — named agents from a shell, one JSON object per answer:
  `start` (seat a CLI by name in a checkout), `prompt` (hand it a message and press
  Enter until it is taken), `wait` (block until `ready` / `working` / `needs-you` /
  `gone`), `read` (its screen), `send-keys` (one named key: `enter`, `escape`,
  arrows, `tab`, `space`, `backspace`, `ctrl-c`), `list`, `stop`; and on a clock,
  `schedule`, `schedules`, `unschedule`; plus `health`. `--yolo` is granted only if
  Settings allow it, and a permission-shaped flag after `--` is refused.
  `python3 bin/agentglass-agent --help` is the reference.
- **`agentglass-browser`** — the built-in browser as a shell command: open, read,
  click, type, screenshot, network log, cookies, profiles, and more, through the
  server's relay rather than a debugging port.
- **`agentglass-browser-mcp`** — the same browser as an MCP server over stdio
  (`claude mcp add agentglass-browser -- agentglass-browser-mcp`). Most tools
  observe; four **act** on the page — `browser_eval` runs JavaScript in it,
  `browser_addInitScript` installs JavaScript that runs before every page,
  `browser_expose` gives the page a function that calls back into the agent, and
  `browser_cdp` sends raw DevTools Protocol commands to the page's session — and
  every acting tool is refused under `AGENTGLASS_BROWSER_READONLY=1`. It does not
  offer `ignoreCertErrors`.

---

## Architecture

```
 Claude Code hooks ───────────▶ hooks/send_event.py ──┐
 OpenTelemetry (any provider) ─▶ /v1/traces, /v1/logs ┤
 ~/.claude/projects (every session) ─▶ scan + tail ───┤──▶  server (Bun)
                                                       │      ├─ ingest.ts       normalize + token/cost delta
                                                       │      ├─ transcripts.ts  machine-wide scan + live tail
                                                       │      ├─ otlp.ts         map gen_ai.* spans/logs → events
                                                       │      ├─ config.ts       project scoping (root / repoDirs)
                                                       │      ├─ db.ts           SQLite: events + sessions, latency pairing
                                                       │      ├─ pricing.ts      model → USD (any provider)
                                                       │      ├─ alerts.ts       webhook / desktop / attached clients
                                                       │      ├─ gitwork.ts      live working tree (lazygit)
                                                       │      ├─ docker.ts       live containers (lazydocker)
                                                       │      ├─ terminal.ts     real PTY shells over WS (+ make/script catalog)
                                                       │      ├─ chat.ts         drive local `claude` sessions (stream-json)
                                                       │      ├─ issues.ts       GitHub issues via gh, start one as a worktree
                                                       │      ├─ files.ts        checkout tree, filename & content search
                                                       │      ├─ machine.ts       listening ports, CPU/mem/disk, per-repo space
                                                       │      ├─ gate.ts         approve/deny control plane
                                                       │      ├─ walkthrough.ts  local-Claude "Explain" of a diff set
                                                       │      ├─ lantern*.ts     the board of every agent, and the watch
                                                       │      ├─ agentops.ts     named agents + agentschedule.ts (starts on a clock)
                                                       │      ├─ understudy-*.ts the Clone: queue, shifts, worktrees, env fence, judge
                                                       │      ├─ plugins.ts      install / review / enable, a scoped token per plugin
                                                       │      ├─ browserdrive.ts the relay the browser CLIs drive the built-in browser through
                                                       │      └─ WS /stream ─┐
                                                       │                      ▼
              web (React + Vite + Motion + Recharts + Shiki + xterm.js, :6180)
              └─ also packaged as an Electron desktop app with a bundled Bun sidecar
```

**How cost stays correct:** transcripts report *cumulative* session tokens.
On ingest the server diffs each cumulative report against the session's prior
total, storing a per-event **delta** — so timeline sums and session totals agree
and nothing is double-counted. Hook events and the scanner dedupe against each
other by session, so the same turn is never counted twice.
