// What a fleet row says about the runtime collisions its session is part of.
// The detection is the server's (server/src/collisions.ts); this only picks a
// session's own share out of the list and words it.
import type { Collision, CollisionParty } from "../../../shared/types.ts";

export interface CollisionNote {
  kind: Collision["kind"];
  resource: string;
  /** Everybody on the resource except the session the row belongs to. */
  others: CollisionParty[];
}

export function collisionsFor(list: Collision[], app: string, sessionId: string): CollisionNote[] {
  const out: CollisionNote[] = [];
  for (const c of list) {
    const mine = (p: CollisionParty) => p.source_app === app && p.session_id === sessionId;
    if (!c.parties.some(mine)) continue;
    out.push({ kind: c.kind, resource: c.resource, others: c.parties.filter((p) => !mine(p)) });
  }
  return out;
}

const tail = (path: string) => path.replace(/\/+$/, "").split("/").pop() || path;

/** The resource in the few words a chip has room for: a path by its file name,
 *  a database by its name. */
export function shortResource(c: { kind: Collision["kind"]; resource: string }): string {
  const key = c.resource.slice(c.kind.length + 1);
  switch (c.kind) {
    case "postgres": return `postgres ${key.slice(key.indexOf("/") + 1) || key}`;
    case "sqlite": case "socket": case "datadir": case "env": return `${c.kind} ${tail(key)}`;
    default: return c.resource;
  }
}

export function collisionChip(notes: CollisionNote[]): string {
  if (!notes.length) return "";
  return `shares ${shortResource(notes[0])}${notes.length > 1 ? ` +${notes.length - 1}` : ""}`;
}

export function collisionTitle(notes: CollisionNote[]): string {
  const lines = ["Possible collision — read from what these sessions ran, so check before trusting either result."];
  for (const n of notes) {
    lines.push("", n.resource);
    for (const p of n.others) lines.push(`  also ${p.source_app}:${p.session_id.slice(0, 8)} in ${tail(p.checkout)} — ${p.evidence}`);
  }
  return lines.join("\n");
}
