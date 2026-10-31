/*
 * The container detail's decisions, out of the component: the red line under
 * the header, the stat cards, what a log line is, how the levels count, how a
 * find walks its matches, what pause says, and how env and processes read.
 */
import { describe, expect, test } from "bun:test";
import type { DockerContainer, DockerStat } from "../../shared/types.ts";
import {
  envRows, envSummary, factsOf, healthLine, hitsIn, lastIndexOf, levelCounts, markSegments, pauseLabel,
  portChips, readLog, shownBy, stepHit, streamChip, topTree,
} from "../src/lib/dockerDetail.ts";

const c = (over: Partial<DockerContainer> = {}): DockerContainer => ({
  id: "a1b2c3d4e5f6", name: "orbit-api-1", image: "acme/orbit:dev", state: "running", status: "Up 4 hours",
  ports: "", project: "orbit", service: "api", workingDir: null, runningFor: "4 hours ago", size: "",
  uptime: "Up 4 hours", restarts: 2, ...over,
});
const stat = (over: Partial<DockerStat> = {}): DockerStat => ({
  id: "a1b2c3d4e5f6", cpu: 12.34, mem: 41.6, memUsage: "416MiB / 1GiB", netIO: "", blockIO: "", pids: 4, ...over,
});

describe("the red line under the header", () => {
  test("an unhealthy container says how often, why, and how long it has been up", () => {
    const w = healthLine(c({ health: "unhealthy", healthFailures: 3, healthError: "GET /healthz answers 502\nsecond line" }))!;
    expect(w.tone).toBe("bad");
    expect(w.lead).toBe("Health check failing 3 times in a row:");
    expect(w.code).toBe("GET /healthz answers 502");
    expect(w.rest).toBe("Up 4 hours, 2 restarts.");
  });
  test("a restart loop is amber and names the last exit code", () => {
    const w = healthLine(c({ state: "restarting", status: "Restarting (1) 5 seconds ago", restarts: 7 }))!;
    expect(w.tone).toBe("amb");
    expect(w.lead).toBe("Restart loop:");
    expect(w.rest).toBe("7 restarts, last exit code 1. Docker keeps trying.");
  });
  test("a crash and a dead container each get their sentence; a quiet one gets none", () => {
    expect(healthLine(c({ state: "exited", status: "Exited (137) 2 hours ago" }))!.lead).toBe("Exited with code 137");
    expect(healthLine(c({ state: "dead", status: "Dead" }))!.lead).toBe("Docker marked this container dead.");
    expect(healthLine(c({ state: "exited", status: "Exited (0) 2 hours ago" }))).toBeNull();
    expect(healthLine(c())).toBeNull();
  });
  test("an unknown restart count is left out rather than called zero", () => {
    const w = healthLine(c({ health: "unhealthy", restarts: undefined }))!;
    expect(w.rest).toBe("Up 4 hours.");
    expect(w.lead).toBe("Health check failing:");
  });
});

describe("the four stat cards", () => {
  test("a running container: uptime with restarts, cpu and memory with their meters", () => {
    const f = factsOf(c(), stat());
    expect(f.up).toEqual({ value: "4 hours", sub: "2 restarts" });
    expect(f.cpu).toEqual({ text: "12.3 %", pct: 12.34, hot: false });
    expect(f.mem).toEqual({ text: "42 %", sub: "416MiB of 1GiB", pct: 41.6, hot: false });
  });
  test("amber at 50 for cpu and 80 for memory, not before", () => {
    expect(factsOf(c(), stat({ cpu: 49.9 })).cpu.hot).toBe(false);
    expect(factsOf(c(), stat({ cpu: 50 })).cpu.hot).toBe(true);
    expect(factsOf(c(), stat({ mem: 79.9 })).mem.hot).toBe(false);
    expect(factsOf(c(), stat({ mem: 80 })).mem.hot).toBe(true);
  });
  test("a stopped container has no meters and says why it is stopped", () => {
    const f = factsOf(c({ state: "exited", status: "Exited (1) 3 hours ago" }), stat());
    expect(f.up).toEqual({ value: "Stopped", sub: "3 hours ago" });
    expect(f.cpu).toEqual({ text: "—", pct: null, hot: false });
    expect(f.mem.pct).toBeNull();
  });
  test("paused, restarting, created and dead each have their word", () => {
    expect(factsOf(c({ state: "paused", uptime: "Up 4 hours (Paused)" }), undefined).up.value).toBe("4 hours");
    expect(factsOf(c({ state: "restarting" }), undefined).up.value).toBe("Restarting");
    expect(factsOf(c({ state: "created", status: "Created" }), undefined).up).toEqual({ value: "Not started", sub: "created, never run" });
    expect(factsOf(c({ state: "dead" }), undefined).up.value).toBe("Dead");
  });
  test("running with no sample yet is a dash, not a zero", () => {
    expect(factsOf(c(), undefined).cpu.text).toBe("—");
  });
});

describe("the ports as chips", () => {
  const web = { host: 8000, hostEnd: 8000, hostIp: "0.0.0.0", container: 8000, containerEnd: 8000, proto: "tcp" as const, web: true };
  test("a web port on a running container opens; the same port stopped does not", () => {
    expect(portChips(c({ portList: [web] }))[0]).toMatchObject({ kind: "web", url: "http://localhost:8000" });
    expect(portChips(c({ state: "exited", portList: [web] }))[0]!.kind).toBe("off");
  });
  test("a published non-web port is plain and an unpublished one says so", () => {
    expect(portChips(c({ portList: [{ ...web, web: false, host: 5432, hostEnd: 5432, container: 5432, containerEnd: 5432 }] }))[0]!.kind).toBe("plain");
    expect(portChips(c({ portList: [{ ...web, host: null, hostEnd: null, hostIp: null }] }))[0]!.title).toContain("not published");
  });
  test("none at all is an empty list", () => {
    expect(portChips(c())).toEqual([]);
  });
});

describe("reading a log", () => {
  const lines = [
    "2026-10-29T17:02:11.123456789Z INFO booting",
    "2026-10-29T17:02:12.5Z WARN slow query",
    "2026-10-29T17:02:13Z ERROR unhandled error",
    "  at handler (app.js:10)",
    "2026-10-29T17:02:14Z GET / 200",
  ];
  test("the stamp becomes a time of day and the rest is the text", () => {
    const e = readLog(lines)[0]!;
    expect(e.time).toBe("17:02:11");
    expect(e.text).toBe("INFO booting");
    expect(e.level).toBe("info");
  });
  test("an indented line carries the level of the one above, so a stack stays with its error", () => {
    const e = readLog(lines);
    expect(e[3]!.level).toBe("error");
    expect(e[3]!.tagged).toBe(false);
  });
  test("a plain line is info and has no stamp when the line has none", () => {
    const e = readLog(["just text"])[0]!;
    expect(e).toMatchObject({ time: null, text: "just text", level: "info", tagged: false });
  });
  test("counts add up to all, and the filter is exact", () => {
    const e = readLog(lines);
    expect(levelCounts(e)).toEqual({ all: 5, error: 2, warn: 1, info: 2 });
    expect(shownBy(e, "error").map((x) => x.text)).toEqual(["ERROR unhandled error", "  at handler (app.js:10)"]);
    expect(shownBy(e, "all")).toHaveLength(5);
  });
  test("the last error is the line that says so, not the stack under it; none says -1", () => {
    expect(lastIndexOf(readLog(lines), "error")).toBe(2);
    expect(lastIndexOf(readLog(["a", "b"]), "error")).toBe(-1);
  });
});

describe("find in the log", () => {
  const e = readLog(["foo bar foo", "nothing", "Foo"]);
  test("every match counts, case-insensitively, and each line knows where its first one is", () => {
    expect(hitsIn(e, "foo")).toEqual({ offsets: [0, 2, 2], total: 3 });
    expect(hitsIn(e, "  ")).toEqual({ offsets: [0, 0, 0], total: 0 });
  });
  test("a line splits into plain and marked pieces numbered from its first match", () => {
    expect(markSegments("foo bar foo", "foo", 4)).toEqual([
      { t: "foo", hit: 4 }, { t: " bar ", hit: null }, { t: "foo", hit: 5 },
    ]);
    expect(markSegments("abc", "", 0)).toEqual([{ t: "abc", hit: null }]);
  });
  test("next and previous wrap round the ends", () => {
    expect(stepHit(2, 3, 1)).toBe(0);
    expect(stepHit(0, 3, -1)).toBe(2);
    expect(stepHit(0, 0, 1)).toBe(0);
  });
});

describe("pause and the stream chip", () => {
  test("pause says how many lines are waiting once it is held", () => {
    expect(pauseLabel(false, 0)).toBe("Pause");
    expect(pauseLabel(true, 0)).toBe("Resume");
    expect(pauseLabel(true, 12)).toBe("Resume · 12 waiting");
  });
  test("live, paused, ended and snapshot, in that precedence", () => {
    expect(streamChip({ running: true, ended: null, paused: false }).key).toBe("live");
    expect(streamChip({ running: true, ended: null, paused: true }).key).toBe("paused");
    expect(streamChip({ running: true, ended: "the stream ended", paused: false }).key).toBe("ended");
    expect(streamChip({ running: false, ended: "the stream ended", paused: false }).key).toBe("snapshot");
    expect(streamChip({ running: false, ended: null, paused: false }).key).toBe("snapshot");
  });
});

describe("the environment", () => {
  const lines = ["NODE_ENV=development", "DATABASE_URL=postgres://orbit@db/orbit", "API_TOKEN=abc=def", "BARE"];
  test("a secret by name is flagged; the value keeps its own equals signs", () => {
    const r = envRows(lines, "");
    expect(r.find((x) => x.key === "API_TOKEN")).toEqual({ key: "API_TOKEN", value: "abc=def", secret: true });
    expect(r.find((x) => x.key === "NODE_ENV")!.secret).toBe(false);
    expect(r.find((x) => x.key === "BARE")).toEqual({ key: "BARE", value: "", secret: false });
  });
  test("find matches the name, not the value", () => {
    expect(envRows(lines, "url").map((x) => x.key)).toEqual(["DATABASE_URL"]);
    expect(envRows(lines, "orbit")).toEqual([]);
  });
  test("the fold's count line", () => {
    expect(envSummary(lines)).toBe("4 variables · 1 hidden");
    expect(envSummary(["A=1"])).toBe("1 variable · 0 hidden");
  });
});

describe("processes", () => {
  const text = [
    "UID  PID  PPID C STIME TTY TIME     CMD",
    "root 1    0    0 10:00 ?   00:00:01 uvicorn orbit.main:app",
    "app  28   1    9 10:00 ?   00:00:30 uvicorn worker 2",
    "app  27   1    61 10:00 ?  00:00:40 uvicorn worker 1",
    "app  44   28   0 10:01 ?   00:00:00 sh -c healthcheck",
  ].join("\n");
  test("a tree: children follow their parent, siblings by pid, depth for the indent", () => {
    const t = topTree(text)!;
    expect(t.map((r) => [r.pid, r.depth])).toEqual([["1", 0], ["27", 1], ["28", 1], ["44", 2]]);
    expect(t[1]).toMatchObject({ user: "app", cpu: "61", cmd: "uvicorn worker 1" });
  });
  test("a table without pid and command columns is left to be shown as text", () => {
    expect(topTree("NAME VALUE\nx 1")).toBeNull();
    expect(topTree("")).toBeNull();
  });
});

const detailSrc = await Bun.file(new URL("../src/components/docker/Detail.tsx", import.meta.url)).text();

describe("the detail's children keep their keys apart", () => {
  // Measured in the compiled bundle: the log view and the folds both had
  // key={c.id} inside one fragment. React then stopped removing the old log
  // view on a switch, and five clicks left five log panes, each still streaming.
  test("no two keys in the Detail fragment are the same expression", () => {
    const body = detailSrc.slice(detailSrc.indexOf("return (\n    <>"), detailSrc.indexOf("/** The variables"));
    const keys = [...body.matchAll(/\bkey=\{([^}]*(?:\{[^}]*\}[^}]*)*)\}/g)].map((m) => m[1]!);
    expect(keys.length).toBeGreaterThanOrEqual(2);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

const css = await Bun.file(new URL("../src/components/docker/resourceCss.ts", import.meta.url)).text();

describe("a resource card's secondary line ends with the same 10px the other cards do", () => {
  // A network with nothing attached ended on its secondary line, which had no
  // bottom padding and so sat on the card's edge, lower than in Images and Volumes.
  test(".dk-xsub pads its bottom like .dk-xf and .dk-xwhy", () => {
    expect(css).toMatch(/\.dk-xsub\{padding:2px 12px 10px 40px;/);
    expect(css).toMatch(/\.dk-xf\{[^}]*padding:8px 12px 10px 40px/);
  });
});
