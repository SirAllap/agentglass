/*
 * A child runs in its own scope, a leftover app scope is stopped by unit name,
 * and a healthy machine is never walked for memory.
 *
 * Measured on one machine on 2026-11-04: oomd killed one app scope holding 1085
 * processes and 11.8 GB, and 16 app scopes were still there with a dead leader
 * and children up to 57 h old. The halves are tested the way they fail: the
 * launch is a real process behind a stand-in `systemd-run` that records its
 * argv, and every clause of the sweep is a table row with an injected
 * `systemctl`.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand } from "../src/agentprobe.ts";
import { serveLaunch } from "../src/agents/opencodeserve.ts";
import {
  APP_SCOPE_PREFIX, DEFAULT_MAX_AGE_H, LEGACY_WORKER_SLICE, MEMORY_MAX_CAP, MEMORY_MAX_FLOOR, MAX_TREE_CGROUPS, MAX_TREE_DEPTH, MEMORY_PRESSURE,
  SCOPE_PREFIX, WORKER_SLICE, adoptOrphanScopes, ageMsOf, appSliceBytes, appliedSliceMemoryMax, bootScopes, cgroupProcs, cgroupTree,
  defaultMemoryMax, endWindowScopes,
  engineServe, ensureWorkerSlice, groupProcs, holdsLiveWork,
  memoryPressure, memoryWatch, noteRunScope, oomKills, ownCgroup, ownScopes, parseShow,
  childScopeOwner, reapStaleScopes, rememberScope, retireLegacySlice, runOutOfMemory, scopeArgv, scopeSettings, scopeUnits, sliceArgv, sliceMemoryHigh,
  sliceMemoryMax, staleAppScope, staleChildScope, stillAdopted, stopOwnScopes, sweepsAppScopes, systemdRun, workerSliceFacts,
  workerSliceUsable,
  type OwnerRead, type ScopeSettings,
} from "../src/scopes.ts";

const dirs: string[] = [];
function temp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

/** `depth` cgroups nested one inside the next, each with one pid; returns the
 *  nested pids in the order the tree should report them. */
function chain(dir: string, depth: number): number[] {
  let at = dir;
  writeFileSync(join(at, "cgroup.procs"), "10\n");
  const nested: number[] = [];
  for (let i = 1; i <= depth; i++) {
    at = join(at, "nested.scope");
    mkdirSync(at);
    writeFileSync(join(at, "cgroup.procs"), `${10 + i}\n`);
    nested.push(10 + i);
  }
  return nested;
}

/** This user's manager with `app.slice` in it, and the worker slice where
 *  systemd really puts it: `app-agentglass-workers.slice` hangs off
 *  `app-agentglass.slice`, one level below `app.slice`. */
function cgroupRoot(prefix: string): { root: string; app: string; slice: string } {
  const root = temp(prefix);
  const uid = typeof process.getuid === "function" ? process.getuid() : 1000;
  const app = join(root, "user.slice", `user-${uid}.slice`, "user@1000.service", "app.slice");
  const slice = join(app, "app-agentglass.slice", WORKER_SLICE);
  mkdirSync(slice, { recursive: true });
  return { root, app, slice };
}

afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  delete process.env.AGENTGLASS_SCOPES;
  delete process.env.AGENTGLASS_SCOPE_MEMORY_MAX;
});

/** 31.3 GiB, the machine the OOM kills in `scopes.ts`'s header were measured on. */
const MEMINFO = "MemTotal:       32773844 kB\nMemAvailable:    9876543 kB\n";
/** `gib` GiB of RAM, as `/proc/meminfo` reports it. */
const meminfo = (gib: number): string => `MemTotal:       ${Math.round(gib * 1024 * 1024)} kB\n`;
const settings: ScopeSettings = {
  on: true, memoryMax: "3G", slice: WORKER_SLICE, sliceMemoryMax: "20G", sliceMemoryHigh: "18G",
  maxAgeMs: DEFAULT_MAX_AGE_H * 3_600_000,
};

describe("the switches", () => {
  test("on by default, a share of RAM, and six hours", () => {
    const s = scopeSettings({}, {}, MEMINFO);
    expect(s.on).toBe(true);
    expect(s.memoryMax).toBe("10G");
    expect(s.maxAgeMs).toBe(6 * 3_600_000);
  });

  test("the environment turns it off, and so does the file", () => {
    expect(scopeSettings({ AGENTGLASS_SCOPES: "0" }, {}, MEMINFO).on).toBe(false);
    expect(scopeSettings({ AGENTGLASS_SCOPES: "off" }, {}, MEMINFO).on).toBe(false);
    expect(scopeSettings({}, { off: true }, MEMINFO).on).toBe(false);
    expect(scopeSettings({ AGENTGLASS_SCOPES: "1" }, { off: true }, MEMINFO).on).toBe(true);
  });

  test("a size systemd would not take falls back instead of becoming a ceiling nobody has", () => {
    expect(scopeSettings({ AGENTGLASS_SCOPE_MEMORY_MAX: "3 gigabytes" }, {}, MEMINFO).memoryMax).toBe("10G");
    expect(scopeSettings({}, { memoryMax: "0G" }, MEMINFO).memoryMax).toBe("10G");
    expect(scopeSettings({ AGENTGLASS_SCOPE_MEMORY_MAX: "512M" }, {}, MEMINFO).memoryMax).toBe("512M");
    expect(scopeSettings({}, { memoryMax: "2G" }, MEMINFO).memoryMax).toBe("2G");
    expect(scopeSettings({ AGENTGLASS_SCOPE_MAX_AGE_H: "nope" }, {}, MEMINFO).maxAgeMs).toBe(6 * 3_600_000);
  });
  test("only the app's own copy sweeps app scopes", () => {
    expect(sweepsAppScopes({})).toBe(false);
    expect(sweepsAppScopes({ AGENTGLASS_DIE_WITH_PARENT: "1" })).toBe(true);
  });
});

describe("the ceiling a child's scope gets", () => {
  test("a third of this machine's RAM, as whole GiB", () => {
    // 31.3 GiB is the machine the OOM kills in the header were measured on.
    expect(defaultMemoryMax(MEMINFO)).toBe("10G");
    expect(defaultMemoryMax(meminfo(48))).toBe("16G");
  });

  test("a floor above one bun test and one serve, a cap no turn has come near", () => {
    // 12 GiB: a third is 4G, below the smallest turn that must survive.
    expect(defaultMemoryMax(meminfo(12))).toBe(`${MEMORY_MAX_FLOOR / 2 ** 30}G`);
    expect(defaultMemoryMax(meminfo(512))).toBe(`${MEMORY_MAX_CAP / 2 ** 30}G`);
    // An unreadable /proc/meminfo is not "no ceiling": it is the floor.
    expect(defaultMemoryMax("")).toBe(`${MEMORY_MAX_FLOOR / 2 ** 30}G`);
  });

  test("never more than half the machine, so the scope is still the box's kill", () => {
    expect(defaultMemoryMax(meminfo(8))).toBe("4G");
    expect(defaultMemoryMax(meminfo(4))).toBe("2G");
  });
});

describe("one ceiling for every worker together", () => {
  test("the slice's wall is this machine's RAM less a reserve for the app and the desktop", () => {
    // Three workers at their own 10G asked 30G of a 31.3 GiB laptop while the
    // app peaked at 9.3G, so the sum — not each scope — needed a wall.
    expect(sliceMemoryMax(MEMINFO)).toBe("20G");
    expect(sliceMemoryMax(meminfo(8))).toBe("4G");
    expect(sliceMemoryMax(meminfo(16))).toBe("10G");
    expect(sliceMemoryMax(meminfo(64))).toBe("42G");
    // An unreadable /proc/meminfo is not "no wall for the workers": it is the floor.
    expect(sliceMemoryMax("")).toBe("4G");
  });

  test("a machine of 8 GiB or less gets half its RAM, never the 4G floor", () => {
    // The floor is for an unreadable meminfo: on a 4 GiB box it made the slice
    // the whole machine, and on a 2 GiB one twice the RAM, so there was no sum
    // wall at all and the app and tmux were as exposed as before.
    expect(sliceMemoryMax(meminfo(2))).toBe("1G");
    expect(sliceMemoryMax(meminfo(3))).toBe("1G");
    expect(sliceMemoryMax(meminfo(4))).toBe("2G");
    expect(sliceMemoryMax(meminfo(6))).toBe("3G");
    expect(sliceMemoryMax(meminfo(7.5))).toBe("3G");
  });

  test("the reserve grows to what app.slice already holds, plus 1G", () => {
    // Measured 11.75-12.16 GiB in app.slice's children on this 30.45 GiB
    // machine, against the 10.45G a third reserves: the wall would have been
    // reached only after the box was already over-committed.
    expect(sliceMemoryMax(MEMINFO, 12 * 2 ** 30)).toBe("18G");
    // A quiet app does not move it: the third is the larger reserve.
    expect(sliceMemoryMax(MEMINFO, 2 ** 30)).toBe("20G");
    // And it never takes the workers below half the machine.
    expect(sliceMemoryMax(meminfo(16), 14 * 2 ** 30)).toBe("8G");
  });

  test("what app.slice holds is read from the cgroup, less the worker slice inside it", () => {
    const { root, app, slice } = cgroupRoot("scopes-cgroup-");
    writeFileSync(join(app, "memory.current"), "12000000000\n");
    writeFileSync(join(slice, "memory.current"), "2000000000\n");
    // A restart measures its own workers in the slice; counting them would
    // shrink the wall every time the app came back.
    expect(appSliceBytes(root)).toBe(10_000_000_000);
    expect(appSliceBytes(join(root, "no-such-tree"))).toBe(0);
    // Another login's app is not this machine's reserve.
    const other = temp("scopes-cgroup-other-");
    const uid = typeof process.getuid === "function" ? process.getuid() : 1000;
    const theirs = join(other, "user.slice", `user-${uid + 1}.slice`, "user@1001.service", "app.slice");
    mkdirSync(theirs, { recursive: true });
    writeFileSync(join(theirs, "memory.current"), "9000000000\n");
    expect(appSliceBytes(other)).toBe(0);
  });

  test("the slice is found where systemd nests it, and its pids decide occupancy", () => {
    const { root, slice } = cgroupRoot("scopes-slice-");
    writeFileSync(join(slice, "memory.max"), "max\n");
    writeFileSync(join(slice, "cgroup.procs"), "");
    // Measured on a live, empty slice: pids.current 0, no child cgroup, and
    // 26,341,376 bytes of file and kernel charges left behind.
    writeFileSync(join(slice, "memory.current"), "26341376\n");
    expect(workerSliceFacts(root)).toEqual({ held: 26341376, max: "max", occupied: false });
    // A worker lives one level down, in its own child scope.
    const child = join(slice, "agentglass-child-4242.scope");
    mkdirSync(child);
    writeFileSync(join(child, "cgroup.procs"), "4242\n");
    expect(workerSliceFacts(root)?.occupied).toBe(true);
  });

  test("a subtree nobody could read is occupied, and an absent slice is null", () => {
    const { root, slice } = cgroupRoot("scopes-slice-unreadable-");
    writeFileSync(join(slice, "memory.max"), "21474836480\n");
    // No cgroup.procs at the slice's own level: the tree is unknown, not empty.
    expect(workerSliceFacts(root)?.occupied).toBe(true);
    expect(workerSliceFacts(join(root, "no-such-tree"))).toBeNull();
  });

  test("a pid in the slice's own cgroup, with no nested scope, is not occupancy", () => {
    // systemd never puts a process straight into a .slice — only into a nested
    // scope or service unit — so `tree.own` is always [] in production; a pid
    // landing there is not a worker this boot should ever defer to.
    const { root, slice } = cgroupRoot("scopes-slice-own-only-");
    writeFileSync(join(slice, "memory.max"), "max\n");
    writeFileSync(join(slice, "memory.current"), "26341376\n");
    writeFileSync(join(slice, "cgroup.procs"), "9999\n");
    expect(workerSliceFacts(root)).toEqual({ held: 26341376, max: "max", occupied: false });
  });

  test("just under the wall, and never above it", () => {
    expect(sliceMemoryHigh("20G")).toBe("18G");
    expect(sliceMemoryHigh("4G")).toBe("3G");
    expect(sliceMemoryHigh("42G")).toBe("37G");
    // A wall with no whole GiB under it is its own throttle: a `MemoryHigh`
    // above `MemoryMax` would mean workers are stopped by the wall, never
    // throttled, and the doc promises the throttle.
    expect(sliceMemoryHigh("1G")).toBe("1G");
    expect(sliceMemoryHigh("512M")).toBe("512M");
    expect(sliceMemoryHigh("100M")).toBe("100M");
  });

  test("the slice is given both of its properties before the first scope lands in it", () => {
    const s = scopeSettings({}, {}, MEMINFO);
    expect(s.slice).toBe(WORKER_SLICE);
    expect(s.sliceMemoryMax).toBe("20G");
    expect(s.sliceMemoryHigh).toBe("18G");
    expect(sliceArgv(s)).toEqual([
      "systemctl", "--user", "set-property", "--runtime", WORKER_SLICE, "MemoryMax=20G", "MemoryHigh=18G",
    ]);
  });

  test("the slice sits inside app.slice, the cgroup systemd-oomd watches", () => {
    // systemd makes `a-b.slice` a subslice of `a.slice`, and oomd only considers
    // descendants of the cgroup it watches (.../user@1000.service/app.slice).
    // A sibling of app.slice leaves the app's own scopes and the tmux panes as
    // its only candidates, which is the opposite of what the slice is for.
    expect(WORKER_SLICE).toBe("app-agentglass-workers.slice");
    const ancestors: string[] = [];
    let name = WORKER_SLICE.replace(/\.slice$/, "");
    while (name.includes("-")) {
      name = name.slice(0, name.lastIndexOf("-"));
      ancestors.push(`${name}.slice`);
    }
    expect(ancestors).toContain("app.slice");
    expect(ancestors, "not the root slice").not.toContain("-.slice");
  });

  test("every child names the slice, and keeps a wall of its own as the second one", () => {
    const one = scopeArgv(["opencode", "serve"], {
      settings, run: "/usr/bin/systemd-run", unit: "agentglass-child-7-1", slice: WORKER_SLICE,
    });
    expect(one.argv).toContain(`--slice=${WORKER_SLICE}`);
    expect(one.argv).toContain("MemoryMax=3G");
    expect(one.argv).toContain("MemorySwapMax=0");
  });

  test("the per-scope override still wins, and the slice has one of its own", () => {
    const laptop = scopeSettings({ AGENTGLASS_SCOPE_MEMORY_MAX: "7G" }, {}, MEMINFO);
    expect(laptop.memoryMax, "the interim laptop setting is the second wall").toBe("7G");
    expect(laptop.sliceMemoryMax).toBe("20G");
    expect(scopeSettings({ AGENTGLASS_SLICE_MEMORY_MAX: "12G" }, {}, MEMINFO).sliceMemoryMax).toBe("12G");
    expect(scopeSettings({ AGENTGLASS_SLICE_MEMORY_MAX: "12G" }, {}, MEMINFO).sliceMemoryHigh).toBe("10G");
    expect(scopeSettings({}, { sliceMemoryMax: "8G" }, MEMINFO).sliceMemoryMax).toBe("8G");
    expect(scopeSettings({ AGENTGLASS_SLICE_MEMORY_MAX: "a lot" }, {}, MEMINFO).sliceMemoryMax).toBe("20G");
  });

  test("a hand-started server says nothing about a clamp it did not apply", () => {
    const said: string[] = [];
    const big = { ...settings, sliceMemoryMax: "10G", sliceMemoryHigh: "9G", sliceClamped: true };
    expect(ensureWorkerSlice({
      settings: big, readOnly: true, read: () => "10G", log: (line) => { said.push(line); },
    })).toBe(true);
    expect(said.some((line) => line.includes("clamped"))).toBe(false);
  });

  test("a configured slice is clamped to what the machine can give, and says so once", () => {
    // A `config.json` copied from a 64G desktop onto a 16G laptop: a 64G wall is
    // no wall, and nothing else would have reported it.
    const big = scopeSettings({ AGENTGLASS_SLICE_MEMORY_MAX: "64G" }, {}, meminfo(16));
    expect(big.sliceMemoryMax).toBe("10G");
    expect(big.sliceClamped).toBe(true);
    expect(scopeSettings({}, { sliceMemoryMax: "64G" }, meminfo(16)).sliceClamped).toBe(true);
    // The clamp is the wall the reserve would have derived, not the machine
    // minus 4G: an 8G box whose app already holds 5G keeps only 4G for workers.
    const tight = scopeSettings({ AGENTGLASS_SLICE_MEMORY_MAX: "24G" }, {}, meminfo(8), 5 * 2 ** 30);
    expect(tight.sliceMemoryMax).toBe("4G");
    expect(tight.sliceClamped).toBe(true);
    // A value the machine can honour is left alone, and a derived one is never marked.
    expect(scopeSettings({ AGENTGLASS_SLICE_MEMORY_MAX: "10G" }, {}, meminfo(16)).sliceClamped).toBeUndefined();
    expect(scopeSettings({}, {}, meminfo(16)).sliceClamped).toBeUndefined();
    const said: string[] = [];
    ensureWorkerSlice({ settings: big, run: () => true, log: (line) => { said.push(line); } });
    expect(said.filter((line) => line.includes("clamped")).length).toBe(1);
    // The line is said once, not on every launch.
    ensureWorkerSlice({ settings: big, run: () => true, log: (line) => { said.push(line); } });
    expect(said.filter((line) => line.includes("clamped")).length).toBe(1);
  });

  test("boot keeps a larger wall while the slice still holds workers", () => {
    // Measured on a 30.45G box: with app.slice at 12.35G a 20G setting derives
    // 17G/15G, and three workers holding 18G would be throttled at 15G before
    // adoption runs. The wall already on the cgroup wins while it is occupied.
    const said: string[] = [];
    const asked: string[][] = [];
    const run = (argv: readonly string[]) => { asked.push([...argv]); return true; };
    const lower = { ...settings, sliceMemoryMax: "17G", sliceMemoryHigh: "15G" };
    expect(ensureWorkerSlice({
      settings: lower, run, sliceNow: () => ({ held: 18 * 2 ** 30, max: "21474836480", occupied: true }), log: (line) => { said.push(line); },
    })).toBe(true);
    expect(asked).toEqual([sliceArgv({ ...lower, sliceMemoryMax: "20G", sliceMemoryHigh: "18G" })]);
    expect(appliedSliceMemoryMax()).toBe("20G");
    expect(said.some((line) => line.includes("keeps 20G"))).toBe(true);
    // Empty: the lower wall is written, so the next boot does not keep it for ever.
    asked.length = 0;
    expect(ensureWorkerSlice({
      settings: lower, run, sliceNow: () => ({ held: 0, max: "21474836480", occupied: false }), log: () => {},
    })).toBe(true);
    expect(asked).toEqual([sliceArgv(lower)]);
    expect(appliedSliceMemoryMax()).toBe("17G");
  });

  test("an empty slice that still charges memory takes the new wall", () => {
    // A live but empty slice keeps file and kernel charges — measured 26,341,376
    // bytes with pids.current 0 — so memory is no evidence of a worker in it.
    const asked: string[][] = [];
    const said: string[] = [];
    const lower = { ...settings, sliceMemoryMax: "17G", sliceMemoryHigh: "15G" };
    expect(ensureWorkerSlice({
      settings: lower,
      run: (argv) => { asked.push([...argv]); return true; },
      sliceNow: () => ({ held: 26341376, max: "max", occupied: false }),
      log: (line) => { said.push(line); },
    })).toBe(true);
    expect(asked).toEqual([sliceArgv(lower)]);
    expect(said.some((line) => line.includes("holds workers"))).toBe(false);
  });

  test("the keeps line names what it holds, not a rounded GiB", () => {
    const said: string[] = [];
    ensureWorkerSlice({
      settings: { ...settings, sliceMemoryMax: "17G", sliceMemoryHigh: "15G" },
      run: () => true,
      sliceNow: () => ({ held: 314572800, max: "21474836480", occupied: true }),
      log: (line) => { said.push(line); },
    });
    expect(said.some((line) => line.includes("keeps 20G") && line.includes("holds 300M"))).toBe(true);
    expect(said.some((line) => line.includes("holds 1G"))).toBe(false);
  });

  test("a wall answered in plain bytes is compared in bytes, not by its label", () => {
    // `systemctl show` prints 30G+4K as 32212258816, which the module's own size
    // pattern refuses (8 digits): read as a label, the standing wall counted 0
    // and the guard lowered a wall it had just read.
    const asked: string[][] = [];
    const said: string[] = [];
    const run = (argv: readonly string[]) => { asked.push([...argv]); return true; };
    expect(ensureWorkerSlice({
      settings, run,
      sliceNow: () => ({ held: 24 * 2 ** 30, max: "32212258816", occupied: true }),
      log: (line) => { said.push(line); },
    })).toBe(true);
    expect(asked).toEqual([sliceArgv({ ...settings, sliceMemoryMax: "31457284K", sliceMemoryHigh: "31457284K" })]);
    expect(appliedSliceMemoryMax()).toBe("31457284K");
    expect(said.some((line) => line.includes("keeps 31457284K"))).toBe(true);
    // A smaller wall, also in bytes, is still lowered.
    asked.length = 0;
    expect(ensureWorkerSlice({
      settings, run,
      sliceNow: () => ({ held: 2 ** 30, max: "2147483648", occupied: true }),
      log: () => {},
    })).toBe(true);
    expect(asked).toEqual([sliceArgv(settings)]);
  });

  test("an occupied slice with no readable wall is left alone, not walled under them", () => {
    const said: string[] = [];
    let ran = false;
    expect(ensureWorkerSlice({
      settings: { ...settings, sliceMemoryMax: "17G", sliceMemoryHigh: "15G" },
      run: () => { ran = true; return true; },
      sliceNow: () => ({ held: 2 * 2 ** 30, max: "max", occupied: true }),
      log: (line) => { said.push(line); },
    })).toBe(false);
    expect(ran).toBe(false);
    expect(appliedSliceMemoryMax()).toBeNull();
    expect(said.some((line) => line.includes("left alone rather than lowered"))).toBe(true);
  });

  test("no user systemd: the launch the app had before, one line, and nothing fails", () => {
    const said: string[] = [];
    const log = (line: string) => { said.push(line); };
    expect(ensureWorkerSlice({ settings, run: null, log })).toBe(false);
    expect(said.length).toBe(1);
    expect(said[0]).toContain("not in one slice");
    expect(said[0]).toContain("no user systemd");
    // The line says the sum is unbounded again: "each keeps its own ceiling"
    // alone reads as if three of them were still bounded.
    expect(said[0]).toContain("sum has no wall");
    // A second launch is not a second line: the journal already has it.
    expect(ensureWorkerSlice({ settings, run: null, log })).toBe(false);
    expect(said.length).toBe(1);
    expect(workerSliceUsable()).toBe(false);
    // And a launch still happens: exactly the argv from before the slice existed.
    const plain = scopeArgv(["opencode", "serve"], { settings, run: "/usr/bin/systemd-run", unit: "agentglass-child-9-1" });
    expect(plain.argv).toEqual([
      "/usr/bin/systemd-run", "--quiet", "--user", "--scope", "--collect", "--unit=agentglass-child-9-1",
      "-p", "MemoryMax=3G", "-p", "MemorySwapMax=0",
      "--", "opencode", "serve",
    ]);
  });

  test("a slice that will not take its walls: the same fallback, one line", () => {
    const said: string[] = [];
    const log = (line: string) => { said.push(line); };
    expect(ensureWorkerSlice({ settings, run: () => false, log })).toBe(false);
    expect(said.length).toBe(1);
    expect(said[0]).toContain("would not take its ceiling");
    expect(said[0]).toContain("sum has no wall");
    expect(workerSliceUsable()).toBe(false);
  });

  test("a failed slice is retried, and coming back is one line", () => {
    // A user manager still starting, or a full /run, costs one attempt and not
    // the rest of the process's life: the retry is the sweep's clock.
    const odd = { ...settings, slice: "app-agx-retry.slice" };
    const said: string[] = [];
    const log = (line: string) => { said.push(line); };
    expect(ensureWorkerSlice({ settings: odd, run: () => false, log })).toBe(false);
    const asked: string[][] = [];
    const run = (argv: readonly string[]) => { asked.push([...argv]); return true; };
    expect(ensureWorkerSlice({ settings: odd, run, log })).toBe(true);
    expect(asked).toEqual([sliceArgv(odd)]);
    expect(said.filter((line) => line.includes("back in")).length).toBe(1);
    expect(workerSliceUsable()).toBe(true);
  });

  test("a slice that does: the scopes go back into it", () => {
    const asked: string[][] = [];
    const run = (argv: readonly string[]) => { asked.push([...argv]); return true; };
    // The log is swallowed: whether a recovery line is owed depends on the
    // slice's state when this row runs, which is another row's business.
    expect(ensureWorkerSlice({ settings, run, log: () => {} })).toBe(true);
    expect(asked).toEqual([sliceArgv(settings)]);
    expect(workerSliceUsable()).toBe(true);
    const scoped = scopeArgv(["true"], { settings, run: "/bin/true", unit: "agentglass-child-9-2" });
    expect(scoped.argv).toContain(`--slice=${WORKER_SLICE}`);
  });

  test("a clamp is announced only by a write that was applied", () => {
    // After the one-line rows above: a reason is said once per process.
    const said: string[] = [];
    const big = { ...settings, sliceMemoryMax: "10G", sliceMemoryHigh: "9G", sliceClamped: true };
    // Its own slice name, so the row above's announcement is not what answers.
    const probe = { ...big, slice: "app-agx-clamp-probe.slice" };
    // A write systemd refused, and a wall kept: neither wrote the clamped
    // value, so neither says it was applied.
    expect(ensureWorkerSlice({
      settings: probe, run: () => false, log: (line) => { said.push(line); },
    })).toBe(false);
    expect(ensureWorkerSlice({
      settings: probe, run: () => true,
      sliceNow: () => ({ held: 2 ** 30, max: "21474836480", occupied: true }),
      log: (line) => { said.push(line); },
    })).toBe(true);
    expect(said.filter((line) => line.includes("clamped")).length).toBe(0);
  });
});

describe("a process that is not the app's own copy", () => {
  test("reads the slice's effective wall and never writes it", () => {
    const wrote: string[][] = [];
    expect(ensureWorkerSlice({
      settings, readOnly: true, read: () => "20G",
      run: (argv) => { wrote.push([...argv]); return true; },
    })).toBe(true);
    expect(wrote, "a hand-started server wrote the machine-wide drop-in").toEqual([]);
    expect(workerSliceUsable()).toBe(true);
    expect(appliedSliceMemoryMax()).toBe("20G");
    const scoped = scopeArgv(["true"], { settings, run: "/bin/true", unit: "agentglass-child-9-3" });
    expect(scoped.argv).toContain(`--slice=${WORKER_SLICE}`);
  });

  test("an unwalled slice: no --slice=, and one line that says why", () => {
    const said: string[] = [];
    expect(ensureWorkerSlice({ settings, readOnly: true, read: () => "infinity", log: (line) => { said.push(line); } })).toBe(false);
    expect(workerSliceUsable()).toBe(false);
    expect(appliedSliceMemoryMax()).toBeNull();
    const lines = said.filter((line) => line.includes("no ceiling"));
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain("sum has no wall");
    const plain = scopeArgv(["opencode", "serve"], { settings, run: "/usr/bin/systemd-run", unit: "agentglass-child-9-4" });
    expect(plain.argv.join(" ")).not.toContain("--slice=");
  });

  test("a slice that cannot be read is not a walled one", () => {
    expect(ensureWorkerSlice({ settings, readOnly: true, read: () => null, log: () => {} })).toBe(false);
    expect(workerSliceUsable()).toBe(false);
  });

  test("systemd's own byte answer is a wall, not an unreadable one", () => {
    // `systemctl --user show -p MemoryMax` prints bytes: a 300M wall is
    // `314572800` and a 20G wall is `21474836480`. The size pattern caps at
    // seven digits, so both used to read as "no ceiling".
    expect(ensureWorkerSlice({ settings, readOnly: true, read: () => "314572800", log: () => {} })).toBe(true);
    expect(appliedSliceMemoryMax()).toBe("300M");
    expect(ensureWorkerSlice({ settings, readOnly: true, read: () => "21474836480", log: () => {} })).toBe(true);
    expect(appliedSliceMemoryMax()).toBe("20G");
    expect(scopeArgv(["true"], { settings, run: "/bin/true", unit: "agentglass-child-9-5" }).argv)
      .toContain(`--slice=${WORKER_SLICE}`);
  });
});

describe("the old worker slice", () => {
  const loaded = `LoadState=loaded\nActiveState=active\nControlGroup=/user.slice/user-1000.slice/user@1000.service/agentglass.slice/${LEGACY_WORKER_SLICE}\n`;

  test("loaded and empty: one line and a stop", () => {
    const said: string[] = [];
    const stopped: string[] = [];
    expect(retireLegacySlice({
      show: () => loaded,
      procs: () => [],
      stop: (unit) => { stopped.push(unit); return true; },
      log: (line) => { said.push(line); },
    })).toBe("stopped");
    expect(stopped).toEqual([LEGACY_WORKER_SLICE]);
    expect(said.length).toBe(1);
    expect(said[0]).toContain("stopped the old worker slice");
  });

  test("loaded with a process: left alone, and the line says why", () => {
    const said: string[] = [];
    let stopped = false;
    expect(retireLegacySlice({
      show: () => loaded,
      procs: () => [4242],
      stop: () => { stopped = true; return true; },
      log: (line) => { said.push(line); },
    })).toBe("kept");
    expect(stopped).toBe(false);
    expect(said.length).toBe(1);
    expect(said[0]).toContain("1 process");
  });

  test("not loaded, unreadable, or a foreign cgroup: nothing is stopped", () => {
    let stopped = false;
    const stop = () => { stopped = true; return true; };
    expect(retireLegacySlice({ show: () => "LoadState=not-found\nControlGroup=\n", stop })).toBe("absent");
    expect(retireLegacySlice({ show: () => "LoadState=loaded\nActiveState=inactive\nControlGroup=\n", stop })).toBe("absent");
    expect(retireLegacySlice({ show: () => null, stop })).toBe("unknown");
    expect(retireLegacySlice({
      show: () => "LoadState=loaded\nActiveState=active\nControlGroup=/user.slice/user-1000.slice/user@1000.service/other.slice\n", stop,
    })).toBe("unknown");
    expect(stopped).toBe(false);
  });
});

describe("a run the scope OOM killed", () => {
  const unit = `${SCOPE_PREFIX}1-acme-1.scope`;
  const events = (oomKill: number): string => `low 0\nhigh 0\nmax 0\noom 0\noom_kill ${oomKill}\noom_group_kill 0\n`;

  test("says so, with the ceiling, instead of the engine's socket dying", () => {
    noteRunScope("acme-orbit", unit);
    const read = (u: string): string | null => u === unit ? events(2) : null;
    // The child's counter cannot say which memory.max fired, so both walls are
    // named: the per-scope one alone is a ceiling that may never have bound.
    expect(runOutOfMemory("acme-orbit", { events: read, ceiling: "10G", sliceCeiling: "20G" })).toBe("10G, shared 20G");
    expect(oomKills(events(2))).toBe(2);
    expect(oomKills("oom 3\n"), "a cgroup under OOM is not a kill").toBe(0);
  });

  test("a kill names both walls, so neither is reported as the one that bound", () => {
    // On the reference laptop the per-scope setting is 7G and the slice 20G;
    // three workers reach 20G and the one killed is told 7G, whose raising
    // changes nothing. The slice's `memory.max` still reports in the child's
    // `memory.events`, so the sentence names both numbers.
    noteRunScope("acme-orbit-shared", unit);
    const read = (u: string): string | null => u === unit ? events(1) : null;
    expect(runOutOfMemory("acme-orbit-shared", { events: read, ceiling: "7G", sliceCeiling: "5G" })).toBe("7G, shared 5G");
    // A process that is not using the slice reports its own ceiling alone.
    expect(runOutOfMemory("acme-orbit-shared", { events: read, ceiling: "7G", sliceCeiling: null })).toBe("7G");
  });

  test("the shared wall named is the one that was applied, not a later reading", () => {
    // The drop-in is written once. app.slice's live size moves, so a number
    // recomputed at report time can name a wall nobody set.
    noteRunScope("acme-orbit-applied", unit);
    const read = (u: string): string | null => u === unit ? events(1) : null;
    expect(ensureWorkerSlice({ settings: { ...settings, sliceMemoryMax: "20G" }, run: () => true, log: () => {} })).toBe(true);
    const before = process.env.AGENTGLASS_SLICE_MEMORY_MAX;
    process.env.AGENTGLASS_SLICE_MEMORY_MAX = "8G";
    try {
      expect(runOutOfMemory("acme-orbit-applied", { events: read, ceiling: "7G" })).toBe("7G, shared 20G");
    } finally {
      if (before === undefined) delete process.env.AGENTGLASS_SLICE_MEMORY_MAX;
      else process.env.AGENTGLASS_SLICE_MEMORY_MAX = before;
    }
  });

  test("a scope not killed, unreadable, or absent says nothing", () => {
    noteRunScope("acme-orbit-quiet", unit);
    expect(runOutOfMemory("acme-orbit-quiet", { events: () => events(0), ceiling: "10G" })).toBeNull();
    expect(runOutOfMemory("acme-orbit-quiet", { events: () => null, ceiling: "10G" })).toBeNull();
    expect(runOutOfMemory("acme-orbit-tui", { unit: null, events: () => events(1) })).toBeNull();
    expect(runOutOfMemory("acme-orbit-unlaunched", { events: () => events(1) })).toBeNull();
  });
});

describe("the argv of one child", () => {
  test("its own transient scope, in the worker slice, with a memory ceiling and no swap", () => {
    const s = scopeArgv(["opencode", "serve"], {
      settings, run: "/usr/bin/systemd-run", unit: "agentglass-child-7-1", slice: WORKER_SLICE,
    });
    expect(s.unit).toBe("agentglass-child-7-1");
    expect(s.argv).toEqual([
      "/usr/bin/systemd-run", "--quiet", "--user", "--scope", "--collect", "--unit=agentglass-child-7-1",
      `--slice=${WORKER_SLICE}`,
      "-p", "MemoryMax=3G", "-p", "MemorySwapMax=0",
      "--", "opencode", "serve",
    ]);
  });

  test("a unit of its own per launch", () => {
    const a = scopeArgv(["true"], { settings, run: "/bin/true" });
    const b = scopeArgv(["true"], { settings, run: "/bin/true" });
    expect(a.unit).not.toBe(b.unit);
    expect(a.unit!.startsWith(SCOPE_PREFIX)).toBe(true);
  });

  test("a child environment with no user manager is not scoped, even with the binary on PATH", () => {
    const bin = temp("scopes-run-");
    writeFileSync(join(bin, "systemd-run"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const path = `${bin}:/usr/bin:/bin`;
    expect(systemdRun({ PATH: path } as NodeJS.ProcessEnv)).toBeNull();
    expect(systemdRun({ PATH: path, XDG_RUNTIME_DIR: "/run/user/1000" } as NodeJS.ProcessEnv)).toBe(join(bin, "systemd-run"));
  });

  test("no systemd-run, or the off switch: the command is launched as it was", () => {
    expect(scopeArgv(["true"], { settings, run: null })).toEqual({ argv: ["true"], unit: null });
    const off = { ...settings, on: false };
    expect(scopeArgv(["true"], { settings: off, run: "/usr/bin/systemd-run" })).toEqual({ argv: ["true"], unit: null });
  });

  test("the worker's private server is launched through it, and is still that server", () => {
    const wrapped = serveLaunch("/usr/bin/opencode", {}, {
      run: "/usr/bin/systemd-run", unit: "agentglass-child-1-1", settings, slice: WORKER_SLICE,
    });
    expect(wrapped.argv.slice(0, 6)).toEqual([
      "/usr/bin/systemd-run", "--quiet", "--user", "--scope", "--collect", "--unit=agentglass-child-1-1",
    ]);
    expect(wrapped.argv).toContain(`--slice=${WORKER_SLICE}`);
    expect(wrapped.argv.slice(12)).toEqual(["/usr/bin/opencode", "serve", "--hostname", "127.0.0.1", "--port", "0"]);
    const plain = serveLaunch("/usr/bin/opencode", {}, { run: null, settings });
    expect(plain.argv).toEqual(["/usr/bin/opencode", "serve", "--hostname", "127.0.0.1", "--port", "0"]);
  });

  test("a probe really runs behind systemd-run, and its output still arrives", async () => {
    const bin = temp("scopes-bin-");
    const record = join(bin, "argv.txt");
    const shim = join(bin, "systemd-run");
    writeFileSync(shim, [
      "#!/bin/sh",
      'printf "%s\\n" "$@" >> "$SCOPE_RECORD"',
      'printf -- "---\\n" >> "$SCOPE_RECORD"',
      'while [ "$1" != "--" ]; do shift; done',
      "shift",
      'exec "$@"',
    ].join("\n"));
    chmodSync(shim, 0o755);
    // systemdRun() only wraps where a user runtime dir exists (a container has none), so the test names one.
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}`, SCOPE_RECORD: record, XDG_RUNTIME_DIR: bin } as Record<string, string>;

    /* An explicit ceiling, so the row does not move with the test machine's
       RAM: what is under test is that the default path applies one at all. */
    process.env.AGENTGLASS_SCOPE_MEMORY_MAX = "3G";
    const r = await runCommand(["sh", "-c", "printf probe-ok"], 10_000, { env });
    expect(r.out).toBe("probe-ok");
    expect(r.code).toBe(0);
    const said = readFileSync(record, "utf8");
    expect(said).toContain("--scope");
    expect(said).toContain("MemoryMax=3G");
    expect(said).toContain("MemorySwapMax=0");
    expect(said).toContain("sh");

    rmSync(record, { force: true });
    process.env.AGENTGLASS_SCOPES = "0";
    try {
      const plain = await runCommand(["sh", "-c", "printf probe-ok"], 10_000, { env });
      expect(plain.out).toBe("probe-ok");
      expect(readdirSync(bin).includes("argv.txt")).toBe(false);
    } finally {
      delete process.env.AGENTGLASS_SCOPES;
      delete process.env.AGENTGLASS_SCOPE_MEMORY_MAX;
    }
  });
});

describe("what this process stops on the way out", () => {
  test("its own child scopes, and never the app's own", () => {
    rememberScope(`${SCOPE_PREFIX}4242-1`);
    rememberScope(`${APP_SCOPE_PREFIX}4242.scope`);
    const stopped: string[] = [];
    const done = stopOwnScopes((u) => { stopped.push(u); });
    expect(done).toContain(`${SCOPE_PREFIX}4242-1`);
    expect(stopped).toContain(`${SCOPE_PREFIX}4242-1`);
    // The app scope is not this process's to stop: a tmux server may sit in it.
    expect(stopped.some((u) => u.startsWith(APP_SCOPE_PREFIX))).toBe(false);
    expect(ownScopes().size).toBe(0);
  });

  test("a name outside the prefix is never remembered", () => {
    expect(rememberScope("agentglass-tmux-1.scope")).toBe(false);
    expect(rememberScope("app-agentglass-electron-9.scope")).toBe(false);
    expect(ownScopes().has("agentglass-tmux-1.scope")).toBe(false);
    expect(ownScopes().has("app-agentglass-electron-9.scope")).toBe(false);
  });
});

const app = `${APP_SCOPE_PREFIX}1156150.scope`;
const other = `${APP_SCOPE_PREFIX}999.scope`;
const HOUR = 3_600_000;

/** One process in a cgroup below the scope's own: the pid is what its age is
 *  read from, so it travels with the comm. */
function below(pid: number, comm: string): { pid: number; comm: string } {
  return { pid, comm };
}

function fact(
  unit: string, mainPid: number, procs: number[],
  comms: string[] = procs.map(() => "bun"), nested: { pid: number; comm: string }[] | null = [],
) {
  return { unit, mainPid, procs, comms, nested };
}

describe("what the sweep picks", () => {
  const now = { list: () => [app], minAgeMs: 6 * HOUR, selfPid: 1, alive: () => false, log: () => {} };

  test("an app scope whose leader is gone and whose youngest child is over six hours", () => {
    const stopped: string[] = [];
    const picked = reapStaleScopes({
      ...now,
      fact: () => fact(app, 1156150, [10, 11]),
      ageMs: () => new Map([[10, 57 * HOUR], [11, 8 * HOUR]]),
      stop: (u) => { stopped.push(u); },
    });
    expect(picked).toEqual([app]);
    expect(stopped).toEqual([app]);
  });

  test("nothing while its leader is alive: that is a running app", () => {
    const stopped: string[] = [];
    const picked = reapStaleScopes({
      ...now,
      alive: (pid) => pid === 1156150,
      fact: () => fact(app, 1156150, [10]),
      ageMs: () => new Map([[10, 57 * HOUR]]),
      stop: (u) => { stopped.push(u); },
    });
    expect(picked).toEqual([]);
    expect(stopped).toEqual([]);
  });

  test("nothing younger than the ceiling: a child that just started is not a leftover", () => {
    const stopped: string[] = [];
    const picked = reapStaleScopes({
      ...now,
      fact: () => fact(app, 0, [10, 11]),
      ageMs: () => new Map([[10, 57 * HOUR], [11, 5 * HOUR]]),
      stop: (u) => { stopped.push(u); },
    });
    expect(picked).toEqual([]);
    expect(stopped).toEqual([]);
  });

  test("nothing with no processes left, and never this server's own cgroup", () => {
    const stopped: string[] = [];
    expect(reapStaleScopes({ ...now, fact: () => fact(app, 0, []), stop: (u) => { stopped.push(u); } })).toEqual([]);
    expect(reapStaleScopes({
      ...now,
      selfPid: 11,
      fact: () => fact(app, 0, [10, 11]),
      ageMs: () => new Map([[10, 57 * HOUR], [11, 57 * HOUR]]),
      stop: (u) => { stopped.push(u); },
    })).toEqual([]);
    expect(stopped).toEqual([]);
  });

  test("a scope whose processes all moved one cgroup down is still reaped", () => {
    // The leader dying empties the app's own cgroup and leaves every payload in
    // a nested scope: that is the shape this sweep exists for, not nothing.
    const moved = { ...fact(app, 0, []), nested: [below(20, "opencode"), below(21, "git")] };
    expect(staleAppScope(moved, 57 * HOUR, 6 * HOUR, 1)).toBe(true);
    expect(staleAppScope(moved, 1 * HOUR, 6 * HOUR, 1)).toBe(false);
    // A child scope reads the same: its own cgroup empty, its payload below.
    const child = `${SCOPE_PREFIX}4242-ab12-1.scope`;
    expect(staleChildScope(child, 57 * HOUR, 6 * HOUR, 1, 4242, false, [], [], moved.nested)).toBe(true);
    const stopped: string[] = [];
    const picked = reapStaleScopes({
      ...now,
      fact: () => moved,
      ageMs: () => new Map([[20, 57 * HOUR], [21, 57 * HOUR]]),
      stop: (u) => { stopped.push(u); },
    });
    expect(picked).toEqual([app]);
    expect(stopped).toEqual([app]);
  });

  test("only this app's scopes are asked about: a tmux unit is not this sweep's business", () => {
    const stopped: string[] = [];
    const asked: string[] = [];
    const picked = reapStaleScopes({
      ...now,
      list: () => ["agentglass-tmux.service", "session-1.scope"],
      fact: (u) => { asked.push(u); return fact(u, 0, [10]); },
      ageMs: () => new Map([[10, 57 * HOUR]]),
      stop: (u) => { stopped.push(u); },
    });
    expect(picked).toEqual([]);
    expect(stopped).toEqual([]);
    expect(asked).toEqual([]);
  });

  test("a child scope whose server is gone is reaped once it is old enough", () => {
    const child = `${SCOPE_PREFIX}4242-ab12-1.scope`;
    const stopped: string[] = [];
    const reap = (ownerAlive: boolean, unit = child) => reapStaleScopes({
      ...now,
      list: () => [unit],
      alive: (pid) => ownerAlive && pid === 4242,
      fact: () => fact(unit, 777, [10]),
      ageMs: () => new Map([[10, 7 * HOUR]]),
      stop: (u) => { stopped.push(u); },
    });
    // The payload's own pid answering says nothing: the server in the name is
    // the identity, and it is gone.
    expect(reap(false)).toEqual([child]);
    expect(reap(true)).toEqual([]);
    expect(reap(false, `${SCOPE_PREFIX}not-a-pid.scope`)).toEqual([]);
    expect(stopped).toEqual([child]);
  });

  test("a scope the boot pass adopted is never aged out, whatever the ceiling", () => {
    // A ceiling below a turn's length is a legitimate setting, and the age of a
    // scope is not a fact about whether the turn in it is still working.
    const child = `${SCOPE_PREFIX}4242-ab12-1.scope`;
    const stopped: string[] = [];
    const picked = reapStaleScopes({
      ...now,
      list: () => [child],
      fact: () => fact(child, 777, [10]),
      ageMs: () => new Map([[10, 7 * HOUR]]),
      keep: () => new Set([child]),
      stop: (u) => { stopped.push(u); },
    });
    expect(picked).toEqual([]);
    expect(stopped).toEqual([]);
  });

  test("a leftover child scope that holds a tmux server is never stopped", () => {
    // An agent's own turn runs tmux inside the scope its private server got, so
    // that scope holds live panes too: the same rule has to reach it, and the
    // owner pid in its name being gone does not make the panes dead.
    const child = `${SCOPE_PREFIX}4242-ab12-1.scope`;
    const plain = { ...fact(child, 777, [10, 11]), comms: ["opencode", "bun"] };
    const withTmux = { ...fact(child, 777, [10, 11]), comms: ["opencode", "tmux: server"] };
    expect(staleChildScope(child, 7 * HOUR, 6 * HOUR, 1, 4242, false, [10, 11], plain.comms, [])).toBe(true);
    expect(staleChildScope(child, 7 * HOUR, 6 * HOUR, 1, 4242, false, [10, 11], withTmux.comms, [])).toBe(false);
    const stopped: string[] = [];
    const picked = reapStaleScopes({
      ...now,
      list: () => [child],
      fact: () => withTmux,
      ageMs: () => new Map([[10, 7 * HOUR], [11, 7 * HOUR]]),
      stop: (u) => { stopped.push(u); },
    });
    expect(picked).toEqual([]);
    expect(stopped).toEqual([]);
  });

  test("a leftover app scope that holds a tmux server is never stopped", () => {
    const old = `${APP_SCOPE_PREFIX}7.scope`;
    const plain = { ...fact(old, 0, [10, 11]), comms: ["git", "bun"] };
    const withTmux = { ...fact(old, 0, [10, 11]), comms: ["git", "tmux: server"] };
    expect(staleAppScope(plain, 57 * HOUR, 6 * HOUR, 1)).toBe(true);
    expect(staleAppScope(withTmux, 57 * HOUR, 6 * HOUR, 1)).toBe(false);
  });

  test("the rule itself refuses a unit that is not an app or child scope", () => {
    expect(staleAppScope(fact("session-1.scope", 0, [10]), 57 * HOUR, 6 * HOUR, 1)).toBe(false);
    expect(staleAppScope(fact(`${SCOPE_PREFIX}1-1`, 0, [10]), 57 * HOUR, 6 * HOUR, 1)).toBe(false);
    expect(staleAppScope(fact(app, 0, [10]), 57 * HOUR, 6 * HOUR, 1)).toBe(true);
    expect(staleChildScope("session-1.scope", 57 * HOUR, 6 * HOUR, 1, 4242, false, [10], ["bun"], [])).toBe(false);
    expect(staleChildScope(`${SCOPE_PREFIX}4242-ab12-1.scope`, 57 * HOUR, 6 * HOUR, 1, 4242, false, [10], ["bun"], [])).toBe(true);
    expect(staleChildScope(`${SCOPE_PREFIX}4242-ab12-1.scope`, 1 * HOUR, 6 * HOUR, 1, 4242, false, [10], ["bun"], [])).toBe(false);
    expect(staleChildScope(`${SCOPE_PREFIX}4242-ab12-1.scope`, 57 * HOUR, 6 * HOUR, 1, 4242, true, [10], ["bun"], [])).toBe(false);
    expect(staleChildScope(`${SCOPE_PREFIX}4242-ab12-1.scope`, 57 * HOUR, 6 * HOUR, 1, null, false, [10], ["bun"], [])).toBe(false);
    expect(staleChildScope(`${SCOPE_PREFIX}4242-ab12-1.scope`, 57 * HOUR, 6 * HOUR, 1, 4242, false, [1, 10], ["bun", "bun"], [])).toBe(false);
    expect(staleChildScope(`${SCOPE_PREFIX}4242-ab12-1.scope`, 57 * HOUR, 6 * HOUR, 1, 4242, false, [], [], [])).toBe(false);
  });

  test("the owner pid comes from the unit name, and nowhere else", () => {
    expect(childScopeOwner(`${SCOPE_PREFIX}4242-ab12-1.scope`)).toBe(4242);
    expect(childScopeOwner(`${SCOPE_PREFIX}not-a-pid.scope`)).toBeNull();
    expect(childScopeOwner("app-agentglass-electron-4242.scope")).toBeNull();
  });

  test("a read that failed is not a fact: nothing is stopped", () => {
    const stopped: string[] = [];
    expect(reapStaleScopes({ ...now, list: () => null, stop: (u) => { stopped.push(u); } })).toEqual([]);
    expect(reapStaleScopes({ ...now, fact: () => null, stop: (u) => { stopped.push(u); } })).toEqual([]);
    // A pid that vanished between the cgroup read and the age read makes the
    // numbers incomplete, and an incomplete set is not a verdict.
    expect(reapStaleScopes({
      ...now,
      fact: () => fact(app, 0, [10, 11]),
      ageMs: () => new Map([[10, 57 * HOUR]]),
      stop: (u) => { stopped.push(u); },
    })).toEqual([]);
    expect(stopped).toEqual([]);
  });

  test("the fact must be about the unit that was asked for", () => {
    const stopped: string[] = [];
    const picked = reapStaleScopes({
      ...now,
      list: () => [app],
      fact: () => fact(other, 0, [10]),
      ageMs: () => new Map([[10, 57 * HOUR]]),
      stop: (u) => { stopped.push(u); },
    });
    expect(picked).toEqual([]);
    expect(stopped).toEqual([]);
  });
});

describe("what the sweep keeps when it cannot tell", () => {
  const child = `${SCOPE_PREFIX}4242-ab12-1.scope`;
  const now = { list: () => [app], minAgeMs: 6 * HOUR, selfPid: 1, alive: () => false, log: () => {} };

  test("a comm that could not be read is unknown, and unknown keeps the scope", () => {
    const unread = fact(app, 0, [10, 11], ["chromium", ""]);
    expect(holdsLiveWork(unread.procs, unread.comms, unread.nested)).toBe(true);
    expect(staleAppScope(unread, 57 * HOUR, 6 * HOUR, 1)).toBe(false);
    expect(staleChildScope(child, 57 * HOUR, 6 * HOUR, 1, 4242, false, [10, 11], ["bun", ""], [])).toBe(false);

    const stopped: string[] = [];
    expect(reapStaleScopes({
      ...now,
      fact: () => unread,
      ageMs: () => new Map([[10, 57 * HOUR], [11, 57 * HOUR]]),
      stop: (u) => { stopped.push(u); },
    })).toEqual([]);
    expect(stopped).toEqual([]);
    // The same scope with both comms read is the row above: it is a leftover.
    expect(staleAppScope(fact(app, 0, [10, 11], ["chromium", "bun"]), 57 * HOUR, 6 * HOUR, 1)).toBe(true);
  });

  test("a comm missing from the fact is unknown too, not a shorter list", () => {
    expect(holdsLiveWork([10, 11], ["chromium"], [])).toBe(true);
    expect(staleAppScope(fact(app, 0, [10, 11], ["chromium"]), 57 * HOUR, 6 * HOUR, 1)).toBe(false);
  });

  test("a tmux in a cgroup nested under the scope keeps it", () => {
    const nested = { ...fact(app, 0, [10], ["git"]), nested: [below(20, "bash"), below(21, "tmux: server")] };
    expect(staleAppScope(nested, 57 * HOUR, 6 * HOUR, 1)).toBe(false);
    expect(staleAppScope({ ...nested, nested: [below(20, "bash")] }, 57 * HOUR, 6 * HOUR, 1)).toBe(true);
    // An agent's turn nests its own scope inside the child scope it was given.
    expect(staleChildScope(child, 57 * HOUR, 6 * HOUR, 1, 4242, false, [10], ["opencode"], [below(20, "tmux: server")])).toBe(false);
    expect(staleChildScope(child, 57 * HOUR, 6 * HOUR, 1, 4242, false, [10], ["opencode"], [below(20, "bash")])).toBe(true);
  });

  test("a nested tmux keeps the scope through the sweep, not only through the rule", () => {
    const stopped: string[] = [];
    const picked = reapStaleScopes({
      ...now,
      fact: () => ({ ...fact(app, 0, [10, 11], ["chromium", "git"]), nested: [below(20, "tmux: server")] }),
      ageMs: () => new Map([[10, 57 * HOUR], [11, 8 * HOUR], [20, 57 * HOUR]]),
      stop: (u) => { stopped.push(u); },
    });
    expect(picked).toEqual([]);
    expect(stopped).toEqual([]);
  });

  test("a turn that started a minute ago one cgroup down keeps the scope its dead leader left", () => {
    // The header's machine: the app's own cgroup holds a 26 h `opencode serve`
    // and the turn it started two minutes ago sits a level below. The oldest
    // process is not the one that says whether anything is still being used.
    const withTurn = { ...fact(app, 0, [10], ["opencode"]), nested: [below(20, "opencode")] };
    const reap = (ages: Map<number, number>) => {
      const stopped: string[] = [];
      const picked = reapStaleScopes({ ...now, fact: () => withTurn, ageMs: () => ages, stop: (u) => { stopped.push(u); } });
      return { picked, stopped };
    };
    expect(reap(new Map([[10, 26 * HOUR], [20, 2 * 60_000]]))).toEqual({ picked: [], stopped: [] });
    // The same tree with nothing young in it is a leftover, so the young pid is
    // what kept it rather than the nesting.
    expect(reap(new Map([[10, 26 * HOUR], [20, 7 * HOUR]])).picked).toEqual([app]);
    // And a nested pid that vanished before its age was read leaves the set
    // incomplete: an incomplete set is not a verdict.
    expect(reap(new Map([[10, 26 * HOUR]])).picked).toEqual([]);
  });

  test("descendant cgroups nobody could read keep the scope", () => {
    const unread = { ...fact(app, 0, [10]), nested: null };
    expect(staleAppScope(unread, 57 * HOUR, 6 * HOUR, 1)).toBe(false);
    const stopped: string[] = [];
    expect(reapStaleScopes({
      ...now,
      fact: () => unread,
      ageMs: () => new Map([[10, 57 * HOUR]]),
      stop: (u) => { stopped.push(u); },
    })).toEqual([]);
    expect(stopped).toEqual([]);
  });

  test("a stop says which unit, what was in it, and why the sweep believed it", () => {
    const lines: string[] = [];
    const picked = reapStaleScopes({
      ...now,
      fact: () => fact(app, 0, [10, 11], ["chromium", "git"]),
      ageMs: () => new Map([[10, 57 * HOUR], [11, 8 * HOUR]]),
      stop: () => {},
      log: (l) => lines.push(l),
    });
    expect(picked).toEqual([app]);
    expect(lines.length).toBe(2);
    expect(lines[0]).toContain(app);
    expect(lines[0]).toContain("in it: 10:chromium 11:git");
    expect(lines[0]).toContain("leader none not running");
    expect(lines[0]).toContain("youngest 8.0h over 6.0h");
  });

  test("a child scope's stop names the owner it lost, never a leader it never had", () => {
    const child = `${SCOPE_PREFIX}4242-ab12-1.scope`;
    const lines: string[] = [];
    const picked = reapStaleScopes({
      ...now,
      list: () => [child],
      fact: () => fact(child, 777, [10, 11], ["opencode", "git"]),
      ageMs: () => new Map([[10, 57 * HOUR], [11, 8 * HOUR]]),
      stop: () => {},
      log: (l) => lines.push(l),
    });
    expect(picked).toEqual([child]);
    expect(lines[0]).toContain("child scope, owner 4242 not running");
    expect(lines[0]).not.toContain("leader");
  });

  test("the log lists the nested processes too: they are what the stop killed", () => {
    const lines: string[] = [];
    reapStaleScopes({
      ...now,
      fact: () => ({ ...fact(app, 0, [10], ["git"]), nested: [below(20, "opencode"), below(21, "bash")] }),
      ageMs: () => new Map([[10, 57 * HOUR], [20, 57 * HOUR], [21, 57 * HOUR]]),
      stop: () => {},
      log: (l) => lines.push(l),
    });
    expect(lines[0]).toContain("in it: 10:git 20:opencode 21:bash");
  });

  test("a stop that failed says so, so it is not read as a stop that is slow", () => {
    const said = (stop: () => boolean | void): string[] => {
      const lines: string[] = [];
      reapStaleScopes({
        ...now,
        fact: () => fact(app, 0, [10], ["git"]),
        ageMs: () => new Map([[10, 57 * HOUR]]),
        stop,
        log: (l) => lines.push(l),
      });
      return lines;
    };
    const failed = said(() => false);
    expect(failed.some((l) => l.includes("did not stop"))).toBe(true);
    // A stop that threw never reached the user manager either.
    const threw = said(() => { throw new Error("no user manager"); });
    expect(threw.some((l) => l.includes("did not stop"))).toBe(true);
    const worked = said(() => true);
    expect(worked.some((l) => l.includes(`${app} stopped`))).toBe(true);
    expect(worked.some((l) => l.includes("did not stop"))).toBe(false);
  });
});

describe("what systemd prints", () => {
  test("units, filtered later by name", () => {
    const out = [
      `${app} loaded active running agentglass`,
      "run-r2f1.scope loaded active running A transient scope",
      "backup.timer loaded active waiting nightly",
      "",
    ].join("\n");
    expect(scopeUnits(out)).toEqual([app, "run-r2f1.scope"]);
  });

  test("show prints key=value lines, and a dead leader is MainPID=0", () => {
    expect(parseShow("MainPID=1156150\nControlGroup=/user.slice/user-1000.slice/app.slice/x.scope\n")).toEqual({
      mainPid: 1156150, controlGroup: "/user.slice/user-1000.slice/app.slice/x.scope",
    });
    // Active because its children are, with no main process left.
    expect(parseShow("MainPID=\nControlGroup=/user.slice/user-1000.slice/app.slice/x.scope\n")).toEqual({
      mainPid: 0, controlGroup: "/user.slice/user-1000.slice/app.slice/x.scope",
    });
    expect(parseShow("MainPID=\nControlGroup=\n")).toBeNull();
    expect(parseShow("MainPID=not a pid\nControlGroup=/user.slice\n")).toBeNull();
  });

  test("the pids of a cgroup, or null when it cannot be read", () => {
    const dir = temp("scopes-cgroup-");
    writeFileSync(join(dir, "cgroup.procs"), "10\n11\n\n");
    expect(cgroupProcs(dir)).toEqual([10, 11]);
    expect(cgroupProcs(join(dir, "gone"))).toBeNull();
  });

  test("a scope's own cgroup and the cgroups nested under it, or null", () => {
    const dir = temp("scopes-tree-");
    mkdirSync(join(dir, "nested.scope"));
    writeFileSync(join(dir, "cgroup.procs"), "10\n");
    writeFileSync(join(dir, "nested.scope", "cgroup.procs"), "11\n");
    expect(cgroupTree(dir)).toEqual({ own: [10], nested: [11] });
    rmSync(join(dir, "nested.scope", "cgroup.procs"));
    expect(cgroupTree(dir)).toBeNull();
  });

  test("a slice's own cgroup is empty while its child scopes hold the workers", () => {
    // Measured on a throwaway slice: its `cgroup.procs` was empty and the sleep
    // lived in a transient scope inside it. Stopping the slice killed the
    // sleep, so reading only the top level would stop the legacy slice under a
    // live turn.
    const root = temp("scopes-group-");
    const slice = join(root, LEGACY_WORKER_SLICE);
    const child = join(slice, `${SCOPE_PREFIX}1-acme.scope`);
    mkdirSync(child, { recursive: true });
    writeFileSync(join(slice, "cgroup.procs"), "");
    writeFileSync(join(child, "cgroup.procs"), "4242\n");
    expect(groupProcs(`/${LEGACY_WORKER_SLICE}`, root)).toEqual([4242]);
    // A level nobody could read is unknown, never empty: the slice is kept.
    rmSync(join(child, "cgroup.procs"));
    expect(groupProcs(`/${LEGACY_WORKER_SLICE}`, root)).toBeNull();
  });

  test("a subtree seven turns down is read, not left permanently unknown", () => {
    // A turn of a turn puts scopes one inside the next; the old ceiling of six
    // made that tree null for ever, and the scope that caused it is the one
    // nobody could then reap.
    const dir = temp("scopes-deep-");
    const nested = chain(dir, 7);
    expect(cgroupTree(dir)).toEqual({ own: [10], nested });
  });

  test("past a bound the tree is unknown and the scope is kept", () => {
    const deep = temp("scopes-deep-bound-");
    chain(deep, MAX_TREE_DEPTH + 1);
    expect(cgroupTree(deep)).toBeNull();
    const wide = temp("scopes-wide-bound-");
    writeFileSync(join(wide, "cgroup.procs"), "10\n");
    for (let i = 0; i < 4; i++) {
      mkdirSync(join(wide, `w${i}.scope`));
      writeFileSync(join(wide, `w${i}.scope`, "cgroup.procs"), `${20 + i}\n`);
    }
    expect(MAX_TREE_CGROUPS).toBeGreaterThan(4);
    expect(cgroupTree(wide, MAX_TREE_DEPTH, 3)).toBeNull();
    expect(cgroupTree(wide, MAX_TREE_DEPTH, 4)!.nested.sort((a, b) => a - b)).toEqual([20, 21, 22, 23]);
  });

  test("only the unit's own cgroup is walked, never the root or a shared ancestor", () => {
    // A unit's own cgroup is the directory named after it; anything else is a
    // slice full of other units' processes, and one such row costs the machine.
    expect(ownCgroup(app, `/user.slice/user-1000.slice/app.slice/${app}`)).toBe(`/user.slice/user-1000.slice/app.slice/${app}`);
    expect(ownCgroup(app, "/")).toBeNull();
    expect(ownCgroup(app, "/user.slice/user-1000.slice/app.slice")).toBeNull();
    expect(ownCgroup(app, `${app}`)).toBeNull();
  });

  test("a pid's age comes from the kernel, and a gone pid has none", () => {
    expect(ageMsOf(process.pid, 1e9)).toBeGreaterThanOrEqual(0);
    expect(ageMsOf(2 ** 22 + 12345, 1e9)).toBeNull();
  });
});

describe("the memory reading", () => {
  const meminfo = (usedShare: number): string => {
    const total = 32 * 1024 * 1024; // kB
    const available = Math.round(total * (1 - usedShare));
    return `MemTotal:       ${total} kB\nMemAvailable:   ${available} kB\n`;
  };

  test("pressure is what MemAvailable says, not MemFree", () => {
    const p = memoryPressure(meminfo(0.5));
    expect(p.pressure).toBeGreaterThan(0.49);
    expect(p.pressure).toBeLessThan(0.51);
    expect(memoryPressure("").pressure).toBe(0);
  });

  test("below the threshold no scope is walked at all", () => {
    let listed = false;
    const watch = memoryWatch({
      meminfo: () => meminfo(MEMORY_PRESSURE - 0.01),
      list: () => { listed = true; return [app]; },
    });
    expect(watch.over).toBe(false);
    expect(watch.scopes).toEqual([]);
    expect(listed).toBe(false);
  });

  test("above it, the top RSS per scope, biggest first, nested cgroups included", () => {
    const watch = memoryWatch({
      meminfo: () => meminfo(0.9),
      list: () => [app, other, "run-r2f1.scope"],
      // `other`'s payload lives one cgroup down, which is where a leftover
      // app's payloads are once its leader has died.
      fact: (u) => u === app ? fact(u, 1, [10, 11]) : { ...fact(u, 1, [12]), nested: [below(13, "bash")] },
      rss: (pid) => pid === 10 ? 3_000 : pid === 11 ? 2_000 : pid === 13 ? 700 : 100,
      top: 5,
    });
    expect(watch.over).toBe(true);
    expect(watch.scopes).toEqual([
      { unit: app, rss: 5_000, procs: 2 },
      { unit: other, rss: 800, procs: 2 },
    ]);
  });
});

/*
 * A CHILD SCOPE A SERVER LEFT BEHIND.
 *
 * Measured on one machine after a restart: five `agentglass-child-*` scopes
 * whose server pid was dead still held a finished opencode run, tmux servers a
 * probe had started, and an adb fork-server from a worktree that no longer
 * existed — about 1.3 GB. The age sweep cannot tell those from the one case
 * that must be left alone: a worker that outlived the restart and is still
 * working in the scope it was launched in.
 */
describe("a child scope left by a server that is gone", () => {
  const dead = 4242;
  const child = `${SCOPE_PREFIX}${dead}-ab12-1.scope`;
  const WORKTREE = "/home/a/code/orbit-1042";
  const boot = {
    list: () => [child], alive: () => false, selfPid: 1, on: true, log: () => {},
    // A cwd nobody works in and no serve: the scope is a leftover unless a test
    // says otherwise.
    cwdOf: () => "/nowhere/at/all", serves: () => false,
  };
  /** The `AGX_OWNER` read: a pid in the table names its worker, the rest name
   *  none. */
  const owners = (byPid: Record<number, string>) => (pid: number): OwnerRead =>
    byPid[pid] ? { state: "owner", name: byPid[pid] } : { state: "absent" };
  const live = (...names: string[]) => () => ({ names: new Set(names), dirs: [] });
  const turnsIn = (...dirs: string[]) => () => ({ names: new Set<string>(), dirs });

  test("is stopped when no live worker is in it, with no age floor", () => {
    const stopped: string[] = [];
    const r = adoptOrphanScopes({
      ...boot,
      fact: () => fact(child, 777, [10], ["opencode"]),
      ownerOf: owners({ 10: "orbit-1042" }),
      live: live("another-worker"),
      stop: (u) => { stopped.push(u); },
    });
    expect(r).toEqual({ adopted: [], stopped: [child], failed: [] });
    expect(stopped).toEqual([child]);
  });

  test("is adopted while the worker in it has a turn in flight", () => {
    const stopped: string[] = [];
    const lines: string[] = [];
    const r = adoptOrphanScopes({
      ...boot,
      fact: () => ({ ...fact(child, 777, [10], ["opencode"]), nested: [below(20, "bash")] }),
      ownerOf: owners({ 20: "orbit-1042" }),
      live: live("orbit-1042"),
      stop: (u) => { stopped.push(u); },
      log: (l) => lines.push(l),
    });
    expect(r).toEqual({ adopted: [child], stopped: [], failed: [] });
    expect(stopped).toEqual([]);
    expect(lines[0]).toContain("adopting");
    expect(lines[0]).toContain("orbit-1042");
  });

  test("is adopted when the engine's private server is in it, whoever started it", () => {
    /* The first boot after an upgrade: every serve in flight was started by the
       build before AGX_OWNER was stamped, so nothing in the scope names a
       worker. Stopping it takes the private server out from under a working
       turn — the case this pass exists to save. */
    const stopped: string[] = [];
    const r = adoptOrphanScopes({
      ...boot,
      fact: () => fact(child, 777, [10], ["opencode"]),
      ownerOf: owners({}),
      serves: (pid) => pid === 10,
      live: live("orbit-1042"),
      stop: (u) => { stopped.push(u); },
    });
    expect(r).toEqual({ adopted: [child], stopped: [], failed: [] });
    expect(stopped).toEqual([]);
  });

  test("is adopted when a process in it works in a live row's directory", () => {
    /* The second signal of the same boot: a serve and its tools run with the
       worker's `cwd`, and the registry still has that row open. */
    const stopped: string[] = [];
    const r = adoptOrphanScopes({
      ...boot,
      fact: () => fact(child, 777, [10], ["bash"]),
      ownerOf: owners({}),
      cwdOf: (pid) => pid === 10 ? join(WORKTREE, "server/src") : "/nowhere/at/all",
      live: turnsIn(WORKTREE),
      stop: (u) => { stopped.push(u); },
    });
    expect(r).toEqual({ adopted: [child], stopped: [], failed: [] });
    expect(stopped).toEqual([]);
    // A neighbour whose name only starts with the worktree's is somewhere else.
    const beside = adoptOrphanScopes({
      ...boot,
      fact: () => fact(child, 777, [10], ["bash"]),
      ownerOf: owners({}),
      cwdOf: () => `${WORKTREE}0`,
      live: turnsIn(WORKTREE),
      stop: (u) => { stopped.push(u); },
    });
    expect(beside).toEqual({ adopted: [], stopped: [child], failed: [] });
  });

  test("a pid that left /proc is gone, not doubt; one still there that cannot be read is doubt", () => {
    const stopped: string[] = [];
    const gone = adoptOrphanScopes({
      ...boot,
      fact: () => fact(child, 777, [10], ["bash"]),
      ownerOf: () => ({ state: "unreadable" }),
      cwdOf: () => null,
      alive: () => false,
      live: live("orbit-1042"),
      stop: (u) => { stopped.push(u); },
    });
    // The cgroup listed a pid that was gone before its environ could be read:
    // that says nothing, and it is not a reason to keep the whole scope.
    expect(gone).toEqual({ adopted: [], stopped: [child], failed: [] });
    expect(stopped).toEqual([child]);

    // The same reads from a pid that is still there hide something: kept.
    const kept = adoptOrphanScopes({
      ...boot,
      fact: () => fact(child, 777, [10], ["bash"]),
      ownerOf: () => ({ state: "unreadable" }),
      cwdOf: () => null,
      alive: (pid) => pid === 10,
      live: live("orbit-1042"),
      stop: (u) => { stopped.push(u); },
    });
    expect(kept).toEqual({ adopted: [child], stopped: [], failed: [] });
  });

  test("an adopted scope is registered for its window's end", () => {
    const stopped: string[] = [];
    const r = adoptOrphanScopes({
      ...boot,
      fact: () => fact(child, 777, [10], ["opencode"]),
      ownerOf: owners({ 10: "orbit-1042" }),
      live: live("orbit-1042"),
      stop: (u) => { stopped.push(u); },
    });
    expect(r.adopted).toEqual([child]);
    // This process did not launch the unit, but the window it works for did:
    // closing that window must stop it, or it stays for days.
    expect(endWindowScopes("orbit-1042", (u) => { stopped.push(u); })).toEqual([child]);
    expect(stopped).toContain(child);
  });

  test("a directory two live rows work in binds the adopted scope to neither", () => {
    /* Two workers in one checkout: `dirNames` collapsed them to whichever row
       came last, so closing that window stopped the other worker's scope. */
    const one = "orbit-1044";
    const two = "orbit-1045";
    const shared = () => ({ names: new Set<string>(), dirs: [WORKTREE, WORKTREE], dirNames: new Map([[WORKTREE, two]]) });
    const stopped: string[] = [];
    const byDir = adoptOrphanScopes({
      ...boot,
      fact: () => fact(child, 777, [10], ["bash"]),
      ownerOf: owners({}),
      cwdOf: () => join(WORKTREE, "server"),
      live: shared,
      stop: (u) => { stopped.push(u); },
    });
    expect(byDir).toEqual({ adopted: [child], stopped: [], failed: [] });
    const byServe = adoptOrphanScopes({
      ...boot,
      fact: () => fact(child, 777, [10], ["opencode"]),
      ownerOf: owners({}),
      serves: (pid) => pid === 10,
      cwdOf: () => join(WORKTREE, "server"),
      live: shared,
      stop: (u) => { stopped.push(u); },
    });
    expect(byServe).toEqual({ adopted: [child], stopped: [], failed: [] });
    // Adopted all the same, and left to the age sweep: no evidence picked a row.
    expect(endWindowScopes(one, (u) => { stopped.push(u); })).toEqual([]);
    expect(endWindowScopes(two, (u) => { stopped.push(u); })).toEqual([]);
    expect(stopped).toEqual([]);
  });

  test("the keep set is asked again, so a turn that ended stops holding its scope", () => {
    const childFact = () => fact(child, 777, [10], ["bash"]);
    let names = new Set(["orbit-1042"]);
    const kept = () => stillAdopted([child], {
      live: () => ({ names, dirs: [] }),
      fact: childFact,
      ownerOf: owners({ 10: "orbit-1042" }),
      serves: () => false,
      cwdOf: () => "/nowhere/at/all",
      alive: () => false,
    });
    expect(kept().has(child)).toBe(true);
    names = new Set();
    expect(kept().has(child), "a keep set frozen at boot left the scope exempt").toBe(false);
  });

  test("a row stored with an empty directory or / keeps no scope", () => {
    for (const dir of ["/", ""]) {
      const stopped: string[] = [];
      const r = adoptOrphanScopes({
        ...boot,
        fact: () => fact(child, 777, [10], ["bash"]),
        ownerOf: owners({}),
        // Under this server's own cwd, which is what `resolved("")` used to be.
        cwdOf: () => join(process.cwd(), "server/src"),
        live: () => ({ names: new Set<string>(), dirs: [dir] }),
        stop: (u) => { stopped.push(u); },
      });
      expect(r, `dir ${JSON.stringify(dir)} kept every leftover`).toEqual({ adopted: [], stopped: [child], failed: [] });
    }
  });

  test("an environ that could not be read keeps the scope", () => {
    /* A sandboxed or non-dumpable child hides its environ while its comm reads
       fine. "" and "no owner" are not the same answer, and the wrong one stops
       a working turn. */
    const stopped: string[] = [];
    const lines: string[] = [];
    const r = adoptOrphanScopes({
      ...boot,
      fact: () => fact(child, 777, [10], ["bash"]),
      ownerOf: () => ({ state: "unreadable" }),
      // The payload pid is still there; its environ is what is hidden.
      alive: (pid) => pid === 10,
      live: live("orbit-1042"),
      stop: (u) => { stopped.push(u); },
      log: (l) => lines.push(l),
    });
    expect(r).toEqual({ adopted: [child], stopped: [], failed: [] });
    expect(stopped).toEqual([]);
    expect(lines[0]).toContain("nothing in it could be read");
  });

  test("the switch that turns scopes off stops nothing at all", () => {
    const stopped: string[] = [];
    let listed = false;
    const r = adoptOrphanScopes({
      ...boot,
      on: false,
      list: () => { listed = true; return [child]; },
      fact: () => fact(child, 777, [10], ["opencode"]),
      ownerOf: owners({}),
      live: live(),
      stop: (u) => { stopped.push(u); },
    });
    expect(r).toEqual({ adopted: [], stopped: [], failed: [] });
    expect(stopped).toEqual([]);
    expect(listed, "systemd was asked about scopes while the switch was off").toBe(false);
  });

  test("a scope whose server is still running is not this pass's business", () => {
    const stopped: string[] = [];
    const r = adoptOrphanScopes({
      ...boot,
      alive: (pid) => pid === dead,
      fact: () => fact(child, 777, [10], ["opencode"]),
      ownerOf: owners({ 10: "orbit-1042" }),
      live: live(),
      stop: (u) => { stopped.push(u); },
    });
    expect(r).toEqual({ adopted: [], stopped: [], failed: [] });
    expect(stopped).toEqual([]);
  });

  test("an app scope is left to the sweep that knows how to read its leader", () => {
    const stopped: string[] = [];
    adoptOrphanScopes({
      list: () => [app],
      alive: () => false,
      selfPid: 1,
      on: true,
      fact: () => fact(app, 0, [10], ["chromium"]),
      live: live(),
      stop: (u) => { stopped.push(u); },
      log: () => {},
    });
    expect(stopped).toEqual([]);
  });

  test("unknown keeps the scope, and a tmux does not", () => {
    const stopped: string[] = [];
    const deps = {
      ...boot,
      ownerOf: owners({}),
      live: live("orbit-1042"),
      stop: (u: string) => { stopped.push(u); },
    };
    const kept = { adopted: [child], stopped: [], failed: [] };
    // A comm, a whole level or the fact itself that could not be read is kept
    // AND recorded: the age sweep that follows must not read it as a leftover.
    expect(adoptOrphanScopes({ ...deps, fact: () => fact(child, 777, [10], [""]) })).toEqual(kept);
    expect(adoptOrphanScopes({ ...deps, fact: () => ({ ...fact(child, 777, [10]), nested: null }) })).toEqual(kept);
    expect(adoptOrphanScopes({ ...deps, fact: () => null })).toEqual(kept);
    expect(stopped).toEqual([]);
    /* A tmux in a dead server's scope was started by a probe or a worker's own
       command — an agent's pane is never scoped — and the machine this pass was
       written from was holding one. */
    expect(adoptOrphanScopes({ ...deps, fact: () => fact(child, 777, [10], ["tmux: server"]) }))
      .toEqual({ adopted: [], stopped: [child], failed: [] });
    expect(stopped).toEqual([child]);
  });

  test("a registry that could not be read stops nothing", () => {
    const stopped: string[] = [];
    const r = adoptOrphanScopes({
      ...boot,
      fact: () => fact(child, 777, [10], ["opencode"]),
      ownerOf: owners({ 10: "orbit-1042" }),
      live: () => null,
      stop: (u) => { stopped.push(u); },
    });
    expect(r).toEqual({ adopted: [], stopped: [], failed: [] });
    expect(stopped).toEqual([]);
  });

  test("the stop says the server it lost and what is in it", () => {
    const lines: string[] = [];
    adoptOrphanScopes({
      ...boot,
      fact: () => ({ ...fact(child, 777, [10, 11], ["opencode", "git"]), nested: [below(20, "bash")] }),
      ownerOf: owners({}),
      live: live(),
      stop: () => {},
      log: (l) => lines.push(l),
    });
    expect(lines[0]).toContain(`stopping ${child}`);
    expect(lines[0]).toContain(`server ${dead} is gone`);
    expect(lines[0]).toContain("in it: 10:opencode 11:git 20:bash");
  });

  test("a stop that failed is counted as failed, never as stopped", () => {
    const lines: string[] = [];
    const r = adoptOrphanScopes({
      ...boot,
      fact: () => fact(child, 777, [10], ["opencode"]),
      ownerOf: owners({}),
      live: live(),
      stop: () => false,
      log: (l) => lines.push(l),
    });
    expect(r).toEqual({ adopted: [], stopped: [], failed: [child] });
    expect(lines[1]).toContain("did not stop");
  });

  test("an engine's private server is a name and a `serve`, not any command with the word", () => {
    expect(engineServe(["/usr/bin/opencode", "serve", "--hostname", "127.0.0.1", "--port", "0"])).toBe(true);
    expect(engineServe(["bun", "/opt/opencode/bin/opencode", "serve"])).toBe(true);
    // `tailscale serve` is a `serve` and not an engine: a scope holding one is
    // not a live turn.
    expect(engineServe(["/usr/bin/tailscale", "serve", "--bg", "5173"])).toBe(false);
    expect(engineServe(["/usr/bin/opencode", "run", "--server", "http://127.0.0.1:1"])).toBe(false);
  });
});

/*
 * THE BOOT PASS AS A TABLE: adopt, hand what was adopted to the sweep, and
 * sweep only when the roster could be read. A failed pass asks for the next
 * tick; it never leaves the sweep off for the process.
 */
describe("the boot policy", () => {
  const child = `${SCOPE_PREFIX}4242-ab12-1.scope`;
  const live = () => ({ names: new Set<string>(), dirs: [] });
  const quiet = { log: () => {}, error: () => {} };

  test("adoption, then the sweep, handed the units it adopted", () => {
    const sweeps: (() => ReadonlySet<string>)[] = [];
    const r = bootScopes({
      ...quiet,
      appCopy: true,
      live,
      adopt: () => ({ adopted: [child], stopped: [], failed: [] }),
      sweep: (d) => { sweeps.push(d.keep!); },
      keepNow: (units) => units,
    });
    expect(r).toEqual({ adopted: [child], stopped: [], failed: [], swept: true, retry: false });
    expect(sweeps).toHaveLength(1);
    expect(sweeps[0]!().has(child), "the sweep did not get what the pass adopted").toBe(true);
  });

  test("a table row without a keepNow: the default answers each ask from the roster", () => {
    /* The wiring this pass is about: every sweep asks again. A frozen
       `keep: () => adopted` keeps the unit on the second ask too, and this row
       is the one that says so. */
    const sweeps: (() => ReadonlySet<string>)[] = [];
    let asked = 0;
    const live = () => {
      asked++;
      // At boot and on the first ask the row is there; it has ended by the second.
      return asked <= 2 ? { names: new Set(["orbit-1042"]), dirs: [] } : { names: new Set<string>(), dirs: [] };
    };
    bootScopes({
      ...quiet,
      appCopy: true,
      live,
      adopt: () => ({ adopted: [child], stopped: [], failed: [] }),
      sweep: (d) => { sweeps.push(d.keep!); },
      keepDeps: {
        fact: (u) => fact(u, 777, [10], ["bash"]),
        ownerOf: () => ({ state: "owner", name: "orbit-1042" }),
        serves: () => false,
        cwdOf: () => "/nowhere/at/all",
        alive: () => false,
      },
    });
    expect(sweeps[0]!().has(child), "the first ask lost a live worker's scope").toBe(true);
    expect(sweeps[0]!().has(child), "the keep set froze at boot").toBe(false);
  });

  test("a roster that could not be read is one line, and it carries the reason", () => {
    const errors: string[] = [];
    const r = bootScopes({
      ...quiet,
      error: (l) => errors.push(l),
      appCopy: true,
      live: () => { throw new Error("database is locked"); },
      adopt: () => { throw new Error("not reached"); },
      sweep: () => {},
    });
    expect(r).toEqual({ adopted: [], stopped: [], failed: [], swept: false, retry: true });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("database is locked");
    /* And the boot wiring leaves the read's failure to it: a second, vaguer
       line is what a retry tick used to add, ten minutes apart. */
    const s = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
    const from = s.indexOf("const roster = (): LiveTurns | null => {");
    const to = s.indexOf("const boot = (): void => {", from);
    expect(from).toBeGreaterThan(0);
    expect(to).toBeGreaterThan(from);
    expect(s.slice(from, to), "index.ts logs the failure itself, so each retry says it twice").not.toContain("console.error");
  });

  test("a roster that could not be read stops nothing and starts no sweep", () => {
    let adopted = 0;
    let swept = 0;
    const r = bootScopes({
      ...quiet,
      appCopy: true,
      live: () => null,
      adopt: () => { adopted++; return { adopted: [], stopped: [], failed: [] }; },
      sweep: () => { swept++; },
    });
    expect(r).toEqual({ adopted: [], stopped: [], failed: [], swept: false, retry: true });
    expect(adopted).toBe(0);
    expect(swept).toBe(0);
  });

  test("a pass that threw asks for the next tick, and a later one still sweeps", () => {
    const swept: number[] = [];
    const failed = bootScopes({
      ...quiet,
      appCopy: true,
      live,
      adopt: () => { throw new Error("database is locked"); },
      sweep: () => { swept.push(1); },
    });
    expect(failed.retry).toBe(true);
    expect(failed.swept).toBe(false);
    // The next tick is a fresh pass, not a process that gave up: a roster that
    // can be read this time still starts the sweep.
    const later = bootScopes({
      ...quiet,
      appCopy: true,
      live,
      adopt: () => ({ adopted: [child], stopped: [], failed: [] }),
      sweep: () => { swept.push(1); },
      keepNow: (u) => u,
    });
    expect(later).toMatchObject({ swept: true, retry: false });
    expect(swept).toHaveLength(1);
  });

  test("a server somebody started by hand neither adopts nor sweeps", () => {
    let asked = 0;
    const r = bootScopes({
      ...quiet,
      appCopy: false,
      live: () => { asked++; return live(); },
      adopt: () => { asked++; return { adopted: [], stopped: [], failed: [] }; },
      sweep: () => { asked++; },
    });
    expect(r).toEqual({ adopted: [], stopped: [], failed: [], swept: false, retry: false });
    expect(asked).toBe(0);
  });
});

/*
 * ONE RUN, ONE SCOPE, AND ONE WINDOW.
 *
 * A headless turn on OpenCode 2.x runs against a private server with a scope of
 * its own. A TURN ending stops only that server — the wrapper's `AGX_SERVE_PIDS`
 * kill, as before — because the scope is also the cgroup of everything the
 * engine spawned, a `bun run dev` it left for the person to look at included.
 * The whole scope goes when the WINDOW goes: a tab stopped, the name started
 * over, the row reconciled away.
 */
describe("the scope of one run", () => {
  test("ends with the window, once, and only for that worker", () => {
    const unit = `${SCOPE_PREFIX}1-ab12-1.scope`;
    noteRunScope("wend-scope", unit);
    const stopped: string[] = [];
    expect(endWindowScopes("wend-scope", (u) => { stopped.push(u); })).toEqual([unit]);
    expect(endWindowScopes("wend-scope", (u) => { stopped.push(u); })).toEqual([]);
    expect(stopped).toEqual([unit]);
  });

  test("a later turn replaces the last one's scope, and a run with none clears it", () => {
    noteRunScope("wend-scope-2", `${SCOPE_PREFIX}1-ab12-1.scope`);
    noteRunScope("wend-scope-2", `${SCOPE_PREFIX}1-ab12-2.scope`);
    expect(endWindowScopes("wend-scope-2", () => {})).toEqual([`${SCOPE_PREFIX}1-ab12-2.scope`]);
    noteRunScope("wend-scope-3", `${SCOPE_PREFIX}1-ab12-1.scope`);
    noteRunScope("wend-scope-3", null);
    expect(endWindowScopes("wend-scope-3", () => { throw new Error("stopped"); })).toEqual([]);
  });

  test("a stop that failed keeps the scope for the exit pass to try again", () => {
    const unit = `${SCOPE_PREFIX}1-ab12-4.scope`;
    rememberScope(unit); // the way a launch leaves it, for the exit pass to walk
    noteRunScope("wend-scope-4", unit);
    expect(endWindowScopes("wend-scope-4", () => false)).toEqual([]);
    expect(ownScopes().has(unit), "a failed stop forgot the unit").toBe(true);
    const stopped: string[] = [];
    expect(endWindowScopes("wend-scope-4", (u) => { stopped.push(u); })).toEqual([unit]);
    expect(ownScopes().has(unit)).toBe(false);
    expect(stopped).toEqual([unit]);
  });

  test("a unit this module did not mint is never stopped", () => {
    noteRunScope("wend-foreign", "run-r2f1.scope");
    expect(endWindowScopes("wend-foreign", () => { throw new Error("stopped"); })).toEqual([]);
  });
});
