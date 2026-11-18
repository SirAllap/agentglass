import { useSyncExternalStore } from "react";

// The "Prefix key" row and the "Custom prefix key" row are two TmuxRow
// instances. They share this one flag, so picking Custom… unlocks the other.
let on = false;
const subs = new Set<() => void>();

export function setCustomPrefix(v: boolean): void {
  if (on === v) return;
  on = v;
  subs.forEach((f) => f());
}
export function getCustomPrefix(): boolean { return on; }
const subscribe = (f: () => void) => { subs.add(f); return () => { subs.delete(f); }; };
export function useCustomPrefix(): [boolean, (v: boolean) => void] {
  return [useSyncExternalStore(subscribe, getCustomPrefix, getCustomPrefix), setCustomPrefix];
}
