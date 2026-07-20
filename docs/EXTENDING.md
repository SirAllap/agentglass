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

Claude Code wiring lives in `hooks/gate_event.py` (see README control-plane
section). Any harness can long-poll the same endpoint.

## 3. Make it yours

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
(`/ingest`, OTLP) honour the token when set.

## 4. How it stays live

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
