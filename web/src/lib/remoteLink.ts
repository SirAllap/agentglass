// Which of this machine's addresses the Remote pane should offer, remembered.
//
// A box with Tailscale on it has at least two routes to itself, and the pane
// listed them with the plain LAN one first because that is the one that needs
// no software on the phone. Sensible as a default, wrong as a permanent
// answer: someone who picked the tailnet address picked it for a reason, and
// the pane forgot on every open, so the QR quietly went back to a URL that
// only works from the sofa.
//
// The saved thing is the address itself, never the index into the list. The
// list is rebuilt from the live interfaces every three seconds, and it changes
// shape for ordinary reasons — joining a different wifi, DHCP handing out a new
// lease, Tailscale coming up late. An index survives none of that and would
// silently point at a different network than the one that was chosen.
export interface PickedAddress {
  address: string;
  iface: string;
  tailnet: boolean;
}

const KEY = "agentglass.remote.address";

export function readPick(store: Pick<Storage, "getItem"> | null = safeStorage()): PickedAddress | null {
  try {
    const raw = store?.getItem(KEY);
    if (!raw) return null;
    const v = JSON.parse(raw);
    if (!v || typeof v.address !== "string" || typeof v.iface !== "string") return null;
    return { address: v.address, iface: v.iface, tailnet: !!v.tailnet };
  } catch {
    return null; // private mode, or someone hand-edited it into nonsense
  }
}

export function writePick(a: PickedAddress, store: Pick<Storage, "setItem"> | null = safeStorage()): void {
  try {
    store?.setItem(KEY, JSON.stringify({ address: a.address, iface: a.iface, tailnet: a.tailnet }));
  } catch {
    /* private mode — the choice just lasts as long as the pane is open */
  }
}

function safeStorage(): Storage | null {
  try { return typeof localStorage === "undefined" ? null : localStorage; } catch { return null; }
}

/**
 * The index to select, given what is reachable now and what was chosen before.
 *
 * Three steps down, because the address that was saved may genuinely be gone:
 *
 *   1. the same address, which is the normal case and the only exact answer;
 *   2. the same interface, for a laptop whose DHCP lease moved it from
 *      192.168.1.131 to .140 on the same wifi — same route, new number;
 *   3. the same kind, tailnet or not, which is what carries the intent across
 *      a change of network entirely. "I want the address that works from
 *      anywhere" is still answerable on a different wifi; the number is not.
 *
 * Nothing saved, or nothing that matches, falls back to 0 — the list already
 * arrives with the no-extra-software address first.
 */
export function pickIndex(addresses: readonly PickedAddress[], saved: PickedAddress | null): number {
  if (!addresses.length) return 0;
  if (!saved) return 0;
  const exact = addresses.findIndex((a) => a.address === saved.address);
  if (exact >= 0) return exact;
  const sameIface = addresses.findIndex((a) => a.iface === saved.iface);
  if (sameIface >= 0) return sameIface;
  const sameKind = addresses.findIndex((a) => a.tailnet === saved.tailnet);
  return sameKind >= 0 ? sameKind : 0;
}
