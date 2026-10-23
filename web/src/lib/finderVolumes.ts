// What a DEVICES row in the finder's sidebar does, decided from the volume and
// nothing else (the screen only draws it). Strata's rules, window.rs
// device_row_actions / volume_release_action: an encrypted volume gets a lock
// button, a removable one an eject button, a fixed one that is mounted an
// unmount button drawn with the same eject icon.
import { useCallback, useEffect, useState } from "react";
import type { RemoteStep, Volume } from "../../../shared/types.ts";
import { api } from "./api.ts";

export type VolumeClick = "open" | "mount" | "unlock";
/** Clicking the row: a locked volume asks for its passphrase, a mounted one opens, anything else mounts and then opens. */
export const clickOf = (v: Volume): VolumeClick => (v.locked ? "unlock" : v.mounted ? "open" : "mount");

export interface LockButton { act: "unlock" | "lock"; icon: "lock" | "lock-open"; label: "Unlock" | "Lock" }
/** The closed padlock offers to open, the open one offers to close, as in Strata. */
export const lockButton = (v: Volume): LockButton | null =>
  !v.encrypted ? null : v.locked ? { act: "unlock", icon: "lock", label: "Unlock" } : { act: "lock", icon: "lock-open", label: "Lock" };

export interface ReleaseButton { act: "eject" | "unmount"; icon: "eject"; label: "Eject" | "Unmount" }
export const releaseButton = (v: Volume): ReleaseButton | null =>
  v.remote === "smb" ? null : v.release === "eject" ? { act: "eject", icon: "eject", label: "Eject" } : v.release === "unmount" && v.mounted ? { act: "unmount", icon: "eject", label: "Unmount" } : null;

/** The title of the dialog a failed action raises, Strata's wording. */
export const FAILED: Record<"mount" | "unmount" | "eject" | "unlock" | "lock", string> = {
  mount: "Unable to mount volume", unmount: "Unable to unmount device", eject: "Unable to eject device", unlock: "Unable to unlock volume", lock: "Unable to lock device",
};

/** What the passphrase prompt says after a refusal (Strata authentication_retry_message). */
export const WRONG_PASSPHRASE = "Those credentials weren’t accepted. Check passphrase and try again.";

/** Strata draws an SMB mount as a network place and everything else as a drive. */
export const deviceIcon = (v: Volume): "network" | "hard-drive" => (v.remote === "smb" ? "network" : "hard-drive");
/** An SMB mount is left from its context menu, not from a button (window.rs append_smb_mount). */
export const disconnectItem = (v: Volume): { act: "unmount"; label: "Disconnect" } | null => (v.remote === "smb" ? { act: "unmount", label: "Disconnect" } : null);
export const failedTitle = (act: keyof typeof FAILED, v: Volume): string => (v.remote && act === "unmount" ? "Unable to disconnect" : FAILED[act]);

export type StepDialog =
  | { kind: "form"; title: string; fields: ("User" | "Domain" | "Password")[] }
  | { kind: "ask"; title: string; message: string; choices: string[] }
  | { kind: "error"; title: string; message: string };
/** What a connection step puts on screen; `done` puts nothing. */
export function stepDialog(s: RemoteStep): StepDialog | null {
  if (s.state === "password") return { kind: "form", title: "Authentication required", fields: s.fields };
  if (s.state === "question") return { kind: "ask", title: "Verify the server", message: s.message, choices: s.choices };
  if (s.state === "error") return { kind: "error", title: "Unable to open location", message: s.error };
  return null;
}

// One socket frame tells every finder the list moved; each re-reads it.
const listeners = new Set<() => void>();
export function volumesChanged(): void { for (const fn of listeners) { try { fn(); } catch { /* one bad listener must not stop the rest */ } } }

/** The volumes udisks reports, re-read when the server says the list moved and never on a clock. An empty list is "no devices", an error is also an empty list: the heading is not drawn for either. */
export function useVolumes(on = true): { volumes: Volume[]; reload: () => void } {
  const [volumes, setVolumes] = useState<Volume[]>([]);
  const reload = useCallback(() => { void api.volumes().then((r) => setVolumes(r.ok ? r.devices : [])).catch(() => { /* keep what is shown: a failed read is not "everything was unplugged" */ }); }, []);
  useEffect(() => {
    if (!on) return;
    reload();
    listeners.add(reload);
    return () => { listeners.delete(reload); };
  }, [on, reload]);
  return { volumes, reload };
}
