import { test, expect, beforeAll } from "bun:test";

// The notification pane has two switches because it has two sources: the
// machine's own notifications, mirrored in, and agentglass's own events. They
// share one bell, so they have to be silenceable apart — otherwise "stop
// telling me about Slack" and "stop telling me a branch fell behind" are the
// same decision, which is how a cockpit ends up muted entirely.
//
// These pin the three rules that make the switches safe to use:
//
//   - off means "do not interrupt", never "stop keeping track": the bell's
//     list is written on a path neither switch is on;
//   - turning the mirror off and on again does not silently downgrade how much
//     of a message you had asked to see;
//   - both default the way the feature was designed to: mirroring off (it
//     reads every notification you receive), our own alerts on.

const cell = new Map<string, string>();
let sysNotify: typeof import("../src/lib/sysNotify.ts");

beforeAll(async () => {
  (globalThis as any).localStorage = {
    getItem: (k: string) => cell.get(k) ?? null,
    setItem: (k: string, v: string) => { cell.set(k, v); },
    removeItem: (k: string) => { cell.delete(k); },
  };
  (globalThis as any).location = { hostname: "localhost", origin: "http://localhost:4000" };
  sysNotify = await import("../src/lib/sysNotify.ts");
});

test("the defaults are the designed ones: nothing mirrored, our own alerts on", () => {
  expect(sysNotify.sysNotifyOn()).toBe(false);
  expect(sysNotify.sysNotifyMode()).toBe("off");
  expect(sysNotify.appNotify()).toBe(true);
});

test("the mirror switch is the tri-state, said as on and off", () => {
  sysNotify.setSysNotifyOn(true);
  expect(sysNotify.sysNotifyOn()).toBe(true);
  // Full rather than titles: someone switching it on wants to know what the
  // message said, and the narrower answer is a deliberate second choice.
  expect(sysNotify.sysNotifyMode()).toBe("full");

  sysNotify.setSysNotifyOn(false);
  expect(sysNotify.sysNotifyOn()).toBe(false);
  expect(sysNotify.sysNotifyMode()).toBe("off");
});

/*
 * The one that would go unnoticed.
 *
 * Someone on a shared screen picks "Who" so other people's messages are not
 * readable over their shoulder, then flips the feature off for a call. If on
 * comes back as "Full", a privacy choice has been quietly undone by a switch
 * that said nothing about it.
 */
test("turning the mirror off and on again keeps the detail you chose", () => {
  sysNotify.setSysNotifyMode("titles");
  sysNotify.setSysNotifyOn(false);
  sysNotify.setSysNotifyOn(true);
  expect(sysNotify.sysNotifyMode()).toBe("titles");
});

test("agentglass's own switch round-trips, persists and tells its listeners", () => {
  const seen: boolean[] = [];
  const off = sysNotify.subscribeAppNotify((v) => seen.push(v));

  sysNotify.setAppNotify(false);
  expect(sysNotify.appNotify()).toBe(false);
  // A preference, not a session mood: it is read from storage on every call, so
  // this is what a fresh page would see.
  expect(cell.get("agentglass.appNotify")).toBe("0");

  sysNotify.setAppNotify(true);
  expect(sysNotify.appNotify()).toBe(true);

  expect(seen).toEqual([false, true]);
  off();
});

/*
 * The exception, pinned.
 *
 * "agentglass's own notifications: off" is a fair thing to ask for and must not
 * become "an agent was held until it timed out and nothing said so". A held tool
 * call is the one event here that cannot be caught up on later — the hold
 * expires on its own — so it still speaks with the switch off, and the Settings
 * hint says as much. If someone ever simplifies this condition down to a plain
 * `appNotify()`, this fails.
 */
test("with our own alerts off, only what is held waiting still interrupts", () => {
  sysNotify.setAppNotify(false);
  expect(sysNotify.shouldInterrupt(false)).toBe(false); // a turn finished — it can wait
  expect(sysNotify.shouldInterrupt(true)).toBe(true);   // something is stopped until you answer

  sysNotify.setAppNotify(true);
  expect(sysNotify.shouldInterrupt(false)).toBe(true);
});

test("neither switch can stop the bell collecting", () => {
  sysNotify.setAppNotify(false);
  sysNotify.setSysNotifyOn(false);
  const before = sysNotify.notifyHistory().length;

  // The history path, shared by everything the bell lists. Deliberately outside
  // both gates: silence is about interruption, and a list you muted should
  // still be complete when you choose to look at it.
  sysNotify.recordNote({ app: "git", summary: "agentglass", body: "3 commits to pull on main" });

  expect(sysNotify.notifyHistory().length).toBe(before + 1);
  expect(sysNotify.notifyHistory()[0]!.summary).toBe("agentglass");
});
