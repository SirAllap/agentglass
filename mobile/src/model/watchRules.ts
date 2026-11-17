/*
 * The watch sheet's rules, built so the server stores exactly what was drawn.
 *
 * The rules belong to the computer (`server/src/prNotifyWatch.ts` keeps them, so
 * they outlive the window and a phone that goes into a pocket); the sheet is a
 * view of them, and this file is the join. Two things it must get right, and
 * both are here rather than in the sheet:
 *
 *   * a rule the sheet builds is a rule `coerceRule` accepts, so a switch turned
 *     on cannot silently arm nothing;
 *   * the skip list is a list of EXACT check names (`ci-pass.ignore`), trimmed,
 *     without repeats and capped at 30 — the server's own ceiling, because a
 *     sheet that armed more than the server keeps would show a skip that never
 *     happens.
 *
 * The three rules are the ones the mock's "Tell me when…" sheet draws, and each
 * keeps the server's semantics rather than a nicer-sounding one: a CI rule fires
 * ONCE and turns itself off, a comment rule stays on until it is removed.
 */
import type { PrWatch, PrWatchRule } from "../../../shared/types.ts";

/** The server's cap on one skip list (`MAX_IGNORE`), and on one name. */
export const MAX_IGNORE = 30;
export const MAX_IGNORE_LEN = 200;

export type WatchKind = "green" | "fails" | "comments";

export interface WatchKindRow {
  id: WatchKind;
  label: string;
  /** One line under the label: what it does, in the person's terms. */
  sub: string;
  /** Fires once and turns itself off, rather than staying on. */
  once: boolean;
}

export const WATCH_KINDS: readonly WatchKindRow[] = [
  {
    id: "green",
    label: "Everything is green",
    sub: "Once, then the rule turns itself off.",
    once: true,
  },
  {
    id: "fails",
    label: "Something fails",
    sub: "The first failure only, then quiet until the run changes.",
    once: true,
  },
  {
    id: "comments",
    label: "Someone comments",
    sub: "A comment, a review or a change asked for.",
    once: false,
  },
];

/** What the sheet holds while somebody is turning things on and off. */
export interface WatchDraft {
  green: boolean;
  fails: boolean;
  comments: boolean;
  /** The skip list as typed: names separated by commas or newlines. */
  skip: string;
  /** "Same for my new PRs in this repo" — the repository's default rules. */
  sameForNew: boolean;
}

export const NO_RULES: WatchDraft = { green: false, fails: false, comments: false, skip: "", sameForNew: false };

/** Check names, as the server stores them: trimmed, no empties, no repeats,
 *  each cut at 200, and the list at 30. The order is what was typed. */
export function skipNames(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/[,\n]/)) {
    const name = raw.trim().slice(0, MAX_IGNORE_LEN);
    if (!name || out.includes(name)) continue;
    out.push(name);
    if (out.length === MAX_IGNORE) break;
  }
  return out;
}

/** The rule one kind makes. `green` carries the skip list; the other two take
 *  none, which is why a skip list typed with only "fails" on is not armed. */
export function ruleOf(kind: WatchKind, draft: WatchDraft): PrWatchRule {
  if (kind === "fails") return { type: "ci-fail" };
  if (kind === "comments") return { type: "comment" };
  const ignore = skipNames(draft.skip);
  return ignore.length ? { type: "ci-pass", ignore } : { type: "ci-pass" };
}

/** The rules the draft asks for, in the sheet's own order. */
export function rulesOf(draft: WatchDraft): PrWatchRule[] {
  return WATCH_KINDS
    .filter((k) => (k.id === "green" ? draft.green : k.id === "fails" ? draft.fails : draft.comments))
    .map((k) => ruleOf(k.id, draft));
}

/** What the server already has on this pull request. */
export interface Armed {
  watches: readonly PrWatch[];
  /** The repository's default rules, when one is saved. */
  preset?: { rules: readonly PrWatchRule[]; auto: boolean } | null;
}

/**
 * The same draft, read back from the server: which switches are on and which
 * names are skipped. The union of the armed rules, not the first one — the
 * server keeps one row per kind, and only "All CI passed" can be repeated with
 * another skip list (it replaces it).
 */
export function draftOf(armed: Armed): WatchDraft {
  const rules = armed.watches.filter((w) => w.active).map((w) => w.rule);
  const pass = rules.find((r) => r.type === "ci-pass");
  return {
    green: rules.some((r) => r.type === "ci-pass"),
    fails: rules.some((r) => r.type === "ci-fail"),
    comments: rules.some((r) => r.type === "comment"),
    skip: pass?.type === "ci-pass" ? (pass.ignore ?? []).join(", ") : "",
    // A repo default is "on" only when it has rules AND applies them to new
    // PRs: rules saved with auto off are a saved preset, not a standing order.
    sameForNew: !!armed.preset?.auto && armed.preset.rules.length > 0,
  };
}

/** The most rules one pull request may hold; the server refuses the 21st. */
export const MAX_RULES_PER_PR = 20;

/**
 * The writes a press on Done needs: the rules to arm, the watches to remove,
 * and whether the repo default changed. A rule already armed with the same skip
 * list is not posted again — pressing the bell twice is not two rules, and the
 * server would answer one row anyway.
 */
export interface WatchWrites {
  add: PrWatchRule[];
  /** Ids, because that is what `/prs/notify-watch/remove` takes. */
  remove: string[];
  /** The repo's default rules, or null when the switch was not touched. */
  preset: { rules: PrWatchRule[]; auto: boolean } | null;
}

const sameKind = (a: PrWatchRule, b: PrWatchRule): boolean =>
  a.type === b.type && (a.type !== "check" || (b.type === "check" && a.match.toLowerCase() === b.match.toLowerCase() && a.on === b.on));

const sameRule = (a: PrWatchRule, b: PrWatchRule): boolean => {
  if (a.type !== b.type) return false;
  if (a.type === "check" && b.type === "check") return a.match.toLowerCase() === b.match.toLowerCase() && a.on === b.on;
  if (a.type === "ci-pass" && b.type === "ci-pass") {
    const x = [...(a.ignore ?? [])].sort();
    const y = [...(b.ignore ?? [])].sort();
    return x.length === y.length && x.every((n, i) => n === y[i]);
  }
  return true;
};

export function writesFor(draft: WatchDraft, armed: Armed, before: WatchDraft): WatchWrites {
  const want = rulesOf(draft);
  const has = armed.watches.filter((w) => w.active);
  const add = want.filter((r) => !has.some((w) => sameRule(w.rule, r)));
  /* Removed by KIND, not by the whole rule: the server keys a watch without its
     ignore list ("All CI passed" is one rule per PR, and adding it again
     replaces the list), so removing it before re-adding would lose the rule
     altogether if the second write never landed. */
  const remove = has
    .filter((w) => !want.some((r) => sameKind(w.rule, r)))
    .map((w) => w.id);
  const touched = draft.sameForNew !== before.sameForNew;
  return {
    add,
    remove,
    // The switch reaching INTO the on position writes the rules drawn with it;
    // turning it off leaves the rules on the PR alone and clears the default.
    preset: touched ? { rules: want, auto: draft.sameForNew } : null,
  };
}

/** The body `/prs/notify-watch/add` takes (`AddInput` in prNotifyWatch.ts). */
export function addBody(
  pr: { root: string; repo: string; number: number; title: string }, rule: PrWatchRule,
): { root: string; number: number; title: string; rule: PrWatchRule } {
  return { root: pr.root, number: pr.number, title: pr.title, rule };
}

/** The body `/prs/notify-watch/default` takes: the repo's rules for new PRs. */
export function defaultBody(
  repo: string, rules: readonly PrWatchRule[], auto: boolean,
): { repo: string; rules: PrWatchRule[]; auto: boolean } {
  return { repo, rules: [...rules].slice(0, MAX_RULES_PER_PR), auto };
}

/** What one armed rule says under the switch, in the person's words. A fired
 *  one-shot rule is kept, inactive, so the line can say what happened last. */
export function armedLine(w: PrWatch, now = Date.now()): string {
  const kind = w.rule.type === "ci-pass" ? "Green"
    : w.rule.type === "ci-fail" ? "Fails"
      : w.rule.type === "comment" ? "Comments"
        : `“${w.rule.match}”`;
  if (w.active) return `${kind} · armed${w.rule.type === "ci-pass" && w.rule.ignore?.length ? ` · ${w.rule.ignore.length} skipped` : ""}`;
  const when = w.lastAt ? ` · ${ago(w.lastAt, now)}` : "";
  return `${kind} · ${w.lastText || "fired"}${when}`;
}

const ago = (at: number, now: number): string => {
  const m = Math.max(0, Math.floor((now - at) / 60_000));
  return m < 1 ? "just now" : m < 60 ? `${m}m ago` : m < 1440 ? `${Math.floor(m / 60)}h ago` : `${Math.floor(m / 1440)}d ago`;
};

/** The word the sheet's header uses for the rules neither armed nor editable
 *  here: what "same for new PRs" covers. */
export const SAME_FOR_NEW_SUB =
  "Every pull request you open in this repository starts with the rules above.";

/**
 * The line under one rule's switch (mock 40): what it is doing right now.
 *
 * Off is said as what the rule would NOT do — "failures are not sent" — rather
 * than as "Off", because a switch already says off and the useful half is what
 * the phone will stay quiet about. On says what will reach the phone, and a
 * rule that has already fired says when.
 */
export function liveLine(
  kind: WatchKind, draft: WatchDraft, watches: readonly PrWatch[], now = Date.now(),
  /** The run the green rule would count, when the sheet knows it: "49/49
   *  green, 0 running" is the answer to "what is it waiting for". */
  run?: { passed: number; total: number; running: number },
): string {
  const type = kind === "green" ? "ci-pass" : kind === "fails" ? "ci-fail" : "comment";
  const mine = watches.find((w) => w.rule.type === type);
  if (kind === "green") {
    if (!draft.green) return "Off · the checks are still read";
    const skipped = skipNames(draft.skip).length;
    const skips = skipped ? ` · ${skipped} never block${skipped === 1 ? "s" : ""} it` : "";
    if (run) return `${run.passed}/${run.total} green, ${run.running} running${skips}`;
    return skipped
      ? `Armed · ${skipped} check${skipped === 1 ? "" : "s"} never block it`
      : "Armed · fires once, the next time every check is green";
  }
  if (kind === "fails") {
    if (!draft.fails) return "Off · failures are not sent";
    return mine?.lastAt
      ? `Armed · the last failure was ${ago(mine.lastAt, now)}`
      : "Armed · the next failure reaches this phone";
  }
  if (!draft.comments) return "Off · comments are not sent";
  return "On · the next comment reaches this phone";
}
