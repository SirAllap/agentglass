/*
 * The way back from a view an agent switched to (lib/agentBack.ts).
 *
 * Measured: an agent that opened a view for the person took them out of the chat
 * where it kept talking, and nothing marked the way back. These pin when the
 * offer appears, that it keeps the person's FIRST place across several switches,
 * and that the doors which can replace the view are all armed.
 */
import { beforeEach, describe, expect, it } from "bun:test";
import { ARM_MS, BACK_MS, EMPTY, VIEW_SWITCHERS, arm, back, backText, live, noteView } from "../src/lib/agentBack.ts";

beforeEach(() => back.reset());

describe("when the offer appears", () => {
  it("an armed door that moved the view offers the way back, with the name", () => {
    const s = noteView(arm(EMPTY, "chat", "orchestrator-agx", 1000), "git", 1500);
    expect(s.offer).toEqual({ from: "chat", to: "git", as: "orchestrator-agx", at: 1500 });
    expect(s.armed).toBeNull();
  });

  it("a view change nobody armed offers nothing", () => {
    expect(noteView(EMPTY, "git", 1000)).toEqual(EMPTY);
  });

  it("an arm that went stale is not an agent's switch: the person's own click gets no chip", () => {
    const s = noteView(arm(EMPTY, "chat", undefined, 1000), "git", 1000 + ARM_MS + 1);
    expect(s.offer).toBeNull();
  });

  it("a door that left the person where they were offers nothing, and drops a standing offer", () => {
    const s0 = noteView(arm(EMPTY, "chat", "a", 0), "git", 10);
    const s1 = noteView(arm(s0, "git", "a", 20), "chat", 30);
    expect(s1.offer).toBeNull();
  });

  it("the person leaving the agent's view by hand takes the offer with them", () => {
    const s0 = noteView(arm(EMPTY, "chat", "a", 0), "git", 10);
    expect(noteView(s0, "files", 10_000).offer).toBeNull();
    expect(noteView(s0, "git", 10_000).offer).toEqual(s0.offer); // a re-render on the same view keeps it
  });

  it("a second switch keeps the first place, not the agent's first view", () => {
    const s0 = noteView(arm(EMPTY, "chat", "a", 0), "git", 10);
    const s1 = noteView(arm(s0, "git", "a", 20), "files", 30);
    expect(s1.offer).toMatchObject({ from: "chat", to: "files" });
  });

  it("an offer is live for a minute and then is not", () => {
    const o = { from: "chat", to: "git", at: 0 } as const;
    expect(live(o, BACK_MS - 1)).toBe(o);
    expect(live(o, BACK_MS)).toBeNull();
    expect(live(null, 0)).toBeNull();
  });
});

describe("the store", () => {
  it("dismiss drops the offer without touching the arm", () => {
    back.arm("chat", "a", 0);
    back.noteView("git", 5);
    expect(back.offer()?.from).toBe("chat");
    back.dismiss();
    expect(back.offer()).toBeNull();
  });
});

describe("the words", () => {
  it("names the place and the agent, and falls back to 'An agent'", () => {
    expect(backText("Chat", "orchestrator-agx")).toBe("Back to Chat · orchestrator-agx");
    expect(backText("Chat", undefined)).toBe("Back to Chat · An agent");
  });
});

describe("every door that can replace the view is armed", async () => {
  const handlers = (await Bun.file(new URL("../src/lib/uiActions.ts", import.meta.url)).text()).split("\n");
  const app = await Bun.file(new URL("../src/App.tsx", import.meta.url)).text();

  it("the three the owner named are in the list", () => {
    for (const id of ["view.open", "pane.open", "workspace.toggle"]) expect(VIEW_SWITCHERS as readonly string[]).toContain(id);
  });

  it("a handler that calls goView or workspace is in the list, so a new one cannot skip the chip", () => {
    const found: string[] = [];
    for (const l of handlers) {
      const m = /^\s+"([a-z.]+)":\s*(.*)$/.exec(l);
      if (m && /c\.goView\(|c\.workspace\(/.test(m[2]!)) found.push(m[1]!);
    }
    expect(found.length).toBeGreaterThan(3);
    for (const id of found) expect(VIEW_SWITCHERS as readonly string[], id).toContain(id);
  });

  it("the window arms before it runs a switching door, and watches the view", () => {
    expect(app).toMatch(/VIEW_SWITCHERS\.includes\(door\)\) back\.arm\(wsViewRef\.current, meta\?\.as\)/);
    expect(app).toContain("back.noteView(wsView)");
    expect(app).toContain("<AgentChangeChip onBack={goView} />");
  });
});

describe("the skill an agent reads says how to show without taking the chat", async () => {
  const skill = await Bun.file(new URL("../../skills/ui-control/SKILL.md", import.meta.url)).text();
  const at = skill.indexOf("**Show me without taking the chat away.**");
  const rule = skill.slice(at, skill.indexOf("- **Do not change a setting", at));

  it("the rule is there, and names the overlays, the switchers, saying so first and switching back", () => {
    expect(at).toBeGreaterThan(0);
    for (const w of ["panel.open", "machine.open", "peek.file", "bench", "git.modal", "view.open", "pane.open", "workspace.toggle", "BEFORE", "switch back", "Back to"]) {
      expect(rule, w).toContain(w);
    }
  });

  it("every door it calls an overlay is not a view switcher", () => {
    for (const id of ["panel.open", "machine.open", "peek.file", "bench.toggle", "bench.file", "bench.board", "git.modal", "git.compare", "git.blame", "git.rebase"]) {
      expect(VIEW_SWITCHERS as readonly string[], id).not.toContain(id);
    }
  });
});
