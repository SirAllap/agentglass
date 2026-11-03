/*
 * The server's "polaris" frame reaches the windows that show Polaris: a burst of events is
 * told once, a window that closed is not told, and useLive hands the frame to this module.
 */
import { describe, expect, test } from "bun:test";
import { POLARIS_QUIET_MS, onPolarisChanged, publishPolarisChanged } from "../src/lib/polarisLive.ts";

const live = await Bun.file(new URL("../src/lib/useLive.ts", import.meta.url)).text();
const hooks = await Bun.file(new URL("../src/components/polaris/usePolaris.ts", import.meta.url)).text();
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("the polaris frame", () => {
  test("five events in a burst tell a subscriber once, and a closed window hears nothing", async () => {
    let heard = 0, closed = 0;
    const off = onPolarisChanged(() => { heard++; });
    const gone = onPolarisChanged(() => { closed++; });
    gone();
    for (let i = 0; i < 5; i++) publishPolarisChanged();
    await wait(POLARIS_QUIET_MS + 150);
    expect([heard, closed]).toEqual([1, 0]);
    publishPolarisChanged();
    await wait(POLARIS_QUIET_MS + 150);
    expect(heard).toBe(2);
    off();
  });
  test("useLive publishes it, and both hooks re-read on it instead of on a timer", () => {
    expect(live).toMatch(/frame\.type === "polaris"\) \{ publishPolarisChanged\(\)/);
    expect(hooks.match(/onPolarisChanged\(/g)).toHaveLength(2);
    expect(hooks).not.toMatch(/setInterval|setTimeout/);
  });
});
