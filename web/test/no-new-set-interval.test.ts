// House rule: no polling. A raw setInterval needs a reason here; the rest go through
// usePoll / pollWhileLooking (fetches, pause on blur) or useNow / useVisibleInterval (clocks, pause hidden).
import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const SRC = join(import.meta.dir, "..", "src");
const ALLOW: Record<string, { max: number; why: string }> = {
  "lib/usePoll.ts": { max: 1, why: "the poll primitive itself" },
  "lib/visibleInterval.ts": { max: 2, why: "the clock primitive itself" },
  "components/BrowserPanel.tsx": { max: 1, why: "30 s host heartbeat: liveness, must run while hidden (server lanes.ts HOST_GONE_MS)" },
  "components/LaneHost.tsx": { max: 1, why: "30 s lane host heartbeat: liveness, must run while hidden (server lanes.ts HOST_GONE_MS)" },
  "lib/laneManager.ts": { max: 1, why: "30 s lane manager heartbeat: liveness, must run while hidden (server lanes.ts HOST_GONE_MS)" },
  "components/PrPanel.tsx": { max: 1, why: "list/detail refresh gated on visible+focus with a catch-up on return" },
  "components/finder/machine/MachineFinder.tsx": { max: 1, why: "edge autoscroll, only during a drag" },
  "components/jira/JiraStepDialog.tsx": { max: 1, why: "110 ms row reveal animation that clears itself" },
  "components/projects/SidePanes.tsx": { max: 1, why: "undo-toast countdown tied to the toast's own 6 s timeout" },
  "lib/alarm.ts": { max: 1, why: "the ringing alarm repeats until stopped or timed out" },
  "lib/browserDrive.ts": { max: 1, why: "wait-for-condition inside the guest page; ends at its own deadline; also wraps timers to count them" },
  "lib/demo.ts": { max: 2, why: "demo mode only: fake stream" },
  "lib/updateStore.ts": { max: 1, why: "6 h release check, desktop only" },
};

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : /\.(ts|tsx)$/.test(n) && !/\.test\./.test(n) ? [p] : [];
  });
}

test("setInterval only in the allow-list, each with a reason and a max count per file", () => {
  const bad: string[] = [];
  const seen = new Set<string>();
  for (const f of files(SRC)) {
    const rel = relative(SRC, f);
    const n = readFileSync(f, "utf8").split("\n").filter((l) => /\bsetInterval\s*\(/.test(l) && !/^\s*(\/\/|\*|\/\*)/.test(l)).length;
    if (!n) continue;
    seen.add(rel);
    const allowed = ALLOW[rel];
    if (!allowed || !allowed.why || n > allowed.max) bad.push(`${rel}: ${n} found, ${allowed?.max ?? 0} allowed`);
  }
  expect(bad).toEqual([]);
  expect([...Object.keys(ALLOW)].filter((k) => !seen.has(k))).toEqual([]);
});

test("manifest summary polls on visibility only, not focus", () => {
  const src = readFileSync(join(SRC, "lib", "manifest.ts"), "utf8");
  expect(src).toContain("intervalWhileVisible(");
  expect(src).not.toContain("pollWhileLooking(");
});

// A view that stays mounted behind another one must hand its `active` to the poll.
// `usePoll(true, …)` is only for what is on screen whenever the window is: each
// entry says why it has no view to stop with.
const ALWAYS_ON: Record<string, string> = {
  "App.tsx": "session titles feed the agents every view draws, not one view; 30 s, window-gated",
  "components/workspace/ViewRail.tsx": "the rail is on screen whenever the workspace is; 5 min, window-gated",
};

test("usePoll(true) only where no view hides it, each with a reason", () => {
  const bad: string[] = [];
  const seen = new Set<string>();
  for (const f of files(SRC)) {
    const rel = relative(SRC, f);
    const hit = readFileSync(f, "utf8").split("\n").some((l) => /\busePoll\(\s*true\b/.test(l) && !/^\s*(\/\/|\*|\/\*)/.test(l));
    if (!hit) continue;
    seen.add(rel);
    if (!ALWAYS_ON[rel]) bad.push(rel);
  }
  expect(bad).toEqual([]);
  expect(Object.keys(ALWAYS_ON).filter((k) => !seen.has(k))).toEqual([]);
});

test("the polls that were left running behind another view take its active", () => {
  const has = (rel: string, s: string) => expect(readFileSync(join(SRC, rel), "utf8")).toContain(s);
  has("components/PairPanel.tsx", "usePoll(active, poll, 2000)");
  has("components/settings/pages/RemoteDevicesPage.tsx", "active={open}");
  has("components/StarboardWorkerLive.tsx", "usePoll(active, load, READ_POLL_MS)");
  has("components/StarboardView.tsx", "<WorkerLive name={scope.worker} active={active} />");
  has("components/LanesRow.tsx", "usePoll(active, read, 10_000)");
  has("components/BrowserPanel.tsx", "<LanesRow active={viewOn} />");
});

// These beats keep the server's lane alive. server/src/lanes.ts drops a lane whose host
// stops beating after HOST_GONE_MS (60 s), so a hidden or minimized window that paused them
// would kill every agent's browser lane within a minute.
test("lane host heartbeats are not visibility-gated (lanes.ts HOST_GONE_MS)", () => {
  for (const rel of ["components/BrowserPanel.tsx", "components/LaneHost.tsx", "lib/laneManager.ts"]) {
    const src = readFileSync(join(SRC, rel), "utf8");
    expect(src, `${rel}: gating the heartbeat on visibility lets lanes.ts HOST_GONE_MS (60 s) drop every lane while hidden`).toContain("setInterval(beat, 30_000)");
    expect(src, `${rel}: heartbeat must not use intervalWhileVisible (lanes.ts HOST_GONE_MS)`).not.toMatch(/intervalWhileVisible|useVisibleInterval|pollWhileLooking|usePoll/);
  }
});
