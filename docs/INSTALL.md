# Installing, running and connecting agents

The [README](../README.md) has the two lines that get the app open. This is the
rest: running it from a checkout, what it shells out to, the desktop shell, the
updater, the opt-in gate that holds a tool call, and how to point something that
is not Claude Code at it.

- [Quickstart](#quickstart) · [Running from source](#running-from-source) · [Wire the hooks globally](#wire-the-hooks-globally--one-command-opt-in)
- [Requirements](#requirements-what-agentglass-expects-to-find)
- [Desktop app](#desktop-app) · [Updating](#updating)
- [Control plane — approve / deny remotely](#control-plane--approve--deny-tool-calls-remotely-opt-in)
- [Any provider — Kimi, OpenAI, Gemini, Bedrock …](#any-provider--kimi-openai-gemini-bedrock-)

---

## Quickstart

agentglass is a **desktop app**. Grab the installer for your platform from
[**Releases**](https://github.com/SirAllap/agentglass/releases/latest), launch
it, and the cockpit opens with its own server bundled inside. Nothing to run in
a terminal, no port to open in a browser.

| Platform | Asset on the release | Notes |
| --- | --- | --- |
| Linux, x86_64 | `agentglass_<version>_x86_64.AppImage` or `agentglass_<version>_amd64.deb` | AppImage: `chmod +x`, run it. The in-app updater works here |
| macOS, Apple silicon (arm64) | `agentglass_<version>_arm64.dmg` | Drag into Applications. Updates by downloading the next `.dmg`; **Settings ▸ About** names the file when one is out |
| macOS, Intel (x64) | `agentglass_<version>_x64.dmg` | Same as above, Intel build |
| Windows, x64 | `agentglass_<version>_x64.exe` | NSIS installer. The in-app updater is off here; download the next `.exe` to update |
| Android (companion) | `agentglass-v<version>.apk` | The phone app: pairs with a desktop that has remote access on. Not a standalone cockpit |

The desktop installers are attested: `gh attestation verify <file> --repo SirAllap/agentglass` answers which commit and workflow produced the one you downloaded. The APK is signed with the app's own key instead.

That alone already shows you everything: the built-in **transcript scanner**
reads `~/.claude/projects`, so every Claude Code session on the machine is
there on first open, with no wiring at all.

To also get live streaming and `PreToolUse` gating, wire the hooks once
(opt-in, details [below](#wire-the-hooks-globally--one-command-opt-in)).

**In the desktop app there is nothing to clone**: the hooks ship inside the
bundle, and **Settings ▸ Hooks** wires them into `~/.claude/settings.json` and
takes them out again, showing whether they are currently installed.

From a checkout, the forwarder lives in the repo, so this path wants a clone and
Python 3; it needs nothing else:

```bash
git clone https://github.com/SirAllap/agentglass.git && cd agentglass
python3 hooks/install_hooks.py        # global Claude Code hooks
python3 hooks/seed_demo.py            # optional: streams demo agents for ~30s
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
[`hooks/settings.example.json`](../hooks/settings.example.json) for manual setups.

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

## Updating

**Settings ▸ About** shows the version you are running, the commit it was built from, and whether a newer **release** is published. One click builds it and restarts.

**The in-app updater is POSIX-only.** It rebuilds from source, so it needs `git` and `bun` on the machine, and on **Windows** it is switched off rather than shelling out to a `bash` that may not exist — About still reports the version and the newest published tag, but updating means downloading the installer again. When the machine is offline the pane says it could not reach the release feed, instead of claiming you are up to date.

![settings — preferences, shortcuts, and the About pane that offers a newer release](../.github/assets/settings.png)

It tracks **tags**, never a branch tip. A tip is wherever development happened to stop — half a feature, a debugging commit — and tagging is the act of saying *this one is tested*. So nothing pushed after the last tag reaches an installed app until you tag it:

```bash
git tag v0.3.0 && git push --tags     # now every install is offered it
```

The build happens in agentglass's **own clone** under `~/.cache/agentglass/source`, never in your checkout — so a convenience button can never move your `HEAD` or touch work in progress. It works out what it already has from `git describe` rather than a version field, so a `package.json` nobody remembered to bump cannot make an older tag look like an upgrade.

The route that runs it is the strictest in the server: reachable from the desktop shell's own origin and nothing else — not from a browser, not from another machine on your network. It is the one endpoint that executes arbitrary code, so the ordinary "local network is fine" rule is not enough for it.

> Updating this way compiles on your machine, which is only reasonable because your machine already has the toolchain. It is not a substitute for a signed release feed, and it is deliberately not automatic — nothing is downloaded or run until you press the button.
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
`config.toml` hook blocks from [the extension guide](EXTENDING.md#kimi-code-cli-and-kimi-k3).

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
  span's token usage. Cost uses the same [pricing table](../server/src/pricing.ts)
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
