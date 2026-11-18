import { describe, expect, test } from "bun:test";
import { noteRestarts, restartsInWindow } from "../src/lib/dockerRestarts.ts";

const MIN = 60_000;
describe("restart window", () => {
  test("one reading has nothing to compare with", () => {
    expect(restartsInWindow(noteRestarts([], 0, 3), 3)).toBeNull();
  });
  test("counts the change since the first kept reading", () => {
    let h = noteRestarts([], 0, 2);
    h = noteRestarts(h, 5 * MIN, 5);
    h = noteRestarts(h, 9 * MIN, 8);
    expect(restartsInWindow(h, 8)).toBe(6);
  });
  test("drops readings older than the window", () => {
    let h = noteRestarts([], 0, 0);
    h = noteRestarts(h, 5 * MIN, 4);
    h = noteRestarts(h, 20 * MIN, 5);
    expect(restartsInWindow(h, 5)).toBe(1);
  });
  test("a lower total means a new container: start over", () => {
    let h = noteRestarts([], 0, 9);
    h = noteRestarts(h, MIN, 1);
    expect(restartsInWindow(h, 1)).toBeNull();
  });
});

import { healthLine } from "../src/lib/dockerDetail.ts";
test("the restart-loop line names the window when known", () => {
  const c = { id: "a", name: "orbit-worker-1", image: "x", state: "restarting", status: "Restarting (137) 3 seconds ago", ports: "", project: "orbit", service: "worker", workingDir: null, runningFor: "", size: "", restarts: 40 } as never;
  expect(healthLine(c, 6)?.rest).toContain("6 restarts in 10 min, last exit code 137");
  expect(healthLine(c)?.rest).toContain("40 restarts");
});
