/*
 * "Can the app show this link itself?"
 *
 * An agent prints a pull request's URL, a card mentions another card, a review
 * says "see #1042" — and every one of those used to open the system browser,
 * for something the app has a view of one click away. Each place that draws a
 * link (the terminal's URL addon, the shared markdown renderer, the pull
 * request's own body renderer) asks this one question here, rather than each
 * growing its own idea of what a pull request URL looks like.
 *
 * Three answers. A GitHub pull request opens the pull request view, a ClickUp
 * card opens the card in the Tasks view, and everything else — issues, commits
 * outside this pull request, docs, any other host — leaves exactly as it did.
 *
 * Hosts are compared whole, after the URL parser has read them. A pattern over
 * the raw string is how `https://github.com.evil.example/a/b/pull/1` becomes an
 * in-app link, and the in-app view then fetches whatever that URL named through
 * the owner's own `gh` token. github.com only: an enterprise host serves the
 * same path, but the panel reads through a checkout whose remote says which
 * host it is, and the router has no way to ask that — an enterprise link goes
 * out, which is where it went before.
 *
 * Escape hatch: Ctrl (Cmd on a Mac) held while clicking opens the external
 * browser, everywhere. In rendered markdown Shift and Alt and the middle button
 * do too, because those already mean "new window" to a browser.
 */
import { openExternal } from "./externalUrl.ts";
import { openCard } from "./openCard.ts";
import { openPr } from "./openPrs.ts";
import { api } from "./api.ts";
import { clickupSetup, clickupSetupNow } from "./clickupSetup.ts";

export type LinkRoute =
  | { kind: "pr"; repo: string; number: number; url: string }
  /** `#123` or `owner/repo#123` as a pull request body autolinks it: GitHub
   *  writes both issues and pull requests that way, so it might be either. The
   *  pull request view tries it and gives it back to the browser when it is not
   *  one. */
  | { kind: "ref"; repo: string; number: number; url: string }
  | { kind: "card"; query: string; url: string }
  | { kind: "external"; url: string };

const GITHUB = new Set(["github.com", "www.github.com"]);
/** Where a ClickUp task lives. The API host is not a page, and a lookalike
 *  subdomain on somebody else's zone is not ClickUp. */
const CLICKUP = new Set(["app.clickup.com"]);

/* A URL printed in prose ends where the sentence does: "(see https://…/pull/7)."
   The terminal addon already stops before most of these, a markdown link never
   has them, and a pasted one might — so they are trimmed here rather than
   trusted to have been trimmed. */
const TRAILING = /[)\].,;:!?'"»>]+$/;
const SAFE_SEGMENT = /^[\w.-]+$/;

/**
 * What a link is, as far as the app is concerned. Null when it is not a link
 * anything should follow at all — `javascript:`, `data:`, a relative path.
 *
 * `shortRef` says the anchor was written by the body autolinker from `#123`,
 * which is the only case an `/issues/` path is worth trying as a pull request.
 */
export function classifyLink(raw: string | null | undefined, opts: { shortRef?: boolean } = {}): LinkRoute | null {
  const text = raw?.trim().replace(TRAILING, "");
  if (!text) return null;
  let u: URL;
  try { u = new URL(text); } catch { return null; }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  const url = u.href;
  // Credentials in a URL are a disguise (`https://github.com@evil.example/`
  // parses to evil.example, but `https://github.com:x@…` is worth refusing too).
  if (u.username || u.password) return { kind: "external", url };
  const host = u.hostname.toLowerCase();
  const seg = u.pathname.split("/").filter(Boolean);
  if (GITHUB.has(host) && seg.length >= 4 && SAFE_SEGMENT.test(seg[0]!) && SAFE_SEGMENT.test(seg[1]!)) {
    const number = /^\d+$/.test(seg[3]!) ? Number(seg[3]) : 0;
    if (Number.isSafeInteger(number) && number > 0) {
      const repo = `${seg[0]}/${seg[1]}`;
      if (seg[2] === "pull") return { kind: "pr", repo, number, url };
      if (seg[2] === "issues" && opts.shortRef && seg.length === 4) return { kind: "ref", repo, number, url };
    }
  }
  // `/t/<id>` and `/t/<workspace>/<custom-id>`: with two segments the task is
  // the last one, the first is the workspace (same rule as shared/taskref.ts).
  if (CLICKUP.has(host) && seg[0] === "t" && (seg.length === 2 || seg.length === 3)
    && seg.slice(1).every((s) => SAFE_SEGMENT.test(s) && !s.includes("."))) {
    return { kind: "card", query: seg[seg.length - 1]!, url };
  }
  return { kind: "external", url };
}

/** A link whose text is `#123` or `owner/repo#123`: what the body autolinker
 *  writes, and what GitHub writes for a reference of either kind. */
export function isShortRef(text: string | null | undefined): boolean {
  return /^(?:[\w.-]+\/[\w.-]+)?#\d+$/.test(text?.trim() ?? "");
}

/** Modifier state, from a DOM or a React event alike. */
type Click = { ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean; altKey?: boolean; button?: number };

/** Ctrl/Cmd everywhere. `strict` adds what a browser reads as "new window" —
 *  used for markdown, not for the terminal, where Shift is how a click gets
 *  past a program that has the mouse. */
export function wantsExternal(e: Click | undefined, strict = false): boolean {
  if (!e) return false;
  if (e.ctrlKey || e.metaKey) return true;
  return strict && (!!e.shiftKey || !!e.altKey || (e.button ?? 0) !== 0);
}

/*
 * Which repositories have a checkout here, remembered for a minute: the panel
 * reads a pull request through one, and without it the panel has nothing to
 * show. A link to a repository nobody has cloned goes to the browser instead
 * of to a view that would only say so. "No checkout" is remembered like "yes";
 * a request that did not come back is not.
 *
 * Once the answer is in it is returned as a plain boolean, so the second click
 * on a link is decided inside the click — see openInApp.
 */
const LOCATE_TTL = 60_000;
const located = new Map<string, { at: number; ok: Promise<boolean>; value?: boolean }>();
function hasCheckout(repo: string): boolean | Promise<boolean> {
  const key = repo.toLowerCase(); // GitHub names are case-insensitive
  const hit = located.get(key);
  if (hit && Date.now() - hit.at < LOCATE_TTL) return hit.value ?? hit.ok;
  const entry: { at: number; ok: Promise<boolean>; value?: boolean } = { at: Date.now(), ok: Promise.resolve(false) };
  entry.ok = api.prLocate(repo).then((r) => (entry.value = !!(r.ok && r.root)))
    .catch(() => { located.delete(key); return false; });
  located.set(key, entry);
  return entry.ok;
}

export interface RouteDeps {
  /** A boolean when the answer is already known, a promise when it is not. */
  hasCheckout: (repo: string) => boolean | Promise<boolean>;
  hasClickup: () => boolean | Promise<boolean>;
  openPr: typeof openPr;
  openCard: typeof openCard;
  openExternal: typeof openExternal;
}
const live: RouteDeps = {
  hasCheckout, openPr, openCard, openExternal,
  // Same answer the card chips use: a machine with no ClickUp board has no
  // view to open the card in.
  hasClickup: () => clickupSetupNow()?.connected ?? clickupSetup().then((s) => s.connected),
};

/**
 * Open the link inside the app when it is something the app shows. True when
 * it took the link — the caller then stops the browser's own handling; false
 * leaves the caller's default (the external browser) exactly as it was.
 *
 * Ceiling: the pull request and Tasks views have no history of their own. The
 * pull request view's "back to <repo>" strip returns from a borrowed checkout;
 * nothing returns you to the terminal line or the card you came from.
 */
export function openInApp(
  raw: string | null | undefined,
  e?: Click,
  opts: { shortRef?: boolean; strict?: boolean } = {},
  deps: RouteDeps = live,
): boolean {
  if (wantsExternal(e, opts.strict)) return false;
  const r = classifyLink(raw, opts);
  if (!r || r.kind === "external") return false;
  const inApp = r.kind === "card"
    ? () => deps.openCard(r.query)
    : () => deps.openPr(r.repo, r.number, r.kind === "ref" ? { fallback: r.url } : {});
  const can = r.kind === "card" ? deps.hasClickup() : deps.hasCheckout(r.repo);
  /* Known already: decided inside the click. "No" hands the link back to the
     caller, whose own handling is the browser — opened by the click itself,
     which a popup blocker allows. */
  if (typeof can === "boolean") { if (can) inApp(); return can; }
  /* Not known yet: the browser's own handling has to be cancelled before we
     know, so the fallback opens it by hand after the round trip. The desktop
     app allows that; a plain web tab may block a window opened that late, and
     the next click on the same link is decided from the cache. */
  void can.then((ok) => { if (ok) inApp(); else deps.openExternal(r.url); });
  return true;
}

/** The terminal's handler: in the app when it can be, the browser otherwise. */
export function followLink(raw: string, e?: Click): void {
  if (!openInApp(raw, e)) openExternal(raw);
}
