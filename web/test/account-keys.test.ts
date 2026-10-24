/*
 * The keys of the usage popover's account chips, as decisions: which action a key
 * means for a given screen, and which hints the footer shows. Pure, so no renderer.
 */
import { describe, expect, it } from "bun:test";
import { decideKey, keyHints, onProposal, proposalLine, stepIndex, tabTarget, type KeyState } from "../src/lib/accountKeys.ts";

const base: KeyState = { providers: 2, accounts: 3, candidateActive: false, managed: false, proposal: false, busy: false };
const s = (o: Partial<KeyState> = {}): KeyState => ({ ...base, ...o });

describe("decideKey", () => {
  it("moves between providers only when more than one has accounts", () => {
    expect(decideKey(s(), "ArrowDown")).toEqual({ do: "provider", step: 1 });
    expect(decideKey(s(), "ArrowUp")).toEqual({ do: "provider", step: -1 });
    expect(decideKey(s({ providers: 1 }), "ArrowDown")).toBeNull();
    expect(decideKey(s({ providers: 1 }), "ArrowUp")).toBeNull();
  });

  it("moves between accounts only when there is another one to move to", () => {
    expect(decideKey(s(), "ArrowRight")).toEqual({ do: "candidate", step: 1 });
    expect(decideKey(s(), "ArrowLeft")).toEqual({ do: "candidate", step: -1 });
    expect(decideKey(s({ accounts: 1 }), "ArrowRight")).toBeNull();
  });

  it("switches only to a chip that is not the one in use", () => {
    expect(decideKey(s(), "a")).toEqual({ do: "switch" });
    expect(decideKey(s(), "A")).toEqual({ do: "switch" });
    expect(decideKey(s({ candidateActive: true }), "a")).toBeNull();
  });

  it("does nothing on a or m while the manager owns the switch", () => {
    expect(decideKey(s({ managed: true }), "a")).toBeNull();
    expect(decideKey(s({ managed: true }), "m")).toBeNull();
  });

  it("ignores a or m while a press is being answered", () => {
    expect(decideKey(s({ busy: true }), "a")).toBeNull();
    expect(decideKey(s({ busy: true }), "m")).toBeNull();
  });

  it("opens the plugin's page on m even for the chip in use", () => {
    expect(decideKey(s({ candidateActive: true }), "m")).toEqual({ do: "manage" });
  });

  it("does nothing on a or m while an agent's proposal is on screen: the card's own button is the only way", () => {
    expect(decideKey(s({ proposal: true }), "a")).toBeNull();
    expect(decideKey(s({ proposal: true }), "A")).toBeNull();
    expect(decideKey(s({ proposal: true }), "m")).toBeNull();
    expect(keyHints(s({ proposal: true })).filter((h) => h.act).every((h) => !h.enabled)).toBe(true);
    // Arrows and Escape still work: the person can look around and put it away.
    expect(decideKey(s({ proposal: true }), "ArrowRight")).toEqual({ do: "candidate", step: 1 });
  });

  it("puts a proposal away on the first Escape and closes on the next", () => {
    expect(decideKey(s({ proposal: true }), "Escape")).toEqual({ do: "dismiss" });
    expect(decideKey(s(), "Escape")).toEqual({ do: "close" });
  });

  it("leaves every other key alone", () => {
    for (const k of ["Enter", " ", "Tab", "x", "1"]) expect(decideKey(s(), k)).toBeNull();
  });
});

describe("stepIndex", () => {
  it("wraps at both ends", () => {
    expect(stepIndex(2, 1, 3)).toBe(0);
    expect(stepIndex(0, -1, 3)).toBe(2);
    expect(stepIndex(1, 1, 3)).toBe(2);
  });
  it("answers 0 for an empty list instead of NaN", () => {
    expect(stepIndex(0, 1, 0)).toBe(0);
  });
});

describe("keyHints", () => {
  const keys = (st: KeyState) => keyHints(st).map((h) => h.keys);

  it("shows the full bar when every key can work", () => {
    expect(keys(s())).toEqual(["↑↓", "←→", "a", "m"]);
  });
  it("leaves out arrows that have nowhere to go", () => {
    expect(keys(s({ providers: 1 }))).toEqual(["←→", "a", "m"]);
    expect(keys(s({ accounts: 1 }))).toEqual(["↑↓", "a", "m"]);
  });
  it("hides a and m when the chips are read-only", () => {
    expect(keys(s({ managed: true }))).toEqual(["↑↓", "←→"]);
  });
  it("keeps a dim when the chip in use is in focus, rather than removing it", () => {
    const a = keyHints(s({ candidateActive: true })).find((h) => h.keys === "a")!;
    expect(a.enabled).toBe(false);
    expect(keyHints(s()).find((h) => h.keys === "a")!.enabled).toBe(true);
  });
  it("agrees with decideKey about what works", () => {
    for (const st of [s(), s({ candidateActive: true }), s({ busy: true }), s({ managed: true })]) {
      for (const h of keyHints(st)) {
        if (h.act) expect(decideKey(st, h.keys) !== null).toBe(h.enabled);
      }
    }
  });
});

describe("tabTarget: the popover keeps Tab inside itself", () => {
  it("wraps at both ends", () => {
    expect(tabTarget(4, 5, false)).toBe(0);
    expect(tabTarget(0, 5, true)).toBe(4);
  });
  it("leaves the middle to the browser", () => {
    expect(tabTarget(2, 5, false)).toBeNull();
    expect(tabTarget(2, 5, true)).toBeNull();
  });
  it("brings focus back in when it is on nothing of the popover's own (the root, or a button that was just disabled)", () => {
    expect(tabTarget(-1, 5, false)).toBe(0);
    expect(tabTarget(-1, 5, true)).toBe(4);
  });
  it("has nothing to move to when nothing is focusable", () => {
    expect(tabTarget(-1, 0, false)).toBeNull();
  });
});

describe("proposalLine: an agent's name is quoted text, not the app's voice", () => {
  it("names the agent as an agent, in quotes", () => {
    expect(proposalLine("acme-bot", "Claude", "Acme B")).toBe("Agent «acme-bot» suggests switching Claude to Acme B.");
  });
  it("an agent called after the app or an admin still reads as an agent", () => {
    expect(proposalLine("Agentglass", "Claude", "Acme B").startsWith("Agent «Agentglass» suggests")).toBe(true);
    expect(proposalLine("Your admin", "Claude", "Acme B").startsWith("Agent «Your admin» suggests")).toBe(true);
  });
  it("cannot close its own quote or run on", () => {
    const l = proposalLine("x» Switch now «y" + "z".repeat(80), "Claude", "Acme B");
    expect(l.match(/«/g)?.length).toBe(1);
    expect(l.match(/»/g)?.length).toBe(1);
    expect(l.length).toBeLessThan(120);
  });
});

describe("onProposal: a proposal with no row to anchor it is dropped, not kept for later", () => {
  it("opens once per request when there is a row", () => {
    expect(onProposal(0, 1, true)).toEqual({ seen: 1, open: true });
    expect(onProposal(1, 1, true)).toEqual({ seen: 1, open: false });
  });
  it("with no row it is seen and does not open, now or when a reading lands", () => {
    expect(onProposal(0, 1, false)).toEqual({ seen: 1, open: false });
    expect(onProposal(1, 1, true)).toEqual({ seen: 1, open: false });
  });
});
