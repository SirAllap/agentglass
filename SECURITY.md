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
mints the token itself. It is off by default, it states in plain words what
turning it on grants, and turning it off closes the port rather than merely
hiding the link.

Adding a device is a separate, deliberate act — see
[Pairing a device](#pairing-a-device). The QR code is an *invitation*, not a
credential: a photograph of the screen does not pair anything.

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
- **The token is never served over any route, to anyone.** `/remote/status`
  reports where the server is reachable and whether a device has arrived, and
  the addresses it returns are addresses — nothing in that answer, or in any
  other, is a credential. It used to hand the token back to a caller on this
  machine, because the QR code *was* the token and the pane had to draw it;
  pairing replaced that, and a URL that grants a shell is exactly what ends up
  in a screenshot of the pane it is drawn in.
- **A device holds its own credential, at its own level.** See
  [Pairing a device](#pairing-a-device).
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

## Pairing a device

Handing a phone the machine's token had three consequences, and all three are
why this is now a handshake:

* **anyone who could see the screen was paired.** The QR carried the credential,
  so a photograph, a screenshot in a chat or a shared window in a call was a
  working key;
* **a lost phone could not be cut off.** One token meant revoking was rotating,
  and rotating kicked every device including the desk;
* **everything could do everything.** A phone that only ever approves gates had
  a terminal, git write access and Docker control.

The handshake, in `server/src/pairing.ts`:

1. **The machine mints an invitation.** A ticket id goes in the QR; a six-digit
   code is shown on the screen and nowhere else. Both last two minutes.
2. **The phone proves it can see that screen.** It scans the QR, generates a
   P-256 keypair that never leaves the browser, and types the code. Five wrong
   guesses closes the invitation outright rather than refusing one attempt.
3. **A person at the machine agrees.** The request appears in the Remote pane
   naming the device, the address it came from and the same six digits, and
   waits. Nothing is minted until somebody accepts, and accepting is where the
   device's level is chosen.
4. **The credential is delivered to that claimant and nobody else.** It is
   encrypted to the key from step 2 (ECDH → HKDF → AES-256-GCM, salted with the
   ticket) and collected exactly once, authorised by a secret only the claimant
   holds.

What this gives you, and what it does not:

- **The QR is not a credential.** Photographing it, or scanning it from a shared
  screen, gets a form asking for six digits that are not in the picture.
- **The credential never travels in the clear.** The server speaks plain HTTP
  over the LAN, so anything on that network sees the whole exchange — ticket,
  code, both public keys — and still has no key.
- **It does not defend against an active on-path attacker.** Someone who can
  rewrite traffic can substitute their own public key, and no handshake fixes
  that without an authenticated channel. That is a TLS problem. On a network you
  do not own, use the Tailscale address, which is encrypted end to end; the pane
  says so where the choice is made.
- **Credentials are stored hashed** (`~/.config/agentglass/devices.json`, `0600`)
  and compared in constant time. A readable file is not a working key.

**Levels.** A paired device is `read`, `answer` or `full`, chosen when the
request is accepted and defaulting to `answer`:

| Level | What it can do |
|---|---|
| `read` | Every GET, plus the POSTs that only read. Approves nothing, sends nothing. |
| `answer` | The above, plus `/gate/decide` and replying to a session that is already running. |
| `full` | Everything the machine can do: the terminal, git write, Docker, merging pull requests. |

Enforcement is **deny by default**: anything that changes state and is not named
as a read or an answer requires `full`, so a route added later is out of a
paired phone's reach until somebody decides otherwise. `/terminal/pty` is
explicitly `full` despite arriving as a `GET` — a browser cannot put a header on
a WebSocket upgrade, and a rule that trusted the method would hand a read-only
device an interactive shell.

**Revoking one device** (Settings › Remote › Paired devices › Forget) revokes
that credential and closes the sockets it is holding, and leaves every other
device — and the desk — alone. Rotating the machine's token is still there for
the case where you have lost the code itself, and still kicks everything.

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
| `~/.config/agentglass/devices.json` | One row per paired device, `0600`: its name, its level, when it was added and last used, and a **SHA-256 of its credential** — never the credential. Revoked rows are kept rather than deleted, so "did I definitely cut that phone off" stays answerable. |
| `~/.config/agentglass/config.json` | The active project scope and the UI switches. |

**One feature does send data off this machine, and it is the only one.** The AI
**Explain** walkthrough hands your changed lines to a model — the local `claude`
CLI, or the Anthropic API if you have set a key — so it can describe them. That
is what the button is for, and it runs only when you press it.

What it will not send: files whose contents are a credential by design (`.env*`,
`*.pem`, `*.key`, `id_rsa`, `credentials.json`, `.npmrc`, and their neighbours)
are held back, and the patches that do go are run through the same secret
scrubber the crash reporter uses, for a key pasted into an ordinary source file.
Anything withheld is **named on screen** rather than quietly missing — a summary
of a different changeset than the one you are looking at is worse than none.

Two things about retention are easy to get wrong:

- **`AGENTGLASS_RETENTION_DAYS` bounds the raw events, not the history.** Expiring
  events are folded into a daily rollup *before* they are deleted, so per-day
  totals — cost, tokens, error counts, session counts — survive the prune and
  keep accumulating. That is the point of the feature, and it means the default
  8 days is not how long agentglass remembers you.
- **The rollup has no expiry at all.** Nothing prunes it, and there is no path
  in the product that removes a row from it. It is designed to be kept for
  years.
- **The task list is read, not recorded.** Tasks live in your Taskwarrior store
  and agentglass keeps no copy, so deleting one there is not this promise's
  business — it is your list, and the app is a second window onto it. What
  agentglass stores about tasks is the reminders you set, above.
- **A reminder you have answered ages out; one you have not never does.** The
  reminders table is pruned on the same cutoff as the events, but only for rows
  that have been acknowledged or cancelled. A reminder still waiting for you is
  a live request, however old its row looks — the same ruling held tools get.
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
