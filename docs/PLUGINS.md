# Plugins

A plugin is a program somebody else wrote that watches or drives agentglass
over HTTP, packaged so that installing it, reading what it asks for, and
switching it on are three separate acts a person performs in Settings → Plugins.
This page is the design and the how-to in one place; the short version, with
the worked example, is [§6 of EXTENDING.md](EXTENDING.md#6-publish-a-plugin).

- [What a plugin is](#what-a-plugin-is)
- [The manifest](#the-manifest)
- [Scopes, in reviewer language](#scopes-in-reviewer-language)
- [Install, review, enable](#install-review-enable)
- [Catalogues](#catalogues)
- [Drawing in the app](#drawing-in-the-app)
- [From the terminal](#from-the-terminal)
- [Being listed](#being-listed)
- [One plugin's output is another's input](#one-plugins-output-is-anothers-input)
- [What a plugin cannot do](#what-a-plugin-cannot-do)
- [Publishing one](#publishing-one)
- [A worked example](#a-worked-example)
- [Where this stops being small](#where-this-stops-being-small)

## What a plugin is

**A plugin runs as you.** Its entrypoint is a command this server starts as your
user, with your files and your network. The scope you grant limits the token the
plugin is handed for talking to agentglass; the scope limits the token, not the
process. Nothing here stops a plugin from reading a file, opening a socket or
running a program on its own. Approve one only as you would run its code yourself,
and read it first. A sandbox is planned and is not here yet.

A folder with a `plugin.json` at its root. It is copied onto disk at install,
under `~/.config/agentglass/plugins/<name>/`, and nothing in it runs at that
point. When a person enables it, the server mints a token at the granted scope
and starts the manifest's `entrypoint` as **its own process**, with exactly four
variables in its environment: `PATH`, `HOME`, `AGENTGLASS_URL` and
`AGENTGLASS_READ_TOKEN`. The variable is named `AGENTGLASS_READ_TOKEN` whatever
scope was granted — the name predates plugins and was kept so the same script
works as a plugin and as a hand-run extension.

From there the plugin talks to agentglass the way any outside program does:
the HTTP routes and the `/stream` WebSocket, described in
[EXTENDING.md](EXTENDING.md). Nothing is loaded into the server or the desktop
window. The only thing the plugin mechanism adds over "write a script and export
a token" is the packaging: a manifest a reviewer can read, a catalogue to find it
in, and an on/off switch that revokes the token when it is off.

Disabling a plugin kills its process and revokes its token. A server restart
respawns every enabled plugin with a fresh token; tokens live in memory and are
never written to disk.

## The manifest

```json
{
  "name": "hello-stream",
  "publisher": "someone",
  "description": "Writes a line to its own log whenever an agent finishes a turn.",
  "entrypoint": "bun run watch.ts",
  "scope": "read"
}
```

| field | rule |
|---|---|
| `name` | 1–60 characters, `A-Z a-z 0-9 . - _`; not `.`, not `..`, and not starting with a dot. Becomes the directory name on disk. |
| `publisher` | 1–200 characters. Shown to the reviewer; not verified. |
| `description` | 1–500 characters. Shown to the reviewer; not verified. |
| `entrypoint` | a shell command, 1–500 characters, no control characters; run through `bash -c` with the install directory as its working directory. |
| `scope` | `read`, `answer` or `full` — what the plugin *asks for*. See below. |
| `contributes` | optional; where it draws. See [Drawing in the app](#drawing-in-the-app). |
| `icon` | optional; a relative path inside the folder to an `.svg`, `.png` or `.webp`, at most 256 KB, served to the window with `nosniff` and a sandbox policy. Named and not shipped is the mistake `agentglass-plugin validate` warns about. |
| `color` | optional `#rrggbb`; the tint of its mark and of the button it puts in a pull request. |
| `minApp` | optional `major.minor.patch`; the oldest agentglass this works on. An older app refuses the install and says both versions, rather than installing something whose panel would never appear. |
| `sandbox` | optional; what the plugin asks to be given inside a box: `network` (`agentglass`, the default, or `internet`), `read` and `write` (lists of `~/…` or absolute paths, at most 16 each) and `programs` (bare command names to put on its PATH). It is part of what a reviewer approves, so a grant that grows asks again, and the approval screen lists every path, in red when the name looks like a login. A grant of `~/.ssh`, `~/.gnupg`, `~/.config/agentglass`, the session bus folder or `~/.local/share/keyrings`, or of a folder that contains one, is refused. **Declared only for now: nothing enforces it yet and the plugin still runs as you.** No block means no declaration, and the plugin is unchanged. |

A manifest that fails any rule is refused with the sentence naming the rule;
nothing is coerced into a wider shape than what was declared.

The folder itself is refused before the manifest is read when it holds more
than 2000 files, a file over 10 MB, or more than 50 MB in total, and when any
symlink in it resolves outside the folder — an install is a copy, and a copy
that follows a link out is a copy of something else. A link is also refused
when it is absolute, or climbs above the folder on its way back in: the folder
is checked where it was fetched and installed somewhere else. A link that stays
inside is kept as a link. Files a plugin keeps in Git LFS install as their
pointers: an install never fetches through LFS, whose host the repository's
own `.lfsconfig` names, and never stops to ask for a password. A local install takes an
absolute path; a relative one is refused rather than resolved against whatever
directory the server happens to be in.

## Scopes, in reviewer language

The three scopes are the same three the server already uses for paired devices
(`server/src/auth.ts`), so no new permission language had to be invented and
nothing new has to be kept in step with the route table.

- **`read`** — almost every `GET` route, including `/stream`: a session's live
  output as it happens, the same prompts and replies shown on screen, costs,
  diffs, pull requests, the Lantern's board. Writes nothing *through this app's API*; the process itself is not confined. Six reads
  need `full` rather than `read`, because each one hands over something that is
  not this plugin's: `/terminal/pty`, `/browser/places/all`, the desktop's
  notifications (`/notifications`, `/notifications/capability`), and
  `/plugins/settings` and `/plugins/panels`, which are another plugin's settings
  and another plugin's screen. A plugin reads and writes its own through
  `/plugin/self/…` at any scope.
- **`answer`** — everything `read` gets, plus replying to a session that is
  running now, an open chat pane (`/chat/send`, `/chat/pane/key`). It does **not** include
  releasing a permission gate — see the next paragraph.
- **`full`** — everything this machine can do: a terminal, git writes, Docker
  control, merging pull requests, installing other plugins.

**A plugin never answers a gate.** `POST /gate/decide` is the one act the server
reserves for a credential that no process on this machine could have minted for
itself — a paired phone's, or a person at the desktop. A plugin's token is minted
by this server and sits in the environment of a child process of this server, on
this machine, readable by any other process running as the same user. That is
exactly the kind of caller the gate exists to hold, so plugin tokens are their
own kind (`kind: "plugin"`) and are turned away from `/gate/decide` by name,
whatever scope the manifest declared and whatever scope was granted. A plugin at
`answer` can reply to an agent; it cannot release one.

The manifest is a request, not a grant. The reviewer sees the scope and decides
whether to enable the plugin at all; a plugin cannot obtain `full` by writing
`"full"` and being believed.

## Install, review, enable

1. **Install** copies the folder — from a git URL, a local path, or a catalogue
   entry — into the plugins directory and reads `plugin.json`. No code runs.
   The install refuses a `name` that is `.`, `..` or dotted, and every path it
   removes or copies is asserted to sit under the plugins root before anything
   touches the filesystem.
2. **Review** shows what the manifest declares: publisher, description, the
   entrypoint command, the scope asked for. What was reviewed is recorded as a
   fingerprint over the scope, the presence of an executable entrypoint and a
   content hash of **every file and every link** in the folder (`.git`
   excluded; a link by where it points, a file by its bytes and whether it
   may be run, read from git's index in a checkout so Windows hashes it the
   same) — not the name, and not the manifest alone.
3. **Enable** is a per-plugin switch under a master switch. Enabling mints the
   token and starts the process; disabling stops it and revokes the token.
   Turning the master switch off stops every plugin.

An update — from the same source — is installed into place and then compared
against the recorded fingerprint. If the manifest changed, or the manifest is
untouched but the files behind the entrypoint are not, the old approval is
cleared, a running instance is stopped, and the reviewer is asked again. Every
update re-asks, a typo fix included: a consent prompt that is only *sometimes*
honest teaches people to click through it faster than one that always is.

`~/.config/agentglass/plugins.json` records, per plugin, its source (git URL and
ref, local path, or catalogue plus entry id), the commit it resolved to, the
content hash, the fingerprint that was approved, whether it is enabled, and when
it was installed. That is every fact a lockfile would pin down, so there is no
separate lockfile.

## Catalogues

A catalogue is a plain JSON file at an `https://` URL, fetched fresh every time
somebody browses it. It is a list, not a registry: nothing from it is cached as
trustworthy between reads, and an unreachable or malformed catalogue is shown as
exactly that, never as an empty list.

```json
{
  "name": "community-plugins",
  "owner": "someone",
  "plugins": [
    {
      "id": "someone.hello-stream",
      "source": { "kind": "git", "url": "https://example.com/someone/hello-stream.git", "ref": null },
      "description": "Writes a line to its own log whenever an agent finishes a turn.",
      "categories": ["monitoring"]
    }
  ]
}
```

| field | rule |
|---|---|
| `name` | A heading: 1-60 printable characters, no control characters. Not a plugin name — this one never becomes a path |
| `owner` | 1–200 characters; shown, not verified |
| `plugins[].id` | the handle an install-from-catalogue names, and the folder it installs into — so it follows the plugin-name rule (1–60 letters, digits, `.`, `_`, `-`, no leading dot) and must equal the `name` in the manifest at that source, or the install is refused |
| `plugins[].source` | `{ "kind": "git", "url": "https://…", "ref": null \| "<branch, tag or commit>" }`; a missing `ref` installs the default branch, and a full 40-character commit is fetched by id and checked to be that commit |
| `plugins[].sha256` | optional, 64 lowercase hex: the content hash of the tree at `ref` (`agentglass-plugin hash <folder>` prints it, over a checkout made with `core.autocrlf=false`, which is how the app checks out on every platform). Present, the install refuses a tree that hashes to anything else; malformed, the entry is dropped. This project's catalogue carries one on every listing |
| `plugins[].description` | 1–500 characters |
| `plugins[].categories` | optional list of short strings, at most 20 |
| `plugins[].title` | optional, ≤80; the card's heading when there is one, otherwise the id |
| `plugins[].publisher` | optional, ≤80; the card's byline, otherwise the catalogue's owner |
| `plugins[].draws` | optional list of at most 8 short words — `panel`, `settings`, `pr-notes`, `pr-button` — so a card can say what installing gets you before anything is installed |
| `plugins[].preview` | optional `https` URL of a picture — the card shows it. The approval workflow fills this in from a `preview.png`, `.jpg` or `.webp` at the root of the plugin's own repository, so an author ships one file and nothing else |
| `plugins[].added` | optional ISO date; the only ordering a catalogue offers that its author cannot game by rewriting the file |

A document may list more than the 500 entries the server keeps; it answers with
those and with `total`, the number the document held, and the window says so
rather than becoming a shorter catalogue. A card is drawn a page at a time, in
the app and on the site: a list this long is one a catalogue should publish in
pages of its own.

Fields the app does not read are dropped, which includes `verified` on this
project's own catalogue — that mark exists on the website and means a
maintainer read the plugin at the listed source. It is not a promise about
later changes, which is why an update asks again.

One malformed entry drops that entry, not the catalogue. Fetching a catalogue
goes through the same guarded fetch the server uses for any address it did not
choose itself: each hop is checked against private, loopback and link-local addresses before it
is connected to, redirects are followed one hop at a time (five at most) with the
same check on every hop, and a redirect off `https://` ends the fetch. The body
is capped at 5 MB and the whole fetch at 15 seconds.

Catalogues are optional. A plugin is installable from its git URL alone.

## Drawing in the app

A plugin declares where it draws, in its manifest, next to its scope:

```json
{
  "name": "orbit-reviewer",
  "publisher": "acme",
  "description": "Reviews pull requests and keeps the findings local.",
  "entrypoint": "python3 -u reviewer.py",
  "scope": "read",
  "contributes": {
    "panels": [{ "id": "main", "title": "Reviews", "icon": "review" }],
    "prNotes": true,
    "prActions": [
      { "id": "review", "label": "Local review" },
      { "id": "review-full", "label": "Review from scratch" }
    ],
    "settings": [
      { "key": "repos", "type": "list", "label": "Repositories" },
      { "key": "model", "type": "select", "label": "Model", "options": ["opus", "sonnet"] }
    ]
  }
}
```

The declaration is part of what the person approves. The review screen lists it
in plain words ("adds a panel, Reviews, to the Plugins view"), and it is folded
into the manifest hash, so a plugin that starts drawing somewhere new is asked
about again. A manifest with no `contributes` hashes exactly as it did before
drawing existed, so upgrading the app clears no approval.

Four places a plugin can appear:

| Contribution | Where it shows | What the plugin sends |
|---|---|---|
| `panels` | A tab in the **Plugins** view, in the rail's bottom drawer | A tree of nodes (below), redrawn whenever it likes. At most 8, each with an `id`, a `title` of at most 40 characters, and optionally one `icon` from `puzzle`, `review`, `check`, `chart`, `list`, `bell`, `bug`, `book`, `bolt`, `eye` — a word the app maps to its own set, so a plugin ships no image for it |
| `settings` | A page of its own in **Settings**, under Connections | Nothing: the app draws the fields and stores the values |
| `prNotes` | Inside a pull request: one entry per pass in the conversation's **Local** lane, and each note under its line in the Files tab | Runs and notes, with a severity, a path and a line |
| `prActions` | A button in every pull request's header, in the plugin's own colour, with the rest of its actions under a caret | Nothing to draw: the button's state is read from the plugin's runs on that pull request |

Everything goes through the plugin's own channel, `/plugin/self/…`, over its own
token. That channel is open at any scope, because drawing is not a power over
anything else. The name comes from the token, never from the request, so one
plugin cannot draw into another's panel.

| Route | What it does |
|---|---|
| `GET /plugin/self` | Its name, its declared contributions and its settings |
| `GET /plugin/self/events?wait=25000` | Long poll: clicks, submitted forms, settings changes, a note marked resolved, a pull request opened |
| `POST /plugin/self/panel` `{id, tree}` | Draw a declared panel |
| `POST /plugin/self/options` `{key, options}` | Choices for a `select` it could only find at run time |
| `POST /plugin/self/settings` `{values}` | Fill in its own declared settings — for a box the person edits that has to arrive with something in it |

`~/.config/agentglass/plugins.json` (mode 0600) is the whole record: what is
installed and where it came from, the approval on file, the master switch, the
catalogues added, and the settings values the person typed — which is why a
prompt written in a settings box never travels with the plugin.
| `POST /plugin/self/pr/run` | Start or finish a pass over a pull request |
| `POST /plugin/self/pr/notes` `{notes}` | Add or update notes |

**A button in a pull request** (`prActions`, at most five) is not a trigger
with a spinner. The first one declared is the button and the rest hang off its
caret, and what it says is the state of that plugin's latest run on that pull
request: *Local review* when there is none, *Queued*, *Reviewing · 1:12*, or
the counts it found, which open the findings. So a plugin posts its `queued`
run the moment it accepts the press — before any work starts — or the press
looks ignored. The event carries the action id and the pull request and
nothing else; an id the manifest never declared is refused.

**The vocabulary** ([shared/pluginUi.ts](../shared/pluginUi.ts)) is a closed set
of nodes the app draws with its own parts:

- layout: `stack`, `row`, `section`, `split`, `tabs`;
- content: `heading`, `text`, `markdown`, `code`, `badge`, `stat`, `keyValue`, `list`, `timeline`, `progress`, `empty`, `link`, `divider`;
- controls: `button`, `form`.

There is no HTML, no style, no colour and no image by URL. A tone is a word
(`accent`, `success`, `warning`, `danger`, `muted`) that the app maps onto the
current theme. A link is `https` or nothing. A tree is checked before it is kept,
with limits on depth, node count and string length, and an unknown node is
refused rather than skipped. A click comes back as the action id and payload the
plugin put on the control, and nothing else.

**What a plugin may hold**, because a plugin that writes in a loop is a plugin
that fills a disk: at most 8 panels and 60 settings fields (each with at most
200 options); 500 notes in one `POST`, 2000 notes on a pull request and 20 000
in total per plugin; 100 runs on a pull request and 5000 per plugin; 40 MB of
notes and runs per plugin. Past a limit the oldest go first and the write still
succeeds. The event queue holds 200: a plugin that stops polling for its events
loses the oldest ones rather than growing a queue nobody reads. And a run older
than a day stops speaking for the button in a pull request's header — a review
from last week is history, not the state of that pull request.

**A row can point at a pull request.** A `list` or `timeline` item may carry
`open: { repo, number, focus }`, and the app opens that pull request — from
whichever project is open, borrowing the checkout that holds it and offering
the way back. `focus: "local"` lands on the Local lane. It is the app's
errand, not a message to the plugin: `action` is still the plugin's, and an
item may carry both.

**Notes on a pull request** are never sent anywhere. Each one is marked *local*,
has no Reply, and offers Resolve, Dismiss, Reopen and Copy. The person's choice
outranks the plugin's: a note they resolved stays resolved when the plugin sends
it again, and the plugin hears the change as an event, so its next pass can take
it into account. Removing a plugin removes its notes; disabling it keeps them
readable. Removing it keeps what was chosen on its settings page, so a reinstall
comes back configured; the remove dialog (or `--drop-settings`) clears them too.

A worked plugin that uses all four is
[local-review](https://github.com/SirAllap/agentglass-local-review): it reviews
your labelled pull requests with the agent you choose, inside a sandbox, and
keeps the findings in the pull request view.

## From the terminal

`agentglass-plugin` does what the Plugins pane does, for a script:

    agentglass-plugin validate ~/code/my-plugin     # needs no running app
    agentglass-plugin add https://github.com/you/my-plugin --approve
    agentglass-plugin list                          # name, state, scope, what it draws
    agentglass-plugin list --json
    agentglass-plugin enable <name> --approve
    agentglass-plugin disable | update | remove <name>
    agentglass-plugin remove <name> --drop-settings  # its settings go too
    agentglass-plugin settings <name>               # what it holds
    agentglass-plugin settings <name> style=security

It is installed beside the app on Linux (`~/.local/bin/agentglass-plugin`); it
is one file with no dependencies beyond `python3`, so anywhere else — CI, a
machine with no agentglass — fetching `bin/agentglass-plugin` from this
repository is the whole installation.

Everything but `validate` talks to a running app: `AGENTGLASS_SERVER` (default
`http://localhost:4000`) and `AGENTGLASS_TOKEN`, which is read from
`~/.config/agentglass/token` when it is not set. The token is sent over https
anywhere, and over plain http only to this machine.

**`enable` asks to be told that somebody read the declaration.** Switching a
plugin on IS the approval, and the window earns the right to do it by drawing
the scope and every place the plugin draws first. A terminal draws nothing, so
`--approve` is how a caller says it showed them; it prints the declaration
before it enables. Without it, a plugin whose declaration is new or has changed
since it was approved is refused and told where to read it. A plugin already
approved is not re-approved by being switched on again.

`validate` is the one that works with nothing running: it reads a folder's
`plugin.json` and applies the rules the app applies at install, so a plugin's
own CI refuses a broken manifest before anybody tries to install it. It exits
0 or 1 and prints one JSON object, and it warns about what the app finds out
later — an icon named and not shipped, a missing README.

It carries its own copy of those rules, because CI has no agentglass to ask.
`server/test/plugin-cli-validate.test.ts` runs the app's validator and the
CLI's over the same cases, so the two cannot drift apart quietly.

## Installing from a web page

A catalogue lives on a site and the app lives on a machine; the only thing a
browser can hand across is a link. agentglass claims `agentglass://`, and the
**Install** button on a card opens

    agentglass://plugin/install?url=https://github.com/you/my-plugin

which raises the window and puts that URL in the install box in Settings ▸
Plugins. **It installs nothing.** The person presses Install, reads what the
plugin declares and switches it on — the same gate a URL pasted by hand goes
through. The link carries an `https` git URL and nothing else: a link that
could name a local path would let a page point the install box at somebody's
home directory.

A browser cannot be asked whether an application is installed. It either hands
the link over or does nothing, silently — so the button watches for the page
losing focus and, when nothing takes it, says so and offers the URL to copy.
The scheme is claimed only by a packaged install: from a checkout the
executable is Electron itself, and registering that would point the scheme at
whatever ran last.

## Being listed

Anybody can install a plugin from its git URL without asking anybody. The
catalogue is for being found: open the **List a plugin** issue on this
repository, and a check clones what you named, validates the manifest, reads
the source for a short list of patterns, and writes what it found on the
issue. Then a person decides.

**Listing is not auditing**, and the catalogue says so where people read it. A
listed plugin has a public repository, a manifest the app accepts, a README
and a licence — that is all a machine can tell. It still runs as a process on
the installer's machine, it still asks them to approve its scope and where it
draws, and the check never executes a line of it. Read the code.

The machinery, because the shape of it is the security argument:

| Stage | What happens | Where it runs |
|---|---|---|
| The issue | The form asks for the repository, a category, what it costs, and a checklist | — |
| `read` | Clones it shallow, validates the manifest, scans the source for a short list of patterns, writes a report | `contents: read` and nothing else, a checkout that keeps no credentials, and no write anywhere |
| `say` | Re-reads the live issue, then posts the report and sets `ready for listing` or `changes needed`. A run about the commit the last report names rewrites that report; a run about another commit or another repository posts a new one, so a push between two checks shows on the issue, and that report is held: it takes `ready for listing` and `approved for listing` off before it is posted and never puts `ready for listing` back, so a maintainer reads it and applies `ready for listing` again | `issues: write`, never looks at the submitted code |
| `approved for listing` | A maintainer's label. Re-checks that the actor still has write access and the issue still qualifies, fetches the exact commit the latest submission check reported on — refusing if the issue does not carry `ready for listing`, if that check did not pass, if it is held and no person has applied `ready for listing` since it was posted, if the repository has moved since, or if the report changed after the label — validates and scans it **again**, and opens a pull request adding the entry pinned to that commit and the content hash of its tree. Refuses an id already listed from another repository, and the project's own name as a stranger's publisher | `contents: read` and `issues: write`; the branch is pushed and the pull request opened with a GitHub App token minted for the run (contents and pull requests, no bypass), and no check is reported by this job |
| The merge | CI's `catalogue` job re-derives the entry from the pull request itself — one entry, the commit is on a branch or tag of the repository it names (not only a fork's), the id, draws, `minApp` and title are what the manifest at that commit makes them, a fresh clone hashes to the pinned hash — and the pull request merges on that and `build`. The App only opens it and arms auto-merge, and arms it only when `main`'s rules make `catalogue` a required check; otherwise the pull request waits for a maintainer and the issue says so. The site and the app read the file | — |

The split between the first two is the point: the job that touches a
stranger's repository has nothing in its environment worth stealing and no
permission to write anything, and what crosses to the job that does is a
report. Nothing submitted is ever executed, and the scan follows no symlink
out of the folder it was handed.

The pull request at the end is deliberate. A bot that writes to `main` needs
an apparatus to replace the person reading the diff; at this size the person
reading the diff is cheaper, and they are the catalogue's only reviewer.

## One plugin's output is another's input

The most useful thing a plugin can do is write something another one can read.
A reviewer does not own "findings on a pull request": it writes runs and notes
through `prNotes`, the app draws them, and a second reviewer — a different
model, a linter, a policy check — writes into the same lane beside it. The
person resolves a note once and every plugin hears it.

So when a plugin needs to talk to another, prefer the app's own shapes over a
private channel: notes on a pull request, a panel, settings. A contract the
app already draws is one an author can join by producing data, without
touching anybody's code.

**A blocklist**, `~/.config/agentglass/blocklist.json`, refuses a plugin by
name with a reason and an optional link. It is checked when one is switched on,
when it is started, and again when the app comes back up, so a plugin named
there cannot be running by the time anybody reads the list. It is the person's
own file; nothing writes it for them.

## What a plugin cannot do

**Run code in the window.** A plugin draws in the app ([Drawing in the
app](#drawing-in-the-app)), but only as data: it sends what to show, and the app
draws it with its own components. Not a line of the plugin's code runs in the
desktop window, which is the privileged surface: it holds the API token and can
open a shell, and anything executing inside it, an iframe tile included, would
live inside that trust. A screen the vocabulary cannot express can still be the
plugin's own window, a terminal UI or a web page it serves, talking to agentglass
over the same HTTP. That window is outside the app's trust boundary, which is the
point.

**Answer a gate.** See above. **Be handed the machine token.** The plugin gets its own
token at its own scope; the machine's is never put in its environment. That is a
statement about what the server passes, not about what the process can reach: it
runs as you, and the machine's token is a file your user can read. **Run before
it is enabled.** Install is a copy.

## Publishing one

1. Write the plugin as its own git repository with `plugin.json` at the root.
2. Push it to any host `git clone` reaches over `https://`, `ssh://` or the
   `git@host:path` form. The URL must not carry a credential — a plugin address
   is stored in `plugins.json` and reused for updates, so a `user:pass@` URL
   would sit on disk from then on and is refused; plain `http://` is refused
   too, since it would hand whatever the URL carries to anyone on the wire.
3. The URL is the publication. Pasting it into "Install a plugin" is enough. A
   catalogue is for when there is more than one plugin to list — see
   [Being listed](#being-listed) for how one gets into this repository's.

There is no build step, no registration and no account.

## A worked example

`hello-stream` — a `read`-scope watcher, two files.

```json
{
  "name": "hello-stream",
  "publisher": "someone",
  "description": "Writes a line to its own log whenever an agent finishes a turn.",
  "entrypoint": "bun run watch.ts",
  "scope": "read"
}
```

```ts
// watch.ts — a separate process. Everything it may do comes from two variables
// the server sets when a person enables it; nothing is imported from agentglass.
const URL_BASE = process.env.AGENTGLASS_URL ?? "http://127.0.0.1:4000";
const TOKEN = process.env.AGENTGLASS_READ_TOKEN ?? "";

const ws = new WebSocket(`${URL_BASE.replace(/^http/, "ws")}/stream?token=${encodeURIComponent(TOKEN)}`);
ws.addEventListener("message", (e) => {
  const frame = JSON.parse(String(e.data));
  if (frame.type === "event" && frame.data?.hook_event_type === "Stop") {
    console.log(new Date().toISOString(), "turn finished in", frame.data.session_id);
  }
});
```

Once enabled, its log shows the shape a `read` token has — a `GET` it was
allowed to make, and a write it was not:

```
GET /terminal/panes -> 200
POST /understudy/halt -> 403
watching /stream
```

The 403 is the mechanism working. `read` cannot halt a run, and nothing in the
plugin's own code changes that.

## Where this stops being small

The install / review / enable mechanism is the paired-device credential model
wearing an install button. Drawing is the same model with a screen: the plugin
still holds only its own token, and all it can add is data the app chooses how to
show.

What it does not do yet, and is the next thing after this:

- **A sandboxed frame** for a screen the vocabulary cannot express, such as a
  chart library or a canvas. It would be an iframe with no same-origin, a strict
  CSP and a message bridge that forwards only to the plugin's own actions. Until a
  real plugin needs it, the vocabulary grows instead.
- **A rail entry per plugin.** Every panel lives in one Plugins view, so the
  rail's hotkeys never move.
- **Drawing in other places than a pull request.** Notes attach to a pull
  request because that is where review happens; a card, a commit or a file would
  each be one more declared contribution of the same shape.
