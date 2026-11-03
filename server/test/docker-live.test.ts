/*
 * The Docker panel stopped polling: one `docker events` and one streaming
 * `docker stats` serve every open panel, exist only while somebody is
 * listening, and die with the last listener.
 *
 * A stand-in `docker` on PATH, in a child process (the binary lookup is cached
 * per process): it logs each spawn, records its pid so the test can see the
 * process die, and prints a recorded burst of events.
 */
import { afterAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backoffMs, scopesFor, statsFromChunk } from "../src/dockerlive.ts";

test("only events that change what a list shows say so, and say which list", () => {
  const ev = (Type: string, Action: string) => JSON.stringify({ Type, Action, id: "aaa" });
  expect(scopesFor(ev("container", "start"))).toEqual(["containers"]);
  expect(scopesFor(ev("container", "die"))).toEqual(["containers"]);
  expect(scopesFor(ev("container", "health_status: unhealthy"))).toEqual(["containers"]);
  // A new or removed container moves the image's "containers" count.
  expect(scopesFor(ev("container", "create"))).toEqual(["containers", "images"]);
  expect(scopesFor(ev("container", "destroy"))).toEqual(["containers", "images"]);
  expect(scopesFor(ev("image", "pull"))).toEqual(["images"]);
  expect(scopesFor(ev("volume", "create"))).toEqual(["volumes"]);
  expect(scopesFor(ev("network", "disconnect"))).toEqual(["networks"]);
  // A health check execs inside the container every few seconds: that is not a change.
  expect(scopesFor(ev("container", "exec_start: /bin/true"))).toEqual([]);
  expect(scopesFor(ev("container", "exec_die"))).toEqual([]);
  expect(scopesFor(ev("volume", "mount"))).toEqual([]);
  expect(scopesFor("not json")).toEqual([]);
});

test("a retry waits longer each time and never longer than half a minute", () => {
  const waits = [0, 1, 2, 3, 4, 5, 6, 20].map((n) => backoffMs(n));
  expect(waits[0]).toBe(1000);
  for (let i = 1; i < waits.length; i++) expect(waits[i]!).toBeGreaterThanOrEqual(waits[i - 1]!);
  expect(waits.at(-1)).toBe(30_000);
});

test("a stats chunk is the clear-screen escapes docker prints between samples plus one JSON row per container", () => {
  const row = (id: string, cpu: string) => JSON.stringify({ ID: id, CPUPerc: cpu, MemPerc: "2.5%", MemUsage: "10MiB / 1GiB", NetIO: "1kB / 2kB", BlockIO: "0B / 0B", PIDs: "4" });
  const chunk = `\x1b[2J\x1b[H${row("aaaaaaaaaaaaffff", "1.50%")}\n${row("bbbbbbbbbbbbffff", "0.00%")}\n`;
  const got = statsFromChunk(chunk);
  expect(got.map((s) => s.id)).toEqual(["aaaaaaaaaaaa", "bbbbbbbbbbbb"]);
  expect(got[0]).toMatchObject({ cpu: 1.5, mem: 2.5, pids: 4 });
  expect(statsFromChunk("\x1b[2J\x1b[H\n")).toEqual([]);
});

/* ---- the processes ------------------------------------------------------- */

const dir = mkdtempSync(join(tmpdir(), "agx-live-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const spawnsLog = join(dir, "spawns.log");

writeFileSync(join(dir, "docker"), `#!/bin/sh
case "$1" in
  events)
    echo events >> "${spawnsLog}"; echo $$ > "${dir}/events.pid"
    [ -f "${dir}/down" ] && { echo "Cannot connect to the Docker daemon" >&2; exit 1; }
    sleep 0.4
    echo '{"Type":"container","Action":"start","id":"aaa"}'
    echo '{"Type":"container","Action":"die","id":"aaa"}'
    echo '{"Type":"container","Action":"exec_start: /bin/true","id":"aaa"}'
    echo '{"Type":"image","Action":"pull","id":"nginx"}'
    exec sleep 300 ;;
  stats)
    echo stats >> "${spawnsLog}"; echo $$ > "${dir}/stats.pid"
    [ -f "${dir}/down" ] && exit 1
    sleep 0.4
    printf '\\033[2J\\033[H{"ID":"aaaaaaaaaaaaffff","CPUPerc":"1.50%%","MemPerc":"2.5%%","MemUsage":"1MiB / 1GiB","NetIO":"0B / 0B","BlockIO":"0B / 0B","PIDs":"3"}\\n'
    exec sleep 300 ;;
esac
exit 0
`);
chmodSync(join(dir, "docker"), 0o755);

async function probe(body: string): Promise<any> {
  rmSync(spawnsLog, { force: true });
  for (const f of ["down", "events.pid", "stats.pid"]) rmSync(join(dir, f), { force: true });
  const code = `import { subscribe, __setBackoffBaseForTest } from ${JSON.stringify(new URL("../src/dockerlive.ts", import.meta.url).pathname)};
    import { readFileSync, existsSync, writeFileSync, rmSync } from "node:fs";
    const dir = ${JSON.stringify(dir)};
    const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
    const pid = (f) => Number(readFileSync(dir + "/" + f + ".pid", "utf8"));
    const until = async (fn, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await Bun.sleep(25); } return fn(); };
    const spawns = () => existsSync(dir + "/spawns.log") ? readFileSync(dir + "/spawns.log", "utf8").split("\\n").filter(Boolean) : [];
    __setBackoffBaseForTest(100);
    const out = {};
    ${body}
    console.log(JSON.stringify(out)); process.exit(0);`;
  const p = Bun.spawn([process.execPath, "-e", code], {
    stdout: "pipe", stderr: "pipe",
    env: {
      PATH: `${dir}:${process.env.PATH ?? ""}`, HOME: dir, XDG_CONFIG_HOME: dir, XDG_DATA_HOME: dir, XDG_CACHE_HOME: dir,
      AGENTGLASS_STATE_DIR: join(dir, "state"), AGENTGLASS_DB: join(dir, "d.db"), AGENTGLASS_ROOT: dir, NODE_ENV: "test",
    },
  });
  const [stdout, stderr] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  await p.exited;
  try { return JSON.parse(stdout.trim().split("\n").pop() ?? ""); } catch { throw new Error("probe died: " + stderr.slice(0, 400) + stdout.slice(0, 200)); }
}

test("an event burst is one `changed` per list, and the stats come from the stream", async () => {
  const r = await probe(`
    const got = []; const off = subscribe((m) => got.push(m));
    await until(() => got.some((m) => m.kind === "stats") && got.filter((m) => m.kind === "changed").length >= 2, 4000);
    await Bun.sleep(500);
    out.changed = got.filter((m) => m.kind === "changed").map((m) => m.scope);
    out.stats = got.filter((m) => m.kind === "stats").map((m) => m.stats.map((s) => [s.id, s.cpu]));
    out.down = got.some((m) => m.kind === "down");
    off();`);
  expect(r.changed.sort()).toEqual(["containers", "images"]);
  expect(r.stats[0]).toEqual([["aaaaaaaaaaaa", 1.5]]);
  expect(r.down).toBe(false);
}, 20_000);

test("two listeners share one pair of processes, and the last one out kills them", async () => {
  const r = await probe(`
    const a = subscribe(() => {}); const b = subscribe(() => {});
    await until(() => existsSync(dir + "/stats.pid"), 3000);
    await Bun.sleep(300);
    out.spawns = spawns();
    const ev = pid("events"), st = pid("stats");
    a();
    await Bun.sleep(400);
    out.aliveAfterFirstLeaves = [alive(ev), alive(st)];
    b();
    out.deadAfterLast = await until(() => !alive(ev) && !alive(st), 4000);`);
  expect(r.spawns.sort()).toEqual(["events", "stats"]);
  expect(r.aliveAfterFirstLeaves).toEqual([true, true]);
  expect(r.deadAfterLast).toBe(true);
}, 20_000);

test("a daemon that is down is reported, retried with backoff, and reported back up", async () => {
  const r = await probe(`
    writeFileSync(dir + "/down", "");
    const got = []; const off = subscribe((m) => got.push(m.kind === "changed" ? "changed" : m.kind));
    out.sawDown = await until(() => got.includes("down"), 3000);
    out.retried = await until(() => spawns().filter((s) => s === "events").length >= 3, 4000);
    rmSync(dir + "/down");
    out.sawUp = await until(() => got.includes("up"), 6000);
    out.downOnce = got.filter((k) => k === "down").length;
    const ev = pid("events");
    off();
    out.deadAfter = await until(() => !alive(ev), 4000);`);
  expect(r.sawDown).toBe(true);
  expect(r.retried).toBe(true);
  expect(r.sawUp).toBe(true);
  expect(r.downOnce).toBe(1);
  expect(r.deadAfter).toBe(true);
}, 30_000);
