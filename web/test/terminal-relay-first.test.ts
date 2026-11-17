// With the relay on, the window's main terminal still went through the old
// door: it connected before its first ticket had come back. The connect now
// waits for that answer, for a bounded time.
import { expect, test } from "bun:test";
import { RELAY_FIRST_WAIT_MS } from "../src/lib/api.ts";

const panel = await Bun.file(new URL("../src/components/TerminalPanel.tsx", import.meta.url)).text();

test("a terminal waits for its first relay ticket, and not for long", () => {
  const at = panel.indexOf("function connect(s: Sess) {");
  expect(at).toBeGreaterThan(-1);
  const body = panel.slice(at, panel.indexOf("\n}\n", at));
  expect(body).toContain("const wait = relayReady();");
  expect(body).toContain('if (!s.ws && s.status === "connecting") openSocket(s);');
  // Nothing opens a socket in `connect` itself any more: one door, after the wait.
  expect(body).not.toContain("new WebSocket(");
  expect(RELAY_FIRST_WAIT_MS).toBeLessThanOrEqual(1000);
});

const apiSource = await Bun.file(new URL("../src/lib/api.ts", import.meta.url)).text();

test("the ticket is asked for only once the server is up", () => {
  const at = apiSource.indexOf("export function relayReady(");
  expect(at).toBeGreaterThan(-1);
  const body = apiSource.slice(at, apiSource.indexOf("\n}\n", at));
  const up = body.indexOf("return whenServerUp().then(");
  expect(up).toBeGreaterThan(-1);
  // The refill is inside that wait, not before it: asked of a booting server it reads as "no relay".
  expect(body.indexOf("refillRelayTickets();")).toBeGreaterThan(up);
});

test("a terminal that came up on the old door moves to the relay, quietly and once a ticket is in hand", () => {
  const ready = panel.indexOf('if (f.t === "ready") {');
  expect(ready).toBeGreaterThan(-1);
  expect(panel.slice(ready, panel.indexOf('} else if (f.t === "tmux")', ready))).toContain("void moveToRelay(s, ws);");
  const at = panel.indexOf("async function moveToRelay(");
  expect(at).toBeGreaterThan(-1);
  const body = panel.slice(at, panel.indexOf("\n}\n", at))
    .split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
  expect(body).toContain("if (onRelay(ws.url)) return;");
  expect(body).toContain("if (!(await relayTicketSoon())) return;");
  // Still the same live socket after the wait, or nothing happens.
  expect(body).toContain('if (s.ws !== ws || s.status !== "live") return;');
  // Detached before it closes, so its onclose neither reconnects nor writes "disconnected".
  expect(body.indexOf("s.ws = null;")).toBeGreaterThan(-1);
  expect(body.indexOf("s.ws = null;")).toBeLessThan(body.indexOf("ws.close()"));
  // Keys typed in the gap are queued: the status is "connecting" before the new socket opens.
  expect(body.indexOf('s.status = "connecting";')).toBeLessThan(body.indexOf("openSocket(s);"));
});

test("the relay and the old door are told apart by their URL", async () => {
  const { onRelay } = await import("../src/lib/api.ts");
  expect(onRelay("ws://127.0.0.1:35051/pty?t=abc&root=x")).toBe(true);
  expect(onRelay("ws://127.0.0.1:4000/terminal/pty?root=x")).toBe(false);
  expect(onRelay("ws://192.168.1.20:4000/terminal/pty?root=x")).toBe(false);
});
