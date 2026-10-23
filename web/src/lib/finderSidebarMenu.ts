// What a right-click (or the Menu key) on a sidebar row offers, as Strata's window.rs builds it:
//   Home, the XDG folders, a pinned folder   Unpin, Customize…, Properties
//   Trash, Network                           Unpin (Properties and Empty Trash need Strata's own
//                                            location properties and a trash probe, which are not here)
//   Recent                                   nothing: Strata gives that row no menu
//   a pinned remote                          Unpin
//   a device                                 Unlock or Lock, Eject or Unmount, Mount, Properties
//   a shared folder mounted (smb)            Properties, Disconnect
// Format… and Set label… are udisks jobs the server has no route for.
import type { Volume } from "../../../shared/types.ts";
import { lockButton, releaseButton } from "./finderVolumes.ts";

export type SideTarget =
  | { kind: "place"; id: string; path?: string }
  | { kind: "pin"; uri: string; path?: string }
  | { kind: "device"; volume: Volume };

export type SideAct = "unpin" | "customize" | "properties" | "mount" | "unmount" | "eject" | "unlock" | "lock";
export interface SideItem { act: SideAct; label: string; icon: string; danger?: boolean }

const UNPIN: SideItem = { act: "unpin", label: "Unpin", icon: "pin" };
const CUSTOMIZE: SideItem = { act: "customize", label: "Customize…", icon: "palette" };
const PROPS: SideItem = { act: "properties", label: "Properties", icon: "info" };

export function sideMenu(t: SideTarget): SideItem[] {
  if (t.kind === "place") {
    if (t.id === "recent") return [];
    if (t.id === "trash" || t.id === "network" || !t.path) return [UNPIN];
    return [UNPIN, CUSTOMIZE, PROPS];
  }
  if (t.kind === "pin") return t.path ? [UNPIN, CUSTOMIZE, PROPS] : [UNPIN];
  const v = t.volume;
  if (v.remote === "smb") return [...(v.mountPoint ? [PROPS] : []), { act: "unmount", label: "Disconnect", icon: "unplug", danger: true }];
  const lock = lockButton(v), release = releaseButton(v);
  return [
    ...(lock ? [{ act: lock.act, label: lock.label, icon: lock.icon } as SideItem] : []),
    ...(release ? [{ act: release.act, label: release.label, icon: release.icon } as SideItem] : []),
    ...(!v.mounted && !v.locked ? [{ act: "mount", label: "Mount", icon: "hard-drive" } as SideItem] : []),
    ...(v.mountPoint ? [PROPS] : []),
  ];
}

/** The place ids the person hid with Unpin; a hidden one is back when its switch in Settings is turned on. */
export const visiblePlaces = <T extends { id: string }>(places: readonly T[], hidden: readonly string[]): T[] => places.filter((p) => !hidden.includes(p.id));
export const withHidden = (hidden: readonly string[], id: string, off: boolean): string[] => off ? (hidden.includes(id) ? [...hidden] : [...hidden, id]) : hidden.filter((h) => h !== id);
