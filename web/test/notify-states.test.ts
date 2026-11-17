// The three states of the approved mockup (.agx-tmp/mockup.html): what the chip,
// the bell and Settings ▸ Pop-ups say, from one pure answer.
import { describe, expect, test } from "bun:test";
import { levelFrom, levelOf, notifyStates, storedOf, POP_LEVELS } from "../src/lib/notifyStates.ts";
import { searchSettings } from "../src/lib/settingsIndex.ts";
import { deliveryFor, whereItShows, type PolicyState } from "../src/lib/notePolicy.ts";
import type { PopLevel } from "../src/lib/notifyStates.ts";

const pill = (s: ReturnType<typeof notifyStates>, id: string) => s.wins.find((w) => w.id === id)!;
const where = (s: ReturnType<typeof notifyStates>, id: string) => s.where.find((w) => w.id === id)!;

describe("notifyStates", () => {
  test("state 1: DND off, everything pops up", () => {
    const s = notifyStates({ dnd: false, silenced: false, level: "all", waiting: 0, breakThrough: true });
    expect(s.chip).toBe("DND off");
    expect(s.silencedChip).toBe(false);
    expect(s.bell.pops.label).toBe("Pops up: everything");
    expect(s.wins.map((w) => w.id)).toEqual(["agent", "silence", "dnd", "level"]);
    expect(pill(s, "agent")).toMatchObject({ pill: "none now", active: false });
    expect(pill(s, "silence")).toMatchObject({ pill: "off", active: false });
    expect(pill(s, "dnd")).toMatchObject({ pill: "off", active: false });
    expect(pill(s, "level")).toMatchObject({ pill: "All", active: true });
    expect(where(s, "apps")).toMatchObject({ main: "Desktop popup", sub: "agentglass: bell only" });
    expect(where(s, "news")).toMatchObject({ main: "agentglass card", sub: "desktop popup only when the window is hidden" });
    expect(where(s, "agent").main).toBe("Always pops up");
  });

  test("state 2: DND on, agents only, one waiting", () => {
    const s = notifyStates({ dnd: true, silenced: false, level: "agents", waiting: 1, breakThrough: true });
    expect(s.chip).toBe("DND on");
    expect(s.bell.dnd.label).toBe("DND on");
    expect(s.bell.pops.label).toBe("Pops up: agents only");
    expect(pill(s, "agent")).toMatchObject({ pill: "1 waiting", active: true });
    expect(pill(s, "dnd")).toMatchObject({ pill: "on", active: true });
    expect(pill(s, "level")).toMatchObject({ pill: "Agents", active: true });
    expect(where(s, "apps")).toMatchObject({ main: "Bell only", sub: "no desktop popup, no card" });
    expect(where(s, "news")).toMatchObject({ main: "Bell only", sub: "no card" });
    expect(where(s, "agent").sub).toBe("desktop popup too (break through on)");
  });

  test("state 3: DND off and Silence all holds What pops up at Nothing", () => {
    const s = notifyStates({ dnd: false, silenced: true, level: levelFrom(true, true, true), waiting: 0, breakThrough: true });
    expect(s.chip).toBe("DND off");
    expect(s.silencedChip).toBe(true);
    expect(s.bell.pops.label).toBe("Pops up: nothing");
    expect(s.bell.pops.said).toContain("Silence all wins");
    expect(pill(s, "silence")).toMatchObject({ pill: "on · wins", active: true });
    expect(pill(s, "level")).toMatchObject({ pill: "held", active: false });
    expect(where(s, "apps")).toMatchObject({ main: "Desktop popup", sub: "the desktop draws it; agentglass: bell only" });
    expect(where(s, "news").main).toBe("Bell only");
  });

  test("What pops up keeps Volume's stored values", () => {
    expect(POP_LEVELS.map((l) => `${l.label}=${l.stored}`)).toEqual(["Nothing=off", "Agents=quiet", "Apps=normal", "All=loud"]);
    for (const l of POP_LEVELS) expect(levelOf(storedOf(l.id))).toBe(l.id);
    expect(levelFrom(false, false, false)).toBe("apps");
    expect(levelFrom(false, false, true)).toBe("all");
  });

  test("settings search still finds the old word Volume on the renamed row", () => {
    const hits = searchSettings("volume", [{ id: "notifications", label: "Notifications", kw: "" }]);
    expect(hits.some((h) => h.pane === "notifications" && h.label === "What pops up")).toBe(true);
  });

  // The table is said by hand; this holds it to the router that really places a note
  // (deliveryFor + whereItShows), window on screen, for every switch combination.
  test("Where it shows now agrees with whereItShows", () => {
    const notes = {
      apps: { app: "Slack", source: "desktop:slack", urgency: 1 as const },
      news: { app: "git", source: "git", urgency: 1 as const },
      agent: { app: "claude", source: "agent", urgency: 2 as const },
    };
    for (const dnd of [false, true]) for (const silenced of [false, true]) for (const level of ["agents", "apps", "all"] as PopLevel[]) {
      const policy: PolicyState = { muted: new Set(), quiet: level === "agents", silence: silenced, rules: { agentglass: level === "all" ? "popup" : "bell", "desktop:slack": "popup" } };
      const s = notifyStates({ dnd, silenced, level, waiting: 0, breakThrough: true });
      for (const id of ["apps", "news", "agent"] as const) {
        const n = notes[id];
        const real = whereItShows(n, deliveryFor(n, policy), { dnd, visible: true, breakThrough: true });
        const said = where(s, id).main;
        const ctx = `${id} dnd=${dnd} silenced=${silenced} level=${level}: said ${said}`;
        // Another app with DND off: the desktop draws its own popup, so agentglass places nothing.
        if (said === "Desktop popup") expect({ ctx, real }).toEqual({ ctx, real: { card: false, desktop: false } });
        else expect({ ctx, card: real.card }).toEqual({ ctx, card: said !== "Bell only" });
      }
    }
  });
});
