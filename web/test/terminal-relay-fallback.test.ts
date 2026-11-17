// With the relay on and refusing the window, the terminal retried the same
// door for two minutes. A relay socket that never got a shell now sends the
// retries to the old door.
import { expect, test } from "bun:test";
import { RELAY_REFUSED_OFF_MS, relayReady, relayTurnedAway } from "../src/lib/api.ts";

const panel = await Bun.file(new URL("../src/components/TerminalPanel.tsx", import.meta.url)).text();

test("a relay socket that closed before its shell was ready puts the terminal on the old door", () => {
  const relay = "ws://127.0.0.1:41873/pty?t=abc&root=%2Fhome%2Fdev%2Forbit&cols=80&rows=24";
  const now = 1_000_000;
  // A live terminal that dropped is a restart; the main server's door is not the relay.
  expect(relayTurnedAway(relay, true, now)).toBe(false);
  expect(relayTurnedAway("ws://127.0.0.1:4000/terminal/pty?root=%2Fhome%2Fdev%2Forbit", false, now)).toBe(false);
  expect(relayTurnedAway(relay, false, now)).toBe(true);
  // Nothing to wait for while the relay is set aside: the connect goes straight to the old door.
  expect(relayReady(now + RELAY_REFUSED_OFF_MS - 1)).toBeNull();
  expect(RELAY_REFUSED_OFF_MS).toBeGreaterThanOrEqual(30_000);
});

test("the panel reports every close, before it retries", () => {
  const at = panel.indexOf("ws.onclose = () => {");
  expect(at).toBeGreaterThan(-1);
  const body = panel.slice(at, panel.indexOf("\n  };\n", at));
  const told = body.indexOf("relayTurnedAway(ws.url, wasLive);");
  expect(told).toBeGreaterThan(-1);
  expect(body.indexOf("maybeReconnect(s, wasLive);")).toBeGreaterThan(told);
});
