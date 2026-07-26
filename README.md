<div align="center">

<img src=".github/assets/logo.svg" alt="agentglass" width="88" height="88" />

# agentglass

**A loupe for your agents** — a real-time Mission-Control **dashboard _and_ workspace** for AI coding agents, across every provider and every project on your machine.

[![▶ Live demo](https://img.shields.io/badge/▶%20Live%20demo-try%20it%20now-6366f1?style=for-the-badge)](https://sirallap.github.io/agentglass/demo/)

<a href="https://trendshift.io/repositories/86777?utm_source=trendshift-badge&amp;utm_medium=badge&amp;utm_campaign=badge-trendshift-86777" target="_blank" rel="noopener noreferrer"><img src="https://trendshift.io/api/badge/trendshift/repositories/86777/daily?language=TypeScript" alt="SirAllap%2Fagentglass | Trendshift" width="250" height="55"/></a>

![stack](https://img.shields.io/badge/server-Bun%20%2B%20SQLite-black) ![ui](https://img.shields.io/badge/ui-React%20%2B%20Vite%20%2B%20Motion%20%2B%20Shiki-61dafb) ![workspace](https://img.shields.io/badge/workspace-diff%20%C2%B7%20git%20%C2%B7%20pr%20%C2%B7%20docker%20%C2%B7%20term%20%C2%B7%20chat-34d399) ![desktop](https://img.shields.io/badge/desktop-Electron%20app-47848f) ![themes](https://img.shields.io/badge/themes-22-a78bfa) ![license](https://img.shields.io/badge/license-MIT-green)

![agentglass in action — the live cockpit, then the workspace: source control, diff review, Docker and chat, one keystroke away](.github/assets/hero.gif)

![the cockpit — every session, spend, throughput, tool mix and what needs you](.github/assets/dashboard.png)

</div>

Point any AI coding agent at agentglass — via Claude Code hooks or any OpenTelemetry GenAI exporter (OpenAI Codex, Gemini CLI, Bedrock, LangChain, LiteLLM…) — and watch every agent, tool call, token, and dollar move in real time. Cost tracking, tool-latency percentiles, error timelines, session lifecycles, a filter-the-whole-cockpit-by-provider switch, and 22 themes. It persists across reloads (unlike a pure in-browser stream).

And it's not just a viewer. agentglass carries a full **workspace** in the same cockpit — the idea is simple: browser, terminal, IDE panels, agent telemetry… all in one place. A syntax-highlighted **diff** viewer for everything the fleet changed, a **lazygit**-style source-control panel (stage, commit, push), a **pull-request** panel that reviews and merges without opening a browser, a **lazydocker**-style Docker panel (containers, logs, stats), a **real terminal** (an actual PTY shell on your machine, not an emulation), and a **chat** panel that drives local Claude Code sessions — all behind one keystroke, under a notch that mirrors your desktop notifications so nothing is lost while you are fullscreen. Ships as a **native desktop app**, server included.

### ▶ [**Live demo →**](https://sirallap.github.io/agentglass/demo/)

The full cockpit running on fabricated sample data — a simulated live event
stream, populated radar, spend charts, and even the control-plane approve/deny
gate. No install, no server. *(Everything there is fake; it's a showcase.)*

---

## Contents

- [Every project, one cockpit](#every-project-one-cockpit)
- [More than a dashboard — a workspace](#more-than-a-dashboard--a-workspace)
- [Why](#why) · [Themes](#themes)
- [Quickstart](#quickstart) · [Requirements](#requirements-what-agentglass-expects-to-find)
- [Desktop app](#desktop-app) · [Updating](#updating)
- [Security model — read this before installing](#security-model--read-this-before-installing)
- [Control plane — approve / deny remotely](#control-plane--approve--deny-tool-calls-remotely-opt-in)
- [Any provider — via OpenTelemetry](#any-provider--via-opentelemetry-openai-gemini-bedrock-)
- [Configuration](#configuration-env) · [API](#api) · [Architecture](#architecture)
- [Extending / make it yours](docs/EXTENDING.md)
- [Roadmap](#roadmap) · [Contributing](#contributing) · [License](#license)

---

## Every project, one cockpit

agentglass watches **every** Claude Code session on your machine — you don't
launch it per-repo. Alongside the live hook stream, a **transcript scanner**
reads `~/.claude/projects` directly, so history from every project is there the
moment you open the dashboard, and new sessions tail in live (deduped against
the hooks, so nothing is double-counted).

Want to focus? **Scope the whole cockpit to a single project** — only that repo
(and its worktrees) show up, and its git / terminal / chat panels, diffs, and
spend are all you see. The natural way is the **in-app project picker**: on
first open (a desktop app has no "current folder", so it asks) you choose what
this cockpit is about, and the **⌂ name in the header** switches it any time:

- pick a **project** → that repo and its worktrees, nothing else;
- pick a **folder your projects live in** (e.g. `~/code`) → every repo from
  that folder inward;
- pick **All repos/projects** → no scope at all.

The choice is applied live and **persisted** (`root` in
`~/.config/agentglass/config.json`), so the next launch opens straight into it.
It can also be set from outside:

```bash
AGENTGLASS_ROOT=~/code/my-project bun run dev
# desktop:  AGENTGLASS_ROOT=~/code/my-project agentglass
```

Leave everything unset and it covers the whole machine. You can also pin the
repo sweep to specific directories via `AGENTGLASS_REPO_DIRS`, or the same
config file:

```jsonc
{ "root": "~/code/my-project", "repoDirs": ["~/code", "/mnt/hdd/code"] }
```

---

## More than a dashboard — a workspace

Watching is only half of it. agentglass grew a set of **lazygit / lazydocker-style panels** — plus a real terminal and a Claude chat — that live right in the cockpit, so you can go from *seeing* what the fleet did to *acting* on it without leaving the tab. Keyboard-driven, and they wear the same 22 themes.

They live in one **workspace**: `Ctrl+\` (`⌘\`) opens it over the dashboard, a rail down the left switches between the six views, and `Esc` puts you back. Every view has the same fixed-height title bar and the same list width, so switching changes the panel and nothing else moves.

**Two kinds of shortcut, because they answer different questions.** On the dashboard, bare letters jump straight in — `g` `d` `p` `o` `t` `c`. Inside the workspace every keystroke belongs to whatever has focus, usually a shell, so navigation there carries a modifier: `Ctrl+1`–`Ctrl+6` for the rail in order, `Ctrl+[` / `Ctrl+]` to cycle. Both sets are rebindable in **Settings ▸ Shortcuts**, and the modified one takes any combination you like — `Ctrl+Alt+J` is recorded exactly as you hold it.

![settings — every shortcut, rebindable, with the key that works anywhere beside the one that works on the dashboard](.github/assets/settings-shortcuts.png)

**Drag the rail to reorder it.** Put the terminal at the bottom if that is where your thumb goes; `Ctrl+1`–`6` follow your arrangement, so the tooltips never start lying. Drag the seam beside any list to resize it — every view shares that width, and it is remembered.

### 🔔 The notch — what is happening, above everything

A strip across the top of the workspace, always visible, never themed: true black so it disappears into the bezel of an OLED display.

It carries what you would otherwise go looking for — commits **to push** and **to pull**, live **shells**, chats **waiting** on you, unread notifications, your Anthropic **5-hour and weekly plan meters**, a seven-segment clock — and it mirrors **desktop notifications**, so the Slack message that arrives while you are fullscreen is not lost. Click it and it opens downward into an inbox with the full text; click again and it closes. Capability-probed on the server, so a platform without a notification bus gets a notch with no inbox rather than a broken one.

Notifications are off by default and opt-in per level in **Settings ▸ Preferences** — titles only, or the full body.

### 🔬 File changes — a syntax-highlighted diff & review workspace &nbsp;`d`

Every Edit/Write the fleet makes, gathered into one reviewable, chaptered list. **Shiki** syntax highlighting composed with a **word-level** intra-line diff, split or unified, ligatures and a per-diff theme, "reviewed" check-offs — plus one-click **✨ Explain** (a local-Claude walkthrough of the whole change set) and **⎇ Commit…** to turn a review straight into a commit.

![diff viewer](.github/assets/diff.png)

### 🌿 Source control — lazygit, in the dashboard &nbsp;`g`

A live view of any repo's working tree (repos are discovered from the fleet's own file paths). Stage / unstage / discard, **interactive hunk staging**, a commit composer, branches (checkout / create / delete), log, reflog, remotes, tags, worktrees and stashes — plus push / pull / fetch. Keyboard-driven (`j/k` move · `s/u` stage · `x` discard · `1`–`8` jump to a tab) and **write-gated**, so it's read-only until you opt in.

It also does the three things you would otherwise drop to a terminal for:

**Sync from base.** Pull `main` into the branch you are on, from the header, with the count of what is waiting. Disabled while the tree is dirty — merging over uncommitted work is how you lose it.

**Resolve conflicts.** Conflicted files are listed as what they are — files git has stopped in the middle of, not ordinary edits — so you cannot commit one with `<<<<<<<` still in it. Take a whole file's `ours`/`theirs` for the lockfile case, or open it **one by one** and choose a side per conflict block — or keep both, in either order — with both versions side by side and the common ancestor when git recorded one. Nothing is written until every block has an answer, because defaulting the ones you did not read is exactly how a merge quietly eats somebody's work.

**Undo the merge**, while that is still exactly reversible — only when nothing is committed on top and nothing is pushed. If either is true the button explains why instead of offering you a lie.

![source control panel](.github/assets/git.png)

### 🔀 Pull requests — review one without opening a browser &nbsp;`p`

![pull requests — the files of a change, every diff open at once with a viewed switch per file, under a masthead carrying author, branch, size, reviewers, assignee and milestone; the list beside it filtered to the three waiting on your review](.github/assets/pr.png)

Every open pull request in **one repository at a time** — picked from a repo selector in the panel header, with the repo list discovered from the fleet's own file paths, like the git panel. It opens on **what is waiting on your review**, because that is the question a review dashboard exists to answer; if nothing is waiting it falls through to your own once, so it never lands on an empty pane. **Saved views** — *Needs my review, Mine, Failing, Ready, All* — are a scope and a query under one name, each carrying a live count where the scope is loaded and its last known one everywhere else. Each row carries its checks rolled into one dot (hover for `passed · failed · skipped · running`) and a `here` chip when this checkout is on that branch.

Above the tabs, a **masthead** that survives them: state, number and title, then author, branch, size, reviewers, assignee and milestone, the labels, and a `⋯` menu for the things you do to a pull request rather than in it — retitle, request a review, edit labels, convert to draft, copy the link, hand it to Claude, close it. Open Files and you still know whose change you are reading. Check states arrive in a **second batched pass** after the list itself lands — until it returns the dot is grey and reads `Checks…`, the header says *Loading check states…*, and rows with unknown checks are deliberately kept by the filter rather than hidden. That is what keeps the list itself instant.

**Filter it the way you filter GitHub.** Below the saved views is a query box plus eight multi-select facet menus — **Author, Label, Reviews, Checks, Draft, Base, Assignee, Milestone** — each showing a live count per option, a **Sort** pill, a removable chip per active filter and an "N of M" count. The query string is the single source of truth: `key:value` tokens plus bare words, keys case-insensitive, double quotes for values with spaces (`label:"needs review"`). Keys are `author`, `label`, `review`, `checks`, `is`, `base`, `assignee`, `milestone` and `sort`. Semantics are **OR within a facet, AND across facets** — two authors widens, adding a label then narrows. Bare words match the PR number, title or author, and `sort` takes `recently-updated` (default), `newest`, `oldest`, `most-changed`, `title` or `checks`. Unknown keys, half-typed tokens and unclosed quotes degrade to free text rather than emptying the list. Picking a saved view writes that view's query into the same box, so the chips still show what is on and still take it off again; edit it and the view row says **Custom** rather than claiming you are still in one.

```
author:sirallap label:bug is:draft sort:checks
```

Keyboard-driven both sides: in the list, `j`/`k` (or ↓/↑) move the selection and reset the detail to overview, `/` jumps into the query box, `Esc` clears it. In a PR's **files** tab, `j`/`k` walk the file list, `n`/`p` jump hunk to hunk, `x` marks a file viewed and `↵` folds it — the same keys the File changes modal uses, with the legend on screen. None of them fire while a query or comment box has focus.

Open one and it has **overview · conversation · commits · files · checks · review**. The diff is the app's own viewer — the same `SplitDiff` / `UnifiedDiff` the file-changes panel uses, keybindings and all, rather than a second implementation that drifts — and it reads **per file or per commit**, with merge commits marked as the trunk catch-ups they are so you do not review them as work.

**The conversation is one timeline, and the machines are turned down rather than interleaved.** Reviews, comments, line threads and the events between them read in the order they happened, on a single rail, oldest first or newest first. On a real review, four issue comments were all from CI and one coverage table alone was 46,551 characters, so automation collapses to a digest with the original a click away. Everything a person wrote renders as real markdown at a reading measure, because prose set to the full width of a 2000px window is unreadable however correctly it is formatted. A composer sits at the end, where a conversation ends, with Write and Preview.

**Files opens open.** Every file's diff is expanded from the start — that is how you read a change — and each one mounts as it comes near the viewport, so a sixty-file pull request scrolls instead of stalling; anything over 600 changed lines starts folded, because a regenerated lockfile is not what the tab should open on. Per file there is a **Viewed** switch rather than a tick, since viewed is state you keep for the length of a review, and the bar above carries a path filter, Unified / Split / Wrap, collapse-all and how many of the files you have got through.

**Reviews work the way GitHub's do.** Line comments queue as drafts (a `pending` chip counts them) and go up together as one review — approve, request changes or comment — so a half-finished review never lands in someone's inbox a line at a time. Threads belong to the review that opened them, are anchored to the code they are about, link out when you do want the browser, and the app declines to let you approve your own pull request.

**A PR's overview is also where you act on it.** It leads with whether the thing can land and what is stopping it, each blocker linking to the tab that would fix it. Squash-and-merge (pinned to the head SHA, so a push you have not seen makes GitHub refuse; optionally deleting the branch), enable auto-merge, close, update the branch from base, convert to or from draft, re-run failed checks — merges and closes behind a confirm dialog. The description is **editable in place**, with Write and Preview, and any checklist in it gets a progress bar. And **Review with Claude**: it opens the chat panel on this project with the review prompt already written, pinned to the PR's head SHA and pointed at `gh pr diff` for the change itself. It writes nothing — no fetch, no checkout, no directory left in your repository — and the prompt waits in the composer rather than sending itself, so the run starts when you say so. Same trick behind **Ask Claude why** on a failing check, which hands over the job that broke instead of the whole diff.

Check results notify you only for the pull requests you have a stake in — the ones you authored (**mine**) and the ones waiting on your review. Browsing **all** shows every PR's check state but never pushes a notification, and each PR notifies once per verdict however many checks it runs.

Nothing blocks on the network: the server has one thread, so every read is a cached answer that shows its own age. Check states come back in **one batched GraphQL query** rather than a subprocess per pull request, which is what makes a fifty-row list affordable.

### 🐳 Docker — lazydocker, in the dashboard &nbsp;`o`

Containers, images, volumes and networks in one **stacked column** whose headers never leave — so "is anything dangling?" is answerable without navigating away from the container you are watching. Containers group by compose project with live CPU / memory in aligned columns, and a **dense** toggle drops the image line when you would rather fit more on screen.

Select one and the pane beside it carries **logs · info · env · config · top**, with the logs coloured by level and pinned to the bottom while they stream. **exec** drops you into a shell inside that container — in the console already docked below, so your history and any running job survive it. Start / stop / restart / rm per container, and start / stop / restart across a whole compose project at once (`rm` stays per-container), with each bulk action hidden when it would do nothing. Same keyboard-first feel, same write-gate.

![docker panel](.github/assets/docker.png)

### ▶ Terminal — a real shell, in the dashboard &nbsp;`t`

Not a command-runner imitation: the server opens **your login shell inside a
real PTY** (xterm.js in front, a pseudo-terminal behind a WebSocket), in any
repo/worktree the fleet has touched. Job control, `Ctrl+C` / `Ctrl+R`,
tab-completion, colors, `vim` / `htop` / `lazygit` — everything a local terminal
does. Sessions are **per-repo and persistent**: close the panel mid-build,
reopen later, the job is still running with scrollback intact.

The PTY backend is **POSIX-only**, so on a Windows *host* the Term view is
present but disabled and says why — ConPTY is not implemented yet. The decision
is made on the server, not in the browser, so a Windows *browser* pointed at a
Linux or macOS server still gets a full shell.

The **⚙ commands** menu makes every project command self-explanatory and one
click away — and it covers the **whole selected project**, not just its root:
**Makefile targets with their descriptions** (from `## comment` annotations or
the `# comment` above each target) plus **`package.json` scripts**, discovered
in the repo root *and* its subfolders. A monorepo's nested commands come out
ready to run (`make -C api test`, `bun run --cwd web dev`), grouped by folder
in the menu, each with the right runner (`bun` / `npm` / `pnpm` / `yarn`)
detected from that folder's lockfile. agentglass's own `Makefile` is annotated
this way — `make help` prints the same list in the shell.

Run **tmux** in it and the panel adopts its windows as its own tabs. The list
comes from tmux, the pixels come from agentglass: click to switch, `+` for a new
window, double-click to rename, and tmux's own status line steps aside (one
click brings it back, and it is restored when the panel closes). Nothing about
the keyboard changes — `^b c`, `^b n`, `^b 2` and everything else still go
straight to tmux, and the tabs follow. The point is that the window list stops
being the one strip of the workspace themed by whichever `.tmux.conf` the
machine happens to carry.

**If a shell ever renders solid white,** switch **Settings ▸ Preferences ▸
Terminal renderer** to *Compatibility*. xterm's GPU renderer is fast, but on
some Linux GPU/compositor stacks it paints the terminal blank with no catchable
context-loss event — so the default (**Auto**) uses the GPU on macOS and Windows
and the DOM renderer on Linux. *GPU* forces WebGL back on anywhere; a real
context loss still drops that session to DOM permanently. The choice applies to
newly opened shells, and is separate from `AGENTGLASS_GPU`, which is the
Electron window compositor rather than xterm.

![terminal panel](.github/assets/terminal.png)

### 💬 Chat — drive Claude sessions from the browser &nbsp;`c`

Multi-chat against your **local `claude` CLI**: pick a repo/worktree, a model,
and a permission mode (plan → default / acceptEdits → bypass), then converse —
replies stream in, tool calls appear as chips, and follow-ups resume the same
session. Sessions you start here show up in the fleet like any other agent.

**↩ resume** picks up a session that already exists — including one you started
in a terminal — with its full context intact. Sessions that are still running
are listed but can't be picked: a claude session has a single owner, and a
second writer on the same transcript corrupts its history.

**What a session shows:** the conversation is a **timeline**, not only a chat
log. Tool runs interleave with messages, each tool card carries the head of its
output (so a failing test is distinguishable from a passing one without leaving
the panel), and **subagents** report the parent's session id, so their tool
calls nest under the `Task` call that spawned them and fold away behind a
`… +N tool uses` toggle. Images are sent to the model as image blocks; other
files are quoted into the message. Type `/` in the composer to list and insert
skills/commands (slash commands are enabled in `-p`, they just weren't
discoverable).

---

![chat panel](.github/assets/chat.png)

## Why

agentglass is a **visibility layer, not a harness**: it doesn't run your agents
or impose a workflow on them — it shows you what they're actually doing, and
puts the controls (diff, commit, terminal, docker) next to what it shows.
Everyone's harness is their own; the missing piece is seeing through it.

Most agent dashboards show a live event feed and forget everything on refresh. agentglass adds the layer that actually answers *"what did this cost, what's slow, what's breaking, and how much of my plan is left?"* — across every provider and every project, wrapped in a fast, animated cockpit.

| Feature | What you get |
|---|---|
| 🛰 **Mission-Control cockpit** | Mission clock, live throughput, tool-mix, a sweeping agent radar (distance from centre = context window used — a blip at the edge is about to compact), plain-English event stream, and a "what needs you" alert center. |
| 🗂 **Every project, machine-wide** | A transcript scanner reads every Claude Code session on the machine — history is there on open, new sessions tail in live. Or scope the whole cockpit to one project (or one folder of projects) with the in-app picker. |
| 🖥 **Native desktop app** | Own window + icon and a **self-contained bundled server** — nothing to run in a terminal. Launch-at-login toggle, attaches to a running server instead of duplicating it. |
| 🔬 **Diff & review** | A real diff viewer for everything the fleet changed — Shiki highlighting + word-level diff, split/unified, AI **Explain**, and commit-straight-from-review. |
| 🌿 **Source control** | lazygit in the cockpit: stage, hunk-stage, commit, branch, stash, push/pull — live on any repo the fleet touched (write-gated). |
| 🐳 **Docker** | lazydocker in the cockpit: containers by compose project, live stats, a log viewer, start/stop/restart (write-gated). |
| ▶ **Real terminal** | A true PTY shell (your login shell) per repo/worktree over a WebSocket — persistent sessions, plus a described, ready-to-run list of every Makefile target & package script across the whole project, grouped by folder. |
| 💬 **Claude chat** | Drive local Claude Code sessions from the browser — model + permission-mode picker, streamed replies, resumable sessions that appear in the fleet. |
| 💰 **Cost & tokens** | Per-event, per-session, per-model USD from a tunable pricing table (input / output / cache-write / cache-read). |
| ⏱️ **Tool latency** | `PreToolUse`→`PostToolUse` pairing → real p50 / p95 / max per tool. |
| 📊 **Persistent analytics** | SQLite-backed. `/stats` over any time window survives reloads and restarts. |
| 🌐 **Any provider** | Claude Code hooks **plus** an OpenTelemetry OTLP receiver (`gen_ai.*` spans). Provider is auto-detected from the model **per event**, so a session that switched models is counted under each provider it actually used — then **filter the entire cockpit** (cost, tools, latency, sessions, radar…) by provider. A model no rule recognises lands in a real **Unknown** bucket you can select, rather than disappearing from every filtered view. |
| 🤖 **Per-model breakdown** | Cost & token split across every model — Claude, GPT, Gemini, and more — from a tunable pricing table. |
| 🧵 **Session lifecycle** | Timeline of every session: start→end, duration, tokens, cost. |
| 📈 **Anthropic plan usage** | 5-hour + weekly plan-limit meters — shown only when you're viewing Anthropic (the one provider with a usage API), on wide screens. |
| ⌨ **Command palette + shortcuts** | `Ctrl-K` to filter, switch theme, change window, export; `d` diffs · `g` git · `p` pull requests · `o` Docker · `t` terminal · `c` chat · `k` skills · `s` stats · `/` search; click any event for full details; click an agent to filter to it. |
| 🎨 **22 themes** | 11 dark palettes (Midnight Purple, Forest, Ember, Nord, …), each with a light twin — instant switch, remembered. |
| 🔔 **Push alerts** | Webhook (Slack/Discord) + desktop notify + optional in-app chime on approvals and errors. |
| 📤 **Export** | One-click CSV / JSON of all events. |

### Themes

22 palettes — 11 dark, each with a light twin. A few:

| Forest | Ember | Deep Sea |
|---|---|---|
| ![forest](.github/assets/theme-forest.png) | ![ember](.github/assets/theme-ember.png) | ![deep sea](.github/assets/theme-deep-sea.png) |

Every dark palette has a matching light twin — e.g. Midnight Purple Light:

![light theme](.github/assets/theme-light.png)

---

## Quickstart

agentglass is a **desktop app**. Grab the installer for your platform from
[**Releases**](https://github.com/SirAllap/agentglass/releases/latest), launch
it, and the cockpit opens with its own server bundled inside. Nothing to run in
a terminal, no port to open in a browser.

| Linux | macOS |
| --- | --- |
| `.AppImage` (chmod +x, run it) or `.deb` | `.dmg`, Apple Silicon and Intel |

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
| [D-Bus tools](https://www.freedesktop.org/wiki/Software/dbus/), [libnotify](https://gitlab.gnome.org/GNOME/libnotify), [xdg-utils](https://www.freedesktop.org/wiki/Software/xdg-utils/) | Mirroring desktop notifications onto the notch, alerts when no window is open, opening their links (Linux) | Those notifications simply do not appear |
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
  racing a second one against the same database.
- **Clean lifecycle** — the bundled server is a child process, killed when the
  app exits. If the app dies hard, the server's own watchdog notices it was
  orphaned (`AGENTGLASS_DIE_WITH_PARENT`, armed by the shell) and exits rather
  than lingering on the port.
- **Launch at login** — an in-app toggle, no file editing.
- **Keeps full history** — the desktop app defaults `AGENTGLASS_RETENTION_DAYS=0`.

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
  nothing on your network can reach it. By default there is **no authentication**,
  because on a single-user machine "can reach localhost" already means "is you".
- **Optional shared-secret token.** Set `AGENTGLASS_TOKEN` and every route but
  the append-only telemetry sinks (`/ingest`, the OTLP receivers) requires it —
  `Authorization: Bearer <token>` for the API, `?token=<token>` on the dashboard
  URL (it's stored and stripped from the address bar). This is what makes a
  shared machine or a network bind safe, and it stops *other local processes*
  from opening the shell. Binding a non-loopback address **without** a token
  refuses to run unauthenticated: it mints one, prints it, and saves it
  `0600` under your config dir on POSIX (Linux/macOS). Windows has no POSIX
  mode bits, so there the file falls back to your account's default ACL.
- **Websites you visit can't touch it.** Every request is origin-checked, the
  shell and the live stream require a verified local origin, and a Host-header
  guard blocks DNS-rebinding tricks (browsers can't forge `Host`). Running it
  behind a reverse proxy? Allow its name via `AGENTGLASS_ALLOWED_HOSTS`.
- **⚠️ Shared / multi-user machines are NOT the default home.** `localhost`
  belongs to the *machine*, not to your account — on a box where other people
  also have accounts, any of them could reach the server and its shell **as
  your user**. Set `AGENTGLASS_TOKEN` to lock it to you, and/or disable the
  capability surfaces: `AGENTGLASS_TERMINAL_DISABLED=1`, `AGENTGLASS_FS_BROWSE_DISABLED=1`,
  `AGENTGLASS_CHAT_DISABLED=1`, `AGENTGLASS_GIT_WRITE_DISABLED=1`,
  `AGENTGLASS_DOCKER_WRITE_DISABLED=1`.
- **⚠️ Exposing it to a network is a three-part deliberate act.** `AGENTGLASS_BIND=0.0.0.0`
  hands the shell, git write and Docker control to that network. Do it only with
  a token set **and** `AGENTGLASS_TRUST_LAN=1` (off by default, LAN browsers are
  refused as cross-origin without it), and only on a network you fully trust.
- **⚠️ Browser-driven autonomy is opt-in.** The Chat panel's `bypassPermissions`
  mode (`claude --dangerously-skip-permissions`) is honored only when
  `AGENTGLASS_CHAT_BYPASS=1`; otherwise it's downgraded to a prompting default.
- **Your data stays local.** Events live in a local SQLite file, written
  owner-only (`0700` dir, `0600` file) on POSIX; on Windows, which has no POSIX
  mode bits, it falls back to your account's default ACL. Outbound calls are few and all of them are yours to
  switch off: the optional Anthropic plan-usage meter (`api.anthropic.com`,
  using your own credentials), the update check against the GitHub releases API,
  the **Pull requests** panel through your own authenticated `gh` CLI, the AI
  **Explain** walkthrough through a local `claude` (or your `ANTHROPIC_API_KEY`),
  and anything *you* configure (webhook alerts).

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
gating every call. Denying returns a `PreToolUse` deny with your reason.

Want the opposite trade-off? Set `AGENTGLASS_GATE_FAILCLOSED=1` and a timeout or
an unreachable control plane **denies** instead of allows — the fleet stops
until you decide. Off by default; turn it on only when blocking is safer than
proceeding, and remember agentglass being down then blocks every gated call.

---

## Any provider — via OpenTelemetry (OpenAI, Gemini, Bedrock, …)

agentglass isn't Claude-only. It exposes an **OTLP/HTTP** trace receiver that
maps OpenTelemetry **GenAI** spans (the `gen_ai.*` semantic conventions) into the
same events the dashboard already understands — so anything emitting GenAI
telemetry streams in: the OpenAI / Google / Bedrock SDK instrumentations,
LangChain, LiteLLM, OpenLLMetry, and Claude Code's own OTel export.

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

### Anything else — point its OTLP exporter here

The receiver accepts OTLP/HTTP in **both protobuf (the SDK default) and JSON**, so
no Collector is needed — just aim any exporter's endpoint at the server:

```bash
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4000
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
inference, prompt) to an event the same way.

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
| `AGENTGLASS_DB` | `~/.local/share/agentglass/agentglass.db` | SQLite file path. The default lives under `$XDG_DATA_HOME` (or `~/.local/share`), created `0700`; a pre-existing `agentglass.db` in the working directory wins, which is what keeps a checkout's `bun run dev` on its own database. |
| `AGENTGLASS_ROOT` | — | Scope the whole cockpit to one project (repo + worktrees) or a folder of projects. Unset = every project on the machine. Also set by passing a directory to the desktop app; the in-app **project picker** sets/clears the same scope at runtime and persists it as `root` in the config file (note: the env var, when set, wins again on the next launch). |
| `AGENTGLASS_REPO_DIRS` | — | Colon-separated dirs to sweep for git repos (git / terminal / chat panels). Also settable as `repoDirs` in the config file. |
| `AGENTGLASS_PROJECTS_DIR` | `~/.claude/projects` | Root the transcript scanner reads Claude Code session logs from. Several roots can be listed, separated by the platform's `PATH` delimiter (`:` on Linux/macOS, `;` on Windows). |
| `AGENTGLASS_SCAN_INTERVAL_MS` | `3000` | Transcript scan poll interval (min 500). |
| `AGENTGLASS_SCAN_DISABLED` | — | `1` → turn off the machine-wide transcript scanner (rely on hooks / OTel only). |
| `AGENTGLASS_RETENTION_DAYS` | `8` | Days of history to keep (pruned hourly). Covers the full 7d stats window; `0` = keep forever. |
| `AGENTGLASS_PRICING` | — | Path to a JSON pricing override (see `server/src/pricing.ts`). |
| `AGENTGLASS_WEBHOOK` | — | POST `{text}` alerts here (Slack/Discord compatible). |
| `AGENTGLASS_NOTIFY` | — | `1` → fire desktop alerts. A connected client (browser or desktop app) raises a **native OS notification** on any platform; `notify-send` is the fallback for a headless server with nothing attached to show it. |
| `AGENTGLASS_SERVER` | `http://localhost:4000` | Used by the hook/seed scripts. |
| `VITE_CW_SERVER` | `http://<host>:4000` | UI → server URL (build/dev time). Unset, the UI resolves same-origin when the server itself served it (single-port mode), `:4000` otherwise. |
| `AGENTGLASS_GIT_WRITE_DISABLED` | — | `1` → make the **Source control** panel read-only (no stage / commit / push). Also makes the **Pull requests** panel read-only — no merge, close, review submit or branch update. |
| `AGENTGLASS_DOCKER_WRITE_DISABLED` | — | `1` → make the **Docker** panel read-only (no start / stop / restart / rm). |
| `AGENTGLASS_TERMINAL_DISABLED` | — | `1` → disable the in-browser **Terminal** entirely (no PTY shells are spawned). Also settable as `"terminalDisabled": true` in `config.json`, so it is reachable from a desktop-launched app that inherits no env; the env var overrides the file when set. Moot on Windows, where the terminal is already off — the PTY backend is POSIX-only. |
| `AGENTGLASS_EDITOR_DISABLED` | — | `1` → refuse **open in editor**, so the app cannot hand a path to a live nvim or `$EDITOR`. |
| `AGENTGLASS_GPU` | — | `1` → opt an Electron window back into full GPU compositing. The desktop shell composites the final frame on the CPU on Linux by default, because some GPU/compositor stacks paint the window white. Unrelated to the terminal's own renderer setting. |
| `AGENTGLASS_MAX_TERMINALS` | `200` | Ceiling on concurrent PTY sessions. |
| `AGENTGLASS_AUTOFETCH_SECONDS` | `60` | How often the git panel fetches in the background. |
| `AGENTGLASS_GIT_TIMEOUT_SECONDS` | `120` | Ceiling on a single git subprocess. |
| `AGENTGLASS_FS_BROWSE_DISABLED` | — | `1` → disable directory completion in the project picker (`/fs/complete`). Separate from the terminal switch on purpose: disabling the shell should not leave the directory tree readable. |
| `AGENTGLASS_CHAT_DISABLED` | — | `1` → disable the **Chat** panel (no `claude` sessions can be started from the browser). |
| `AGENTGLASS_CHAT_BYPASS` | — | `1` → allow the Chat panel's `bypassPermissions` mode (`claude --dangerously-skip-permissions`). Off by default: the mode is downgraded to a prompting default unless you opt in. |
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

## API

| Route | Description |
|---|---|
| `POST /ingest` | Ingest an event `{source_app, session_id, hook_event_type, payload?, chat?, model_name?}`. |
| `POST /v1/traces` | OTLP/HTTP (JSON + protobuf) — maps OpenTelemetry `gen_ai.*` spans to events (any provider). |
| `POST /v1/logs` | OTLP/HTTP (JSON + protobuf) — maps OpenTelemetry GenAI log records to events (e.g. Codex CLI). |
| `GET /events/recent?limit=` | Latest events. |
| `GET /events/filter-options` | Distinct apps / event types / models. |
| `GET /projects` | Known projects (filtered to the active scope) + the current workspace. |
| `POST /workspace` | Scope the cockpit to a project / folder at runtime (`{root}`; `null` → whole machine). Applied live, persisted to the config file — this is what the in-app project picker calls. |
| `GET /sessions?limit=` | Session rollups. |
| `GET /stats?window=<ms>` | Full analytics summary (totals, by-model, tool latency, timeline). |
| `GET /skills` | Skill/command catalog scanned from `~/.claude` + `$AGENTGLASS_CODE_DIR/*/.claude`, joined with recorded usage. |
| `GET /changes?limit=` | Recent file changes (Edit/Write) as diff hunks — feeds the **File changes** diff viewer. |
| `POST /walkthrough` | AI **Explain** — a local-Claude walkthrough of a set of diffs (per-file summary + review focus). |
| `GET /git/tree · /repos · /branches · /log · /graph · /worktrees · /stashes · /commit-diff` · `POST /git/status` | Live working-tree, branches, log/graph, worktrees & stashes for a repo (read). `/repos` honours the active scope; `?all=1` lists the whole machine (what the project picker uses). |
| `POST /git/{stage,unstage,discard,commit-staged,push,pull,fetch,checkout,branch-*,stash-*,apply-hunk,merge,rebase,reset,worktree-*}` | Mutating git ops — **gated** by `AGENTGLASS_GIT_WRITE_DISABLED`. |
| `GET /docker/overview · /stats · /logs · /inspect · /top` | Containers / images / volumes / networks, live CPU-mem stats, container logs, environment & config, running processes. |
| `POST /docker/{start,stop,restart,rm}` | Container actions — **gated** by `AGENTGLASS_DOCKER_WRITE_DISABLED`. |
| `GET /git/conflicts · /conflict-blocks` · `POST /git/resolve · /resolve-blocks · /sync-base · /merge-abort · /merge-continue · /undo-merge` | Mid-merge state: which files are conflicted, the `<<<<<<<` blocks inside one, and taking a side per file or per block. Sync a branch from its base, and undo the last merge while that is still exactly reversible. Write-gated. |
| `GET /update/status · /update/log` · `POST /update/run` | The running version, the newest published release tag, and building it. **Desktop-shell origin only** — refused (403) for a browser, another machine, or a caller with no `Origin` at all, because it is the one route that executes arbitrary code. |
| `WS /terminal/pty?root=&cols=&rows=` | A **real PTY shell** in a repo/worktree — raw bytes out, `{t:"in"\|"resize"}` frames in. Gated by host platform (**never available on Windows** — no POSIX PTY backend), by `"terminalDisabled"` in `config.json`, and by `AGENTGLASS_TERMINAL_DISABLED`; `GET /terminal/commands` carries the reason (`windows` \| `config` \| `env`) so the panel can say which. |
| `GET /terminal/commands?root=` | Ready-to-run project commands: Makefile targets **with descriptions** + `package.json` scripts (runner-aware), from the repo root **and its subfolders** (`make -C …`), grouped by folder. |
| `GET /chat/enabled` · `POST /chat/send` | Drive a local `claude` session in a repo (streamed JSONL) — gated by `AGENTGLASS_CHAT_DISABLED`. `send` takes an optional `engine` (`process` \| `tmux`). |
| `GET /chat/attach` | The `tmux attach` command for a chat running on the pane engine, and whether its pane is still up. |
| `GET /prs/capability · /prs/list · /prs/detail · /prs/diff · /prs/commit-diff · /prs/branch-url` | Pull requests through the `gh` CLI, per repository: capability probe, the list for a scope tab, one PR's full detail, its diff, a single commit's diff. Cached, with check states filled by a second batched GraphQL pass. |
| `POST /prs/{review,review-with,comment,reply,thread-resolved,react,edit,labels,reviewers,draft,update-branch,rerun,merge,close}` | Pull-request actions — **gated** by `AGENTGLASS_GIT_WRITE_DISABLED` and by the active scope. |
| `POST /prs/review-prompt` | The prompt to review a PR with Claude, and the directory to run it in. Reads only, so the write switch does not gate it; the active scope still does. |
| `GET /hooks/status` · `POST /hooks/install · /hooks/uninstall` | Whether the Claude Code hooks are wired into `~/.claude/settings.json`, and wiring or removing them — what **Settings ▸ Hooks** calls, so a packaged app needs no clone. |
| `GET /health` | Liveness plus an identity marker (`service: "agentglass"`), so a client can tell our server from a stranger on the same port. Token-exempt. |
| `GET /usage` | Anthropic plan-limit windows (5-hour / weekly) for the usage meters. |
| `GET /session?id=` | Full detail for one session (events, files, totals). |
| `GET /insights` | Derived warnings — loops, fast burn, high failure rate, spend velocity. |
| `GET /search?q=` | Full-text search across all captured prompts/commands/outputs. |
| `POST /gate` · `GET /gate/pending` · `POST /gate/decide` | Control-plane approve/deny for the opt-in `PreToolUse` gate. |
| `POST /control` | Drive the dashboard's own UI (switch view, toggle workspace, theme, zoom, new chat) from an external controller — a Stream Deck, a phone. Validated then rebroadcast on `/stream`; changes only what's shown, grants no capability the keyboard doesn't. See [`docs/EXTENDING.md`](docs/EXTENDING.md). |
| `GET /export?format=csv\|json` | Download all events. |
| `WS /stream` | Live frames — `initial` · `openTools` · `event` · `session` · `git` · `ci` · `alert` · `control`. Read-only: the socket never accepts commands. |

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
                                                       │      ├─ alerts.ts       webhook / desktop push
                                                       │      ├─ gitwork.ts      live working tree (lazygit)
                                                       │      ├─ docker.ts       live containers (lazydocker)
                                                       │      ├─ terminal.ts     real PTY shells over WS (+ make/script catalog)
                                                       │      ├─ chat.ts         drive local `claude` sessions (stream-json)
                                                       │      ├─ gate.ts         approve/deny control plane
                                                       │      ├─ walkthrough.ts  local-Claude "Explain" of a diff set
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
- Windows: a usable terminal panel (ConPTY) — the honest disable already ships — [#98](https://github.com/SirAllap/agentglass/issues/98)

**Next**
- Per-agent changes scoped to each session's worktree/branch — [#117](https://github.com/SirAllap/agentglass/issues/117)
- Warn when parallel agents collide on shared runtime the diff can't see — [#118](https://github.com/SirAllap/agentglass/issues/118)
- A gate that can hold by rule (spend, allowlist), not only by hand — [#109](https://github.com/SirAllap/agentglass/issues/109)
- Per-project gate policies and hook profiles — [#14](https://github.com/SirAllap/agentglass/issues/14)
- Keep model prices fresh without hand-editing the table — [#9](https://github.com/SirAllap/agentglass/issues/9)

**Later / exploring**
- An API panel to exercise the endpoints the fleet is building — [#170](https://github.com/SirAllap/agentglass/issues/170)
- Tasks per project, and a decision log mined from transcripts — [#12](https://github.com/SirAllap/agentglass/issues/12), [#13](https://github.com/SirAllap/agentglass/issues/13)
- A phone-friendly view for monitoring and answering gate approvals — [#7](https://github.com/SirAllap/agentglass/issues/7)
- Voice input in chat — [#92](https://github.com/SirAllap/agentglass/issues/92)

**Recently shipped** — see the [releases](https://github.com/SirAllap/agentglass/releases) for the full record.
- **unreleased** — a slow tool call is told from a hung one by evidence rather than by a timer, per tool class, with "can't tell" as a real answer ([#134](https://github.com/SirAllap/agentglass/issues/134)); the UI says so when something other than agentglass owns `:4000`.
  - **The numbers got audited.** A client clock that disagrees with the server no longer skews every window ([#245](https://github.com/SirAllap/agentglass/issues/245)); provider is attributed **per event** rather than per session, and sessions whose model was never resolved get a real **Unknown** bucket instead of vanishing from every filter ([#246](https://github.com/SirAllap/agentglass/issues/246)); a token delta that spans a model switch is priced per its own model ([#247](https://github.com/SirAllap/agentglass/issues/247)); insights are scoped to the open project like every other metric, and the `/stats` timeline stopped dropping the newest events ([#248](https://github.com/SirAllap/agentglass/issues/248)).
  - **Pull requests.** Check states load in **one batched GraphQL query** instead of a subprocess per PR ([#249](https://github.com/SirAllap/agentglass/issues/249)); GitHub-style facet filters and a query bar; keyboard navigation in the files tab; and CI results notify you only for the PRs you authored or were asked to review ([#244](https://github.com/SirAllap/agentglass/issues/244)).
  - **Desktop.** The Claude Code hooks ship inside the app and wire from **Settings ▸ Hooks**, so a packaged install needs no clone ([#187](https://github.com/SirAllap/agentglass/issues/187)); self-update is gated off on Windows rather than shelling to `bash` ([#189](https://github.com/SirAllap/agentglass/issues/189)); push alerts are delivered cross-platform, not only through `notify-send` ([#192](https://github.com/SirAllap/agentglass/issues/192)); and two Linux rendering faults — a white-out on the final frame and a blank terminal from WebGL context loss — are fixed, with a **Terminal renderer** setting to override the default.
  - **Supply chain.** CodeQL and Dependabot now watch the repo ([#169](https://github.com/SirAllap/agentglass/issues/169)), and a privacy-first diagnostic scrubber built from an allowlist landed for the reporting paths ([#207](https://github.com/SirAllap/agentglass/issues/207)).
  - **From the community.** `POST /control`, so a Stream Deck or a phone can drive the cockpit's own UI ([#237](https://github.com/SirAllap/agentglass/issues/237), thanks [@Yoshiofthewire](https://github.com/Yoshiofthewire)); the terminal disabling itself honestly on Windows at the server seam ([#140](https://github.com/SirAllap/agentglass/issues/140), thanks [@emre155](https://github.com/emre155)); and every deprecated GitHub Action brought up to a current major ([#242](https://github.com/SirAllap/agentglass/issues/242), thanks [@mvanhorn](https://github.com/mvanhorn)).
- **v0.5.0** — pull request review inside the cockpit, and the freeze is gone: the event loop is watched, and every expensive git, docker and database read left the thread that carries the terminal
- **v0.4.0** — evidence-of-life signal for open tool calls; the shell no longer adopts a stranger's server on `:4000`
- **v0.3.0** — in-app merge-conflict resolution, whole-project docker controls, a rearrangeable workspace, and an in-app updater
- **v0.2.x** — downloadable installers for Linux / macOS / Windows, the Electron desktop shell, and a real chat panel

---

## Contributing

PRs welcome. If you want to adapt agentglass to another agent or harness without forking, start with [`docs/EXTENDING.md`](docs/EXTENDING.md) — OTLP ingest, the gate primitive, themes, and config surfaces are already there.

Issues and PRs welcome — see [CONTRIBUTING.md](CONTRIBUTING.md). Small, fast, and
dependency-light on purpose: a Bun/SQLite server, a React/Vite UI, an Electron
desktop shell, and a stdlib-only Python hook forwarder.

## About

Built by [**@SirAllap**](https://github.com/SirAllap) (David Pallares).
Original work — not a fork. Not affiliated with or endorsed by Anthropic;
"Claude" and "Claude Code" are trademarks of Anthropic.

## License

MIT © 2026 David Pallares — see [LICENSE](LICENSE).
