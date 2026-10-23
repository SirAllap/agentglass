/*
 * The Agents page's own rows: the gate's two choices, the new-chat defaults and
 * the reviewer among the worker roles. The page reads the five server settings
 * from the settings door; two of them (where a new chat opens, and its mode)
 * are acted on by the chat panel, so the panel's use is pinned against source,
 * as there is no renderer here to open a chat.
 */
import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { globalStubs } from "./stubGlobal";
const mem = new Map<string, string>();
globalStubs()("localStorage", { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => { mem.set(k, v); }, removeItem: (k: string) => { mem.delete(k); } });
const { GateCard, NewChatsCard } = await import("../src/components/agents/AgentsCards.tsx");
const D = await import("../src/lib/agentDefaults.ts");
import type { HookSetupStatus } from "../../shared/types.ts";

const st = (over: Partial<HookSetupStatus> = {}): HookSetupStatus =>
  ({ installed: true, gate: false, gateBundled: true, bundled: true, settingsPath: "~/.claude/settings.json", python: "python3", pythonVersion: "3.12", ...over });
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("what the door's list says", () => {
  test("every field falls back to the default when the server does not say, or says something else", () => {
    expect(D.readDefaults([])).toEqual(D.AGENT_DEFAULTS);
    expect(D.readDefaults([{ id: "chats.mode", value: "bypassPermissions" }, { id: "gate.answerer", value: 7 }, { id: "chats.deny", value: "Edit" }])).toEqual(D.AGENT_DEFAULTS);
  });
  test("what it does say is kept", () => {
    const d = D.readDefaults([
      { id: "gate.answerer", value: "orchestrator" }, { id: "gate.onTimeout", value: "ask" }, { id: "chats.startIn", value: "open" },
      { id: "chats.mode", value: "plan" }, { id: "chats.deny", value: ["Edit", "Bash(rm:*)"] },
    ]);
    expect(d).toEqual({ gateAnswerer: "orchestrator", gateOnTimeout: "ask", chatStartIn: "open", chatMode: "plan", chatDeny: ["Edit", "Bash(rm:*)"] });
  });
  test("a chat opens with what was last remembered, and with the old behaviour before anything was", () => {
    expect(D.chatDefaults()).toMatchObject({ chatStartIn: "last", chatMode: "inherit" });
    D.rememberDefaults({ ...D.AGENT_DEFAULTS, chatStartIn: "open", chatMode: "acceptEdits" });
    expect(D.chatDefaults()).toMatchObject({ chatStartIn: "open", chatMode: "acceptEdits" });
    expect(JSON.parse(mem.get("agentglass.chat.defaults")!)).toEqual({ "chats.startIn": "open", "chats.mode": "acceptEdits" });
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

describe("the new chats card", () => {
  const html = (over: Partial<Parameters<typeof NewChatsCard>[0]> = {}) => renderToStaticMarkup(React.createElement(NewChatsCard, {
    open: false, tmuxEngine: { available: true, reason: "", defaultOn: false } as never, enginePref: null, onEngine() {}, ...over,
  }));
  test("the four rows of the mockup, in its order", () => {
    const h = html();
    const at = ["How new chats run", "Starts in", "Permission mode", "Extra deny rules"].map((w) => h.indexOf(w));
    expect(at.every((i) => i > -1)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(h).toContain("Last project");
    expect(h).toContain("Like the open chat");
    expect(h).toContain("Edit rules");
  });
  test("two ways to run, and the one the server defaults to is the one drawn when nothing was chosen", () => {
    const pressed = (h: string) => [...h.matchAll(/aria-pressed="true"[^>]*>([^<]+)</g)].map((m) => m[1]);
    expect(pressed(html())).toEqual(["Separate"]);
    expect(pressed(html({ tmuxEngine: { available: true, reason: "", defaultOn: true } as never }))).toEqual(["tmux panes"]);
    expect(pressed(html({ enginePref: "tmux" }))).toEqual(["tmux panes"]);
  });
  test("panes that cannot run say why and cannot be picked", () => {
    const h = html({ tmuxEngine: { available: false, reason: "tmux is not on this machine", defaultOn: false } as never });
    expect(h).toContain("tmux panes unavailable: tmux is not on this machine.");
    expect(h).toMatch(/aria-pressed="[a-z]+"[^>]*disabled/);
  });
});

const panel = strip(await Bun.file(new URL("../src/components/ChatPanel.tsx", import.meta.url)).text());
const cards = strip(await Bun.file(new URL("../src/components/agents/AgentsCards.tsx", import.meta.url)).text());
describe("what acts on them", () => {
  test("a new chat opens in the open project, or in the permission mode set, when the settings say so", () => {
    expect(panel).toContain('chatDefaults().chatStartIn === "open" ? workspace : null');
    expect(panel).toContain('agent === "claude" && chatDefaults().chatMode !== "inherit" ? chatDefaults().chatMode');
    expect(panel).toContain("void loadDefaults()");
  });
  test("the roles are drawn in the picture's order, so the reviewer has its row", () => {
    expect(cards).toContain("JOB_ORDER.map");
    expect(cards).toContain('reviewer: "Reads it adversarially"');
  });
  test("the deny rules row says which chats take them: only Claude's", () => {
    expect(cards).toContain("added to every new Claude chat. Codex and Antigravity chats do not take deny rules.");
  });
});
