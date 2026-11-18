import { describe, expect, test } from "bun:test";
import { LANE_BUSY_MS, islandLanes, laneBoxName, nextQuiet, overviewCounts, publishLanes, subscribeLanes } from "../src/lib/laneView.ts";
import type { LaneRow } from "../../shared/types.ts";

const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
const island = strip(await Bun.file(new URL("../src/components/browser/BrowserIsland.tsx", import.meta.url)).text());
const watch = strip(await Bun.file(new URL("../src/components/browser/LaneWatch.tsx", import.meta.url)).text());
const panel = strip(await Bun.file(new URL("../src/components/BrowserPanel.tsx", import.meta.url)).text());
const live = strip(await Bun.file(new URL("../src/lib/useLive.ts", import.meta.url)).text());

const NOW = 1_000_000;
const row = (o: Partial<LaneRow>): LaneRow => ({ id: "l1", container: "private", created: NOW - 60_000, lastAsk: NOW - 60_000, ...o });

describe("a lane's box", () => {
  test("a vault lane says which box, by the name Settings shows", () => {
    expect(laneBoxName(row({ container: "ephemeral", vault: "Zen — Orbit", vaultId: "zen:abc/0" }))).toBe("Vault lane · Zen — Orbit");
    expect(laneBoxName(row({ container: "named", name: "acme" }))).toBe("Lane · acme");
    expect(laneBoxName(row({}))).toBe("Lane");
  });

  test("names the agent and its page, and is working only for LANE_BUSY_MS after an ask", () => {
    const [l] = islandLanes([row({ as: "orbit-1", lastAsk: NOW - 1000 })], [{ id: "l1", url: "https://acme.test/", title: "Acme" }], NOW);
    expect(l).toMatchObject({ id: "l1", agent: "orbit-1", busy: true, title: "Acme", url: "https://acme.test/" });
    expect(islandLanes([row({ lastAsk: NOW - LANE_BUSY_MS })], [], NOW)[0]!.busy).toBe(false);
    expect(islandLanes([row({})], [], NOW)[0]!.agent).toBe("An agent");
  });

  test("the soonest working lane is when the overview next changes, with no timer for a quiet one", () => {
    expect(nextQuiet([row({ lastAsk: NOW - 4000 }), row({ id: "l2", lastAsk: NOW - 8000 })], NOW)).toBe(2000);
    expect(nextQuiet([row({})], NOW)).toBeNull();
  });
});

describe("the overview counts lanes", () => {
  test("a lane is one container, one tab and one agent; a working lane is a working agent", () => {
    const lanes = islandLanes([row({ as: "orbit-1", lastAsk: NOW - 10 }), row({ id: "l2", as: "acme" })], [], NOW);
    expect(overviewCounts({ agents: [], busy: [], containers: 1, tabs: 2 }, lanes)).toEqual({ agents: 2, busy: 1, containers: 3, tabs: 4 });
    /* Lanes opened with no --as are each their own agent, not one "An agent". */
    const anon = islandLanes([row({ lastAsk: NOW - 10 }), row({ id: "l2", lastAsk: NOW - 10 }), row({ id: "l3", lastAsk: NOW - 10 })], [], NOW);
    expect(overviewCounts({ agents: [], busy: [], containers: 0, tabs: 0 }, anon)).toMatchObject({ agents: 3, busy: 3 });
    /* The same agent in a tab and a lane is one agent. */
    expect(overviewCounts({ agents: ["orbit-1"], busy: [], containers: 1, tabs: 1 }, lanes.slice(0, 1)).agents).toBe(1);
  });

  test("the sentence on top is built from those counts, and each lane gets its own box and card", () => {
    expect(island).toContain('{sum.busy === sum.agents ? "working"');
    expect(island).toContain("<strong>{sum.containers}</strong>");
    expect(island).toContain("<strong>{sum.tabs}</strong>");
    expect(island).toMatch(/shownLanes\.map\(\(l, i\) =>/);
    expect(island).toContain("p.onShowLane?.(l.id)");
  });
});

describe("pushed, and shown on --show", () => {
  test("the live socket's lanes frame reaches subscribers with the lane to show", () => {
    const got: Array<[number, string | undefined]> = [];
    const off = subscribeLanes((r, show) => got.push([r.length, show]));
    publishLanes({ lanes: [row({})], show: "l1" });
    publishLanes({ lanes: [] });
    off();
    publishLanes({ lanes: [row({})] });
    expect(got).toEqual([[1, "l1"], [0, undefined]]);
    expect(live).toContain('if (frame.type === "lanes") { publishLanes(frame.data); return; }');
  });

  test("--show only marks the lane in the overview; the watch opens from the person's own click", () => {
    /* An agent never covers the person's page: seen beside, never instead. */
    expect(panel).not.toContain("useIslandLanes(setWatching)");
    expect(panel).toContain("const lanes = useIslandLanes(setCalledLane);");
    expect(panel).toContain("{watched && <LaneWatch lane={watched} onClose={() => setWatching(null)} />}");
    expect(panel).toContain("lanes={lanes} calledLane={calledLane} onShowLane={(id) => { setCalledLane(null); setWatching(id); }}");
    expect(island).toContain('(p.calledLane === l.id ? " is-called" : "")');
  });
});

describe("watching takes nothing from the agent", () => {
  test("the picture takes no pointer, and the view sends the lane nothing", () => {
    expect(watch).toContain("pointer-events-none");
    expect(watch).not.toMatch(/sendInputEvent|executeJavaScript|\.focus\(|onClick=\{[^}]*laneWatch/);
    expect(watch).toContain("return () => { stop?.(); };");
  });
});
