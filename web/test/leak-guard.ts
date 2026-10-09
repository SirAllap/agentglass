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

// The other thing one file can leave for the next: api.ts itself. `mock.module`
// is process-wide and has no undo, and patching `api.clickupViews` without giving
// it back is the same loss; either makes every suite loaded afterwards read a
// stub that never makes the request (clickup-prefs-gate.test.ts saw "no ClickUp
// here" and asked nothing, in the seeded orders that ran merge-dialog.test.ts
// first). A stub is recognisable by what the real function is made of.
//
// Its ceiling: the end state only, a short list, and the file that did it is
// found by running the files one at a time.
afterAll(async () => {
  let m: Record<string, any>;
  try { m = await import("../src/lib/api.ts"); } catch { return; }
  const wrong: string[] = [];
  const must = (name: string, fn: unknown, text: string, ...or: string[]) => { if (![text, ...or].some((t) => String(fn).includes(t))) wrong.push(name); };
  // server-banner-desktop.test.ts leaves a wrapper that is off after its file
  // and calls the real function: it names `realApiModule`, and that is allowed.
  must("probeServer", m.probeServer, "timeoutMs", "realApiModule.probeServer");
  must("sidecarFailure", m.sidecarFailure, "SHELL", "realApiModule.sidecarFailure");
  for (const k of ["clickupViews", "clickupPrefs", "clickupSetWrites"]) must(`api.${k}`, m.api?.[k], "/clickup/");
  if (m.IS_DEMO) return;
  if (wrong.length) {
    throw new Error(`a test file left api.ts replaced: ${wrong.join(", ")}; a mock.module on it cannot be undone (answer through a flag that is off after afterAll), and a patched api.* must be given back in afterAll`);
  }
});
