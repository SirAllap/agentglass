/*
 * The Flight plan through a booted, isolated server: settings through the door,
 * a Preflight asked for by name, Go and No-go, an answer to a finding, and a
 * finished task reviewed. The reviewer is preflightStub.ts through
 * AGENTGLASS_PREFLIGHT_BIN, which the server honours only under NODE_ENV=test.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freePort } from "./freePort.ts";
import { TMUX_TEST_TMPDIR } from "./tmuxTmp.ts";
import { SERVER_BOOT_MS } from "./serverBoot.ts";

const TOKEN = "tok-flight-plan-example";
let dir: string, base: string, proc: ReturnType<typeof Bun.spawn> | null = null;
const auth = { Authorization: `Bearer ${TOKEN}` };
const fromApp = () => ({ ...auth, Origin: base, "Content-Type": "application/json" });
const fromAgent = { ...auth, "Content-Type": "application/json" };
const reply = (t: string) => writeFileSync(join(dir, "reply.txt"), t);
const get = async (path: string) => { const r = await fetch(base + path, { headers: auth }); return { status: r.status, body: (await r.json()) as Record<string, any> }; };
const post = async (path: string, body: unknown, headers: Record<string, string> = fromAgent) => {
  const r = await fetch(base + path, { method: "POST", headers, body: JSON.stringify(body) });
  return { status: r.status, body: (await r.json()) as Record<string, any> };
};
const settle = async (id: string, want = "done") => {
  for (let i = 0; i < 100; i++) { const r = (await get(`/flight-plan/runs/${id}`)).body.run; if (r.state === want) return r; await Bun.sleep(50); }
  throw new Error(`run ${id} never reached ${want}`);
};
const setting = (id: string, value: unknown, root: string) => post("/settings/door", { id, value, root }, fromApp());
let plan: string, shot: string, ROOT: string;
// Runs no longer wait for Go, but a row an older server left awaiting-go still answers to the person: write one into the server's own database.
const waitingRun = (): string => {
  const id = `pf_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const d = new Database(join(dir, "d.db"));
  try {
    d.run("PRAGMA busy_timeout = 5000");
    d.query(`INSERT INTO preflight_run (id, created_at, root, moment, state, requested_by, input) VALUES (?, ?, ?, 'before-launch', 'awaiting-go', 'tester', ?)`)
      .run(id, Date.now(), ROOT, JSON.stringify({ files: [plan], mockups: [], root: ROOT, model: "sonnet", budgetUsd: 0.5 }));
  } finally { d.close(); }
  return id;
};

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "agx-flightplan-route-"));
  ROOT = join(dir, "root"); mkdirSync(ROOT);
  plan = join(dir, "plan.md"); shot = join(dir, "screen.png");
  writeFileSync(plan, "# Plan"); writeFileSync(shot, Buffer.from([137, 80, 78, 71]));
  reply("No findings");
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  proc = Bun.spawn(["bun", "run", new URL("../src/index.ts", import.meta.url).pathname], {
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      NODE_ENV: "test",
      AGENTGLASS_PREFLIGHT_BIN: new URL("./preflightStub.ts", import.meta.url).pathname,
      STUB_REPLY_FILE: join(dir, "reply.txt"),
      TMUX_TMPDIR: TMUX_TEST_TMPDIR,
      HOME: dir, XDG_CONFIG_HOME: dir, XDG_DATA_HOME: join(dir, "data"), XDG_CACHE_HOME: join(dir, "cache"),
      AGENTGLASS_STATE_DIR: `${dir}/state`,
      AGENTGLASS_ROOT: ROOT,
      AGENTGLASS_DB: join(dir, "d.db"),
      AGENTGLASS_SCAN_DISABLED: "1",
      AGENTGLASS_PORT: String(port),
      AGENTGLASS_TOKEN: TOKEN,
    },
    stdout: "ignore", stderr: "pipe",
  });
  for (let i = 0; i < 150; i++) {
    try { if ((await fetch(base + "/health")).ok) return; } catch { /* booting */ }
    await Bun.sleep(100);
  }
  throw new Error("server did not start");
}, SERVER_BOOT_MS);

afterAll(() => { proc?.kill(); rmSync(dir, { recursive: true, force: true }); });

describe("asking for a Preflight", () => {
  test("the door has the settings, a plan review by default and per project", async () => {
    const r = await get(`/settings/door?id=flightPlan.preflight.reviews&root=${encodeURIComponent(ROOT)}`);
    expect(r.body).toMatchObject({ ok: true, value: ["plan"] });
    expect((await get(`/settings/door?id=flightPlan.pilot&root=${encodeURIComponent(ROOT)}`)).body.value).toBe("copilot");
    expect((await get(`/settings/door?id=flightPlan.preflight.costCapUsd&root=${encodeURIComponent(ROOT)}`)).body.value).toBe(0.5);
    // the three per-moment keys are gone
    expect((await get(`/settings/door?id=flightPlan.preflight.onPr&root=${encodeURIComponent(ROOT)}`)).body.ok).not.toBe(true);
  });

  test("an agent reviewing more waits for the person; the person's own change applies", async () => {
    const q = `/settings/door?id=flightPlan.preflight.reviews&root=${encodeURIComponent(ROOT)}`;
    const a = await post("/settings/door", { id: "flightPlan.preflight.reviews", value: ["plan", "pr"], root: ROOT });
    expect(a.status).toBe(202);
    expect((await get(q)).body.value).toEqual(["plan"]);
    expect((await setting("flightPlan.preflight.reviews", ["plan", "pr"], ROOT)).status).toBe(200);
    expect((await get(q)).body.value).toEqual(["plan", "pr"]);
    // reviewing less applies at once for an agent
    expect((await post("/settings/door", { id: "flightPlan.preflight.reviews", value: ["plan"], root: ROOT })).status).toBe(200);
    expect((await get(q)).body.value).toEqual(["plan"]);
  });

  test("a moment the project does not review is refused with the sentence", async () => {
    const r = await post("/flight-plan/preflight", { files: [plan], root: ROOT, moment: "task-done" });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe(`Preflight does not review task-done in ${ROOT}.`);
  });

  test("manual runs, async: the answer is a running row, then done with the certificate", async () => {
    reply("### F1 - Blocker - Cannot be checked\nQuote: q\nEvidence: e");
    const r = await post("/flight-plan/preflight", { files: [plan], mockups: [shot], root: ROOT, moment: "manual", as: "tester" });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, state: "running" });
    const run = await settle(r.body.id);
    expect(run.requestedBy).toContain("tester");
    expect(run.certificate.mockups).toHaveLength(1);
    expect(run.certificate.findings[0]).toMatchObject({ id: "F1", severity: "blocker" });
    expect((await get("/flight-plan/runs?state=done&root=" + encodeURIComponent(ROOT))).body.runs.map((x: any) => x.id)).toContain(r.body.id);
  });

  test("bad input is refused before anything is created", async () => {
    const n = (await get("/flight-plan/runs")).body.runs.length;
    const bad = async (b: Record<string, unknown>) => (await post("/flight-plan/preflight", { root: ROOT, moment: "manual", files: [plan], ...b })).status;
    expect(await bad({ files: [join(dir, "missing.md")] })).toBe(400);
    expect(await bad({ files: [dir] })).toBe(400);
    expect(await bad({ files: ["relative.md"] })).toBe(400);
    expect(await bad({ files: [] })).toBe(400);
    expect(await bad({ mockups: [plan] })).toBe(400);
    const secret = join(dir, ".ssh"); mkdirSync(secret, { recursive: true }); writeFileSync(join(secret, "id_x"), "k");
    const envf = join(dir, ".env.local"); writeFileSync(envf, "A=1");
    expect(await bad({ files: [join(secret, "id_x")] })).toBe(400);
    expect(await bad({ files: [envf] })).toBe(400);
    expect(await bad({ files: ["/etc/hostname"] })).toBe(400);
    expect(await bad({ moment: "whenever" })).toBe(400);
    expect(await bad({ root: "relative" })).toBe(400);
    expect(await bad({ pr: { number: 0, root: ROOT } })).toBe(400);
    expect((await get("/flight-plan/runs")).body.runs.length).toBe(n);
  });

  test("a link under home that points outside it is refused, for the folder and for the file", async () => {
    const outside = mkdtempSync(join(tmpdir(), "agx-outside-"));
    try {
      writeFileSync(join(outside, "notes.md"), "# Outside");
      symlinkSync(outside, join(dir, "linked-dir"));
      symlinkSync(join(outside, "notes.md"), join(dir, "linked-file.md"));
      const ask = (f: string) => post("/flight-plan/preflight", { files: [f], root: ROOT, moment: "manual" });
      expect((await ask(join(dir, "linked-dir", "notes.md"))).status).toBe(400);
      expect((await ask(join(dir, "linked-file.md"))).status).toBe(400);
    } finally { rmSync(outside, { recursive: true, force: true }); }
  });

  test("a request without the token is refused", async () => {
    expect((await fetch(base + "/flight-plan/runs")).status).toBe(401);
  });
});

describe("Go, No-go and answering a finding", () => {
  let waiting: string;
  test("a reviewed moment starts running at once: there is no Go to wait for", async () => {
    reply("No findings");
    const r = await post("/flight-plan/preflight", { files: [plan], root: ROOT, moment: "before-launch" });
    expect(r.status).toBe(200);
    expect(r.body.state).toBe("running");
    await settle(r.body.id);
    expect((await post(`/flight-plan/runs/${r.body.id}/go`, {}, fromApp())).status).toBe(409);
  });

  test("an awaiting-go row waits until Go, then runs; a second Go or a No-go is refused", async () => {
    reply("### F1 - Major - Unstated\nQuote: q\nEvidence: e\n\n### F2 - Nit - Name\nQuote: q\nEvidence: e");
    waiting = waitingRun();
    await Bun.sleep(300);
    expect((await get(`/flight-plan/runs/${waiting}`)).body.run).toMatchObject({ state: "awaiting-go", certificate: null });
    expect((await post(`/flight-plan/runs/${waiting}/go`, { as: "tester" }, fromApp())).body.run.state).toBe("running");
    const run = await settle(waiting);
    expect(run.certificate.findings).toHaveLength(2);
    expect((await post(`/flight-plan/runs/${waiting}/go`, {}, fromApp())).status).toBe(409);
    expect((await post(`/flight-plan/runs/${waiting}/no-go`, {}, fromApp())).status).toBe(409);
  });

  test("an agent cannot say Go or No-go: they are the person's", async () => {
    const id = waitingRun();
    expect((await post(`/flight-plan/runs/${id}/go`, {})).status).toBe(403);
    expect((await post(`/flight-plan/runs/${id}/no-go`, { as: "agent" }, { ...fromApp(), "x-agentglass-agent": "agent" })).status).toBe(403);
    expect((await get(`/flight-plan/runs/${id}`)).body.run.state).toBe("awaiting-go");
    await post(`/flight-plan/runs/${id}/no-go`, {}, fromApp());
  });

  test("No-go declines an awaiting-go row", async () => {
    const id = waitingRun();
    expect((await post(`/flight-plan/runs/${id}/no-go`, {}, fromApp())).body.run.state).toBe("declined");
  });

  test("a finding is answered by the person, never by any agent on the machine token; contest and dismiss need a note", async () => {
    expect((await post(`/flight-plan/runs/${waiting}/findings/F1`, { action: "fix" })).status).toBe(403);
    expect((await post(`/flight-plan/runs/${waiting}/findings/F1`, { action: "fix" }, { ...fromApp(), "x-agentglass-agent": "agent" })).status).toBe(403);
    const f = (fid: string, b: unknown) => post(`/flight-plan/runs/${waiting}/findings/${fid}`, b, fromApp());
    expect((await f("F1", { action: "contest" })).status).toBe(400);
    expect((await f("F1", { action: "dismiss", note: " " })).status).toBe(400);
    expect((await f("F1", { action: "contest", note: "a.ts:3 does it", as: "tester" })).body.run.certificate.findings[0]).toMatchObject({ action: "contest", note: "a.ts:3 does it" });
    expect((await f("F2", { action: "fix" })).status).toBe(200);
    expect((await f("F7", { action: "fix" })).status).toBe(404);
    expect((await f("F1", { action: null })).body.run.certificate.findings[0].action).toBeNull();
    expect((await post("/flight-plan/runs/pf_0000000000000000/go", {}, fromApp())).status).toBe(404);
  });
});

describe("a finished task", () => {
  // The review follows the plan the task came from, so a task is linked to one of the given size first.
  const finish = async (title: string, size?: "M" | "L") => {
    const t = await post("/seat/task", { root: ROOT, title, detail: "d", proof: "p" }, fromApp());
    expect(t.status).toBe(200);
    if (size) expect((await post("/flight-plan/plans", { root: ROOT, request: title, size, taskId: t.body.task.id }, fromApp())).status).toBe(200);
    return post("/seat/task/finish", { root: ROOT, id: t.body.task.id, outcome: "done" }, fromApp());
  };
  test("a project that does not review finished tasks: the task is finished and carries no preflight", async () => {
    const r = await finish("Off task");
    expect(r.body.task).toMatchObject({ preflight: null });
    expect(r.body.task.doneAt).not.toBeNull();
  });
  test("reviewing finished tasks: only a task from an L plan is reviewed, at once, checked or open when a major finding stands", async () => {
    expect((await setting("flightPlan.enabled", true, ROOT)).status).toBe(200);
    expect((await setting("flightPlan.preflight.reviews", ["plan", "taskDone"], ROOT)).status).toBe(200);
    reply("No findings");
    const none = await finish("No plan task");
    const small = await finish("M plan task", "M");
    expect(none.body.task.preflight).toBeNull();
    expect(small.body.task.preflight).toBeNull();

    const ok = await finish("Clean task", "L");
    await settle(ok.body.task.preflight.runId);
    const tasks = (await get(`/seat/tasks?root=${encodeURIComponent(ROOT)}`)).body.tasks as any[];
    expect(tasks.find((t) => t.id === ok.body.task.id).preflight.status).toBe("checked");
    expect((await get(`/flight-plan/runs/${ok.body.task.preflight.runId}`)).body.run).toMatchObject({ state: "done", moment: "task-done", taskId: ok.body.task.id });

    reply("### F1 - Major - Unstated\nQuote: q\nEvidence: e");
    const bad = await finish("Open task", "L");
    await settle(bad.body.task.preflight.runId);
    expect(((await get(`/seat/tasks?root=${encodeURIComponent(ROOT)}`)).body.tasks as any[]).find((t) => t.id === bad.body.task.id).preflight).toMatchObject({ status: "checked", openFindings: 1 });
    await setting("flightPlan.preflight.reviews", ["plan"], ROOT);
  });
});

describe("the door: agentglass-ui flight-plan", () => {
  const ui = async (...args: string[]) => {
    const p = Bun.spawn(["python3", new URL("../../bin/agentglass-ui", import.meta.url).pathname, "--as", "cli-tester", "flight-plan", ...args], {
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: dir, AGENTGLASS_SERVER: base, AGENTGLASS_TOKEN: TOKEN }, stdout: "pipe", stderr: "pipe",
    });
    const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
    await p.exited;
    try { return JSON.parse(out) as Record<string, any>; } catch { throw new Error(`no JSON from the CLI: ${(out || err).slice(0, 300)}`); }
  };

  test("run, show and list, with the mockup and the name stamped; resolve from an agent is refused with the reason", async () => {
    reply("### F1 - Major - Unstated\nQuote: q\nEvidence: e");
    const r = await ui("run", plan, "--mockup", shot, "--root", ROOT);
    expect(r).toMatchObject({ ok: true, state: "running" });
    const done = await settle(r.id);
    expect(done.requestedBy).toContain("cli-tester");
    expect(done.certificate.mockups).toHaveLength(1);
    expect((await ui("show", r.id)).run.id).toBe(r.id);
    expect((await ui("list", "--state", "done", "--root", ROOT)).runs.map((x: any) => x.id)).toContain(r.id);
    expect((await ui("resolve", r.id, "F1", "dismiss", "--note", "out of scope")).error).toContain("answered by the person or the project's coordinator");
    expect((await ui("show", r.id)).run.certificate.findings[0].action).toBeNull();
  });

  test("a moment the project does not review answers the server's sentence; Go on a run that does not wait is refused", async () => {
    await setting("flightPlan.preflight.reviews", ["plan"], ROOT);
    expect((await ui("run", plan, "--root", ROOT, "--moment", "pr")).error).toBe(`Preflight does not review pr in ${ROOT}.`);
    const id = (await get("/flight-plan/runs?state=done")).body.runs[0].id;
    expect((await ui("go", id)).ok).toBe(false);
    expect((await ui("no-go", id)).ok).toBe(false);
  });
});
