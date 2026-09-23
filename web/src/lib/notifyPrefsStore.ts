// The notification diet, kept as one module-level store rather than a hook
// fetching on every mount. Every emitter that checks `notifies()` needs the
// same answer at the same moment — a chip that read a stale "off" a render
// behind the desktop popup would disagree with itself about whether an alert
// fired at all — and it is small enough (one JSON object) that "read once on
// boot, update on the server's own broadcast" costs nothing gateStore.ts's
// poll does not already justify for something that changes constantly.
import { api } from "./api.ts";
import { DEFAULT_NOTIFY_PREFS, type NotifyPrefs } from "../../../shared/notifyPrefs.ts";

const subs = new Set<() => void>();
let snapshot: NotifyPrefs = DEFAULT_NOTIFY_PREFS;
let loaded = false;

export const getNotifyPrefs = (): NotifyPrefs => snapshot;

export function subscribeNotifyPrefs(fn: () => void): () => void {
  if (!loaded) {
    loaded = true;
    void api.notifyPrefs().then((r) => { if (r.ok) setSnapshot(r.prefs); }).catch(() => {});
  }
  subs.add(fn);
  return () => subs.delete(fn);
}

function setSnapshot(p: NotifyPrefs) {
  snapshot = p;
  for (const fn of subs) fn();
}

/** Called from useLive.ts when a `{type:"notify-prefs"}` frame arrives — from
 *  this device's own save round-tripping, or from another tab/device open on
 *  the same server. */
export function receiveNotifyPrefs(p: NotifyPrefs): void {
  setSnapshot(p);
}

/** The Settings modal's own save path: write through the server, then adopt
 *  the coerced result immediately rather than waiting for the frame — the tab
 *  that saved should not flicker back to the old value for one round trip. */
export async function saveNotifyPrefs(p: NotifyPrefs): Promise<NotifyPrefs> {
  const r = await api.setNotifyPrefs(p);
  if (r.ok) setSnapshot(r.prefs);
  return r.ok ? r.prefs : snapshot;
}
