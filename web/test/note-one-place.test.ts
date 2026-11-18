import { beforeAll, describe, expect, test } from "bun:test";
import { globalStubs } from "./stubGlobal";

// Notifications v2: one notification, one place. A waiting agent (an open gate
// hold) or any own note on this path shows as a card only while the window has
// the person's focus; shown-but-unfocused, hidden or closed, it is the desktop
// popup only, and the note waits in the bell.
const cell = new Map<string, string>();
const stubGlobal = globalStubs();
let dnd: typeof import("../src/lib/desktopDnd.ts");
let policy: typeof import("../src/lib/notePolicy.ts");

beforeAll(async () => {
  stubGlobal("localStorage", {
    getItem: (k: string) => cell.get(k) ?? null,
    setItem: (k: string, v: string) => { cell.set(k, v); },
    removeItem: (k: string) => { cell.delete(k); },
  });
  stubGlobal("location", { hostname: "localhost", origin: "http://localhost:4000" });
  dnd = await import("../src/lib/desktopDnd.ts");
  policy = await import("../src/lib/notePolicy.ts");
  dnd.receiveDesktopDnd({ supported: true, on: false });
});

const hold = { app: "gate", source: "gate", urgency: 2 as const, key: "hold" };
const own = { app: "agentglass", source: "agentglass", urgency: 2 as const };
const where = (n: typeof hold | typeof own) => {
  const d = policy.deliveryFor(n, { muted: new Set(), quiet: false, silence: false, rules: {} });
  return policy.whereItShows(n, d, dnd.attentionNow());
};
const window = (visibilityState: "visible" | "hidden", focused: boolean) =>
  stubGlobal("document", { visibilityState, hidden: visibilityState === "hidden", hasFocus: () => focused });

describe("a waiting agent shows in exactly one place", () => {
  for (const n of [hold, own]) {
    test(`${n.app}: focused, the card only`, () => {
      window("visible", true);
      expect(where(n)).toEqual({ card: true, desktop: false });
    });
    test(`${n.app}: shown but unfocused (another workspace), the desktop popup only`, () => {
      window("visible", false);
      expect(where(n)).toEqual({ card: false, desktop: true });
    });
    test(`${n.app}: hidden, the desktop popup only`, () => {
      window("hidden", false);
      expect(where(n)).toEqual({ card: false, desktop: true });
    });
    test(`${n.app}: closed (no window to draw a card in), the desktop popup only`, () => {
      // A closed window runs no page; what the page would decide for it is
      // the hidden answer, and the card has nowhere to go.
      window("hidden", false);
      const s = { ...dnd.attentionNow(), visible: false };
      const d = policy.deliveryFor(n, { muted: new Set(), quiet: false, silence: false, rules: {} });
      expect(policy.whereItShows(n, d, s)).toEqual({ card: false, desktop: true });
    });
  }
});
