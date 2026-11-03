/**
 * What the open pull request's chrome says, decided away from the screen: the
 * tab strip's numbers, the dock's reason sentence and what the dock gives up
 * when the detail is narrow. A screen cannot be asked "what does the Checks tab
 * show when two of nine fail?" without drawing it.
 */
import type { DetailBand } from "./prDock.ts";

export type TabId = "overview" | "conversation" | "commits" | "files" | "checks" | "review";

/** The strip's six tabs, in the mockup's order. Review is always there: what it holds depends on who is looking, the tab does not. */
export const TAB_IDS: readonly TabId[] = ["overview", "conversation", "commits", "files", "checks", "review"];

export type TabFacts = {
  /** Comments, threads and bot lanes the Conversation tab lists. */
  conversation: number;
  /** Atoms said since the person last looked. */
  newAtoms: number;
  commits: number;
  files: number;
  checksTotal: number;
  checksFailing: number;
  /** Line comments written and not sent. */
  drafts: number;
  /** A review is owed (asked of this person) or written and not sent. */
  reviewAsked: boolean;
  reviewDraft: boolean;
  /** Local findings, from the review run on this machine, not yet resolved or dismissed. */
  openFindings: number;
};

export type Hot = { text: string; tone: "bad" | "accent"; title: string };
export type TabView = { count?: number; hot?: Hot };

/**
 * The number beside a tab and, when the tab wants something, the one pill that
 * says what. Red is for something broken (failing checks) and for findings the
 * local review raised that nobody has settled; the accent is for news and for
 * a verdict that is owed. Review has the one pill, so the open findings take it
 * (they are what the person has to act on before sending a verdict) and the
 * "asked" or "draft" pill comes back once none is open.
 */
export function tabView(id: TabId, f: TabFacts): TabView {
  switch (id) {
    case "conversation":
      return { count: f.conversation, hot: f.newAtoms > 0 ? { text: `${f.newAtoms} new`, tone: "accent", title: `${f.newAtoms} new since you last looked` } : undefined };
    case "commits": return { count: f.commits };
    case "files": return { count: f.files };
    case "checks":
      return { count: f.checksTotal, hot: f.checksFailing > 0 ? { text: String(f.checksFailing), tone: "bad", title: `${f.checksFailing} failing` } : undefined };
    case "review":
      return {
        count: f.drafts || undefined,
        hot: f.openFindings > 0
          ? { text: String(f.openFindings), tone: "bad", title: `${f.openFindings} open local ${f.openFindings === 1 ? "finding" : "findings"}` }
          : f.reviewAsked || f.reviewDraft
          ? { text: f.reviewAsked ? "asked" : "draft", tone: "accent", title: f.reviewAsked ? "A review was asked of you" : "A review is written but not sent: it is kept until you send it" }
          : undefined,
      };
    default: return {};
  }
}

export type DockReason = { kind: "ok" | "blocked" | "closed"; text: string };

/**
 * The sentence beside the Merge button: "Ready to land", or the one thing in
 * the way. A merged or closed pull request has nothing to land, and says why.
 */
export function dockReason(i: {
  state: "OPEN" | "MERGED" | "CLOSED";
  merging: boolean;
  /** The first refusal's title, when something forbids the merge. */
  refusal?: string;
  /** GitHub would merge it. */
  canMerge: boolean;
  isBehind: boolean;
  base: string;
  /** GitHub's own words for why it cannot (mergeBlockedWhy). */
  blockedWhy: string;
}): DockReason {
  if (i.state === "MERGED") return { kind: "closed", text: "Already merged" };
  if (i.state === "CLOSED") return { kind: "closed", text: "This pull request is closed" };
  if (i.merging) return { kind: "ok", text: "Merging…" };
  if (i.refusal) return { kind: "blocked", text: i.refusal };
  if (i.canMerge) return { kind: "ok", text: "Ready to land" };
  if (i.isBehind) return { kind: "ok", text: `Ready to land, but ${i.base} has moved on` };
  return { kind: "blocked", text: i.blockedWhy };
}

/**
 * What the dock keeps at this width. The order of the buttons never changes;
 * the narrow detail sends To draft and Close into one overflow menu, shortens
 * Send to terminal to its icon, and drops the reason sentence as the mockup's
 * 760px container query does, except when the sentence is the answer to "why
 * is Merge off": a blocked or closed pull request keeps it, because a button
 * that is dimmed with its reason hidden is the thing people open the browser
 * to understand.
 */
export function dockFit(band: DetailBand, reasonKind: DockReason["kind"] = "ok"): { reason: boolean; draftClose: "inline" | "menu"; termLabel: boolean } {
  return band === "narrow"
    ? { reason: reasonKind !== "ok", draftClose: "menu", termLabel: false }
    : { reason: true, draftClose: "inline", termLabel: true };
}

/**
 * The three branch slots between the reason and To draft / Close. All three are
 * always drawn, in this order; what cannot be done now is dimmed in place, never
 * removed, so the row does not rearrange itself when a conflict appears.
 * Send to terminal hands the conflict to an agent when there is one, and the
 * pull request to the review agent when there is not.
 */
export function dockSlots(i: { state: "OPEN" | "MERGED" | "CLOSED"; canUpdate: boolean; behind: number; updateLabel: string; conflicted: boolean; canTerm: boolean }) {
  const open = i.state === "OPEN";
  return {
    update: { label: i.canUpdate || i.behind > 0 ? i.updateLabel : "Up to date", enabled: open && i.canUpdate },
    resolve: { enabled: open && i.conflicted },
    term: { kind: (i.conflicted ? "conflict" : "review") as "conflict" | "review", enabled: i.canTerm },
  };
}
