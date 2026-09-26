/*
 * The on-device preference for pull-request talk notifications.
 *
 * `expo-secure-store` is stubbed rather than real — this is a phone-only
 * module under `bun test` — with a fake that always answers "nothing stored",
 * so what is asserted is the module's OWN default, not whatever this machine
 * happens to have in a keystore.
 */
import { beforeAll, describe, expect, test, mock } from "bun:test";

mock.module("expo-secure-store", () => ({
  getItemAsync: async () => null,
  setItemAsync: async () => {},
}));

let talkPref: typeof import("../src/notifications/talkPref.ts").talkPref;
let setTalkPref: typeof import("../src/notifications/talkPref.ts").setTalkPref;
let onTalkPref: typeof import("../src/notifications/talkPref.ts").onTalkPref;

beforeAll(async () => {
  const mod = await import("../src/notifications/talkPref.ts");
  ({ talkPref, setTalkPref, onTalkPref } = mod);
});

describe("the device preference for pull-request talk", () => {
  test("defaults to off when nothing is stored", () => {
    // Off, not the desk's "everything": a phone asks to be interrupted in a
    // pocket, and copying the desk's default onto every device that pairs
    // would buzz a phone nobody asked to be buzzed on its first launch.
    expect(talkPref()).toBe("off");
  });

  test("setTalkPref changes the value and tells subscribers", () => {
    let told = 0;
    const off = onTalkPref(() => { told++; });
    setTalkPref("everything");
    expect(talkPref()).toBe("everything");
    expect(told).toBe(1);
    setTalkPref("reviews");
    expect(talkPref()).toBe("reviews");
    expect(told).toBe(2);
    off();
    setTalkPref("off");
    expect(told).toBe(2);
  });
});
