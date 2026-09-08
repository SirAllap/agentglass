/*
 * WHAT THE SEAT REMEMBERS OF YOU — the precedent bank, asked on the seat's
 * behalf.
 *
 * A fresh model in the chair repeats the mistakes a person has already
 * corrected ten times. The bank the Clone spent months filling is the answer
 * to exactly that: ten thousand recorded decisions and the rules compiled out
 * of them, per project. It was reachable only from a view nobody opened; here
 * it becomes the seat's memory.
 *
 * ASKED, NOT DUMPED. Ten thousand precedents do not go in a prompt. The seat
 * gets the handful that bear on the question it is about to answer — the same
 * `ask()` the Clone's own tab uses, so the two cannot drift into two different
 * ideas of what this person has decided.
 *
 * AND IT SAYS WHEN IT IS THIN. `AskResult.thin` means the bank has so little
 * on this that acting on it would be guessing. That is passed through in as
 * many words instead of being hidden, because an orchestrator quoting a
 * precedent it does not have is worse than one that says it has none: the
 * whole value of this is that a recalled decision is a decision the person
 * actually made.
 */
import { ask, type AskResult } from "./understudy-ask.ts";
import { openProjectName } from "./understudy.ts";

/** How much of the bank reaches one answer. Six is the Clone's own default;
 *  more would crowd the prompt without adding a second opinion. */
const LIMIT = 6;

export interface Recalled {
  question: string;
  /** Rules compiled out of what the person wrote down. */
  rules: string[];
  /** Decisions recorded at the time, newest first. */
  decided: string[];
  /** True when there is too little here to lean on. */
  thin: boolean;
}

const line = (s: string) => s.replace(/\s+/g, " ").trim().slice(0, 220);

/**
 * Ask the bank one question, in the open project's partition.
 *
 * The partition is the Clone's own fence: what was learned working on one
 * repository does not answer for another. `openProjectName()` is that fence,
 * and it is deliberately NOT the seat's root — the two are different axes and
 * conflating them would have the seat for one project quoting another's
 * precedents.
 */
export function recall(question: string): Recalled {
  const q = line(question);
  if (!q) return { question: "", rules: [], decided: [], thin: true };
  let r: AskResult;
  try { r = ask({ text: q, partition: openProjectName(), limit: LIMIT }); }
  catch { return { question: q, rules: [], decided: [], thin: true }; }
  return {
    question: q,
    rules: r.rules.map((x) => line(typeof x === "string" ? x : (x as { text?: string }).text ?? "")).filter(Boolean),
    decided: [...r.decided, ...r.said].slice(0, LIMIT).map((p) => line(`${p.situation} → ${p.decision}`)).filter(Boolean),
    thin: r.thin,
  };
}

/** The recall as the seat reads it: a short block, or an honest nothing. */
export function recallBlock(question: string): string {
  const r = recall(question);
  if (!r.question) return "";
  if (r.thin && !r.rules.length && !r.decided.length) {
    return `Nothing recorded about "${r.question}" — decide it on the facts and say that you had no precedent.`;
  }
  const out: string[] = [`What this person has already decided about "${r.question}":`];
  for (const x of r.rules) out.push(`- rule: ${x}`);
  for (const x of r.decided) out.push(`- before: ${x}`);
  if (r.thin) out.push("(thin — this is a hint, not a ruling. Say so if you lean on it.)");
  return out.join("\n");
}
