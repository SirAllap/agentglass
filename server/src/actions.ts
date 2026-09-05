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
  /**
   * Whether this request came from one of the app's own pages — the desktop
   * shell's renderer or the dashboard in a browser — as opposed to a bare
   * client holding the same token: a hook, the CLI, an MCP client, an agent's
   * `curl`. The route decides it, because the evidence is the Origin header and
   * only the route has the request.
   *
   * Three states, and the third is the point. `true` and `false` are answers;
   * *absent* means the caller never looked, and then this module keeps saying
   * what it has always said. A missing flag read as `false` would relabel every
   * press a person makes as a bare client on every route that has not been
   * taught to set it, and a log that calls the human a machine is worse than
   * one that calls the machine a human — the first is wrong on nearly every
   * row, the second on the rare one.
   *
   * What it is not: proof. Origin is unforgeable for a *browser*, which is what
   * makes it worth checking against a page on the web; a local process holding
   * the token can put whatever it likes in a header. This separates the honest
   * cases, which is what a log is for. What stops the held party releasing its
   * own hold is the route refusing the credential, not this field.
   */
  fromPage?: boolean;
}

/**
 * The name for this machine's own token, presented by something that is not one
 * of the app's pages.
 *
 * "local" was the only answer here, and it is what a person pressing the button
 * in the desktop app produces — so an audit line could not tell the desk apart
 * from a script, a hook, or the very agent whose call was being held. For every
 * other write that ambiguity is a nuisance; for a gate it voids the record,
 * because "who approved that" is the whole question the log exists to answer
 * and both possible answers looked identical.
 *
 * The words are chosen for the reader months later rather than for precision:
 * it says what was presented, which is all that is actually known. The token is
 * shared by the whole machine, so no name can be invented for its holder — but
 * "not the person at the desk, and not a paired device" is a fact, and it is
 * the one that changes what the line means.
 */
export const MACHINE_ACTOR = "machine token";

/**
 * Whether an actor string is the shared token rather than a person.
 *
 * Exported because the audit line is not the only place the distinction has to
 * land: gate.ts tells a stopped model who released it, and the actor string is
 * the only thing the decision path carries. It asks this function instead of
 * matching a literal of its own, for the reason typedReason() compares against
 * defaultReason() rather than a copy of its text — two spellings of the same
 * fact drift, and the day they do, the model is told a human decided again.
 */
export function isMachineActor(actor: string | null | undefined): boolean {
  return typeof actor === "string" && (actor === MACHINE_ACTOR || actor.startsWith(`${MACHINE_ACTOR} · `));
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
 *
 * The label is also the one piece of this vocabulary an outsider writes, so it
 * is the one place the vocabulary can be borrowed: a phone paired as "machine
 * token" would produce a line that reads as the shared credential, and gate.ts
 * would then tell a stopped model no human had decided when one had. Such a
 * label is dropped rather than trusted — the same reason the id rides along at
 * all, applied to the other thing this string must not be mistaken for.
 */
export function deviceActor(d: { id: string; label: string }): string {
  const short = String(d.id).replace(/[^0-9a-z]/gi, "").slice(0, 6) || "unknown";
  const raw = String(d.label || "").trim().replace(/\s+/g, " ").slice(0, 40);
  const label = raw.toLowerCase() === MACHINE_ACTOR ? "" : raw;
  return label ? `${label} · ${short}` : `device · ${short}`;
}

/**
 * Who did it, as far as the server can honestly tell.
 *
 * Three answers, and which one applies is a question of what the caller proved.
 *
 * A *paired device* has its own credential and the name somebody accepted when
 * they paired it (devices.ts), so here a name is a fact rather than a fiction —
 * this is the part the shared token could never support, and the reason the
 * question in #299 has a real answer now instead of an address.
 *
 * The *machine token presented by something that is not a page* is the answer
 * this function used to fold into the one below it. A hook, the CLI and an
 * agent's `curl` all hold that token — it is in the agent's own environment and
 * readable on disk — so a line saying `local` covered both the person at the
 * desk and the process the line was about. They are now different strings; see
 * MACHINE_ACTOR for the wording and for what this does not claim.
 *
 * Everything else falls back to where the request arrived from: `local` for a
 * loopback caller — the dashboard on this machine — and the address otherwise,
 * which is all a shared token can honestly assert about a caller who did not
 * say how it arrived.
 */
export function actorOf(ip: string | null | undefined, caller?: ActorSource | null): string {
  const dev = caller?.kind === "device" ? caller.device : null;
  if (dev) return deviceActor(dev);
  const where = !ip || isLoopback(ip) ? "local" : ip.replace(/^::ffff:/, "");
  // `=== false` and not `!caller.fromPage`: absent is "the route never looked",
  // and the address on its own is what it has always meant. See ActorSource.
  if (caller?.kind === "machine" && caller.fromPage === false) return `${MACHINE_ACTOR} · ${where}`;
  return where;
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
