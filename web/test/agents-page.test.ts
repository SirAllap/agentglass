/*
 * The Agents page's own rows: the gate's two choices and the reviewer among the
 * worker roles. The page reads the two server settings from the settings door.
 */
import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { globalStubs } from "./stubGlobal";
const mem = new Map<string, string>();
globalStubs()("localStorage", { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => { mem.set(k, v); }, removeItem: (k: string) => { mem.delete(k); } });
const { GateCard } = await import("../src/components/agents/AgentsCards.tsx");
const D = await import("../src/lib/agentDefaults.ts");
import type { HookSetupStatus } from "../../shared/types.ts";

const st = (over: Partial<HookSetupStatus> = {}): HookSetupStatus =>
  ({ installed: true, gate: false, gateBundled: true, bundled: true, settingsPath: "~/.claude/settings.json", python: "python3", pythonVersion: "3.12", ...over });
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("what the door's list says", () => {
  test("every field falls back to the default when the server does not say, or says something else", () => {
    expect(D.readDefaults([])).toEqual(D.AGENT_DEFAULTS);
    expect(D.readDefaults([{ id: "gate.onTimeout", value: "bypassPermissions" }, { id: "gate.answerer", value: 7 }])).toEqual(D.AGENT_DEFAULTS);
  });
  test("what it does say is kept", () => {
    const d = D.readDefaults([
      { id: "gate.answerer", value: "orchestrator" }, { id: "gate.onTimeout", value: "ask" },
    ]);
    expect(d).toEqual({ gateAnswerer: "orchestrator", gateOnTimeout: "ask" });
  });
});

describe("the gate card", () => {
  const html = (over?: Partial<HookSetupStatus>) => renderToStaticMarkup(React.createElement(GateCard, { st: st(over), busy: false, onGate() {}, open: false }));
  test("three rows with one line of help each, and the long words behind Details", () => {
    const h = html();
    for (const w of ["Hold what leaves this machine", "Who answers", "If nobody answers", "Held actions show up in the Lantern first.", "After the wait, the action is dropped, never sent.", "Drop it", "Ask again"]) expect(h).toContain(w);
    expect(h.match(/Details/g)!.length).toBeGreaterThanOrEqual(3);
  });
  test("off asks for a decision; on offers to turn it off; a build without a gate says so", () => {
    expect(html()).toContain("Turn the gate on");
    expect(html()).toContain("Off · needs a decision");
    expect(html({ gate: true })).toContain("Turn the gate off");
    expect(html({ gateBundled: false })).toContain("Not in this build");
  });
});

const cards = strip(await Bun.file(new URL("../src/components/agents/AgentsCards.tsx", import.meta.url)).text());
describe("the worker roles", () => {
  test("the roles are drawn in the picture's order, so the reviewer has its row", () => {
    expect(cards).toContain("JOB_ORDER.map");
    expect(cards).toContain('reviewer: "Reads it adversarially"');
  });
});
