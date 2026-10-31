/*
 * "Analyze with agent": the prompt a cleanup agent starts from, when the button
 * may be pressed, and which launcher the button uses. The prompt is the only
 * safety net the agent gets before its first command, so its rules are asserted
 * word for word.
 */
import { describe, expect, test } from "bun:test";
import type { DockerContainer, DockerDisk, DockerImage, DockerVolume } from "../../shared/types.ts";
import { analyzeGate, analyzePrompt, analyzeTitle, type AnalyzeSnapshot } from "../src/lib/dockerAnalyze.ts";
import { READ_ONLY_REASON } from "../src/lib/dockerState.ts";

const GB = 1e9;
const ct = (id: string, over: Partial<DockerContainer> = {}): DockerContainer => ({
  id, name: `orbit-${id}-1`, image: `acme/orbit-${id}:dev`, state: "running", status: "Up 1 hour", ports: "", project: "orbit",
  service: id, workingDir: null, runningFor: "", size: "", ...over,
});
const img = (id: string, tag: string, size: string, over: Partial<DockerImage> = {}): DockerImage => ({
  id, repository: "acme/orbit-old", tag, size, created: "3 hours ago", containers: "0", dangling: false, ...over,
});
const vol = (name: string): DockerVolume => ({ name, driver: "local" }) as DockerVolume;
const disk: DockerDisk = {
  images: 12 * GB, containers: 1 * GB, volumes: 9 * GB, buildCache: 70 * GB, reclaimable: 0,
  orphans: [{ id: "bb", tag: "acme/orbit-old:dev", bytes: 3 * GB, worktree: "billing-fix" }],
  volumes_: [
    { name: "orbit_node_modules", bytes: 2 * GB, links: 1 },
    { name: "orbit_pgdata", bytes: 7 * GB, links: 1 },
  ],
  at: 0,
};
const snap = (over: Partial<AnalyzeSnapshot> = {}): AnalyzeSnapshot => ({
  project: "orbit", workspace: "/work/orbit",
  containers: [ct("api"), ct("worker", { state: "exited", status: "Exited (1) 2 hours ago" })],
  images: [img("bb", "dev", "3GB"), img("dd3f9a1c2b7e", "<none>", "200MB", { dangling: true })],
  volumes: [vol("orbit_node_modules"), vol("orbit_pgdata")],
  networks: 3, disk, ...over,
});

describe("analyzePrompt", () => {
  const p = analyzePrompt(snap());
  test("carries the safety rules", () => {
    expect(p).toContain("READ-ONLY");
    expect(p).toContain("docker system df -v");
    expect(p).toContain("git worktree list");
    expect(p).toMatch(/ask me before EVERY removal/i);
    expect(p).toMatch(/one at a time/i);
    expect(p).toMatch(/NEVER remove a data volume unless I type its name/);
    expect(p).toContain("NEVER run `docker system prune --volumes`");
    expect(p).toMatch(/rebuild would cost/i);
  });
  test("starts where the Disk view stops: totals, what can come back, cache, volumes, trouble", () => {
    expect(p).toContain("Project: orbit (/work/orbit)");
    expect(p).toContain("92.0 GB");                                // 12+1+9+70
    expect(p).toContain("acme/orbit-old:dev");                     // worktree-gone image
    expect(p).toContain("billing-fix");
    expect(p).toMatch(/1 dangling image/);
    expect(p).toMatch(/Build cache: 70\.0 GB.*budget 60\.0 GB.*10\.0 GB over/);
    expect(p).toMatch(/node_modules volumes: 1 .*2\.0 GB/);
    expect(p).toMatch(/Data volumes: 1 .*7\.0 GB/);
    expect(p).toContain("orbit_pgdata");
    expect(p).toContain("worker");                                 // the crashed container
    expect(p).toMatch(/2 containers, 2 images, 2 volumes, 3 networks/);
  });
  test("with no disk figures it tells the agent to measure first", () => {
    const q = analyzePrompt(snap({ disk: null }));
    expect(q).toMatch(/not measured/i);
    expect(q).toContain("READ-ONLY");
  });
  test("is bounded: a hundred images do not make a hundred lines", () => {
    const many = Array.from({ length: 100 }, (_, i) => img(`d${i}`, "<none>", "1MB", { dangling: true }));
    expect(analyzePrompt(snap({ images: many })).split("\n").length).toBeLessThan(80);
  });
});

describe("analyzeGate", () => {
  test("enabled when Docker answers and writes are on", () => {
    expect(analyzeGate({ readOnly: false, situation: "normal" })).toEqual({ disabled: false, reason: "" });
  });
  test("read-only, down and not installed each say why", () => {
    expect(analyzeGate({ readOnly: true, situation: "normal" })).toEqual({ disabled: true, reason: READ_ONLY_REASON });
    expect(analyzeGate({ readOnly: false, situation: "down" }).reason).toMatch(/not running/i);
    expect(analyzeGate({ readOnly: false, situation: "notinstalled" }).reason).toMatch(/not installed/i);
  });
});

describe("analyzeTitle", () => {
  test("names the agent that will run, or says the setting", () => {
    expect(analyzeTitle("Codex")).toContain("Codex");
    expect(analyzeTitle(null)).toMatch(/Worker roles/);
  });
});

describe("the launcher", () => {
  const src = (f: string) => Bun.file(new URL(f, import.meta.url)).text();
  const fn = (text: string, head: string) => {
    const i = text.indexOf(head);
    expect(i).toBeGreaterThan(-1);
    return text.slice(i, text.indexOf("\n}\n", i));
  };
  test("the button opens a bench agent tab with the builder's provider, not a hard-coded Claude", async () => {
    const lib = await src("../src/lib/lanternAsk.ts");
    const body = fn(lib, "export async function askBuilderOnBench(");
    expect(body).toContain("workerRoles()");
    expect(body).toContain("builder?.provider");
    expect(body).toContain("askOnBench(");
    const ask = fn(lib, "export async function askOnBench(");
    expect(ask).toContain("kind");
    const panel = await src("../src/components/DockerPanel.tsx");
    expect(panel).toContain("askBuilderOnBench(");
    expect(panel).toContain("analyzePrompt(");
    const hdr = await src("../src/components/docker/Header.tsx");
    expect(hdr).toContain("Analyze with agent");
  });
});
