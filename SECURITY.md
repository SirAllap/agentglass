# Security Policy

agentglass is a **local-first developer tool**: the server is designed to run on
`localhost`, and it can stage/commit/push git, merge pull requests, control
Docker, open real shells, start `claude` sessions and open files in your editor
on the machine it runs on. Treat the server port like you would treat `sshd` on
your workstation — do not expose it to the public internet.

A LAN is **not** trusted by default. Reaching the server from another machine is
a deliberate three-part act: bind off loopback, set `AGENTGLASS_TRUST_LAN=1`, and
carry a token. See [Trust model](#trust-model) below.

## Supported versions

Only the latest `main` is supported. There are no LTS branches; fixes land on
`main` and ship immediately. Installed desktop builds track **release tags**
rather than the branch tip, so a fix reaches them when it is tagged — the in-app
updater (POSIX only) offers the newest tag, and Windows installs update by
downloading the installer again.

## Automated scanning

The repository is watched by **CodeQL** (code scanning) and **Dependabot**
(GitHub Actions updates), and a secret scanner runs over every push. These
complement, rather than replace, the private reporting path below.

## Trust model

- **Origin and Host gates.** Every route is behind a same-origin/private-host
  check, plus a DNS-rebinding guard that refuses a request arriving under a
  `Host` that is not localhost or private (`AGENTGLASS_ALLOWED_HOSTS` allows a
  reverse-proxy name explicitly).
- **Token.** `AGENTGLASS_TOKEN` is required on every route except the telemetry
  intake sinks (`/ingest`, the OTLP receivers) and `/health`, which stay
  tokenless because local hooks and OTel exporters have no way to carry a
  secret. Binding off loopback — **or setting `AGENTGLASS_TRUST_LAN=1` at all** —
  makes a token mandatory; if none is set the server mints, persists (`0600`) and
  prints one.
- **Intake is rate-limited** rather than authenticated: `AGENTGLASS_RATE_MAX`
  requests per source-address+route inside `AGENTGLASS_RATE_WINDOW_MS`.
- **Desktop-only routes.** The self-update route executes arbitrary code and is
  reachable from the packaged shell's own origin and nothing else — not from a
  browser, not from another machine.
- **Root escalation, once, with a visible prompt.** Rescuing a worktree whose
  files another user owns shells out to `pkexec chown`, so the desktop's own
  password dialog is what authorises it. The path is validated first, precisely
  so a crafted root cannot point a privileged `chown -R` somewhere else.
- **The control plane is fail-open by default.** A `PreToolUse` gate that times
  out (`AGENTGLASS_GATE_TIMEOUT`, 60s) falls through rather than blocking your
  agents. Set `AGENTGLASS_GATE_FAILCLOSED=1` if you would rather a timeout or an
  unreachable control plane denied the call.

## Reporting a vulnerability

Please **do not open a public issue** for security problems.

Use GitHub's private vulnerability reporting instead:
**[Report a vulnerability](https://github.com/SirAllap/agentglass/security/advisories/new)** —
it opens a private thread with the maintainer.

Please include:

- What an attacker can do, and from where (same machine · LAN · a webpage the
  user visits — e.g. anything that bypasses the origin guard on mutating routes)
- Steps or a proof-of-concept to reproduce
- The commit/version you tested

You can expect an acknowledgement within a few days. Once a fix ships, the
report can be published as an advisory with credit to you (unless you prefer to
stay anonymous).

## Hardening knobs

Each capability has its own switch — see the README's configuration table for
the full list and defaults:

| Knob | Turns off |
|---|---|
| `AGENTGLASS_TERMINAL_DISABLED` | PTY shells (also `"terminalDisabled"` in `config.json`; always off on Windows) |
| `AGENTGLASS_CHAT_DISABLED` | starting `claude` sessions from the browser |
| `AGENTGLASS_GIT_WRITE_DISABLED` | git mutations **and** every pull-request action |
| `AGENTGLASS_DOCKER_WRITE_DISABLED` | container start/stop/restart/rm |
| `AGENTGLASS_COMMIT_DISABLED` | the diff viewer's commit composer |
| `AGENTGLASS_FS_BROWSE_DISABLED` | directory completion in the project picker |
| `AGENTGLASS_EDITOR_DISABLED` | opening a file in your editor from the app |
| `AGENTGLASS_SCAN_DISABLED` | the machine-wide transcript scanner |
| `AGENTGLASS_GATE_FAILCLOSED=1` | *(opposite sense)* makes the gate deny on timeout instead of allowing |

Two things are **not** individually switchable, and it is worth knowing which:
the AI **Explain** walkthrough (it follows `AGENTGLASS_COMMIT_DISABLED`'s
surface but has no knob of its own) and the `/control` UI-navigation endpoint,
which is unswitchable by design — it grants no capability the keyboard does not
already have.

Beyond the knobs, **scope is itself a boundary**: with a project open, git
writes, the terminal, chat, pull-request actions and editor opens are all
refused outside it.
