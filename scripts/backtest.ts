#!/usr/bin/env bun
/*
 * Would it have predicted you? Answered from history, this afternoon, offline.
 *
 * The live scorecard needs eighty scored decisions per class before it says
 * anything, and at the rate a person actually commits that is weeks of waiting
 * to find out whether the idea works at all. But the decisions already
 * happened: a git history is a record of hundreds of real ones, dated, in the
 * same categorical shape the live seams record. So replay them.
 *
 * WHAT IT REPLAYS, and why git rather than the transcripts. A commit carries
 * the shape of a decision — how many files, whether it was given a body, what
 * kind of branch it landed on — and those are exactly the fields the live
 * `/git/commit` seam records. The transcripts carry what he SAID about the
 * work, which is a different thing and cannot be scored against a categorical
 * prediction (see the note at the top of understudy-predict.ts).
 *
 * THE HONESTY RULES, which are most of this file:
 *
 *   Expanding window. Every decision is predicted using only the decisions
 *   BEFORE it. The whole exercise is worthless the moment a prediction can see
 *   its own future, and in a replay that leak is one sloppy loop away.
 *
 *   The same baseline as the live panel. "Always answer what you have answered
 *   most often so far", scored on the same rows. A model level with that has
 *   learned that the person has a habit, not who they are.
 *
 *   No writes. This never touches the ledger, the bank or the policy. It reads
 *   git and prints a table; running it twice changes nothing.
 *
 *   Nothing leaves the machine. No network, no model, no key.
 *
 *   git log --no-merges is NOT used for C2: a merge is a decision too, and it
 *   is a different class. Each pass says what it selected.
 *
 * Usage:
 *   bun scripts/backtest.ts                     # this repo
 *   bun scripts/backtest.ts ~/code/other ...    # several
 *   bun scripts/backtest.ts --author "Name"     # restrict to one author
 */
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

/* ── the same vocabulary the live seam uses ─────────────────────────────────
   Copied rather than imported because importing index.ts would boot a server.
   If these drift from index.ts the backtest stops measuring the live feature,
   which is why they sit together here with the reason attached. */
const BRANCH_SHAPES = new Set(["feat", "fix", "chore", "docs", "test", "refactor", "perf", "ci", "build", "style", "revert"]);

function branchShape(name: string): string {
  const s = String(name ?? "");
  if (!s) return "none";
  const slash = s.indexOf("/");
  const head = (slash === -1 ? s : s.slice(0, slash)).toLowerCase();
  if (BRANCH_SHAPES.has(head)) return head;
  return slash === -1 ? "bare" : "other";
}

function countShape(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n === 1) return "1";
  if (n <= 5) return "2-5";
  if (n <= 20) return "6-20";
  return "20+";
}

const canon = (o: Record<string, unknown>): string =>
  `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${JSON.stringify(o[k])}`).join(",")}}`;

/* ── reading history ────────────────────────────────────────────────────── */

interface Decision {
  cls: string;
  subject: string;
  at: number;
  actual: string;
}

/*
 * ── the features, and the one rule that governs them ──────────────────────
 *
 * EVERY FEATURE HAS TO BE KNOWABLE BEFORE THE DECISION. That sounds obvious
 * and is the easiest thing in the world to get wrong here: the number of files
 * in a commit is sitting right there in the row, it correlates beautifully
 * with the answer, and it is part of the answer. A model fed that would score
 * superbly and be worthless, because at the moment of prediction nobody knows
 * it yet.
 *
 * So the features are only things true of the WORLD BEFORE the decision: when
 * it is happening, how long since the last one, and what he did last time.
 * That last one is the interesting one — people work in runs, and "what did he
 * just do" is exactly the signal a global constant throws away.
 */
interface Features {
  /** What he did on the previous decision of this class. */
  prev: string;
  /** How long since it, bucketed. Bursts and fresh starts are different. */
  gap: string;
  /** Roughly when in the day. */
  hour: string;
}

function gapBucket(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "first";
  if (ms < 10 * 60_000) return "burst";
  if (ms < 60 * 60_000) return "same-hour";
  if (ms < 24 * 3_600_000) return "same-day";
  return "later";
}

function hourBucket(at: number): string {
  const h = new Date(at).getHours();
  if (h < 6) return "night";
  if (h < 12) return "morning";
  if (h < 18) return "afternoon";
  return "evening";
}

/**
 * The backoff chain, most specific first.
 *
 * A single key would be either too specific to ever match or too coarse to say
 * anything. Backing off is what lets the same predictor use "he is mid-burst
 * and last time he wrote a body" when it has seen that before, and fall back to
 * "he is mid-burst" when it has not — rather than giving up and returning the
 * global mode for both.
 */
function keys(f: Features): string[] {
  return [
    `p=${f.prev}|g=${f.gap}|h=${f.hour}`,
    `p=${f.prev}|g=${f.gap}`,
    `p=${f.prev}`,
    `g=${f.gap}`,
  ];
}

const git = (repo: string, args: string[]) =>
  spawnSync("git", ["-C", repo, ...args], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });

/**
 * Every commit, as the decision it was.
 *
 * `%x00` separators rather than a character somebody might type: a commit
 * subject containing a tab or a pipe would silently split a row, and the rows
 * that get mangled would be the interesting ones.
 */
function commits(repo: string, author: string | null): Decision[] {
  const fmt = ["%H", "%at", "%s", "%b", "%P"].join("%x00");
  const args = ["log", `--pretty=format:${fmt}%x01`, "--numstat"];
  if (author) args.push(`--author=${author}`);
  const r = git(repo, args);
  if (r.status !== 0) return [];

  const out: Decision[] = [];
  const name = repoName(repo);
  for (const chunk of r.stdout.split("\x01")) {
    if (!chunk.trim()) continue;
    /*
     * Split on the NUL fields FIRST, and only then look for the newline.
     *
     * The commit body is multiline, so the first version sliced the chunk at
     * its first newline and called that the header — which threw away
     * everything from the body onwards, left `parents` undefined, and made a
     * repository of several hundred commits report exactly one decision. The
     * last field is `parents` with the numstat block stuck to it, so it is the
     * only one that needs splitting.
     */
    const parts = chunk.split("\x00");
    if (parts.length < 5) continue;
    const at = parts[1];
    const subject = parts[2];
    const body = parts[3];
    const tail = parts[4] ?? "";
    const nl = tail.indexOf("\n");
    const parents = (nl === -1 ? tail : tail.slice(0, nl)).trim();
    const files = nl === -1 ? 0 : tail.slice(nl).split("\n").filter((l) => /^\d+\t|^-\t/.test(l)).length;
    const isMerge = parents.split(/\s+/).filter(Boolean).length > 1;
    const when = Number(at) * 1000;
    if (!Number.isFinite(when) || !when) continue;

    if (isMerge) {
      // C3: landing something. The branch is in the subject of a merge commit,
      // which is the only place the name survives once the branch is deleted.
      const m = /Merge (?:branch|pull request) '?([^' ]+)'?/i.exec(subject ?? "");
      out.push({
        cls: "C3",
        subject: name,
        at: when,
        actual: canon({ from: branchShape(m?.[1] ?? ""), ok: true }),
      });
      continue;
    }

    // C2: a commit, in the shape the live seam records it.
    out.push({
      cls: "C2",
      subject: name,
      at: when,
      actual: canon({
        staged: false,
        files: countShape(files),
        titled: !!(subject ?? "").trim(),
        described: !!(body ?? "").trim(),
        ok: true,
      }),
    });
  }
  return out;
}

function repoName(repo: string): string {
  const r = git(repo, ["rev-parse", "--show-toplevel"]);
  const top = r.status === 0 ? r.stdout.trim() : repo;
  return top.split("/").filter(Boolean).pop() ?? "repo";
}

/* ── the replay ─────────────────────────────────────────────────────────── */

interface Score {
  n: number;
  hits: number;
  baseHits: number;
  declined: number;
}

/** Token overlap, the same crude measure the live predictor uses. */
function similar(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const t = (s: string) => new Set(s.toLowerCase().split(/[^a-z0-9]+/i).filter((x) => x.length > 1));
  const A = t(a);
  const B = t(b);
  if (!A.size || !B.size) return 0;
  let hit = 0;
  for (const x of A) if (B.has(x)) hit++;
  return hit / Math.max(A.size, B.size);
}

const MIN_HISTORY = 3;

/**
 * Replay one class, oldest first.
 *
 * The model and the baseline are scored on the SAME rows, including the rows
 * the model declined to guess on. Scoring a model only where it was confident
 * is how a predictor that answers twice and is right both times reports 100%.
 */
function replay(rows: Decision[]): Score {
  const s: Score = { n: 0, hits: 0, baseHits: 0, declined: 0 };

  /** key -> answer -> how often, for every key we have ever formed. */
  const byKey = new Map<string, Map<string, number>>();
  const global = new Map<string, number>();
  let prev = "none";
  let prevAt = 0;

  /** The most common answer under a key, and how much of that key it is. */
  const modeOf = (m: Map<string, number> | undefined): { answer: string; n: number; total: number } => {
    if (!m) return { answer: "", n: 0, total: 0 };
    let answer = "";
    let n = 0;
    let total = 0;
    for (const [k, c] of m) { total += c; if (c > n) { answer = k; n = c; } }
    return { answer, n, total };
  };

  for (const row of rows) {
    const f: Features = {
      prev,
      gap: prevAt ? gapBucket(row.at - prevAt) : "first",
      hour: hourBucket(row.at),
    };

    // ── the baseline: the modal answer among everything before this row.
    const g = modeOf(global);

    // ── the model: the most specific key with enough evidence behind it.
    //    THREE, not one: a key seen twice is an anecdote, and letting an
    //    anecdote outrank a well-supported coarser key is how a contextual
    //    model ends up worse than a constant.
    let guess = "";
    for (const k of keys(f)) {
      const m = modeOf(byKey.get(k));
      if (m.total >= 3 && m.answer) { guess = m.answer; break; }
    }
    if (!guess && g.total >= MIN_HISTORY && g.n / g.total >= 0.5) guess = g.answer;

    s.n += 1;
    if (!guess) s.declined += 1;
    if (guess && guess === row.actual) s.hits += 1;
    if (g.answer && g.answer === row.actual) s.baseHits += 1;

    // ── learn AFTER scoring. The row must never inform its own prediction.
    for (const k of keys(f)) {
      const m = byKey.get(k) ?? new Map<string, number>();
      m.set(row.actual, (m.get(row.actual) ?? 0) + 1);
      byKey.set(k, m);
    }
    global.set(row.actual, (global.get(row.actual) ?? 0) + 1);
    prev = row.actual;
    prevAt = row.at;
  }
  return s;
}

/* ── report ─────────────────────────────────────────────────────────────── */

const LABEL: Record<string, string> = {
  C2: "a local commit, and the message on it",
  C3: "landing on the integration branch",
};

function main() {
  const argv = process.argv.slice(2);
  let author: string | null = null;
  const repos: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--author") { author = argv[++i] ?? null; continue; }
    repos.push(resolve(argv[i]!));
  }
  if (!repos.length) repos.push(resolve(import.meta.dir, ".."));

  const all: Decision[] = [];
  for (const repo of repos) {
    const got = commits(repo, author);
    console.log(`${repoName(repo)}: ${got.length} decisions from history`);
    all.push(...got);
  }
  // Oldest first, ACROSS repos: a person's habits do not restart per checkout,
  // and replaying each repo separately would give the model a fresh amnesia
  // every time — which flatters the baseline and starves the model.
  all.sort((a, b) => a.at - b.at);

  const byClass = new Map<string, Decision[]>();
  for (const d of all) {
    const list = byClass.get(d.cls) ?? [];
    list.push(d);
    byClass.set(d.cls, list);
  }

  console.log("");
  console.log("class  n      model   yours   gap    declined  what");
  console.log("─".repeat(78));
  let verdict = "";
  for (const [cls, rows] of [...byClass.entries()].sort()) {
    const s = replay(rows);
    const model = s.n ? s.hits / s.n : 0;
    const base = s.n ? s.baseHits / s.n : 0;
    const gap = (model - base) * 100;
    console.log(
      `${cls.padEnd(6)} ${String(s.n).padEnd(6)} ` +
      `${(model * 100).toFixed(0).padStart(5)}%  ${(base * 100).toFixed(0).padStart(5)}%  ` +
      `${gap >= 0 ? "+" : ""}${gap.toFixed(0).padStart(4)}   ${String(s.declined).padStart(7)}   ${LABEL[cls] ?? ""}`,
    );
    if (gap >= 10) verdict = verdict || cls;
  }
  console.log("");
  if (verdict) {
    console.log(`${verdict} beats "your usual" by ten points or more. That is the pre-registered pass:`);
    console.log(`there is something here a constant cannot do.`);
  } else {
    console.log(`Nothing beats "your usual" by ten points. On this history the honest reading is`);
    console.log(`that these decisions are habits rather than judgements — the ledger and the policy`);
    console.log(`are still worth having, and the word "clone" is not yet earned.`);
  }
  console.log("");
  console.log(`Read nothing but git. Wrote nothing. ${all.length} decisions replayed oldest-first,`);
  console.log(`each predicted from only what came before it.`);
}

main();
