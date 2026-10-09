/*
 * The "requested" hold must outlive a reload of the window: it used to live in
 * component state only, so the button came back enabled for a pull request
 * whose request was still pending. The store is sessionStorage, expiring with
 * the longest standing that reads it.
 */
import { describe, expect, test } from "bun:test";
import { globalStubs } from "./stubGlobal.ts";
import { saveOwnUpdate, loadOwnUpdate } from "../src/lib/ownUpdateStore.ts";
import { STALLED_SHOWN_MS, updateStanding, updateHeld } from "../../shared/justUpdated.ts";

const stubGlobal = globalStubs();
function memoryStorage(throwing = false) {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => { if (throwing) throw new Error("blocked"); return m.get(k) ?? null; },
    setItem: (k: string, v: string) => { if (throwing) throw new Error("blocked"); m.set(k, v); },
  };
}

const NOW = Date.parse("2026-10-09T13:04:00Z");
const KEY = "/work/orbit#1042";

describe("own Update branch request, kept for the session", () => {
  test("a reload gets the request back and the button stays held", () => {
    stubGlobal("sessionStorage", memoryStorage());
    saveOwnUpdate(KEY, { number: 1042, at: NOW - 30_000, headBefore: "aaa1111" });
    const own = loadOwnUpdate(KEY, 1042, NOW);
    expect(own).not.toBeNull();
    const s = updateStanding({ now: NOW, own, headSha: "aaa1111", checksTotal: 4 });
    expect(s).toBe("requested");
    expect(updateHeld(s)).toBe(true);
  });

  test("another pull request, or an expired entry, reads nothing", () => {
    stubGlobal("sessionStorage", memoryStorage());
    saveOwnUpdate(KEY, { number: 1042, at: NOW - 30_000, headBefore: "aaa1111" });
    expect(loadOwnUpdate(KEY, 1043, NOW)).toBeNull();
    expect(loadOwnUpdate(KEY, 1042, NOW + STALLED_SHOWN_MS)).toBeNull();
    expect(loadOwnUpdate("/work/orbit#9", 9, NOW)).toBeNull();
  });

  test("storage that throws or holds junk never breaks the panel", () => {
    stubGlobal("sessionStorage", memoryStorage(true));
    expect(() => saveOwnUpdate(KEY, { number: 1042, at: NOW, headBefore: "a" })).not.toThrow();
    expect(loadOwnUpdate(KEY, 1042, NOW)).toBeNull();
    const junk = memoryStorage();
    junk.setItem("agx.ownUpdate:" + KEY, "{not json");
    stubGlobal("sessionStorage", junk);
    expect(loadOwnUpdate(KEY, 1042, NOW)).toBeNull();
  });
});
