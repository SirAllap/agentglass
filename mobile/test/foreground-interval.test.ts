import { expect, test } from "bun:test";
import { foregroundInterval, type AppLike } from "../src/lib/foreground-interval.ts";

const fakeApp = (state: string) => {
  let cb: ((s: string) => void) | null = null;
  const app: AppLike = {
    currentState: state,
    addEventListener: (_t, f) => { cb = f; return { remove: () => { cb = null; } }; },
  };
  return { app, set: (s: string) => { app.currentState = s; cb?.(s); }, listening: () => cb !== null };
};

test("the timer stops in the background, restarts in the foreground and is removed on cleanup", async () => {
  const f = fakeApp("active");
  let n = 0;
  const stop = foregroundInterval(f.app, () => { n++; }, 10);
  await Bun.sleep(35);
  expect(n).toBeGreaterThan(1);
  f.set("background");
  const frozen = n;
  await Bun.sleep(35);
  expect(n).toBe(frozen);
  f.set("active");
  await Bun.sleep(35);
  expect(n).toBeGreaterThan(frozen);
  stop();
  const end = n;
  await Bun.sleep(35);
  expect(n).toBe(end);
  expect(f.listening()).toBe(false);
});

test("it does not arm when the app starts in the background", async () => {
  const f = fakeApp("background");
  let n = 0;
  const stop = foregroundInterval(f.app, () => { n++; }, 10);
  await Bun.sleep(35);
  expect(n).toBe(0);
  stop();
});

test("coming back to the foreground runs it at once", () => {
  const f = fakeApp("background");
  let n = 0;
  const stop = foregroundInterval(f.app, () => { n++; }, 60_000);
  f.set("active");
  expect(n).toBe(1);
  f.set("active");
  expect(n).toBe(1);
  stop();
});
