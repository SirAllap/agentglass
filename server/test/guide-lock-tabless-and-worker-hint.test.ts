/*
 * Three refusal sentences an agent met on 2026-11-13, each one wrong:
 *
 * 1. A guide on ONE tab refused `vault --list` (the `lane` op), which uses no
 *    tab at all. The lock is about acts on the guided tab.
 * 2. The same refusal named an empty owner: "It is 's guide".
 * 3. A worker reaching for the person's container was told to run
 *    `--shared open`, which is exactly the call its credential is refused.
 *
 * Fakes only: a stand-in panel for the relay, and the real CLI in an empty
 * state dir pointed at a closed port.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { __setBrowserAsker, askBrowser, parseAsk, resetBrowserDrive, WORKER_PERSON_TAB_HINT, type BrowserAsk, type BrowserReply } from "../src/browserdrive.ts";
import { setGuideClock } from "../src/browserGuide.ts";

let seen: BrowserAsk[] = [];

beforeEach(() => {
  resetBrowserDrive();
  seen = [];
  const now = Date.parse("2026-11-13T15:02:00");
  setGuideClock(() => now);
  __setBrowserAsker(async (a) => {
    seen.push(a);
    if (a.op === "tabs") return { ok: true, value: [{ id: "t1", active: true }] };
    return { ok: true, value: {} };
  });
});
afterEach(() => { __setBrowserAsker(null); setGuideClock(null); resetBrowserDrive(); });

async function ask(op: string, body: Record<string, unknown>): Promise<BrowserReply> {
  const p = parseAsk(op, body);
  if ("error" in p) return { ok: false, error: p.error };
  return askBrowser(p.ask);
}

/* The person's own guide: no name, as the MCP surface and the panel send it. */
const personGuide = () => ask("guide", { action: "start", why: "Rotate the orbit-ci key", page: "t1" });

describe("the guide lock and verbs that use no tab", () => {
  test("`vault --list` (the lane op) is not refused by a guide on another tab", async () => {
    expect((await personGuide()).ok).toBe(true);
    const r = await ask("lane", { action: "vaults", as: "orbit-worker" });
    expect(String(r.error ?? "")).not.toContain("guide mode");
  });

  test("an act on the guided tab itself is still refused", async () => {
    expect((await personGuide()).ok).toBe(true);
    const r = await ask("click", { selector: "#go", as: "orbit-worker", page: "t1" });
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("guide mode");
  });
});

describe("the guide's owner in a refusal", () => {
  test("a nameless guide is the person's, never an empty name", async () => {
    expect((await personGuide()).ok).toBe(true);
    const act = String((await ask("click", { selector: "#go", as: "orbit-worker", page: "t1" })).error);
    expect(act).toContain("It is the person's guide.");
    expect(act).not.toContain(" 's guide");
    const other = String((await ask("point", { selector: "#go", say: "here", as: "orbit-worker", page: "t1" })).error);
    expect(other).toContain("guided by the person");
    expect(other).not.toMatch(/by\s+\(|Only\s+may/);
  });

  test("a named guide names whoever started it", async () => {
    expect((await ask("guide", { action: "start", why: "Rotate", as: "orbit-keys", page: "t1" })).ok).toBe(true);
    const act = String((await ask("click", { selector: "#go", as: "orbit-worker", page: "t1" })).error);
    expect(act).toContain("It is orbit-keys's guide.");
  });
});

describe("a worker reaching for the person's tab", () => {
  test("the relay's hint never points at --shared", () => {
    expect(WORKER_PERSON_TAB_HINT).toContain("out of reach for a worker by design");
    expect(WORKER_PERSON_TAB_HINT).toContain("orchestrator (seat)");
    expect(WORKER_PERSON_TAB_HINT).toContain("--as <name>");
    expect(WORKER_PERSON_TAB_HINT).not.toContain("--shared");
  });

  const HAVE_PY = !!Bun.which("python3");
  const CLI = new URL("../../bin/agentglass-browser", import.meta.url).pathname;
  test.skipIf(!HAVE_PY)("the CLI's no-tab sentence does not tell a worker to run `--shared open`", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agx-guidelock-"));
    try {
      const p = Bun.spawn({
        cmd: ["python3", CLI, "--shared", "read"],
        env: {
          PATH: process.env.PATH ?? "", HOME: dir,
          AGENTGLASS_BROWSER_STATE_DIR: join(dir, "s"),
          AGENTGLASS_TOKEN: "wk_fake", AGENTGLASS_URL: "http://127.0.0.1:9",
        },
        stdout: "pipe", stderr: "pipe",
      });
      const err = await new Response(p.stderr).text();
      expect(await p.exited).not.toBe(0);
      expect(err).toContain("out of reach for a worker by design");
      expect(err).not.toContain("--shared open");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
