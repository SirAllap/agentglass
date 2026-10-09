import { afterAll } from "bun:test";

/**
 * A `localStorage` for one test file, put back when the file is done.
 *
 * `bun test` runs every file in one process, so a stub a file leaves behind is
 * the next file's starting point: fifteen files left a do-nothing one, and any
 * file installing its own with `??=` kept it (see update-store). Installed when
 * called, not in a `beforeAll`, because some files import modules that read it
 * while the file itself is still loading.
 */
const noopStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };

export function stubStorage(impl: object = noopStorage): void {
  const g = globalThis as Record<string, unknown>;
  const had = "localStorage" in g;
  const before = g.localStorage;
  g.localStorage = impl;
  afterAll(() => {
    if (had) g.localStorage = before;
    else delete g.localStorage;
  });
}
