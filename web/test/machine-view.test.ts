/*
 * The Machine dialog's decisions, without a renderer: what a port row says,
 * which dials show and when they turn amber, how the process tree is cut, how
 * the disk plan is grouped, and when a stats sample may ask for a new reading.
 */
import { describe, expect, test } from "bun:test";
import type { DiskCleanLine, DiskCleanMount, GitRepoRef, MachineTotals, PortEntry, ProcEntry } from "../../shared/types.ts";
import { globalStubs } from "./stubGlobal.ts";

// machineView reuses the disk plan's ordering, and diskClean.ts reads the settings store at load.
const stubGlobal = globalStubs();
const store = new Map<string, string>();
stubGlobal("localStorage", {
  getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k), clear: () => store.clear(), key: () => null, length: 0,
} as unknown as Storage);
stubGlobal("location", new URL("http://localhost:5173/"));
stubGlobal("document", { documentElement: { setAttribute: () => {}, getAttribute: () => null, style: { setProperty: () => {}, removeProperty: () => {}, getPropertyValue: () => "" } } });
stubGlobal("getComputedStyle", () => ({ getPropertyValue: () => "" }));
stubGlobal("navigator", { webdriver: true, userAgent: "Linux" });
stubGlobal("window", new EventTarget());

const {
  LINE_PCT, bestRepo, breakdownRows, canStop, checkoutName, dialSub, dialsOf, forAge, groupsOf, lockGroups, mountBar,
  portFlags, portHit, portUrl, pushSample, resampleDue, ringDash, sameShown, splitPorts, treeOf,
} = await import("../src/lib/machineView.ts");

const port = (o: Partial<PortEntry> = {}): PortEntry => ({
  port: 3000, addr: "127.0.0.1", proc: "node", pid: 4100, cwd: "/home/u/code/orbit/web", mine: true, ageSec: 90,
  fromAgent: false, cwdGone: false, ancestry: [], publicBind: false, exeGone: false, tmpLeftover: false, duplicate: false,
  idleSec: null, dir: "/home/u/code/orbit", ...o,
} as PortEntry);

describe("port rows", () => {
  test("ages are coarse", () => {
    expect([forAge(5), forAge(600), forAge(3600), forAge(8100)]).toEqual(["5s", "10m", "1h", "2h15m"]);
  });

  test("every flag keeps its word, its tone and its sentence, in the row's order", () => {
    const flags = portFlags(port({
      fromAgent: true, publicBind: true, exeGone: true, cwdGone: true, tmpLeftover: true, duplicate: true, idleSec: 7200, addr: "0.0.0.0", dir: "/tmp/orbit-preview",
    }));
    expect(flags.map((f) => f.label)).toEqual(["agent-started", "on the network", "stale binary", "checkout gone", "tmp leftover", "duplicate", "idle"]);
    expect(flags.map((f) => f.tone)).toEqual(["muted", "warn", "muted", "bad", "warn", "warn", "warn"]);
    expect(flags[1]!.title).toContain("Listening on every interface (0.0.0.0)");
    expect(flags[4]!.title).toContain("/tmp/orbit-preview");
    expect(flags[6]!.title).toBe("Nothing has connected for 2h.");
  });

  test("a quiet port has no flags", () => {
    expect(portFlags(port())).toEqual([]);
  });

  test("the open URL turns every-interface into localhost and brackets IPv6", () => {
    expect(portUrl(port({ addr: "0.0.0.0" }))).toBe("http://localhost:3000");
    expect(portUrl(port({ addr: "::" }))).toBe("http://localhost:3000");
    expect(portUrl(port({ addr: "::1" }))).toBe("http://[::1]:3000");
    expect(portUrl(port({ addr: "127.0.0.1", port: 8000 }))).toBe("http://127.0.0.1:8000");
  });

  test("the filter reads port, process, checkout, address and what started it", () => {
    const p = port({ ancestry: [{ name: "tmux", pid: 1 }] as PortEntry["ancestry"] });
    for (const q of ["3000", "NODE", "orbit", "127.0", "tmux", ""]) expect(portHit(p, q)).toBe(true);
    expect(portHit(p, "uvicorn")).toBe(false);
  });

  test("yours and everything else are split after the filter", () => {
    const s = splitPorts([port(), port({ port: 22, mine: false, proc: "sshd" })], "ssh");
    expect(s.mine).toHaveLength(0);
    expect(s.rest.map((p) => p.port)).toEqual([22]);
  });

  test("Stop is offered for a process with a pid that is not this app's own server", () => {
    expect(canStop(port())).toBe(true);
    expect(canStop(port({ pid: null }))).toBe(false);
    expect(canStop(port({ proc: "agentglass-serv" }))).toBe(false);
  });

  test("the checkout chip is the last segment of the served folder", () => {
    expect(checkoutName(port())).toBe("orbit");
    expect(checkoutName(port({ dir: null, cwd: "/home/u/code/orbit-fix/web" }))).toBe("web");
    expect(checkoutName(port({ dir: null, cwd: null }))).toBeNull();
  });

  test("two reports that differ only in the age's seconds draw the same table", () => {
    const a = { ports: [port({ ageSec: 61 })], scanned: 1 } as any;
    const b = { ports: [port({ ageSec: 75 })], scanned: 1 } as any;
    const c = { ports: [port({ ageSec: 200 })], scanned: 1 } as any;
    expect(sameShown(a, b)).toBe(true);
    expect(sameShown(a, c)).toBe(false);
  });
});

const machine = (o: Partial<MachineTotals> = {}): MachineTotals => ({
  cpu: 31, cores: 16, memUsed: 11.9e9, memTotal: 31.2e9, swapUsed: 0, swapTotal: 0, tempC: 63, load1: 2.41, diskFree: 38e9, diskTotal: 500e9, ...o,
});

describe("the machine dials", () => {
  test("five dials without swap, six with it, in the mockup's order", () => {
    expect(dialsOf(machine()).map((d) => d.key)).toEqual(["cpu", "mem", "disk", "load", "temp"]);
    expect(dialsOf(machine({ swapTotal: 8e9, swapUsed: 0.4e9 })).map((d) => d.key)).toEqual(["cpu", "mem", "swap", "disk", "load", "temp"]);
  });

  test("no temperature sensor, no temperature dial", () => {
    expect(dialsOf(machine({ tempC: null })).map((d) => d.key)).not.toContain("temp");
  });

  test("a first sample says sampling and draws no arc", () => {
    const d = dialsOf(machine({ cpu: null }))[0]!;
    expect([d.value, d.sub, d.pct]).toEqual(["—", "sampling…", null]);
    expect(ringDash(d.pct)).toBeNull();
  });

  test("the readings are written the way the mockup writes them", () => {
    const [cpu, mem, disk, load, temp] = dialsOf(machine());
    expect([cpu!.value, cpu!.sub]).toEqual(["31 %", "of 16 cores"]);
    expect([mem!.value, mem!.sub]).toEqual(["11.9 GB", "of 31.2 GB"]);
    expect([disk!.value, disk!.sub]).toEqual(["38 GB free", "92 % used"]);
    expect([load!.value, load!.sub]).toEqual(["2.41", "1 min · 16 cores"]);
    expect(temp!.value).toBe("63 °C");
  });

  test(`amber starts at ${LINE_PCT} % and the sub-line says the word instead of the detail`, () => {
    const disk = dialsOf(machine())[2]!;
    expect(disk.hot).toBe(true);
    expect(dialSub(disk)).toBe("past the line");
    const cpu = dialsOf(machine())[0]!;
    expect(cpu.hot).toBe(false);
    expect(dialSub(cpu)).toBe("of 16 cores");
    expect(dialsOf(machine({ cpu: 80 }))[0]!.hot).toBe(true);
    expect(dialsOf(machine({ cpu: 79.9 }))[0]!.hot).toBe(false);
  });

  test("load is a share of the cores and never past the ring", () => {
    expect(dialsOf(machine({ load1: 40 }))[3]!.pct).toBe(100);
  });

  test("a machine with nothing to read has no dials", () => {
    expect(dialsOf(machine({ cpu: null, memTotal: 0, diskTotal: 0 }))).toEqual([]);
  });

  test("the arc is a share of the circle", () => {
    const [on, full] = ringDash(50)!.split(" ").map(Number);
    expect(on! / full!).toBeCloseTo(0.5, 5);
  });
});

const proc = (o: Partial<ProcEntry>): ProcEntry => ({ pid: 1, ppid: 0, comm: "node", cmd: "node", cpu: 1, rss: 100, cwd: null, ours: true, ...o });
const repo = (o: Partial<GitRepoRef>): GitRepoRef => ({ root: "/c/orbit", name: "orbit", branch: "main", dirty: 0, ahead: 0, behind: 0, touchedAt: 0, ...o });

describe("the process tree", () => {
  const repos = [repo({}), repo({ root: "/c/orbit-fix", branch: "fix/retry", worktreeOf: "/c/orbit" } as Partial<GitRepoRef>)];

  test("the longest registered root wins, so a worktree is not its project", () => {
    expect(bestRepo(repos, "/c/orbit-fix/web")!.root).toBe("/c/orbit-fix");
    expect(bestRepo(repos, "/c/orbit/api")!.root).toBe("/c/orbit");
    expect(bestRepo(repos, "/c/orbitary")).toBeNull();
  });

  test("project, then checkout (a worktree by its branch), then process, biggest first", () => {
    const t = treeOf([
      proc({ pid: 1, cwd: "/c/orbit/web", rss: 100, cpu: 2 }),
      proc({ pid: 2, cwd: "/c/orbit-fix/web", rss: 900, cpu: 30 }),
      proc({ pid: 3, cwd: "/elsewhere", rss: 5, cpu: 1 }),
      proc({ pid: 4, cwd: "/c/orbit", ours: false }),
    ], repos, "");
    expect(t.map((n) => n.label)).toEqual(["orbit", "Elsewhere"]);
    expect(t[0]!.kids.map((k) => k.label)).toEqual(["fix/retry", "orbit"]);
    expect([t[0]!.cpu, t[0]!.rss]).toEqual([32, 1000]);
  });

  test("a filter removes the checkouts it empties, and never the others' totals", () => {
    const t = treeOf([proc({ pid: 1, comm: "vite", cwd: "/c/orbit/web" }), proc({ pid: 2, comm: "bun", cwd: "/c/orbit-fix/x" })], repos, "vite");
    expect(t[0]!.kids.map((k) => k.label)).toEqual(["orbit"]);
  });

  test("history keeps the newest 24 samples", () => {
    const m = new Map<string, number[]>();
    for (let i = 0; i < 40; i++) pushSample(m, "k", i);
    expect(m.get("k")).toHaveLength(24);
    expect(m.get("k")![23]).toBe(39);
  });
});

const line = (o: Partial<DiskCleanLine>): DiskCleanLine => ({ id: "a", kind: "trash", mount: "/", label: "Trash", bytes: 10, verdict: "safe", why: "", target: { kind: "path" } as any, ...o });

describe("the disk plan", () => {
  test("lines fall into Safe, Look first, and In use / information, each with its size", () => {
    const g = groupsOf([
      line({ id: "1", bytes: 3e9 }), line({ id: "2", bytes: 5e9 }), line({ id: "3", verdict: "ask", bytes: 2e9 }),
      line({ id: "4", verdict: "inuse", bytes: 1e9 }), line({ id: "5", verdict: "explain", bytes: null }),
    ]);
    expect(g.safe.lines.map((l) => l.id)).toEqual(["2", "1"]);
    expect(g.safe.bytes).toBe(8e9);
    expect(g.ask.lines.map((l) => l.id)).toEqual(["3"]);
    expect(g.info.lines.map((l) => l.id)).toEqual(["4", "5"]);
    expect(g.info.bytes).toBe(1e9);
  });

  test("a mount bar: used grey, safe stripe at the tail, amber under the setting", () => {
    const m: DiskCleanMount = { mount: "/", source: "x", size: 500e9, free: 38e9, safeBytes: 10e9 };
    const b = mountBar(m, 15);
    expect(b.usedPct).toBeCloseTo(92.4, 1);
    expect(b.safePct).toBeCloseTo(2, 1);
    expect(b.greyPct).toBeCloseTo(90.4, 1);
    expect(b.low).toBe(true);
    expect(mountBar({ ...m, free: 300e9, safeBytes: 0 }, 15)).toMatchObject({ low: false, safePct: 0 });
  });
});

describe("the other small decisions", () => {
  test("the breakdown shows the eight biggest, bars relative to the biggest, never under 2 %", () => {
    const dirs = Array.from({ length: 10 }, (_, i) => ({ path: `/p/${i}`, name: `d${i}`, bytes: 1000 - i * 100, reclaimable: i === 0 }));
    dirs.push({ path: "/p/tiny", name: "tiny", bytes: 1, reclaimable: false });
    const rows = breakdownRows(dirs);
    expect(rows).toHaveLength(8);
    expect(rows[0]!.pct).toBe(100);
    expect(breakdownRows([{ path: "/a", name: "a", bytes: 1000, reclaimable: false }, { path: "/b", name: "b", bytes: 1, reclaimable: false }])[1]!.pct).toBe(2);
  });

  test("a stats sample asks for a new reading at most once per gap, and not while one is in flight", () => {
    expect(resampleDue(10_000, 0, 5_000, false)).toBe(true);
    expect(resampleDue(4_000, 0, 5_000, false)).toBe(false);
    expect(resampleDue(10_000, 0, 5_000, true)).toBe(false);
  });

  test("locks are Stuck when nothing holds them, In use otherwise", () => {
    const l = (stale: boolean) => ({ repo: "/r", name: "index.lock", path: `/r/${stale}`, ageSec: 1, heldBy: stale ? null : { pid: 1, cmd: "git" }, stale });
    const g = lockGroups([l(true), l(false)]);
    expect([g.stuck.length, g.held.length]).toEqual([1, 1]);
  });
});
