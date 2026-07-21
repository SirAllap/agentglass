import { test, expect, beforeAll } from "bun:test";
import type { PendingGate } from "../../shared/types.ts";

// agentglass reads notifications off the D-Bus session bus instead of being the
// daemon, so the desktop's own Do Not Disturb cannot reach what lands on the
// notch. Verified live: with DND on, WhatsApp messages the desktop silently
// queued were still shown, body and all. Quiet is agentglass's own answer to
// that, since the OS state is not portably readable.
//
// The line these defend is the one that makes quiet safe to use: it silences
// other people's messages, and it must never be able to silence a gate hold,
// because that would turn "do not interrupt me" into "an agent blocked and
// nobody said". That separation is structural (a hold does not travel the
// mirrored-notes path at all) and these pin it so a refactor cannot merge the
// two lanes by accident.

const cell = new Map<string, string>();

let sysNotify: typeof import("../src/lib/sysNotify.ts");
let gateStore: typeof import("../src/lib/gateStore.ts");

beforeAll(async () => {
  (globalThis as any).localStorage = {
    getItem: (k: string) => cell.get(k) ?? null,
    setItem: (k: string, v: string) => { cell.set(k, v); },
    removeItem: (k: string) => { cell.delete(k); },
  };
  (globalThis as any).location = { hostname: "localhost", origin: "http://localhost:4000" };
  sysNotify = await import("../src/lib/sysNotify.ts");
  gateStore = await import("../src/lib/gateStore.ts");
  // Leave the singleton as this file found it, so running before or after
  // gate-store.test.ts cannot change either file's result.
  gateStore.__resetGateStore();
});

const gate = (id: string): PendingGate => ({
  id,
  source_app: "claude",
  session_id: "abcdef0123456789",
  tool_name: "Bash",
  summary: "rm -rf build",
  created: 1_700_000_000_000,
});

test("quiet is off unless asked for", () => {
  expect(sysNotify.notifyQuiet()).toBe(false);
});

test("quiet round-trips and notifies its listeners", () => {
  const seen: boolean[] = [];
  const off = sysNotify.subscribeNotifyQuiet((q) => seen.push(q));

  sysNotify.setNotifyQuiet(true);
  expect(sysNotify.notifyQuiet()).toBe(true);

  sysNotify.setNotifyQuiet(false);
  expect(sysNotify.notifyQuiet()).toBe(false);

  expect(seen).toEqual([true, false]);
  off();
});

test("quiet survives a reload, because it is a preference and not a session mood", () => {
  sysNotify.setNotifyQuiet(true);
  // The store reads localStorage on every call rather than caching, so this is
  // what a fresh page would see.
  expect(cell.get("agentglass.sysNotify.quiet")).toBe("1");
  expect(sysNotify.notifyQuiet()).toBe(true);
});

/*
 * The one that matters.
 *
 * Quiet gates `subscribeSystemNotes`, which carries mirrored third-party
 * notifications and nothing else. A gate hold reaches the notch through
 * `subscribeNewGates`, a different path entirely, so silencing Slack cannot
 * silence a blocked agent. If someone ever routes holds through the mirrored
 * lane to "simplify", this fails.
 */
test("a gate hold still announces itself while quiet is on", () => {
  sysNotify.setNotifyQuiet(true);

  const arrivals: string[] = [];
  const off = gateStore.subscribeNewGates((g) => arrivals.push(g.id));

  gateStore.ingestGates([]);              // seed the baseline
  gateStore.ingestGates([gate("held")]);  // and now something blocks

  expect(arrivals).toEqual(["held"]);
  off();
});

test("quiet does not stop mirrored notes being collected, only interrupting", () => {
  sysNotify.setNotifyQuiet(true);
  const before = sysNotify.notifyHistory().length;

  // recordNote is the history path, shared by everything the notch lists. It is
  // deliberately not gated: quiet means "do not interrupt me", not "stop
  // keeping track", so the list is still complete when you choose to look.
  sysNotify.recordNote({ app: "slack", summary: "Armichee", body: "sticker" });

  expect(sysNotify.notifyHistory().length).toBe(before + 1);
  expect(sysNotify.notifyHistory()[0]!.summary).toBe("Armichee");
});
