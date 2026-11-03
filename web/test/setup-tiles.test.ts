/*
 * Step 1's tiles, from one `/engines` report.
 *
 * There is no DOM harness here; the markup is rendered statically, which is
 * enough to assert the reading order and that exactly one tile carries the ring.
 * The write itself is read from SetupFlow's source: a pick writes `setup.agent`
 * and Continue does not, and that is the difference the reload case depends on.
 */
import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import type { EngineReadiness, EnginesReport } from "../../shared/types.ts";
import { SETUP_AGENTS, agentTiles, noneInstalled } from "../src/lib/setupAgents.ts";
import { AgentStep } from "../src/components/setup/AgentStep.tsx";

const engine = (id: string, over: Partial<EngineReadiness> = {}): EngineReadiness => ({
  id, title: id, found: true, path: `/usr/bin/${id}`, version: "1.2.3", min: null, versionOk: true,
  account: { signedIn: true }, answers: { state: "never" },
  roles: { worker: { ok: true }, orchestrator: { ok: true } }, missing: [],
  envelope: { via: null, enforced: "no", note: "" }, ...over,
});

const report: EnginesReport = {
  host: "acme-desk",
  engines: [
    engine("claude"),
    engine("opencode", { account: { signedIn: false } }),
    engine("codex", { found: false, path: null, version: null, account: { signedIn: null } }),
    engine("gemini", { found: false, path: null, version: null, account: { signedIn: null } }),
    engine("hermes", { account: { signedIn: null } }),
    engine("antigravity"),
  ],
};

describe("the tile states", () => {
  const tiles = agentTiles(report, "opencode");

  test("the five are engine ids, in one fixed order (the reading order)", () => {
    expect(tiles.map((t) => t.id)).toEqual(SETUP_AGENTS.map((a) => a.id));
    expect(tiles.map((t) => t.id)).not.toContain("antigravity");
  });

  test("signed in, not signed in and not installed read differently", () => {
    expect(tiles.find((t) => t.id === "claude")).toMatchObject({ state: "Detected · signed in", tone: "ok", installable: false });
    expect(tiles.find((t) => t.id === "opencode")).toMatchObject({ state: "Detected · not signed in", tone: "warn", installable: false });
    expect(tiles.find((t) => t.id === "codex")).toMatchObject({ state: "Not installed", tone: "off", installable: true });
    // A CLI that is there and will not say who it is is not signed in.
    expect(tiles.find((t) => t.id === "hermes")).toMatchObject({ state: "Detected · not signed in", tone: "warn" });
  });

  test("the pick rings one tile, and only one", () => {
    expect(tiles.filter((t) => t.picked).map((t) => t.id)).toEqual(["opencode"]);
  });

  test("a report that could not be read keeps the tiles and says no state", () => {
    expect(agentTiles(null, "claude").every((t) => t.state === null)).toBe(true);
  });

  test("none installed is its own sentence, one installed is not", () => {
    const nothing = { host: "acme-desk", engines: [] } satisfies EnginesReport;
    expect(noneInstalled(agentTiles(nothing, "claude"))).toBe(true);
    expect(noneInstalled(agentTiles(report, "claude"))).toBe(false);
  });
});

describe("the rendered step", () => {
  const html = renderToStaticMarkup(React.createElement(AgentStep, {
    report, error: false, picked: "opencode", busy: false, display: null, onPick: () => {}, onRecheck: () => {},
  }));

  test("one button per tile, in reading order", () => {
    const ids = [...html.matchAll(/id="setup-agent-([a-z]+)"/g)].map((m) => m[1]);
    expect(ids).toEqual([...SETUP_AGENTS.map((a) => a.id)]);
  });

  test("exactly one tile carries the ring", () => {
    expect([...html.matchAll(/data-on="1"/g)]).toHaveLength(1);
    expect(html).toContain('id="setup-agent-opencode"');
  });

  test("a failed read draws the sentence and the Recheck, not invented states", () => {
    const failed = renderToStaticMarkup(React.createElement(AgentStep, {
      report: null, error: true, picked: "claude", busy: false, display: null, onPick: () => {}, onRecheck: () => {},
    }));
    expect(failed).toContain("Could not read this machine&#x27;s agents.");
    expect(failed).toContain("Recheck");
    expect(failed).not.toContain("Detected ·");
  });

  test("the count says none rather than counting zero of them", () => {
    const none = renderToStaticMarkup(React.createElement(AgentStep, {
      report: { host: "acme-desk", engines: [] }, error: false, picked: "claude", busy: false, display: null, onPick: () => {}, onRecheck: () => {},
    }));
    expect(none).toContain("none detected on this machine yet");
    expect(none).not.toContain("0 detected");
    expect(html).toContain("3 detected on this machine, pick one");
  });
});

describe("what a pick writes, and what Continue does not", () => {
  const flow = readFileSync(new URL("../src/components/setup/SetupFlow.tsx", import.meta.url), "utf8");
  const block = (start: string, end: string) => flow.slice(flow.indexOf(start), flow.indexOf(end, flow.indexOf(start)));

  test("picking writes setup.agent at once", () => {
    expect(block("const pickAgent", "const pickMode")).toContain('settingsDoorSet("setup.agent"');
  });

  test("Continue writes that a run is open, never the agent", () => {
    const next = block("const next = async () =>", "const skip");
    expect(next).toContain('settingsDoorSet("setup.inProgress", true)');
    expect(next).not.toContain("setup.agent");
  });

  test("Finish and Skip close the run as well as the setup", () => {
    const fin = block("const finish =", "const next");
    expect(fin).toContain('settingsDoorSet("setup.done", true)');
    expect(fin).toContain('settingsDoorSet("setup.inProgress", false)');
  });
});
