/*
 * "What would he do here?" — the question the bank exists to answer.
 *
 * WHY THIS FILE HAD TO BE WRITTEN. For the whole of this feature's life the
 * ingested bank was write-only: 8,940 precedents and 1,203 rules read off a
 * person's machine, compiled, counted on a panel — and `retrieve()` had no
 * callers at all. Everything the understudy learned about somebody sat in a
 * table nothing queried. The scorecard was measuring a frequency model over the
 * ledger, which knows the last few decisions taken inside the app and nothing
 * whatsoever about the person.
 *
 * WHY IT IS NOT WIRED INTO THE PREDICTOR INSTEAD, which was the obvious idea
 * and is the wrong one. The predictor guesses a categorical shape —
 * `{"base":"main","pattern":"feat/"}` — and the bank holds sentences. There is
 * no honest way to score "go on, merge it" against that shape; it would report
 * `differ` on every row and call the noise a measurement. The two corpora
 * answer different questions, so this answers the other one.
 *
 * WHAT IT WILL NOT DO. It does not generate, paraphrase or summarise. Every
 * line it returns is something the person actually wrote, with a note of what
 * kind of place it came from. An understudy that invents a plausible opinion
 * and attributes it to you is worse than one that says nothing, because you
 * cannot tell the two apart from the outside.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { classOf, classify, retrieve, type Precedent } from "./understudy.ts";
import { policyDir } from "./understudy-ingest.ts";

export interface AskRule {
  id: string;
  cls: string;
  text: string;
  src: string;
  backed: number;
}

export interface AskResult {
  cls: string;
  label: string;
  partition: string;
  /** What you have written down that applies here. */
  rules: AskRule[];
  /** Conclusions you recorded: notes, memory, worklog, skills. */
  decided: Precedent[];
  /** Things you said at the time, out of transcripts. A different kind of evidence. */
  said: Precedent[];
  /** How much of an answer this is, in words rather than a number. */
  says: string;
  /** True when there is so little here that acting on it would be guessing. */
  thin: boolean;
}

/**
 * Which of the thirteen a free-text question is about.
 *
 * The core's table, not a copy of it — see `CLASS_WORDS` there for why. A
 * question routed by one rule and answered from rows filed by another opens
 * the wrong drawer with full confidence.
 */
export const classifyQuestion = classify;

/** The compiled rules, or none if nothing has been compiled yet. */
export function compiledRules(): AskRule[] {
  try {
    const raw = readFileSync(join(policyDir(), "rules.json"), "utf8");
    const o = JSON.parse(raw) as { rules?: AskRule[] };
    return Array.isArray(o.rules) ? o.rules : [];
  } catch {
    // Nothing compiled yet, which is a normal state and not an error: the
    // answer is simply that it has not read anything.
    return [];
  }
}

/*
 * How many of the question's own words a rule uses.
 *
 * Lexical, and it has a known blind spot worth stating rather than discovering:
 * this person writes in two languages, so a question asked in English does not
 * reach a rule they wrote in Spanish. "when do I delete a worktree" misses
 * "borrar mis worktrees al mergear" entirely — same rule, no shared word.
 *
 * The honest fix is embeddings, which means a model, which means the network
 * decision that has not been taken. Until then this is a word matcher and says
 * so, which is better than a word matcher that behaves as though it understood.
 */
function overlap(rule: string, terms: string[]): number {
  if (!terms.length) return 0;
  const hay = rule.toLowerCase();
  let n = 0;
  for (const t of terms) if (hay.includes(t)) n++;
  return n;
}

const STOP = new Set([
  "the", "and", "for", "that", "this", "with", "what", "would", "should", "when", "have", "does",
  "que", "para", "por", "con", "los", "las", "una", "del", "como", "hacer", "esto", "esta",
]);

function termsOf(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9áéíóúñü\s/_-]+/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP.has(w))
    .slice(0, 12);
}

/**
 * What he has said and done about a situation like this one.
 *
 * The partition is REQUIRED and passed straight through to `retrieve`, which
 * throws rather than defaulting. Everything about this function is a lookup
 * across somebody's private material, so the one argument that decides which
 * material is not something to be inferred from a question.
 */
export function ask(q: { text: string; cls?: string; partition: string; limit?: number }): AskResult {
  const cls = q.cls && classOf(q.cls) ? q.cls : classifyQuestion(q.text);
  const def = classOf(cls);
  const terms = termsOf(q.text);
  const limit = Math.max(1, Math.min(12, q.limit ?? 6));

  /*
   * Precision first, breadth as the fallback.
   *
   * Every term at once finds the rows that are actually about the question; any
   * term finds the rows that merely mention a word from it. Measured against a
   * real bank, the loose query answered "do I squash when I merge" with
   * "Complete the merge" — a phrase that contains the word and none of the
   * meaning. So the narrow query runs first and the loose one only fills in
   * behind it, de-duplicated, so a thin answer is still an answer.
   */
  const wide = limit * 6;
  const tight = retrieve({ cls, partition: q.partition, text: q.text, limit: wide, all: true });
  const pool = [...tight];
  const seen = new Set(pool.map((p) => p.id));
  for (const p of retrieve({ cls, partition: q.partition, text: q.text, limit: wide })) {
    if (!seen.has(p.id)) { seen.add(p.id); pool.push(p); }
  }

  /*
   * Two kinds of evidence, kept apart because they are not the same claim.
   *
   * A line from a note or a memory file is a CONCLUSION: the person worked
   * something out and wrote it down. A turn out of a transcript is what they
   * said in the middle of doing something, and most of them are questions.
   * Measured against a real bank, "do I squash when I merge" came back with
   * "Complete the merge" — a phrase that contains the word and none of the
   * meaning, presented under a heading that said "what you actually did".
   *
   * Mixing them lets the second borrow the authority of the first. Both are
   * worth showing; only one of them is a decision.
   */
  const decided = pool.filter((p) => !isTranscript(p.source)).slice(0, limit);
  const said = pool.filter((p) => isTranscript(p.source)).slice(0, limit);

  /*
   * Rules of this class first, then anything from another class that uses the
   * question's own words. A rule filed under C3 can still be the rule that
   * settles a C1 question — the classifier is thirteen regexes and it is not
   * the arbiter of what is relevant, only of where things were filed.
   */
  const all = compiledRules();
  const scored = all
    .map((r) => ({ r, hits: overlap(r.text, terms) }))
    /*
     * A shared word is the floor, and being in the right class is only a bonus
     * on top of it. The other way round put every rule of the class into every
     * answer of that class: "when do I delete a worktree" came back with a rule
     * about screenshots because both had been filed under C1. Class says where
     * a thing was filed, not whether it bears on the question.
     */
    .filter((x) => x.hits > 0)
    .map((x) => ({ r: x.r, score: x.hits * 2 + (x.r.cls === cls ? 1 : 0) }))
    .sort((a, b) => b.score - a.score || b.r.backed - a.r.backed)
    .slice(0, limit)
    .map((x) => x.r);

  const thin = scored.length === 0 && decided.length === 0 && said.length === 0;
  return {
    cls,
    label: def?.label ?? "something else",
    partition: q.partition,
    rules: scored,
    decided,
    said,
    says: sentence(scored.length, decided.length, said.length, all.length),
    thin,
  };
}

/*
 * The honest sentence, which is the whole point of returning one.
 *
 * A count is easy to read as a score — six precedents looks like a good answer
 * and might be six near-identical lines from one afternoon. What a person needs
 * before leaning on this is whether it is a body of evidence or a coincidence,
 * so it is said in words, and the thin case says so first.
 */
/** A transcript turn is conversation; everything else is something written down. */
function isTranscript(source: string): boolean {
  return source.startsWith("transcripts:");
}

function sentence(rules: number, decided: number, said: number, compiled: number): string {
  const precedents = decided + said;
  /*
   * Order matters here and it got this wrong once: `compiled` was checked
   * first, so an answer carrying real precedents announced "it has not read
   * anything yet" directly above them. What is on screen has to be what the
   * sentence describes.
   */
  if (!compiled && !precedents) return "It has not read anything yet, so it has nothing of yours to go on.";
  if (!compiled) return `${precedents} things you did in cases like this. No rules compiled yet — press "Read them again" in Teach.`;
  if (!rules && !precedents) return "Nothing of yours matches this. It would rather say that than reach.";
  if (!precedents) return `${rules} of your written rules bear on this, but you have no recorded case like it.`;
  if (!rules) return `${precedents} things of yours bear on this, with no rule written down about it.`;
  if (!decided) return `${rules} of your rules, and ${said} times you talked about this — but nothing you wrote down as settled.`;
  return `${rules} of your rules and ${decided} cases you recorded${said ? `, plus ${said} times you talked about it` : ""}.`;
}
