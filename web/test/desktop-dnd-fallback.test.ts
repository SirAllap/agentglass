import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { globalStubs } from "./stubGlobal";

// Off Omarchy there is no way to read the desktop's DND, so the switch is
// agentglass's own: stored here, and still read by whereItShows.
const cell = new Map<string, string>();
let dnd: typeof import("../src/lib/desktopDnd.ts");

beforeAll(async () => {
  stubGlobal("localStorage", {
    getItem: (k: string) => cell.get(k) ?? null,
    setItem: (k: string, v: string) => { cell.set(k, v); },
    removeItem: (k: string) => { cell.delete(k); },
  });
  stubGlobal("location", { hostname: "localhost", origin: "http://localhost:4000" });
  dnd = await import("../src/lib/desktopDnd.ts");
});
afterAll(() => { cell.clear(); });
const stubGlobal = globalStubs();

describe("Desktop DND where the desktop cannot say", () => {
  test("unsupported: the switch is stored by agentglass and read back", async () => {
    dnd.receiveDesktopDnd({ supported: false, on: false });
    await dnd.setDesktopDnd(true);
    expect(cell.get("agentglass.notes.dnd")).toBe("1");
    expect(dnd.desktopDnd()).toEqual({ supported: false, on: true });
    expect(dnd.screenNow().dnd).toBe(true);
    // A server that still says "unsupported" keeps the person's choice.
    dnd.receiveDesktopDnd({ supported: false, on: false });
    expect(dnd.desktopDnd().on).toBe(true);
  });
  test("supported: the desktop's answer wins over the stored one", () => {
    dnd.receiveDesktopDnd({ supported: true, on: false });
    expect(dnd.desktopDnd()).toEqual({ supported: true, on: false });
  });
  test("break through DND is on unless turned off", () => {
    expect(dnd.breakThrough()).toBe(true);
    dnd.setBreakThrough(false);
    expect(dnd.breakThrough()).toBe(false);
    expect(dnd.screenNow().breakThrough).toBe(false);
  });
});

describe("own notes count the window as seen only while it has focus", () => {
  test("shown but unfocused (another workspace): not seen, so the popup goes out", () => {
    let focused = false;
    stubGlobal("document", { visibilityState: "visible", hidden: false, hasFocus: () => focused });
    expect(dnd.screenNow().visible).toBe(true);
    expect(dnd.attentionNow().visible).toBe(false);
    focused = true;
    expect(dnd.attentionNow().visible).toBe(true);
  });
  test("hidden: not seen, focus or not", () => {
    stubGlobal("document", { visibilityState: "hidden", hidden: true, hasFocus: () => true });
    expect(dnd.attentionNow().visible).toBe(false);
  });
});
