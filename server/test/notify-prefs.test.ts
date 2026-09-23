/*
 * The notification diet's shared model, and its persistence on disk.
 *
 * shared/notifyPrefs.ts is imported by both the server and the web client, so
 * its rules are pinned here without booting either: the defaults (only
 * `blocked` and `reminders` interrupt out of the box), coercion of a
 * hand-edited or forged file, the `notifies()` truth table, and the three
 * message strings alerts.ts actually measured against real traffic.
 *
 * The persistence half follows plugins.test.ts's own pattern for
 * plugins.json: a scratch XDG_CONFIG_HOME per test, and NODE_ENV=test so
 * notifyPrefs.ts's own `offLimits` guard would refuse anything outside it —
 * the same rule that keeps a suite run from reading or clobbering a
 * developer's real prefs.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_NOTIFY_PREFS, coerceNotifyPrefs, notifies, kindOfNotification, NOTIFY_KINDS, NOTIFY_CHANNELS,
} from "../../shared/notifyPrefs.ts";

describe("DEFAULT_NOTIFY_PREFS", () => {
  test("only blocked and reminders interrupt out of the box", () => {
    expect(DEFAULT_NOTIFY_PREFS.none).toBe(false);
    expect(DEFAULT_NOTIFY_PREFS.kinds.blocked).toBe(true);
    expect(DEFAULT_NOTIFY_PREFS.kinds.reminders).toBe(true);
    for (const k of NOTIFY_KINDS) {
      if (k === "blocked" || k === "reminders") continue;
      expect(DEFAULT_NOTIFY_PREFS.kinds[k], k).toBe(false);
    }
    for (const c of NOTIFY_CHANNELS) expect(DEFAULT_NOTIFY_PREFS.channels[c], c).toBe(true);
  });
});

describe("coerceNotifyPrefs", () => {
  test("junk in every position falls back to the default, not to a throw", () => {
    expect(coerceNotifyPrefs(null)).toEqual(DEFAULT_NOTIFY_PREFS);
    expect(coerceNotifyPrefs("not an object")).toEqual(DEFAULT_NOTIFY_PREFS);
    expect(coerceNotifyPrefs({ none: "yes", kinds: "nope", channels: 3 })).toEqual(DEFAULT_NOTIFY_PREFS);
  });

  test("an unknown key is dropped rather than carried through", () => {
    const p = coerceNotifyPrefs({ kinds: { blocked: false, madeUpKind: true } });
    expect(p.kinds.blocked).toBe(false);
    expect((p.kinds as Record<string, unknown>).madeUpKind).toBeUndefined();
  });

  test("a non-boolean value for a real key falls back to that key's default rather than being trusted", () => {
    const p = coerceNotifyPrefs({ kinds: { blocked: "yes", idle: 1 } });
    // "yes" is truthy but not `true` — the one value that turns a kind on.
    expect(p.kinds.blocked).toBe(true); // falls back to blocked's own default, which is on
    expect(p.kinds.idle).toBe(false); // idle's own default, which is off
  });

  test("a genuine change round-trips exactly", () => {
    const raw = { none: true, kinds: { ...DEFAULT_NOTIFY_PREFS.kinds, idle: true }, channels: { ...DEFAULT_NOTIFY_PREFS.channels, sound: false } };
    expect(coerceNotifyPrefs(raw)).toEqual(raw);
  });
});

describe("notifies", () => {
  const base = DEFAULT_NOTIFY_PREFS;
  test("the default blocked kind notifies on every channel", () => {
    for (const c of NOTIFY_CHANNELS) expect(notifies(base, "blocked", c), c).toBe(true);
  });
  test("a kind that is off notifies on no channel", () => {
    for (const c of NOTIFY_CHANNELS) expect(notifies(base, "idle", c), c).toBe(false);
  });
  test("a kind that is on but a channel that is off notifies on no other channel", () => {
    const p = { ...base, channels: { ...base.channels, chip: false } };
    expect(notifies(p, "blocked", "chip")).toBe(false);
    expect(notifies(p, "blocked", "bell")).toBe(true);
  });
  test("none silences a kind that is otherwise fully on", () => {
    const p = { ...base, none: true };
    expect(notifies(p, "blocked", "desktop")).toBe(false);
  });
});

describe("kindOfNotification", () => {
  // The three message shapes alerts.ts's own comment measured over 7 days of
  // real traffic: 279 "waiting for your input", 6 "needs your permission", 3
  // "needs your approval", 2 "usage limit reset".
  test("a permission or approval message is the real block", () => {
    expect(kindOfNotification("Claude needs your permission to use Bash")).toBe("blocked");
    expect(kindOfNotification("A message from another session needs your approval")).toBe("blocked");
  });
  test("a usage limit message is its own kind, not a block", () => {
    expect(kindOfNotification("Usage limit reset — Claude is continuing your task")).toBe("usage");
  });
  test("the common case — waiting for input — is idle, not a block", () => {
    expect(kindOfNotification("Claude is waiting for your input")).toBe("idle");
  });
});

describe("persistence — server/src/notifyPrefs.ts", () => {
  const REAL_XDG = process.env.XDG_CONFIG_HOME;
  let dir: string;
  let mod: typeof import("../src/notifyPrefs.ts");

  beforeEach(async () => {
    process.env.NODE_ENV = "test";
    dir = mkdtempSync(join(tmpdir(), "agx-notify-prefs-"));
    process.env.XDG_CONFIG_HOME = dir;
    // A fresh module instance per test: readNotifyPrefs() caches, and the
    // cache is what a stale XDG_CONFIG_HOME from a previous test would leak
    // through — see CLAUDE.md's "known leaks" list.
    mod = await import(`../src/notifyPrefs.ts?u=${Math.random()}`);
  });
  afterEach(() => {
    if (REAL_XDG === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = REAL_XDG;
  });

  test("nothing on disk reads back the default, and writes nothing", () => {
    expect(mod.readNotifyPrefs()).toEqual(DEFAULT_NOTIFY_PREFS);
    expect(existsSync(mod.notifyPrefsPath())).toBe(false);
  });

  test("a write persists, and a fresh read of the file agrees with it", () => {
    const written = mod.writeNotifyPrefs({ none: false, kinds: { ...DEFAULT_NOTIFY_PREFS.kinds, idle: true }, channels: DEFAULT_NOTIFY_PREFS.channels });
    expect(written.kinds.idle).toBe(true);
    const onDisk = JSON.parse(readFileSync(mod.notifyPrefsPath(), "utf8"));
    expect(onDisk.kinds.idle).toBe(true);
    mod.__resetNotifyPrefsCache();
    expect(mod.readNotifyPrefs().kinds.idle).toBe(true);
  });

  test("a corrupt file on disk falls back to default rather than taking the read down", () => {
    mod.writeNotifyPrefs({});
    writeFileSync(mod.notifyPrefsPath(), "{not json");
    mod.__resetNotifyPrefsCache();
    expect(mod.readNotifyPrefs()).toEqual(DEFAULT_NOTIFY_PREFS);
  });
});
