# Provider usage gauges

**Date:** 2026-07-31
**Status:** approved, not yet implemented

## The problem

agentglass shows plan quota for exactly one provider. `UsageWidget` reads
Anthropic's OAuth usage endpoint and renders two meters in the header, shown
only when the provider filter is Anthropic and only above the `2xl` breakpoint
— a rule written when there was one gauge and nothing to compare it against.

The cockpit now drives three agents. Codex and Antigravity have quota that runs
out exactly the way Anthropic's does, and the app says nothing about either.
The header is also the wrong home for this: it is the most contended strip in
the UI, which is why the one existing gauge is already hidden on most screens.

## What we are building

1. A **Usage box on the dashboard**, left of Cost, showing every provider.
2. The **same rows in the Stats modal**, with room for the detail.
3. A **single in-context gauge in the notch** — whichever provider you are
   working in.
4. **Removal of the header widget.**
5. An **opt-in refresh ping** that keeps the Codex reading from going stale.

## What each provider can actually tell us

This shaped every decision below, so it comes first.

**Anthropic — live, already working.** `server/src/usage.ts` fetches
`api.anthropic.com/api/oauth/usage` with the local Claude Code OAuth token and
gets a 5-hour and a 7-day window. It is never stale. It costs a network call
against a rate-limited endpoint, which is why it is cached for 5 minutes and
backs off hard on a 429. Unchanged by this work.

**Codex — a local file, no credentials, no network.** The Codex CLI writes
`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`, and its `token_count` events
carry:

```json
"rate_limits": {
  "limit_id": "codex",
  "primary":   { "used_percent": 5.0, "window_minutes": 10080, "resets_at": 1786114806 },
  "secondary": null,
  "credits":   { "has_credits": false, "unlimited": false, "balance": "0" },
  "plan_type": "plus"
}
```

Strictly cheaper than the Anthropic path — reading a file the CLI already
wrote. One property the Anthropic reading does not have: **it is only as fresh
as the last Codex turn.** Run nothing for two days and the number is two days
old, and its window may have reset since. Every surface has to say how old the
reading is, and item 5 exists to shorten that gap.

**Antigravity — nothing exists to read.** Verified on 2026-07-31: `agy` has no
usage or quota subcommand; `~/.gemini/antigravity-cli/` holds no quota file
(`jetski_state.pbtxt` is onboarding state); the conversation `.db` files carry
no usage or quota fields; and `cli.log` shows a `quota_manager.go` that
refreshes quota into process memory and never writes it down. The only route
would be reverse-engineering its authenticated backend call with its OAuth
token — fragile, silently breakable, and out of scope.

Antigravity therefore appears in the list as a **labelled gap**: named, with a
note saying no usage data is available from the CLI. This is deliberate. A
provider that is simply absent reads as a bug in agentglass; a provider that
says why reads as the upstream limitation it is.

## Architecture

### Normalised shape

One shape for all three, so every surface renders a list instead of three
bespoke blocks. In `shared/types.ts`:

> **Amended after the final whole-branch review.** The sketch below is
> missing a field the implementation added and depends on: `minutes`.
> Codex's rollout file gives windows as `primary`/`secondary`, which are
> positional and swap between plans (on a weekly-only plan `primary` IS the
> weekly window), so ordering them "short window before long window" needs
> the window length as a number, not the derived `label` string parsed back
> apart. `shared/quota.ts`'s `windowLabel()` and `server/src/codexusage.ts`'s
> sort both key on `minutes`. It is also missing from the sample below and
> should be read as present on every `QuotaWindow`.
>
> The naming-rationale comment has also been overtaken by events: the
> Anthropic-specific `UsageWindow` in `web/src/lib/api.ts` it warns about,
> and DynamicIsland's import of it, were both deleted once this feature
> replaced them (zero remaining consumers, verified by grep). The comment
> below is kept for history.

```ts
/** Named `QuotaWindow`, not `UsageWindow`: that name is taken by the
 *  Anthropic-specific `{ utilization, remaining, resets_at }` in
 *  web/src/lib/api.ts, which DynamicIsland imports. Two differently-shaped
 *  types under one name, in the files that consume both, is a trap. */
export type QuotaWindow = {
  /** "5h", "weekly" — derived from the provider's window length. */
  label: string;
  /** Window length in minutes, so consumers can order short-before-long
   *  without parsing the label back into a number. */
  minutes: number;
  usedPercent: number;
  /** ISO 8601, or null when the provider does not say. */
  resetsAt: string | null;
};

export type ProviderUsage = {
  provider: "anthropic" | "codex" | "antigravity";
  /** How the provider is named on screen. */
  label: string;
  available: boolean;
  windows: QuotaWindow[];
  /** Plan name where the provider reports one ("plus", "max"). */
  plan?: string;
  /** When this reading was taken, epoch ms. Live for Anthropic; the last
   *  recorded turn for Codex. Absent when there is no reading. */
  observedAt?: number;
  /** Why there is nothing, when there is nothing. Rendered to the user, so it
   *  is a sentence rather than an error code. */
  note?: string;
};
```

`window_minutes` maps to `label`: 300 → `"5h"`, 10080 → `"weekly"`, anything
else → a computed label (`"3h"`, `"30d"`). Codex's `primary`/`secondary` are
positional, not semantic — the window length is what names them, not the key.

### Server

**New: `server/src/codexusage.ts`**

- `codexUsage(): ProviderUsage` — the newest recorded reading.
- Walks `~/.codex/sessions` newest-day-first, and within a day newest-file-first
  by mtime. Scans each file **from the end** for the last `token_count` event
  with `rate_limits`, stopping at the first hit.
- Reads **at most 5 files** before giving up. A session that has only just
  started has no `token_count` event yet, so the newest file alone is not
  enough; five is generous and bounds the work.
- Cached against the mtime of the file it read, so repeat calls are free until
  Codex writes again.
- Honest absence, each with its own `note`: Codex not installed, no sessions
  directory, no session carrying `rate_limits`.
- Respects `CODEX_HOME` if set, matching how the CLI itself relocates.

**New endpoint: `GET /usage/providers` → `ProviderUsage[]`**

Assembles all three: Anthropic via the existing `getUsage()`, Codex via the
above, Antigravity as the constant gap entry. Gated like the rest of the data
surface — the outer origin gate and the token gate, no desktop-only gate: there
is no path on disk in this payload and nothing here can act.

`GET /usage` stays as it is. It is the Anthropic source underneath, and
removing a working endpoint is not part of this change.

**New endpoint: `POST /usage/codex/refresh`** — see "The refresh ping".

### Client

**New: `web/src/lib/usageStore.ts`**

The shared poll currently lives *inside* `UsageWidget.tsx` as module state,
which was right when the widget was its only consumer and is wrong now that the
widget is going away. It moves out unchanged in behaviour: one 5-minute timer
for the whole app however many gauges are mounted, last-good-reading retention
through transient failures, and a late subscriber getting the current value
rather than waiting a cycle. It now fetches `/usage/providers`.

**New: `web/src/components/UsageBox.tsx`**

The dashboard panel, `Panel eyebrow="Usage" title="Plan quota"`. One row per
provider: name, a meter per window, percent, reset time, and an age note when
the reading is stale. Reuses `usedColor()` and `resetLabel()`, which move into
the store beside the poll they belong with. The Antigravity row renders its
`note` in place of meters.

**Changed: `web/src/App.tsx:590-600`**

The money row and the timeline row merge into one grid so the Usage box can
span both:

```
xl:grid-cols-12, rows 196px / 140px

│ Usage(3) │ Cost(3) │ Latency(3) │ Sessions(3) │  196px
│  spans   ├─────────┴────────────┴─────────────┤
│  2 rows  │       Mission timeline (9)         │  140px
```

Every box lines up with the one above it in the cockpit grid: Usage under Fleet
(`col-span-3`, eyebrow "Sessions"), Cost and Latency under the middle column
(`col-span-6`), Sessions under Alerts (`col-span-3`). Below `xl` the grid
collapses to one column as the existing rows already do, with Usage first.

**Changed: `web/src/components/workspace/DynamicIsland.tsx`**

Shows one gauge: the provider in context. Context is the focused chat panel's
agent when the workspace is open, otherwise the header's provider filter — so
driving a Codex chat shows the Codex gauge even when the dashboard filter says
Anthropic. No provider in context, or that provider has no reading: no gauge,
exactly as today.

> **Amended after the final whole-branch review.** The line this replaces
> claimed "the existing 'rate limited, retrying' state is kept and becomes
> per-provider" — untrue as shipped. The notch has no fallback branch at
> all: this is deliberate (a pre-flight ruling scoped the three display
> states to "everywhere with room to explain," which the notch, a glance
> rather than an explanation, is not), so a rate-limited or offline reading
> renders as no gauge there, same as no reading at all. The reason *does*
> surface, in `anthropicUsage()`'s per-error notes (`server/src/providerusage.ts`):
> on the dashboard Usage box and the Stats modal section, both of which have
> room to show the row's `note` rather than just its meters.

**Changed: `web/src/components/StatsModal.tsx`**

A Usage section with the same rows plus what the dashboard box has no room
for: plan type, exact reset times, and when the reading was taken.

**Changed: `web/src/components/Header.tsx`**

`UsageWidget` and the `showUsage` prop are removed, along with the plumbing
that computes and threads `showUsage` from `App.tsx`.

**Deleted: `web/src/components/UsageWidget.tsx`** — its poll moves to the
store, its helpers move with it, and the widget itself has no remaining home.

## The refresh ping

**The setting.** Settings › Preferences, **default off**:

> **Refresh Codex usage hourly** — runs a minimal Codex turn so the usage
> reading stays current. Uses a small amount of the quota it measures.

> **Amended after Task 9 shipped.** The label above was the sketch; the
> shipped copy (`web/src/components/SettingsModal.tsx`) reads **"Keep Codex
> usage current"**, with the hourly cadence and the quota cost moved into the
> hint text: "Runs a minimal Codex turn hourly so the quota reading is not
> stale — uses a small amount of the quota it measures." Recorded so a
> future reader matches the string that actually ships rather than the one
> drafted here.

The help text says what it costs because it genuinely costs something: this
consumes quota in order to measure quota. Small on a Plus plan against a weekly
window, but not free, and a setting that hides that is a setting that surprises
someone.

**Triggers.** Hourly while the app is open, and once on page load — with a
**15-minute floor**: if the current reading is younger than that, the trigger is
skipped. Without the floor, a habit of hitting ⌘R turns into a stream of billed
pings, each spawning a process and waiting seconds on a model.

**Server.** `POST /usage/codex/refresh` spawns `codex exec` with a trivial
prompt, discards the output, and re-reads `rate_limits`. Wrapped in
`singleFlight("codex-usage-refresh", …)` from `server/src/singleflight.ts` so
concurrent callers — several open tabs on page load — collapse into one turn.
Refused when `CODEX_ENABLED` is false.

**Which model.** Codex does not label a model "cheapest", so this does not
guess. In order: `AGENTGLASS_CODEX_USAGE_MODEL` if set; otherwise the last
entry of the list `parseModels()` already produces, which is sorted by Codex's
own `priority` and so ends on the smallest model it offers; otherwise no
`--model` flag at all, so the CLI uses its configured default. The
fallback chain matters more than the pick — a hardcoded model id that does not
exist on the user's plan is a feature that fails for everyone but its author.

**Scope.** Codex only. Anthropic's reading is already live, so a ping there
would spend quota to learn what we already know; Antigravity writes nothing to
disk, so a ping there produces no reading no matter how often it runs.

## Error handling

Nothing here is allowed to blank out a gauge that has a good reading. The
existing degrade-to-last-good behaviour in `usage.ts` is the model: a failed
poll leaves the previous numbers standing, and only genuinely absent data
renders as absent — with a `note` saying why.

Unavailability is a first-class state with a sentence attached, not an empty
box. Three distinct cases must read differently on screen: *loading* (first
fetch in flight), *unavailable* (the provider cannot tell us, with the reason),
and *stale* (a real reading, with its age). Collapsing any two of these is the
bug this project just fixed in the About pane.

## Testing

**Server** (`server/test/codex-usage.test.ts`), fixture rollout files under a
temp `CODEX_HOME`:

- A normal reading parses: percent, window label, reset, plan.
- `secondary: null` — the shape on a Plus plan — yields one window, not a
  broken second one.
- The **newest** reading wins when several sessions carry `rate_limits`.
- A newest file with no `token_count` yet falls back to an older file.
- Missing sessions directory, and Codex not installed: `available: false` with
  a note, never a throw.
- The 5-file bound holds: a directory of files with no rate limits does not
  turn into an unbounded scan.

**Server routes** (`server/test/usage-providers.test.ts`):

- `/usage/providers` returns all three providers, Antigravity always present
  and always with a note.
- The payload carries no filesystem path.
- `/usage/codex/refresh` is refused when Codex is disabled.

**Client** (`web/test/usage.test.ts`), pure functions only:

- `windowLabel()`: 300 → "5h", 10080 → "weekly", other values → computed.
- Staleness formatting, including "just now" and the >24h case.
- `providerInContext()`: focused chat agent wins over the filter; the filter is
  used when the workspace is closed; neither present → null.
- Refresh floor: a reading younger than 15 minutes suppresses the trigger.

## Out of scope

- Any attempt to obtain Antigravity quota, including reverse-engineering its
  backend call.
- Historical usage — this is current quota, not a series over time.
- Alerting or budget enforcement on plan quota. `budget.ts` covers spend
  against a limit and is a separate mechanism.
- Refresh pings for Anthropic or Antigravity, for the reasons above.
