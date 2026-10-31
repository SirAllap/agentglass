// What the picker says while a plan runs and after, one row per system.
//
// prHandOver.ts decides the steps. Each runs against its own service and the
// outcomes arrive separately, so the result is a function of the plan and the
// outcomes so far: every row's state and sentence, whether the picker closes,
// what Done reads, and exactly which steps a retry sends. The rule that matters
// is the last one. A step that passed is never sent again, because sending a
// review request twice pings the reviewer twice and moving a card twice can
// undo someone's move in between.
//
// Rows are per SYSTEM (GitHub, ClickUp, Jira), steps are per call: a card row
// holding "assign" and "move" is one row that fails when either does, and its
// retry sends only the one that failed.
import type { Plan, Step, StepId } from "./prHandOver.ts";

export type Outcome =
  | { state: "busy" }
  | { state: "ok" }
  /** `status` is the service's HTTP answer when it gave one; `error` is its own sentence when it refused in words (a changed card, a read-only token); neither is "did not answer". */
  | { state: "fail"; status?: number; error?: string };

/** A step with no outcome yet has not started. */
export type Outcomes = Partial<Record<StepId, Outcome>>;

export type RowState = "pending" | "busy" | "ok" | "fail";

export interface ResultRow {
  system: Step["system"];
  /** `GitHub`, `ClickUp`, `Jira`. */
  label: string;
  state: RowState;
  /** The small line under the label. */
  text: string;
  /** The steps of this row a retry sends: the failed ones only. */
  retry: StepId[];
  /** `Retry only GitHub`; set on a failed row. */
  retryLabel: string | null;
}

export type Phase = "idle" | "working" | "done" | "partial" | "failed";

export interface ApplyResult {
  phase: Phase;
  rows: ResultRow[];
  /** Every step that failed, to resend; nothing that passed. */
  retry: StepId[];
  /** Done: back to the picker when idle; "Working…" and off while running and while anything is left to retry. */
  done: { label: string; disabled: boolean };
  /** The list of people is read-only while a request is in flight or a failure is open. */
  locked: boolean;
  /** Close the picker after this many ms; null leaves it open. */
  closeAfterMs: number | null;
  /** Said in the toast when everything went through. */
  toast: string | null;
}

export const CLOSE_AFTER_MS = 500;

const sentence = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function rowOf(system: Step["system"], steps: Step[], out: Outcomes): ResultRow {
  const label = steps[0].label;
  const states = steps.map((s) => out[s.id]?.state);
  const state: RowState = states.some((s) => s === "busy") ? "busy"
    : states.some((s) => s === "fail") ? "fail"
      : states.every((s) => s === "ok") ? "ok"
        : states.every((s) => s === undefined) ? "pending" : "busy";
  const failed = steps.filter((s) => out[s.id]?.state === "fail");
  const passed = steps.filter((s) => out[s.id]?.state === "ok");
  const plan = sentence(steps.map((s) => s.text.replace(/ on (GitHub|ClickUp|Jira)$/, "")).join(" · "));
  let text = plan;
  if (state === "fail") {
    const first = failed.map((s) => out[s.id]).find((o) => o?.state === "fail") as { status?: number; error?: string } | undefined;
    const said = first?.status ? `${label} answered ${first.status}.`
      : first?.error ? `${label} said: ${first.error.replace(/\.$/, "")}.`
        : `${label} did not answer.`;
    if (system === "github") text = said;
    else text = `${said} ${passed.length ? `Already done: ${passed.map((s) => s.text).join(", ")}.` : "Nothing was changed on the card."}`;
  }
  return {
    system, label, state, text,
    retry: failed.map((s) => s.id),
    retryLabel: state === "fail" ? `Retry only ${label}` : null,
  };
}

export function applyResult(plan: Pick<Plan, "steps" | "summary" | "done">, out: Outcomes): ApplyResult {
  const bySystem = new Map<Step["system"], Step[]>();
  for (const s of plan.steps) bySystem.set(s.system, [...(bySystem.get(s.system) ?? []), s]);
  const rows = [...bySystem].map(([sys, steps]) => rowOf(sys, steps, out));
  const retry = rows.flatMap((r) => r.retry);
  const started = plan.steps.some((s) => out[s.id]);
  const allOk = rows.length > 0 && rows.every((r) => r.state === "ok");
  const anyBusy = rows.some((r) => r.state === "busy" || r.state === "pending");
  const anyFail = rows.some((r) => r.state === "fail");

  const phase: Phase = !started ? "idle" : allOk ? "done" : anyBusy ? "working"
    : anyFail ? (rows.some((r) => r.state === "ok") ? "partial" : "failed") : "working";

  return {
    phase,
    rows: started ? rows : [],
    retry,
    /* Partial failure keeps Done as "Working…", off: the way forward is a row's
       own retry, and a Done that re-sent the whole plan would repeat the step
       that passed. */
    done: phase === "idle" ? plan.done : { label: "Working…", disabled: true },
    locked: phase !== "idle",
    closeAfterMs: phase === "done" ? CLOSE_AFTER_MS : null,
    toast: phase === "done" ? plan.summary : null,
  };
}

/** Mark steps as started: a retry sets only the failed ones busy and leaves the passed ones untouched. */
export function startSteps(out: Outcomes, ids: readonly StepId[]): Outcomes {
  const next: Outcomes = { ...out };
  for (const id of ids) next[id] = { state: "busy" };
  return next;
}
