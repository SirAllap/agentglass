/*
 * The Agents page's own rows: the gate's two choices. The page reads the two
 * server settings from the settings door; the worker roles live in
 * Orchestration, and this page only points there.
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
  const html = (over?: Partial<HookSetupStatus>, busy = false) => renderToStaticMarkup(React.createElement(GateCard, { st: st(over), busy, onGate() {}, open: false, onShow() {}, showTitle: "The Agents view opens here." }));
  test("three rows with one line of help each, and the long words behind Details", () => {
    const h = html();
    for (const w of ["Ask me before anything leaves this machine", "Who answers", "If nobody answers", "Waiting actions show up in the Agents view first.", "After the wait, the action is dropped, never sent.", "Drop it", "Ask again"]) expect(h).toContain(w);
    expect(h.match(/Details/g)!.length).toBeGreaterThanOrEqual(3);
  });
  test("off asks for a decision; on reports it; a build without a gate says so", () => {
    expect(html()).toContain("Off · needs a decision");
    expect(html({ gate: true })).toContain(">On</");
    expect(html({ gateBundled: false })).toContain("Not in this build");
  });
  test("the whole row is one switch, and it refuses while it is busy or absent", () => {
    const off = html();
    expect(off).toContain('role="switch"');
    expect(off).toContain('aria-checked="false"');
    expect(html({ gate: true })).toContain('aria-checked="true"');
    expect(html({ gate: true }, true)).toContain('disabled=""');
    expect(html({ gateBundled: false })).not.toContain('role="switch"');
  });
  test("the strip says what waits and where, whichever way the gate is set", () => {
    for (const h of [html(), html({ gate: true })]) {
      expect(h).toContain("agx-gate-strip");
      expect(h).toContain("Waiting actions live in the Agents view.");
      for (const w of ["a push", "a pull request", "a review", "a comment", "a merge", "a message"]) expect(h).toContain(w);
    }
    expect(html()).toContain("Off: nothing is stopped.");
    expect(html({ gate: true })).toContain("On: an outward action waits for you.");
  });
});

describe("the worker roles have one home", () => {
  test("neither the Agents card file nor the modal draws a roles card", async () => {
    const cards = strip(await Bun.file(new URL("../src/components/agents/AgentsCards.tsx", import.meta.url)).text());
    const modal = strip(await Bun.file(new URL("../src/components/SettingsModal.tsx", import.meta.url)).text());
    for (const src of [cards, modal]) {
      expect(src).not.toContain("WorkerRolesCard");
      expect(src).not.toContain('title="Worker roles"');
    }
  });
});
