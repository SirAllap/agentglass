// The fleet verdict, read once per screen from the Lantern's store (see
// lib/fleetVerdict.ts for what it says). The rail's pip already subscribes to
// the same store for the life of the app, so reading it here asks for nothing.
import { useSyncExternalStore } from "react";
import { subscribeLantern, lanternRows, lanternFailed, lanternKnown } from "./lanternStore.ts";
import { fleetVerdict, type FleetVerdict } from "./fleetVerdict.ts";

export function useFleetVerdict(): FleetVerdict | null {
  const rows = useSyncExternalStore(subscribeLantern, lanternRows, lanternRows);
  const failed = useSyncExternalStore(subscribeLantern, lanternFailed, lanternFailed);
  const known = useSyncExternalStore(subscribeLantern, lanternKnown, lanternKnown);
  return fleetVerdict(rows, Date.now(), failed, known);
}
