import { afterAll } from "bun:test";

/**
 * Globals for one test file, put back when the file is done:
 *
 *   const stubGlobal = globalStubs();            // once, at the top of the file
 *   stubGlobal("location", { hostname: "localhost" });
 *
 * `bun test` runs every file in one process, so a global a file sets and keeps
 * is the next file's starting point (see leak-guard.ts). The restore is an
 * `afterAll` registered by `globalStubs()`, so call that at file scope: from a
 * `beforeAll` it ran before the first test, from a preload it runs once, after
 * the last file. `stubGlobal` itself can then be called anywhere. A second call
 * for the same name keeps the first original.
 *
 * Hooks run in the order they were registered: a file whose own `afterAll` still
 * needs the stubs declares `globalStubs()` after it (see notification-noise).
 */
export function globalStubs(): (name: string, value: unknown) => void {
  const originals = new Map<string, { had: boolean; before: unknown }>();
  const g = globalThis as Record<string, unknown>;
  const put = (name: string, value: unknown) =>
    Object.defineProperty(g, name, { value, writable: true, configurable: true, enumerable: true });
  afterAll(() => {
    for (const [name, { had, before }] of [...originals].reverse()) {
      if (had) put(name, before);
      else delete g[name];
    }
    originals.clear();
  });
  return (name, value) => {
    if (!originals.has(name)) originals.set(name, { had: name in g, before: g[name] });
    put(name, value);
  };
}
