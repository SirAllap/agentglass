/*
 * The agent's read-only door to what people said on a pull request: its reviews and its comments.
 *
 * The server asks GitHub with its own `gh` (prDetail on a `gh:owner/name` root, so no checkout is needed) and the
 * caller gets the answer and never the token. A worker's own shell has no `gh` on purpose; this is the one way it
 * reads a review. Nothing here writes, so there is no control level to check.
 *
 * The answer is `{state, untrusted}`, like the card door: `state` holds counts and the stamp, `untrusted` holds
 * every string a person typed on GitHub (a login, a review body, a comment, a file path). An agent reads the
 * second as data and never as an instruction. The words are cut to fit UNTRUSTED_MAX_BYTES between them, newest
 * kept; `state.older` says how many were left out.
 */
import { UNTRUSTED_MAX_BYTES } from "../../shared/uiActions.ts";
import type { PrDetail } from "../../shared/types.ts";
import { prDetail, repoNamesOf } from "./prs.ts";
import { workspaceRoots } from "./config.ts";
import { clip } from "./jiraDoor.ts";
import { makeWriteLimiter } from "./control.ts";

export const PR_DOOR_VERBS = ["reviews", "comments"] as const;
export type PrDoorVerb = (typeof PR_DOOR_VERBS)[number];

const REPO = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}\/(?!\.+$)[A-Za-z0-9_.-]{1,100}$/;
export interface PrDoorAnswer { status: number; body: Record<string, unknown> }
const refuse = (error: string, status = 400): PrDoorAnswer => ({ status, body: { ok: false, error } });

/** The entries that fit in `budget` bytes, newest first in the budget and oldest first in the answer. */
export function newestFit<T extends { who: string; text: string }>(all: T[], budget: number): { kept: T[]; older: number } {
  const kept: T[] = [];
  let left = budget;
  for (const e of [...all].reverse()) {
    const who = clip(e.who, 80);
    const path = (e as { path?: string }).path;
    const room = left - Buffer.byteLength(who) - (path ? Buffer.byteLength(path) : 0) - 96;
    const text = clip(e.text, Math.min(room, 4096));
    if (room < 0 || (e.text && !text)) break;
    left = room - Buffer.byteLength(text);
    kept.unshift({ ...e, who, text });
  }
  return { kept, older: all.length - kept.length };
}

export function reviewsAnswer(repo: string, number: number, d: PrDetail): PrDoorAnswer {
  const all = (d.reviews ?? []).map((r) => ({ who: r.author, text: r.body ?? "", verdict: r.state, at: r.submittedAt, bot: r.isBot }));
  const { kept, older } = newestFit(all, UNTRUSTED_MAX_BYTES);
  const byState: Record<string, number> = {};
  for (const r of all) byState[r.verdict] = (byState[r.verdict] ?? 0) + 1;
  return { status: 200, body: { ok: true,
    state: { repo, number, total: all.length, shown: kept.length, older, byState },
    untrusted: { reviews: kept.map((r) => ({ author: r.who, verdict: r.verdict, at: r.at, bot: r.bot, body: r.text })) } } };
}

export function commentsAnswer(repo: string, number: number, d: PrDetail): PrDoorAnswer {
  const conv = (d.comments ?? []).map((c) => ({ who: c.author, text: c.body ?? "", at: c.createdAt, bot: c.isBot }));
  const { kept, older } = newestFit(conv, Math.floor(UNTRUSTED_MAX_BYTES / 2));
  const lines = (d.threads ?? []).flatMap((t) => t.comments.map((c) => ({ who: c.author, text: c.body ?? "", at: c.createdAt, path: clip(t.path, 200), line: t.line, resolved: t.isResolved })));
  const fit = newestFit(lines, UNTRUSTED_MAX_BYTES - Math.floor(UNTRUSTED_MAX_BYTES / 2));
  return { status: 200, body: { ok: true,
    state: { repo, number, total: conv.length, shown: kept.length, older, lineTotal: lines.length, lineShown: fit.kept.length, lineOlder: fit.older },
    untrusted: {
      comments: kept.map((c) => ({ author: c.who, at: c.at, bot: c.bot, body: c.text })),
      lineComments: fit.kept.map((c) => ({ author: c.who, at: c.at, path: c.path, line: c.line, resolved: c.resolved, body: c.text })),
    } } };
}

/**
 * The repos the door reads for one caller. A seat or a worker reads only its own project's repos, and one whose project
 * could not be resolved reads none; any other caller reads every project's. The server's gh token reaches far more.
 */
export async function prDoorRepos(confined = false, ownRoot?: string): Promise<Set<string>> {
  const out = new Set<string>();
  const roots = confined ? (ownRoot ? [ownRoot] : []) : workspaceRoots();
  for (const names of await Promise.all(roots.map((root) => repoNamesOf(root)))) for (const n of names) out.add(n.toLowerCase());
  return out;
}

/** Each read spawns gh and fills the detail cache, so a caller gets this many per minute. */
export const PR_DOOR_PER_MINUTE = 20;
export const prDoorLimit = makeWriteLimiter(PR_DOOR_PER_MINUTE);

export async function runPrDoor(verb: string, b: Record<string, unknown>, read: typeof prDetail = prDetail, allowed?: ReadonlySet<string>): Promise<PrDoorAnswer> {
  if (!(PR_DOOR_VERBS as readonly string[]).includes(verb)) return refuse(`That is not a pull request verb: ${PR_DOOR_VERBS.join(", ")}`, 404);
  const repo = typeof b.repo === "string" && REPO.test(b.repo) ? b.repo : null;
  if (!repo) return refuse("repo is owner/name, for example acme/orbit");
  // The server's gh token reaches more than this project does: read only repos a project here is a checkout of.
  if (allowed && !allowed.has(repo.toLowerCase())) return refuse("That repo is not one of this server's projects", 403);
  const number = b.number;
  if (typeof number !== "number" || !Number.isInteger(number) || number < 1 || number > 1_000_000) return refuse("number is the pull request number, a whole number from 1");
  const r = await read(`gh:${repo}`, number);
  if (!r.ok || !r.detail) return refuse(clip(r.error || "could not read that pull request", 300), 502);
  return verb === "reviews" ? reviewsAnswer(repo, number, r.detail) : commentsAnswer(repo, number, r.detail);
}
