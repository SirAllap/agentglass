/*
 * What the power button says about the machine's sleep.
 *
 * It said "awake" and nothing else, which could not answer the two questions
 * a person asks before closing a lid or picking suspend from the menu: is
 * something holding the machine, and what — the lid switch, and a sleep lock
 * that lets their own suspend through — and why, which agent work. On a
 * machine without systemd-inhibit it said "awake" while only the screen was
 * held.
 */
import { describe, expect, test } from "bun:test";
import { powerReadout, type PowerStatus } from "../src/lib/desktop.ts";

const linuxHeld = { sleep: "block-weak", lid: true, display: true, app: false } as const;
const linux = { platform: "linux" } as const;
const none = { chats: 0, runs: 0, hooked: 0, named: 0 };

describe("powerReadout", () => {
  test("off is normal sleep, and holds nothing", () => {
    const r = powerReadout({ mode: "off", awake: false, working: false });
    expect(r.tone).toBe("idle");
    expect(r.title).toContain("Normal sleep");
  });

  test("agent mode at work says what is working, and what is held", () => {
    const s: PowerStatus = { ...linux, mode: "agent", awake: true, working: true, why: { ...none, chats: 1, hooked: 2 }, locks: linuxHeld, inhibitMissing: false };
    const r = powerReadout(s);
    expect(r.tone).toBe("held");
    expect(r.title).toContain("1 chat mid-turn");
    expect(r.title).toContain("2 agents active in the last 10 minutes");
    expect(r.title).toContain("the lid switch");
    expect(r.title, "the person's own suspend is not blocked, and the button says so").toContain("your own suspend still goes through");
  });

  test("the plain block fallback is a weak lock too, and reads the same", () => {
    const r = powerReadout({ ...linux, mode: "on", awake: true, working: false, locks: { ...linuxHeld, sleep: "block" }, inhibitMissing: false });
    expect(r.title).toContain("your own suspend still goes through");
  });

  test("agent mode with nothing working is idle", () => {
    const r = powerReadout({ mode: "agent", awake: false, working: false, why: none, locks: { sleep: null, lid: false, display: false, app: false } });
    expect(r.tone).toBe("idle");
    expect(r.title).toContain("nothing is working");
  });

  test("awake with no systemd-inhibit is a warning, not a promise", () => {
    const r = powerReadout({ mode: "on", awake: true, working: false, locks: { sleep: null, lid: false, display: true, app: false }, inhibitMissing: true });
    expect(r.tone).toBe("warn");
    expect(r.title).toContain("systemd-inhibit");
    expect(r.title).toContain("only the screen");
  });

  test("a shell from before the locks and reasons were reported still reads", () => {
    const r = powerReadout({ mode: "agent", awake: true, working: true });
    expect(r.tone).toBe("held");
    expect(r.title).toContain("an agent is working");
  });

  test("a Mac holds the screen and idle sleep, and says the lid still sleeps", () => {
    const r = powerReadout({ platform: "darwin", mode: "on", awake: true, working: false, locks: { sleep: null, lid: false, display: true, app: true }, inhibitMissing: false });
    expect(r.tone).toBe("held");
    expect(r.title).toContain("idle sleep");
    expect(r.title).toContain("closing the lid still sleeps");
  });

  test("what is held on Linux is logind's own idle action, named as that", () => {
    const r = powerReadout({ ...linux, mode: "on", awake: true, working: false, locks: linuxHeld, inhibitMissing: false });
    expect(r.title).toContain("logind's idle suspend");
  });

  test("a Linux lid lock that was refused is a warning, not a green button", () => {
    /* systemd-inhibit is there, and logind or polkit said no to the lid:
       closing it suspends the machine mid-run. */
    const r = powerReadout({ ...linux, mode: "on", awake: true, working: false, locks: { ...linuxHeld, lid: false }, inhibitMissing: false });
    expect(r.tone).toBe("warn");
    expect(r.title).toContain("the lid switch is not held");
    const none2 = powerReadout({ ...linux, mode: "on", awake: true, working: false, locks: { sleep: null, lid: false, display: true, app: false }, inhibitMissing: false });
    expect(none2.tone).toBe("warn");
  });
});
