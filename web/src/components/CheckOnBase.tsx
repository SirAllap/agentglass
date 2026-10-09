/*
 * "Check on base", in the failing test's card: is this failure this PR's? No CI
 * signal proves it; the one proof is an experiment, so this runs the same command
 * on the base branch's tip and on the PR's head, a few times each, and writes
 * down what happened. It states counts, never a verdict.
 *
 * It never runs by itself: the command comes from a CI log and runs repository
 * code on this machine, so the person reads it, edits it if they want, and
 * presses Run. The box says which two commits, how many runs, and whether a
 * sandbox holds the command. What it changes in their git is nothing: the server
 * exports both trees read-only to a temp folder and deletes it (see
 * server/src/checkOnBase.ts). The decisions are in shared/checkOnBase.ts.
 */
import { useEffect, useRef, useState } from "react";
import { usePoll } from "../lib/usePoll.ts";
import type { CiFailure } from "../../../shared/types.ts";
import { CHECK_COMMAND_MAX, commandProblem, planBlock, suggestCommand, type CheckOnBasePlan, type CheckOnBaseResult } from "../../../shared/checkOnBase.ts";
import { api } from "../lib/api.ts";
import { Button, EDGE, LINE } from "./workspace/Chrome.tsx";
import { CODE_FONT_STYLE } from "./diff/DiffLines.tsx";

type Phase =
  | { at: "idle" }
  | { at: "planning" }
  | { at: "confirm"; plan: CheckOnBasePlan }
  | { at: "running"; id: string; done: number; total: number }
  | { at: "done"; result: CheckOnBaseResult }
  | { at: "error"; error: string };

/** A run in progress outlives the card being closed: the server keeps running, and reopening picks it up. */
const running = new Map<string, string>();

const rememberKey = (root: string) => `agx.checkOnBase.command:${root}`;
function remembered(root: string): string | null {
  try { return localStorage.getItem(rememberKey(root)); } catch { return null; }
}
function remember(root: string, command: string): void {
  try { localStorage.setItem(rememberKey(root), command); } catch { /* private window: it just is not remembered */ }
}

const POLL_MS = 1500;
const short = (sha: string) => sha.slice(0, 7);


export function CheckOnBase({ root, pr, failure }: { root: string; pr: number; failure: CiFailure }) {
  const key = `${root}#${pr}#${failure.signature}`;
  const [phase, setPhase] = useState<Phase>(() => {
    const id = running.get(key);
    return id ? { at: "running", id, done: 0, total: 0 } : { at: "idle" };
  });
  const [command, setCommand] = useState("");
  /** The person's own say-so to run with no sandbox: unticked every time the box opens. */
  const [noBox, setNoBox] = useState(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  const id = phase.at === "running" ? phase.id : null;
  // Only while the window is looked at; the run goes on server-side either way.
  usePoll(!!id, () => {
    if (!id) return;
    void api.prCheckOnBaseStatus(id).then((s) => {
      if (!alive.current) return;
      if (!s.ok) { running.delete(key); setPhase({ at: "error", error: s.error }); }
      else if (s.state === "done") { running.delete(key); setPhase({ at: "done", result: s.result }); }
      else setPhase((p) => (p.at === "running" && p.done === s.done && p.total === s.total ? p : { at: "running", id, done: s.done, total: s.total }));
    }, () => { /* the next tick asks again */ });
  }, POLL_MS);

  const open = async () => {
    setPhase({ at: "planning" });
    try {
      const plan = await api.prCheckOnBasePlan(root, pr);
      if (!alive.current) return;
      if (!plan.ok) { setPhase({ at: "error", error: plan.error }); return; }
      // This failure's own command if it names one, else what this repository ran last time.
      setCommand(suggestCommand(failure) || remembered(root) || "");
      setNoBox(false);
      setPhase({ at: "confirm", plan });
    } catch { if (alive.current) setPhase({ at: "error", error: "Could not reach the server" }); }
  };

  const run = async (plan: CheckOnBasePlan) => {
    remember(root, command);
    setPhase({ at: "planning" });
    try {
      const r = await api.prCheckOnBaseStart(root, pr, command, plan, noBox);
      if (!alive.current) return;
      if (!r.ok) { setPhase({ at: "error", error: r.error }); return; }
      running.set(key, r.id);
      setPhase({ at: "running", id: r.id, done: 0, total: 0 });
    } catch { if (alive.current) setPhase({ at: "error", error: "Could not reach the server" }); }
  };

  const stop = () => { if (id) void api.prCheckOnBaseCancel(id); };
  const reset = () => setPhase({ at: "idle" });

  if (phase.at === "idle") {
    return (
      <div className="flex items-center gap-2 px-2.5 py-1.5" style={{ borderTop: LINE }}>
        <Button size="compact" onClick={() => void open()} title="Run this test on the base branch and on this PR's head, and count what happens">Check on base</Button>
        <span className="text-[10px]" style={{ color: "var(--text3)" }}>Runs the test on both commits. Nothing in your git changes.</span>
      </div>
    );
  }
  const box = (children: React.ReactNode) => <div className="px-2.5 py-2 flex flex-col gap-1.5 text-[10.5px]" style={{ borderTop: LINE, color: "var(--text2)" }}>{children}</div>;
  if (phase.at === "planning") return box(<span role="status">Looking up the two commits…</span>);
  if (phase.at === "error") {
    return box(<>
      <span style={{ color: "var(--warning-ink)" }}>Could not check: {phase.error}.</span>
      <div><Button size="compact" onClick={reset}>Close</Button></div>
    </>);
  }
  if (phase.at === "running") {
    return box(<>
      <span role="status">{phase.total ? `Running ${phase.done} of ${phase.total}…` : "Starting…"}</span>
      <div><Button size="compact" onClick={stop}>Stop</Button></div>
    </>);
  }
  if (phase.at === "done") {
    const r = phase.result;
    return box(<>
      <span className="font-semibold" style={{ color: "var(--text)" }}>{r.facts[0]!.toUpperCase() + r.facts.slice(1)}</span>
      <span style={{ color: "var(--text3)" }}>
        Base {r.base.ref} {short(r.base.sha)} · PR head {short(r.head.sha)} · {r.base.tally.runs} runs each{r.cancelled ? " · stopped early" : ""}{r.sandbox === "bwrap" ? " · no network" : " · no sandbox on this machine"}
      </span>
      <div className="flex items-center gap-2"><Button size="compact" onClick={() => void open()}>Run again</Button><Button size="compact" onClick={reset}>Close</Button></div>
    </>);
  }
  const { plan } = phase;
  const blocked = planBlock(plan);
  const problem = commandProblem(command);
  const needsSay = plan.sandbox === "none" && !noBox;
  return box(<>
    <span style={{ color: "var(--text)" }}>Run this on both commits, {plan.runs} times each (at most {plan.timeoutS} s per run):</span>
    <textarea value={command} onChange={(e) => setCommand(e.target.value)} rows={2} spellCheck={false} maxLength={CHECK_COMMAND_MAX} aria-label="Command to run"
      className="w-full text-[10.5px] px-2 py-1.5 rounded-lg resize-y agx-scroll"
      style={{ ...CODE_FONT_STYLE, border: EDGE, background: "var(--surface-inset)", color: "var(--text)" }} />
    <span style={{ color: "var(--text3)" }}>
      Base: {plan.base.ref} at {short(plan.base.sha)} · Head: the PR's head commit {short(plan.head.sha)}. Only tracked files are exported, so a test that needs an install will say it could not run.
    </span>
    <span style={{ color: plan.sandbox === "bwrap" ? "var(--text3)" : "var(--warning-ink)" }}>
      {plan.sandbox === "bwrap" ? "It runs in a box with no network, and sees only the exported folder." : "No sandbox is available on this machine: the command runs with your user's rights, with no tokens in its environment."}
    </span>
    {plan.sandbox === "none" && (
      <label className="flex items-center gap-1.5" style={{ color: "var(--text)" }}>
        <input type="checkbox" checked={noBox} onChange={(e) => setNoBox(e.target.checked)} />
        Run it without a sandbox
      </label>
    )}
    {blocked && <span style={{ color: "var(--warning-ink)" }}>Cannot run: {blocked}.</span>}
    <div className="flex items-center gap-2">
      <Button size="compact" tone="primary" disabled={!!blocked || !!problem || needsSay} title={problem || (needsSay ? "Tick “Run it without a sandbox” first" : undefined)} onClick={() => void run(plan)}>Run</Button>
      <Button size="compact" onClick={reset}>Cancel</Button>
    </div>
  </>);
}
