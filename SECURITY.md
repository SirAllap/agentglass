# Security Policy

agentglass is a **local-first developer tool**: the server is designed to run on
`localhost`, and it can stage/commit/push git, merge pull requests, control
Docker, open real shells, start `claude` sessions and open files in your editor
on the machine it runs on. Treat the server port like you would treat `sshd` on
your workstation — do not expose it to the public internet.

A LAN is **not** trusted by default. Reaching the server from another machine is
a deliberate three-part act: bind off loopback, set `AGENTGLASS_TRUST_LAN=1`, and
carry a token. See [Trust model](#trust-model) below.

The desktop app performs all three as one switch (Settings › Remote), which
mints the token itself and shows the URL as a QR code. It is off by default, it
states in plain words what turning it on grants to everyone on the network, and
turning it off closes the port rather than merely hiding the link.

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
- **Hooks refuse to send anywhere but this machine.** The hook and seed scripts
  post full session transcripts, and their destination — `AGENTGLASS_SERVER` —
  is attacker-influenceable: a repo-local `settings.json` can set it, so cloning
  a repository could otherwise redirect your prompts and file contents to
  somebody else's host. Anything that is not `localhost` / `127.0.0.1` / `::1`
  is refused with a message on stderr, and the script exits 0 so a hostile
  setting cannot break the agent either. `AGENTGLASS_ALLOW_REMOTE=1` is the
  explicit opt-out, for the case where the server genuinely runs elsewhere.
- **Desktop-only routes.** The self-update route executes arbitrary code and is
  reachable from the packaged shell's own origin and nothing else — not from a
  browser, not from another machine.
- **The token is never re-served to the network.** `/remote/status` reports where
  the server is reachable and whether a device has arrived, but includes the
  token itself only for a caller on this machine (a loopback peer address). A
  page loaded over the LAN already holds the token; handing it back out would
  turn one leaked link into a permanent credential for anything on the wifi.
- **Tailnet addresses.** CGNAT (`100.64.0.0/10`, what Tailscale assigns) counts
  as private under `AGENTGLASS_TRUST_LAN=1`, alongside RFC1918. It is reachable
  only across an authenticated, encrypted mesh, so it is a narrower grant than
  trusting a wifi network, and it rides the same opt-in.
- **Root escalation, once, with a visible prompt.** Rescuing a worktree whose
  files another user owns shells out to `pkexec chown`, so the desktop's own
  password dialog is what authorises it. The path is validated first, precisely
  so a crafted root cannot point a privileged `chown -R` somewhere else.
- **The control plane is fail-open by default.** A `PreToolUse` gate that times
  out (`AGENTGLASS_GATE_TIMEOUT`, 60s) falls through rather than blocking your
  agents. Set `AGENTGLASS_GATE_FAILCLOSED=1` if you would rather a timeout or an
  unreachable control plane denied the call.

## What agentglass stores, and how to get rid of it

Everything below is on your machine and nowhere else. There is no account, no
sync, and no upload — the hooks refuse to post anywhere but this host (see
`AGENTGLASS_ALLOW_REMOTE` above). But it is worth saying plainly what lands on
disk, because **nothing in the app deletes it**: there is no route, no button
and no menu item that removes recorded data. The `Clear ✕` in the header clears
*filters*, not history.

| Where | What is in it |
|---|---|
| `~/.local/share/agentglass/agentglass.db`<br><sub>or `$XDG_DATA_HOME/agentglass/`, or `./agentglass.db` if one is already there</sub> | Every event, with its `summary`, its `error_text` and the **raw hook payload** — which for a tool call is the command line, the file path, and the prompt. Plus session totals, the full-text search index, gate decisions, the daily rollup, and the **activity log** — every write the dashboard performed, with the address it came from. |
| `~/.config/agentglass/token` | The shared secret, `0600`, when one has been minted. |
| `~/.config/agentglass/config.json` | The active project scope and the UI switches. |

Two things about retention are easy to get wrong:

- **`AGENTGLASS_RETENTION_DAYS` bounds the raw events, not the history.** Expiring
  events are folded into a daily rollup *before* they are deleted, so per-day
  totals — cost, tokens, error counts, session counts — survive the prune and
  keep accumulating. That is the point of the feature, and it means the default
  8 days is not how long agentglass remembers you.
- **The rollup has no expiry at all.** Nothing prunes it, and there is no path
  in the product that removes a row from it. It is designed to be kept for
  years.
- **Neither does the activity log.** Settings › Activity is an audit trail, so
  it is append-only by design: every git write, container action, pull-request
  action and gate decision, with what it touched and the address it came from
  (`local` for this machine, otherwise the IP — there are no accounts here, so
  a name would be invented). One row per thing a person pressed, which is tens
  a day rather than the thousands an hour the events table takes.

To get rid of any of it, delete the files. Stop the server first — SQLite is
open while it runs:

```sh
rm -rf ~/.local/share/agentglass ~/.config/agentglass
```

Removing only the history and keeping your settings means deleting the `.db`
alone. Nothing else in the app depends on it; the next event starts a new one.

## Out of scope

agentglass is a tool you point at your own machine, so the boundary is
provenance, not symptom. **A surface you deliberately opened, doing something
to the machine you opened it on, is the tool working.** In particular:

- The terminal, the chat panes and the Docker controls run **as you**, with your
  permissions. Filling the disk, killing a process, removing your own container
  or running a destructive command through them is not a vulnerability — it is
  the capability, and each one has a switch in the table below.
- The gate is **fail-open by default and by design**. An agent proceeding
  because nobody answered in time, or because agentglass was not running, is
  documented behaviour; `AGENTGLASS_GATE_FAILCLOSED=1` inverts it.
- Recorded data staying recorded (above) is a retention decision, not a leak.
- Findings that require an attacker to already have a shell on the machine, or
  to already hold the token, are not separate issues — at that point they have
  what the token protects.

What **is** in scope is anything that crosses a boundary without you: a webpage
reaching the server, another machine reaching it without the token, a repository
you cloned redirecting your transcripts, one project's scope reading another's
data, or a path that escapes the active scope.

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
