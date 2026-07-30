/**
 * The one thing the page has to hand the service worker.
 *
 * A held gate now arrives on the phone with **Allow** and **Deny** on it, and
 * answering has to happen in the worker — that is the whole point, the app is
 * closed and the screen is locked. The worker cannot read `localStorage`: it
 * has no `window`, and the credential the page keeps there is invisible to it.
 * IndexedDB is the one store both halves can reach.
 *
 * What is mirrored is deliberately the minimum: which server this device is
 * paired to, and the credential it was given. Not a second, wider credential
 * minted for the worker — the same one, at the level it was paired at, on the
 * same origin the page already keeps it on. A phone paired to answer gates can
 * answer a gate from a notification and can do nothing else, because the
 * server checks the scope on the route. Forgetting the device at the machine
 * revokes this copy in the same breath as the other one.
 *
 * It is written when push is switched on and cleared when it is switched off,
 * so a phone that is not receiving notifications is not holding a credential
 * for a worker that has nothing to do with it.
 *
 * Every operation resolves rather than rejecting. This is a side effect of a
 * toggle, and a private-mode browser that refuses IndexedDB should cost the
 * buttons on the notification, not the notification.
 */

const DB = "agentglass";
const STORE = "auth";
const KEY = "server";

export interface SwAuth {
  /** Where to send the decision. The app and the API are the same origin on a
   *  phone (the server serves the bundle), but not when a dev build talks to a
   *  server elsewhere — so it is recorded rather than assumed. */
  origin: string;
  /** Empty on a box with no token configured, which is the normal local case. */
  token: string;
}

function open(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => {
        // Guarded: two tabs can race the upgrade, and the second one throwing
        // here would reject the open for a store that already exists.
        try { req.result.createObjectStore(STORE); } catch { /* already there */ }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null); // private mode, or a browser with it switched off
    }
  });
}

function put(value: SwAuth | null): Promise<boolean> {
  return open().then((db) => {
    if (!db) return false;
    return new Promise<boolean>((resolve) => {
      try {
        const store = db.transaction(STORE, "readwrite").objectStore(STORE);
        const req = value ? store.put(value, KEY) : store.delete(KEY);
        req.onsuccess = () => resolve(true);
        req.onerror = () => resolve(false);
      } catch {
        resolve(false);
      }
    });
  });
}

/** Tell the worker where this device is paired, and with what. */
export const rememberForWorker = (auth: SwAuth): Promise<boolean> => put(auth);

/** Take it back. Called when push is switched off, and on nothing else — a
 *  worker with no subscription has nothing to answer. */
export const forgetForWorker = (): Promise<boolean> => put(null);

/** Read it back. Only the tests and the settings pane need this; the worker
 *  has its own copy of the read, because it cannot import from here. */
export function readForWorker(): Promise<SwAuth | null> {
  return open().then((db) => {
    if (!db) return null;
    return new Promise<SwAuth | null>((resolve) => {
      try {
        const req = db.transaction(STORE, "readonly").objectStore(STORE).get(KEY);
        req.onsuccess = () => resolve((req.result as SwAuth) ?? null);
        req.onerror = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
  });
}
