import { afterAll } from "bun:test";

// Preload (bunfig.toml). `bun test` runs every web test file in one process, so a
// global one file keeps is the next file's starting point and the suite passes
// or fails by file order: `bun test --seed N` failed 8 to 29 tests, and CI's own
// order went red on three. A preload's hooks run once around the whole run, so
// this checks the end state of a fixed list of globals against the start.
//
// Its ceiling: it names the globals, not the file (run the files one at a time,
// the leaker is the one that fails), sees only the end state, and only watches
// this list. The fix for a leak is globalStubs() in stubGlobal.ts.
const WATCHED = [
  "localStorage", "sessionStorage", "location", "document", "window", "navigator",
  "fetch", "WebSocket", "EventSource", "Notification", "matchMedia", "getComputedStyle",
  "setTimeout", "clearTimeout", "setInterval", "clearInterval",
  "requestAnimationFrame", "cancelAnimationFrame", "ResizeObserver", "HTMLElement", "Element",
];
const g = globalThis as Record<string, unknown>;
const before = new Map(WATCHED.map((k) => [k, g[k]]));

afterAll(() => {
  const left = WATCHED.filter((k) => g[k] !== before.get(k));
  if (left.length) {
    throw new Error(`a test file left ${left.join(", ")} changed on the global object; install stubs with globalStubs() from test/stubGlobal.ts so they are given back`);
  }
});
