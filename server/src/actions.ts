// What the cockpit did, and where the request came from.
//
// The dashboard performs real writes: it stages and discards, pushes, merges
// pull requests, removes containers, and answers the gate that has an agent
// stopped at the other end of it. Until now the only record was a ring buffer
// that says of itself it is "a live view of the current session, not an audit
// trail" (gitlog.ts:11) — so "who approved that", and "what happened to my
// branch while I was at lunch", had no answer at all.
//
// This module owns two decisions and nothing else: who the actor is, and what
// the target of a route was. The writing itself is db.recordAction.

import { isLoopback } from "./remote.ts";
import { recordAction } from "./db.ts";
import { basename } from "node:path";

/** What the actor of a request needs to be nameable: a device that presented
 *  its own credential, or nothing. Structural rather than importing `Caller`,
 *  so a test can name an actor without standing up the auth module. */
export interface ActorSource {
  kind: "machine" | "device";
  device?: { id: string; label: string };
}

/**
 * A device's name, made unambiguous.
 *
 * The label is free text the phone picked for itself at pairing. Two of them
 * being identical is not a corner case: `issueDevice` defaults an unnamed one
 * to "A device", so every phone that skipped the field collides with every
 * other. An audit line reading "A device approved rm -rf build" answers the
 * question worse than the address it replaced, so the device's own id comes
 * with it — short, because it only has to separate the handful of phones one
 * person has paired.
 *
 * The id is part of the stored string rather than resolved at read time on
 * purpose: forgetting a phone must not erase who used it, and a log that turns
 * into unresolvable ids the moment you revoke a device is exactly wrong.
 */
export function deviceActor(d: { id: string; label: string }): string {
  const short = String(d.id).replace(/[^0-9a-z]/gi, "").slice(0, 6) || "unknown";
  const label = String(d.label || "").trim().replace(/\s+/g, " ").slice(0, 40);
  return label ? `${label} · ${short}` : `device · ${short}`;
}

/**
 * Who did it, as far as the server can honestly tell.
 *
 * Two answers, and which one applies is a question of what the caller proved.
 *
 * A *paired device* has its own credential and the name somebody accepted when
 * they paired it (devices.ts), so here a name is a fact rather than a fiction —
 * this is the part the shared token could never support, and the reason the
 * question in #299 has a real answer now instead of an address.
 *
 * Everything else falls back to where the request arrived from: `local` for a
 * loopback caller — the dashboard on this machine — and the address otherwise,
 * which is all the machine token can honestly assert, since it is shared.
 */
export function actorOf(ip: string | null | undefined, caller?: ActorSource | null): string {
  const dev = caller?.kind === "device" ? caller.device : null;
  if (dev) return deviceActor(dev);
  if (!ip) return "local";
  return isLoopback(ip) ? "local" : ip.replace(/^::ffff:/, "");
}

/** Longest a target may be. A commit message or a review body belongs in the
 *  thing it was written on, not in a log line about it. */
const MAX_TARGET = 120;
const clip = (s: string) => (s.length > MAX_TARGET ? s.slice(0, MAX_TARGET - 1) + "…" : s);

/**
 * The subject of a write, short enough to read in a list.
 *
 * `root` is an absolute path and would be the same prefix on every line, so it
 * is reduced to the checkout's own name — which is what the rest of the UI
 * shows too. What varies is what follows it, and that is the part worth
 * keeping: which files were discarded, which branch was deleted, which
 * container was removed.
 */
export function targetOf(pathname: string, b: Record<string, unknown>): string {
  const repo = typeof b.root === "string" && b.root ? basename(b.root) : "";
  const paths = Array.isArray(b.paths) ? (b.paths as unknown[]).filter((p) => typeof p === "string") as string[] : [];
  const named = (n: unknown) => (typeof n === "string" || typeof n === "number" ? String(n) : "");

  // A gate: what was held, not the uuid it was held under.
  if (pathname.startsWith("/gate/")) return clip([named(b.tool), named(b.summary)].filter(Boolean).join(" · "));
  if (pathname.startsWith("/docker/")) return named(b.id);
  // A chat launch: where it runs and on what. Never the prompt — see index.ts.
  if (pathname === "/chat/send") return clip([repo, named(b.name)].filter(Boolean).join(" · "));
  if (pathname.startsWith("/prs/")) {
    const num = named(b.number);
    return clip([repo, num && `#${num}`].filter(Boolean).join(" "));
  }
  if (pathname.startsWith("/git/")) {
    // The argument that identifies what was touched. Which one that is depends
    // on the verb, and getting it wrong turns "deleted branch release-4" into
    // an unhelpful bare repo name.
    const what =
      paths.length ? paths.map((p) => (repo && p.includes("/") ? p.split("/").slice(-2).join("/") : p)).join(" ")
      : named(b.name) || named(b.message) || named(b.title) || named(b.ref) || named(b.to)
      || (b.index !== undefined ? `#${named(b.index)}` : "");
    return clip([repo, what].filter(Boolean).join(" "));
  }
  return clip(repo);
}

/**
 * Record one write.
 *
 * Everything that goes through a write route is kept, including the small
 * things — a resolved review thread, an emoji reaction. A recorder that decides
 * what is worth recording is a log nobody can trust, and the filtering belongs
 * to whoever reads it. The volume allows for that: every row here is a person
 * pressing something, which is tens a day, not the thousands an hour the events
 * table takes.
 *
 * `/control` is not routed through here and is not meant to be: it moves the
 * UI's own focus and grants nothing the keyboard does not already have, so
 * logging it would bury the merges under navigation.
 */
export function noteAction(
  ip: string | null | undefined,
  pathname: string,
  body: Record<string, unknown>,
  res: { ok?: boolean; error?: string } | null,
  caller?: ActorSource | null,
): void {
  recordAction({
    actor: actorOf(ip, caller),
    action: pathname,
    target: targetOf(pathname, body),
    ok: !!res?.ok,
    detail: res?.error ? clip(String(res.error)) : null,
  });
}
