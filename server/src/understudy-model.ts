/*
 * Which model runs a task, and how hard it thinks.
 *
 * Every run so far launched `claude -p` with no `--model` at all, so every one
 * of them — a two-line rename and a whole-feature audit alike — went to
 * whatever the default was. On this account that is the most expensive model
 * there is, and the weekly budget is shared with the person whose account it
 * is. A clone that empties it by Wednesday is not standing in for him, it is
 * standing in his way.
 *
 * HIS OWN RULE, in his words: haiku when the work is "pretty much a copy and
 * paste, or text with no thinking needed behind it"; sonnet for the middle;
 * opus "for things where I want it to do a really top-level analysis". And one
 * prohibition that is not about quality at all — Fable is never used here,
 * because it costs the weekly allowance he needs for his own work.
 *
 * THE BUDGET DECIDES TOO, not just the task. Asking for the best model with
 * 8% of the week left is how a Thursday ends with nothing available; asking
 * for the cheapest with 90% left wastes the good hours. Both are failures and
 * the second is the quieter one.
 */

/** What we may run. Fable is deliberately absent — see the note above. */
export type UnderstudyModel = "haiku" | "sonnet" | "opus";

/** Reasoning effort, passed to `--effort`. */
export type UnderstudyEffort = "low" | "medium" | "high";

/** Never launched, whatever anybody asks for. */
export const FORBIDDEN_MODELS = ["fable"] as const;

export interface UsageNow {
  /** Percent of the seven-day allowance still available, 0–100. */
  weekRemaining: number;
  /** Percent of the five-hour window still available, 0–100. */
  hourRemaining: number;
}

export interface Choice {
  model: UnderstudyModel;
  effort: UnderstudyEffort;
  /** One sentence, recorded on the run so a person can argue with it. */
  why: string;
}

/**
 * How much thinking the task itself needs, from its words.
 *
 * Deliberately coarse and deliberately biased low. The cost of sending a
 * mechanical edit to the biggest model is paid every time; the cost of sending
 * a hard task to a smaller one shows up as a failed run somebody can see and
 * re-queue.
 */
function demand(title: string, detail: string): UnderstudyModel {
  /*
   * THE TITLE IS NOT THE TASK. Measured: the only caller passed `detail: ""`,
   * so a whole card was classified from one line of card title while the body
   * — the part that says whether this is a rename or an audit — went to the
   * brief and was withheld from the thing choosing what would read it. His
   * cards are a short title with the substance underneath it.
   *
   * Bounded at 400 characters, the same bound `understudy-work.ts` already
   * puts on `${title} ${detail}` where it matches a card against the bank:
   * enough to say what the work is, short of an essay that mentions
   * everything and therefore classifies as everything.
   */
  const text = `${title} ${detail}`.slice(0, 400).toLowerCase();

  /*
   * MECHANICAL FIRST, and the order is the fix rather than an accident.
   *
   * Run with 90% of the week left, back when the expensive pattern was tested
   * first and returned on a match:
   *
   *   "Fix the typo in the migration guide"      -> opus   (matched `migrat`)
   *   "Rename the security banner copy"          -> opus   (matched `security`)
   *   "Reword the comment about why we analyse"  -> opus   (matched `analys`)
   *
   * Three copy edits at the top tier, out of his allowance. In every one of
   * them the mechanical word is the VERB — what is being done — and the
   * expensive word is the noun it is being done to. A migration guide is a
   * document; renaming the security banner is not security work.
   *
   * What this order gets wrong is the mirror of it: "audit how we format the
   * ledger" reads as mechanical. That is the direction this function already
   * says it accepts — a task sent down a tier fails where somebody can see it
   * and re-queue it, and one sent up a tier is paid for silently, every time.
   */
  if (/\b(rename|typo|spelling|wording|copy|comment|format|reword|move the|delete the|remove the)\b/.test(text)
      && !/\b(refactor|redesign)\b/.test(text)) {
    return "haiku";
  }
  // Words that mean "work it out": the task is a question, not an instruction.
  if (/\b(audit|investigate|decide|design|measure|diagnose|why|analys|architect|trade-?off|security|migrat)/.test(text)) {
    return "opus";
  }
  return "sonnet";
}

const RANK: Record<UnderstudyModel, number> = { haiku: 0, sonnet: 1, opus: 2 };
const BY_RANK: UnderstudyModel[] = ["haiku", "sonnet", "opus"];

/**
 * The model and effort for one run.
 *
 * The task asks for a tier; the remaining allowance can only lower it. That
 * asymmetry is the whole design: a cheap task never gets promoted because the
 * week is young, and an expensive one gets demoted when it is nearly over.
 */
export function chooseModel(p: {
  title: string;
  detail?: string;
  usage?: UsageNow | null;
}): Choice {
  const wanted = demand(p.title, p.detail ?? "");
  const usage = p.usage;
  const week = usage?.weekRemaining;

  // No reading of the budget is not a reason to spend it as if it were full.
  if (week === undefined || week === null || Number.isNaN(week)) {
    const model = RANK[wanted] > RANK.sonnet ? "sonnet" : wanted;
    return { model, effort: model === "opus" ? "high" : "medium",
      why: `the task reads as ${wanted}; no usage reading, so capped at ${model}` };
  }

  /*
   * THE FIVE-HOUR WINDOW, which was measured and then thrown away.
   *
   * `UsageNow` has carried `hourRemaining` from the beginning and `usageNow()`
   * has always filled it in; nothing read it. So a run could start at
   * opus/high with 6% of the window left, die in the middle of the work and
   * record a failure that says nothing about why — and the number that stops
   * work at four in the afternoon is the one he actually watches.
   *
   * Read as full when it cannot be read, which is what `usageNow` already
   * decides when the five-hour figure is missing. The week is the meter that
   * gets the pessimistic reading, because the week is the one that does not
   * come back.
   */
  const hour = typeof usage?.hourRemaining === "number" && !Number.isNaN(usage.hourRemaining)
    ? usage.hourRemaining : 100;

  /*
   * The ceiling by what is left. Thresholds rather than a curve, because a
   * person has to be able to predict this from the number on the top bar.
   *
   * The window has its own, and lower ones: 8% of the week is a Thursday with
   * nothing left in it, 8% of five hours is twenty minutes and then it
   * refills. It binds later than the week and never above it.
   */
  const weekCeiling: UnderstudyModel = week < 15 ? "haiku" : week < 35 ? "sonnet" : "opus";
  const hourCeiling: UnderstudyModel = hour < 10 ? "haiku" : hour < 25 ? "sonnet" : "opus";
  const ceiling = BY_RANK[Math.min(RANK[weekCeiling], RANK[hourCeiling])]!;
  const model = BY_RANK[Math.min(RANK[wanted], RANK[ceiling])]!;

  /*
   * Effort follows the same logic one step further: the last of the week is
   * spent thinking less, not thinking worse. `high` needs room in BOTH meters,
   * because a long think is exactly what does not finish inside the last
   * twenty minutes of a window.
   */
  const effort: UnderstudyEffort =
    week < 15 || hour < 10 ? "low"
      : model === "opus" && week >= 50 && hour >= 50 ? "high"
      : "medium";

  /*
   * Which meter did it. "Capped to sonnet with 90% of the week left" reads as
   * a bug when the week is not what capped it, and a failure nobody can
   * explain is the thing this reading was added to prevent.
   */
  const hourDidIt = RANK[hourCeiling] < RANK[weekCeiling]
    || (model === "opus" && week >= 50 && effort !== "high");
  const window = hourDidIt ? `, and ${Math.round(hour)}% of the five-hour window` : "";

  const why = model === wanted
    ? `the task reads as ${wanted}, and ${Math.round(week)}% of the week is left${window}`
    : `the task reads as ${wanted}, capped to ${model} with ${Math.round(week)}% of the week left${window}`;
  return { model, effort, why };
}
