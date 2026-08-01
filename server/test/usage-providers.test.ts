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
