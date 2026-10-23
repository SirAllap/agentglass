/*
 * The chair's engine, through the routes a person and a seat actually call:
 * a booted server with fake engines first on PATH (fixtures/workerHarness.ts).
 * What is asserted is what the engine was started with, the row, and who was
 * turned away — the sentence a refused engine gets is the one the page shows.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SERVER_BOOT_MS } from "./serverBoot.ts";
import { MACHINE, startHarness, type Harness } from "./fixtures/workerHarness.ts";

const have = !!Bun.which("tmux") && !!Bun.which("python3");
let h: Harness;
beforeAll(async () => { if (have) h = await startHarness("s9route"); }, SERVER_BOOT_MS);
afterAll(async () => { if (have) await h.stop(); });

const tuiArgv = () => readdirSync(h.logs).filter((n) => n.startsWith("tui-opencode-") && n.endsWith(".argv"))
  .map((n) => readFileSync(join(h.logs, n), "utf8").split("\0").slice(0, -1));

describe.skipIf(!have)("the engine in the chair, by the routes", () => {
  test("open and orchestrate refuse an engine with no captured screen, in a sentence, and start nothing", async () => {
    for (const verb of ["open", "orchestrate"]) {
      const r = await h.asPerson(`/seat/${verb}`, { root: h.dir, kind: "codex" });
      expect(r.status).toBe(400);
      expect(r.error).toBe("Codex cannot take the chair yet: agentglass has not captured its screen, so it could not tell when it is ready to be woken.");
    }
    const hermes = await h.asPerson("/seat/open", { root: h.dir, kind: "hermes" });
    expect(hermes.error).toBe("Hermes cannot take the chair yet: it does not open in a terminal tab.");
    expect(tuiArgv()).toEqual([]);
  });

  test("settings take an engine, refuse one that cannot sit, and a new engine does not inherit the old one's model", async () => {
    expect((await h.asPerson("/seat/settings", { root: h.dir, model: "claude-sonnet-5-5" })).ok).toBe(true);
    const no = await h.asPerson("/seat/settings", { root: h.dir, kind: "codex" });
    expect(no.status).toBe(400);
    expect(no.error).toContain("Codex cannot take the chair yet");
    const ok = await h.asPerson("/seat/settings", { root: h.dir, kind: "opencode" });
    expect(ok.ok).toBe(true);
    expect((ok as any).seat).toMatchObject({ kind: "opencode", model: "" });
    expect((await h.asPerson("/seat/settings", { root: h.dir, kind: "claude", model: "claude-sonnet-5-5" }) as any).seat).toMatchObject({ kind: "claude", model: "claude-sonnet-5-5" });
  });

  test("a seat cannot change its own engine or powers through settings; a person still can", async () => {
    const before = (await h.asPerson("/seat/settings", { root: h.dir })) as any;
    for (const body of [{ kind: "opencode" }, { powers: "assign" }, { model: "x" }, {}]) {
      const r = await h.asSeat("/seat/settings", { root: h.dir, ...body });
      expect(r.status).toBe(403);
      /* Turned away at the auth wall today, and by the route's own check if
         that list ever lets /seat/settings through; either way the row stays. */
      expect(r.error).toMatch(/^(only a person changes the chair|the orchestrator's seat may not POST \/seat\/settings)/);
    }
    const after = (await h.asPerson("/seat/settings", { root: h.dir })) as any;
    expect(after.seat.kind).toBe(before.seat.kind);
    expect(after.seat.powers).toBe(before.seat.powers);
  });

  test("adopting a session leaves the chair a Claude one, whatever kind the row held before, and a later setting does not turn it into another engine", async () => {
    await h.asPerson("/seat/close", { root: h.dir });
    await h.asPerson("/seat/settings", { root: h.dir, kind: "opencode" });
    const pane = await h.handTab(h.dir);
    const r = await h.asPerson("/seat/adopt", { root: h.dir, session: "s-adopted", pane, powers: "speak" });
    expect(r.ok).toBe(true);
    expect((r as any).seat.kind).toBe("claude");
    /* A setting made while a session sits is the next seating's, so the
       occupant is still read as what it is. */
    await h.asPerson("/seat/settings", { root: h.dir, kind: "opencode" });
    const board = await (await fetch(`${h.base}/agents/board`, { headers: { Authorization: `Bearer ${MACHINE}` } })).json() as { chairs?: { root: string; kind: string }[] };
    expect(board.chairs?.find((c) => c.root === h.dir)?.kind).toBe("claude");
    await h.asPerson("/seat/close", { root: h.dir });
  });

  test("asking for another engine while one sits is refused, not answered as already", async () => {
    await h.asPerson("/seat/close", { root: h.dir });
    expect((await h.asPerson("/seat/open", { root: h.dir, kind: "claude", powers: "speak" })).ok).toBe(true);
    const r = await h.asPerson("/seat/open", { root: h.dir, kind: "opencode" });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("already sits in this chair");
    expect((await h.asPerson("/seat/open", { root: h.dir, kind: "claude" }) as any).already).toBe(true);
    await h.asPerson("/seat/close", { root: h.dir });
  }, 30_000);

  test("a chair of OpenCode starts on its own model flag with the engine's default, holds a seat token, and is the row's kind", async () => {
    /* The harness already holds a chair: empty it, then sit the other engine. */
    await h.asPerson("/seat/close", { root: h.dir });
    await h.asPerson("/seat/settings", { root: h.dir, kind: "opencode", model: "" });
    const r = await h.asPerson("/seat/orchestrate", { root: h.dir, kind: "opencode", powers: "speak" });
    expect(r.ok).toBe(true);
    expect((r as any).seat).toMatchObject({ kind: "opencode", model: "opencode/big-pickle", powers: "speak" });
    const argv = await (async () => { for (let i = 0; i < 60; i++) { const a = tuiArgv(); if (a.length) return a[0]!; await Bun.sleep(100); } return []; })();
    expect(argv[argv.indexOf("--model") + 1]).toBe("opencode/big-pickle");
    expect(argv).toContain("--prompt");
    /* Its own credential, as Claude's chair has: powers is a wall, not a sentence. */
    expect(readFileSync(join(h.logs, "seat-opencode.token"), "utf8").length).toBeGreaterThan(10);
    /* No gate hook on this engine, so it runs under the lock its workers do:
       a chair that cannot push, open a pull request or spend. */
    for (let i = 0; i < 60 && !existsSync(join(h.logs, "seat-opencode.lock")); i++) await Bun.sleep(100);
    const lock = JSON.parse(readFileSync(join(h.logs, "seat-opencode.lock"), "utf8")) as { permission: { bash: Record<string, string> } };
    for (const c of ["git push", "git merge", "gh", "curl", "docker", "sudo"]) expect(lock.permission.bash[c]).toBe("deny");
    expect((await h.asPerson("/seat/close", { root: h.dir })).ok).toBe(true);
  }, 40_000);
});
