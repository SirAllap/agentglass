import { test, expect, beforeAll } from "bun:test";

// One socket, however many things ask for one.
//
// Found by measurement, not by reading: a single `notify-send` put two
// identical cards on screen. The cause is a race that only exists because
// opening is asynchronous — the capability probe is a fetch, and the module
// retunes on load while the first subscriber retunes on mount, milliseconds
// apart. Both saw `ws === null`, both passed the guard, both opened. The server
// then delivered every notification down two sockets, so every Slack message
// arrived twice and landed in the bell twice, which reads as the desktop
// sending duplicates rather than as agentglass racing itself.
//
// This file is the lock on that. It stubs the socket and the probe rather than
// reaching for a server, because what is being pinned is the guard, not the
// transport.

const cell = new Map<string, string>();
let sysNotify: typeof import("../src/lib/sysNotify.ts");
let opened: string[] = [];
let socks: FakeSocket[] = [];

class FakeSocket {
  onmessage: ((e: { data: string }) => void) | null = null;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(url: string) { opened.push(url); socks.push(this); }
  close() { this.onclose?.(); }
}

beforeAll(async () => {
  (globalThis as any).localStorage = {
    getItem: (k: string) => cell.get(k) ?? null,
    setItem: (k: string, v: string) => { cell.set(k, v); },
    removeItem: (k: string) => { cell.delete(k); },
  };
  (globalThis as any).location = { hostname: "localhost", origin: "http://localhost:4000" };
  (globalThis as any).WebSocket = FakeSocket;
  // The probe the race is run against: a promise, so both callers are inside
  // the await when the second one arrives. A resolved-instantly stub would hide
  // the very gap this test exists for.
  (globalThis as any).fetch = async () => {
    await new Promise((r) => setTimeout(r, 10));
    return { ok: true, json: async () => ({ supported: true }) };
  };
  sysNotify = await import("../src/lib/sysNotify.ts");
});

test("two things asking at once still open one socket", async () => {
  opened = []; socks = [];
  // The two callers that collide on every cold start, in the order they happen:
  // the preference being on (module load / a flip in Settings) and the first
  // component subscribing.
  sysNotify.setSysNotifyMode("full");
  const off = sysNotify.subscribeSystemNotes(() => {});

  await new Promise((r) => setTimeout(r, 60));
  expect(opened.length).toBe(1);

  off();
  sysNotify.setSysNotifyMode("off");
});

test("one desktop notification is one card and one row", async () => {
  opened = []; socks = [];
  const seen: string[] = [];
  sysNotify.setSysNotifyMode("full");
  const off = sysNotify.subscribeSystemNotes((n) => seen.push(n.summary));
  await new Promise((r) => setTimeout(r, 60));

  // The server sends the same frame down every socket it has, which is exactly
  // how one Slack message became two cards. Delivering to all of them is what
  // makes this measure the duplication rather than the last socket's behaviour.
  const before = sysNotify.notifyHistory().length;
  const frame = { data: JSON.stringify({ id: "sys-1", app: "slack", summary: "Alejandro", body: "avisa", urgency: 1, at: 1 }) };
  for (const s of socks) s.onmessage?.(frame);

  expect(seen).toEqual(["Alejandro"]);
  expect(sysNotify.notifyHistory().length).toBe(before + 1);

  off();
  sysNotify.setSysNotifyMode("off");
});
