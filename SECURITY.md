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
- **Token.** `AGENTGLASS_TOKEN` is required on every route except `/health`, the
  pairing handshake, and the local senders' own routes — the telemetry intake
  sinks (`/ingest`, the OTLP receivers) and `/agents/status`, a hooked session
  saying what it is working on — **when the request arrives on loopback**.
  Local hooks and OTel exporters have no way to carry a secret, so the exemption exists for them; it
  is a property of where the request came from and not of the path alone,
  because those sinks write permanent rows and the alert they raise leaves the
  machine. From anywhere else — including through a reverse proxy — they need
  the token like everything else. `/health` stays open to anyone: it stores
  nothing, and the pairing screen probes it before it has a credential to carry.
  Binding off loopback — **or setting `AGENTGLASS_TRUST_LAN=1` at all** — makes a
  token mandatory; if none is set the server mints, persists (`0600`) and prints
  one.
- **A proxy cannot claim to be loopback.** `tailscale serve` terminates TLS and
  re-dials the port from `127.0.0.1`, which would otherwise hand the whole
  tailnet the loopback exemption above. Forwarding headers are never the
  decision on their own: `X-Forwarded-For` is consulted only when the socket peer
  is loopback *and* the uid owning that socket is tailscaled's, and a proxied
  request is treated as remote unconditionally.
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
  out (`AGENTGLASS_GATE_TIMEOUT`, 300s) falls through rather than blocking your
  agents. Set `AGENTGLASS_GATE_FAILCLOSED=1` if you would rather a timeout or an
  unreachable control plane denied the call.
- **A held call is not released by the process being held.** Answering one
  (`/gate/decide`) needs a paired device with the `answer` grant, or an `Origin`
  this server already trusts — a browser attaches one to every POST it makes,
  and the desktop shell serves its renderer under a scheme of its own. The
  machine token on its own is not an answer, because the agent whose call is
  held holds that token too. *Raising* a hold (`POST /gate`) is untouched: that
  one is the hook asking to be stopped. What this is and is not worth is in
  [What the gate does not protect against](#what-the-gate-does-not-protect-against).

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

## What the gate does not protect against

The `PreToolUse` gate stops an agent before a tool call and holds it until
somebody answers. That is a brake on a workflow: the destructive command gets
looked at before it runs, a phone gets somewhere to answer it from, and every
decision leaves a line in the activity log. It is **not** a boundary against
code running as you on this machine, and that is a limit worth stating here
rather than waiting for somebody else to state it.

Not because the routes are open — they are authenticated like the rest.
`/gate/decide` is in the scope list, so a paired phone needs `answer` or `full`
to reach it, and a caller from off this machine carrying no token is refused
before any route sees it. Three narrower things are true, and all three end in
the same place.

- **The read routes carry no cross-origin check.** `/gate/decide` is behind
  `trustedCaller`, which turns away a browser that is neither same-origin nor
  private, and behind the release rule below on top of that. `/gate/status`,
  `/gate/pending` and `/gate/history` sit behind the surface-wide origin gate
  only, and that one waves an Origin-less caller through on purpose, because
  the hooks and the OTLP exporters cannot send one. Reading the queue is not
  answering it — but the queue holds the command an agent is about to run.
- **A server started by hand has no token to check.** `resolveToken` returns
  `{token: null}` when it is loopback-only and `AGENTGLASS_TOKEN` is unset
  (`server/src/auth.ts`), so the shared-secret gate is skipped rather than
  passed, and nothing downstream ever learns *who* is asking. Every rule graded
  by that — the `answer` grant, the deny-by-default table, and the device half
  of the release rule below — is not loosened on such a box, it is simply never
  consulted, and what is left of the release rule there is the `Origin` header
  alone. Remote callers are still refused outright; local ones were never being
  asked for anything.

  This is **not** how the desktop app runs. It mints a secret on first launch
  and hands it to its own sidecar (`electron/main.js`), so the app is
  authenticated on loopback too — which is what `docs/CONFIG.md` describes. The
  tokenless case is `bun run dev`, a hand-started server, and anything else that
  launches the sidecar itself. If that is you, set `AGENTGLASS_TOKEN`.
- **The token does not separate you from your own agents.** When one is set it
  is at `~/.config/agentglass/token`, `0600`, and the shipped hook reads it from
  exactly there — which is something anything running under your account can do.
  An agent that has swallowed a hostile instruction out of a README it cloned is
  running under your account. `0600` stops another user on the box; it does not
  stop a process that is already you. Answering a held call is the one thing
  that credential no longer opens on its own, which is the rest of this section.

### The one on that list that was a bug

Everything above is a limit of what a tool pointed at your own machine can
promise. One consequence of the last of them was not a limit but a defect, and
it is worth writing down rather than quietly fixing.

Until this change, the credential the shipped hook reads in order to **submit** a
gate also opened the route that **answers** one. `/gate/decide` was behind the
origin check the rest of the write surface uses, and that check waves an
Origin-less caller through on loopback on purpose — because that is exactly what
a hook is. An agent's own shell has the same shape. So the agent whose tool call
was being held could release it with one `curl` carrying a token it already had,
and two things followed. The decision was recorded as `local`, byte for byte
what a person pressing Approve in the desktop app writes, so the activity log
could not tell the two apart afterwards. And the stopped model was handed the
sentence written for a human answer — *"A human reviewed this call in agentglass
and approved it"* — so a call nobody had looked at came back to the agent as one
somebody had. The case that matters here is not the agent that sets out to work
around a hold. It is the helpful one, taking "approve the gate" as the next step
of the task it was given; and the one told to by a pull-request description,
which this app renders from whatever repository you happen to be triaging.

So `/gate/decide` now asks for something the held party has no way to produce: a
paired device with the `answer` grant, or one of the origins this server already
trusts — a foreign website is turned away by that check as it always was.
Between them they cover the three ways a person actually answers. The packaged
shell serves its renderer from a scheme no browser can be served from; a browser
attaches `Origin` to every POST it makes, same-origin ones included, so the
dashboard on this machine is untouched; and a paired phone carries a credential
minted at the desk that lives only on it. `curl`, `urllib` and the other
libraries an agent reaches for send no such header, and the machine token on its
own is no longer an answer — so the sentence the stopped model is handed, that a
human reviewed this call, now costs one of those two things. Raising a hold is
unchanged: `POST /gate` is the hook asking to be stopped, which was the half
that worked.

What that is worth, at no more than its real value. It moves self-release from
incidental to deliberate: the obvious `curl` gets a refusal that explains itself,
where before it got an approval the log recorded as a person. It is **not** a
boundary, and the reason fits in a line — a header is a string, and a local
process that sets one on purpose passes. Nor is the device store a wall:
`devices.json` is `0600` on this same machine, which is the same *already you*
the bullet above ends on. Closing it properly would take a credential the agent
cannot read, meaning one the desk holds and the token file does not, and that is
not what this is.

The record can only say what the caller proved, and it is worth reading it that
way. A paired device signs its own line with the name that was accepted when it
was paired — and accepting is now itself behind the same rule, because it was
the sharper hole. A machine token alone could ask for a ticket, accept its own
ticket, and mint a device with any label; releasing a hold through that device
then needed no header at all, and the line read as a phone somebody had once
approved. An audit log that invents a named human is worse than one that only
fails to say which process it was, so `/pair/accept` asks for the same proof
`/gate/decide` does. What that does not reach, and nothing here can, is a row
appended to `devices.json` directly — same file, same 0600, same *already you*. Everything else is `local`, and
`local` means *this machine*: the desk, the dashboard it serves, and anything
here that got past the rule above by looking like one of them. Nothing about a
person pressing Approve moved — the same actor, the same words to the agent, on
the same routes — which is the regression that would have made this change worse
than the bug it fixed. But the log is not a second line of defence: it records
what was presented, which is the limit above seen from the other end.

So the honest scope: the gate is a **human-workflow brake, not a security
boundary against a process running as you**. It earns its place because the
thing on the other side of it is a model that would otherwise run the command
the moment it thought of it, and the pause is where a person gets to say no. The
change above makes that sentence more true rather than obsolete: a brake the
braked thing cannot release by accident is what a brake is, and something
deliberately working around this one still runs as you, reads the same files,
talks to the same port and can set the same header. Where a capability must not
be exercised at all, turn it off — the knobs below hold in a way the gate does
not.

## What agentglass stores, and how to get rid of it

Everything below is on your machine and nowhere else. There is no account, no
sync, and no upload — the hooks refuse to post anywhere but this host (see
`AGENTGLASS_ALLOW_REMOTE` above). But it is worth saying plainly what lands on
disk, because **nothing in the app deletes it** on its own: there is no route,
no button and no menu item that removes recorded history, and the only sweep is
the retention window below. Three routes remove a row *you* asked the app to
hold for you, and nothing else: `POST /understudy/work/unask` takes one task
back out of the Clone's queue; `POST /agents/status` with `done: true` drops a
session's own "what it is working on" line, and only when the same session that
wrote it asks; and `POST /bench/note` with empty text deletes that checkout's
bench note, a file of its own under the data directory. None of the three
touches an event, a session or a decision.

One route is named as if it did: `/browser/places/forget` throws away the
browsing history you imported from your own browser. That history is kept in
its own file rather than in the events database — `places.db` beside it —
exactly so that deleting it takes one call and costs you none of your fleet's
history. Nothing agentglass recorded is removed by it. The `Clear ✕` in the header clears
*filters*, not history.

One row in the database is not recorded data and is deleted routinely: the
**database claim** — the pid, port and hostname of the server process that owns
the file, written at boot and dropped on a clean exit. It exists so a second
server cannot run a second transcript scanner over the same history, which
double-counts events, tokens and cost in silence. It holds nothing about your
sessions.

| Where | What is in it |
|---|---|
| `~/.local/share/agentglass/agentglass.db`<br><sub>or `$XDG_DATA_HOME/agentglass/`, or `./agentglass.db` if one is already there</sub> | Every event, with its `summary`, its `error_text` and the **raw hook payload** — which for a tool call is the command line, the file path, and the prompt. Plus session totals, the full-text search index, gate decisions, the daily rollup, and the **activity log** — every write the dashboard performed, with the address it came from. |
| `~/.config/agentglass/token` | The shared secret, `0600`, when one has been minted. |
| `~/.config/agentglass/devices.json` | One row per paired device, `0600`: its name, its level, when it was added and last used, and a **SHA-256 of its credential** — never the credential. Revoked rows are kept rather than deleted, so "did I definitely cut that phone off" stays answerable. |
| `~/.config/agentglass/config.json` | The active project scope and the UI switches. |
| `~/.config/agentglass/clickup-views.json` | The ClickUp boards you saved, and a copy of the last thing each one returned — task titles, statuses and tags. Not a secret and not `0600`: it is a cache of things you can already see, kept on disk so the panel opens instantly instead of waiting a second and a half after every restart. Delete it and it rebuilds. |
| `~/.config/agentglass/credentials.json` | **API tokens for services you connected in Settings → Integrations**, `0600`, alongside what the service said about each one — the account name and workspace, so a card can say who you are without a round trip. Only providers with no CLI of their own land here: `gh` keeps GitHub's token in your system keyring and agentglass never reads it. |

### About that credentials file

It is `0600`, and `0600` is a real boundary: another user on this machine cannot
read it. It is **not encrypted**, and that is a limit worth stating rather than
papering over — any key this process could read unattended would have to sit
next to the thing it protects, which buys a feeling rather than a defence.

So the honest scope is: `0600` stops another account on this computer. It does
not stop a backup of your home directory, a synced dotfiles repository, or
anyone who can already read your files as you. If that matters for a given
token, prefer a provider with a CLI that uses the system keyring, and scope the
token narrowly wherever the service lets you.

The token is never sent to the browser. It goes in through one route, is
verified against the service before anything is written, and after that the app
answers with a status — who you are, which workspace, how many tasks — and never
with the credential. It is not written to logs either: where one has to be
named, only a prefix and a length are printed.

### One more outbound request: assignee pictures

The ClickUp panel draws the people on a card as their avatars, and those images
come from ClickUp's own attachment host — so opening a board makes a request per
distinct person, carrying no credential and no referrer. It is the same kind of
request the pull-request list already makes for GitHub avatars.

Nothing is uploaded and nothing about you is in the URL: it is a picture your
workspace already publishes to anyone who can see the card. If that request is
unwelcome, the panel is still correct without it — a person with no photo is
drawn as their initials on their own colour, which is what happens today for
anyone who never uploaded one.

**One feature sends your code off this machine, and it is the only one that
does so unasked by a switch.** The AI **Explain** walkthrough hands your changed
lines to a model — the local `claude` CLI, or the Anthropic API if you have set a
key — so it can describe them. That is what the button is for, and it runs only
when you press it. Two more paths exist and both are off until you turn them on:
`AGENTGLASS_WEBHOOK` (what travels through it is listed under
[What leaves through the webhook](#what-leaves-through-the-webhook)), and the
Clone's judge, which hands `claude -p` the material it is comparing — through
the same local CLI, only after the private-terms gate, and only with the `judge`
setting on.

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
- **The Clone's and the Lantern's tables have windows of their own**, and
  `AGENTGLASS_RETENTION_DAYS` does not move them. They are swept hourly with the
  events, on fixed clocks: what the Clone read to make a call
  (`understudy_snapshots`) goes at **30 days**; the bare fact that it wrote
  something (`understudy_ledger` stubs), a proposal once it has been answered
  (`understudy_proposals`), a queued task once it has been taken or worked
  (`understudy_asked`), a named agent once its window has ended
  (`named_agent`), what a session was to the app (`session_role`), a scheduled
  start once it has fired or been cancelled (`agent_schedule`) and a question
  once it has been answered (`understudy_help`) all go at **90 days**. What
  never expires is the part that is still owed to a person or still the score:
  a *pending* proposal, a *queued* task, a *waiting* schedule, an *open*
  question, and the ledger's `decision` and `fence` rows. Three more tables —
  shifts that are not running (`understudy_shifts`), acts that have been undone
  (`understudy_acts`) and runs that are not running (`understudy_work`) — go at
  90 days too, except that **`AGENTGLASS_RETENTION_DAYS=0` keeps them for
  ever**: they are the record of what ran unattended, and turning event pruning
  off is read as wanting that record kept. A shift, an act not yet undone, or a
  run still marked running is never swept, because "started, never finished" is
  the only trace of an agent killed mid-task.

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
  documented behaviour; `AGENTGLASS_GATE_FAILCLOSED=1` inverts it. Nor is it a
  boundary against a process running as you — see
  [What the gate does not protect against](#what-the-gate-does-not-protect-against),
  which says so before a report has to. A local process that sets an `Origin`
  header in order to release its own hold is that same case, and that section
  says so in as many words rather than leaving it to be discovered.
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

## Writing to somebody else's board

Reading ClickUp needs only the token. **Changing** anything there — moving a card
to another status, putting yourself on it — is off unless you set
`AGENTGLASS_CLICKUP_WRITE=1`, and that default is the opposite of the one the
local task list uses. The reason is the blast radius rather than the risk of a
bug: your Taskwarrior store is yours, while a status change on a company board
fires automations, notifies a team, and cannot be undone from here.

With it on, each change still asks first — naming the card and what will change
from and to — and re-reads the card immediately beforehand, refusing if somebody
moved it while you had it open. That check is `date_updated`, which is the
closest thing ClickUp offers to a precondition; it is weaker than the fingerprint
the local list uses, and it catches the case that actually happens.

Values are offered, never typed: a status can only be one the list itself
accepts, so an invalid one cannot be sent. And there are no bulk actions here on
purpose — one wrong batch is thirty notifications to other people.

## Reading outside the open project

Everything under `/files/` is bounded by the open project: a cockpit pointed at
one repository refuses a path that is not in it, so scoping narrows what you can
*touch* and not only what you can *see*.

The finder's **Machine** tab is the one deliberate exception, because "where is
that document" is asked about files that are in no checkout — a ticket's
evidence folder, a note in `~/Documents`. It is bounded separately, in
`server/src/disk.ts`, and the bounds are narrow:

- **your home directory and nothing above it.** Another root can be added with
  `AGENTGLASS_DISK_ROOTS` (`:`-separated), which is an operator's decision.
- **nothing hidden.** A dotted path component is refused, for searching and for
  reading — `~/.ssh`, `~/.aws`, `~/.config/<app>` and every credentials file
  that lives in one. The rule is the dot rather than a list of names.
- **symlinks are resolved before the path is judged**, so a shortcut in your
  home directory cannot point out of it.
- **`AGENTGLASS_DISK_DISABLED=1` turns it off**, and so does
  `AGENTGLASS_FS_BROWSE_DISABLED=1` — disabling the file browser must not leave
  a second door standing.

Three details of the same boundary, because each was once wrong:

- **`/preview/raw` and `/preview/open` judge the real path.** Symlinks are
  resolved *before* the scope check, and what is then read or handed to the
  desktop opener is that resolved path — never the spelling that passed. Both
  are refused outright under `AGENTGLASS_FS_BROWSE_DISABLED=1`.
- **`/disk/find` and `/disk/grep` pass the query after `--`**, so a search
  string that begins with a dash is a search string to `fd`, `rg` and `grep`,
  not an option that changes where they look.
- **`/docker/volume/peek` runs `busybox` or `alpine` and nothing else.** Looking
  inside a volume means mounting it into a throwaway container, and the image
  that container runs is matched against those two names; if neither is already
  local the peek is refused rather than pulled or substituted.

The boundary is covered by `server/test/disk-scope.test.ts`; a regression there
is a hole rather than a bug, and it would not show up in a screenshot.

## Plugins

A plugin is a folder with a `plugin.json`, copied to
`~/.config/agentglass/plugins/<name>/` by `POST /plugins/install` (or
`/plugins/install-from-catalogue`) and run only after a person has read what it
declares and pressed enable — nothing in the folder executes at install, and the
master switch (`/plugins/master`) stops every plugin at once.
[docs/PLUGINS.md](docs/PLUGINS.md) is the long form; the security facts are these.

A plugin runs as **its own process**, started by this server with four
variables in its environment (`PATH`, `HOME`, `AGENTGLASS_URL`,
`AGENTGLASS_READ_TOKEN`) and nothing inherited. The token is minted at enable
time at the scope the manifest asked for — `read`, `answer` or `full`, the same
three a paired device has — lives only in the server's memory, and is revoked
when the plugin is disabled or the process exits. What was approved is a
fingerprint over the scope and a content hash of every file in the folder, so an
update that changes the manifest, or changes the code behind an unchanged
manifest, clears the approval and asks again.

**A plugin token is its own kind of caller and can never answer a permission
gate**, whatever scope it declares or was granted. `POST /gate/decide` asks for
a credential no process on this machine could have minted for itself; a plugin's
token sits in a process environment on this machine, readable by any agent
running as the same user — exactly what the gate holds — so `auth.ts` names the
kind and refuses it. `answer` for a plugin means replying to a running session,
not releasing one.

Two path rules and one network rule hold the install itself. A `name` that is
`.`, `..` or begins with a dot is refused before anything is copied. Every path
the installer removes or copies to is asserted to sit under the plugins root
(`insidePluginsRoot`), so a manifest cannot steer a delete elsewhere. A
catalogue (`GET /plugins/catalogue?url=`) is fetched over `https://` only, through
the same guarded fetch the server uses for any address it did not choose: each
hop is checked against private, loopback and link-local ranges before it is
connected to, redirects are followed one hop at a time with that check repeated,
five hops at most, and a body over 5 MB or a fetch over 15 seconds is dropped.

## The Clone, unattended

The Clone (the *understudy* in the code and the routes) takes a task from a
queue, cuts a worktree of its own, seats an agent in it and lets the tests
decide. It never pushes. Because nobody is watching while it works, what the
agent inherits is fenced rather than trusted.

**The environment fence** (`server/src/understudy-runenv.ts`) builds the run's
environment by copying the server's and blanking, by name, `GH_TOKEN`,
`GITHUB_TOKEN`, `GH_ENTERPRISE_TOKEN`, `SSH_AUTH_SOCK`, `AGENTGLASS_WEBHOOK` and
`AGENTGLASS_TOKEN`, then every variable whose name matches `*_TOKEN`, `*_KEY`,
`*_API_KEY`, `*_SECRET`, `*_PASSWORD`, `*_PASS`, `*_CREDENTIAL(S)`, `AWS_*`,
`AZURE_*`, `GOOGLE_APPLICATION*`, `OPENAI_*`, `CLICKUP*`, `SLACK_*`, `DISCORD_*`,
`NPM_TOKEN`, `PYPI*` or `DOCKER_*` (case-insensitive). The one exception is
`ANTHROPIC_API_KEY`, which is the key the fenced CLI itself spends. `gh` is
pointed at an empty, run-private config directory, git's credential helper is
emptied and every `https://`, `git@` and `ssh://` push URL is rewritten to an
address that does not resolve, so a push cannot succeed even if the agent tries
one. Into that fenced environment the run receives **one credential of its
own**: a per-run token (`AGENTGLASS_TOKEN` and `AGENTGLASS_READ_TOKEN` both name
it) minted for the run and revoked when it ends, graded not by scope but by a
short positive allowlist — every read, and only the writes the Clone owns; it
can neither release a gate nor start a session.

**The private-terms gate** keeps the material the Clone learns from
(`POST /understudy/learn`: notes, transcripts, shell history, rules) and the
judge's prompt free of names that must not leave a private repository. The list
is one pattern per line at `~/.config/agentglass/private-terms.txt`;
`AGENTGLASS_PRIVATE_TERMS` names another file; and when the app's own list is
absent a git hook's list at `~/.config/git/private-terms.txt` is honoured, since
a person who keeps one there has already said what is private. Without any list
the Clone refuses to read at all. The one override is explicit consent — the
desktop's *"Read anyway — nothing here is private"*, sent as
`iAcceptNoTermsList: true` from the desktop's own origin and from nowhere else.
A hit is recorded as an index into the list, never as the term.

**The judge** — `claude -p` asked whether the Clone's call matched the person's
— is **off by default** (the `judge` setting) and declines to run without a
private-terms list. When it runs it does so in a room of its own: a fresh
directory under the app's state directory created `0700`, with its own
`CLAUDE_CONFIG_DIR` beside it (also `0700`), never under `/tmp`, so the model's
hooks, settings and working files are the app's rather than whatever the
person's own `claude` would load.

**Seeding a worktree** from `.worktreeinclude` copies only files git ignores,
skips anything tracked, never overwrites what git put there, refuses a line that
climbs out of the repository, and never copies through or as a symlink — every
path component is `lstat`ed without following, and the `.worktreeinclude` file
itself must be a regular file.

## The Lantern, and agents with names

**The Lantern** is an observer. `GET /agents/board` reads every hooked session
on this machine; `GET`/`POST /lantern/settings` holds two switches
(`lanternWatch`, `lanternWatchMinutes`) that make the server re-read that board
every N minutes on its own and send one notification when somebody is still
stopped on you, a named agent's window has vanished, or claimed work has gone
quiet. A notification goes wherever the app's alerts go: the bell in the app, a
paired phone on the socket it holds, the desktop otherwise, and
`AGENTGLASS_WEBHOOK` when one is set (see below). The Lantern's own chat is on
the board as `role: "lantern"` and is never counted as needing you; a status
line posted by it is accepted and dropped. It starts nothing and stops nothing.

**`POST /agents/status`** is how a session says what it is working on, and it is
**tokenless on loopback by design**: the shipped hook carries it and a hook has
no token to give. It still passes the origin check. Its free-text fields are
capped at the door — `name`, `worktree`, `branch` and `session` at 512
characters, `doing` and `left` at 4096 — and trimmed again before storage, so a
runaway agent cannot fill the database through it. `{name, done: true}` removes
a line, and only the session that wrote the line may remove it: no `session` is
a 400, another session's is a 403.

**Named agents** (`GET /agents/named`, `POST /agents/named/{start,prompt,wait,
read,keys,stop}`) and **schedules** (`GET`/`POST /agents/schedule`,
`POST /agents/schedule/cancel`) seat a CLI by name in a checkout of the open
project, now or at a time. Two rules hold whatever the caller passes. The
skip-permissions mode (`--yolo`) is granted only if Settings allow it
(`chatBypass`, or `AGENTGLASS_CHAT_BYPASS=1`), and a schedule checks that
**again when it fires**, not only when it was written. And extra CLI arguments
are refused when they are permission-shaped: any vendor's bypass flag, anything
beginning `--dangerously-`, anything containing *bypass*, *skip-permission*,
*dangerous*, *yolo* or *full-auto*, and `--permission-mode`, `--settings`,
`--mcp-config`, `--sandbox`, `-a`/`--ask-for-approval`, `--allowedTools`,
`--allowed-tools`, `--disallowedTools`, `--disallowed-tools` and `--add-dir`.
The refusal is a 400 that names the flag; nothing is silently dropped. What an
agent is allowed to do is decided in Settings, not in the arguments of the
request that starts it.

## The browser, driven by an agent

`bin/agentglass-browser` and `bin/agentglass-browser-mcp` drive the app's own
built-in browser through the server's relay (`POST /browser/<verb>`), so an
agent reaches the page the person is looking at — signed in as they are — and
nothing else: the app's own renderer, and the token in it, are not on the other
side of that relay. This is why the app is never started with a remote
debugging port.

Some of those verbs **act**. `browser_eval` runs JavaScript in the page,
`browser_addInitScript` installs JavaScript that runs before every page does,
`browser_expose` gives the page a function that calls back into the agent, and
`browser_cdp` sends raw DevTools Protocol commands to the page's session. All
four are confined to the guest page, and all four — with clicking, typing, and
every other verb not in the observe list — are refused under
`AGENTGLASS_BROWSER_READONLY=1`, which leaves reading, screenshots and the
network log working.

`upload` attaches a file from this machine to a page, so it is bounded like a
read of the disk: a path is admitted only if the open project admits it, or (with
no project open) it is under your home directory and not hidden, or the
machine-search roots (`AGENTGLASS_DISK_ROOTS`) admit it — and never `~/.ssh`,
`~/.gnupg`, `~/.aws` or the app's own config directory, checked against the
spelling and against the resolved path. It honours `AGENTGLASS_DISK_DISABLED=1`
and `AGENTGLASS_FS_BROWSE_DISABLED=1` as refusals. The MCP server does not
offer `ignoreCertErrors` at all. Both CLIs refuse to send the token over plain
`http://` to any host that is not loopback — `https://` anywhere, `http://`
only to this machine — before a single request is built. Cookies, storage
state, HAR files and page snapshots the CLI writes land as `0600` files.

## What leaves through the webhook

`AGENTGLASS_WEBHOOK` is off unless set. With it set, the server POSTs
`{"text": …}` to that one URL (a Slack- or Discord-shaped incoming webhook) in
three cases, and this is everything that travels:

- **Alerts** — the same title and body the desktop notification carries: a
  gate waiting on you, a reminder, the Clone stuck on a question, and the
  Lantern's watch notices, which name agents, the base name of a checkout,
  what an agent said it was working on, and the reason a permission prompt or a
  held gate gave — each line cut at 200 characters.
- **Pull-request nudges** — `POST /prs/nudge` with `send: true` posts the chase
  it wrote: the reviewers' logins as `@`-handles, the PR number, its title, a
  phrase for what is being asked (a first look, another look, a re-check), and
  the PR's URL.

No transcript, no diff and no token goes through it, and the variable is blanked
out of every Clone run so an unattended agent cannot post through it either.

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
| `AGENTGLASS_FS_BROWSE_DISABLED` | directory completion in the project picker, and everything under `/files/` and `/disk/` |
| `AGENTGLASS_DISK_DISABLED` | the finder's **Machine** tab: searching and reading documents under your home directory |
| `AGENTGLASS_EDITOR_DISABLED` | opening a file in your editor from the app |
| `AGENTGLASS_SCAN_DISABLED` | the machine-wide transcript scanner |
| `AGENTGLASS_BROWSER_READONLY` | every acting verb of the built-in browser when an agent drives it — clicks, typing, `eval`, `cdp`, init scripts, uploads — leaving reads and screenshots |
| `AGENTGLASS_BUDGET_WRITE_DISABLED` | changing spend budgets from the app (`POST /budgets/set`) |
| `AGENTGLASS_TASK_WRITE_DISABLED` | writes to your Taskwarrior list from the Tasks view |
| `AGENTGLASS_UNDERSTUDY=0` | the Clone, whatever its settings file says — the variable can force it off, never on |
| `AGENTGLASS_TMUX_OBSERVE_ONLY` | every tmux command that writes to a session — see [docs/BLAST-RADIUS.md](docs/BLAST-RADIUS.md) |
| `AGENTGLASS_CLICKUP_WRITE=1` | *(opposite sense)* turns **on** writes to a ClickUp board, which are off by default |
| `AGENTGLASS_GATE_FAILCLOSED=1` | *(opposite sense)* makes the gate deny on timeout instead of allowing |

Two things are **not** individually switchable, and it is worth knowing which:
the AI **Explain** walkthrough (it follows `AGENTGLASS_COMMIT_DISABLED`'s
surface but has no knob of its own) and the `/control` UI-navigation endpoint,
which is unswitchable by design — it grants no capability the keyboard does not
already have.

Beyond the knobs, **scope is itself a boundary**: with a project open, git
writes, the terminal, chat, pull-request actions and editor opens are all
refused outside it.

## What it can do to your tmux

agentglass attaches to the tmux server you already run rather than starting one
of its own, which means it can write to sessions it did not create — resize a
window, rename it, move it, switch your client. That is a capability, not a
vulnerability, but it is one worth being able to look up rather than discover.
[docs/BLAST-RADIUS.md](docs/BLAST-RADIUS.md) lists every such command, what
triggers it, and the `AGENTGLASS_TMUX_OBSERVE_ONLY=1` switch that turns all of
them off while leaving the read-only cockpit working.
