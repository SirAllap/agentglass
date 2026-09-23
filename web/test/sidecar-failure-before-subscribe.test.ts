/**
 * A server that dies before the banner subscribes is still reported.
 *
 * The preload reads the shell's verdict once, as the page loads, and the push
 * after that reaches only listeners that exist. A server that exits on its
 * first line fails in the gap between the two: after the preload's read (null,
 * nothing decided yet) and before React has mounted the banner and subscribed.
 * Measured on the packaged shell with a database it could not open: the window
 * sat on "Reading the working tree…" with no banner, and the same page showed
 * the failure at once when reloaded.
 */
import { describe, expect, test } from "bun:test";

type Failure = { reason: string; what: string; fix: string };
const died: Failure = { reason: "exited", what: "The server started and stopped again (exit 1).", fix: "…" };

(globalThis as any).location ??= { hostname: "127.0.0.1", origin: "http://127.0.0.1:4000", href: "http://127.0.0.1:4000/" };
(globalThis as any).localStorage ??= { getItem: () => null, setItem: () => {}, removeItem: () => {} };
const hadWindow = "window" in globalThis;
const prevShell = (globalThis as any).window?.agentglass;
(globalThis as any).window ??= globalThis;
const shell: any = (globalThis as any).window.agentglass = {
  // Read at load, before the server had failed.
  sidecarFailure: null,
  // The failure already went out, to nobody.
  onServerFailed: () => () => {},
  // What the shell knows now.
  sidecarFailureNow: () => died,
};
const API_PATH = new URL("../src/lib/api.ts", import.meta.url).pathname;
const api = await import(`${API_PATH}?failure-before-subscribe`);
if (prevShell === undefined) delete (globalThis as any).window.agentglass;
else (globalThis as any).window.agentglass = prevShell;
if (!hadWindow) delete (globalThis as any).window;

describe("onSidecarFailure", () => {
  test("hands a new subscriber the failure it missed", async () => {
    const seen: (Failure | null)[] = [];
    const off = api.onSidecarFailure((f: Failure | null) => seen.push(f));
    await Promise.resolve();
    off();
    expect(seen).toEqual([died]);
  });

  test("and the recovery it missed, so a stale banner comes down", async () => {
    shell.sidecarFailure = died;
    shell.sidecarFailureNow = () => null;
    const seen: (Failure | null)[] = [];
    api.onSidecarFailure((f: Failure | null) => seen.push(f));
    await Promise.resolve();
    expect(seen).toEqual([null]);
  });

  test("and says nothing when nothing changed", async () => {
    shell.sidecarFailure = null;
    shell.sidecarFailureNow = () => null;
    const seen: (Failure | null)[] = [];
    api.onSidecarFailure((f: Failure | null) => seen.push(f));
    await Promise.resolve();
    expect(seen).toEqual([]);
  });
});
