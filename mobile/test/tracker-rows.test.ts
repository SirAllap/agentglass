/*
 * The Task trackers list: what each row says, and that the screens that send
 * you there are wired to it. The rows are a diagnosis, so the assertions are
 * about the sentences a person reads when the Cards tab is missing.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ProviderStatus } from "../../shared/providers.ts";
import { trackerRows, trackersSummary } from "../src/model/trackerRows.ts";

const none: ProviderStatus[] = [
  { id: "clickup", state: "needs-auth" },
  { id: "taskwarrior", state: "missing-tool" },
  { id: "github", state: "connected" },
];

describe("task tracker rows", () => {
  test("a machine with nothing connected explains each tracker", () => {
    const rows = trackerRows(none);
    expect(rows.map((r) => r.title)).toEqual(["ClickUp", "Taskwarrior", "Jira"]);
    const by = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(by.clickup).toMatchObject({ badge: "off" });
    expect(by.clickup!.reason).toContain("Connect it on the computer");
    expect(by.taskwarrior).toMatchObject({ badge: "off", reason: "The task tool is not installed on the computer." });
    expect(by.jira).toMatchObject({ badge: "soon" });
    expect(by.jira!.reason).toContain("Not supported");
    expect(trackersSummary(none)).toBe("None connected · Cards tab hidden");
  });

  test("connected and failing both count as set up, like the bar's rule", () => {
    const rows = trackerRows([
      { id: "clickup", state: "error", detail: "ClickUp refused this token." },
      { id: "taskwarrior", state: "connected", detail: "12 pending" },
    ]);
    const by = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(by.clickup).toMatchObject({ badge: "on" });
    expect(by.clickup!.reason).toContain("refused this token");
    expect(by.taskwarrior).toMatchObject({ badge: "on", reason: "12 pending" });
    expect(trackersSummary([{ id: "taskwarrior", state: "connected" }])).toBe("Taskwarrior connected · Cards tab on");
  });

  test("no answer yet is not 'nothing connected'", () => {
    expect(trackerRows(null).find((r) => r.id === "clickup")!.reason).toBe("Waiting for the computer to answer.");
    expect(trackersSummary(null)).not.toContain("hidden");
  });
});

describe("the ways into the list", () => {
  const read = (p: string): string => readFileSync(join(import.meta.dir, "..", p), "utf8");
  test("Settings has the row and the empty Cards screen links to it", () => {
    expect(read("app/(tabs)/settings.tsx")).toMatch(/title="Task trackers"[\s\S]{0,300}?push\("\/trackers"\)/);
    expect(read("app/(tabs)/tasks.tsx")).toMatch(/provider === null[\s\S]{0,900}?push\("\/trackers"\)/);
  });
  test("the route exists", () => {
    expect(read("app/trackers.tsx")).toContain("trackerRows(");
  });
});
