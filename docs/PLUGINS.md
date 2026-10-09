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

**A plugin runs in a box, where this host can build one.** Its entrypoint is a
command this server starts as your user, inside a `bwrap` box: the system's own
folders read-only, its installed folder, its own data folder
(`$AGENTGLASS_PLUGIN_DATA`), the programs and paths its `sandbox` block lists,
and this app's address — no home folder, no other files, and, by default, no
internet. The scope you grant limits the token the plugin is handed for talking
to agentglass; the scope limits the token, not the process, and the box
limits everything else. A manifest with no `sandbox`
block gets the default box, so a plugin that wrote to your home folder or ran a
program from it must now declare that. **On Linux**, a host that cannot build
the box (bubblewrap missing, or Ubuntu's AppArmor limit on user namespaces)
**does not start** the plugin until you say it may run unboxed anyway — one
plugin at a time (`POST /plugins/allow-unboxed {"name", "allow": true|false}`,
revocable the same way; the plugin's card in Settings → Plugins has the button,
shown only while the plugin is refused or allowed that way), or
`AGENTGLASS_PLUGINS_UNBOXED=1` for every plugin on a host you already trust
completely — Settings → Plugins says so at the top while that is set, since it
has no switch there to turn off. Refused starts show why and how to fix it (install bubblewrap,
lift the AppArmor limit, or grant the consent) rather than widening the grant
silently; there is no per-plugin switch to run outside a box on a Linux host
that has one. **On macOS and Windows**, where bwrap does not exist at all,
every plugin still runs unboxed behind the same warning as before this
release — refusing by default would not defend anything there, since there
was never a box on those platforms to widen past.

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
| `sandbox` | optional; what the plugin asks to be given inside a box: `network` (`agentglass`, the default — only this app, reached through a proxy the box's own loopback is rewired onto; no internet, and no other program listening on this machine either — or `internet`, which shares the host's real network device, and with it every loopback service already listening on this machine), `read` and `write` (lists of `~/…` or absolute paths, at most 16 each) and `programs` (bare command names to put on its PATH). It is part of what a reviewer approves, so a grant that grows asks again, and the approval screen lists every path, in red when the name looks like a login. A grant of `~/.ssh`, `~/.gnupg`, `~/.config/agentglass`, the session bus folder, `~/.local/share/keyrings`, a system temp/proc/run/dev directory, a live tmux socket directory, or of a folder that contains one, is refused outright — as is a `write` grant of a shell's rc file, `~/.local/bin`, or anywhere else on this machine's PATH. **Enforced when this host can build a `bwrap` box: the process itself sees the system's own read-only folders (`/usr`, `/etc`, `/opt` and the rest of what `/`'s own layout puts there), its own installed folder (read-only), its own data folder (read-write), any declared `programs`, and the `read`/`write` paths listed here — nothing else.** On Linux, a host that cannot build one (bubblewrap missing, or blocked by Ubuntu's AppArmor user-namespace limit) refuses to start the plugin at all unless it — or every plugin, via `AGENTGLASS_PLUGINS_UNBOXED=1` — was explicitly allowed to run unboxed; only then does it run, behind a warning naming why. On macOS and Windows, where bwrap is not a thing, it always runs unboxed behind that same warning — refusing there would defend nothing. No block means the default: `agentglass` network and nothing else, so a plugin that needs more has to ask. |

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

Five places a plugin can appear:

| Contribution | Where it shows | What the plugin sends |
|---|---|---|
| `panels` | A tab in the **Plugins** view, in the rail's bottom drawer | A tree of nodes (below), redrawn whenever it likes; or, with `"canvas": true`, a live scene changed by operations (see *A live panel*). At most 8, each with an `id`, a `title` of at most 40 characters, and optionally one `icon` from `puzzle`, `review`, `check`, `chart`, `list`, `bell`, `bug`, `book`, `bolt`, `eye` — a word the app maps to its own set, so a plugin ships no image for it |
| `settings` | A page of its own in **Settings**, under Connections | Nothing: the app draws the fields and stores the values |
| `prNotes` | Inside a pull request: one entry per pass in the conversation's **Local** lane, and each note under its line in the Files tab | Runs and notes, with a severity, a path and a line |
| `prActions` | A button in every pull request's header, in the plugin's own colour, with the rest of its actions under a caret | Nothing to draw: the button's state is read from the plugin's runs on that pull request |
| `inboxAnnotations` | A small badge on Inbox rows, and a "Sort: <plugin>" choice in the Inbox's toolbar | A badge, a tip and a number per row (below). It cannot hide a row |

Everything goes through the plugin's own channel, `/plugin/self/…`, over its own
token. That channel is open at any scope, because drawing is not a power over
anything else. The name comes from the token, never from the request, so one
plugin cannot draw into another's panel.

| Route | What it does |
|---|---|
| `GET /plugin/self` | Its name, its declared contributions and its settings |
| `GET /plugin/self/events?wait=25000` | Long poll: clicks, submitted forms, settings changes, a note marked resolved, a pull request opened |
| `POST /plugin/self/panel` `{id, tree}` | Draw a declared panel |
| `POST /plugin/self/panel/<id>/ops` `{seq?, ops}` | Change a declared live panel (`canvas: true`) |
| `POST /plugin/self/options` `{key, options}` | Choices for a `select` it could only find at run time |
| `POST /plugin/self/settings` `{values}` | Fill in its own declared settings — for a box the person edits that has to arrive with something in it |
| `POST /plugin/self/inbox/annotations` `{items, replace?}` | Badge and order Inbox rows (`inboxAnnotations`) |

`~/.config/agentglass/plugins.json` (mode 0600) is the whole record: what is
installed and where it came from, the approval on file, the master switch, the
catalogues added, and the settings values the person typed (a `secret` field's
value is the exception: it is in `secrets.json`, below) — which is why a
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

**A key or a token** is a settings field of type `secret`. The window draws a
masked box; once saved the value is shown as *Set, hidden* with **Replace** and
**Clear**, and it is never sent back to the window. Every read of the settings
(`GET /plugins/settings`, the plugin list, a plugin holding `full` scope) gets
`null` in its place and a `set` list naming the secrets that hold a value; only
the plugin that declared it reads the value, over its own `GET /plugin/self` and
in its `settings` event. It lives in `~/.config/agentglass/secrets.json`, a 0600 file of its own
(`{plugin: {field: value}}`, rewritten whole and kept at 0600 on every save), so
that one code path reads it and `plugins.json`, which more of the app reads, never
holds a value; a key an older build left in `plugins.json` moves over the first
time it is read. That is a file only your user can read and not a keyring, so the
ceiling is plain: **a plugin running outside its box, and any program running as
you, can read it.** This hides the value from the app's screens and its API, not
from the disk. When a plugin runs outside its box while another holds a key, the
plugin's card and `agentglass-plugin list` say so: "<plugin> runs outside its box
and can read <holder>'s key". A manifest cannot give a
`secret` a default (a manifest is a public file), an update that turns the field
into anything else drops the stored value, a removed plugin's secret is never
kept for a reinstall, and a drawn `form` node never echoes one. From the
terminal, `agentglass-plugin settings <name> apiKey=-` reads the value from
standard input, because a value on the command line lands in shell history. The
review screen says when a plugin asks for one.

**Marking Inbox rows** (`inboxAnnotations: true`) is for a plugin that knows
something about a notification the list does not. It posts, per row, the thread
`id` and the `updatedAt` it was made for, and any of: a `score` (0 to 1) or a
`rank` (any number) to order by, a `badge` `{text, tone}` of at most 24
characters, and a `tip` of at most 200 (control, zero-width and bidi characters are stripped from both). At most 500 rows a post and 1000 kept per
plugin, in memory: a plugin posts again when it starts. `replace: true` drops
what it posted before. The app draws the badge as a chip on the row and adds
**Sort: <plugin>** beside **Time**, highest number first, rows it gave no number
after the ones it did. Newest first stays the default until the person picks the
plugin, and nothing here can remove a row, mark one read or change what it
says: an annotation for an older version of a row (`updatedAt` is not the row's
last update) is not shown, and the list has the same rows with or without it.

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

**A live panel** is a `panels` entry with `"canvas": true`. Where a tree is a
document the plugin re-posts, a canvas is a small scene the plugin changes many
times a second: things arrive in a lane, wait behind a gate, ride a wire to the
next stage and leave. It exists for boards, flow diagrams and instruments, and
nothing about it is specific to one plugin.

```json
{ "contributes": { "panels": [{ "id": "board", "title": "Pipeline", "canvas": true }] } }
```

It is declared, so the review screen says "Live panel" and the flag is part of
what was approved: a plugin approved as a static screen cannot start animating
without asking again. A canvas panel takes operations, not a tree (`POST
/plugin/self/panel` refuses it, and the operations route refuses a panel that is
not declared as one):

```
POST /plugin/self/panel/<id>/ops   {"seq": 12, "ops": [ ... ]}   ->  {"ok": true, "epoch": 3, "version": 41}
```

| Op | What it does |
|---|---|
| `add` | `{node: {id, type, parent?, ...props}, before?}` — one node; `parent` is a container, absent means the root |
| `set` | `{id, props}` — change props; `null` unsets an optional one. Type, id and parent cannot change here |
| `move` | `{id, parent?, before?, via?, ms?, easing?}` — re-parent or reorder; `via` is an `edge` id and the node rides that wire |
| `remove` | `{id}` — the node, what is under it, and every wire that touched any of them |
| `clear` | drop the scene |
| `animate` | `{id, kind: "enter" \| "exit" \| "pulse", ms?}` — a one-shot the app plays |

Node types ([shared/pluginCanvas.ts](../shared/pluginCanvas.ts) is the whole
list, with each one's props): containers `stack`, `row` and `lane` (a stage:
`title`, `state: open | closed | sealed`, `layout: list | grid | pile`, `icon`,
`activity`); leaves `token`, `label`, `counter`, `stat`, `badge`, `icon`, `spark`
(`values`, and `cap`, a limit drawn as a dashed line at that value on the same scale:
it is counted into the range, so a trend under its limit stays under the line),
`gauge` (`shape: arc | ring | bar | pips`, `value`, `max`), `countdown` (`until`,
ticked by the app so a clock is not an op per second) and `edge` (`from`, `to`,
`activity: idle | busy | flowing`; the app routes it between the two boxes); and
controls `button`, `segmented` and `disclosure` (plain text in a `<pre>`, for
"what was sent, exactly"). `grow` (1-4) on a container makes a board fill the
width. A control's click comes back through the same `/plugin/self/events` as a
tree's. There is no Markdown, no link, no image and, outside a board, no position: a scene must
never make the window fetch something on its own, and it cannot overlap.

**A board** is the other way to draw a live panel, for a plugin that draws a
machine instead of a flow: a stage of fixed size in its own units that the app
scales as a whole, with parts at fixed places, slots that hold tokens, and traces
that run under the parts. Nothing is specific to one plugin; a build farm or a
queue monitor uses the same words. A scene without a board is laid out as above,
exactly as before.

| Type | Lives in | Props (`*` required) |
|---|---|---|
| `board` | the root only, at most 2 per scene | `w`* 320-2400, `h`* 200-1600 (integers), `material: glass \| plain`, `label` |
| `part` | a `board`, directly | `x`* 0-2400, `y`* 0-1600, `w`* 24-2400, `h`* 24-1600, `depth` 0-4 (default 1), `step` 1-99, `title`, `hint`, `tone`, `action` (the whole part is a button) |
| `bay` | a `part`, directly; holds only `token`s | `cols`* 1-12, `rows`* 1-8 (`cols * rows` at most 64, also after a `set`), `sealed`, `caption` |
| `gate` | any container | `state`* `open \| closed`, `value`, `max` 1-60 (its pips), `label`, `tone` |
| `press` | any container | `activity`, `label`, `tone` |
| `core` | any container | `title`, `value`, `unit`, `hint`, `hint2`, `activity`, `tone` |
| `item` | any container | `title`*, `rank` 1-999, `meta`, `badge`, `badgeTone`, `dim`, `selected`, `action` |
| `lamp` | any container | `tone`, `label`, `on` |

An `edge` may live at the root or directly in a board. Inside a board it may also
carry `points`, 2 to 12 `[x, y]` pairs of integers in board units (0-2400 by
0-1600), and `kind: trace | control | seal` (default `trace`); a trace with no
`points` is drawn as a straight elbow between the two parts. `points` on an edge
anywhere else is refused, and so is moving an edge that has them out of its
board. Existing types gain props: `gauge` `shape: needle`, `digits` 0-4 and
`hideMax`; `counter` `digits` 0-6, `prefix` (at most 4 characters) and `style:
plain | odometer`; `segmented` `style: chips | lever`; `countdown` `shape: text |
ring` and `period` 1-86400 seconds (what a ring measures its remainder against).
A `move` with `via` an edge in a board rides that edge's points.

```json
[
  {"op": "add", "node": {"id": "line", "type": "board", "w": 1180, "h": 560, "material": "glass"}},
  {"op": "add", "node": {"id": "inbox", "type": "part", "parent": "line", "x": 40, "y": 60, "w": 300, "h": 220, "step": 1, "title": "Inbox", "hint": "acme/orbit"}},
  {"op": "add", "node": {"id": "queue", "type": "part", "parent": "line", "x": 520, "y": 60, "w": 300, "h": 220, "step": 2, "title": "Queue"}},
  {"op": "add", "node": {"id": "slots", "type": "bay", "parent": "queue", "cols": 4, "rows": 3, "caption": "waiting"}},
  {"op": "add", "node": {"id": "wire", "type": "edge", "parent": "line", "from": "inbox", "to": "queue", "kind": "trace", "activity": "flowing",
    "points": [[340, 170], [430, 170], [430, 120], [520, 120]]}},
  {"op": "add", "node": {"id": "n1", "type": "token", "label": "ORBIT-1042", "parent": "inbox"}},
  {"op": "move", "id": "n1", "parent": "slots", "via": "wire", "ms": 600}
]
```

The window keeps the whole board at one scale (between 0.6 and 1.6 of its own
size, scrolling sideways below that) and draws the parts over the traces. A
part's box is not checked against the board's size when it is written, since a
later `set` on the board could make it wrong; whatever falls outside is clipped.
A bay draws a slot per cell in scene order, and tokens past the last slot show as
"+N". There is no rotation, no free drawing (a trace is integer points, never a
path) and no plugin CSS. A board holds at most 2 per scene, traces at most 12
points, bays at most 64 slots and gates at most 60 pips; a `core` or `press` that
is busy counts as two looping animations (a core spins and pulses, a press has two jaws), a busy token as one. A board holds only parts and edges directly; everything else goes in a part or a bay.

**An instrument sheet** is the third way to draw a live panel, for a plugin whose
subject is a ring: stations round an orbit, a rate limiter's window, a clock that
counts to the next poll. A `board` is about what is next to what; a sheet is about
where on a ring. The plugin says what sits at which angle and the app does the
projection, the depth, the label columns, the paint and the motion. Angles are
degrees, 0 = right, growing clockwise, and an angle is below 360, never 360. An
out-of-range prop refuses the op by name; nothing is clamped into a different
meaning.

| Type | Lives in | Props (`*` required; ranges inclusive unless "below") |
|---|---|---|
| `sheet` | the root, a stack, a row or a `fold`; one per `fit` | `w`* 320-1200, `h`* 200-700 (integers), `fit`* `wide \| narrow`, `material: plain \| inset`, `label` (read aloud), `key` up to 4 `{shape: ring \| dot \| diamond, label}` (the legend, top right) |
| `orb` | a sheet; at most 1 | `cx`* 0-1200, `cy`* 0-700, `r`* 8-300 (integers), `light` 0 to below 360 (where the lit side faces), `bands` 0-8, `terminator`, `tone`, `halo` |
| `plane` | a sheet; at most 2 | `cx`*, `cy`*, `rx`* 40-600 (integers), `tilt`* 15-90 (the angle it is seen from: 90 is a circle, 27 an ellipse .454 as tall as wide), `roll` -45 to 45, `depth` 0-1 (near moons grow and far ones shrink by up to 35 percent of it), `label` |
| `band` | a plane; at most 4 | `r0`*, `r1`* (0.2-1.6 of the plane's `rx`, `r1 > r0`), `from`* 0 to below 360, `to`* above `from` and at most `from + 360` (a sector across 0 is `330` to `390`), `layer: back \| front \| all`, `segments` 1-60 and `lit` 0-`segments` (a 30-sector gate is one node; each segment is at least 1 degree), `tone`, `halo` |
| `ticks` | a plane; at most 1 | `count`* 8-120, `mark` (every nth is longer), `lit` 0-16 (the last marks before the hand), `passed`, `until` (an epoch in ms) with `period` in seconds (1-86400): the window works out the passed marks and the hand once a second, so a clock costs the plugin no operations; `until` wins over `passed`. `side: out \| in`, `numerals` up to 4 `{at, text}` of 1-3 characters, `tone` |
| `hatch` | a sheet; at most 2 | `of`* (an orb, or a band of that sheet), `from`*, `to`*, `gap`* 6-24, `angle` 0 to below 180. The lines cover the shape, at most 80 |
| `reticle` | a plane; at most 1 | `of`* (a token of that plane), `chip` (plain text, top left) |
| `dock` | the root, a stack or a row | `title`*, `value`, `until` (an epoch in ms: the value line becomes the time left as `mm:ss`, redrawn by the window once a second, so a live line costs no operations; `value` is what shows without it), `unit`, `hint`, `hint2`, `tone`, `selected`, `here` (the stop of a journey you are at), `leg: idle \| busy \| flowing` (the trace into it), `action`; holds one `gauge` |
| `fold` | the root, a stack or a row | `h`* 160-760 and `hNarrow` (the height when the panel is narrow), `open` (the first state), `label`, `action` |

A `token` in a plane gains `at`* (it is refused outside a plane, and a token in a
plane without it), `size: lg`, `shape: ring \| dot \| diamond`, `halo`, `trail`
0-12 slices with `trailSpan` 5-120 degrees (a fading tail behind it), `leader:
left \| right \| below \| above \| none` (its label on a hairline; the app stacks each margin
column and drops what does not fit, saying how many; `below` and `above` hang the
label on a short hairline under or over the moon, which is where the top station goes
when a label under it would run into the body), `value` and `unit` (a second
line); its `count` is the number in the moon. An `edge` between two tokens of one
plane follows the plane; `breakAt` 0-1 with `breakGap` 0.02-0.5 cuts a gap with end
marks, the open breaker. A `gauge` gains `shape: ticks` (`max` 8-120) and
`segments` (`max` up to 12), `mark` 0-1 (a tick on an arc, ring or bar: a p95, a
threshold) and `values`, 1-3 concentric arcs on an arc. A `ticks` gauge also takes
`until` (an epoch in ms) with `period` in seconds, 1-86400: the window lights the
marks as the period runs, once a second, so an elapsed gauge costs the plugin no
operations while it runs. `until` wins over `value`, which stays the static
fallback; a `period` alone, or either on another shape, is refused.

Rules a reviewer can lean on. The window shows the sheet whose `fit` matches the
PANEL's width (900 px is the line), so build the narrow one rather than hoping the
wide one scales. A fold's `h`, `hNarrow` and `open` are set when it is added and a
`set` of them is refused: a control never moves under the pointer because a
plugin toggled a drawer. Whether it is open is the person's, kept across a
reconnect; the plugin hears of it only through the fold's `action`. Pressing a
dock opens the first fold and runs the dock's `action`. A sheet costs what it
draws: every SVG element is priced (`halo` 1, a trail slice 1, ticks and bands
and hatches one path each however many marks), at most 320 per sheet, and a `set`
that would pass it, on this node or on the plane it sits on, is refused with the
number. What a node points at (a reticle's token, a hatch's shape, an edge's
ends) is checked on the whole scene after every batch, so a `move` cannot leave
one dangling, and a `remove` takes what pointed at the node with it. A moon is
never drawn larger than 24 units. A moon that gets a new `at` travels to it (a
tween, 420 ms, counted among the 64) and jumps under reduced motion. The props
that carry a lot of light (`tone`, `lit`, `halo`, `light`, `terminator`,
`material`, `shape`, `leg`, `selected`, `here`) are drawn at most once per 400 ms
per node, 1 s under reduced motion, whatever rate they arrive at. In dark `halo` is
a soft disc behind the thing, in light the same flag is an accent ring: one
prop, two looks. Nothing in a sheet takes the pointer except a `dock` and a
`fold`'s bar, and nothing can be placed or painted outside the sheet's box.

What the app does so the plugin does not have to: lays everything out, routes the
wires, maps `tone` and `icon` (fixed lists) onto the theme, light and dark, and
draws it all in the house style. Under `prefers-reduced-motion` every duration is
0, no loop runs and the scene still updates. Only `transform` and `opacity`
animate, everything pauses when the panel is hidden, at most 64 loops and 64
one-shots run at once (the rest draw still), and `ms` is at most 2000.

What it holds: 400 nodes, 128 KB of scene, 8 levels deep, labels of at most 120
characters, a `disclosure` of at most 8000, 100 ops and 64 KB per request (the
body is cut off at the limit before it is parsed), and a budget of 60 ops a second
with a burst of 200 (a request costs at least one, so a loop of empty ones is
not free; past it, `429` with `retryAfterMs`). Ids are `a-z0-9_-`, at most 64. A
batch is all or nothing: one bad op refuses the batch and the scene is untouched.
The server owns `version` (+1 per batch) and `epoch` (new whenever the scene
starts over, e.g. the plugin restarted); `seq` only lets a plugin retry a batch
it is not sure arrived, and a repeat of the last one answers `applied: false`.

The window watches every live panel it has open over one private WebSocket
(`/plugins/panels/live`), which needs the desk's credential: a plugin's own token
is refused there whatever scope its manifest declared, so one plugin cannot watch
another's scene, and a paired read-only phone cannot either. A window that falls
behind is sent the scene as it is, not what it missed. The shared `/stream` socket
carries no scene.

Ceilings, chosen: a canvas cannot draw arbitrary shapes, run code per frame or
link out; a plugin that needs that is still its own window, as before.

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
