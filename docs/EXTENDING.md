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
    "hook_event_type": "PostToolUse",
    "payload": { "tool_name": "Bash", "tool_response": "ok" },
    "model_name": "gpt-4.1-mini"
  }'
```

Required fields: `source_app`, `session_id`, `hook_event_type`.
Optional: `payload`, `chat`, `model_name`. Invalid JSON returns `400`; missing
required fields returns `400`. If a Claude transcript scanner already owns the
session id, the event is accepted but skipped (no double-count).

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

The server validates the body against a closed set (`server/src/control.ts`)
and rebroadcasts it as a `control` frame on `/stream`; every open tab runs it
through the very setters the keyboard handler uses (`web/src/lib/controlBus.ts`
→ `App.tsx`), so external and keyboard navigation are one path, not two.

```bash
# open the workspace on the git view
curl -sS http://localhost:4000/control \
  -H 'content-type: application/json' \
  -d '{ "cmd": "view", "to": "git" }'
```

`ControlCmd` (see `shared/types.ts`), anything else → `400`:

| `cmd` | Fields | Effect |
| --- | --- | --- |
| `view` | `to`: `git`\|`diff`\|`pr`\|`docker`\|`term`\|`chat` | open the workspace on that view |
| `workspace` | `open?`: boolean | toggle (absent) or set the workspace overlay |
| `esc` | — | close panels / workspace, as Escape does |
| `open` | `what`: `stats`\|`skills`\|`search`\|`help`\|`palette` | open that panel |
| `theme` | `name?`: id, or `dir?`: `1`\|`-1` | pin a palette, or step the list |
| `zoom` | `dir`: `1`\|`-1`\|`0` | zoom in / out / reset |

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

The six views are a list, and the rail, the shortcuts and the tooltips all read
from it — so adding one is a single entry rather than five places to keep in
step:

```ts
// web/src/components/workspace/views.ts
export const VIEWS: ViewDef[] = [
  { id: "git", label: "git", key: "g", icon: GitIcon, hint: "stage, commit, push/pull" },
  // …add yours here
];
```

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
`AGENTGLASS_DOCKER_WRITE_DISABLED`, `AGENTGLASS_CHAT_DISABLED`, …). Intake routes
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

## Dashboard vs harness (one paragraph)

agentglass does **not** replace Claude Code, Codex, Gemini CLI, LangChain, or
your custom runner. Those remain the harness. agentglass is the loupe and the
optional remote control: ingest telemetry, render the fleet, and (if you wire
it) hold tool calls until a human clicks allow/deny. Point things at it; keep
shipping with whatever you already run.
