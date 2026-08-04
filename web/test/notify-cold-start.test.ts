import { test, expect, beforeAll, afterEach } from "bun:test";

// The desktop app starts its server a beat after its window.
//
// Measured on the real thing: the window came up at 15:50:17 and the sidecar
// was listening at 15:51:21. The renderer's first capability probe lands in
// that gap and fails — and the answer was cached for the life of the page. So
// the switch read ON, Settings read "Unavailable — server unreachable" over a
// server that had been up for a minute, and nothing was watching the bus. The
// same shape as the bug this whole feature came out of: something says it is on
// and nothing is listening.
//
// The rule these pin: "this machine has no notification bus" is a VERDICT and
// is kept; "I could not reach the server to ask" is not an answer at all, and
// must be asked again.

const cell = new Map<string, string>();
let sysNotify: typeof import("../src/lib/sysNotify.ts");
let sockets = 0;
let asks = 0;
/** What the next probe does. Set per test. */
let answer: () => Promise<any> = async () => ({ ok: true, json: async () => ({ supported: true }) });

class FakeSocket {
  onmessage: ((e: { data: string }) => void) | null = null;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor() { sockets++; }
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
  (globalThis as any).fetch = async () => { asks++; return answer(); };
  sysNotify = await import("../src/lib/sysNotify.ts");
});

afterEach(() => {
  sysNotify.setSysNotifyMode("off");
  sysNotify.__resetNotifyCapability();
  sockets = 0;
  asks = 0;
});

test("a probe that could not reach the server is not remembered as an answer", async () => {
  answer = async () => { throw new Error("connection refused"); };
  const first = await sysNotify.notifyCapability();
  expect(first.supported).toBe(false);
  expect(first.transient).toBe(true);

  // The server finished starting. Asking again must actually ask.
  answer = async () => ({ ok: true, json: async () => ({ supported: true }) });
  const second = await sysNotify.notifyCapability();
  expect(second.supported).toBe(true);
  expect(asks).toBe(2);
});

test("a verdict is remembered — a machine with no bus is not asked twice", async () => {
  answer = async () => ({ ok: true, json: async () => ({ supported: false, reason: "no D-Bus session bus" }) });
  const first = await sysNotify.notifyCapability();
  expect(first.supported).toBe(false);
  expect(first.transient).toBeUndefined();

  await sysNotify.notifyCapability();
  expect(asks).toBe(1);
});

/*
 * The one that was actually on screen.
 *
 * Switched on, cold start, server not up yet: the socket must come back on its
 * own. Before this, `open()` gave up on the failed probe and nothing ever
 * retried, so the feature stayed dead until the app was restarted — while
 * Settings showed it as on.
 */
test("switched on before the server is up, it opens the socket when the server arrives", async () => {
  answer = async () => { throw new Error("connection refused"); };
  sysNotify.setSysNotifyMode("full");          // retunes → probes → fails
  const off = sysNotify.subscribeSystemNotes(() => {});
  await new Promise((r) => setTimeout(r, 50));
  expect(sockets).toBe(0);                     // nothing to connect to yet

  // The sidecar comes up. The retry is on a backoff, so this waits past the
  // first delay rather than assuming an instant reconnect.
  answer = async () => ({ ok: true, json: async () => ({ supported: true }) });
  await new Promise((r) => setTimeout(r, 1400));
  expect(sockets).toBe(1);

  off();
});
