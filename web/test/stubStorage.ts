import { globalStubs } from "./stubGlobal";

/**
 * A `localStorage` for one test file, put back when the file is done (see
 * globalStubs). The default is a do-nothing one: fifteen files left one behind,
 * and any file installing its own with `??=` kept it (see update-store). Call it
 * at file scope, once; a file that also stubs other globals uses globalStubs.
 */
const noopStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };

export function stubStorage(impl: object = noopStorage): void {
  globalStubs()("localStorage", impl);
}
