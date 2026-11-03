// The Git header's decisions, with no React in them: which situational items
// the slot holds, what the branch chip says, what the fetch tooltip says, and
// why a remote button is disabled. There is no renderer in this project, so
// each rule is a function asserted directly (web/test/git-header.test.ts).
import type { GitBranchInfo, GitLastFetch } from "../../../shared/types.ts";

/** The most the situational slot shows before the rest go behind "+N". */
export const SLOT_MAX_VISIBLE = 2;

export type SlotId = "add-remote" | "make-branch" | "pr" | "prs-land" | "pr-unknown" | "sync" | "undo" | "bisect";

export interface HeaderFacts {
  hasRemote: boolean;
  hasUpstream: boolean;
  detached: boolean;
  ahead: number;
  behind: number;
  /** An open pull request for this branch, known and reachable. */
  hasPr: boolean;
  prsLand: boolean;
  prUnknown: boolean;
  canSync: boolean;
  canUndo: boolean;
  bisecting: boolean;
}

export function headerFacts(b: Pick<GitBranchInfo, "upstream" | "ahead" | "behind" | "detached" | "state"> | undefined, x: { hasRemote: boolean } & Partial<Pick<HeaderFacts, "hasPr" | "prsLand" | "prUnknown" | "canSync" | "canUndo">>): HeaderFacts {
  return {
    hasRemote: x.hasRemote, hasUpstream: !!b?.upstream, detached: !!b?.detached,
    ahead: b?.ahead ?? 0, behind: b?.behind ?? 0,
    hasPr: !!x.hasPr, prsLand: !!x.prsLand, prUnknown: !!x.prUnknown,
    canSync: !!x.canSync, canUndo: !!x.canUndo, bisecting: b?.state === "bisecting",
  };
}

/** Every item the situation calls for, most important first. The way out of a
 *  dead end (no remote, no branch) leads; then the review, then the moves. */
export function slotItems(f: HeaderFacts): SlotId[] {
  const out: SlotId[] = [];
  if (!f.hasRemote) out.push("add-remote");
  if (f.detached) out.push("make-branch");
  if (f.hasPr) out.push("pr");
  if (f.canSync) out.push("sync");
  if (f.canUndo) out.push("undo");
  if (f.bisecting) out.push("bisect");
  if (!f.hasPr && f.prsLand) out.push("prs-land");
  if (!f.hasPr && !f.prsLand && f.prUnknown) out.push("pr-unknown");
  return out;
}

/** At most `max` visible; the rest, in order, behind "+N". */
export function splitSlot<T>(items: T[], max = SLOT_MAX_VISIBLE, pin?: T): { visible: T[]; overflow: T[] } {
  // A pinned item (the sync button, which carries the base picker) never goes
  // behind "+N": it takes the last visible place and pushes that one back.
  if (pin !== undefined && items.indexOf(pin) >= max) {
    const visible = [...items.slice(0, Math.max(max - 1, 0)), pin];
    return { visible, overflow: items.filter((i) => !visible.includes(i)) };
  }
  return { visible: items.slice(0, max), overflow: items.slice(max) };
}

/** How much the header gives up when the row does not fit, one step at a time.
 *  Measured at 1000 px with bisect + detached HEAD + no remote: the row ran
 *  354 px past the window with two slot items and both dashed badges, and fit
 *  only with the badges gone and every slot item behind "+N". The header steps
 *  up while its own scrollWidth exceeds its clientWidth, so the list below is
 *  the order of what it gives up, not a width table. */
export const SQUEEZE_MAX = 4;
export interface HeaderShape {
  /** "no remote" / "no upstream": status only, the buttons' tooltips say the same. */
  badges: boolean;
  /** Slot items drawn in the row; the rest are behind "+N". */
  slotMax: number;
  /** "(bisecting)" after the branch name. */
  chipState: boolean;
}
export function headerShape(level: number): HeaderShape {
  return { badges: level < 1, slotMax: level < 2 ? SLOT_MAX_VISIBLE : level < 3 ? 1 : 0, chipState: level < SQUEEZE_MAX };
}

/** The next squeeze step. A header whose inputs just changed starts again from
 *  everything (the DOM it measured was drawn for the old inputs, so it proves
 *  nothing); the render at step 0 is then measured like any other. */
export function nextSqueeze(overflowing: boolean, squeeze: number, justReset: boolean): number {
  if (justReset && squeeze > 0) return 0;
  return overflowing && squeeze < SQUEEZE_MAX ? squeeze + 1 : squeeze;
}

/** The dashed status badges and their sentences. When the row squeezes the
 *  badges go, and the sentences move into the branch chip's tooltip. */
export function badgeNotes(f: Pick<HeaderFacts, "hasRemote" | "hasUpstream" | "detached">): { label: string; text: string }[] {
  if (!f.hasRemote) return [{ label: "no remote", text: "This repository has no remote yet, so there is nothing to fetch, pull or push." }];
  if (!f.hasUpstream && !f.detached) return [{ label: "no upstream", text: "Nothing to compare against" }];
  return [];
}

export interface StateBanner {
  text: string;
  /** Abort is not a field: it is offered in every stopped state, the one move that is always safe. */
  canContinue: boolean;
  continueWhy: string | null;
}
const STOPPED: Record<string, string> = {
  merging: "Merge in progress", rebasing: "Rebase in progress", "cherry-picking": "Cherry-pick in progress",
  reverting: "Revert in progress", bisecting: "Bisect in progress",
};
/** The strip under the header while git is stopped in the middle of something;
 *  null when it is not. `conflicts` is null until the list has been read: the
 *  banner then names no count and cannot continue. A bisect has nothing to
 *  continue: marking good or bad is the slot's "bisect" button. */
export function stateBanner(state: string | undefined, conflicts: number | null): StateBanner | null {
  if (!state || state === "clean") return null;
  const name = STOPPED[state] ?? `${state} in progress`;
  return {
    text: state === "bisecting" || conflicts === null ? name : `${name} — ${conflicts} conflicted file${conflicts === 1 ? "" : "s"}`,
    canContinue: state !== "bisecting",
    continueWhy: conflicts === null ? "reading the conflicts…" : conflicts > 0 ? "resolve every file first" : null,
  };
}

export interface ChipView {
  text: string;
  detached: boolean;
  /** "merging", "bisecting"... shown in brackets after the name. */
  state: string | null;
  /** Ahead/behind, or null when there is nothing to compare against. */
  sync: { ahead: number; behind: number; inSync: boolean } | null;
}

export function chipView(b: Pick<GitBranchInfo, "name" | "ahead" | "behind" | "upstream" | "detached" | "state">, hasRemote: boolean, sha: string | null, stateLabel: (s: string) => string | null): ChipView {
  const state = b.state && b.state !== "clean" ? stateLabel(b.state) : null;
  if (b.detached) return { text: `detached at ${sha || "HEAD"}`, detached: true, state, sync: null };
  const sync = hasRemote && b.upstream ? { ahead: b.ahead, behind: b.behind, inSync: !b.ahead && !b.behind } : null;
  return { text: b.name, detached: false, state, sync };
}

/** "2 min ago" at the grain a person reads: under a minute is "just now". */
export function ageText(ms: number): string {
  const m = Math.floor(Math.max(0, ms) / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h} h ago` : `${Math.floor(h / 24)} d ago`;
}

const list = (xs: string[]) => xs.length <= 1 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`;

/** The fetch tooltip, or null when the app has no record: unknown is omitted,
 *  never guessed. */
export function fetchedLabel(last: GitLastFetch | null | undefined, now: number): { title: string; sub: string | null } | null {
  if (!last || !last.remotes.length) return null;
  const ago = ageText(now - last.at);
  return {
    title: `Fetched ${list(last.remotes)}${ago === "just now" ? " just now" : ` ${ago}`}`,
    sub: last.news === 0 ? "auto-fetch every 60 s · nothing new" : null,
  };
}

export type RemoteOp = "fetch" | "pull" | "push";

/** Why a remote button cannot be pressed, in the sentence its tooltip shows;
 *  null when it can. */
export function disabledReason(op: RemoteOp, f: Pick<HeaderFacts, "hasRemote" | "hasUpstream" | "detached" | "ahead">): string | null {
  if (op === "fetch") return f.hasRemote ? null : "No remote to fetch from";
  if (op === "pull") return f.hasRemote && f.hasUpstream && !f.detached ? null : "No upstream to pull from";
  if (!f.hasRemote) return "No remote";
  if (f.detached) return "Nothing to push";
  // A branch that is not on the remote yet is exactly what a push is for.
  return f.hasUpstream && f.ahead === 0 ? "Nothing to push" : null;
}

/** Fetch each remote on its own, one after another, reporting each as it
 *  returns (no server streaming: one request per remote). A throw is a failed
 *  remote, not a stopped loop. */
export async function fetchEach(
  remotes: string[],
  one: (remote: string | undefined) => Promise<{ ok: boolean; error?: string; output?: string }>,
  onStep: (remote: string, state: "run" | "ok" | "fail", error?: string) => void,
): Promise<{ remote: string; ok: boolean; error?: string }[]> {
  const out: { remote: string; ok: boolean; error?: string }[] = [];
  // No remote names known (the list has not loaded): one request with none
  // fetches them all. An empty loop would report "fetched" for nothing.
  for (const remote of remotes.length ? remotes : [undefined]) {
    const label = remote ?? "your remotes";
    onStep(label, "run");
    let r: { ok: boolean; error?: string };
    try { r = await one(remote); } catch (e) { r = { ok: false, error: String(e) }; }
    out.push({ remote: label, ok: r.ok, error: r.ok ? undefined : r.error || "failed" });
    onStep(label, r.ok ? "ok" : "fail", r.ok ? undefined : r.error);
  }
  return out;
}

/** The remote a branch's upstream names ("origin/main" -> "origin"). */
export const upstreamRemote = (upstream: string | null | undefined): string | null => upstream ? upstream.split("/")[0] || null : null;
