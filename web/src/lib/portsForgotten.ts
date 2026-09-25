// Which listening ports the Lantern mentions. The Lantern is about who needs
// you; a server nobody uses does not, so this is a quiet section drawn only when
// there is something to say and never a notification, a number on the rail, or
// a reason to interrupt. It names the port and why, and stops nothing — the
// stop button is in Machine › Ports.
import type { PortEntry } from "../../../shared/types.ts";

export interface Forgotten { port: PortEntry; why: string[] }

/** Ours only, with every reason the row's own badges give, in the order they read. */
export function forgottenPorts(ports: readonly PortEntry[]): Forgotten[] {
  const out: Forgotten[] = [];
  for (const p of ports) {
    if (!p.mine) continue;
    const why: string[] = [];
    if (p.cwdGone) why.push("checkout gone");
    if (p.tmpLeftover) why.push("tmp leftover");
    if (p.duplicate) why.push("duplicate");
    if (p.idleSec != null) why.push("idle");
    if (why.length) out.push({ port: p, why });
  }
  return out;
}
