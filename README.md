<div align="center">

<img src=".github/assets/logo.svg" alt="agentglass" width="88" height="88" />

# agentglass

**agentglass doesn't replace your agents. It attaches to the tmux sessions and repos already open on your machine, and puts every tool call, dollar and dangerous command on one screen — at your desk or in your pocket.**

[![▶ Live demo](https://img.shields.io/badge/▶%20Live%20demo-try%20it%20now-6366f1?style=for-the-badge)](https://sirallap.github.io/agentglass/demo/)

<a href="https://trendshift.io/repositories/86777?utm_source=trendshift-badge&amp;utm_medium=badge&amp;utm_campaign=badge-trendshift-86777" target="_blank" rel="noopener noreferrer"><img src="https://trendshift.io/api/badge/trendshift/repositories/86777/daily?language=TypeScript" alt="SirAllap%2Fagentglass | Trendshift" width="250" height="55"/></a>

![stack](https://img.shields.io/badge/server-Bun%20%2B%20SQLite-black) ![ui](https://img.shields.io/badge/ui-React%20%2B%20Vite%20%2B%20Motion%20%2B%20Shiki-61dafb) ![desktop](https://img.shields.io/badge/desktop-Electron%20app-47848f) ![phone](https://img.shields.io/badge/phone-signed%20Android%20APK-3ddc84) ![themes](https://img.shields.io/badge/themes-22-a78bfa) ![license](https://img.shields.io/badge/license-MIT-green)

![agentglass in action — the live cockpit, then the workspace: source control, diff review, pull requests, tasks, Docker, chat and a file browser, one keystroke away](.github/assets/hero.gif)

</div>

## Install

A desktop app with its own server inside it: nothing to run in a terminal, no
port to open in a browser. Take the build for your platform from
[**Releases**](https://github.com/SirAllap/agentglass/releases/latest) and
launch it.

| Linux | macOS | Windows | Android |
| --- | --- | --- | --- |
| `.AppImage` (chmod +x, run it) or `.deb` | `.dmg`, Apple Silicon and Intel | `.exe` — but the terminal, the tmux tabs and the updater are off there, by design: they need a POSIX pty | `agentglass-<tag>.apk` — signed, built by CI, on the same page |

Each platform's build is a separate CI job, so check the release page for the
one you want rather than assuming the newest tag carries all four.

That alone already shows you every Claude Code session on the machine: a
transcript scanner reads `~/.claude/projects` on open, with nothing wired at
all. Live streaming and the gate that can hold a tool call want the hooks, and
**Settings ▸ Hooks** wires them into `~/.claude/settings.json` and takes them
out again — the forwarder ships inside the bundle, so there is nothing to clone.

From a checkout instead ([Bun](https://bun.sh) ≥ 1.1 and Python 3):

```bash
bun install
bun run dev          # server :4000  +  UI :6180
```

> Want to look before installing? The [**live demo**](https://sirallap.github.io/agentglass/demo/)
> is this exact UI, built from the same source on every push, running on
> fabricated data.

### Running from source

For hacking on agentglass, or for a headless box. Requires
[Bun](https://bun.sh) ≥ 1.1 and Python 3 (the hook forwarder and the terminal's
pseudo-terminal both run under it). Everything else agentglass shells out to is
listed under [Requirements](#requirements-what-agentglass-expects-to-find), and
checked for you in Settings ▸ Requirements.

```bash
bun install
bun run dev          # server :4000  +  UI :6180  (vite dev server)
make desktop         # or: build the UI and launch the real shell
```

`bun run dev` gives you the same UI in a browser tab at
**http://localhost:6180**, minus what only the shell can do (fullscreen, zoom,
launch-at-login, and the self-update route, which refuses a browser by design).
It is the development path, not the way to run the app. If something else on
your machine already owns `:4000`, the tab will talk to *that* server, so check
the port before believing an empty dashboard.

**Running a second server alongside the installed app** — a test instance, a
worktree you want to poke at — needs `AGENTGLASS_DB`, and this is the one that
bites. Isolating `XDG_CONFIG_HOME` is not enough: the *database* is found via
`XDG_DATA_HOME`, and a checkout with no `agentglass.db` of its own resolves to
the installed app's real history. A second server there would run a second
transcript scanner over it, and two scanners over one file inflate events,
tokens and cost — the scanner's rows carry no `event_id`, so the idempotency
index cannot dedupe them, nothing errors, and the totals simply grow. The claim
at boot now stops that scanner from starting, which keeps the numbers honest but
also means your test instance sees no live sessions. Give it its own file:

```bash
S=$(mktemp -d)
env AGENTGLASS_DB=$S/agentglass.db \
    XDG_DATA_HOME=$S/data XDG_CONFIG_HOME=$S/cfg \
    AGENTGLASS_PORT=4713 \
    bun run server/src/index.ts
```

(`GH_CONFIG_DIR=$HOME/.config/gh` too, if you want the PR panel to work — `gh`
reads its login through `XDG_CONFIG_HOME`, and isolating that logs it out.)

**Single-port deploys** (a headless box, a systemd unit): build the UI once and
the server serves it itself, one process, one port, API and dashboard on the
same origin:

```bash
bun run build                         # web/dist
cd server && bun run src/index.ts     # dashboard AND API on :4000
```

When `web/dist` doesn't exist (plain `bun run dev`, or the packaged app's
bundled server), nothing is served over HTTP: the server is API-only and no
dashboard is reachable on that port at all.

Prefer `make`? Every entry point is a described Makefile target, and `make help`
lists them all (`make dev`, `make setup`, `make demo-feed`, `make desktop`, …).
The in-app terminal (`t` → **⚙ commands**) surfaces the same list, ready to
click-run.

### Wire the hooks globally — one command, opt-in

`bun run setup` appends the agentglass forwarder to your **global**
`~/.claude/settings.json`, so **every** Claude Code session — in any project —
starts streaming to the dashboard. No hand-copying, no per-project setup.
(It's deliberately **not** run automatically on `bun install`: touching
`~/.claude` is a decision, so `postinstall` only prints a reminder.) Safe to
re-run:

- **Idempotent & non-destructive** — your existing hooks are preserved; re-running
  only re-points agentglass's own entries (e.g. after moving the clone).
- **Backed up** — the settings file is copied to `*.bak.agentglass.<timestamp>`
  before any change.
- **Auto-labeled** — `--source-app` is omitted so each session shows up under its
  own project's folder name in the dashboard.
- **Takes effect on the next session** — Claude Code loads hooks at startup, so
  open a new session after wiring.

```bash
bun run setup            # wire the global hooks (also: make setup)
bun run setup:undo       # remove the agentglass hooks again
```

> Even without any hooks, the built-in **transcript scanner** already surfaces
> every Claude Code session on the machine — the hooks add live `PreToolUse`
> gating and lower-latency streaming on top.

Prefer to scope it to one project instead of globally? Point the installer at a
project directory (writes `<project>/.claude/settings.json`):

```bash
python3 hooks/install_hooks.py --project ~/code/my-project
```

Both use a dependency-free Python forwarder that POSTs to the server; `Stop` /
`SubagentStop` / `SessionEnd` pass `--add-chat` so token usage can be read from
the transcript. The raw hook blocks also live in
[`hooks/settings.example.json`](hooks/settings.example.json) for manual setups.

---

## Requirements: what agentglass expects to find

agentglass drives the tools you already have rather than bundling its own. The
app itself is self-contained (the server ships inside it), so this list is about
**what each feature shells out to**, and what stands down when it isn't there.

**The app checks all of it for you: Settings ▸ Requirements** shows every tool,
whether this machine has it, what stops working without it, and a link to the
project's own install page. Nothing there installs anything, and the guidance is
deliberately generic: there is one macOS, one Windows and an unbounded number of
Linux distributions, so how you install software is yours to know.

**Needed**

| Tool | Why | Without it |
| --- | --- | --- |
| [git](https://git-scm.com/downloads) | Source control, file changes, pull requests, worktrees; the terminal uses it to decide where to open | Those panels stay empty and the terminal cannot open in a repo |
| [Claude Code CLI](https://docs.claude.com/en/docs/claude-code/setup) | The chat panel runs `claude`: every turn, the pane engine, Review with Claude, the walkthrough | No chatting from the app. Sessions still appear: the transcript scanner reads `~/.claude/projects` regardless |
| [Python 3](https://www.python.org/downloads/) | Runs the hook forwarder, and backs the terminal's pseudo-terminal | Hooks stay wired and fail on every event, so nothing streams live and nothing says why. The terminal still opens, in a mode where full-screen programs do not render. Windows hooks use `py` or `python` |

**Per feature**

| Tool | Gives you | Without it |
| --- | --- | --- |
| [tmux](https://github.com/tmux/tmux/wiki/Installing) | Chats as live panes you can attach to, your tmux windows as tabs, theme sync | Chats run one process per turn instead: slower to start, nothing left running |
| [GitHub CLI](https://cli.github.com) | The whole pull-requests panel | No PRs. It also has to be logged in (`gh auth login`), which is the step people miss |
| [Docker](https://docs.docker.com/get-started/get-docker/) | Containers, images, volumes, logs | No docker panel. The daemon has to be running, not just the CLI installed |
| [Neovim](https://neovim.io) | Sending a file to a live editor, theme sync | The app hands you a command to paste instead |
| setsid, script ([util-linux](https://github.com/util-linux/util-linux)) | Process groups per shell, and the fallback pseudo-terminal | A closed terminal can leave background processes behind |
| [D-Bus tools](https://www.freedesktop.org/wiki/Software/dbus/), [libnotify](https://gitlab.gnome.org/GNOME/libnotify), [xdg-utils](https://www.freedesktop.org/wiki/Software/xdg-utils/) | Mirroring desktop notifications into the app, alerts when no window is open, opening their links (Linux) | Those notifications simply do not appear |
| [polkit](https://gitlab.freedesktop.org/polkit/polkit) | Handing a worktree back to you when a container left root-owned files in it | That one repair button fails |

**Two more that are not binaries**

- **Linux `.AppImage`**: needs FUSE, which some distributions no longer install
  by default. The `.deb` has no such requirement.
- **Self-update** ("Install & restart" in Settings ▸ About) builds the new
  version on your machine, so it wants `git`, [Bun](https://bun.sh) and a
  working build toolchain. It is opt-in and never automatic.

**On Windows**, the terminal, tmux chat panes, the notification mirror and
self-update are off by design rather than broken: they need a POSIX
pseudo-terminal, a Unix shell and a D-Bus session respectively. Everything else,
including the transcript scanner and the git and PR panels, works.

---

## Desktop app

agentglass ships as a **desktop app** — its own window and icon, plus a
**self-contained server** (the Bun backend compiled to a standalone binary and
shipped as an [Electron](https://electronjs.org) sidecar), so there's nothing to
run in a terminal. Launch it from your app menu and the cockpit opens; close it
and the server goes with it. The UI is the same web app, run in Chromium so it
composites on the GPU.

Installers for every release are published on
[**Releases**](https://github.com/SirAllap/agentglass/releases/latest):
`.AppImage` and `.deb` for Linux, `.dmg` for macOS (Apple Silicon and Intel).
That is the way to install it.

**Power.** The desktop app can keep the machine awake while agents work. A button
in the header cycles three modes — **On** (awake continuously), **Agent** (awake
only while something is working, polled from `GET /agents/working` every 20
seconds) and **Off** (normal system sleep) — and the choice is saved to
`~/.config/agentglass/power.json`. The default is **Agent**, the one mode that
costs nothing when nothing is working. "Working" is judged from live state, not
from what an agent last said: a chat pane mid-turn, a Clone run still running
(staled out after two hours, so a run killed mid-task cannot hold the lid), a
hook that fired in the last ten minutes from any session on the machine — the
ones in your own terminals included — or a named agent whose pane still exists.
On Linux the hold is `systemd-inhibit` (sleep and the lid switch) plus Electron's
display blocker; on macOS it is the display blocker plus an app-suspension
assertion.

### macOS: "agentglass is damaged and can't be opened"

On Apple Silicon, macOS may refuse to launch the app with a misleading
**"agentglass.app is damaged and can't be opened"** message. The download is
**not** actually damaged. The `.dmg` is not yet code-signed and notarized with
an Apple Developer ID, so Gatekeeper blocks the quarantined app your browser
downloaded and shows that wording instead of the softer "unidentified developer"
prompt. Clear the quarantine flag with the built-in `xattr` tool, then open it
normally:

```bash
xattr -dr com.apple.quarantine /Applications/agentglass.app
```

Right-click → Open does **not** clear this specific "damaged" variant on Apple
Silicon; only the command above does. Signing and notarization are on the
roadmap (they can run in CI on a macOS runner, so no Mac hardware is needed).
For background, see Apple's [Safely open apps on your
Mac](https://support.apple.com/en-us/102445).

Building it yourself, from a clone:

```bash
make desktop            # build the UI and launch Electron + the sidecar
make desktop-dist       # package installable binaries (electron-builder)
make desktop-install    # install for this user (no root)
```

Then launch **agentglass** from your desktop menu, or `agentglass` from a shell.

The packaged app's bundled server serves the API and nothing else: the UI is
loaded from the shell's own `agentglass://` origin, which a browser cannot
reach, so an install never exposes a dashboard on a port.

- **Attaches, never duplicates** — if a server is already listening on `:4000`
  (e.g. a `bun run dev` you left running), the app attaches to it instead of
  racing a second one against the same database. Note the trigger: it is the
  **port**, so a second server started deliberately on another port sails past
  this check. What stops *that* one is the database claim below.
- **One scanner per database file** — the server claims its database at boot
  (pid and port, in the file itself), and a second process that finds a live
  claim runs with the transcript scanner **off**: it serves, it ingests hooks,
  it just does not sweep. Two scanners over one file double events, tokens and
  cost in silence — scanner rows carry no `event_id`, so the ingest idempotency
  index cannot dedupe them. A claim left behind by a killed process is taken
  over, not honoured. Give a second instance its own `AGENTGLASS_DB` and both
  scan.
- **Clean lifecycle** — the bundled server is a child process, killed when the
  app exits. If the app dies hard, the server's own watchdog notices it was
  orphaned (`AGENTGLASS_DIE_WITH_PARENT`, armed by the shell) and exits rather
  than lingering on the port.
- **Launch at login** — an in-app toggle, no file editing.
- **Keeps eight days of raw events** — the same `AGENTGLASS_RETENTION_DAYS`
  default as every other way of running it; the packaged app sets nothing. The
  boot log and Settings ▸ Budgets both state the window in force. Spend history
  outlives the rows via the daily rollup, which has no expiry — but the raw
  prompts and command lines behind it do not. Set
  `AGENTGLASS_RETENTION_DAYS=0` if you want them kept for ever.

A desktop app launched from its icon has no "current folder" — so on first
open the cockpit **asks which folder it's about**: pick a project, a folder of
projects, or the whole machine, and switch any time from the **⌂ header**. The
choice persists across launches. Prefer to decide at launch time? Pass the
directory instead:

```bash
make desktop-open DIR=~/code/my-project   # or: agentglass ~/code/my-project
```

> Works on **Linux** and **macOS**.

---

## Updating

**Settings ▸ About** shows the version you are running, the commit it was built from, and whether a newer **release** is published. One click builds it and restarts.

**The in-app updater is POSIX-only.** It rebuilds from source, so it needs `git` and `bun` on the machine, and on **Windows** it is switched off rather than shelling out to a `bash` that may not exist — About still reports the version and the newest published tag, but updating means downloading the installer again. When the machine is offline the pane says it could not reach the release feed, instead of claiming you are up to date.

![settings — preferences, shortcuts, and the About pane that offers a newer release](.github/assets/settings.png)

It tracks **tags**, never a branch tip. A tip is wherever development happened to stop — half a feature, a debugging commit — and tagging is the act of saying *this one is tested*. So nothing pushed after the last tag reaches an installed app until you tag it:

```bash
git tag v0.3.0 && git push --tags     # now every install is offered it
```

The build happens in agentglass's **own clone** under `~/.cache/agentglass/source`, never in your checkout — so a convenience button can never move your `HEAD` or touch work in progress. It works out what it already has from `git describe` rather than a version field, so a `package.json` nobody remembered to bump cannot make an older tag look like an upgrade.

The route that runs it is the strictest in the server: reachable from the desktop shell's own origin and nothing else — not from a browser, not from another machine on your network. It is the one endpoint that executes arbitrary code, so the ordinary "local network is fine" rule is not enough for it.

> Updating this way compiles on your machine, which is only reasonable because your machine already has the toolchain. It is not a substitute for a signed release feed, and it is deliberately not automatic — nothing is downloaded or run until you press the button.

## Security model — read this before installing

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

## Control plane — approve / deny tool calls remotely (opt-in)

agentglass can do more than watch: a `PreToolUse` hook can **hold a tool call**
until you approve or deny it from the dashboard. Wire `hooks/gate_event.py` into
a project's `PreToolUse` and risky tool calls show up under **"What needs you"**
with Approve / Deny buttons — decide from any device and the agent unblocks.

```jsonc
"PreToolUse": [
  { "matcher": "Bash", "hooks": [{ "type": "command",
    "command": "python3 ~/code/agentglass/hooks/gate_event.py --source-app my-project" }] }
]
```

On Windows, use `py` (or `python`) instead of `python3` in hand-written hook commands; `hooks/install_hooks.py` picks this automatically.

Safe by design — it **never blocks your agents by accident**:

- unreachable server or an error → **allow** (the hook exits 0, no decision)
- no one decides within `AGENTGLASS_GATE_TIMEOUT` (default 60s) → **auto-allow**
- only sessions wired to the gate are gated; everything else is untouched

It also survives a restart. Pending requests are persisted, so restarting or
crashing the server brings the queue back instead of quietly auto-allowing
everything that was waiting on you — the hook re-attaches to the request it was
already holding. A request whose window ran out while the server was down is
resolved by your configured policy and **says so** in "What needs you", because
an outcome nobody chose is the one worth showing.

Scope it with the `matcher` (e.g. `Bash` only, or a specific tool) so you're not
gating every call. Denying returns a `PreToolUse` deny with your reason — and
when you just press Deny without typing one, the agent is told a human stopped
it, that retrying the same call is pointless, and to try another approach or ask
you. That sentence is read by the model, not by you, so it is written for it.

Want the opposite trade-off? Set `AGENTGLASS_GATE_FAILCLOSED=1` and a timeout or
an unreachable control plane **denies** instead of allows — the fleet stops
until you decide. Off by default; turn it on only when blocking is safer than
proceeding, and remember agentglass being down then blocks every gated call.

---

## Any provider — Kimi, OpenAI, Gemini, Bedrock, …

Two ways in: an agent with hooks can post through the bundled forwarder, and
anything that speaks OpenTelemetry can point its exporter here.

### Kimi Code CLI and Kimi K3 — via hooks

[Kimi Code CLI hooks](https://moonshotai.github.io/kimi-code/en/customization/hooks)
can stream its session and tool lifecycle through the bundled hook forwarder.
Agentglass recognizes the real K3 names (`k3`, `kimi-k3`, and `kimi-code/k3`)
as **Moonshot / K3**, understands both Moonshot cache-token formats, and applies
K3's input, output, and cache-hit rates without counting cached prompt tokens
twice.

Kimi's hook payload does not carry token usage, so hooks populate the live
session/tool views; a Kimi/Moonshot adapter can send its final `usage` object to
`POST /ingest` for exact token and cost charts. Copy the ready-to-use
`config.toml` hook blocks from [the extension guide](docs/EXTENDING.md#kimi-code-cli-and-kimi-k3).

### OpenTelemetry

agentglass isn't Claude-only. It exposes an **OTLP/HTTP** trace receiver that
maps OpenTelemetry **GenAI** spans (the `gen_ai.*` semantic conventions) into the
same events the dashboard already understands — so anything emitting GenAI
telemetry streams in: the OpenAI / Google / Bedrock SDK instrumentations,
LangChain, LiteLLM, OpenLLMetry, Arize Phoenix and the other OpenInference
instrumentors.

**Not Claude Code's own OTel export**, which this used to list. That export is
*metrics*, and this receiver takes spans and log records — so pointing
`OTEL_EXPORTER_OTLP_ENDPOINT` at agentglass from Claude Code sends its metrics
to an endpoint that turns them away and says why. Nothing is lost: Claude Code
is already covered, at far higher fidelity, by the hooks (`bun run setup`) —
per-tool timings, the prompt, the arguments, and the gate. Metrics carry totals,
which is the one thing the dashboard can already compute.

### Auto-connect installed CLIs — one command, opt-in

Like the Claude Code hooks, one command **detects and wires any installed agent
CLI that speaks OpenTelemetry** — backed up first, idempotent, and never run
behind your back on `bun install`:

```bash
bun run connect          # detect + wire installed agent CLIs (also: make connect)
bun run connect:undo     # unwire them again
```

- **Gemini CLI** → `~/.gemini/settings.json` (OTLP **traces** → `/v1/traces`)
- **OpenAI Codex CLI** → `~/.codex/config.toml` (OTLP **logs** → `/v1/logs`)

Start a new `gemini` / `codex` session after connecting and it streams straight in.

### OpenCode — a plugin, because it has no OTLP exporter

OpenCode does not export OpenTelemetry and has no hook system to wire, but it
does load plain JS from its own plugin directory. So this one is a file copy:

```bash
bun run connect:opencode        # deploy the plugin (also: make connect-opencode)
bun run connect:opencode:undo   # remove it again
```

It writes one dependency-free file to `~/.config/opencode/plugins/agentglass.js`
— nothing else in your OpenCode config is touched, no `package.json` is edited
and no package is installed. The plugin subscribes to OpenCode's event bus and
POSTs the same normalised events to `/ingest` that the Claude Code hooks do, so
prompts, tool calls, usage and subagents all land in the same fleet.

Safe to re-run, and deliberately timid about a directory this app does not own:
it refuses to replace an `agentglass.js` that is not ours, backs up before
overwriting one that is, and on `--undo` leaves an unrelated plugin of that name
exactly where it is. It also refuses to deploy at all if `AGENTGLASS_SERVER`
points off this machine, rather than wiring up an endpoint and relying on the
plugin to decline later.

Start a new `opencode` session after connecting for it to take effect.

### Anything else — point its OTLP exporter here

The receiver accepts OTLP/HTTP in **both protobuf (the SDK default) and JSON**, so
no Collector is needed — just aim any exporter's endpoint at the server:

```bash
export OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4000
# spans POST to /v1/traces automatically (protobuf or http/json both accepted)
```

The provider and model are **auto-detected from the spans** (`gen_ai.system`,
`gen_ai.request.model`) — no config, no dropdown. Mapping:

- **LLM spans** (`chat` / `completion` / …) → a costed *"turn"* event carrying the
  span's token usage. Cost uses the same [pricing table](server/src/pricing.ts)
  (OpenAI, Gemini, Mistral, … included; override with `AGENTGLASS_PRICING`).
- **Tool spans** (`execute_tool`, or any span with `gen_ai.tool.name`) → a paired
  `PreToolUse` + `PostToolUse`, so **tool latency (p50/p95)** and the tool-mix
  populate.

Some agents (OpenAI Codex CLI) export OpenTelemetry **logs** rather than traces —
those go to **`/v1/logs`**, which maps each GenAI log record (tool decision/result,
inference, prompt) to an event the same way. Codex's native `event.kind`,
`input_token_count`, `output_token_count`, `cached_token_count`, and
`cache_write_token_count` fields are recognized directly; cached input is kept
in its own buckets rather than charged again as ordinary input.

> Non-GenAI spans/records are ignored — this is an agent-observability lens, not a
> general trace or log store.

---

## Configuration (env)

| Var | Default | Meaning |
|---|---|---|
| `AGENTGLASS_PORT` | `4000` | Server HTTP/WS port. |
| `AGENTGLASS_BIND` | `127.0.0.1` | Address the server binds to. Loopback-only by default. Exposing (`0.0.0.0`) requires `AGENTGLASS_TOKEN` **and** `AGENTGLASS_TRUST_LAN=1`, and only on a trusted network. See [Security model](#security-model--read-this-before-installing). |
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
| `AGENTGLASS_WEBHOOK` | — | POST `{text}` here (a Slack/Discord-shaped incoming webhook) for alerts, Lantern watch notices and PR nudges sent with `send: true`. What travels is the notification's title and body — agent names, a checkout's base name, a PR's number, title, URL and reviewer logins — never a transcript, a diff or a token. Blanked out of every Clone run. |
| `AGENTGLASS_NOTIFY` | — | `1` → fire desktop alerts. A connected client (browser or desktop app) raises a **native OS notification** on any platform; `notify-send` is the fallback for a headless server with nothing attached to show it. Does **not** gate the phone, which hears every alert on the socket it already holds and decides for itself — see [Alerts on the phone](docs/WORKSPACE.md#alerts-on-the-phone-and-what-they-honestly-cover). |
| `AGENTGLASS_SERVER` | `http://127.0.0.1:4000` | Used by the hook/seed scripts. Refused unless it points at this machine — see the next row. A `localhost` value is accepted and rewritten to `127.0.0.1` before connecting: the server binds IPv4-only, so on a host that resolves `localhost` to `::1` first, every event pays a refused connect before falling back. |
| `AGENTGLASS_ALLOW_REMOTE` | — | `1` → let the hook scripts post to a **non-local** `AGENTGLASS_SERVER`. Off by default and deliberately awkward: those payloads carry full session transcripts, and `AGENTGLASS_SERVER` can be set by a repo-local `settings.json` — so a cloned repository could otherwise redirect your transcripts to somebody else's host. Set it only if you genuinely run the server on another machine. |
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
| `AGENTGLASS_TMUX_OBSERVE_ONLY` | — | `1` (or `true`/`yes`/`on`) → every tmux command that would change **your** sessions becomes a no-op that logs what it would have run; reads keep working, so the whole cockpit still draws. See [docs/BLAST-RADIUS.md](docs/BLAST-RADIUS.md). |
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

---

## Worktrees start with what git leaves out

`git worktree add` copies the tracked tree and nothing else — no `.env`, no local
settings, no generated files a repository ignores on purpose — and a new checkout
does not start without them. Put a `.worktreeinclude` at the repository root, one
ignored path per line, and every worktree agentglass cuts (the Clone's, the Git
view's, a conflict checkout) gets those copied in from the primary checkout:

```
# .worktreeinclude — copied, never linked, never overwriting what git put there
.env
config/local.json
```

Tracked paths are skipped (git owns them), a path already in the new checkout is
kept, and a line that climbs out of the repository is refused.

## The terminal's two keyboard tricks

- **Pluck** — `Ctrl+Shift+Space` over a pane lists the paths, links, commit hashes,
  ids and branch refs on its screen, newest first, each with a letter. The letter
  writes the token into the pane as one paste (the agent said a path; you say it
  back); `Shift`+letter copies it instead. Wrapped lines are joined first, so a
  link broken across two rows is one link.
- **Ask about this** — select something in a pane (a traceback, a table) and the
  pane's bar offers to ask about it: a short note, then the note and the selection,
  quoted, go to the agent living in that pane as its next message. A pane with no
  agent in it gets a fresh chat on the floating bench with the same message.

## API

Every route is behind the token and the origin/Host gates described in [Security model](#security-model--read-this-before-installing); the exceptions are named on their row. **Gated** means refused by the named switch; a write outside the open project is refused by scope. Families are grouped by prefix; `{a,b}` lists the verbs under one.

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
| `GET /plugins` · `/plugins/catalogue?url=` · `/plugins/catalogues` · `POST /plugins/{install,install-from-catalogue,update,enable,disable,remove,master,catalogues/*}` | Installed plugins and the master switch; browse a catalogue (`https://` only); install, update, enable, disable, remove. Nothing runs at install; writes need `full`. See [docs/PLUGINS.md](docs/PLUGINS.md). |
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
| `POST /control` | Drive the dashboard's own UI (view, theme, zoom, new chat) from outside. Validated, rebroadcast on `/stream`; grants nothing the keyboard lacks. See [`docs/EXTENDING.md`](docs/EXTENDING.md). |
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

---

## Roadmap

Where this is going — themes, not dates. The living version is the issue tracker; the [`help wanted`](https://github.com/SirAllap/agentglass/labels/help%20wanted) and [`good first issue`](https://github.com/SirAllap/agentglass/labels/good%20first%20issue) labels mark the best places to start.

**Now**
- Lead with a verdict: what's running, what's stuck, what needs you now — [#42](https://github.com/SirAllap/agentglass/issues/42)

**Next**
- Per-agent changes scoped to each session's worktree/branch — [#117](https://github.com/SirAllap/agentglass/issues/117)
- Warn when parallel agents collide on shared runtime the diff can't see — [#118](https://github.com/SirAllap/agentglass/issues/118)
- A gate that can hold by rule (spend, allowlist), not only by hand — [#109](https://github.com/SirAllap/agentglass/issues/109)
- Per-project gate policies and hook profiles — [#14](https://github.com/SirAllap/agentglass/issues/14)
- Keep model prices fresh without hand-editing the table — [#9](https://github.com/SirAllap/agentglass/issues/9)

**Later / exploring**
- An API panel to exercise the endpoints the fleet is building — [#170](https://github.com/SirAllap/agentglass/issues/170)
- Tasks per project, and a decision log mined from transcripts — [#12](https://github.com/SirAllap/agentglass/issues/12), [#13](https://github.com/SirAllap/agentglass/issues/13)
- Voice input in chat — [#92](https://github.com/SirAllap/agentglass/issues/92)

**Recently shipped** — see the [releases](https://github.com/SirAllap/agentglass/releases) for the full record.
- **v0.15.0** — the app learns to look after the agents, not only to show them. A **Lantern** view lights on the rail with the count of agents stopped on you and answers first: who needs you and why, in the notification's own words; every agent as a card — model, checkout and branch, what it is doing now (its own word, or its last tool call), what it was asked, commits over the base and files changed, calls, turns, errors, cost, and a countdown of the prompt cache. A **watch** re-reads the field every fifteen minutes and sends one notification when somebody is still stopped on you, a worker's window vanished, or claimed work has gone quiet; **Ask about the field** opens a chat with the field as its first message; **Schedule…** starts an agent later, at a time, with a prompt, in a checkout; **hand off** moves a conversation to another agent as a brief. **Named agents** — `agentglass-agent start / prompt / wait / read / send-keys / list / stop / schedule` — give a script a launcher and a liveness over the engine this app already owns, in a JSON shape an orchestrator's worker reads unchanged. The **Clone** stops a live agent that has gone quiet at twenty minutes instead of forty-five, sleeps until the session limit the CLI announces and resumes on its own, seeds a fresh worktree from `.worktreeinclude`, and comes back from a restart with every window split the way it was. The **terminal** gains **Pluck** (`Ctrl+Shift+Space`: the paths, links, hashes and ids on the screen, lettered, one key to paste) and **Ask about this** (a selection becomes a question to the agent in that pane). Pull-request cards count their **open threads** and offer to **nudge the reviewers**. The machine stays awake for **every** agent at work — the ones in your own terminals included — and starts in that mode. Underneath: the observer never counts itself, a bench tab's close can end what it runs, and the public repository describes its own features in its own terms.
- **v0.14.0** — the phone gets a design system of its own, and the chart stops losing its own history. **Pane** replaces the desk's skin on the phone rather than tuning it: a darker ground with quieter hairlines and raised surfaces doing the separating instead of borders, because at 393 points a visible border around every row is most of what you see; a warm light half, since a cool near-white reads as a screen left on and a warm one reads as paper; and a corner ladder where everything you press is nearly a rectangle and exactly one thing per screen is round. Three faults were caught wiring it, each of which would have shipped — the live repaint composed on the old palette, so the app would have looked like Pane until the first time anybody opened Settings and then snapped back for good; an unreadable preference put the desk's blue on the new ground; and `info` set to the accent collapsed two of the terminal's sixteen ANSI slots into one colour, which made an `ls` colour vanish. The terminal's bottom bar loses three controls that were not earning their place — `80c` duplicated a setting, `line` announced a state that the state announces itself, and `fit` never said what it fit or to what — and the field with its three icons becomes the one capsule, taking the key row from seven keys to eleven in the same width. Underneath, two scoping bugs that both failed silently: the rollup's set of project paths was read once and cached, dropped only by the prune on the stated ground that the prune is the only writer, so any other write left a project's entire folded history filtered out of the chart — and those are precisely the days whose events have already been deleted, so nothing else could put them back; and `resolveScope` answered with git's real path while every row it is prefix-matched against is spelled the way the caller gave it, so a project reached through a symlink filtered out its own history and the cockpit came up empty with nothing to say about why. The first of those had CI red on every pull request for two days, including one that changed a single line of YAML, and was found by reading the runner's own answers back out of the only channel that survived the log's tail: the names of the failing tests.
- **v0.13.0** — the phone finishes the work instead of starting it. A review can be completed without leaving the app: review threads are a screen, with replies, resolve and unresolve, and suggestions that apply as a commit; the diff expands the context a hunk cut off; and the review sheet says when GitHub is already holding line comments started somewhere else, rather than reporting none and submitting them unseen. Work is handed over with intent — the review hand-off shows the prompt before anything runs, and a card is handed to a named skill rather than as its id and title. What the socket carries is unchanged and guarded by a test: a number, a directory and a recipe id, with the words written on the computer. The card screen draws the description, subtasks, checklists, comments and linked pull requests that `/clickup/task` was already answering with and the screen was dropping. And the Cards row appears only where a task tracker is actually set up — read from the provider catalogue, so Taskwarrior counts and a workspace that uses neither is not shown somebody else's product.
- **v0.12.1** — the macOS build exists again. v0.11.0 and v0.12.0 published with no `.dmg` at all: the mac half of the release pipeline had been dying while building the bundled tmux, so the release carrying the Apple Silicon crash fix ([#517](https://github.com/SirAllap/agentglass/issues/517)) had no artifact anyone could install it from, and the newest release that did have one predates the fix. Four faults, each hiding the next: darwin's `configure` refuses to guess about utf8proc and stops; the static check demanded a string `file` never prints for a Mach-O, so a tmux that had compiled and run was rejected by the script that built it; a failing build printed its reason where no log reader could reach it; and libevent was built for the runner rather than the target, so on the Intel cross-build the header was found and the link was not. Two tests now guard the shapes that caused them — a comment inside a backslash-continued command, which `bash -n` reads as valid, and a `./configure` that runs without the target architecture. Nothing in the app changed: this is v0.12.0 with binaries for every platform it claims to support.
- **v0.12.0** — the phone reviews the work instead of watching the agents. A pull request opens *in* the app: the description, the diff paged file by file, line comments left where they belong, and the review submitted in one call rather than one request per comment; a failing check names its job and opens the log at the tail; merging is done from the same screen. The **Inbox** files pull requests, issues and cards by what they need from you rather than by what an agent is doing, and either an issue or a card can be handed to an agent on the machine, which cuts the worktree and starts it there. The conversation UI is gone — nine screens arrived and three left. The terminal, which is where the time on a phone actually goes, stops paying the bridge for every PTY frame (about twenty crossings a second instead of two hundred, with the same bytes in the same order), gains a GPU renderer whose *loss* is handled, and a key bar you can arrange and add your own keys to. **Troubleshooting** answers “why is half of this grey” from the phone, showing the install line rather than running it. On macOS: the desktop app launches on Apple Silicon again after crashing on start since v0.9.0 — flipping an Electron fuse rewrites the framework and invalidates the signature covering that page, and the kernel killed the process before `main.js` ran ([#517](https://github.com/SirAllap/agentglass/issues/517)) — and the vendored tmux builds on darwin. CI measures the tree rather than the week: the toolchain is pinned after an unpinned `bun-version: latest` took `main` red for four days with nine timeouts nobody wrote, and a client name reaching a fixture now fails the build instead of a reviewer.
- **v0.11.0** — the panels stop being places you look at and become places you work from. The pull-request board files every open request by what it needs from you; the app runs its own bundled tmux, so a terminal, a review and an agent all open on an engine that survives a reboot; ClickUp arrives as folders, saved views and the list's own brief; the Diff view is rebuilt on rows and reads the repository once per change instead of every four seconds; the git panel gains branches, tags, stashes, reflog, blame, bisect and grep, and draws the log's graph instead of printing it; and the terminal's bar resumes any past session in the project, in a tab or beside what you are reading.
- **v0.10.1** — a desktop-only release that gives height back. The pull request header is one bar instead of three, and the pins now sit on it in the list view as well as in the detail; the browser view drops a title bar that repeated what its own tab strip said. The triage board's card draws the check suite as a bar filled by what has reported rather than as `6/14`, moves the pin onto the title row as a 26px target, and clamps a long title so one lane's cards stop being three different heights. Two test suites that were waiting for a length of time instead of for a fact stopped going red on continuous integration for reasons unrelated to the change under them. The phone companion is unchanged: v0.10.0's APK talks to this build.
- **v0.10.0** — the phone stops being a viewer and the desk stops being lied to. The companion gets a **Plan left** card on Home, showing what remains of the window that runs out first rather than what has been spent, and a **+** that starts an agent in the checkout you are looking at and says so in words when it cannot. The mirror survives a wrapped prompt, so a line typed at the computer can be finished from the sofa. On the desk: a pane's worktree readout stops naming the tab you just left (1510ms → 151ms, measured against a build of the previous release), the pull request header links out to GitHub and **Its PR** opens the pull request instead of filtering a list, and a branch's pull requests are read again rather than once. Three ways tmux was being told the wrong thing are gone — a window a phone left pinned puts itself back, a teardown restores only what it moved and clears its record only when the restore worked, and tmux stopped painting `list-keys` output and plugin messages across the pane. And every route that executes or mutates now refuses a caller with no `Origin`, which was 22 routes on the permissive gate against 5 on the strict one ([#469](https://github.com/SirAllap/agentglass/issues/469), [#488](https://github.com/SirAllap/agentglass/issues/488)).
- **v0.9.0** — the phone becomes a real application and the shell stops being fifteen months behind. A **native Android companion** replaces the one rendered in a browser tab, which could never finish a pairing handshake over a LAN address because `crypto.subtle` is secure-context only; it pairs, buzzes with the screen off, and holds a real tmux pane. The desktop moves to **Electron 43**, off a line that went EOL in April 2025, with the fuses proven in the packaged binary rather than in the config that asked for them, and the window backend read from the session instead of pinned to one that no longer draws on Wayland. The build stamp now names the *tree* that was packaged rather than whatever `HEAD` happened to be, so "does my installed app have that fix?" is answerable. On the server: the telemetry sinks stop being tokenless from anywhere but loopback, a proxy can no longer present itself as loopback, and an alert that could go missing on the way to you does not. The whole product carries one version number.
- **v0.8.0** — the redesign: the workspace stops being a modal over the dashboard and becomes the window itself, with the cockpit demoted to the first view on a rail you can reorder. Three new views arrive with it — **Tasks** (GitHub issues and your own list, with **Start →** to cut a worktree from an issue), a **Files** browser that opens into the app's own editor, and a **Ports & Resources** panel for what this machine is listening on and how hard it is working. The terminal learned to jump to the git/diff of whatever worktree its focused pane is in, and the desktop's own notifications are mirrored into the app so nothing is missed while it is fullscreen. See the [release](https://github.com/SirAllap/agentglass/releases/latest) for the full record.
- **v0.7.0**: the phone stops being something you have to remember to check. Real Web Push wakes it with the screen off ([#409](https://github.com/SirAllap/agentglass/issues/409), [#412](https://github.com/SirAllap/agentglass/issues/412), [#413](https://github.com/SirAllap/agentglass/issues/413)), and what it wakes you into is a queue with the next move written on it ([#405](https://github.com/SirAllap/agentglass/issues/405), [#404](https://github.com/SirAllap/agentglass/issues/404)).
  - **Push.** Web Push written against the spec and verified byte for byte against another implementation ([#409](https://github.com/SirAllap/agentglass/issues/409)). VAPID keys are minted once, on demand, without the race that left the losing caller silent ([#418](https://github.com/SirAllap/agentglass/issues/418)). Four routes so a phone can subscribe, resubscribe and forget ([#411](https://github.com/SirAllap/agentglass/issues/411), [#419](https://github.com/SirAllap/agentglass/issues/419)), a service worker behind a switch you turn on ([#413](https://github.com/SirAllap/agentglass/issues/413)), and a `deliver()` that reaches a phone with its screen off ([#412](https://github.com/SirAllap/agentglass/issues/412)). Tap the alert and you land on the thing it was about ([#417](https://github.com/SirAllap/agentglass/issues/417)). Only an agent that is *stopped* is worth waking a pocket for ([#420](https://github.com/SirAllap/agentglass/issues/420)). An iPhone in a browser tab was being told push works when it does not, and is not any more ([#414](https://github.com/SirAllap/agentglass/issues/414)). You can prove the whole path works without waiting for an agent to block ([#415](https://github.com/SirAllap/agentglass/issues/415)).
  - **The companion.** One writer per session, so two devices cannot answer the same agent at once ([#391](https://github.com/SirAllap/agentglass/issues/391)). The chat rides the live socket instead of polling, and a phone nobody is looking at is not polled at all ([#392](https://github.com/SirAllap/agentglass/issues/392), [#388](https://github.com/SirAllap/agentglass/issues/388)); it stopped dropping what the agent did ([#395](https://github.com/SirAllap/agentglass/issues/395)); and the chat list is one you can trust and search ([#396](https://github.com/SirAllap/agentglass/issues/396)). Destinations you can name ([#393](https://github.com/SirAllap/agentglass/issues/393)), one rule for when two things are the same project ([#394](https://github.com/SirAllap/agentglass/issues/394)), a confirmation before the taps that cannot be undone ([#383](https://github.com/SirAllap/agentglass/issues/383)), and errors that say what is actually wrong ([#397](https://github.com/SirAllap/agentglass/issues/397), [#399](https://github.com/SirAllap/agentglass/issues/399)). A review happens on the phone and is addressed correctly ([#402](https://github.com/SirAllap/agentglass/issues/402)), and a red check is read there instead of sending you out to a browser ([#406](https://github.com/SirAllap/agentglass/issues/406)). The tab bar floats now, with settings riding on the pill ([#425](https://github.com/SirAllap/agentglass/issues/425), [#429](https://github.com/SirAllap/agentglass/issues/429)), and the dark band along the bottom turned out to be fifteen closed sheets each casting a shadow into it ([#431](https://github.com/SirAllap/agentglass/issues/431)).
  - **The queue, and the fleet.** A Fleet tab, because all of this was already being computed ([#405](https://github.com/SirAllap/agentglass/issues/405)). A repository stopped part-way gets a face and a way out ([#401](https://github.com/SirAllap/agentglass/issues/401)). The Now queue counts each item once, and Later means later ([#400](https://github.com/SirAllap/agentglass/issues/400)). The merge button carries the next move rather than the word "Blocked" ([#404](https://github.com/SirAllap/agentglass/issues/404)), and a review thread is read whole instead of by its first line ([#403](https://github.com/SirAllap/agentglass/issues/403)).
  - **The numbers, round two.** Six numbers were answering a different question than their label ([#369](https://github.com/SirAllap/agentglass/issues/369)); a model's name is no longer welded to its price row ([#368](https://github.com/SirAllap/agentglass/issues/368)); a PreToolUse answers exactly one Post, and a p95 says its sample size ([#371](https://github.com/SirAllap/agentglass/issues/371)); a price that is a guess says so ([#377](https://github.com/SirAllap/agentglass/issues/377)); and search finds the path you typed ([#373](https://github.com/SirAllap/agentglass/issues/373)). OpenInference-instrumented sessions arrive with their tokens again ([#375](https://github.com/SirAllap/agentglass/issues/375)), GPT-5 is priced as GPT-5 ([#385](https://github.com/SirAllap/agentglass/issues/385)), a K3 context suffix is the same model rather than an unknown one ([#363](https://github.com/SirAllap/agentglass/issues/363)), Kimi K3 is recognised with its cached prompt tokens split out ([#361](https://github.com/SirAllap/agentglass/issues/361)), external ingest is retry-safe and Codex usage is mapped ([#357](https://github.com/SirAllap/agentglass/issues/357)), an unrecognised OTel record is treated as telemetry rather than a request for a human ([#379](https://github.com/SirAllap/agentglass/issues/379)), and a stale session is retired in the timeline like it is everywhere else ([#353](https://github.com/SirAllap/agentglass/issues/353)).
  - **The numbers outlive retention.** Expiring events fold into a daily rollup before they are deleted ([#376](https://github.com/SirAllap/agentglass/issues/376)), and the dashboard reads that rollup, marks the windows it covers and exports the days ([#381](https://github.com/SirAllap/agentglass/issues/381), [#292](https://github.com/SirAllap/agentglass/issues/292)).
  - **Terminal, chat and desktop.** A tmux tab flashes when the agent in it wants you: amber for a question, green for a finished turn ([#426](https://github.com/SirAllap/agentglass/issues/426)). Every byte written to the pty gets there, not only the ones it took first ([#382](https://github.com/SirAllap/agentglass/issues/382)). The theme file already on disk is repaired, so it stops overwriting your tmux status bar ([#339](https://github.com/SirAllap/agentglass/issues/339), [#374](https://github.com/SirAllap/agentglass/issues/374)). A branch merged yesterday no longer reads "not merged" until a ref happens to move ([#427](https://github.com/SirAllap/agentglass/issues/427)). The remote pane remembers the address, names the devices and shows who is connected ([#428](https://github.com/SirAllap/agentglass/issues/428), [#430](https://github.com/SirAllap/agentglass/issues/430)). A chat is named after what you asked it to do ([#398](https://github.com/SirAllap/agentglass/issues/398)), a project hands its own commands to an agent ([#407](https://github.com/SirAllap/agentglass/issues/407)), the chat store stops re-serialising every chat once per shed ([#386](https://github.com/SirAllap/agentglass/issues/386)), and a diff tokenises the first line of a file like all the rest ([#387](https://github.com/SirAllap/agentglass/issues/387)).
  - **Security and privacy.** Explain stopped sending your `.env` to a model ([#390](https://github.com/SirAllap/agentglass/issues/390)). There is a record of who did what ([#389](https://github.com/SirAllap/agentglass/issues/389)), a gate denial the agent can act on instead of guess at ([#380](https://github.com/SirAllap/agentglass/issues/380)), and a security policy that says what is kept, how to remove it, and what is not a bug ([#384](https://github.com/SirAllap/agentglass/issues/384), [#378](https://github.com/SirAllap/agentglass/issues/378)). Eleven code-scanning alerts triaged: three were real and are fixed, and none were dismissed ([#432](https://github.com/SirAllap/agentglass/issues/432)).
  - **The front door.** A logo generated from one source ([#358](https://github.com/SirAllap/agentglass/issues/358), [#356](https://github.com/SirAllap/agentglass/issues/356)), README figures recaptured with the phone in them ([#359](https://github.com/SirAllap/agentglass/issues/359), [#355](https://github.com/SirAllap/agentglass/issues/355), [#364](https://github.com/SirAllap/agentglass/issues/364)), a landing page that shows the companion doing something ([#354](https://github.com/SirAllap/agentglass/issues/354), [#372](https://github.com/SirAllap/agentglass/issues/372)), and a demo that no longer installs a service worker on a stranger's browser ([#421](https://github.com/SirAllap/agentglass/issues/421), [#422](https://github.com/SirAllap/agentglass/issues/422)). We measure what we ship: GitHub's traffic window is kept before it rolls off, and the landing page is counted ([#367](https://github.com/SirAllap/agentglass/issues/367), [#370](https://github.com/SirAllap/agentglass/issues/370)).
- **v0.6.0** — the cockpit leaves the desk, and the pull request panel stops being a viewer: the dashboard reaches your own phone in one switch, installs as an app, and answers agents from it ([#344](https://github.com/SirAllap/agentglass/issues/344), [#346](https://github.com/SirAllap/agentglass/issues/346), [#349](https://github.com/SirAllap/agentglass/issues/349)).
- **v0.5.0** — pull request review inside the cockpit, and the freeze is gone: the event loop is watched, and every expensive git, docker and database read left the thread that carries the terminal
- **v0.4.0** — evidence-of-life signal for open tool calls; the shell no longer adopts a stranger's server on `:4000`
- **v0.3.0** — in-app merge-conflict resolution, whole-project docker controls, a rearrangeable workspace, and an in-app updater
- **v0.2.x** — downloadable installers for Linux / macOS / Windows, the Electron desktop shell, and a real chat panel

---

## Contributing

Issues and PRs welcome — see [CONTRIBUTING.md](CONTRIBUTING.md). Small, fast and
dependency-light on purpose: a Bun/SQLite server, a React/Vite UI, an Electron
desktop shell, a React Native phone app, and a stdlib-only Python hook
forwarder. To adapt it to another agent or harness without forking, start at
[`docs/EXTENDING.md`](docs/EXTENDING.md).

## About

Built by [**@SirAllap**](https://github.com/SirAllap) (David Pallares).
Original work — not a fork. Not affiliated with or endorsed by Anthropic;
"Claude" and "Claude Code" are trademarks of Anthropic.

## License

MIT © 2026 David Pallares — see [LICENSE](LICENSE).
