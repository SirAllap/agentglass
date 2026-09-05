<div align="center">

<img src=".github/assets/logo.svg" alt="agentglass" width="88" height="88" />

# agentglass

**agentglass doesn't replace your agents. It attaches to the tmux sessions and repos already open on your machine, and puts every tool call, dollar and dangerous command on one screen — at your desk or in your pocket.**

[![▶ Live demo](https://img.shields.io/badge/▶%20Live%20demo-try%20it%20now-6366f1?style=for-the-badge)](https://sirallap.github.io/agentglass/demo/)

<a href="https://trendshift.io/repositories/86777?utm_source=trendshift-badge&amp;utm_medium=badge&amp;utm_campaign=badge-trendshift-86777" target="_blank" rel="noopener noreferrer"><img src="https://trendshift.io/api/badge/trendshift/repositories/86777/daily?language=TypeScript" alt="SirAllap%2Fagentglass | Trendshift" width="250" height="55"/></a>

![stack](https://img.shields.io/badge/server-Bun%20%2B%20SQLite-black) ![ui](https://img.shields.io/badge/ui-React%20%2B%20Vite%20%2B%20Motion%20%2B%20Shiki-61dafb) ![desktop](https://img.shields.io/badge/desktop-Electron%20app-47848f) ![phone](https://img.shields.io/badge/phone-signed%20Android%20APK-3ddc84) ![themes](https://img.shields.io/badge/themes-22-a78bfa) ![license](https://img.shields.io/badge/license-MIT-green)

![agentglass in action — the live cockpit, then the workspace: source control, diff review, pull requests, tasks, Docker, chat and a file browser, one keystroke away](.github/assets/hero.gif)

</div>

## What it does

**Every agent on one screen.** Claude Code, Codex, Gemini CLI and OpenCode, in
the tmux sessions and repositories already open on your machine. Every tool
call as it happens, what each is costing, where the time goes, which session is
stuck in a loop, what files it touched. agentglass does not launch them and
does not replace them — it attaches to what is already running.

**It tells you who needs you.** The **Lantern** leads with one question and
answers it: red for an agent stopped on a permission gate, amber for one that
finished a turn and is waiting for you to type. Every agent is a card — model,
branch, what it is doing this second, cost, turns, errors, and how long before
its prompt cache goes cold. A watch re-reads it every few minutes and sends one
notification when somebody has been left hanging.

**Nothing dangerous runs unwatched.** A tool call you decided to gate is held
until you allow it, from the desk or from your phone. The queue is on disk, so
a crash cannot silently auto-allow.

**It is a place to work, not a dashboard.** Read the diff the agent just wrote,
review a pull request through to a verdict, run git and docker, drop into a real
terminal with real tmux panes, drive a browser your agents can use. From a
[native Android app](https://github.com/SirAllap/agentglass/releases/latest) too.

![the workspace: source control, diff review, pull requests, tasks, Docker and a file browser](.github/assets/dashboard.png)

## Install

A desktop app with its own server inside it: nothing to run in a terminal, no
port to open in a browser. Take the build for your platform from
[**Releases**](https://github.com/SirAllap/agentglass/releases/latest) and
launch it — Linux (`.AppImage`, `.deb`), macOS (`.dmg`, Apple silicon and
Intel), Windows (`.exe`) and the Android companion (`.apk`).

On macOS the build is not signed yet, so Gatekeeper calls it damaged. It is
not: `xattr -dr com.apple.quarantine /Applications/agentglass.app`, once.

Or run it from source:

```bash
git clone https://github.com/SirAllap/agentglass && cd agentglass
bun install && bun run dev          # http://localhost:4000
python3 hooks/install_hooks.py      # so Claude Code reports to it
```

Full instructions, every platform's caveats and the requirements it expects to
find: [**docs/INSTALL.md**](docs/INSTALL.md).

## Local, and it stays that way

Your machine holds everything: a SQLite file on your own disk, no account, no
cloud, nothing phoned home. The phone reaches the desk over your own network,
paired by a code you scan, at a scope you choose — read, answer, or full.

Two paths leave the machine and both are opt-in and off by default: a webhook
you configure yourself, and the Explain button, which sends the hunks you point
at to a model. Read [**SECURITY.md**](SECURITY.md) before you install: what is
stored, what is exposed, what each token can do, and every switch that turns a
capability off.

## Documentation

| | |
| --- | --- |
| [**INSTALL.md**](docs/INSTALL.md) | Installing, updating, requirements, the desktop app, the control plane, and running against any provider — Kimi, OpenAI, Gemini, Bedrock |
| [**WORKSPACE.md**](docs/WORKSPACE.md) | Every view and what it is for: the rail, the Clone, the Lantern, the terminal, keyboard shortcuts, themes |
| [**CONFIG.md**](docs/CONFIG.md) | Every environment variable the code reads, the whole HTTP API, and the architecture |
| [**SECURITY.md**](SECURITY.md) | The trust model, what each surface can reach, retention, and how to report a vulnerability |
| [**EXTENDING.md**](docs/EXTENDING.md) | Driving agentglass from your own harness, and writing a plugin |
| [**PLUGINS.md**](docs/PLUGINS.md) | What a plugin is, what it may ask for, and how to publish one |
| [**CHANGELOG.md**](CHANGELOG.md) | What each release changed |

## Two things worth knowing about

**Worktrees start with what git leaves out.** `git worktree add` copies the
tracked tree and nothing else — no `.env`, no local settings — and a new
checkout does not start without them. A `.worktreeinclude` at the repository
root names the ignored paths every worktree agentglass cuts should carry in.

**The terminal has two keyboard tricks.** `Ctrl+Shift+Space` letters the paths,
links, hashes and ids on a pane's screen so one key pastes one back. And
selecting something in a pane offers to ask the agent in that pane about it.

## Roadmap

Themes, not dates. The living version is the issue tracker; the
[`help wanted`](https://github.com/SirAllap/agentglass/labels/help%20wanted)
label is where to start.

**Now**
- Signing and notarization for the macOS build, so Gatekeeper stops calling it damaged
- Warn when parallel agents collide on shared runtime the diff cannot see — [#118](https://github.com/SirAllap/agentglass/issues/118)
- Say when two live sessions share one working tree, instead of attributing the changes to whichever asked last — [#117](https://github.com/SirAllap/agentglass/issues/117)

**Next**
- A gate that can hold by rule — a tool allowlist beside the spend threshold that already works — [#109](https://github.com/SirAllap/agentglass/issues/109)
- Per-project gate policies and hook profiles — [#14](https://github.com/SirAllap/agentglass/issues/14)
- Let an agent query the cockpit over MCP: what is running, what it costs, what is held — [#296](https://github.com/SirAllap/agentglass/issues/296)
- Keep model prices fresh without hand-editing the table — [#9](https://github.com/SirAllap/agentglass/issues/9)
- Verify the Windows build on real hardware — [#231](https://github.com/SirAllap/agentglass/issues/231), [#195](https://github.com/SirAllap/agentglass/issues/195)

**Later / exploring**
- Review a local diff in place and send the whole review as one prompt — [#294](https://github.com/SirAllap/agentglass/issues/294)
- An API panel to exercise the endpoints the fleet is building — [#170](https://github.com/SirAllap/agentglass/issues/170)
- Tasks per project, and a decision log mined from transcripts — [#12](https://github.com/SirAllap/agentglass/issues/12), [#13](https://github.com/SirAllap/agentglass/issues/13)

Shipped so far, newest first: [**CHANGELOG.md**](CHANGELOG.md) and the
[releases](https://github.com/SirAllap/agentglass/releases).

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
