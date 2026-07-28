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

/**
 * Who did it, as far as the server can honestly tell.
 *
 * There are no accounts here, and the token is shared rather than personal, so
 * a name would be a fiction. What is true is where the request arrived from:
 * `local` for a loopback caller — the dashboard on this machine — and the
 * address for anything else, which is what makes "I approved that from my
 * phone" a question with an answer.
 */
export function actorOf(ip: string | null | undefined): string {
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
): void {
  recordAction({
    actor: actorOf(ip),
    action: pathname,
    target: targetOf(pathname, body),
    ok: !!res?.ok,
    detail: res?.error ? clip(String(res.error)) : null,
  });
}
