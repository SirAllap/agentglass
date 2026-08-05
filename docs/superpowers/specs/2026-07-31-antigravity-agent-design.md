# Google Antigravity as a third chat agent

**Date:** 2026-07-31
**Status:** approved

## What this is

The chat panel drives `claude` and `codex`. This adds Google's Antigravity CLI
(`agy`) as a third peer. It is **not** a replacement for the Gemini CLI: the two
are separate binaries with separate wiring, and `agy` is a multi-model harness
that offers `claude-sonnet-4-6` and `gpt-oss-120b-medium` alongside Gemini
models. Gemini CLI keeps its existing OpenTelemetry route onto the radar and is
not touched.

## Facts this design rests on

Established against `agy` 1.1.9, not assumed:

| Need | Antigravity |
|---|---|
| Non-interactive stream | `agy -p "…" --output-format stream-json` |
| Resume | `agy --conversation <uuid> -p "…"` |
| Model list | `agy models` → newline-separated ids |
| Modes | `--mode accept-edits\|plan`; default `request-review`; `--dangerously-skip-permissions` → `always-proceed` |
| State dir | `~/.gemini/antigravity-cli` (shared parent with Gemini CLI, distinct subtree) |

Frame envelope — note the discriminator is `event`, not `type`:

```json
{"event":"init","conversation_id":"…","init":{"model":"…","cwd":"…","permission_mode":"request-review"}}
{"event":"step_update","step_update":{"step_index":2,"state":"DONE","step_type":"agent_response","text_delta":"…","usage":{…}}}
{"event":"step_update","step_update":{"step_index":3,"state":"ACTIVE","step_type":"tool","tool_name":"list_dir","tool_info":{"name":"list_dir","parameters":{"DirectoryPath":"…"}}}}
{"event":"result","result":{"conversation_id":"…","status":"SUCCESS","response":"…","num_turns":2,"usage":{…}}}
```

`step_type` ∈ `user_input | agent_response | thinking | tool | subagent |
browser_action | checkpoint | error_message | unknown`. A tool step appears
twice, `ACTIVE` then `DONE`, the second carrying `tool_info.output` and
`duration_seconds`.

Usage is `{input,output,thinking,cache_read,total}_tokens`. **`result.usage` is
per-turn, not thread-cumulative** — measured: turn 1 reported 31789 input,
turn 2 reported 16609. So it is added across turns (like Claude), not assigned
(like Codex). Getting this backwards would over-report spend several-fold.

## Architecture

The seam `docs/EXTENDING.md` already describes: the server spawns and streams
without translating; one browser file knows the vocabulary; real differences are
surfaced rather than papered over.

### `server/src/antigravity.ts`

Mirrors `codex.ts`.

- `antigravityModels()` — runs `agy models`, splits lines, caches.
- `antigravityArgs(bin, model, mode, resumeId)` — pure argv builder.
- `antigravityStream(cwd, message, model, resumeId, mode, emit?)` — spawns,
  pipes JSONL back verbatim, emits `agx_error` when the process never started.
- `frameToEvent(frame, ctx)` — pure frame → event mapper, exported for tests.

Shares every guard with the other two: `safeAbs` / `repoRootOf` / `inScope`, the
`setsid` process group so stopping a turn reaches the whole job tree, the
keepalive, and `MODEL_RE` / `SESSION_RE` (a conversation id is a UUID, which
`SESSION_RE` already accepts).

Gated by `AGENTGLASS_ANTIGRAVITY_DISABLED`.
`ANTIGRAVITY_BYPASS_ALLOWED = chatBypassAllowed()` — the same single operator
opt-in that already covers Claude's `bypassPermissions` and Codex's
`full-access`, because it is the same decision.

### Modes

They land almost 1:1 on Claude's four, which is a property of the CLI rather
than something forced here:

| Panel | Flag |
|---|---|
| Ask (default) | *(none)* → `request-review` |
| Plan (no edits) | `--mode plan` |
| Auto-accept edits | `--mode accept-edits` |
| ⚡ Bypass | `--dangerously-skip-permissions` |

### Fleet visibility: frames → events

Antigravity has neither hooks nor an OTel exporter, so without this its chats
would exist only in the panel and the README's "sessions you start here show up
in the fleet" would be false for it.

`antigravityStream` takes an injected `emit` callback; `index.ts` passes
`ingestBody`. That keeps the mapper pure and testable and matches how `otlp.ts`
already works — the parser returns events, `index.ts` inserts them.

```
init         → SessionStart      (model, cwd)
user_input   → UserPromptSubmit  (prompt)
tool ACTIVE  → PreToolUse        (tool_name, tool_use_id = step_index)
tool DONE    → PostToolUse       (tool_info.output, duration_seconds, is_error)
result       → Turn complete     (usage, model)
```

`source_app` is `"antigravity"`. This is load-bearing rather than cosmetic:
`agy` can run `claude-opus-4-6-thinking`, so `model_name` is an actively
misleading signal, and `agentOf` checks `source_app` first. Setting it
explicitly is what stops an Antigravity session being misfiled as a Claude one.

Only chats started in the panel produce events. A terminal-run `agy` stays
invisible, and that is stated rather than implied.

### `web/src/lib/antigravityFrames.ts`

The whole translation, beside `codexFrames.ts`, so there is one file to open
when a frame renders wrong.

- `applyAntigravityFrame(chat, frame)` — fills the same `ChatMsg` / `ChatTool`
  shapes the other two produce. Nothing below the store branches on which CLI
  produced a turn.
- `antigravityUsage(usage, prev)` — **adds**, per the measured per-turn
  semantics above.
- `contextTokens` stays 0. `agy` reports no window, and `ctxLimitOf` does not
  know the Gemini 3.x families, so a meter here would fall back to a default and
  draw a confident wrong number. The `contextTokens > 0` guard already
  suppresses it. Tokens and cost still show.

### The refactor this earns

Two agents justified `agent === "codex" ? x : y`. Three do not — there are ~12
such ternaries across `ChatPanel` and `chatStore`, and each new agent multiplies
them.

```ts
const AGENTS: Record<AgentKind, AgentSpec> = { claude, codex, antigravity };
// label, cli, defaultModel, defaultMode, modes, bypassMode, canAttach, hasTranscript
```

`modelsFor` / `modesFor` / `bypassMode` / `cliName` / `agentLabel` become
lookups. In scope because it is the code this feature touches, and it is what
makes a fourth agent cheap.

Types generalize the same way: `AgentModel` / `AgentCliStatus` become the shared
shapes, with `CodexModel` / `CodexStatus` kept as aliases so no call site churns.

## Deliberate omissions

**No `/antigravity/transcript`.** Conversations are per-UUID SQLite databases
whose `step_payload` is binary protobuf on an undocumented internal schema.
Decoding it would break on any `agy` update. It costs little: panel chats keep
their history through `chatPersist` plus the `conversation_id`, and there are no
fleet-listed Antigravity sessions to adopt in the first place.

**No `--effort` dial.** The model ids already encode it
(`gemini-3.1-pro-high` / `-low`), so a second control would fight the first.

## Testing

- `server/test/antigravity.test.ts` — argv building per mode, model-list
  parsing, `frameToEvent` mapping, scope refusal, bypass gating when the
  operator has not opted in.
- `web/test/antigravity-frames.test.ts` — frame translation, including that
  usage is added rather than assigned, and that `contextTokens` stays 0.
- `web/test/chat-agent.test.ts` — extended to three-way `switchAgent`,
  `agentOf`, and persistence round-trip.

## Docs

README (chat section, env table, endpoint table, security list), the
`agentprobe` roster so Settings lists Antigravity among agents on the machine,
and `EXTENDING.md` — where "a third CLI would repeat that shape" stops being a
prediction.
