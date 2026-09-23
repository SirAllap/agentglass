/** The results file and the markdown table agx-bench prints. */
import {
  TOKEN_ESTIMATOR,
  summarizeArms,
  summarizeTasks,
  summarizeVerbs,
  type ArmSummary,
  type Run,
  type TaskSummary,
  type VerbSummary,
} from "./metrics.ts";

export type Meta = {
  startedAt: string;
  commit: string;
  reps: number;
  arms: string[];
  server: string;
  estimator: string;
  host: string;
  /** 1-minute load average at the start and the end: wall times from a busy
   *  machine are not comparable with a quiet one, and this says which it was. */
  load: [number, number];
};

export type Results = {
  meta: Meta;
  summary: { arms: ArmSummary[]; tasks: TaskSummary[]; verbs: VerbSummary[] };
  runs: Run[];
};

export function buildResults(meta: Omit<Meta, "estimator">, runs: Run[]): Results {
  return {
    meta: { ...meta, estimator: TOKEN_ESTIMATOR },
    summary: { arms: summarizeArms(runs), tasks: summarizeTasks(runs), verbs: summarizeVerbs(runs) },
    runs,
  };
}

const n0 = (x: number) => (Number.isFinite(x) ? String(Math.round(x)) : "—");

function table(head: string[], rows: string[][]): string {
  const line = (cells: string[]) => `| ${cells.join(" | ")} |`;
  return [line(head), line(head.map(() => "---")), ...rows.map(line)].join("\n");
}

/** A compact report: one row per task and arm, one per arm, one per verb. */
export function toMarkdown(r: Results): string {
  const { meta, summary } = r;
  const out = [
    `agx-bench — ${meta.startedAt} — commit ${meta.commit} — ${meta.reps} rep(s), medians — ${meta.estimator} — load ${meta.load.map((l) => l.toFixed(1)).join(" → ")}`,
    "",
    table(
      ["task", "family", "arm", "ok", "wall ms", "steps", "bytes", "tokens"],
      summary.tasks.map((t) => [
        t.task, t.family, t.arm, `${t.successes}/${t.n}`,
        n0(t.medianWallMs), n0(t.medianSteps), n0(t.medianBytes), n0(t.medianTokens),
      ]),
    ),
    "",
    table(
      ["arm", "ok", "wall ms", "steps", "bytes", "tokens", "tokens/success"],
      summary.arms.map((a) => [
        a.arm, `${a.successes}/${a.runs}`, n0(a.wallMs), n0(a.steps), n0(a.bytes), n0(a.tokens), n0(a.tokensPerSuccess),
      ]),
    ),
    "",
    table(
      ["arm", "verb", "calls", "p50 ms", "p95 ms"],
      summary.verbs.map((v) => [v.arm, v.verb, String(v.n), n0(v.p50), n0(v.p95)]),
    ),
  ];
  const failed = r.runs.filter((x) => !x.ok);
  if (failed.length) {
    out.push("", "failures:");
    for (const f of failed) out.push(`- ${f.task} / ${f.arm} / rep ${f.rep}: ${f.error ?? "failed"}`);
  }
  return out.join("\n") + "\n";
}
