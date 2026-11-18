// The relay starts a moment after the server (714 ms on the installed app).
// A ticket asked for inside that gap was answered "no relay", and the
// window's terminal took the in-process door for good.
import { expect, test } from "bun:test";
import { relayUp } from "../src/relay/relayHost.ts";

const host = await Bun.file(new URL("../src/relay/relayHost.ts", import.meta.url)).text();
const index = await Bun.file(new URL("../src/index.ts", import.meta.url)).text();

test("with no relay the wait ends on its own, and says so", async () => {
  const t0 = performance.now();
  expect(await relayUp(60)).toBe(false);
  expect(performance.now() - t0).toBeLessThan(1500);
});

test("the relay's own 'ready' is what ends the wait", () => {
  const line = host.split("\n").find((l) => l.includes('m.op === "ready"')) ?? "";
  expect(line).toContain("for (const w of upWaiters.splice(0)) w();");
});

test("a ticket request waits for a starting relay before it mints", () => {
  const at = index.indexOf('if (pathname === "/terminal/relay-ticket") {');
  expect(at).toBeGreaterThan(-1);
  const body = index.slice(at, index.indexOf("\n      }\n", at));
  const wait = body.indexOf("if (RELAY_ON) await relayUp();");
  expect(wait).toBeGreaterThan(-1);
  expect(body.indexOf("mintTickets(")).toBeGreaterThan(wait);
});
