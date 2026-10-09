/*
 * What a board card can say about WHICH test is failing, from failures the app
 * has already read and kept. The board never asks for a log: a card whose
 * failures nobody opened says what it always did.
 */
import type { CheckFailureSummary, PrCheck } from "../../../shared/types.ts";
import { cardOwnership } from "../../../shared/failureVerdict.ts";

export interface FailureHint {
  /** The first failing test, as the log named it. */
  title: string;
  /** Failing tests beyond that one. */
  more: number;
  ownership: ReturnType<typeof cardOwnership>;
}

/** The job a check ran as: its URL ends `…/job/<id>`. */
export const jobIdOf = (c: Pick<PrCheck, "url">): string | null => /\/job\/(\d+)/.exec(c.url ?? "")?.[1] ?? null;

/**
 * The hint for one card, or null when no test is known. The test is named from
 * the first failing job that has one; "not yours" is claimed only when EVERY
 * failing check was read and every test in them is red elsewhere, because one
 * unread check could be this pull request's own.
 */
export function failureHint(failing: PrCheck[], summaryOf: (job: string) => CheckFailureSummary | undefined): FailureHint | null {
  const found: CheckFailureSummary[] = [];
  let unread = 0;
  for (const c of failing) {
    const job = jobIdOf(c);
    const s = job ? summaryOf(job) : undefined;
    if (s && s.titles.length && (s.source === "log" || s.source === "annotations")) found.push(s);
    else unread++;
  }
  if (!found.length) return null;
  const total = found.reduce((n, s) => n + s.count + s.more, 0);
  const verdicts = found.flatMap((s) => s.verdicts);
  return { title: found[0]!.titles[0]!, more: total - 1, ownership: unread ? { notYours: false } : cardOwnership(verdicts) };
}
