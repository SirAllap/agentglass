/**
 * The spawn broker: git and gh children started by a small process.
 *
 * Measured on an installed app short of memory: the server's only thread sat
 * in `kernel_clone`, state D, through three one-second samples (a 2,392 ms
 * stall with almost no disk or swap traffic) while it started gh and git
 * children. The fork of a 1.1 GB process was the wait, and awaiting the child
 * does not remove it. What is pinned here: the wire, the limits the broker
 * enforces for the server, that the flag being on never makes a command
 * impossible, and that a write is never run twice.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { BROKER_MARK, capped, envDelta, envFor } from "../src/broker/wire.ts";
import type { FromBroker, ToBroker } from "../src/broker/wire.ts";
import { brokerExec, brokerKill, brokerPid, brokerPings, brokerReady, brokerSent, brokerUp, startBroker, stopBroker } from "../src/broker/brokerHost.ts";
import { gitAsync } from "../src/git.ts";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const text = (rel: string) => Bun.file(new URL(rel, import.meta.url)).text();
const childSource = await text("../src/broker/brokerMain.ts");
const wireSource = await text("../src/broker/wire.ts");
const entrySource = await text("../src/index.ts");
const gitSource = await text("../src/git.ts");
const prsSource = await text("../src/prs.ts");

const js = (code: string) => [process.execPath, "-e", code];
const env = () => ({ ...process.env });
const until = async (ok: () => boolean, ms = 8000) => { for (let i = 0; i < ms / 25 && !ok(); i++) await Bun.sleep(25); return ok(); };

describe("the wire", () => {
  test("a request and an answer survive the line they travel on", () => {
    const run: ToBroker = { op: "run", id: 7, argv: ["git", "-C", "/home/dev/orbit", "status"], env: { A: "line\nbreak" }, unset: ["B"], timeoutMs: 1000, maxBytes: 10 };
    const line = JSON.stringify(run) + "\n";
    expect(line.indexOf("\n")).toBe(line.length - 1);
    expect(JSON.parse(line)).toEqual(run);
    const done: FromBroker = { op: "done", id: 7, code: 0, signal: null, stdout: "ORBIT-1042 é\n", stderr: "", truncated: false, timedOut: false, held: false };
    expect(JSON.parse(JSON.stringify(done))).toEqual(done);
  });

  test("a stream is cut at its cap, and a character split across chunks stays one", () => {
    const c = capped(5);
    expect(c.push(new Uint8Array([97, 98, 99]))).toBe(true);
    expect(c.push(new Uint8Array([100, 101, 102, 103]))).toBe(false);
    expect(c.push(new Uint8Array([104]))).toBe(false);
    expect(c.text()).toBe("abcde");
    expect(c.truncated).toBe(true);
    const e = new TextEncoder().encode("é");
    const whole = capped(10);
    whole.push(e.subarray(0, 1));
    whole.push(e.subarray(1));
    expect(whole.text()).toBe("é");
    expect(whole.truncated).toBe(false);
  });

  test("only the difference from the broker's own environment travels, and the child gets the caller's", () => {
    const base = { PATH: "/usr/bin", HOME: "/home/dev", OLD: "1", [BROKER_MARK]: "1" };
    const now = { PATH: "/usr/bin", HOME: "/home/dev", GIT_TERMINAL_PROMPT: "0" };
    const d = envDelta(base, now);
    expect(d.env).toEqual({ GIT_TERMINAL_PROMPT: "0" });
    expect(d.unset.sort()).toEqual([BROKER_MARK, "OLD"].sort());
    // The broker's mark never reaches what it starts, whatever the request says.
    expect(envFor(base, d.env, d.unset)).toEqual(now);
    expect(envFor(base, { [BROKER_MARK]: "1" }, [])[BROKER_MARK]).toBeUndefined();
  });
});

describe("the broker stays small", () => {
  test("its process imports the two wire files and nothing of the server", () => {
    const imports = (src: string) => [...src.matchAll(/^import .* from "([^"]+)";$/gm)].map((m) => m[1]);
    expect(imports(childSource).sort()).toEqual(["../relay/wire.ts", "./wire.ts", "./wire.ts"]);
    expect(imports(wireSource)).toEqual([]);
    expect(childSource).not.toContain("await import(");
  });

  test("the entry point reaches the broker's gate before anything that opens the database", () => {
    const gate = entrySource.indexOf('import "./broker/gate.ts";');
    expect(gate).toBeGreaterThan(-1);
    expect(gate).toBeGreaterThan(entrySource.indexOf('import "./relay/gate.ts";'));
    // cookieentry.ts and desk.ts come first on purpose (see index.ts) and open nothing; the first import that brings
    // in the server, and with it the database, is the first one that names what it takes.
    expect(gate).toBeLessThan(entrySource.search(/^import .* from "/m));
  });

  test("only gitAsync and the gh runner are routed, and each asks the broker before it forks", () => {
    const runGit = gitSource.slice(gitSource.indexOf("async function runGit("));
    expect(runGit.indexOf("runGitBrokered(cwd, args, t0, owner)")).toBeGreaterThan(-1);
    expect(runGit.indexOf("runGitBrokered(cwd, args, t0, owner)")).toBeLessThan(runGit.indexOf("Bun.spawn("));
    const gh = prsSource.slice(prsSource.indexOf("export async function gh("));
    expect(gh.indexOf("brokerExec(")).toBeGreaterThan(-1);
    expect(gh.indexOf("brokerExec(")).toBeLessThan(gh.indexOf("Bun.spawn("));
    expect(prsSource.split("brokerExec(").length - 1).toBe(1);
    expect(gitSource.split("brokerExec(").length - 1).toBe(1);
  });
});

describe("with no broker", () => {
  test("a run is not taken, and git still answers", async () => {
    expect(brokerReady()).toBe(false);
    expect(brokerExec({ argv: js("0"), env: env(), timeoutMs: 1000, maxBytes: 1000 })).toBeNull();
    const before = brokerSent();
    const r = await gitAsync(import.meta.dir, ["--version"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toStartWith("git version");
    expect(brokerSent()).toBe(before);
  });
});

describe("the real process, through the host", () => {
  const log: string[] = [];
  beforeAll(async () => {
    startBroker((l) => log.push(l));
    expect(await brokerUp(15_000)).toBe(true);
  }, 20_000);
  afterAll(async () => {
    stopBroker();
    await until(() => brokerPid() === null);
  });

  test("a command runs there and comes back whole, with the caller's environment", async () => {
    const via = brokerExec({
      argv: js(`console.log("ORBIT-1042 " + process.env.ORBIT_PROBE + " " + String(process.env.${BROKER_MARK})); console.error("to stderr"); process.exit(3)`),
      env: { ...process.env, ORBIT_PROBE: "seen" }, timeoutMs: 10_000, maxBytes: 1 << 20,
    });
    expect(via).not.toBeNull();
    const a = await via!.done;
    expect(a).toMatchObject({ code: 3, signal: null, stdout: "ORBIT-1042 seen undefined\n", stderr: "to stderr\n", truncated: false, timedOut: false, held: false, lost: false });
  }, 20_000);

  test("stdin reaches it", async () => {
    const a = await brokerExec({ argv: js(`process.stdout.write((await Bun.stdin.text()).toUpperCase())`), env: env(), stdin: "acme/orbit", timeoutMs: 10_000, maxBytes: 1000 })!.done;
    expect(a.stdout).toBe("ACME/ORBIT");
  }, 20_000);

  test("a command past its limit is killed, and the answer says it was the limit", async () => {
    const t0 = performance.now();
    const a = await brokerExec({ argv: js(`await Bun.sleep(8000)`), env: env(), timeoutMs: 300, maxBytes: 1000 })!.done;
    expect(a.timedOut).toBe(true);
    expect(a.signal).toBe("SIGTERM");
    expect(performance.now() - t0).toBeLessThan(6000);
  }, 20_000);

  test("a run is ended by its id, and that is not a timeout", async () => {
    const via = brokerExec({ argv: js(`await Bun.sleep(8000)`), env: env(), timeoutMs: 20_000, maxBytes: 1000 })!;
    await Bun.sleep(300);
    brokerKill(via.id);
    const a = await via.done;
    expect(a.timedOut).toBe(false);
    expect(a.signal).toBe("SIGTERM");
  }, 20_000);

  test("output past the cap is cut and marked, and the command still ends", async () => {
    const a = await brokerExec({ argv: js(`process.stdout.write("x".repeat(300000))`), env: env(), timeoutMs: 10_000, maxBytes: 1000 })!.done;
    expect(a.truncated).toBe(true);
    expect(a.stdout.length).toBe(1000);
    expect(a.code).toBe(0);
  }, 20_000);

  test("a command that cannot start answers with the reason instead of hanging", async () => {
    const a = await brokerExec({ argv: ["/nonexistent/orbit-tool"], env: env(), timeoutMs: 5000, maxBytes: 1000 })!.done;
    expect(a.code).toBeNull();
    expect(typeof a.error).toBe("string");
  }, 20_000);

  test("gitAsync goes through it and answers what it always did", async () => {
    const before = brokerSent();
    const r = await gitAsync(import.meta.dir, ["--version"]);
    expect(brokerSent()).toBe(before + 1);
    expect(r.code).toBe(0);
    expect(r.stdout).toStartWith("git version");
    const bad = await gitAsync(import.meta.dir, ["rev-parse", "--verify", "refs/heads/no-such-branch-orbit"]);
    expect(bad.code).not.toBe(0);
  }, 20_000);

  test("a broker that dies says so to whoever was waiting, a read is asked again here, and it comes back", async () => {
    const via = brokerExec({ argv: js(`await Bun.sleep(8000)`), env: env(), timeoutMs: 20_000, maxBytes: 1000 })!;
    await Bun.sleep(200);
    process.kill(brokerPid()!, "SIGKILL");
    const a = await via.done;
    expect(a.lost).toBe(true);
    // Down: nothing is taken, and a read is simply started in-process.
    await until(() => !brokerReady(), 2000);
    const r = await gitAsync(import.meta.dir, ["--version"]);
    expect(r.code).toBe(0);
    expect(await until(() => brokerReady(), 10_000)).toBe(true);
    expect(log.some((l) => l.includes("restarting"))).toBe(true);
    const again = await brokerExec({ argv: js(`console.log("back")`), env: env(), timeoutMs: 10_000, maxBytes: 1000 })!.done;
    expect(again.stdout).toBe("back\n");
  }, 30_000);

  test("a stall on main past the deadline does not blame the broker: the answer in the pipe wins, and the broker is kept", async () => {
    const pid = brokerPid()!;
    const before = log.length;
    // The victim's deadline: 600 + 200 + the host's margin = 3.8 s. Main
    // freezes 4.5 s while it handles another answer (an I/O callback), so when
    // it wakes the next loop pass runs the expired deadline before it reads
    // the victim's answer, which has waited in the pipe since ~0.3 s.
    const first = brokerExec({ argv: js(`console.log("first")`), env: env(), timeoutMs: 10_000, maxBytes: 1000 })!;
    const via = brokerExec({ argv: js(`await Bun.sleep(300); console.log("ORBIT-1042 done")`), env: env(), timeoutMs: 600, graceMs: 200, maxBytes: 1000 })!;
    await first.done.then(() => Bun.sleepSync(4500));
    const a = await via.done;
    expect(a).toMatchObject({ lost: false, code: 0, stdout: "ORBIT-1042 done\n" });
    expect(brokerPid()).toBe(pid);
    expect(brokerReady()).toBe(true);
    expect(log.slice(before).some((l) => l.includes("not answered"))).toBe(false);
  }, 20_000);

  test("a broker that is alive but stopped is not waited on for good: the run answers lost, and it is replaced", async () => {
    const pid = brokerPid()!;
    process.kill(pid, "SIGSTOP");
    const t0 = performance.now();
    // Budget 300 + grace 200 + the host's margin: then the host gives up and kills it.
    const a = await brokerExec({ argv: js(`console.log("never")`), env: env(), timeoutMs: 300, graceMs: 200, maxBytes: 1000 })!.done;
    expect(a.lost).toBe(true);
    expect(performance.now() - t0).toBeLessThan(8000);
    expect(log.some((l) => l.includes("not answered"))).toBe(true);
    expect(await until(() => brokerReady() && brokerPid() !== pid, 15_000)).toBe(true);
  }, 30_000);

  test("a broker killed for not answering takes the git it started with it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "orbit-broker-"));
    const git = join(dir, "git");
    symlinkSync(process.execPath, git);
    const pidFile = join(dir, "pid");
    const pid = brokerPid()!;
    const via = brokerExec({ argv: [git, "-e", `require("fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); await Bun.sleep(30000)`], env: env(), timeoutMs: 1500, graceMs: 200, maxBytes: 1000 })!;
    expect(await until(() => existsSync(pidFile) && readFileSync(pidFile, "utf8").length > 0, 5000)).toBe(true);
    const sleeper = Number(readFileSync(pidFile, "utf8"));
    // Stopped, the broker's own limit never fires: only the host can end the sleeper.
    process.kill(pid, "SIGSTOP");
    const a = await via.done;
    expect(a.lost).toBe(true);
    const gone = () => { try { return readFileSync(`/proc/${sleeper}/stat`, "utf8").split(") ")[1]?.startsWith("Z") ?? true; } catch { return true; } };
    expect(await until(gone, 5000)).toBe(true);
    expect(await until(() => brokerReady() && brokerPid() !== pid, 15_000)).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  }, 30_000);

  test("main closing the pipe does not kill a run in flight: it runs to the end and still answers", async () => {
    const via = brokerExec({ argv: js(`await Bun.sleep(800); console.log("finished")`), env: env(), timeoutMs: 10_000, maxBytes: 1000 })!;
    await Bun.sleep(200);
    stopBroker();
    const a = await via.done;
    expect(a).toMatchObject({ lost: false, signal: null, code: 0, stdout: "finished\n" });
  }, 20_000);
});

/**
 * A stand-in broker that speaks the wire: it says ready, answers every ping,
 * and never answers a run on its own. A kill is answered a second later with
 * the signal, except for a run whose argv[0] is "deaf".
 */
const standIn = js(`
  const say = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
  const runs = new Map();
  say({ op: "ready" });
  let buf = "";
  for await (const c of Bun.stdin.stream()) {
    buf += new TextDecoder().decode(c);
    for (let i; (i = buf.indexOf("\\n")) >= 0;) {
      const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
      if (m.op === "ping") say({ op: "pong" });
      else if (m.op === "run") runs.set(m.id, m.argv[0]);
      else if (m.op === "kill" && runs.get(m.id) !== "deaf") setTimeout(() => say({ op: "done", id: m.id, code: null, signal: "SIGTERM", stdout: "", stderr: "", truncated: false, timedOut: false, held: false }), 1000);
    }
  }
  process.exit(0);
`);

describe("a broker that answers pings but not a run", () => {
  const log: string[] = [];
  beforeAll(async () => {
    startBroker((l) => log.push(l), standIn);
    expect(await brokerUp(10_000)).toBe(true);
  }, 15_000);
  afterAll(async () => {
    stopBroker();
    await until(() => brokerPid() === null);
  });

  test("a read is freed at once; a write keeps its slot until its own answer comes", async () => {
    const pid = brokerPid()!;
    const read = brokerExec({ argv: ["git"], env: env(), timeoutMs: 100, graceMs: 100, maxBytes: 1000, read: true })!;
    const write = brokerExec({ argv: ["git"], env: env(), timeoutMs: 100, graceMs: 100, maxBytes: 1000 })!;
    let wrote = false;
    void write.done.then(() => { wrote = true; });
    expect((await read.done).lost).toBe(true);
    expect(wrote).toBe(false);
    expect(await write.done).toMatchObject({ lost: false, signal: "SIGTERM" });
    expect(brokerPid()).toBe(pid);
  }, 20_000);

  test("a write whose answer never comes, even after the kill, ends with the broker's group", async () => {
    const pid = brokerPid()!;
    const a = await brokerExec({ argv: ["deaf"], env: env(), timeoutMs: 100, graceMs: 100, maxBytes: 1000 })!.done;
    expect(a.lost).toBe(true);
    expect(await until(() => brokerPid() !== pid, 5000)).toBe(true);
  }, 20_000);

  test("fifty runs late together share one ping", async () => {
    // The runs above may have used up the restarts one minute allows: start one here.
    if (!(await brokerUp(10_000))) { startBroker((l) => log.push(l), standIn); expect(await brokerUp(10_000)).toBe(true); }
    const pid = brokerPid()!;
    const before = brokerPings();
    const before_log = log.length;
    // Stopped, it answers no ping: every run is late at once, and one probe judges them all.
    process.kill(pid, "SIGSTOP");
    const runs = Array.from({ length: 50 }, () => brokerExec({ argv: ["git"], env: env(), timeoutMs: 100, graceMs: 100, maxBytes: 1000, read: true })!);
    const answers = await Promise.all(runs.map((v) => v.done));
    expect(answers.every((a) => a.lost)).toBe(true);
    expect(brokerPings() - before).toBe(1);
    expect(log.slice(before_log).filter((l) => l.includes("not answered")).length).toBe(50);
    expect(await until(() => brokerPid() !== pid, 5000)).toBe(true);
  }, 20_000);
});

describe("a write is never run twice", () => {
  test("only a read verb may fall back after the broker lost or cut it", () => {
    const at = gitSource.indexOf("function runGitBrokered(");
    const body = gitSource.slice(at, gitSource.indexOf("\n}\n", at));
    expect(body).toContain("if ((a.lost || a.truncated) && READ_VERBS.has(verbOf(args))) return null;");
    expect(body).toContain("not run again, because it may have run");
    const gh = prsSource.slice(prsSource.indexOf("export async function gh("));
    expect(gh).toContain("if (a.lost) return { code: 1, stdout: \"\", stderr: \"gh was handed to the spawn broker");
  });
});
