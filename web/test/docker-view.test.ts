/*
 * The small decisions the Containers view makes on top of the phase-1 ones:
 * which situation it is in, what the freshness label says, the sub-line under
 * a name, the port cell, and how the list is grouped and folded.
 */
import { describe, expect, test } from "bun:test";
import type { DockerCapability, DockerContainer, DockerOverview, DockerStat } from "../../shared/types.ts";
import {
  ageWords, freshness, groupsView, LAYOUT_KEY, mapGroups, meterOf, navCounts, needFirst, portCell, readLayout,
  scopeLine, situation, stepOf, mergeStats, whyOf,
} from "../src/lib/dockerView.ts";

const c = (over: Partial<DockerContainer> & { id: string }): DockerContainer => ({
  name: `orbit-${over.id}-1`, image: "acme/orbit:dev", state: "running", status: "Up 4 hours",
  ports: "", project: "orbit", service: over.id, workingDir: "/home/dev/code/orbit",
  runningFor: "4 hours ago", size: "", ...over,
});
const sick = (id: string, over: Partial<DockerContainer> = {}) => c({ id, health: "unhealthy", ...over });
const off = (id: string) => c({ id, state: "exited", status: "Exited (0) 1 hour ago" });
const web = (host: number) => ({ host, hostEnd: host, hostIp: "0.0.0.0", container: host, containerEnd: host, proto: "tcp" as const, web: true });
const db = (host: number) => ({ ...web(host), web: false });

const ov = (over: Partial<DockerOverview> = {}): DockerOverview => ({
  available: true, writeEnabled: true, version: "27.3.1", containers: [c({ id: "a" })], images: [], volumes: [], networks: [], at: 1_000, ...over,
});
const cap = (available: boolean): DockerCapability => ({ available });

describe("which situation the view is in", () => {
  test("a missing CLI wins over everything", () => {
    expect(situation({ cap: cap(false), ov: ov(), good: ov(), liveDown: false, failed: false })).toBe("notinstalled");
  });
  test("nothing fetched yet is loading, and a failed first fetch is down", () => {
    expect(situation({ cap: null, ov: null, good: null, liveDown: false, failed: false })).toBe("loading");
    expect(situation({ cap: null, ov: null, good: null, liveDown: false, failed: true })).toBe("down");
  });
  test("a daemon that answers with nothing is empty, with something is normal", () => {
    expect(situation({ cap: cap(true), ov: ov({ containers: [] }), good: ov({ containers: [] }), liveDown: false, failed: false })).toBe("empty");
    expect(situation({ cap: cap(true), ov: ov(), good: ov(), liveDown: false, failed: false })).toBe("normal");
  });
  test("the feed saying down, or an unavailable answer, is down even with a last good state", () => {
    expect(situation({ cap: cap(true), ov: ov(), good: ov(), liveDown: true, failed: false })).toBe("down");
    expect(situation({ cap: cap(true), ov: ov({ available: false }), good: ov(), liveDown: false, failed: false })).toBe("down");
    expect(situation({ cap: cap(true), ov: ov({ available: false }), good: null, liveDown: false, failed: false })).toBe("down");
  });
});

describe("the freshness label", () => {
  test("is live with an age, and the age is words", () => {
    expect(freshness({ situation: "normal", at: 10_000, lastGoodAt: 10_000, now: 15_000 }).text).toBe("Live · 5s ago");
    expect(freshness({ situation: "normal", at: 10_000, lastGoodAt: 10_000, now: 10_500 }).text).toBe("Live · just now");
  });
  test("says retrying with how old the last good state is, in amber", () => {
    const f = freshness({ situation: "down", at: 0, lastGoodAt: 1_000, now: 1_000 + 4 * 60_000 });
    expect(f.text).toBe("retrying · last state 4 min old");
    expect(f.warn).toBe(true);
  });
  test("has nothing to age when it never saw a state", () => {
    expect(freshness({ situation: "down", now: 5 }).text).toBe("retrying · no state yet");
  });
  test("is connecting while loading", () => {
    expect(freshness({ situation: "loading", now: 5 }).text).toBe("connecting…");
  });
  test("age words", () => {
    expect(ageWords(40_000)).toBe("40s");
    expect(ageWords(4 * 60_000)).toBe("4 min");
    expect(ageWords(3 * 3_600_000)).toBe("3 h");
  });
});

describe("the scope pill", () => {
  const scope = { workspace: "/home/dev/code/orbit", project: "orbit", matched: 3, showingAll: false };
  test("names the project and how many are shown", () => {
    expect(scopeLine(scope, 14)).toMatchObject({ all: false, project: "orbit", before: "Project ", after: " · 14 containers" });
    expect(scopeLine(scope, 1)?.after).toBe(" · 1 container");
  });
  test("admits the fallback to the whole host", () => {
    expect(scopeLine({ ...scope, matched: 0, showingAll: true }, 9)).toMatchObject({ all: true, project: "orbit", before: "No ", after: " containers · showing all" });
  });
  test("is absent without a scope", () => expect(scopeLine(undefined, 3)).toBeNull());
});

describe("the sub-line under a name", () => {
  test("a sick one says why", () => {
    expect(whyOf(sick("a", { healthError: "GET /health 503\nbody", healthFailures: 3 }))).toEqual({ text: "health check: GET /health 503 ×3", tone: "warn" });
    expect(whyOf(sick("a")).text).toBe("health check failing");
  });
  test("a restart loop counts restarts and the last exit", () => {
    expect(whyOf(c({ id: "a", state: "restarting", status: "Restarting (1) 4 seconds ago", restarts: 12 }))).toEqual({ text: "12 restarts · last exit 1", tone: "amb" });
    expect(whyOf(c({ id: "a", state: "restarting", status: "Restarting" })).text).toBe("restarting");
  });
  test("a crash gives the code and when", () => {
    expect(whyOf(c({ id: "a", state: "exited", status: "Exited (137) 2 hours ago" }))).toEqual({ text: "exited with code 137 · 2 hours ago", tone: "warn" });
  });
  test("a deliberate stop is plain, dead says remove it, created and paused say so", () => {
    expect(whyOf(off("a"))).toEqual({ text: "stopped 1 hour ago", tone: "" });
    expect(whyOf(c({ id: "a", state: "dead", status: "Dead" })).tone).toBe("warn");
    expect(whyOf(c({ id: "a", state: "created", status: "Created" })).text).toBe("created, never started");
    expect(whyOf(c({ id: "a", state: "paused" }))).toEqual({ text: "paused · acme/orbit:dev", tone: "amb" });
  });
  test("a healthy one shows its image", () => expect(whyOf(c({ id: "a" }))).toEqual({ text: "acme/orbit:dev", tone: "" }));
});

describe("the CPU and memory meters", () => {
  const stat = (cpu: number, mem: number): DockerStat => ({ id: "a", cpu, mem, memUsage: "212MiB / 7.7GiB", netIO: "", blockIO: "", pids: 1 });
  test("go amber at 50 and 80, not before", () => {
    expect(meterOf(stat(49.9, 79.9), true)).toMatchObject({ cpuHot: false, memHot: false });
    expect(meterOf(stat(50, 80), true)).toMatchObject({ cpuHot: true, memHot: true });
  });
  test("a row without a sample or not running has none, rather than a zero", () => {
    expect(meterOf(undefined, true)).toMatchObject({ cpu: null, mem: null });
    expect(meterOf(stat(5, 5), false)).toMatchObject({ cpu: null, mem: null });
  });
  test("memory shows the used figure only", () => expect(meterOf(stat(1, 2), true).memSub).toBe("212MiB"));
});

describe("the port cell", () => {
  test("a web port opens, and says where", () => {
    expect(portCell(c({ id: "a", portList: [web(3100)] }))).toMatchObject({ kind: "web", label: "localhost:3100", url: "http://localhost:3100" });
  });
  test("a published non-web port is plain text", () => {
    expect(portCell(c({ id: "a", portList: [db(5433)] }))).toMatchObject({ kind: "plain", label: ":5433" });
  });
  test("stopped, paused, restarting and dead say why there is nothing to open", () => {
    expect(portCell(off("a"))).toMatchObject({ kind: "none" });
    expect(portCell({ ...off("a"), portList: [web(8025)] })).toMatchObject({ kind: "off", label: ":8025 · off" });
    expect(portCell(c({ id: "a", state: "paused", portList: [web(8025)] }))).toMatchObject({ kind: "off", label: ":8025 · paused" });
    expect(portCell(c({ id: "a", state: "restarting", portList: [web(8025)] }))).toMatchObject({ kind: "none" });
    expect(portCell(c({ id: "a", state: "dead", portList: [web(8025)] }))).toMatchObject({ kind: "none" });
  });
  test("an unparsed ports column still shows its host port", () => {
    expect(portCell(c({ id: "a", ports: "0.0.0.0:8000->8000/tcp" }))).toMatchObject({ kind: "plain", label: ":8000" });
  });
  test("no port at all is a dash", () => expect(portCell(c({ id: "a" }))).toMatchObject({ kind: "none", label: "—" }));
});

describe("groups", () => {
  const fleet = [
    c({ id: "a", project: "orbit", owner: { worktree: "orbit-1042", branch: "b", foreign: false, path: "/p" } }),
    sick("b", { project: "orbit", owner: { worktree: "orbit-1042", branch: "b", foreign: false, path: "/p" } }),
    c({ id: "c", project: "acme-tools" }),
  ];
  test("stacks with something wrong come first, and the sick one leads inside", () => {
    const g = groupsView(fleet, { groupBy: "stack", q: "", answer: null, open: {} });
    expect(g.map((x) => x.key)).toEqual(["orbit", "acme-tools"]);
    expect(g[0]!.containers.map((x) => x.id)).toEqual(["b", "a"]);
    expect(g[0]!.summary.text).toBe("2/2 up · 1 needs you");
    expect(g[0]!.label).toBe("orbit · orbit-1042");
  });
  test("the chip is the checkout in stack mode and the stack in worktree mode", () => {
    expect(groupsView(fleet, { groupBy: "stack", q: "", answer: null, open: {} })[0]!.chip).toMatchObject({ text: "orbit-1042" });
    const w = groupsView(fleet, { groupBy: "worktree", q: "", answer: null, open: {} });
    expect(w.find((x) => x.key === "orbit-1042")!.chip).toMatchObject({ text: "orbit" });
  });
  test("the filter and the answer both narrow, and open every stack", () => {
    const g = groupsView(fleet, { groupBy: "stack", q: "", answer: "need", open: {} });
    expect(g.map((x) => x.key)).toEqual(["orbit"]);
    expect(g[0]!.containers.map((x) => x.id)).toEqual(["b"]);
    expect(groupsView(fleet, { groupBy: "stack", q: "tools", answer: null, open: {} }).map((x) => x.key)).toEqual(["acme-tools"]);
  });
  test("a stack that is fine and was left folded stays folded; one that needs you never does", () => {
    const g = groupsView(fleet, { groupBy: "stack", q: "", answer: null, open: { orbit: false, "acme-tools": false } });
    expect(g.find((x) => x.key === "orbit")!.folded).toBe(false);
    expect(g.find((x) => x.key === "acme-tools")!.folded).toBe(true);
  });
  test("the map keeps the whole fleet, needing ones first", () => {
    const m = mapGroups(fleet, "stack");
    expect(m.map((x) => x.key)).toEqual(["orbit", "acme-tools"]);
    expect(m[0]!.label).toBe("orbit · orbit-1042");
    expect(needFirst(fleet).map((x) => x.id)).toEqual(["b", "a", "c"]);
  });
});

describe("stepping through the visible containers", () => {
  test("gives the position and the neighbours, and none past the ends", () => {
    expect(stepOf(["a", "b", "c"], "b") as unknown).toEqual({ i: 2, n: 3, prev: "a", next: "c" });
    expect(stepOf(["a", "b", "c"], "a") as unknown).toEqual({ i: 1, n: 3, prev: null, next: "b" });
    expect(stepOf(["a"], "zzz") as unknown).toEqual({ i: 0, n: 1, prev: null, next: null });
  });
});

describe("the navigator counts", () => {
  test("containers carry the amber need count and the total", () => {
    const n = navCounts(ov({ containers: [sick("a"), c({ id: "b" })], images: [{} as never], volumes: [], networks: [{} as never, {} as never] }));
    expect(n).toEqual({ need: 1, containers: 2, images: 1, volumes: 0, networks: 2 });
  });
  test("is absent before any state", () => expect(navCounts(null)).toBeNull());
});

describe("stats from the feed", () => {
  const s = (id: string, cpu = 1): DockerStat => ({ id, cpu, mem: 1, memUsage: "1MiB / 2GiB", netIO: "", blockIO: "", pids: 1 });
  test("the feed covers the whole host, the view keeps what it shows", () => {
    const m = mergeStats([s("a", 7), s("zzz")], new Set(["a", "b"]));
    expect(Object.keys(m)).toEqual(["a"]);
    expect(m.a!.cpu).toBe(7);
  });
  test("with nothing known yet it keeps all, so the first sample is not lost", () => {
    expect(Object.keys(mergeStats([s("a"), s("b")], new Set()))).toEqual(["a", "b"]);
  });
});

describe("the layout choice", () => {
  test("defaults to List and remembers Split", () => {
    expect(LAYOUT_KEY).toBe("agx.docker.layout");
    expect(readLayout(() => null)).toBe("list");
    expect(readLayout(() => "split")).toBe("split");
    expect(readLayout(() => "nonsense")).toBe("list");
    expect(readLayout(() => { throw new Error("private mode"); })).toBe("list");
  });
});
