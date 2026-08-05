# Provider Usage Gauges Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show plan quota for all three agent providers in one dashboard box, one Stats section and one in-context notch gauge, and retire the Anthropic-only header widget.

**Architecture:** A normalised `ProviderUsage` shape is assembled server-side from three sources — Anthropic's live OAuth endpoint (already built), Codex's local session rollout files (new, no network), and a constant "no data" entry for Antigravity. One client store polls `/usage/providers` every 5 minutes and every surface renders the same list. An opt-in hourly ping runs a minimal Codex turn to keep its file-based reading fresh.

**Tech Stack:** Bun + TypeScript on the server, React 18 + Tailwind on the web side, `bun test` for both halves.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-31-provider-usage-gauges-design.md`. Read it before Task 1.
- The new shared type is `QuotaWindow`, **never** `UsageWindow` — that name is taken by the Anthropic-specific `{ utilization, remaining, resets_at }` in `web/src/lib/api.ts:929`, which `DynamicIsland` imports.
- Three display states must stay distinguishable **everywhere with room to explain** — the dashboard box and the Stats section: **loading** (first fetch in flight), **unavailable** (provider cannot tell us, with a reason sentence), **stale** (a real reading, with its age). Never collapse two of them there. The notch is a glance, not an explanation: it shows a gauge when there is one and nothing when there is not, and that is deliberate rather than a collapsed state.
- A failed poll must never blank a good reading. Last-good-wins, following `server/src/usage.ts:112-120`.
- Codex `resets_at` is **Unix seconds**, not milliseconds.
- Antigravity is always present in the payload and always carries a `note`.
- No filesystem path may appear in any `/usage*` response.
- The refresh ping setting defaults to **off**.
- Run `cd server && bun test <file>` and `cd web && bun test <file>` for targeted suites; `make typecheck` before each commit.

---

### Task 1: Shared quota types and the Codex reader

**Files:**
- Modify: `shared/types.ts` (append near the existing `UsageHistory` type)
- Create: `shared/quota.ts`
- Create: `server/src/codexusage.ts`
- Test: `server/test/codex-usage.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `QuotaWindow`, `ProviderUsage` (from `shared/types.ts`); `windowLabel(minutes: number): string` (from `shared/quota.ts`); `codexUsage(): ProviderUsage` and `__resetCodexUsageCache(): void` (from `server/src/codexusage.ts`).

- [ ] **Step 1: Add the shared types**

In `shared/types.ts`:

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

- [ ] **Step 2: Write the failing tests**

Create `server/test/codex-usage.test.ts`:

```ts
/*
 * Reading Codex's plan quota off disk.
 *
 * The CLI already writes what a gauge needs into its session rollout files, so
 * this needs no credentials and no network — but it is somebody else's file
 * format, written by a binary that updates itself, so every assumption it makes
 * is pinned here. The one that matters most is freshness: `rate_limits` is only
 * written when a turn runs, so "the newest reading wins" is not a nicety, it is
 * the difference between today's number and one from last week.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { windowLabel } from "../../shared/quota.ts";
import { codexUsage, __resetCodexUsageCache } from "../src/codexusage.ts";

let dir: string | null = null;

function home(): string {
  dir = mkdtempSync(join(tmpdir(), "agx-codex-usage-"));
  process.env.CODEX_HOME = dir;
  __resetCodexUsageCache();
  return dir;
}

/** One rollout file, with whatever lines the test wants, aged so mtime
 *  ordering is deterministic rather than dependent on how fast the test ran. */
function rollout(root: string, day: string, name: string, lines: string[], ageSec = 0): string {
  const [y, m, d] = day.split("-");
  const dirPath = join(root, "sessions", y!, m!, d!);
  mkdirSync(dirPath, { recursive: true });
  const p = join(dirPath, name);
  writeFileSync(p, lines.join("\n") + "\n");
  const when = new Date(Date.now() - ageSec * 1000);
  utimesSync(p, when, when);
  return p;
}

const tokenCount = (usedPercent: number, windowMinutes: number, opts: {
  secondary?: { used_percent: number; window_minutes: number } | null;
  plan?: string;
  resetsAt?: number;
} = {}) => JSON.stringify({
  timestamp: "2026-07-31T23:41:35.574Z",
  type: "event_msg",
  payload: {
    type: "token_count",
    info: { model_context_window: 258400 },
    rate_limits: {
      limit_id: "codex",
      primary: {
        used_percent: usedPercent,
        window_minutes: windowMinutes,
        resets_at: opts.resetsAt ?? 1786114806,
      },
      secondary: opts.secondary
        ? { ...opts.secondary, resets_at: 1786114806 }
        : null,
      plan_type: opts.plan ?? "plus",
    },
  },
});

/** A line the reader must skip: a real rollout is mostly these. */
const otherLine = JSON.stringify({ type: "response_item", payload: { type: "message" } });

afterEach(() => {
  if (dir) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* fine */ } }
  dir = null;
  delete process.env.CODEX_HOME;
  __resetCodexUsageCache();
});

describe("windowLabel", () => {
  test("names the windows Codex actually uses", () => {
    expect(windowLabel(300)).toBe("5h");
    expect(windowLabel(10080)).toBe("weekly");
  });

  test("computes anything else rather than guessing", () => {
    expect(windowLabel(180)).toBe("3h");
    expect(windowLabel(43200)).toBe("30d");
    expect(windowLabel(90)).toBe("90m");
  });
});

describe("reading a rollout", () => {
  test("parses percent, window, reset and plan", () => {
    const root = home();
    rollout(root, "2026-07-31", "rollout-a.jsonl", [otherLine, tokenCount(5, 10080)]);
    const u = codexUsage();
    expect(u.available).toBe(true);
    expect(u.provider).toBe("codex");
    expect(u.plan).toBe("plus");
    expect(u.windows).toHaveLength(1);
    expect(u.windows[0]!.label).toBe("weekly");
    expect(u.windows[0]!.usedPercent).toBe(5);
    // Unix SECONDS in the file; ISO 8601 out.
    expect(u.windows[0]!.resetsAt).toBe(new Date(1786114806 * 1000).toISOString());
  });

  test("a null secondary yields one window, not a broken second one", () => {
    const root = home();
    rollout(root, "2026-07-31", "rollout-a.jsonl", [tokenCount(5, 10080, { secondary: null })]);
    expect(codexUsage().windows).toHaveLength(1);
  });

  test("a present secondary yields both, labelled by length", () => {
    const root = home();
    rollout(root, "2026-07-31", "rollout-a.jsonl", [
      tokenCount(12, 300, { secondary: { used_percent: 40, window_minutes: 10080 } }),
    ]);
    const w = codexUsage().windows;
    expect(w.map((x) => x.label)).toEqual(["5h", "weekly"]);
    expect(w.map((x) => x.usedPercent)).toEqual([12, 40]);
  });

  test("the newest reading wins", () => {
    const root = home();
    rollout(root, "2026-07-30", "rollout-old.jsonl", [tokenCount(90, 10080)], 7200);
    rollout(root, "2026-07-31", "rollout-new.jsonl", [tokenCount(5, 10080)], 60);
    expect(codexUsage().windows[0]!.usedPercent).toBe(5);
  });

  test("the last reading in a file wins over earlier ones", () => {
    const root = home();
    rollout(root, "2026-07-31", "rollout-a.jsonl", [
      tokenCount(2, 10080), otherLine, tokenCount(7, 10080),
    ]);
    expect(codexUsage().windows[0]!.usedPercent).toBe(7);
  });

  test("falls back to an older file when the newest has no reading yet", () => {
    const root = home();
    rollout(root, "2026-07-30", "rollout-old.jsonl", [tokenCount(11, 10080)], 7200);
    // A session that has only just started: no token_count event written yet.
    rollout(root, "2026-07-31", "rollout-fresh.jsonl", [otherLine], 30);
    expect(codexUsage().windows[0]!.usedPercent).toBe(11);
  });

  test("reports when it was observed, from the file's mtime", () => {
    const root = home();
    rollout(root, "2026-07-31", "rollout-a.jsonl", [tokenCount(5, 10080)], 3600);
    const u = codexUsage();
    const ageMs = Date.now() - (u.observedAt ?? 0);
    expect(ageMs).toBeGreaterThan(3_000_000);
    expect(ageMs).toBeLessThan(4_200_000);
  });
});

describe("when there is nothing to read", () => {
  test("no sessions directory: unavailable with a reason, never a throw", () => {
    home();
    const u = codexUsage();
    expect(u.available).toBe(false);
    expect(u.note).toBeTruthy();
    expect(u.windows).toEqual([]);
  });

  test("sessions exist but none carries a reading", () => {
    const root = home();
    rollout(root, "2026-07-31", "rollout-a.jsonl", [otherLine, otherLine]);
    const u = codexUsage();
    expect(u.available).toBe(false);
    expect(u.note).toBeTruthy();
  });

  test("malformed JSON is skipped rather than fatal", () => {
    const root = home();
    rollout(root, "2026-07-31", "rollout-a.jsonl", ["{not json", tokenCount(5, 10080)]);
    expect(codexUsage().windows[0]!.usedPercent).toBe(5);
  });

  test("gives up after a bounded number of files", () => {
    const root = home();
    // Eight readless files, then a ninth with a reading that must NOT be found:
    // the bound is the point, and an unbounded scan would return 42 here.
    for (let i = 0; i < 8; i++) rollout(root, "2026-07-31", `rollout-${i}.jsonl`, [otherLine], i);
    rollout(root, "2026-07-20", "rollout-old.jsonl", [tokenCount(42, 10080)], 900);
    expect(codexUsage().available).toBe(false);
  });

  test("never leaks a filesystem path", () => {
    const root = home();
    rollout(root, "2026-07-31", "rollout-a.jsonl", [otherLine]);
    expect(JSON.stringify(codexUsage())).not.toContain(root);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd server && bun test test/codex-usage.test.ts`
Expected: FAIL — cannot resolve `../../shared/quota.ts` and `../src/codexusage.ts`.

- [ ] **Step 4: Write `shared/quota.ts`**

```ts
/**
 * Naming a rate-limit window by its length.
 *
 * Codex's `primary`/`secondary` are positional, not semantic — which of them is
 * the short window depends on the plan, and on a weekly-only plan `primary` IS
 * the weekly one. So the length names the window and the key never does.
 */
export function windowLabel(minutes: number): string {
  if (minutes === 300) return "5h";
  if (minutes === 10080) return "weekly";
  if (minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}
```

- [ ] **Step 5: Write `server/src/codexusage.ts`**

```ts
// Codex plan quota, read off disk.
//
// The CLI records the rate-limit snapshot it got from the API into its session
// rollout files (`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`), inside the
// `token_count` events. That makes this the cheapest usage source in the app:
// no credentials, no network, no endpoint that can rate-limit us for asking.
//
// It buys that with staleness. `rate_limits` is only written when a turn runs,
// so this reading is as old as your last Codex conversation — which is why
// `observedAt` is not optional decoration here, and why the refresh ping in
// index.ts exists at all. A number with no age on it would be a lie by omission
// the first time somebody read it after a quiet weekend.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { ProviderUsage, QuotaWindow } from "../../shared/types.ts";
import { windowLabel } from "../../shared/quota.ts";

const codexHome = () => process.env.CODEX_HOME || join(homedir(), ".codex");

/**
 * How many rollout files to open before giving up.
 *
 * More than one because the newest file may be a session that has not taken a
 * turn yet and so has no `token_count` in it. Bounded because a rollout is
 * read whole, and "scan until you find one" over a year of sessions is an
 * unbounded read on the thread that also carries the terminal.
 */
const MAX_FILES = 5;

const LABEL = "Codex";

function unavailable(note: string): ProviderUsage {
  return { provider: "codex", label: LABEL, available: false, windows: [], note };
}

/** Numeric directory entries, newest name first. The layout is YYYY/MM/DD, so
 *  lexical order on a zero-padded name is chronological order. */
function descendingDirs(path: string): string[] {
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter((e) => e.isDirectory() && /^\d+$/.test(e.name))
      .map((e) => e.name)
      .sort((a, b) => b.localeCompare(a));
  } catch { return []; }
}

/** The most recent rollout files, newest first, capped at MAX_FILES. */
function recentRollouts(root: string): string[] {
  const out: { path: string; mtime: number }[] = [];
  for (const y of descendingDirs(root)) {
    for (const m of descendingDirs(join(root, y))) {
      for (const d of descendingDirs(join(root, y, m))) {
        const dayDir = join(root, y, m, d);
        let names: string[] = [];
        try { names = readdirSync(dayDir).filter((n) => n.endsWith(".jsonl")); } catch { continue; }
        for (const n of names) {
          const p = join(dayDir, n);
          try { out.push({ path: p, mtime: statSync(p).mtimeMs }); } catch { /* vanished */ }
        }
        // A whole day gathered at a time, so files written out of order within
        // one day still sort correctly against each other.
        if (out.length >= MAX_FILES) {
          return out.sort((a, b) => b.mtime - a.mtime).slice(0, MAX_FILES).map((f) => f.path);
        }
      }
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime).slice(0, MAX_FILES).map((f) => f.path);
}

type RawWindow = { used_percent?: unknown; window_minutes?: unknown; resets_at?: unknown };

function quotaWindow(w: unknown): QuotaWindow | null {
  const r = w as RawWindow | null;
  if (!r || typeof r.used_percent !== "number" || typeof r.window_minutes !== "number") return null;
  return {
    label: windowLabel(r.window_minutes),
    minutes: r.window_minutes,
    usedPercent: Math.round(r.used_percent),
    // Unix SECONDS in the file. Multiplying is not optional: as milliseconds
    // this lands in 1970 and every reset renders as "now".
    resetsAt: typeof r.resets_at === "number" ? new Date(r.resets_at * 1000).toISOString() : null,
  };
}

/** The last `rate_limits` in one file, or null. Scanned backwards: the newest
 *  reading is at the end, and a rollout is mostly lines this does not want. */
function lastRateLimits(path: string): { windows: QuotaWindow[]; plan?: string } | null {
  let text: string;
  try { text = readFileSync(path, "utf8"); } catch { return null; }
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    if (!line || !line.includes("rate_limits")) continue;
    let doc: any;
    try { doc = JSON.parse(line); } catch { continue; } // a truncated final write
    const rl = doc?.payload?.rate_limits;
    if (!rl) continue;
    const windows = [quotaWindow(rl.primary), quotaWindow(rl.secondary)].filter((w): w is QuotaWindow => !!w);
    if (!windows.length) continue;
    // Shortest window first, so a 5h meter never renders below the weekly one
    // it is nested inside. Ordered on length rather than on the primary/
    // secondary keys, which are positional and swap between plans.
    windows.sort((a, b) => a.minutes - b.minutes);
    return { windows, plan: typeof rl.plan_type === "string" ? rl.plan_type : undefined };
  }
  return null;
}

/** Keyed on the file we read and its mtime: repeat calls are free until Codex
 *  writes again, and a new turn invalidates without a timer. */
let cache: { key: string; value: ProviderUsage } | null = null;

export function codexUsage(): ProviderUsage {
  const root = join(codexHome(), "sessions");
  if (!existsSync(root)) {
    return unavailable("No Codex sessions on this machine yet — run a Codex turn and the quota appears here.");
  }
  const files = recentRollouts(root);
  if (!files.length) {
    return unavailable("No Codex sessions on this machine yet — run a Codex turn and the quota appears here.");
  }
  let mtime = 0;
  try { mtime = statSync(files[0]!).mtimeMs; } catch { /* fine */ }
  const key = `${files[0]}:${mtime}`;
  if (cache && cache.key === key) return cache.value;

  let value: ProviderUsage = unavailable(
    "No recent Codex turn recorded its quota — run a Codex turn to refresh it.",
  );
  for (const path of files) {
    const hit = lastRateLimits(path);
    if (!hit) continue;
    let observedAt = Date.now();
    try { observedAt = statSync(path).mtimeMs; } catch { /* fine */ }
    value = {
      provider: "codex", label: LABEL, available: true,
      windows: hit.windows, plan: hit.plan, observedAt,
    };
    break;
  }
  cache = { key, value };
  return value;
}

/** Test seam: forget the cached reading. */
export function __resetCodexUsageCache(): void { cache = null; }
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd server && bun test test/codex-usage.test.ts`
Expected: PASS, 14 tests.

- [ ] **Step 7: Typecheck and commit**

```bash
cd /home/yoshi/git/agentglass-working && make typecheck
git add shared/types.ts shared/quota.ts server/src/codexusage.ts server/test/codex-usage.test.ts
git commit -m "Read Codex's plan quota from the files it already writes"
```

---

### Task 2: The `/usage/providers` endpoint

**Files:**
- Create: `server/src/providerusage.ts`
- Modify: `server/src/index.ts` (import block near line 88; new route beside `/usage`)
- Test: `server/test/usage-providers.test.ts`

**Interfaces:**
- Consumes: `codexUsage()` from `server/src/codexusage.ts`; `ProviderUsage` from `shared/types.ts`; the existing `getUsage(): Promise<UsagePayload>` from `server/src/usage.ts`.
- Produces: `allProviderUsage(): Promise<ProviderUsage[]>` and `ANTIGRAVITY_NOTE: string` (from `server/src/providerusage.ts`); the route `GET /usage/providers`.

- [ ] **Step 1: Find where `/usage` is routed**

Run: `grep -n '"/usage"' server/src/index.ts`
Note the line — the new route goes directly beneath it and reuses the same `json()` helper.

- [ ] **Step 2: Write the failing tests**

Create `server/test/usage-providers.test.ts`:

```ts
/*
 * One shape for three providers.
 *
 * The point of this endpoint is that a surface renders a LIST. That only works
 * if the list is always the same length: a provider that drops out when it has
 * nothing to say turns "Antigravity cannot tell us" into "Antigravity does not
 * exist", and the second reads as our bug rather than theirs.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir: string, base: string, proc: ReturnType<typeof Bun.spawn> | null = null;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "agx-usage-providers-"));
  const port = 4930 + Math.floor(Math.random() * 20);
  base = `http://127.0.0.1:${port}`;
  proc = Bun.spawn(["bun", "run", new URL("../src/index.ts", import.meta.url).pathname], {
    env: {
      PATH: process.env.PATH ?? "",
      HOME: dir,
      XDG_CONFIG_HOME: dir,
      AGENTGLASS_ROOT: dir,
      AGENTGLASS_DB: join(dir, "f.db"),
      AGENTGLASS_SCAN_DISABLED: "1",
      AGENTGLASS_PORT: String(port),
      // A home with no ~/.codex in it: the "nothing recorded yet" path, which
      // is what a fresh machine actually looks like.
      CODEX_HOME: join(dir, "codex"),
    },
    stdout: "ignore", stderr: "pipe",
  });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(base + "/health")).ok) return; } catch { /* not up yet */ }
    await Bun.sleep(100);
  }
  throw new Error("the server did not come up: " + (await new Response(proc.stderr as ReadableStream).text()).slice(0, 400));
});

afterAll(() => {
  try { proc?.kill(); } catch { /* already gone */ }
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* fine */ }
});

type Provider = {
  provider: string; label: string; available: boolean;
  windows: { label: string; usedPercent: number; resetsAt: string | null; minutes: number }[];
  note?: string; plan?: string; observedAt?: number;
};

const providers = async (): Promise<Provider[]> =>
  (await fetch(base + "/usage/providers").then((r) => r.json())) as Provider[];

describe("/usage/providers", () => {
  test("always names all three, in a stable order", async () => {
    const list = await providers();
    expect(list.map((p) => p.provider)).toEqual(["anthropic", "codex", "antigravity"]);
  });

  test("every provider carries a human label", async () => {
    for (const p of await providers()) expect(p.label.length).toBeGreaterThan(0);
  });

  test("Antigravity is a labelled gap, not an absence", async () => {
    const agy = (await providers()).find((p) => p.provider === "antigravity")!;
    expect(agy.available).toBe(false);
    expect(agy.windows).toEqual([]);
    // A sentence, because it is rendered to a person.
    expect(agy.note ?? "").toMatch(/\s/);
  });

  test("a provider with nothing to say still says why", async () => {
    for (const p of await providers()) {
      if (!p.available) expect(p.note ?? "").toMatch(/\s/);
    }
  });

  test("no filesystem path is in the answer", async () => {
    expect(JSON.stringify(await providers())).not.toContain(dir);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd server && bun test test/usage-providers.test.ts`
Expected: FAIL — the route 404s, so `r.json()` rejects or the array is empty.

- [ ] **Step 4: Write `server/src/providerusage.ts`**

```ts
// Every provider's plan quota, in one shape.
//
// Three genuinely different sources — a live OAuth endpoint, a file the Codex
// CLI writes, and nothing at all — normalised so that the surfaces render a
// list instead of three bespoke blocks. The order is fixed rather than sorted:
// a row that moves because a number changed is a row nobody can find twice.
import type { ProviderUsage } from "../../shared/types.ts";
import { getUsage } from "./usage.ts";
import { codexUsage } from "./codexusage.ts";

/**
 * Why Antigravity has no gauge.
 *
 * Checked 2026-07-31: `agy` has no usage or quota subcommand, nothing under
 * ~/.gemini/antigravity-cli holds a quota figure, its conversation DBs carry no
 * usage fields, and its own log shows a quota_manager that refreshes into
 * process memory and never writes it down. The only route left would be
 * replaying its authenticated backend call, which is out of scope.
 *
 * Shown rather than hidden, because a provider that is simply missing from the
 * list reads as a bug in agentglass, while one that says why reads as the
 * upstream limitation it is.
 */
export const ANTIGRAVITY_NOTE =
  "Antigravity's CLI does not report quota anywhere agentglass can read.";

> **Amended after Task 2's review (human ruling: "fix it all").** The sketch
> below hardcodes `"5h"`/`"weekly"` and has no guard for `available: true`
> with zero parsed windows — both were shipped as genuine defects rather than
> deliberate simplifications, so the code now differs from this listing:
> `anthropic()` calls `windowLabel(300)`/`windowLabel(10080)` instead of
> hardcoding the strings, and returns `available: false` with an explanatory
> note when Anthropic answers `available: true` but neither window parses
> (reachable whenever `usage.ts` returns `undefined` for both fields).
>
> **Amended again after the final whole-branch review.** The sketch's single
> hardcoded `"sign in to Claude Code"` note for every `!u.available` case was
> also a defect: `usage.ts` already distinguishes "no credentials", a 429,
> and a network/timeout throw, and telling a rate-limited or offline user to
> sign in is a misdiagnosis. The live `anthropicUsage()` branches on
> `u.error` and gives each case its own sentence. See
> `server/src/providerusage.ts` for the current version; this block is kept
> for history and should not be copied.

/** Anthropic's live reading, in the shared shape. The percentages are already
 *  0..100 and already rounded by usage.ts. */
async function anthropic(): Promise<ProviderUsage> {
  const u = await getUsage();
  if (!u.available) {
    return {
      provider: "anthropic", label: "Claude", available: false, windows: [],
      note: "Could not read Anthropic plan usage — sign in to Claude Code on this machine.",
    };
  }
  const windows = [];
  if (u.five_hour) {
    windows.push({
      label: "5h", minutes: 300,
      usedPercent: u.five_hour.utilization,
      resetsAt: u.five_hour.resets_at,
    });
  }
  if (u.seven_day) {
    windows.push({
      label: "weekly", minutes: 10080,
      usedPercent: u.seven_day.utilization,
      resetsAt: u.seven_day.resets_at,
    });
  }
  return {
    provider: "anthropic", label: "Claude", available: true,
    windows, observedAt: u.fetched_at,
  };
}

export async function allProviderUsage(): Promise<ProviderUsage[]> {
  return [
    await anthropic(),
    codexUsage(),
    {
      provider: "antigravity", label: "Antigravity", available: false,
      windows: [], note: ANTIGRAVITY_NOTE,
    },
  ];
}
```

- [ ] **Step 5: Wire the route**

In `server/src/index.ts`, add to the import block near line 88:

```ts
import { allProviderUsage } from "./providerusage.ts";
```

Directly beneath the existing `/usage` route:

```ts
    // Every provider's plan quota in one shape — the dashboard box, the Stats
    // section and the notch all read this one answer. No desktop-only gate:
    // there is no path on disk in the payload and nothing here can act.
    if (pathname === "/usage/providers") return json(await allProviderUsage());
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd server && bun test test/usage-providers.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 7: Typecheck and commit**

```bash
cd /home/yoshi/git/agentglass-working && make typecheck
git add server/src/providerusage.ts server/src/index.ts server/test/usage-providers.test.ts
git commit -m "Answer plan quota for every provider at one endpoint"
```

---

### Task 3: The client usage store

**Files:**
- Create: `web/src/lib/usageStore.ts`
- Modify: `web/src/lib/api.ts` (add the method beside `usage` at line 331, and to the demo object at line 714)
- Test: `web/test/usage-store.test.ts`

**Interfaces:**
- Consumes: `ProviderUsage` from `shared/types.ts`; `GET /usage/providers` from Task 2.
- Produces, all from `web/src/lib/usageStore.ts`: `subscribeProviderUsage(fn: () => void): () => void`, `providerUsage(): ProviderUsage[] | null`, `usageOf(p: ProviderUsage["provider"]): ProviderUsage | null`, `usedColor(used: number): string`, `resetLabel(iso: string | null): string`, `ageLabel(observedAt: number | undefined, now?: number): string`, `__resetUsageStore(): void`. Plus `api.providerUsage()`.

- [ ] **Step 1: Add the api method**

In `web/src/lib/api.ts`, beside `usage` (line 331):

```ts
  providerUsage: () => get<ProviderUsage[]>(`/usage/providers`),
```

Add `ProviderUsage` to the `shared/types.ts` import at line 1. In the demo object (near line 714):

```ts
  providerUsage: () => D(demo.providerUsage() as ProviderUsage[]),
```

And in `web/src/lib/demo.ts`, beside the existing `usage()`:

```ts
/** The demo has no machine behind it, so the gauges show the shape without
 *  claiming numbers: two providers that cannot answer and one that never can. */
export const providerUsage = (): ProviderUsage[] => [
  { provider: "anthropic", label: "Claude", available: false, windows: [],
    note: "Plan usage is not available in the demo." },
  { provider: "codex", label: "Codex", available: false, windows: [],
    note: "Plan usage is not available in the demo." },
  { provider: "antigravity", label: "Antigravity", available: false, windows: [],
    note: "Antigravity's CLI does not report quota anywhere agentglass can read." },
];
```

- [ ] **Step 2: Write the failing tests**

Create `web/test/usage-store.test.ts`:

```ts
/*
 * The labels the gauges put on screen.
 *
 * Only the pure functions are tested here — the poll itself is a timer and a
 * fetch, and the interesting decisions are all in how a reading is DESCRIBED.
 * `ageLabel` carries the most weight: it is the whole reason a Codex reading is
 * honest rather than merely present.
 */
import { describe, expect, test } from "bun:test";
import { ageLabel, resetLabel, usedColor } from "../src/lib/usageStore.ts";

const NOW = Date.parse("2026-07-31T12:00:00Z");

describe("usedColor", () => {
  test("escalates with consumption", () => {
    expect(usedColor(10)).toBe("var(--success)");
    expect(usedColor(70)).toBe("var(--warning)");
    expect(usedColor(90)).toBe("var(--error)");
  });

  test("changes exactly at the thresholds", () => {
    expect(usedColor(59)).toBe("var(--success)");
    expect(usedColor(60)).toBe("var(--warning)");
    expect(usedColor(84)).toBe("var(--warning)");
    expect(usedColor(85)).toBe("var(--error)");
  });
});

describe("ageLabel", () => {
  test("a reading from moments ago does not nag", () => {
    expect(ageLabel(NOW - 30_000, NOW)).toBe("just now");
  });

  test("says how old a stale reading is", () => {
    expect(ageLabel(NOW - 45 * 60_000, NOW)).toBe("45m ago");
    expect(ageLabel(NOW - 3 * 3_600_000, NOW)).toBe("3h ago");
    expect(ageLabel(NOW - 50 * 3_600_000, NOW)).toBe("2d ago");
  });

  test("no reading is not an age", () => {
    expect(ageLabel(undefined, NOW)).toBe("");
  });
});

describe("resetLabel", () => {
  test("counts down when the reset is near", () => {
    expect(resetLabel(new Date(NOW + 104 * 60_000).toISOString(), NOW)).toBe("in 1h 44m");
    expect(resetLabel(new Date(NOW + 20 * 60_000).toISOString(), NOW)).toBe("in 20m");
  });

  test("a reset in the past is now, not a negative countdown", () => {
    expect(resetLabel(new Date(NOW - 60_000).toISOString(), NOW)).toBe("now");
  });

  test("nothing to say about a null reset", () => {
    expect(resetLabel(null, NOW)).toBe("");
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd web && bun test test/usage-store.test.ts`
Expected: FAIL — cannot resolve `../src/lib/usageStore.ts`.

- [ ] **Step 4: Write `web/src/lib/usageStore.ts`**

This moves the poll out of `UsageWidget.tsx` unchanged in behaviour — one timer for the whole app, last-good retention, late subscribers served immediately — and widens it to all providers. `resetLabel` and `usedColor` come across from `UsageWidget.tsx:5-18` and `:79-83`, gaining an injectable `now` so they can be tested without freezing the clock.

```ts
import { api, IS_DEMO } from "./api.ts";
import type { ProviderUsage } from "../../../shared/types.ts";

/**
 * Plan quota for every provider, polled once for the whole app.
 *
 * A module store rather than a hook, for the reason UsageWidget's own store was
 * one: the answer belongs to the app, not to whichever gauge happens to be
 * mounted. Three surfaces read this now — the dashboard box, the Stats modal
 * and the notch — and a per-component fetch would mean three timers racing an
 * endpoint that talks to a rate-limited API on our behalf.
 */

let snapshot: ProviderUsage[] | null = null;
let firstFetchDone = false;
const listeners = new Set<() => void>();
let poller: ReturnType<typeof setInterval> | null = null;

/** Five minutes: these are 5-hour and weekly windows, and the fastest of them
 *  moves by a fraction of a percent a minute. Polling harder than this once
 *  earned a 429 that made the meters vanish entirely. */
const EVERY_MS = 5 * 60_000;

export const providerUsage = (): ProviderUsage[] | null => snapshot;

export const usageOf = (p: ProviderUsage["provider"]): ProviderUsage | null =>
  snapshot?.find((u) => u.provider === p) ?? null;

/** Whether the first fetch has come back, so a surface can tell "loading" from
 *  "nothing to show" — the distinction the About pane bug was made of. */
export const usageLoaded = (): boolean => firstFetchDone;

> **Amended after Task 3's review.** `!poller && !IS_DEMO` below was a
> shipped defect: it means `load()` never runs in demo mode, so
> `usageLoaded()` is permanently `false`, every demo surface spins forever,
> and the demo fixture is dead code. `UsageWidget.subscribeUsage`, the
> pattern this was meant to port, has no `IS_DEMO` gate at all. The live
> guard is `if (!poller) {` — no `IS_DEMO` check — and `api.providerUsage()`
> already resolves against the demo fixture when `IS_DEMO` is set, the same
> way every other store in this codebase works.

export function subscribeProviderUsage(fn: () => void): () => void {
  listeners.add(fn);
  if (!poller) {
    const load = () => api.providerUsage()
      // A failed poll leaves the last good answer standing: the meters must
      // never blink out because one request lost.
      .then((next) => { snapshot = next; })
      .catch(() => { /* offline — keep what we have */ })
      .finally(() => { firstFetchDone = true; for (const l of listeners) l(); });
    load();
    poller = setInterval(load, EVERY_MS);
  } else if (firstFetchDone) {
    queueMicrotask(fn);
  }
  return () => {
    listeners.delete(fn);
    if (!listeners.size && poller) { clearInterval(poller); poller = null; }
  };
}

/** Colour escalates with consumption — the "used" mental model. */
export function usedColor(used: number): string {
  if (used >= 85) return "var(--error)";
  if (used >= 60) return "var(--warning)";
  return "var(--success)";
}

/** "in 1h 44m" when soon, else "Wed 3:00 PM". */
export function resetLabel(iso: string | null, now = Date.now()): string {
  if (!iso) return "";
  const d = new Date(iso);
  const ms = d.getTime() - now;
  if (ms <= 0) return "now";
  if (ms < 24 * 3_600_000) {
    const h = Math.floor(ms / 3_600_000);
    const m = Math.floor((ms % 3_600_000) / 60_000);
    return h >= 1 ? `in ${h}h ${m}m` : `in ${m}m`;
  }
  const day = d.toLocaleDateString([], { weekday: "short" });
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return `${day} ${time}`;
}

/**
 * How old a reading is.
 *
 * Load-bearing for Codex, whose number is written only when a turn runs and can
 * be days old with nothing on screen to suggest it. Anything under a couple of
 * minutes reads as "just now" rather than "1m ago", because a precise age on a
 * fresh number is noise.
 */
export function ageLabel(observedAt: number | undefined, now = Date.now()): string {
  if (!observedAt) return "";
  const ms = now - observedAt;
  if (ms < 2 * 60_000) return "just now";
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 24 * 3_600_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / (24 * 3_600_000))}d ago`;
}

/** Test seam: forget everything this module remembers. */
export function __resetUsageStore(): void {
  snapshot = null;
  firstFetchDone = false;
  if (poller) { clearInterval(poller); poller = null; }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd web && bun test test/usage-store.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 6: Typecheck and commit**

```bash
cd /home/yoshi/git/agentglass-working && make typecheck
git add web/src/lib/usageStore.ts web/src/lib/api.ts web/src/lib/demo.ts web/test/usage-store.test.ts
git commit -m "Poll every provider's quota once for the whole app"
```

---

### Task 4: The dashboard Usage box and the grid it lives in

**Files:**
- Create: `web/src/components/UsageBox.tsx`
- Modify: `web/src/App.tsx:590-600`

**Interfaces:**
- Consumes: `subscribeProviderUsage`, `providerUsage`, `usageLoaded`, `usedColor`, `resetLabel`, `ageLabel` from `web/src/lib/usageStore.ts`; `Panel` from `web/src/components/Panel.tsx` (signature: `{ eyebrow?, title, right?, children, className?, bodyClass? }`).
- Produces: `<UsageBox />`.

- [ ] **Step 1: Write `web/src/components/UsageBox.tsx`**

```tsx
import { useSyncExternalStore } from "react";
import { Panel } from "./Panel.tsx";
import {
  subscribeProviderUsage, providerUsage, usageLoaded,
  usedColor, resetLabel, ageLabel,
} from "../lib/usageStore.ts";
import type { ProviderUsage } from "../../../shared/types.ts";

/**
 * Plan quota for every provider the cockpit can drive.
 *
 * Three states have to stay distinguishable here, and collapsing any two of
 * them is the bug this box exists to avoid: LOADING (the first fetch is out),
 * UNAVAILABLE (the provider cannot tell us, and the note says why), and STALE
 * (a real reading, with its age). A blank row is none of those and would be
 * read as "you have used nothing".
 */
function Meter({ label, used, resets }: { label: string; used: number; resets: string | null }) {
  const color = usedColor(used);
  return (
    <div className="flex items-center gap-2 min-w-0"
      title={`${label}: ${used}% used${resets ? ` — resets ${resetLabel(resets)}` : ""}`}>
      <span className="text-[9px] uppercase tracking-[0.14em] t-dim2 w-11 shrink-0">{label}</span>
      <div className="h-1.5 flex-1 min-w-0 rounded-full overflow-hidden"
        style={{ background: "color-mix(in srgb, var(--border) 40%, transparent)" }}>
        <div className="h-full rounded-full transition-all duration-700"
          style={{ width: `${Math.min(100, used)}%`, background: color }} />
      </div>
      <span className="text-[11px] font-semibold tabular-nums shrink-0" style={{ color }}>{used}%</span>
    </div>
  );
}

function Row({ u }: { u: ProviderUsage }) {
  const age = ageLabel(u.observedAt);
  return (
    <div className="flex flex-col gap-1 py-1.5">
      <div className="flex items-baseline gap-2 min-w-0">
        <span className="text-[11.5px] font-medium truncate" style={{ color: "var(--text)" }}>{u.label}</span>
        {u.plan && <span className="chip shrink-0 text-[9px] uppercase tracking-wide">{u.plan}</span>}
        {/* The age belongs next to the number it qualifies, not in a tooltip:
            a weeks-old Codex reading looks exactly like a fresh one. */}
        {u.available && age && <span className="ml-auto text-[9.5px] t-dim2 shrink-0">{age}</span>}
      </div>
      {u.available
        ? u.windows.map((w) => <Meter key={w.label} label={w.label} used={w.usedPercent} resets={w.resetsAt} />)
        : <span className="text-[10px] t-dim2 leading-snug">{u.note}</span>}
    </div>
  );
}

export function UsageBox() {
  const rows = useSyncExternalStore(subscribeProviderUsage, providerUsage, () => null);
  const loaded = useSyncExternalStore(subscribeProviderUsage, usageLoaded, () => false);

  return (
    <Panel eyebrow="Usage" title="Plan quota" right={<span className="text-[10px] t-dim2">By provider</span>}>
      <div className="h-full min-h-0 overflow-y-auto agx-scroll flex flex-col divide-y"
        style={{ borderColor: "color-mix(in srgb, var(--border) 30%, transparent)" }}>
        {!loaded && !rows && <span className="text-[11px] t-dim2 py-2">Reading plan quota…</span>}
        {rows?.map((u) => <Row key={u.provider} u={u} />)}
      </div>
    </Panel>
  );
}
```

- [ ] **Step 2: Merge the money and timeline rows in `App.tsx`**

Replace `web/src/App.tsx:590-600` (the two `shrink-0` blocks holding `CostByModel`/`Latency`/`Sessions` and `MissionTimeline`) with:

```tsx
        {/* Money row and timeline share one grid so the Usage box can span
            both. The columns line up with the cockpit above: Usage under
            Fleet, Cost and Latency under the middle column, Sessions under
            Alerts. */}
        <div className="shrink-0 grid grid-cols-1 xl:grid-cols-12 gap-3 h-auto xl:grid-rows-[196px_140px]">
          <div className="xl:col-span-3 xl:row-span-2 min-w-0 min-h-0 h-[196px] xl:h-auto">
            <UsageBox />
          </div>
          <div className="xl:col-span-3 min-w-0 min-h-0 h-[196px] xl:h-auto"><CostByModel stats={stats} /></div>
          <div className="xl:col-span-3 min-w-0 min-h-0 h-[196px] xl:h-auto"><Latency stats={stats} /></div>
          <div className="xl:col-span-3 min-w-0 min-h-0 h-[196px] xl:h-auto"><Sessions provider={filter.provider} /></div>
          <div className="xl:col-span-9 min-w-0 min-h-0 h-[140px] xl:h-auto"><MissionTimeline stats={stats} /></div>
        </div>
```

Add the import beside the other component imports (near line 25):

```tsx
import { UsageBox } from "./components/UsageBox.tsx";
```

- [ ] **Step 3: Typecheck**

Run: `cd /home/yoshi/git/agentglass-working && make typecheck`
Expected: no output beyond the two `tsc` command echoes.

- [ ] **Step 4: Look at it**

Run: `cd /home/yoshi/git/agentglass-working && bun run dev` and open the dashboard.
Expected: a Usage box left of Cost, spanning down beside the timeline; the four top boxes line up with Fleet / middle / Alerts above them; Antigravity shows its note rather than an empty row. Stop the dev server when done.

- [ ] **Step 5: Commit**

```bash
git add web/src/components/UsageBox.tsx web/src/App.tsx
git commit -m "Put every provider's quota on the dashboard, left of the money"
```

---

### Task 5: The in-context gauge in the notch

**Files:**
- Create: `web/src/lib/providerContext.ts`
- Modify: `web/src/components/workspace/DynamicIsland.tsx` (the usage block at lines 440-442 and wherever those meters render)
- Test: `web/test/provider-context.test.ts`

**Interfaces:**
- Consumes: `AgentKind` (`"claude" | "codex" | "antigravity"`) from `web/src/lib/agents.ts`; `ProviderUsage` from `shared/types.ts`; the store from Task 3.
- Produces: `providerInContext(focused: AgentKind | null, filterProvider: string): ProviderUsage["provider"] | null` from `web/src/lib/providerContext.ts`.

- [ ] **Step 1: Write the failing test**

Create `web/test/provider-context.test.ts`:

```ts
/*
 * Which gauge the notch shows.
 *
 * "In context" is deliberately not "whatever the dashboard filter says". The
 * notch lives in the workspace, where you are inside one chat with one agent —
 * and the quota that matters while you drive a Codex turn is Codex's, however
 * the dashboard behind it happens to be filtered.
 */
import { describe, expect, test } from "bun:test";
import { providerInContext } from "../src/lib/providerContext.ts";

describe("providerInContext", () => {
  test("the focused agent wins over the filter", () => {
    expect(providerInContext("codex", "Anthropic")).toBe("codex");
    expect(providerInContext("antigravity", "Anthropic")).toBe("antigravity");
    expect(providerInContext("claude", "OpenAI")).toBe("anthropic");
  });

  test("falls back to the filter when no chat is focused", () => {
    expect(providerInContext(null, "Anthropic")).toBe("anthropic");
    expect(providerInContext(null, "OpenAI")).toBe("codex");
    expect(providerInContext(null, "Google")).toBe("antigravity");
  });

  test("no context at all is null, not a guess", () => {
    expect(providerInContext(null, "")).toBe(null);
    // A provider we have no gauge for must not borrow another's.
    expect(providerInContext(null, "Mistral")).toBe(null);
    expect(providerInContext(null, "unknown")).toBe(null);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd web && bun test test/provider-context.test.ts`
Expected: FAIL — cannot resolve `../src/lib/providerContext.ts`.

- [ ] **Step 3: Write `web/src/lib/providerContext.ts`**

```ts
import type { AgentKind } from "./agents.ts";
import type { ProviderUsage } from "../../../shared/types.ts";

type Provider = ProviderUsage["provider"];

/** The CLI you are driving names its own quota exactly. */
const BY_AGENT: Record<AgentKind, Provider> = {
  claude: "anthropic",
  codex: "codex",
  antigravity: "antigravity",
};

/**
 * A provider filter names a *model vendor*, which is a near-miss for a CLI
 * rather than the same thing — Google models can run under Antigravity or under
 * the Gemini CLI, and only one of those has a gauge. Close enough to pick a
 * meter from, and the map is explicit so an unmapped vendor yields nothing
 * instead of quietly borrowing somebody else's numbers.
 */
const BY_FILTER: Record<string, Provider> = {
  Anthropic: "anthropic",
  OpenAI: "codex",
  Google: "antigravity",
};

export function providerInContext(focused: AgentKind | null, filterProvider: string): Provider | null {
  if (focused) return BY_AGENT[focused];
  return BY_FILTER[filterProvider] ?? null;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd web && bun test test/provider-context.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Switch the island onto the store**

In `DynamicIsland.tsx`, replace the import at line 4:

```tsx
import { subscribeProviderUsage, usageOf, usedColor, resetLabel, ageLabel } from "../../lib/usageStore.ts";
import { providerInContext } from "../../lib/providerContext.ts";
```

`MeterPill` at lines 168-182 takes the Anthropic-shaped `UsageWindow`
(`{ utilization, resets_at }`). Retype it to the shared `QuotaWindow`
(`{ label, minutes, usedPercent, resetsAt }`) and let the window name itself
instead of being told a tag — the label is already "5h" or "weekly":

```tsx
/** A plan window: how much is gone, as a bar and a number, captioned with when
 *  it comes back. "62%" alone never answered the question you actually have. */
function MeterPill({ w, age }: { w: QuotaWindow; age: string }) {
  const color = usedColor(w.usedPercent);
  const reset = resetLabel(w.resetsAt);
  const tag = w.label.toUpperCase();
  return (
    <Pill
      cap={reset ? `${tag} · ${reset}` : tag}
      // The age rides in the tooltip rather than the cap: a Codex reading can
      // be days old, and a number with no age on it is a lie by omission.
      title={`${tag}: ${w.usedPercent}% used${reset ? ` — resets ${reset}` : ""}${age ? ` (read ${age})` : ""}`}
    >
      <span className="agx-bar" style={{ width: 38 }}>
        <i style={{ width: `${Math.min(100, Math.max(0, w.usedPercent))}%`, background: color }} />
      </span>
      <span className="agx-val" style={{ color }}>{w.usedPercent}%</span>
    </Pill>
  );
}
```

Add `QuotaWindow` to the `shared/types.ts` import at the top of the file, and
drop `UsageWindow`/`UsagePayload` from the `../../lib/api.ts` import if nothing
else in the file still uses them.

Replace the usage block at lines 440-442:

```tsx
  // One gauge, for the provider in context — the agent whose chat is focused,
  // or failing that whatever the dashboard is filtered to. The island is a
  // glance, so three providers' meters here would be two too many.
  const [, bumpUsage] = useState(0);
  useEffect(() => subscribeProviderUsage(() => bumpUsage((n) => n + 1)), []);
  const ctx = providerInContext(focusedAgent, filterProvider);
  const u = ctx ? usageOf(ctx) : null;
```

Replace the render at lines 592-605. The `rateLimited` branch goes: it was
reading `usageError()` from the deleted widget, and "the endpoint is throttling
us" is an Anthropic-only condition that the shared `note` now covers in the
surfaces with room to show it.

```tsx
              {u?.available ? (
                <>
                  <span className="agx-sep" />
                  {u.windows.map((w) => (
                    <MeterPill key={w.label} w={w} age={ageLabel(u.observedAt)} />
                  ))}
                </>
              ) : null}
```

- [ ] **Step 6: Thread the two new props**

`DynamicIsland` does not currently receive either input. Add them to its props
type as `focusedAgent: AgentKind | null` and `filterProvider: string`, then pass
them down: `Workspace` already tracks the focused chat (it takes `chatFocusId`
from `App.tsx:606`) and knows its agent, and `filter.provider` is in `App.tsx`
beside the `providers` memo at line 280. Pass `filter.provider` from `App.tsx`
into `Workspace`, and on to the island alongside the focused chat's agent.

Both props are allowed to be absent — `providerInContext(null, "")` returns
null, which renders no gauge, exactly as the island behaves today when there
are no numbers.

- [ ] **Step 7: Typecheck, look at it, commit**

```bash
cd /home/yoshi/git/agentglass-working && make typecheck
cd web && bun test test/provider-context.test.ts
```

Open the workspace, focus a Codex chat, confirm the notch shows the Codex gauge.

```bash
git add web/src/lib/providerContext.ts web/src/components/workspace/DynamicIsland.tsx web/src/components/workspace/Workspace.tsx web/src/App.tsx web/test/provider-context.test.ts
git commit -m "Show the notch the quota of the agent you are actually driving"
```

---

### Task 6: Retire the header widget

**Files:**
- Delete: `web/src/components/UsageWidget.tsx`
- Modify: `web/src/components/Header.tsx` (import at line 9, render at line 241, the `showUsage` prop in its props type)
- Modify: `web/src/App.tsx` (the `showUsage` memo at line 283, the prop at line 555)

**Interfaces:**
- Consumes: nothing new. Tasks 3 and 5 must be done first — they are what moved this file's poll and helpers out and switched its last consumer over.
- Produces: nothing. This task only removes.

- [ ] **Step 1: Confirm nothing still imports the widget**

Run: `grep -rn "UsageWidget" web/src web/test`
Expected: only `web/src/components/UsageWidget.tsx` itself. If `DynamicIsland` still appears, Task 5 is incomplete — stop and finish it.

- [ ] **Step 2: Remove it**

```bash
git rm web/src/components/UsageWidget.tsx
```

In `Header.tsx`: delete the import at line 9, delete the render at line 241 (the whole `{showUsage && <div className="hidden 2xl:block">…</div>}` line and its two-line comment above it), and remove `showUsage` from the component's props type.

In `App.tsx`: delete the `showUsage` const at line 283 with its two-line comment, and the `showUsage={showUsage}` prop at line 555.

- [ ] **Step 3: Verify nothing dangles**

Run: `grep -rn "showUsage\|UsageWidget" web/src`
Expected: no matches.

- [ ] **Step 4: Typecheck and commit**

```bash
cd /home/yoshi/git/agentglass-working && make typecheck
git add -A web/src/components/Header.tsx web/src/App.tsx
git commit -m "Take the quota meters out of the busiest strip in the UI"
```

---

### Task 7: The Stats modal section

**Files:**
- Modify: `web/src/components/StatsModal.tsx`

**Interfaces:**
- Consumes: the store from Task 3.
- Produces: nothing other tasks depend on.

- [ ] **Step 1: Add the section**

In `StatsModal.tsx`, add the imports:

```tsx
import { subscribeProviderUsage, providerUsage, usedColor, resetLabel, ageLabel } from "../lib/usageStore.ts";
```

Add a Usage section rendering one block per provider with what the dashboard box has no room for — plan type, the exact reset time, and when the reading was taken:

```tsx
function UsageSection() {
  const rows = useSyncExternalStore(subscribeProviderUsage, providerUsage, () => null);
  if (!rows) return null;
  return (
    <div className="flex flex-col gap-2">
      {rows.map((u) => (
        <div key={u.provider} className="flex flex-col gap-1">
          <div className="flex items-baseline gap-2">
            <span className="text-[12px]" style={{ color: "var(--text)" }}>{u.label}</span>
            {u.plan && <span className="chip text-[9px] uppercase">{u.plan}</span>}
            {u.observedAt && <span className="text-[10px] t-dim2 ml-auto">read {ageLabel(u.observedAt)}</span>}
          </div>
          {u.available
            ? u.windows.map((w) => (
                <div key={w.label} className="flex items-center gap-2 text-[10.5px]">
                  <span className="w-12 t-dim2">{w.label}</span>
                  <span className="tabular-nums font-semibold" style={{ color: usedColor(w.usedPercent) }}>
                    {w.usedPercent}%
                  </span>
                  {w.resetsAt && <span className="t-dim2">resets {resetLabel(w.resetsAt)}</span>}
                </div>
              ))
            : <span className="text-[10.5px] t-dim2">{u.note}</span>}
        </div>
      ))}
    </div>
  );
}
```

Render it inside the file's existing section wrapper, `Widget` (defined at
`StatsModal.tsx:176`, signature `{ title, i, full?, children }`), where `i` is
the stagger index. The existing widgets use 0-6, so this one takes 7:

```tsx
                <Widget title="plan quota · by provider" i={7} full>
                  <UsageSection />
                </Widget>
```

Place it beside the existing spend widgets — after the `apps by spend` widget
at line 352 is the natural home, since quota and spend answer the same question
from opposite ends.

- [ ] **Step 2: Typecheck, look at it, commit**

```bash
cd /home/yoshi/git/agentglass-working && make typecheck
```

Open Stats (`s` on the dashboard) and confirm the section renders for all three providers.

```bash
git add web/src/components/StatsModal.tsx
git commit -m "Give the quota numbers room to explain themselves in Stats"
```

---

### Task 8: The refresh ping, server side

**Files:**
- Modify: `server/src/codexusage.ts` (append the refresh function)
- Modify: `server/src/index.ts` (new POST route beside `/update/run`)
- Test: `server/test/codex-usage-refresh.test.ts`

**Interfaces:**
- Consumes: `codexUsage()`, `__resetCodexUsageCache()` from Task 1; `singleFlight(key: string, fn: () => Promise<T>): Promise<T>` from `server/src/singleflight.ts`; `CODEX_ENABLED` and `parseModels()` from `server/src/codex.ts`.
- Produces: `refreshCodexUsage(): Promise<{ ok: boolean; error?: string }>` and `usageRefreshModel(models: { id: string }[]): string | null` from `server/src/codexusage.ts`; the route `POST /usage/codex/refresh`.

- [ ] **Step 1: Write the failing test**

Create `server/test/codex-usage-refresh.test.ts`:

```ts
/*
 * The ping that keeps the Codex reading fresh.
 *
 * This spends quota in order to measure quota, so the only behaviours worth
 * pinning are the ones that stop it spending more than it must: it picks the
 * smallest model on offer, it never guesses a model id that is not there, and
 * it refuses outright when Codex is not available to run.
 */
import { describe, expect, test } from "bun:test";
import { usageRefreshModel } from "../src/codexusage.ts";

describe("usageRefreshModel", () => {
  test("takes the last entry — parseModels sorts by Codex's own priority", () => {
    expect(usageRefreshModel([{ id: "gpt-5.6-sol" }, { id: "gpt-5.6-luna" }, { id: "gpt-5.5" }]))
      .toBe("gpt-5.5");
  });

  test("an override wins over the list", () => {
    process.env.AGENTGLASS_CODEX_USAGE_MODEL = "gpt-tiny";
    try {
      expect(usageRefreshModel([{ id: "gpt-5.6-sol" }])).toBe("gpt-tiny");
    } finally {
      delete process.env.AGENTGLASS_CODEX_USAGE_MODEL;
    }
  });

  test("an empty list means no --model flag, not an invented id", () => {
    // Passing a model the plan does not have fails for everyone but its author.
    expect(usageRefreshModel([])).toBe(null);
  });
});

describe("the route, with Codex switched off", () => {
  let dir: string, base: string, proc: ReturnType<typeof Bun.spawn> | null = null;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "agx-refresh-off-"));
    const port = 4950 + Math.floor(Math.random() * 20);
    base = `http://127.0.0.1:${port}`;
    proc = Bun.spawn(["bun", "run", new URL("../src/index.ts", import.meta.url).pathname], {
      env: {
        PATH: process.env.PATH ?? "",
        HOME: dir,
        XDG_CONFIG_HOME: dir,
        AGENTGLASS_ROOT: dir,
        AGENTGLASS_DB: join(dir, "f.db"),
        AGENTGLASS_SCAN_DISABLED: "1",
        AGENTGLASS_PORT: String(port),
        AGENTGLASS_CODEX_DISABLED: "1",
      },
      stdout: "ignore", stderr: "pipe",
    });
    for (let i = 0; i < 100; i++) {
      try { if ((await fetch(base + "/health")).ok) return; } catch { /* not up yet */ }
      await Bun.sleep(100);
    }
    throw new Error("the server did not come up");
  });

  afterAll(() => {
    try { proc?.kill(); } catch { /* already gone */ }
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* fine */ }
  });

  test("refuses rather than spawning a binary it cannot use", async () => {
    const r = await fetch(base + "/usage/codex/refresh", {
      method: "POST",
      headers: { Origin: "http://localhost:5173", "content-type": "application/json" },
      body: "{}",
    });
    expect(r.status).toBe(200);
    const j = (await r.json()) as { ok: boolean; error?: string };
    // An honest no, not a silent success that leaves the reading unchanged.
    expect(j.ok).toBe(false);
    expect(j.error ?? "").toMatch(/codex/i);
  });
});
```

The spawned block needs these added to the file's imports:

```ts
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd server && bun test test/codex-usage-refresh.test.ts`
Expected: FAIL — `usageRefreshModel` is not exported, and the route 404s.

- [ ] **Step 3: Append to `server/src/codexusage.ts`**

```ts
/**
 * Which model the refresh ping runs on.
 *
 * Codex does not label a model "cheapest", so this does not guess. The list
 * `parseModels()` produces is sorted by Codex's own `priority`, largest first,
 * so its last entry is the smallest thing on offer. An explicit override wins,
 * and an empty list means no `--model` flag at all rather than an invented id —
 * a hardcoded model that is not on the user's plan is a feature that fails for
 * everyone except the person who wrote it.
 */
export function usageRefreshModel(models: { id: string }[]): string | null {
  const override = process.env.AGENTGLASS_CODEX_USAGE_MODEL;
  if (override) return override;
  return models.length ? models[models.length - 1]!.id : null;
}
```

And the refresh itself, importing `singleFlight` from `./singleflight.ts`, `CODEX_ENABLED` and the model list from `./codex.ts`:

```ts
/** How long the ping may take before we stop waiting. A turn that says "ok"
 *  takes a couple of seconds; a minute means something is wrong with it, not
 *  that patience will help. */
const REFRESH_TIMEOUT_MS = 60_000;

/**
 * Run a minimal Codex turn so the rate-limit snapshot on disk is current.
 *
 * Single-flighted: several open tabs firing their on-load trigger at once is
 * the normal case, and each one spawning its own turn would multiply the cost
 * by the number of windows somebody happens to have open.
 */
export async function refreshCodexUsage(): Promise<{ ok: boolean; error?: string }> {
  if (!CODEX_ENABLED) return { ok: false, error: "Codex is not available on this machine" };
  return singleFlight("codex-usage-refresh", async () => {
    // codexModels() is synchronous and already exported (server/src/codex.ts:127).
    const model = usageRefreshModel(codexModels());
    const args = ["exec", "--sandbox", "read-only"];
    if (model) args.push("--model", model);
    args.push("Reply with the single word: ok");
    const proc = Bun.spawn(["codex", ...args], {
      stdout: "ignore", stderr: "ignore", timeout: REFRESH_TIMEOUT_MS,
    });
    const code = await proc.exited;
    // The turn's OUTPUT is worthless — the point is the rate_limits it wrote
    // on its way past. Drop the cache so the next read sees the new file.
    __resetCodexUsageCache();
    return code === 0 ? { ok: true } : { ok: false, error: `codex exited ${code}` };
  });
}
```

Import `singleFlight` from `./singleflight.ts`, and `CODEX_ENABLED` plus
`codexModels` from `./codex.ts` — both are already exported (`codex.ts:28` and
`codex.ts:127`), so nothing in that file needs changing.

- [ ] **Step 4: Wire the route**

In `server/src/index.ts`, in the POST section near `/update/run`:

```ts
    // Spends a little quota to measure quota, so it is opt-in on the client and
    // gated here like the other routes that run a CLI.
    if (pathname === "/usage/codex/refresh" && req.method === "POST") {
      if (!trustedCaller(req)) return csrfBlocked();
      return json(await refreshCodexUsage());
    }
```

Add `refreshCodexUsage` to the `codexusage.ts` import.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd server && bun test test/codex-usage-refresh.test.ts test/codex-usage.test.ts`
Expected: PASS, 4 tests in the refresh file and 14 in the reader's.

- [ ] **Step 6: Typecheck and commit**

```bash
cd /home/yoshi/git/agentglass-working && make typecheck
git add server/src/codexusage.ts server/src/index.ts server/test/codex-usage-refresh.test.ts
git commit -m "Offer a minimal Codex turn as a way to refresh a stale reading"
```

---

### Task 9: The refresh setting and its triggers

**Files:**
- Create: `web/src/lib/usageRefreshPref.ts`
- Modify: `web/src/lib/usageStore.ts` (add the trigger)
- Modify: `web/src/lib/api.ts` (add `refreshCodexUsage`)
- Modify: `web/src/components/SettingsModal.tsx` (a `Toggle` in the prefs pane)
- Test: `web/test/usage-refresh.test.ts`

**Interfaces:**
- Consumes: `POST /usage/codex/refresh` from Task 8; `usageOf` from Task 3; the `Toggle({ on, onClick, label, hint })` component at `SettingsModal.tsx:40`; the localStorage-pref pattern of `web/src/lib/clockPref.ts`.
- Produces: `usageRefreshOn(): boolean`, `setUsageRefreshOn(on: boolean): void`, `subscribeUsageRefresh(fn: () => void): () => void`, `shouldRefresh(observedAt: number | undefined, now?: number): boolean` from `web/src/lib/usageRefreshPref.ts`.

- [ ] **Step 1: Write the failing test**

Create `web/test/usage-refresh.test.ts`:

```ts
/*
 * The floor under the refresh ping.
 *
 * Without it, "also on page load" means every ⌘R spawns a process and spends a
 * request. The floor is what turns a trigger into a budget.
 */
import { describe, expect, test } from "bun:test";
import { shouldRefresh } from "../src/lib/usageRefreshPref.ts";

const NOW = Date.parse("2026-07-31T12:00:00Z");

describe("shouldRefresh", () => {
  test("a reading younger than the floor is left alone", () => {
    expect(shouldRefresh(NOW - 60_000, NOW)).toBe(false);
    expect(shouldRefresh(NOW - 14 * 60_000, NOW)).toBe(false);
  });

  test("an older reading is worth a ping", () => {
    expect(shouldRefresh(NOW - 16 * 60_000, NOW)).toBe(true);
    expect(shouldRefresh(NOW - 3 * 3_600_000, NOW)).toBe(true);
  });

  test("no reading at all is worth a ping", () => {
    expect(shouldRefresh(undefined, NOW)).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd web && bun test test/usage-refresh.test.ts`
Expected: FAIL — cannot resolve `../src/lib/usageRefreshPref.ts`.

- [ ] **Step 3: Write `web/src/lib/usageRefreshPref.ts`**

Follows `clockPref.ts` exactly — a localStorage key, a getter, a setter that notifies, a subscribe.

```ts
/**
 * Whether to keep the Codex quota reading fresh by running a tiny turn.
 *
 * Off by default, and the setting says why in the UI: this spends a small
 * amount of the quota it measures. Anthropic needs no such thing (its endpoint
 * is live) and Antigravity would gain nothing (it writes no quota down), so
 * this is a Codex switch however generally it is worded.
 */
const KEY = "agentglass.usageRefresh";

/** Fifteen minutes. Below this a page reload is a reload, not a reason to
 *  spend a request — and reloading is a habit, not an event. */
const FLOOR_MS = 15 * 60_000;

export function usageRefreshOn(): boolean {
  try { return localStorage.getItem(KEY) === "1"; } catch { return false; }
}

const listeners = new Set<() => void>();

export function setUsageRefreshOn(on: boolean): void {
  try { localStorage.setItem(KEY, on ? "1" : "0"); } catch { /* private mode */ }
  for (const fn of listeners) fn();
}

export function subscribeUsageRefresh(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** Whether a reading of this age is worth spending a request on. */
export function shouldRefresh(observedAt: number | undefined, now = Date.now()): boolean {
  if (!observedAt) return true;
  return now - observedAt >= FLOOR_MS;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd web && bun test test/usage-refresh.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Add the api method**

In `web/src/lib/api.ts`, beside `providerUsage`:

```ts
  refreshCodexUsage: () => post<{ ok: boolean; error?: string }>(`/usage/codex/refresh`, {}),
```

And in the demo object:

```ts
  refreshCodexUsage: () => D({ ok: false, error: "not available in the demo" }),
```

- [ ] **Step 6: Fire the trigger from the store**

In `web/src/lib/usageStore.ts`, inside `subscribeProviderUsage`'s `load()`, after the snapshot is set:

```ts
      .then((next) => { snapshot = next; void maybeRefreshCodex(); })
```

And add, with the imports it needs (`usageRefreshOn`, `shouldRefresh` from `./usageRefreshPref.ts`):

```ts
/** The hourly cadence the setting promises. The 5-minute poll is what notices
 *  the moment has come, so no second timer is needed — and the floor in
 *  shouldRefresh() is what makes a page reload cheap. */
const REFRESH_EVERY_MS = 60 * 60_000;
let lastPing = 0;

/**
 * Run the Codex refresh when the setting is on and the reading has gone stale.
 *
 * Deliberately driven by the poll rather than by its own interval: the poll is
 * already the thing that knows how old the reading is, and a second timer would
 * be a second source of truth about when to spend money.
 */
async function maybeRefreshCodex(): Promise<void> {
  if (!usageRefreshOn()) return;
  const codex = usageOf("codex");
  if (!shouldRefresh(codex?.observedAt)) return;
  const now = Date.now();
  if (now - lastPing < REFRESH_EVERY_MS) return;
  lastPing = now;
  try {
    const r = await api.refreshCodexUsage();
    if (r.ok) snapshot = await api.providerUsage();
  } catch { /* the reading simply stays as old as it was */ }
  for (const l of listeners) l();
}
```

Reset `lastPing` in `__resetUsageStore()`.

- [ ] **Step 7: Add the Settings toggle**

In `SettingsModal.tsx`, add the import:

```tsx
import { usageRefreshOn, setUsageRefreshOn } from "../lib/usageRefreshPref.ts";
```

Add state beside the other prefs state (near line 832):

```tsx
  const [usageRefresh, setUsageRefreshState] = useState<boolean>(() => usageRefreshOn());
```

And the row in the prefs pane, beside the other `Toggle`s (near line 974):

```tsx
                    {/* Says what it costs, because it costs something: this
                        spends a little of the quota it is measuring. */}
                    <Toggle on={usageRefresh}
                      onClick={() => { setUsageRefreshOn(!usageRefresh); setUsageRefreshState(!usageRefresh); }}
                      label="Keep Codex usage current"
                      hint="Runs a minimal Codex turn hourly so the quota reading is not stale — uses a small amount of the quota it measures" />
```

- [ ] **Step 8: Typecheck, test, commit**

```bash
cd /home/yoshi/git/agentglass-working && make typecheck
cd web && bun test test/usage-refresh.test.ts test/usage-store.test.ts test/provider-context.test.ts
```

```bash
git add web/src/lib/usageRefreshPref.ts web/src/lib/usageStore.ts web/src/lib/api.ts web/src/components/SettingsModal.tsx web/test/usage-refresh.test.ts
git commit -m "Offer to keep the Codex reading current, and say what it costs"
```

---

### Task 10: Full verification

**Files:** none — this task only runs what exists.

- [ ] **Step 1: The whole server suite**

Run: `cd /home/yoshi/git/agentglass-working && make test`
Expected: PASS. Anything failing that this plan did not touch should be reported, not fixed silently.

- [ ] **Step 2: The whole web suite**

Run: `cd /home/yoshi/git/agentglass-working/web && bun test`
Expected: PASS.

- [ ] **Step 3: Typecheck both halves**

Run: `cd /home/yoshi/git/agentglass-working && make typecheck`
Expected: clean.

- [ ] **Step 4: The production bundle in a real browser**

Run: `cd /home/yoshi/git/agentglass-working && make smoke`
Expected: PASS — this fails on a blank screen or any console error, which is the check that catches a grid change that renders but throws.

- [ ] **Step 5: Report**

State plainly what passed, what did not, and anything left undone. Do not claim completion on an unrun suite.
