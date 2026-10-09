/*
 * The gate every always-on poll goes through, run rather than read.
 *
 * A desktop window is never `document.hidden`, so a plain interval asks for as
 * long as the window exists. `pollWhileLooking` is silent unless the window is
 * visible AND focused, asks at once when it comes back, and lets go of every
 * listener when stopped. The globals are stubbed and restored: `bun test` runs
 * every file in one process.
 */
import { beforeAll, expect, test } from "bun:test";
import { globalStubs } from "./stubGlobal";
import { pollWhileLooking } from "../src/lib/usePoll.ts";
const stubGlobal = globalStubs();

let focused = false;
let hidden = false;
type Listeners = Map<string, Set<() => void>>;
const winL: Listeners = new Map();
const docL: Listeners = new Map();
const add = (m: Listeners) => (t: string, f: () => void) => { (m.get(t) ?? m.set(t, new Set()).get(t)!).add(f); };
const del = (m: Listeners) => (t: string, f: () => void) => { m.get(t)?.delete(f); };
const fire = (m: Listeners, t: string) => { for (const f of [...(m.get(t) ?? [])]) f(); };

beforeAll(() => {
  stubGlobal("window", { addEventListener: add(winL), removeEventListener: del(winL) });
  stubGlobal("document", {
    get hidden() { return hidden; }, hasFocus: () => focused,
    addEventListener: add(docL), removeEventListener: del(docL),
  });
});

test("pollWhileLooking is silent unfocused, asks at once on focus, and lets go", async () => {
  let n = 0;
  focused = false;
  const stop = pollWhileLooking(() => { n++; }, 20);
  await Bun.sleep(100);
  expect(n, "an unfocused window asks nothing").toBe(0);
  focused = true;
  fire(winL, "focus");
  expect(n, "coming back asks at once").toBe(1);
  await Bun.sleep(70);
  expect(n, "and then on the interval").toBeGreaterThanOrEqual(3);
  hidden = true;
  const at = n;
  await Bun.sleep(70);
  expect(n, "a hidden document asks nothing").toBe(at);
  hidden = false;
  stop();
  const stopped = n;
  await Bun.sleep(70);
  fire(winL, "focus");
  expect(n, "stopped is stopped").toBe(stopped);
  expect(winL.get("focus")?.size ?? 0).toBe(0);
  expect(docL.get("visibilitychange")?.size ?? 0).toBe(0);
});
