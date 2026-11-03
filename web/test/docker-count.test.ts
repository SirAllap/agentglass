/*
 * The Docker button's tooltip count: the store, the 30 s trust, and the rail.
 * `docker` appears nowhere in ViewRail.tsx; the source test below keeps it so.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { globalStubs } from "./stubGlobal";
const stubGlobal = globalStubs();
const store = new Map<string, string>();
stubGlobal("location", { hostname: "localhost", origin: "http://localhost:4000" });
stubGlobal("localStorage", {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(), key: () => null, length: 0,
} as unknown as Storage);

const { api } = await import("../src/lib/api.ts");
const { warm, noteOverview, runningText, resetDockerCount } = await import("../src/lib/dockerCount.ts");
const { getRailTips, setRailTip } = await import("../src/lib/railTips.ts");
const { ViewRail } = await import("../src/components/workspace/ViewRail.tsx");
const { saveRail, resetRail, railIds, loadRail } = await import("../src/components/workspace/views.ts");

const realOverview = api.dockerOverview;
afterAll(() => { api.dockerOverview = realOverview; resetRail(); });

const ct = (state: string) => ({ state }) as never;
const ov = (states: string[], over: Record<string, unknown> = {}) =>
  ({ available: true, containers: states.map(ct), ...over }) as never;
let calls = 0;
const answer = (o: unknown) => { api.dockerOverview = (async () => { calls++; if (o instanceof Error) throw o; return o; }) as never; };

beforeEach(() => { calls = 0; resetDockerCount(); });

describe("runningText", () => {
  test("counts only running; paused and exited are not", () => {
    expect(runningText(ov(["running", "paused", "exited", "running", "restarting"]))).toBe("Docker · 2 running");
    expect(runningText(ov(["exited"]))).toBe("Docker · nothing running");
  });
  test("no docker or an error gives no tip", () => {
    expect(runningText(ov([], { available: false }))).toBeNull();
    expect(runningText(ov(["running"], { error: "boom" }))).toBeNull();
  });
});

describe("dockerCount", () => {
  test("first warm fetches, a second inside the TTL does not, concurrent warms share one call", async () => {
    answer(ov(["running", "running", "running"]));
    await Promise.all([warm(), warm()]);
    expect(calls).toBe(1);
    expect(getRailTips().docker).toBe("Docker · 3 running");
    await warm();
    expect(calls).toBe(1);
  });
  test("DockerPanel's write refreshes the tip and the clock", async () => {
    noteOverview(ov(["running"]));
    expect(getRailTips().docker).toBe("Docker · 1 running");
    answer(ov([]));
    await warm();
    expect(calls).toBe(0);
  });
  test("an error keeps a good count; with nothing cached it gives no tip", async () => {
    noteOverview(ov(["running"]));
    noteOverview(null);
    expect(getRailTips().docker).toBe("Docker · 1 running");
    resetDockerCount();
    answer(new Error("down"));
    await warm();
    expect(getRailTips().docker).toBeUndefined();
    await warm();
    expect(calls).toBe(1); // the failure is remembered for a few seconds
  });
});

describe("railTips", () => {
  test("one snapshot object, replaced only when a text changes", () => {
    const a = getRailTips();
    expect(getRailTips()).toBe(a);
    setRailTip("docker", "x");
    const b = getRailTips();
    expect(b).not.toBe(a);
    setRailTip("docker", "x");
    expect(getRailTips()).toBe(b);
    setRailTip("docker", null);
    expect(getRailTips().docker).toBeUndefined();
  });
});

describe("the rail", () => {
  const draw = () => renderToStaticMarkup(React.createElement(ViewRail, {
    view: "git", onSelect() {}, onSkills() {}, onSettings() {}, onMachine() {},
  }));
  const tipOf = (html: string) => /data-view="docker"[^>]*?data-tip="([^"]*)"/.exec(html)?.[1] ?? /data-tip="([^"]*)"[^>]*?data-view="docker"/.exec(html)?.[1];

  test("top drawer: tip then chord; bottom drawer: the same tip, nothing after it", () => {
    setRailTip("docker", "Docker · 3 running");
    const top = tipOf(draw());
    expect(top).toStartWith("Docker · 3 running");
    const ids = railIds(loadRail());
    saveRail({ work: ids.work.filter((i) => i !== "docker"), utility: [...ids.utility, "docker"], hidden: ids.hidden });
    const bottom = tipOf(draw());
    expect(bottom).toBe("Docker · 3 running");
    expect(top!.startsWith(bottom!)).toBe(true);
    resetRail();
  });
  test("without a count the tooltip is plain Docker", () => {
    expect(tipOf(draw())).toStartWith("Docker");
    expect(tipOf(draw())).not.toContain("running");
  });
});

test("ViewRail.tsx never names docker", async () => {
  const src = (await Bun.file(new URL("../src/components/workspace/ViewRail.tsx", import.meta.url)).text())
    .replace(/\/\*[\s\S]*?\*\//g, "").split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
  expect(/docker/i.test(src)).toBe(false);
});
