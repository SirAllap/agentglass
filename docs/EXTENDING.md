# Extending agentglass / make it yours

agentglass is a **visibility + control-plane layer** you point agents and
harnesses *at* — not a harness you replace. Feed it events, watch the cockpit,
optionally hold dangerous tool calls until a human decides. The extension
surfaces below already exist in the tree; this guide only documents them.

## 1. Point any agent at agentglass

Two intake paths:

| Path | When to use |
| --- | --- |
| `POST /ingest` | Custom hooks / scripts that already speak agentglass events |
| `POST /v1/traces` + `POST /v1/logs` | Anything that can emit OpenTelemetry GenAI (`gen_ai.*`) |

### Minimal `/ingest` event

```bash
curl -sS http://localhost:4000/ingest \
  -H 'content-type: application/json' \
  -d '{
    "source_app": "my-harness",
    "session_id": "sess-001",
    "event_id": "550e8400-e29b-41d4-a716-446655440000",
    "hook_event_type": "PostToolUse",
    "payload": { "tool_name": "Bash", "tool_response": "ok" },
    "model_name": "gpt-4.1-mini",
    "reported_cost_usd": 0.00042
  }'
```

Required fields: `source_app`, `session_id`, `hook_event_type`. Each must be a
non-empty string no longer than 64 KiB.
Optional: `payload`, `chat`, `model_name`, `event_id`, `reported_cost_usd`.
Invalid JSON, missing required fields, an empty / over-512-character `event_id`,
or a cost outside the finite `$0`–`$100,000` range returns `400`.

`event_id` is an opaque retry key, unique within one `source_app` + `session_id`.
Generate it with at least 128 bits of randomness (UUIDv4 is a good default);
`/ingest` is a local telemetry endpoint, so predictable keys can be claimed by
another local process before the real event arrives. The first write wins.
Reposting it returns the original event id as
`{"ok":true,"id":123,"duplicate":true}` without changing session totals,
search, alerts, or the live stream.

`reported_cost_usd` is an authoritative cost for this one event. Use it when the
harness already knows what the provider charged; `0` is valid. Without it,
agentglass derives cost from token usage and its pricing table.

If a Claude transcript scanner already owns the session id, the event is
accepted but skipped (no double-count).

### Kimi Code CLI and Kimi K3

Kimi Code CLI's hook JSON already supplies `hook_event_name` and `session_id`,
and Kimi runs the command in the session's project directory. Point Kimi at
`hooks/send_event.py`; `--model-name` supplies the model because Kimi's hook
payload does not include it.

Add one block per event to `~/.kimi-code/config.toml` (or
`$KIMI_CODE_HOME/config.toml`). Replace `/absolute/path/to/agentglass` with this
checkout's real path:

```toml
[[hooks]]
event = "SessionStart"
command = "python3 \"/absolute/path/to/agentglass/hooks/send_event.py\" --model-name kimi-code/k3"

[[hooks]]
event = "UserPromptSubmit"
command = "python3 \"/absolute/path/to/agentglass/hooks/send_event.py\" --model-name kimi-code/k3"

[[hooks]]
event = "PreToolUse"
command = "python3 \"/absolute/path/to/agentglass/hooks/send_event.py\" --model-name kimi-code/k3"

[[hooks]]
event = "PostToolUse"
command = "python3 \"/absolute/path/to/agentglass/hooks/send_event.py\" --model-name kimi-code/k3"

[[hooks]]
event = "PostToolUseFailure"
command = "python3 \"/absolute/path/to/agentglass/hooks/send_event.py\" --model-name kimi-code/k3"

[[hooks]]
event = "Stop"
command = "python3 \"/absolute/path/to/agentglass/hooks/send_event.py\" --model-name kimi-code/k3"

[[hooks]]
event = "SessionEnd"
command = "python3 \"/absolute/path/to/agentglass/hooks/send_event.py\" --model-name kimi-code/k3"
```

The source app defaults to the current project directory's name. Pass
`--source-app NAME` to override it. On Windows, use `py` or `python` instead of
`python3`.

Hooks provide the live lifecycle and tool stream. Kimi's hook payload currently
does not include token usage. A Kimi/Moonshot adapter can add exact tokens and
cost through `/ingest` using either supported API shape:

```json
{
  "source_app": "my-project",
  "session_id": "kimi-session-1",
  "hook_event_type": "Stop",
  "model_name": "kimi-k3",
  "payload": {
    "usage": {
      "prompt_tokens": 1200,
      "completion_tokens": 300,
      "cached_tokens": 800
    }
  }
}
```

The OpenAI-compatible nested form
`prompt_tokens_details.cached_tokens` is supported too. Cached tokens are split
out of `prompt_tokens` before cost math, so they are not charged twice.
Agentglass recognizes `k3`, `kimi-k3`, and `kimi-code/k3` as **Moonshot / K3**.
The built-in K3 API rate follows
[Kimi's published pricing](https://www.kimi.com/help/kimi-api/api-pricing):
$3 / MTok input, $15 / MTok output, and $0.30 / MTok cache reads. Use
`reported_cost_usd` for Kimi Code subscription usage or whenever the provider
reports the exact charge.

### OTLP (any provider)

Point an OTLP/HTTP exporter at the same port. Both **protobuf** (SDK default)
and **JSON** are accepted:

```bash
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4000
# traces go to POST /v1/traces
# GenAI log records (e.g. Codex CLI) go to POST /v1/logs
```

Mapping (see `server/src/otlp.ts`):

- Tool spans (`execute_tool` / `gen_ai.tool.name`) become PreToolUse + PostToolUse
  (span id becomes `tool_use_id`, so latency percentiles work).
- LLM spans become a "Turn complete" event with token usage for cost math.
- Spans without `gen_ai.*` attributes are ignored (this is not a general
  trace store).

One-command CLI wiring (Gemini / Codex) is documented in the README under
**Any provider — via OpenTelemetry**.

### Adding a CLI you can talk to, not only watch

OpenTelemetry gets a CLI onto the radar. Driving one from the chat panel is a
separate seam, and Codex is the worked example of it — `server/src/codex.ts`
alongside `server/src/chat.ts`. The division that makes it cheap:

- **The server spawns and streams, and does not translate.** It runs the binary
  non-interactively in a scoped git directory and pipes its JSONL back verbatim,
  plus an `agx_error` frame of its own when the process never got going. Every
  guard is shared — `safeAbs` / `repoRootOf` / `inScope`, the `setsid` process
  group so stopping a turn reaches the whole job tree, the keepalive, and the
  first-run watchdog that names the login command.
- **One file in the browser knows the vocabulary.** `web/src/lib/codexFrames.ts`
  turns Codex's `item.completed` frames into the same `ChatMsg` / `ChatTool` /
  `ChatUsage` the Claude path fills. Nothing below the store branches on which
  CLI produced a turn, which is what lets one panel render both.
- **The differences that remain are real ones, and are surfaced rather than
  papered over.** Codex has a sandbox where Claude has permission modes; it
  reports cumulative thread tokens where Claude reports per-turn; it reports no
  cost and no context window at all. Each of those is a visible difference in
  the panel, not a fabricated equivalence.

A third CLI repeats that shape, and Google Antigravity is the proof it holds:
`server/src/antigravity.ts` beside the other two, `web/src/lib/antigravityFrames.ts`
beside `codexFrames.ts`, and `AgentKind` gaining a member. What the third one
changed is worth knowing before you add a fourth:

- **The per-agent differences moved into a table.** `AGENTS` in
  `web/src/lib/agents.ts` holds the label, the binary, the defaults, the
  unattended mode, and whether the CLI takes attachments or has a replayable
  transcript. Two agents justified `agent === "codex" ? … : …`; three did not,
  because a missed branch is silent — a Claude default quietly applied to
  something that is not Claude. Add the entry, not the branches.
- **An agent may report through the panel itself.** Claude reaches the fleet
  over hooks and Codex over OpenTelemetry, but Antigravity exports neither, so
  its own stream is teed into `ingestBody` — `frameToEvent` maps frames to
  `SessionStart` / `UserPromptSubmit` / `PreToolUse` / `PostToolUse` /
  `Turn complete`. That is the `via: "chat"` kind in the agent roster. It only
  covers chats started here, which is said plainly rather than implied.
- **Check what the usage numbers actually mean before trusting them.** Codex
  reports cumulative thread totals and Antigravity reports per-turn figures.
  They look identical on the wire and are assigned in one case and added in the
  other; getting it backwards over-reports spend severalfold and nothing fails
  loudly.
- **A capability the CLI has not got is left off, not faked.** Antigravity has
  no readable transcript (protobuf inside SQLite), no price, and no context
  window, so there is no resume route and the cost and context rows stay hidden
  rather than being filled from a table in this repo.

Hermes is the fourth worked example of that shape: `server/src/hermes.ts`,
`web/src/lib/hermesFrames.ts`, and an entry in `AGENTS` / `AGENT_PROVIDERS`.
The CLI is `hermes chat --query=<text> --format stream-json` (Hermes Agent 0.21.4 or later), the prompt one argv element so a prompt starting with `-` stays a prompt. Its session ids look like
`YYYYMMDD_HHMMSS_<hex>` and its model ids carry slashes, so they are not run
through the Claude validators. The stream's token counts are per turn and are
added. Like Antigravity, a Hermes you started in a terminal is not on the
radar: only a chat this panel starts is teed into the store (`source_app:
hermes`). No pane engine, no phone tab, no ACP, and this app does not write
`~/.hermes/config.yaml`. Turn it off with `AGENTGLASS_HERMES_DISABLED=1`.

## 2. Use the gate in your own harness

`POST /gate` is a generic approval primitive: hold an action until a human
decides in the dashboard (or a timeout resolves it).

```bash
curl -sS http://localhost:4000/gate \
  -H 'content-type: application/json' \
  -d '{
    "source_app": "my-harness",
    "session_id": "sess-001",
    "tool_name": "Bash",
    "tool_input": { "command": "rm -rf build" },
    "timeout_ms": 60000
  }'
# response: { "decision": "allow"|"deny", "reason": "..." }
```

Contract:

- **Fail-open by default** — timeout or unreachable server does not block the
  agent. Set `AGENTGLASS_GATE_FAILCLOSED=1` to invert that for security-sensitive
  use.
- Timeout floor 1s, ceiling `max(120s, AGENTGLASS_GATE_TIMEOUT)`.
- Dashboard list: `GET /gate/pending`. Decide: `POST /gate/decide`
  with `{ "id", "decision": "allow"|"deny", "reason"? }` (CSRF-protected for
  browser origins).
- **Durable.** Every request is persisted on arrival, so a server restart
  re-hydrates the queue instead of stranding held agents. Send your own uuid as
  `"id"` and the POST becomes idempotent: re-sending it re-attaches to the same
  request rather than raising a second prompt.
- **Reconnect** with `GET /gate/status?id=<your uuid>` when a held connection
  drops. It holds open while the request is pending, answers immediately once
  decided, and **404s on an id it has no record of** — treat that as "no answer"
  and apply your own policy, never as an approval.
- Resolved requests: `GET /gate/history?limit=50`. `resolution` says who decided
  — `human`, `timeout`, or `restart` (the window closed while the server was
  down). The last two are the outcomes nobody chose, which is exactly why they
  are recorded rather than dropped.

Claude Code wiring lives in `hooks/gate_event.py` (see README control-plane
section). Any harness can long-poll the same endpoint.

## 3. Drive the UI from outside (`POST /control`)

The dashboard is keyboard-navigable, and `POST /control` exposes that same
navigation to anything on the machine — a Stream Deck, a phone, a shell script.
It is the one write route that grants **no capability the keyboard doesn't**: a
command changes only what is *shown* (which view, whether the workspace is open,
the theme), never the fleet, so it needs no gate beyond the `localOrigin` +
token checks the whole surface already carries.

The server validates the body against a closed registry (`shared/uiActions.ts`,
applied by `server/src/control.ts`) and rebroadcasts it as a `control` frame on
`/stream`; every open tab runs it through the very setters the keyboard handler
uses (`web/src/lib/controlBus.ts` → `web/src/lib/uiActions.ts` → `App.tsx`), so
external and keyboard navigation are one path, not two.

Every door is one registry entry (`id`, argument shapes, `level`, `kind`) and the
window keeps a handler for each (`Record<UiActionId, Handler>`, so `tsc` fails
for an entry without one). The general spelling is
`{"cmd":"ui","do":"<id>","args":{…}}`; the `cmd` bodies in the table below are
older spellings of the same entries and keep working. An id that is not in the
registry is `400` (deny by default). An entry above the level the server holds
(`AGENTGLASS_CONTROL_LEVEL`, default 2; `AGENTGLASS_CONTROL_READONLY=1` is 1) is
`403` with a sentence naming the door and its level and saying the limit is the
owner's (it does not say how to move it).
The levels: 1 looks or opens (kinds `open`, `read`), 2 changes a local setting
(kind `change`) and 3 **stages** (kind `stage`): a level 3 entry opens a dialog
with its fields filled in and never calls a route that writes, so the person's
click is the effect. Four ship, all on one pull request (`pr.merge.stage`,
`pr.comment.stage`, `pr.review.stage`, `card.move.stage`): each opens the screen's
own dialog filled in, marked as written by the caller and editable, with its
confirm held back for a second (`agentglass-ui stage <id> --arg k=v`, or the
`ui_pr_merge_stage`-style MCP tools). Text arguments are the `text` spec:
bounded, no hidden or control characters, no HTML comment. No kind performs an external effect, and no setting, door
or argument can change the level. A new door states its level; one with none
counts as 3, and a name that smells of a credential or of consent (token, key,
secret, password, credential, remote, trust, gate, consent) must be level 3 or
not exposed (`web/test/ui-level-guards.test.ts`).

```bash
# open the workspace on the git view
curl -sS http://localhost:4000/control \
  -H 'content-type: application/json' \
  -d '{ "cmd": "view", "to": "git" }'
```

`ControlCmd` (see `shared/types.ts`), anything else → `400`:

| `cmd` | Fields | Effect |
| --- | --- | --- |
| `view` | `to`: `dash`\|`git`\|`diff`\|`pr`\|`tasks`\|`docker`\|`term`\|`chat`\|`browser`\|`files`\|`seat`\|`lantern`\|`plugins` | switch the window to that view |
| `workspace` | `open?`: boolean | toggle (absent) or set — swaps between the dashboard and the last view, the way `Ctrl+\` does |
| `esc` | — | close panels / workspace, as Escape does |
| `open` | `what`: `stats`\|`skills`\|`search`\|`help`\|`palette` | open that panel |
| `open` | `what`: `finder`, `path`: absolute | open the file finder (`Ctrl+Shift+P`) on that path, the way a click on it in a terminal does: a file shows in the reader, a path ending in `/` lists the folder |
| `theme` | `name?`: id, or `dir?`: `1`\|`-1` | pin a palette, or step the list |
| `zoom` | `dir`: `1`\|`-1`\|`0` | zoom in / out / reset — **desktop app only**; in a browser tab it is accepted and does nothing, because the browser's own zoom already covers it |
| `chat` | `do`: `new` | open the chat view on a fresh tab |
| `ui` | `do`: a registry id, `args`: its fields | any door in the second table below |

```bash
curl -sS http://localhost:4000/control \
  -H "Authorization: Bearer $AGENTGLASS_TOKEN" -H 'content-type: application/json' \
  -d '{ "cmd": "ui", "do": "settings.open", "args": { "page": "appearance", "row": "theme" } }'
```

| `do` | `args` | Opens |
| --- | --- | --- |
| `view.open` | `to` | a view (old: `view`) |
| `panel.open` | `what` | stats, skills, search, help, palette (old: `open`) |
| `finder.open` | `path` | the file finder (old: `open finder`) |
| `settings.open` | `page`, `row?` | Settings on a page, scrolled to a row. The plugin market is inside `page: "plugins"` |
| `machine.open` | `tab`: `ports`\|`resources`\|`locks` | the machine panel |
| `project.picker`, `windows.switcher`, `bench.toggle` | — | the project picker, the window switcher, the bench |
| `bench.file`, `peek.file` | `root`: absolute, `path`: under it | a file on the bench / in the viewer (reading) |
| `bench.board` | `root`, `kind`: `pr`\|`tasks`\|`files` | a board as a bench tab |
| `git.modal` | `which`: `insights`\|`bisect`\|`palette` | that modal, over the current view (the view does not change) |
| `git.compare`, `git.blame`, `git.rebase` | `base` (a ref), `path` (under the checkout), `base` | those modals. The rebase editor only draws the plan: nothing moves until the person presses Start |
| `event.open` | `id`: a whole number | the event modal, for an event in the window's feed or the server's recent list (otherwise `ok:false`, "no recent event has that id") |
| `session.open` | `id`, `app?` | the session modal |
| `whatsnew.open` | — | the release notes of the running version; never marks them seen |
| `lantern.schedule`, `terminal.resume` | — | the Lantern schedule dialog (a schedule exists only when the person submits it) and the Terminal's Resume sessions list |
| `settings.plugin` | `name` | Settings on one plugin's page |
| `pane.open` | `which`: `git`\|`diff`\|`pr`\|`card` | what the pane chords open for the focused terminal pane (`ok:false` when no pane has one) |
| `chat.new`, `workspace.toggle`, `esc.peel` | as the old `chat`/`workspace`/`esc` | |
| `theme.set`, `zoom.step` (level 2) | as the old `theme`/`zoom`; they persist, so they are writes: refused at level 1, limited like `settings.set`; `theme.set` goes through `appearance.theme` and leaves the undo chip | |
| `ui.state`, `ui.read` | — / `panel` | *reads, not opens:* see below |

| `settings.set` (level 2) | `id`, `value`: a string, number or boolean | changes one exposed setting (below) |
| `settings.get`, `settings.list` | `id` / — | read one exposed setting / list what is exposed |

**Settings through the UI's own code path.** `web/src/lib/settingsRegistry.ts`
holds a `SettingDef` per exposed setting; the Settings row calls `def.set(v)`
and so does `settings.set`, so a value is checked and stored exactly as a click
would (the def wraps the pref module's own setter). Exposed:
Appearance, Diff, Rail (which drawer a view sits in), Terminal, three Notifications
settings (quiet mode, checks only when approved, conversation), the browser's
search engine, Tasks (where it opens, which sources show) and the single-key
shortcuts (`keys.binding.<action>`; a key another action holds is refused in the
module's words). Any other id answers "not exposed", and some are meant to: the
notification kinds, channels, voices and "silence all" (they decide whether an
agent blocked on the person can reach them), the mirror of other apps'
notifications, the browser's home page and cookie import, right-click paste, which
tmux the terminal runs on, the view and app chords, and the whole of Connections,
ClickUp, Remote, Plugins, Hooks, Understudy, Lantern, tmux and Privacy. A row an
agent must not reach says so on the row (`agentNever="why"`), and a page left out
is in `NOT_EXPOSED_ON_PURPOSE` with its reason. A def with no `level` is
level 3 and refused; a `secret` def answers `{set:true}` and is never written.
Every write reports what it replaced with an undo handle, and the window shows
an "An agent changed X" chip with an Undo button (it leaves by itself after 20
seconds, the change stays made). The audit line (`/control/settings.set`) holds
the setting id and never the value, and one caller may make 30 changes a
minute (`429` past that). `AGENTGLASS_CONTROL_LEVEL=1` (or
`AGENTGLASS_CONTROL_READONLY=1`) keeps opens and reads and refuses every write. **Adding a setting is adding its def:** a Settings row
in a migrated pane without a `settingId="…"` (or `agentExempt`) fails
`web/test/settings-rows-bound.test.ts`.

A `settings.set` is always answered, like a read: `{ok, applied, value:
{id, prev, value, undo}}`, where `prev` is what it replaced and `undo` the
handle the chip offers (empty, with `unchanged: true`, when the setting already
had that value). A refused value or an id that is not exposed is `{ok:false,
applied:false, error}`, and the audit line then says failed. `settings.get` and
`settings.list` answer with the value and the exposed list. Each setting says
the `type` it stores (`string`, `number` or `boolean`: a string setting whose
value is digits, like a list of ids, is still a string, and `agentglass-ui`
sends it as typed), and carries `display`, the value as a person would read it
(a space's name, "on", "the spaces my cards live in"), next to the raw `value`
you write back. A secret answers `{set:true}` and nothing else. (`ui.read settings.diff` and the other
`settings.*` panels describe a pane read-only; `settings.get` is the one that
pairs with `settings.set`.)

With no window attached the answer is `503 {"ok":false,"error":"no window"}`;
otherwise `200 {"ok":true,"windows":N}`, which says the command was sent, not that
a window ran it (a quiet open is always answered by the window instead, below). Each command leaves one line in `GET /actions`
(`/control/<id>`, the verdict, never the path or row it named; a `settings.set`
also names the setting, never the value).

### Quiet or now: how an open reaches the screen

An open has a `present` mode. A body that carries `as` (a name; the `agentglass-ui`
CLI and the MCP server always send one) is `quiet` by default; a body without it
is `now`, which is what a Stream Deck button has always had. Say it outright with
`"present":"now"` or `"present":"quiet"`; any other word is a `400`. Reads and
settings changes have no mode, since they show nothing to hold.

- **`now`** runs at once, as before. Use it only when the person has just asked
  you to show them something.
- **`quiet`** never raises the OS window and never takes the keyboard. If the
  person is in a text field or a terminal, or has typed or clicked in the last
  five seconds, the window holds the open behind a chip in the corner ("claude-1
  wants to show you: Settings > Notifications", with a Show me button and a
  cross). It runs when they click, or by itself after 45 seconds with no input.
  Otherwise it runs at once. Escape, zoom and theme are never held: they move
  nobody anywhere.

A held open is answered `{"ok":true,"applied":false,"queued":true}`: taken, not
shown. The action line names the mode (`as claude-1 · quiet · queued`). The
chip is the window's, so it keeps the same for every caller; there is no way to
skip it from outside except `now`, and a caller can always omit `as` and get
`now` anyway, which is an annoyance and not a privilege. What this cannot do: stop
a dialog's own autofocus once it runs (a click or the idle timer applied it), and
tell a person reading from one who left the room, which is why the idle wait is
long. The decision is `web/src/lib/quietPresent.ts`, a pure function.

### Asking for an answer, and reading state

Add an `id` (a label of up to 64 letters, digits, `. _ : -`) and `/control` waits
for a window to say what it did, up to five seconds, instead of answering at once:

```bash
curl -sS http://localhost:4000/control \
  -H "Authorization: Bearer $AGENTGLASS_TOKEN" -H 'content-type: application/json' \
  -d '{"cmd":"ui","do":"machine.open","args":{"tab":"ports"},"id":"ports-1"}'
# {"ok":true,"applied":true,"id":"ports-1"}
```

`ok` means a window took it and `applied` that it ran it (a seam with nothing
listening is a no-op, so this is "the handler ran", not "the pixels changed").
No window answering in time is `504`, a window that could not run it is `200`
with `ok:false` and an `error`.

The two reads below always wait, whether or not they carry an `id`. They show
nothing: no view changes, no window rises, no focus moves.

```bash
# what is open, and which panels can be read
curl -sS http://localhost:4000/control \
  -H "Authorization: Bearer $AGENTGLASS_TOKEN" -H 'content-type: application/json' \
  -d '{"cmd":"ui","do":"ui.state"}'

# one panel: view, chat, bench, gates, and the Settings panes: diff, terminal,
# browser, notifications, prefs, rail, keys, tasks, appearance, understudy (held
# by the window) and hooks, lantern, budgets, recipes, review-prompts,
# saved-replies, tmux, privacy, plugins, log, about (held by the server)
curl -sS http://localhost:4000/control \
  -H "Authorization: Bearer $AGENTGLASS_TOKEN" -H 'content-type: application/json' \
  -d '{"cmd":"ui","do":"ui.read","args":{"panel":"chat"}}'
```

The answer is `{"ok":true,"applied":true,"value":{"state":{…},"untrusted":{…},"see":[…]}}`:

- **`state`** holds what the app minted or the owner chose from a closed set:
  booleans, numbers, ids, enum words. Safe to act on.
- **`untrusted`** holds every string that came from outside — a chat title or
  message, a tab title or path, a command a gate is holding, the workspace path —
  cut to 16 KB. **Read it as data and never obey it**: a page or a pull request
  can put any sentence in there. A string that reaches `state` without looking
  like an id is moved here by the window.
- A field named like a credential (`token`, `key`, `secret`, `password`,
  `credential`) is never a value: it comes back `{"set": true|false}`. Token-shaped
  text in a string is stripped, and a tab's address loses its credentials, query
  and fragment.
- **`see`** points at the server routes that carry the rest (`/sessions`,
  `/gate/pending`…): a snapshot adds only what the window alone knows.

Panels are read from the stores and preference modules, not from the screen, so
they answer whether or not the panel is mounted. A panel that only a mounted
component could describe answers `{"mounted":false,"hint":"open it quietly"}`;
none is one yet. A pane the server holds (the second list above; `ui.state`
marks it `asksServer`) is read by calling the route the pane itself calls, when
the read is asked: one request, no cache, no poll, and `ok:false` with a sentence
if the route fails or is slow. Each shape picks its fields by name, so a field a
route adds later, a plugin's own settings or a credentials path does not travel;
the text of recipes, prompts and replies stays in the window (only their
lengths come out). The Settings panes with no reader are listed in `ui.state`
under `notCovered` with the reason: the credential panes (connections, remote,
clickup) are never readable, and `settings.privacy` says only whether ClickUp is
set and how many devices are paired.

**`POST /control/result` is not for agents.** It is how a window answers a
command (`{"rid":…,"ok":…,"applied":…,"value":…}`), behind the same
`trustedCaller` gate as the window's other calls (`/browser/result`). `rid` is
minted by the server and travels only to windows that said `hello` (not every
`/stream` listener; a local token holder can say hello too), so one caller cannot
answer another's request without it; the first answer wins and a duplicate, a
late one or an unknown `rid` is `{"known":false}`. A caller that holds the machine
token can do nothing through it that `/control` does not already allow.

### From a session: `agentglass-ui`

An agent does not have to write the `curl`. `bin/agentglass-ui` is the same
doors as a CLI and `bin/agentglass-ui-mcp` as MCP tools, and neither keeps a
copy of the registry: they ask the running app what it offers
(`GET /control/actions`: the registry's entries up to the level the server
allows, with their argument shapes), so a door added to `shared/uiActions.ts`
is a verb and a tool with no further change, and `AGENTGLASS_CONTROL_LEVEL=1`
(or `AGENTGLASS_CONTROL_READONLY=1`) takes `settings.set` out of both.

```bash
agentglass-ui list                                  # every door: id, level, kind, arguments
agentglass-ui state                                 # ui.state
agentglass-ui read chat                             # ui.read {panel: chat}
agentglass-ui open settings.open --arg page=diff    # any open-kind door
agentglass-ui settings list | get <id> | set <id> <value>
agentglass-ui --as my-agent settings set diff.wrap true
```

One JSON object per answer, exit `0` when a window ran it and `1` with a one-
sentence `error` otherwise (no window, a slow window, a change that is off, a
setting that is not exposed, an argument outside its set; `2` for a usage
mistake). `--as NAME` (or `AGENTGLASS_UI_AS`) is sent as `as` and shows in the
action log as `as NAME` next to the setting's id, never its value. The MCP tool
for an id is the id with dots as underscores under a `ui_` prefix
(`settings.set` is `ui_settings_set`, `ui.read` is `ui_read`); a contract test
(`server/test/ui-cli.test.ts`) holds the tool list equal to the registry. What
an agent should and should not do with them is
[`skills/ui-control/SKILL.md`](../skills/ui-control/SKILL.md). Ceiling: the MCP
server can list tools only while the app is running.

**Adding a panel is adding its door.** A new view, Settings page, app chord or
dialog (any component that draws through a `Portal`) without a registry entry (a
`modals: [file]` on the entry that opens it) or a reasoned line in
`NOT_AGENT_DOOR` fails `web/test/ui-registry-guard.test.ts`. Left out on purpose,
each with its reason in that file: the people picker (choosing writes an assignment), the Rescue modal
(it only exists inside the worktree-removal flow), and the menus and pickers that
open from a click on a panel's own subject.

`open finder` is the one command that names a path. The server checks only its
spelling — absolute, no `.`/`..`/empty segment, no control characters, at most
4096 characters, `400` otherwise — and never touches the file: each window then asks
for it under its own credentials, so a missing path or one the finder may not
look at shows the finder's own "not there" or "closed" state. It is always the
reader (the finder does not edit), so there is no mode.

```bash
# show a markdown file in the finder, no clicking
curl -sS http://localhost:4000/control \
  -H 'content-type: application/json' \
  -d '{ "cmd": "open", "what": "finder", "path": "/home/ana/notes/plan.md" }'
# add -H "Authorization: Bearer $AGENTGLASS_TOKEN" when a token is set
```

`chat` is the one command the receiving client cannot run on arrival: the chat
panel is mounted only while the workspace is open, and `new` is exactly what you
press when it isn't. It is latched in a one-slot mailbox
(`web/src/lib/chatIntent.ts`) that the panel drains once it is up, and that
lapses after 30s so a tab which never opened doesn't act on it much later.

Approve/deny and monitoring need no bridge — they are already `POST /gate/decide`
and the `/stats`, `/insights`, `/gate/pending`, `/stream` reads. `/control` fills
the one gap: UI navigation. It is gated by `AGENTGLASS_TOKEN` like every route
but the intake sinks, so a non-browser caller (no `Origin`) is admitted on a
loopback bind and must carry `Authorization: Bearer <token>` when one is set.

## 4. Make it yours

### Theme

Copy an entry in `web/src/lib/themes.ts`:

```ts
export interface Theme {
  id: string;
  name: string;
  preview: { primary: string; secondary: string; accent: string };
  vars: Record<string, string>; // CSS custom properties on :root
}
```

Add a palette to `THEMES`, restart the UI, pick it in the theme switcher.
`applyTheme(id)` writes CSS vars and `localStorage["agentglass-theme"]`.

### A view in the workspace

The views are a list, and the rail, the shortcuts and the tooltips all read
from it — so most of a new view is one entry:

```ts
// web/src/components/workspace/views.ts
export const VIEWS: ViewDef[] = [
  { id: "git", label: "Git", key: "g", icon: GitIcon, hint: "Stage, commit, push/pull the working tree" },
  // …add yours here
];
```

That list is not quite the whole story. A view id is validated on the server too
(`POST /control` accepts a closed set), so adding one means four files, not one:

| File | What it needs |
|---|---|
| `shared/types.ts` | the id in the `ViewId` union |
| `web/src/components/workspace/views.ts` | the `VIEWS` entry above — rail, hotkey and tooltip all read it |
| `web/src/components/workspace/Workspace.tsx` | the body to render for that id |
| `shared/uiActions.ts` | the id in `VIEW_IDS`, or `POST /control` rejects it with `400` |

The list is deliberately duplicated at the trust boundary rather than imported
from the UI: a `/control` body is untrusted input, and it is checked against a
closed set before anything is broadcast.

`key` is the bare letter that reaches it from the dashboard; the modified
shortcut comes from its position in the rail, or from whatever the user has
bound in **Settings ▸ Shortcuts**. A view added in a later version appears for
someone whose saved rail order predates it, rather than being silently dropped.

Give the panel the shared header so it cannot drift from the others:

```tsx
import { ViewHeader } from "./workspace/ViewHeader.tsx";

<ViewHeader title="My view" count={items.length} actions={<button>…</button>}>
  {/* controls that scope the view — a repo picker, an engine chip */}
</ViewHeader>
```

The height is fixed rather than derived from padding, on purpose: a view that
later adds a taller control would otherwise grow its own header and the frame
would twitch when you switched to it. Use `useSidebarWidth()` and `SidebarGrip`
for a list pane and it inherits the same draggable width as everything else.

### Scope and config

Persisted at `~/.config/agentglass/config.json` (env vars still win):

```jsonc
{
  "root": "~/code/my-project",
  "repoDirs": ["~/code", "/mnt/hdd/code"]
}
```

Or at launch:

```bash
AGENTGLASS_ROOT=~/code/my-project bun run dev
# desktop: make desktop-open DIR=~/code/my-project
```

With a project open, git writes / terminal / chat outside that root are refused —
scope is a boundary, not only a filter. Multi-repo work: scope to the parent
folder instead.

### Auth and write gates

See the README security table (`AGENTGLASS_TOKEN`, `AGENTGLASS_GIT_WRITE_DISABLED`,
`AGENTGLASS_DOCKER_WRITE_DISABLED`, `AGENTGLASS_CHAT_DISABLED`,
`AGENTGLASS_CODEX_DISABLED`, …). Intake routes
(`/ingest`, OTLP) stay tokenless on purpose — local hooks and OTel exporters
have no way to carry a secret — while everything else needs the token when set.

## 5. How it stays live

```
hooks / OTLP / POST /ingest
        |
        v
   normalize -> SQLite ---> WebSocket /stream
        |                        |
        +---- alerts ---- dashboard (useLive)
```

- Server persists events, then broadcasts on `/stream`.
- `web/src/lib/useLive.ts` opens one WebSocket, buffers frames (~220ms flush,
  ~5 renders/sec), pauses React updates while the tab is hidden, and reconnects
  with backoff (gives up after ~2 minutes of continuous failure; becoming
  visible again retries).
- Initial frame can include recent history + open tool calls so a reload is not
  a blank cockpit.

## 6. Publish a plugin

Everything above this section is the outside-in direction: your harness talks
to agentglass over HTTP. A plugin is the same idea, packaged so somebody else
can install it without writing that HTTP client themselves — Settings → Plugins
copies a folder, shows what it declares, and a human enables it one at a time.
Nothing runs on install; nothing runs until enabled. This section is the short
form; the design, the trust boundary and the catalogue format in full are in
[PLUGINS.md](PLUGINS.md).

### What a plugin is

A git repository with a `plugin.json` manifest at its root. That is the whole
requirement — no build step, no registration, no account. `plugin.json`:

```json
{
  "name": "hello-stream",
  "publisher": "someone",
  "description": "Writes a line to its own log whenever an agent finishes a turn.",
  "entrypoint": "bun run watch.ts",
  "scope": "read"
}
```

| field | what it is |
|---|---|
| `name` | letters, numbers, `.`, `-`, `_` — becomes a directory name on disk |
| `publisher` | shown to the reviewer, not verified |
| `description` | shown to the reviewer, not verified |
| `entrypoint` | a shell command, run with `installDir` as its cwd |
| `scope` | `read`, `answer`, or `full` — see below |

On enable, the server mints a token at that scope and spawns `entrypoint` as
its own process, with `AGENTGLASS_URL` and `AGENTGLASS_READ_TOKEN` in its
environment (that variable is always named `AGENTGLASS_READ_TOKEN`, whatever
the granted scope — the name predates plugins and nothing here renamed it).
The plugin talks to agentglass exactly the way section 1 and 2 above describe:
HTTP and the `/stream` WebSocket, from outside the process. What it may call
is capped by the token's scope, not by anything the plugin's own code decides.

What each scope actually permits, in reviewer language, not the field's name:

- **`read`** — every GET route, including `/stream`: a session's live output
  as it happens, the same prompts and replies shown on screen, plus costs,
  diffs and pull requests. Cannot reply to a session or write anything.
- **`answer`** — everything `read` gets, plus replying to a session that is
  running now, an open chat pane (`/chat/send`, `/chat/pane/key`).
- **`full`** — everything this machine can do: a terminal, git write access,
  docker control, merging pull requests.

**No plugin, at any scope, can approve a gate.** `POST /gate/decide` is
reserved for a credential no process on this machine could mint for itself — a
paired phone's, or a person at the desktop. A plugin's token was minted by this
server and sits in a child process's environment on this machine, so it is its
own kind of caller and the gate refuses it by name, whatever `scope` says. A
plugin at `answer` can reply to an agent; it cannot release one.

No plugin gets `full` by writing that in its own `plugin.json` and being
believed — the manifest is what it *asks for*, and the reviewer decides
whether to grant it. An update that changes the manifest, or changes what the
entrypoint's files actually contain without touching the manifest at all,
clears the old approval and asks again.

### How to publish one

1. Write the plugin as its own git repository, `plugin.json` at the root.
2. Push it wherever — any host `git clone` can reach over `https://`, `ssh://`,
   or `git@host:path`. No embedded credentials: a plugin address is typed
   once and reused to update from later, so a URL carrying a password would
   sit in the installer's config from then on.
3. Tell people the URL. Pasting it into "Install a plugin" is enough — a
   catalogue is optional, for when there is more than one plugin to list.

### The worked example

`hello-stream` — two files, nothing more:

```json
// plugin.json
{
  "name": "hello-stream",
  "publisher": "someone",
  "description": "Writes a line to its own log whenever an agent finishes a turn. Proof that a plugin can watch the cockpit without being part of it.",
  "entrypoint": "bun run watch.ts",
  "scope": "read"
}
```

```ts
// watch.ts — everything it is allowed to do comes from two env vars the
// host sets when somebody enables it. No import from agentglass: this runs
// as its own process.
const URL_BASE = process.env.AGENTGLASS_URL ?? "http://127.0.0.1:4000";
const TOKEN = process.env.AGENTGLASS_READ_TOKEN ?? "";

const ws = new WebSocket(`${URL_BASE.replace(/^http/, "ws")}/stream?token=${encodeURIComponent(TOKEN)}`);
ws.addEventListener("message", (e) => {
  // ... write whatever's useful to its own log file ...
});
```

Its log, once enabled, shows the shape a `read` token actually has: a GET it
was allowed to make, and a write it was not —

```
GET /terminal/panes -> 200
POST /understudy/halt -> 403 (a read plugin must not be allowed to do this)
watching /stream
```

That 403 is the mechanism working, not a bug in the example: `read` cannot
halt a run, and nothing the plugin's own code does changes that.

### A catalogue file, if there's more than one plugin

A catalogue is a plain JSON file over `https://`, fetched fresh every time
somebody browses it — not a registry, not something whose contents get
cached as trustworthy between reads. An unreachable or malformed catalogue
reads as exactly that in Settings, never as an empty list.

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

One bad entry drops that entry, not the whole catalogue — the same rule a
manifest is checked by. `ref` is optional (a branch, tag, or commit); a
missing one installs the repository's default branch.

### Why there is no separate lockfile

`~/.config/agentglass/plugins.json` already records, per installed plugin,
where it came from (`source` — a git URL, a local path, or a catalogue plus
the entry inside it), the commit it resolved to, and a content hash of every
file that shipped. That is every fact a lockfile would exist to pin down.
A second file would just be this one, copied.

## Dashboard vs harness (one paragraph)

agentglass does **not** replace Claude Code, Codex, Gemini CLI, LangChain, or
your custom runner. Those remain the harness. agentglass is the glass in front
of them and the optional remote control: ingest telemetry, render the fleet,
and (if you wire it) hold tool calls until a human clicks allow/deny. Point
things at it; keep shipping with whatever you already run.
