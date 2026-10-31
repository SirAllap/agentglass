/*
 * Starting workers through the policy, end to end: a booted server with the
 * fake engines first on PATH, its own tmux, and a real seat whose token is the
 * one a chair would hold (fixtures/workerHarness.ts). What is asserted is what
 * happened: the argv and environment the fake engine saw, the row, the
 * Activity log, and who was turned away.
 *
 * Every test sets up what it asserts on, under its own worker names, so the
 * file passes in any order (`bun test --seed N`). The engines are fakes; a
 * test that cannot get what it needs fails instead of starting something else.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { Database } from "bun:sqlite";
import { SERVER_BOOT_MS } from "./serverBoot.ts";
import { DENIED_COMMANDS } from "../../shared/workerRoles.ts";
import { MACHINE, nights, startHarness, type Harness } from "./fixtures/workerHarness.ts";

const have = !!Bun.which("tmux") && !!Bun.which("python3");
const OTHER = "/home/a/code/orbit-other";
let h: Harness;
let n = 0;
const nm = (p: string) => `${p}-${++n}`;
const outsiders: string[] = [];

beforeAll(async () => { if (have) h = await startHarness("wstart"); }, SERVER_BOOT_MS);
afterEach(() => { if (have) h.slow(false); });
afterAll(async () => {
  if (!have) return;
  await h.stop();
  for (const d of outsiders) rmSync(d, { recursive: true, force: true });
});

/** The builder goes to OpenCode: the one policy most tests start from. */
const withNights = async (o: { limits?: { maxWorkers?: number }; ceiling?: { network?: boolean; commit?: boolean }; chain?: { engine: string; model: string }[] } = {}) => {
  await h.usePolicy({ rules: [nights(o.chain)], limits: o.limits, ceiling: o.ceiling });
  await h.ruleOn(true);
};
const startBuilder = (name: string, extra: Record<string, unknown> = {}) =>
  h.asSeat("/agents/named/start", { name, cwd: h.wt, role: "builder", ...extra });
/** A row as another seat's worker, or nobody's: pane ids that are not there. */
const outside = () => { const d = mkdtempSync(join(tmpdir(), "agx-outside-")); outsiders.push(d); return d; };
/** The server holds this file too: a side connection waits for its lock instead of failing on the first busy answer (GitHub's runner lost this race). */
const side = () => { const d = new Database(join(h.dir, "w.db")); d.run("PRAGMA busy_timeout = 5000"); return d; };
const sql = (q: string, args: (string | number | null)[]) => { const d = side(); d.run(q, args); d.close(); };
const seed = (name: string, seatRoot: string | null, ended = false) => {
  const d = side();
  d.run("INSERT OR REPLACE INTO named_agent (name, kind, cwd, pane_id, window_id, started_at, ended_at, seat_root) VALUES (?, 'opencode', ?, '%9999', '@9999', ?, ?, ?)",
    [name, h.wt, Date.now(), ended ? Date.now() : null, seatRoot]);
  d.close();
};

describe.skipIf(!have)("a seat starting workers through the policy", () => {
  test("a rule that is on sends the builder to OpenCode, headless, inside its envelope, owned and stamped", async () => {
    await withNights();
    const name = nm("w-oc");
    const r = await startBuilder(name, { prompt: "-m evil: say done" });
    expect(r.ok).toBe(true);
    expect(r.result).toMatchObject({ engine: "opencode", model: "opencode/big-pickle", envelope: { write: "worktree", network: false, commit: false } });
    expect(r.result?.because.join(" ")).toContain("Nights");

    const done = await h.exited(name);
    const call = h.callsOf("opencode").at(-1)!;
    expect(call.argv.slice(0, 4)).toEqual(["run", "--format", "json", "--model"]);
    expect(call.argv[4]).toBe("opencode/big-pickle");
    expect(call.argv.slice(-2)).toEqual(["--", "-m evil: say done"]);
    expect(call.argv).not.toContain("--auto");
    const cfg = JSON.parse(call.env.OPENCODE_CONFIG_CONTENT!) as { permission: { bash: Record<string, string>; webfetch: string } };
    expect(cfg.permission.bash["git push"]).toBe("deny");
    expect(cfg.permission.bash["agentglass-agent"]).toBe("deny");
    expect(cfg.permission.webfetch).toBe("deny");
    // The wrapper dropped this app's credentials from the engine's environment.
    expect(call.env.AGENTGLASS_TOKEN).toBeUndefined();
    expect(call.env.AGENTGLASS_SEAT).toBeUndefined();

    expect(done).toMatchObject({ seatRoot: h.dir, model: "opencode/big-pickle", exitCode: 0 });
    expect(done.exitLine).toBe("note: free model, rate may vary");
    expect(done.startedBy).toMatchObject({ rule: "Nights", role: "builder", engine: "opencode", headless: true });
  }, 40_000);

  test("--allow commit within the ceiling lifts git commit and nothing else; --allow network beyond it starts nothing", async () => {
    await withNights();
    const before = (await h.listed()).length;
    const no = await startBuilder(nm("w-net"), { allow: ["network"] });
    expect(no.status).toBe(400);
    expect(no.error).toContain("beyond this project's ceiling");
    expect((await h.listed()).length).toBe(before);

    const name = nm("w-commit");
    expect((await startBuilder(name, { allow: ["commit"] })).ok).toBe(true);
    await h.exited(name);
    const cfg = JSON.parse(h.callsOf("opencode").at(-1)!.env.OPENCODE_CONFIG_CONTENT!) as { permission: { bash: Record<string, string> } };
    expect(cfg.permission.bash["git commit"]).toBeUndefined();
    for (const c of DENIED_COMMANDS.filter((x) => x !== "git commit")) expect(cfg.permission.bash[c]).toBe("deny");
  }, 40_000);

  test("an engine outside the chain, a chain that ran out, and Hermes below its minimum are refused with sentences", async () => {
    await withNights();
    expect((await startBuilder(nm("w-x"), { engine: "codex" })).error).toContain("codex is not in the chain");

    await withNights({ chain: [{ engine: "hermes", model: "" }] });
    const old = await startBuilder(nm("w-h"), { engine: "hermes" });
    expect(old.error).toContain("older than 0.21.4");
    const ran = await startBuilder(nm("w-h2"));
    expect(ran.error).toContain("no worker can start");
    // The seat is told through its needs, which is how the person hears it.
    const needs = await (await fetch(`${h.base}/seat/needs?root=${encodeURIComponent(h.dir)}`, { headers: { Authorization: `Bearer ${MACHINE}` } })).text();
    expect(needs).toContain("older than 0.21.4");
  }, 30_000);

  test("too many workers for the seat is refused while one is still running, and a start arriving together cannot slip past", async () => {
    await withNights({ limits: { maxWorkers: 1 } });
    h.slow(true);
    const first = nm("w-slow");
    expect((await startBuilder(first)).ok).toBe(true);
    const second = nm("w-slow");
    const r = await startBuilder(second);
    expect(r.status).toBe(400);
    expect(r.error).toContain("limit is 1");
    expect(await h.row(second)).toBeUndefined();
    // Mid-turn it takes no new instruction: a headless worker is stopped, not steered.
    const mid = await h.asSeat("/agents/named/prompt", { name: first, text: "also do this" });
    expect(mid.status).toBe(409);
    expect(mid.error).toContain("still on its turn");
    // Stopped mid-turn, it has no finished turn to continue.
    await h.asSeat("/agents/named/stop", { name: first });
    const stopped = await h.asSeat("/agents/named/prompt", { name: first, text: "and then?" });
    expect(stopped.status).toBe(409);
    expect(stopped.error).toContain("was stopped before its turn ended");

    const [a, b] = [nm("w-race"), nm("w-race")];
    const both = await Promise.all([startBuilder(a), startBuilder(b)]);
    expect(both.filter((x) => x.ok)).toHaveLength(1);
    for (const x of [a, b]) await h.asSeat("/agents/named/stop", { name: x });
  }, 40_000);

  test("a duplicate start answers 'still running' and leaves the running worker's result files alone", async () => {
    await withNights();
    h.slow(true);
    const name = nm("w-dup");
    expect((await startBuilder(name)).ok).toBe(true);
    const input = join(h.state, "worker-runs", name, "in");
    const before = statSync(input).ino;
    const again = await startBuilder(name);
    expect(again.status).toBe(409);
    expect(again.error).toContain("still running");
    expect(statSync(input).ino).toBe(before);
    await h.asSeat("/agents/named/stop", { name });
  }, 30_000);

  test("arguments the policy start cannot honour are refused, never dropped", async () => {
    await withNights();
    const names = [nm("d"), nm("d"), nm("d"), nm("d")];
    expect((await startBuilder(names[0]!, { args: ["--model", "x"] })).error).toContain("args cannot ride along");
    expect((await startBuilder(names[1]!, { kind: "hermes" })).error).toContain("--engine");
    expect((await startBuilder(names[2]!, { yolo: true })).error).toContain("skipping permissions");
    expect((await startBuilder(names[3]!, { remoteControl: "x" })).error).toContain("remote-control");
    for (const x of names) expect(await h.row(x)).toBeUndefined();
  });

  test("a seat starts workers with a role: without one the policy would be advice", async () => {
    await withNights();
    for (const body of [{ kind: "claude" }, { kind: "opencode" }, { kind: "claude", yolo: true }, {}]) {
      const name = nm("norole");
      const r = await h.asSeat("/agents/named/start", { name, cwd: h.wt, ...body });
      expect(r.status).toBe(400);
      expect(r.error).toContain("--role");
      expect(await h.row(name)).toBeUndefined();
    }
    // The person's own call is another matter and is unchanged.
    const mine = nm("person");
    expect((await h.asPerson("/agents/named/start", { name: mine, cwd: h.wt, kind: "claude", yolo: true, keep: true })).ok).toBe(true);
    await h.asPerson("/agents/named/stop", { name: mine });
  }, 30_000);

  test("a seat's worker lives in its own project: another directory, and a link out of it, are refused", async () => {
    await withNights();
    const outside = mkdtempSync(join(tmpdir(), "agx-outside-"));
    outsiders.push(outside);
    mkdirSync(join(h.wt, "sub"), { recursive: true });
    const link = join(h.wt, `link-${n}`);
    symlinkSync(outside, link);
    for (const cwd of [outside, link, join(h.wt, "..", "..")]) {
      const name = nm("w-out");
      const r = await h.asSeat("/agents/named/start", { name, cwd, role: "builder" });
      expect(r.status).toBe(400);
      expect(r.error).toContain(`${basename(h.dir)}'s own tree`);
      expect(await h.row(name)).toBeUndefined();
    }
    const inside = nm("w-in");
    expect((await h.asSeat("/agents/named/start", { name: inside, cwd: join(h.wt, "sub"), role: "builder" })).ok).toBe(true);
    await h.asSeat("/agents/named/stop", { name: inside });
  }, 30_000);

  test("prompt on a finished worker is a resumed turn on the engine it was stamped with, even after the rule turned off", async () => {
    await withNights();
    const name = nm("w-resume");
    expect((await startBuilder(name)).ok).toBe(true);
    await h.exited(name);
    await h.usePolicy({ rules: [nights(undefined, false)] });
    await h.ruleOn(false);
    const calls = h.callsOf("opencode").length;
    const r = await h.asSeat("/agents/named/prompt", { name, text: "now the second part" });
    expect(r.ok).toBe(true);
    expect(r.result?.resumed).toBe("ses_fake0001");
    // A resumed turn is a new process under the same lock, and says so like a start.
    expect(r.result?.partly).toContain("list of patterns");
    await h.until(async () => h.callsOf("opencode").length > calls);
    const argv = h.callsOf("opencode").at(-1)!.argv;
    expect(argv.slice(argv.indexOf("-s"), argv.indexOf("-s") + 2)).toEqual(["-s", "ses_fake0001"]);
    expect(argv.at(-1)).toBe("now the second part");
    expect(argv[argv.indexOf("--model") + 1]).toBe("opencode/big-pickle");
  }, 40_000);

  test("a resumed turn does not outlive the ceiling: narrowed since, it is refused", async () => {
    await withNights({ ceiling: { commit: true } });
    const name = nm("w-wide");
    expect((await startBuilder(name, { allow: ["commit"] })).ok).toBe(true);
    await h.exited(name);
    await withNights({ ceiling: { commit: false } });
    const r = await h.asSeat("/agents/named/prompt", { name, text: "go on" });
    expect(r.status).toBe(400);
    expect(r.error).toContain("ceiling");
  }, 40_000);

  test("two prompts arriving together on a finished worker start one turn, not two", async () => {
    await withNights();
    const name = nm("w-twice");
    expect((await startBuilder(name)).ok).toBe(true);
    await h.exited(name);
    h.slow(true);
    const both = await Promise.all([1, 2].map((i) => h.asSeat("/agents/named/prompt", { name, text: `part ${i}` })));
    expect(both.filter((r) => r.ok)).toHaveLength(1);
    expect(both.find((r) => !r.ok)?.error).toContain("still on its turn");
    await h.asSeat("/agents/named/stop", { name });
  }, 40_000);
});

describe.skipIf(!have)("who may reach an agent, and who may start one", () => {
  test("a second seat's token cannot prompt, read, key or stop a worker, and the refusal names the owner", async () => {
    const name = nm("theirs");
    seed(name, OTHER);
    for (const [verb, body] of [["prompt", { text: "hello" }], ["read", {}], ["keys", { key: "enter" }], ["stop", {}]] as const) {
      const r = await h.asSeat(`/agents/named/${verb}`, { name, ...body });
      expect(r.status).toBe(403);
      expect(r.error).toContain("belongs to the seat of orbit-other");
      expect(r.error).toContain(`not to yours (${basename(h.dir)})`);
    }
    // The person, with the machine token, is not a seat and still reaches it.
    expect((await h.asPerson("/agents/named/read", { name })).status).not.toBe(403);
    // A broadcast from the seat does not reach it either.
    expect((await h.asSeat("/agents/named/broadcast", { text: "all hands", names: [name] })).result?.asked).toBe(0);
  });

  test("the name of another seat's finished worker is not this seat's to take", async () => {
    const name = nm("done");
    seed(name, OTHER, true);
    await withNights();
    const r = await startBuilder(name);
    expect(r.status).toBe(403);
    expect(r.error).toContain("belongs to the seat of orbit-other");
    expect((await h.row(name))?.seatRoot).toBe(OTHER);
  });

  test("a row with no owner is reachable by no seat until a seat adopts it, and a worker can never adopt", async () => {
    const name = nm("orphan");
    // A live agent the person started: no seat owns it.
    expect((await h.asPerson("/agents/named/start", { name, cwd: h.wt, kind: "claude", yolo: true, keep: true })).ok).toBe(true);
    expect((await h.row(name))?.seatRoot).toBeUndefined();
    for (const [verb, body] of [["prompt", { text: "hello" }], ["read", {}], ["keys", { key: "enter" }], ["stop", {}]] as const) {
      const r = await h.asSeat(`/agents/named/${verb}`, { name, ...body });
      expect(r.status).toBe(403);
      expect(r.error).toContain("has no owner yet; adopt it first");
    }
    expect((await h.asSeat("/agents/named/broadcast", { text: "all hands", names: [name] })).result?.asked).toBe(0);
    // A worker cannot adopt, and neither can the person's own token: only a seat owns.
    await withNights();
    const worker = nm("w-adopt");
    expect((await startBuilder(worker)).ok).toBe(true);
    expect((await h.asSeat("/agents/named/own", { name }, { "X-Agentglass-Agent": worker })).status).toBe(403);
    expect((await h.asPerson("/agents/named/own", { name })).status).toBe(403);
    expect((await h.row(name))?.seatRoot).toBeUndefined();
    // Adopted by the seat, it answers to that seat and to no other.
    expect((await h.asSeat("/agents/named/own", { name })).ok).toBe(true);
    expect((await h.row(name))?.seatRoot).toBe(h.dir);
    expect((await h.asSeat("/agents/named/read", { name })).status).not.toBe(403);
    // Taking one that is another seat's is refused with the owner named.
    const theirs = nm("theirs");
    seed(theirs, OTHER);
    const t = await h.asSeat("/agents/named/own", { name: theirs });
    expect(t.status).toBe(403);
    expect(t.error).toContain("belongs to the seat of orbit-other");
    await h.asSeat("/agents/named/stop", { name });
  }, 40_000);

  test("a finished worker's name pointed at a tab outside the project does not carry its owner or its stamp along, and a resume re-checks the directory", async () => {
    await withNights();
    const name = nm("w-move");
    expect((await startBuilder(name)).ok).toBe(true);
    await h.exited(name);
    const turns = h.callsOf("opencode").length;
    const pane = await h.handTab(outside());
    // The seat cannot enlist a tab that sits outside its project at all.
    const mine = await h.asSeat("/agents/named/enlist", { name, pane });
    expect(mine.ok).toBe(false);
    expect(mine.error).toContain("not inside");
    expect((await h.row(name))?.seatRoot).toBe(h.dir);
    // The person can, and the name then belongs to nobody and is no headless worker.
    expect((await h.asPerson("/agents/named/enlist", { name, pane })).ok).toBe(true);
    const row = await h.row(name);
    expect(row?.seatRoot).toBeUndefined();
    expect(row?.startedBy).toBeUndefined();
    expect(row?.exitCode).toBeUndefined();
    const p = await h.asSeat("/agents/named/prompt", { name, text: "now work here" });
    expect(p.status).toBe(403);
    expect(h.callsOf("opencode")).toHaveLength(turns);
    await h.asPerson("/agents/named/stop", { name });

    // A stamped row whose directory is no longer the project's is not resumed.
    const moved = nm("w-moved");
    expect((await startBuilder(moved)).ok).toBe(true);
    await h.exited(moved);
    const before = h.callsOf("opencode").length;
    sql("UPDATE named_agent SET cwd = ? WHERE name = ?", [outside(), moved]);
    const r = await h.asSeat("/agents/named/prompt", { name: moved, text: "now work here" });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("not inside");
    expect(h.callsOf("opencode")).toHaveLength(before);
  }, 40_000);

  test("another seat's finished worker is not a name this seat can enlist a tab under", async () => {
    const name = nm("done");
    seed(name, OTHER, true);
    const r = await h.asSeat("/agents/named/enlist", { name, pane: await h.handTab(h.wt) });
    expect(r.status).toBe(403);
    expect(r.error).toContain("belongs to the seat of orbit-other");
    expect((await h.row(name))?.seatRoot).toBe(OTHER);
  });

  test("an orchestrator's name is no worker's: a seat starts and enlists nothing under one, whether that chair is down or was never opened", async () => {
    await withNights();
    // A chair that is down: its row has ended, and it never had an owner.
    const down = "orchestrator-orbit-down-4d4d4d";
    sql("INSERT OR REPLACE INTO seat (root, name, powers, started_at, ended_at) VALUES (?, ?, 'assign', 1, 2)", ["/home/a/code/orbit-down", down]);
    seed(down, null, true);
    const s = await startBuilder(down);
    expect(s.status).toBe(403);
    expect(s.error).toContain("is a seat's name");
    expect((await h.row(down))?.endedAt).not.toBeNull();
    sql("DELETE FROM named_agent WHERE name = ?", [down]);
    // A project nobody has seated yet: its name follows from its path.
    const future = "orchestrator-orbit-future-9f9f9f";
    const e = await h.asSeat("/agents/named/enlist", { name: future, pane: await h.handTab(h.wt) });
    expect(e.status).toBe(403);
    expect(e.error).toContain("is a seat's name");
    expect(await h.row(future)).toBeUndefined();
    expect((await startBuilder(future)).status).toBe(403);
    // The person still names what they like.
    expect((await h.asPerson("/agents/named/enlist", { name: future, pane: await h.handTab(h.wt) })).ok).toBe(true);
    expect((await h.asSeat("/agents/named/own", { name: future })).status).toBe(403);
    await h.asPerson("/agents/named/stop", { name: future });
  }, 40_000);

  test("a seat speaks for its own project on every seat verb, whatever root the request names", async () => {
    for (const [verb, body] of [["inbox", {}], ["say", { line: "all quiet" }], ["need", { text: "pick one" }], ["report", { agent: "w-1", text: "blocked on a decision" }]] as const) {
      const r = await h.asSeat(`/seat/${verb}`, { root: OTHER, ...body });
      expect(r.status).toBe(403);
      expect(r.error).toContain("its own project");
    }
    // Its own root, or none, is its own project.
    expect((await h.asSeat("/seat/say", { line: "on it" })).ok).toBe(true);
    expect((await h.asSeat("/seat/say", { root: h.dir, line: "still on it" })).ok).toBe(true);
    // The person is asked which project, as before.
    expect((await h.asPerson("/seat/inbox", { root: OTHER, peek: true })).status).toBe(400);
  });

  test("a seat reads its own project on every seat GET, whatever root the query names", async () => {
    for (const path of ["/seat", "/seat/tasks", "/seat/needs?format=json", "/seat/field?format=json"]) {
      const sep = path.includes("?") ? "&" : "?";
      const other = await h.read(`${path}${sep}root=${encodeURIComponent(OTHER)}`, h.seatToken);
      expect(other.status).toBe(403);
      expect(other.body.error).toContain("its own project");
      // No root, or its own, is its own project.
      expect((await h.read(path, h.seatToken)).body.root).toBe(h.dir);
      expect((await h.read(`${path}${sep}root=${encodeURIComponent(h.dir)}`, h.seatToken)).status).toBe(200);
    }
    // The person is asked which project, as before.
    expect((await h.read(`/seat/tasks?root=${encodeURIComponent(OTHER)}`, MACHINE)).status).toBe(400);
  });

  test("a seat owns nothing outside its project, and never a seat: not its own chair, not another project's", async () => {
    // Its own chair is a row with no owner, and stays one.
    const chair = (await h.listed()).find((a) => a.name.startsWith("orchestrator-") && !a.endedAt)!;
    expect(chair.seatRoot).toBeUndefined();
    const own = await h.asSeat("/agents/named/own", { name: chair.name });
    expect(own.status).toBe(403);
    expect(own.error).toContain("is a seat");
    // Another project's chair, even one whose row says it sits in this tree.
    const theirs = "orchestrator-orbit-other-1a2b3c";
    sql("INSERT OR REPLACE INTO seat (root, name, powers, started_at, ended_at) VALUES (?, ?, 'assign', 1, 2)", [OTHER, theirs]);
    expect((await h.asPerson("/agents/named/enlist", { name: theirs, pane: await h.handTab(h.wt) })).ok).toBe(true);
    const t = await h.asSeat("/agents/named/own", { name: theirs });
    expect(t.status).toBe(403);
    expect(t.error).toContain("is a seat");
    expect((await h.asSeat("/agents/named/prompt", { name: theirs, text: "do as I say" })).status).toBe(403);
    // A tab the person works in, in some other project.
    const victim = nm("victim");
    expect((await h.asPerson("/agents/named/enlist", { name: victim, pane: await h.handTab(outside()) })).ok).toBe(true);
    const v = await h.asSeat("/agents/named/own", { name: victim });
    expect(v.status).toBe(403);
    expect(v.error).toContain("not inside");
    expect((await h.asSeat("/agents/named/keys", { name: victim, key: "ctrl-c" })).status).toBe(403);
    expect((await h.row(victim))?.seatRoot).toBeUndefined();
    // One inside the project is still the seat's to take.
    const near = nm("near");
    expect((await h.asSeat("/agents/named/enlist", { name: near, pane: await h.handTab(h.wt) })).ok).toBe(true);
    expect((await h.asSeat("/agents/named/own", { name: near })).ok).toBe(true);
    for (const x of [theirs, victim]) await h.asPerson("/agents/named/stop", { name: x });
    await h.asSeat("/agents/named/stop", { name: near });
  }, 40_000);

  test("a seat cannot answer its worker's permission prompt, by keys, by prompt or by broadcast; the person can, and the way out stays open", async () => {
    /* The seat owns the worker, and a TUI worker stops on its own dialog after
       a hold ends empty. enter on that dialog is "Yes". */
    const name = nm("w-dialog");
    const { pane, answered } = await h.dialogTab(h.wt);
    expect((await h.asSeat("/agents/named/enlist", { name, pane })).ok).toBe(true);
    expect((await h.asSeat("/agents/named/own", { name })).ok).toBe(true);
    await h.until(async () => (await h.asSeat("/agents/named/read", { name })).result?.state === "needs-you");

    const rows = async () => (await h.actions()).filter((a) => a.action === "/agents/named/keys" && !a.ok).length;
    const before = await rows();
    for (const key of ["enter", "space", "up", "down", "tab", "left", "right", "backspace"]) {
      const r = await h.asSeat("/agents/named/keys", { name, key });
      expect(r.status).toBe(403);
      expect(r.error).toBe("a permission prompt is the person's; ask with agentglass-agent need");
    }
    expect(await rows()).toBe(before + 8);
    const p = await h.asSeat("/agents/named/prompt", { name, text: "1" });
    expect(p.status).toBe(403);
    const bc = await h.asSeat("/agents/named/broadcast", { names: [name], text: "1" });
    expect(bc.ok).toBe(false);
    expect(bc.result?.sent).toEqual([{ name, outcome: expect.stringContaining("refused") }]);
    await Bun.sleep(700);
    expect(answered()).toBe(false);

    // Backing out is not approving, and is still the seat's.
    expect((await h.asSeat("/agents/named/keys", { name, key: "ctrl-c" })).ok).toBe(true);
    expect((await h.asSeat("/agents/named/keys", { name, key: "escape" })).ok).toBe(true);
    // The person's own call is unchanged.
    expect((await h.asPerson("/agents/named/keys", { name, key: "enter" })).ok).toBe(true);
    await h.until(async () => answered());
    await h.asPerson("/agents/named/stop", { name, kill: true });
  }, 40_000);

  test("prompts to finished workers count against the seat's limit, and a start and a prompt on one name make one turn", async () => {
    await withNights({ limits: { maxWorkers: 1 } });
    const [a, b] = [nm("w-again"), nm("w-again")];
    for (const x of [a, b]) { expect((await startBuilder(x)).ok).toBe(true); await h.exited(x); }
    h.slow(true);
    const both = await Promise.all([a, b].map((x) => h.asSeat("/agents/named/prompt", { name: x, text: "once more" })));
    expect(both.filter((x) => x.ok)).toHaveLength(1);
    expect(both.find((x) => !x.ok)?.error).toContain("limit is 1");
    for (const x of [a, b]) await h.asSeat("/agents/named/stop", { name: x });
    h.slow(false);

    await withNights();
    const c = nm("w-both");
    expect((await startBuilder(c)).ok).toBe(true);
    await h.exited(c);
    h.slow(true);
    const pair = await Promise.all([h.asSeat("/agents/named/prompt", { name: c, text: "next" }), startBuilder(c)]);
    expect(pair.filter((x) => x.ok)).toHaveLength(1);
    expect(pair.find((x) => !x.ok)?.status).toBe(409);
    await h.asSeat("/agents/named/stop", { name: c });
  }, 60_000);

  test("the person's start and a seat's prompt on one name take turns too: one turn opens, not two", async () => {
    await withNights();
    const name = nm("w-shared");
    expect((await startBuilder(name)).ok).toBe(true);
    await h.exited(name);
    h.slow(true);
    const pair = await Promise.all([
      h.asSeat("/agents/named/prompt", { name, text: "next" }),
      h.asPerson("/agents/named/start", { name, cwd: h.wt, role: "builder" }),
    ]);
    expect(pair.filter((x) => x.ok)).toHaveLength(1);
    expect(pair.find((x) => !x.ok)?.status).toBe(409);
    await h.asPerson("/agents/named/stop", { name });
  }, 40_000);

  test("a seat's worker opens in the directory that was checked, links followed", async () => {
    await withNights();
    const link = join(h.dir, `link-${++n}`);
    symlinkSync(h.wt, link);
    const name = nm("w-link");
    expect((await startBuilder(name, { cwd: link })).ok).toBe(true);
    expect((await h.row(name))?.cwd).toBe(realpathSync(h.wt));
    await h.asSeat("/agents/named/stop", { name });
  }, 30_000);

  test("a start refused for its directory is in the Activity log like any other refusal", async () => {
    const far = nm("w-far");
    expect((await h.asPerson("/agents/named/start", { name: far, cwd: outside(), kind: "claude" })).status).toBe(400);
    expect((await h.actions()).some((a) => a.action === "/agents/named/start" && !a.ok && /not in the open project/.test(a.detail ?? ""))).toBe(true);
  });

  test("a policy start on Claude Code says its lock is partly enforced", async () => {
    await h.usePolicy({});
    const name = nm("w-cc");
    const r = await startBuilder(name);
    expect(r.ok).toBe(true);
    expect(r.result?.engine).toBe("claude");
    expect(r.result?.partly).toContain("prefix");
    await h.asSeat("/agents/named/stop", { name });
  }, 30_000);

  test("enlist cannot reach a pane another agent already holds, from a seat or from the person", async () => {
    await withNights();
    h.slow(true);
    const worker = nm("w-held");
    expect((await startBuilder(worker)).ok).toBe(true);
    const pane = (await h.row(worker))!.paneId as string;
    for (const who of [h.asSeat, h.asPerson]) {
      const r = await who("/agents/named/enlist", { name: nm("mine"), pane });
      expect(r.ok).toBe(false);
      expect(r.error).toContain(`already agent ${worker}`);
    }
    await h.asSeat("/agents/named/stop", { name: worker });
  }, 30_000);

  test("the seat's own acts are one Activity row each, actor seat:<project>, refusals included", async () => {
    await withNights();
    const actor = `seat:${basename(h.dir)}`;
    const ok = nm("w-log");
    expect((await startBuilder(ok)).ok).toBe(true);
    expect((await startBuilder(nm("w-log"), { allow: ["network"] })).ok).toBe(false);
    const theirs = nm("theirs");
    seed(theirs, OTHER);
    await h.asSeat("/agents/named/prompt", { name: theirs, text: "x" });
    await h.asSeat("/agents/named/stop", { name: ok });
    await h.asSeat("/agents/named/enlist", { name: nm("e"), pane: "%1" });
    const rows = (await h.actions()).filter((a) => a.action.startsWith("/agents/named/"));
    expect(rows.some((a) => a.action === "/agents/named/start" && a.actor === actor && a.ok)).toBe(true);
    expect(rows.some((a) => a.action === "/agents/named/start" && a.actor === actor && !a.ok && /ceiling/.test(a.detail ?? ""))).toBe(true);
    expect(rows.some((a) => a.action === "/agents/named/prompt" && a.actor === actor && !a.ok && /belongs to the seat/.test(a.detail ?? ""))).toBe(true);
    expect(rows.some((a) => a.action === "/agents/named/stop" && a.actor === actor)).toBe(true);
    expect(rows.some((a) => a.action === "/agents/named/enlist" && a.actor === actor)).toBe(true);
  }, 30_000);

  test("a process that presents a worker's name cannot start, stop or seat anything, nor change the wake hours", async () => {
    await withNights();
    h.slow(true);
    const worker = nm("w-wall");
    expect((await startBuilder(worker)).ok).toBe(true);
    const as = { "X-Agentglass-Agent": worker };
    for (const token of [h.seatToken, MACHINE]) {
      const child = nm("child");
      const start = await h.post("/agents/named/start", { name: child, cwd: h.wt, role: "builder" }, token, as);
      expect(start.status).toBe(403);
      expect(start.error).toContain(`${worker} is a worker`);
      expect((await h.post("/agents/named/stop", { name: worker }, token, as)).status).toBe(403);
      expect((await h.post("/seat/say", { root: h.dir, line: "I am in charge now" }, token, as)).status).toBe(403);
      expect((await h.post("/seat/open", { root: h.dir, powers: "assign" }, token, as)).status).toBe(403);
      expect((await h.post("/seat/wake", { hours: 1 }, token, as)).status).toBe(403);
      expect(await h.row(child)).toBeUndefined();
    }
    await h.asSeat("/agents/named/stop", { name: worker });
  }, 30_000);
});
