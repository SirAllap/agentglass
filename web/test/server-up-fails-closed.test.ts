/*
 * The window's first requests wait for the shell to say a server of ours is up,
 * and a timeout alone is not that.
 *
 * The gate used to release after six seconds whatever had happened. With the
 * app's own server hung and something else holding the port, that sent every
 * boot request, with the token, to a server nobody had proved. The shell always
 * reaches a verdict (its own start poll gives up at twelve seconds and reports
 * a failure, after taking the token back), so the gate waits for it.
 */
import { afterAll, expect, test } from "bun:test";

type Hear = ((f: unknown) => void) | null;
let hear: Hear = null;
let up = false;
const w = globalThis as unknown as { window?: unknown };
const hadWindow = "window" in w;
const before = w.window;
w.window = {
  location: { href: "http://127.0.0.1:4000/" },
  agentglass: {
    apiOrigin: "http://127.0.0.1:4000",
    apiToken: "orbit-token",
    sidecarFailure: null,
    sidecarUp: () => up,
    onServerFailed: (fn: (f: unknown) => void) => { hear = fn; return () => { hear = null; }; },
  },
};
// A module instance of its own: SHELL is read once, when api.ts is evaluated.
const fresh = "../src/lib/api.ts?server-up-fails-closed";
const api = (await import(fresh)) as typeof import("../src/lib/api.ts");
if (hadWindow) w.window = before; else delete w.window;

afterAll(() => { hear = null; });

test("a hung server does not release the window's requests on the timeout", async () => {
  let released = false;
  void api.whenServerUp().then(() => { released = true; });
  await Bun.sleep(6600);
  expect(released).toBe(false);
  // The shell's verdict is what lets them go.
  hear?.(null);
  await Bun.sleep(10);
  expect(released).toBe(true);
}, 10_000);
