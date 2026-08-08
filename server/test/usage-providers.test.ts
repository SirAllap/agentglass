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
import { anthropicUsage, installedProviders, allProviderUsage } from "../src/providerusage.ts";
import type { AgentProbe } from "../../shared/types.ts";
import type { UsagePayload } from "../src/usage.ts";
import { TMUX_TEST_TMPDIR } from "./tmuxTmp.ts";

let dir: string, base: string, proc: ReturnType<typeof Bun.spawn> | null = null;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "agx-usage-providers-"));
  const port = 4930 + Math.floor(Math.random() * 20);
  base = `http://127.0.0.1:${port}`;
  proc = Bun.spawn(["bun", "run", new URL("../src/index.ts", import.meta.url).pathname], {
    env: {
      PATH: process.env.PATH ?? "",
      // The server sweeps tmux window sizes at boot; without this it sweeps the
      // developer's own socket directory. See tmuxTmp.ts.
      TMUX_TMPDIR: TMUX_TEST_TMPDIR,
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

/*
 * These run against a real server whose HOME is a temp dir, so WHICH agents are
 * connected depends on the machine — `agy` on the PATH makes Antigravity
 * connected, an absent one does not. So nothing here asserts a specific roster;
 * that contract is pinned deterministically in the injected-probe tests below.
 * What these check is what must hold for whatever rows do come back.
 */
const ORDER = ["anthropic", "codex", "antigravity"];

describe("/usage/providers", () => {
  test("returns known providers, in the fixed order, without repeats", async () => {
    const got = (await providers()).map((p) => p.provider);
    for (const p of got) expect(ORDER).toContain(p);
    expect(new Set(got).size).toBe(got.length);
    // A filter preserves order, so the result is a subsequence of ORDER — a row
    // that moves because a number changed is a row nobody can find twice.
    expect(got).toEqual(ORDER.filter((p) => got.includes(p)));
  });

  test("every provider carries a human label", async () => {
    for (const p of await providers()) expect(p.label.length).toBeGreaterThan(0);
  });

  test("a provider with nothing to say still says why", async () => {
    for (const p of await providers()) {
      if (!p.available) {
        const note = p.note ?? "";
        expect(note.length).toBeGreaterThan(10);
        expect(note).toMatch(/\./);
      }
    }
  });

  test("no filesystem path is in the answer", async () => {
    expect(JSON.stringify(await providers())).not.toContain(dir);
  });
});

describe("anthropicUsage() — pure conversion", () => {
  test("both windows present maps to two QuotaWindow objects with correct labels", () => {
    const payload: UsagePayload = {
      available: true,
      five_hour: { utilization: 25, remaining: 75, resets_at: "2026-07-31T12:00:00Z" },
      seven_day: { utilization: 50, remaining: 50, resets_at: "2026-08-07T00:00:00Z" },
      fetched_at: 1722470400000,
    };
    const result = anthropicUsage(payload);
    expect(result.available).toBe(true);
    expect(result.windows.length).toBe(2);
    expect(result.windows[0].label).toBe("5h");
    expect(result.windows[0].minutes).toBe(300);
    expect(result.windows[0].usedPercent).toBe(25);
    expect(result.windows[1].label).toBe("weekly");
    expect(result.windows[1].minutes).toBe(10080);
    expect(result.windows[1].usedPercent).toBe(50);
    expect(result.observedAt).toBe(1722470400000);
  });

  test("only five_hour present returns one window", () => {
    const payload: UsagePayload = {
      available: true,
      five_hour: { utilization: 33, remaining: 67, resets_at: "2026-07-31T12:00:00Z" },
      fetched_at: 1722470400000,
    };
    const result = anthropicUsage(payload);
    expect(result.available).toBe(true);
    expect(result.windows.length).toBe(1);
    expect(result.windows[0].label).toBe("5h");
    expect(result.windows[0].usedPercent).toBe(33);
  });

  test("available: true but neither window parsed returns unavailable with explanation", () => {
    const payload: UsagePayload = {
      available: true,
      fetched_at: 1722470400000,
    };
    const result = anthropicUsage(payload);
    expect(result.available).toBe(false);
    expect(result.windows.length).toBe(0);
    expect(result.note).toBeDefined();
    expect((result.note ?? "").length).toBeGreaterThan(10);
    expect(result.note).toMatch(/\./);
  });

  test("no credentials returns unavailable with a sign-in note", () => {
    const payload: UsagePayload = {
      available: false,
      fetched_at: 1722470400000,
      error: "no credentials",
    };
    const result = anthropicUsage(payload);
    expect(result.available).toBe(false);
    expect(result.windows.length).toBe(0);
    expect(result.note).toBeDefined();
    expect(result.note).toContain("sign in");
  });

  test("a 429 does not tell a signed-in user to sign in", () => {
    const payload: UsagePayload = {
      available: false,
      fetched_at: 1722470400000,
      error: "Error: HTTP 429",
    };
    const result = anthropicUsage(payload);
    expect(result.available).toBe(false);
    expect(result.note).toBeDefined();
    expect(result.note).not.toContain("sign in");
    expect(result.note).toMatch(/rate.?limit/i);
    expect(result.note).toMatch(/retry|retrying/i);
  });

  test("a network/timeout failure says the endpoint could not be reached, not sign in", () => {
    const payload: UsagePayload = {
      available: false,
      fetched_at: 1722470400000,
      error: "TypeError: fetch failed",
    };
    const result = anthropicUsage(payload);
    expect(result.available).toBe(false);
    expect(result.note).toBeDefined();
    expect(result.note).not.toContain("sign in");
    expect(result.note).not.toMatch(/rate.?limit/i);
    expect(result.note).toMatch(/could not reach/i);
    // The reason is summarised, not a raw "TypeError:" prefix.
    expect(result.note).not.toContain("TypeError:");
  });

  test("no credentials, a 429, and a network failure produce three different notes", () => {
    const notes = [
      anthropicUsage({ available: false, fetched_at: 0, error: "no credentials" }).note,
      anthropicUsage({ available: false, fetched_at: 0, error: "Error: HTTP 429" }).note,
      anthropicUsage({ available: false, fetched_at: 0, error: "TypeError: fetch failed" }).note,
    ];
    expect(new Set(notes).size).toBe(3);
  });
});

/*
 * A CLI that is not on this machine is not a provider with nothing to say — it
 * is a provider that does not apply here. The two render differently: one gets
 * a row with a sentence, the other gets no row at all.
 *
 * The gate is `found`, not `connected`, and the difference is load-bearing.
 * Connecting an agent wires its EVENTS to this server; quota comes from
 * somewhere else entirely — Codex's session files, Claude's credentials — so a
 * disconnected agent still has a plan that runs out, and still gets a row.
 */
describe("installedProviders()", () => {
  /** Only the fields the filter reads; the rest of AgentProbe is irrelevant here. */
  const probe = (id: string, found: boolean) => ({ id, found }) as unknown as AgentProbe;

  test("maps each roster id to its provider", () => {
    const on = installedProviders([
      probe("claude-code", true), probe("codex", true), probe("antigravity", true),
    ]);
    expect([...on].sort()).toEqual(["anthropic", "antigravity", "codex"]);
  });

  test("drops the ones whose binary is not here", () => {
    const on = installedProviders([
      probe("claude-code", true), probe("codex", false), probe("antigravity", false),
    ]);
    expect([...on]).toEqual(["anthropic"]);
  });

  test("nothing installed is empty, not everything", () => {
    const on = installedProviders([
      probe("claude-code", false), probe("codex", false), probe("antigravity", false),
    ]);
    expect(on.size).toBe(0);
  });

  test("an installed but DISCONNECTED agent still counts", () => {
    // The distinction this filter deliberately does not make. Quota does not
    // travel over the event wiring, so unwiring it must not hide the number.
    const on = installedProviders([
      { id: "codex", found: true, connected: false } as unknown as AgentProbe,
    ]);
    expect([...on]).toEqual(["codex"]);
  });

  test("the Gemini CLI maps to no provider — it reports no plan window", () => {
    expect(installedProviders([probe("gemini", true)]).size).toBe(0);
  });
});

describe("allProviderUsage() with injected probes", () => {
  const probe = (id: string, found: boolean) => ({ id, found }) as unknown as AgentProbe;

  test("returns only the installed agents' rows, in the fixed order", async () => {
    const rows = await allProviderUsage([
      probe("claude-code", false), probe("codex", false), probe("antigravity", true),
    ]);
    expect(rows.map((r) => r.provider)).toEqual(["antigravity"]);
  });

  test("nothing installed yields an empty list, and never a partial row", async () => {
    const rows = await allProviderUsage([
      probe("claude-code", false), probe("codex", false), probe("antigravity", false),
    ]);
    expect(rows).toEqual([]);
  });

  test("an installed Antigravity is a labelled gap, not an absence", async () => {
    // Deterministic here in a way the route test cannot be: the probe is
    // injected, so this holds on a machine with no `agy` installed too.
    const [agy] = await allProviderUsage([probe("antigravity", true)]);
    expect(agy!.available).toBe(false);
    expect(agy!.windows).toEqual([]);
    // A sentence, because it is rendered to a person.
    expect((agy!.note ?? "").length).toBeGreaterThan(10);
    expect(agy!.note).toMatch(/\./);
  });
});
