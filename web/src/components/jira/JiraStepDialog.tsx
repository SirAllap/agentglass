import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { motion, AnimatePresence, useReducedMotion } from "motion/react";
import { Portal } from "../Portal.tsx";
import { Select } from "../Select.tsx";
import { CardRef, PersonLine, StatusMove } from "../StepCard.tsx";
import { Face } from "../AssignPicker.tsx";
import { EDGE, LINE } from "../workspace/Chrome.tsx";
import { useOwnedQuestion } from "../../lib/layerOwner.ts";
import { CircleIcon, CommentIcon, CrossIcon, DoneIcon, LinkIcon, MinusIcon, RefreshIcon, SwapIcon, UserIcon, WarningIcon } from "../../lib/glyphIcons.tsx";
import { ICON } from "../../lib/iconSize.ts";
import { actionLabel, plainFailure, planRows, settleRows, type Phase, type PlanPerson, type PlanRow, type RowKind, type RowState, type Settled, type StepAnswer } from "../../lib/jiraStepPlan.ts";
import type { StatusOption } from "../../lib/trackerStatus.ts";
import type { JiraStepChoice, JiraStepPr, StepBlock } from "../../../../shared/providers.ts";

/*
 * The confirmation a Jira step asks before it runs, and the account of it after.
 *
 * Before the press it says how the card will move (its status, then the status it
 * goes to, each as its board draws it) and lists EVERYTHING that will happen, one
 * row per block in the order the server runs them, each with the people it names
 * as a face and a name. A row that would change nothing says so. The press does
 * not close it: the same list settles row by row from what the server answered,
 * a partial landing is said as one, and nothing is retried.
 *
 * It is one request, so while it runs every row shows "running" together: the
 * server answers once it is done and the dialog does not pretend to know which
 * block it is on. The settle after the answer is staggered so the eye can follow
 * it, and not at all with reduced motion.
 */

const NOBODY = "\u0000nobody";

/** What the dialog is given to draw and to run; the press that opened it built this from the card and the saved step. */
export interface StepDialogSpec {
  /** The step's name on its button, with no ellipsis: "Hand off", "Move to In Review". */
  verb: string;
  card: { key: string; title: string; status: string; statusColor?: string | undefined; assignee: PlanPerson | null };
  blocks: readonly StepBlock[];
  /** The status the move reaches when the step fixes it; null when the person picks. */
  to: string | null;
  asks: { status: boolean; clear: boolean; assign: boolean; comment: boolean };
  /** The card's own moves when the status is asked. */
  moves: readonly StatusOption[];
  /** The people the card can be given to, when that is asked. */
  people: readonly PlanPerson[];
  /** The comment's words to start the edit from, when it is asked. */
  comment: string;
  pr?: JiraStepPr | undefined;
  /** Is the pull request already a link on the card? Null when it could not be read. */
  linked: boolean | null;
  /** The switch that lets this app change cards. Off, the dialog shows what would happen and cannot run it. */
  writes: boolean;
  /** Sends the step with what the person chose; one request, answered once. */
  run: (choice: JiraStepChoice) => Promise<StepAnswer & { task?: { status?: string } | undefined }>;
}

export type StepDialogResult = (StepAnswer & { task?: { status?: string } | undefined }) | null;
type Pending = StepDialogSpec & { resolve: (r: StepDialogResult) => void };

const ICONS: Record<RowKind, (s: number) => ReactNode> = {
  move: (s) => <SwapIcon size={s} />, unassign: (s) => <MinusIcon size={s} />, assign: (s) => <UserIcon size={s} />,
  comment: (s) => <CommentIcon size={s} />, link: (s) => <LinkIcon size={s} />,
};
const NODE: Record<RowState, { tint: string; glyph: (s: number) => ReactNode; word: string }> = {
  waiting: { tint: "var(--text4)", glyph: (s) => <CircleIcon size={s} />, word: "waiting" },
  running: { tint: "var(--primary)", glyph: (s) => <RefreshIcon size={s} className="agx-step-spin" />, word: "running" },
  done: { tint: "var(--success)", glyph: (s) => <DoneIcon size={s} />, word: "done" },
  failed: { tint: "var(--error)", glyph: (s) => <CrossIcon size={s} />, word: "failed" },
  skipped: { tint: "var(--text3)", glyph: (s) => <MinusIcon size={s} />, word: "skipped" },
};

export const FIELD_KEY = { color: "var(--text3)", fontSize: 10.5, textTransform: "uppercase" as const, letterSpacing: "0.04em" };

function Timeline({ rows, phase, shown, still }: { rows: readonly Settled[]; phase: Phase; shown: number; still: boolean }) {
  return (
    <ol className="relative flex flex-col gap-0" data-step-timeline="" aria-label="What will happen">
      {rows.map(({ row, state, why }, n) => {
        // Rows past the reveal still read "running": the settle goes down the list, not all at once.
        const now: RowState = phase === "finished" && n >= shown ? "running" : state;
        return <TimelineRow key={row.id} row={row} state={now} why={now === state ? why : undefined} last={n === rows.length - 1} idle={phase === "idle"} still={still} />;
      })}
    </ol>
  );
}

function TimelineRow({ row, state, why, last, idle, still }: { row: PlanRow; state: RowState; why?: string | undefined; last: boolean; idle: boolean; still: boolean }) {
  const node = NODE[state];
  const quiet = idle && !!row.noop;
  return (
    <li className="relative flex items-start gap-2.5 pb-3 last:pb-0" data-row={row.id} data-row-state={state} data-noop={row.noop ? "" : undefined}>
      {/* The line the nodes hang on; the last node ends it. */}
      {!last && <span aria-hidden className="absolute" style={{ left: 9, top: 22, bottom: 0, width: 1, background: "var(--surface-line)" }} />}
      <span className="relative shrink-0 inline-flex items-center justify-center rounded-full" title={node.word}
        style={{ width: 20, height: 20, color: node.tint, background: "var(--surface-card)", boxShadow: `inset 0 0 0 1px color-mix(in srgb, ${node.tint} 45%, transparent)`, transition: still ? "none" : "color 160ms ease, box-shadow 160ms ease" }}>
        {node.glyph(ICON.xs)}
      </span>
      <div className="min-w-0 flex-1" style={{ opacity: quiet ? 0.7 : 1 }}>
        <div className="flex items-center gap-1.5 text-[12px] leading-snug" style={{ color: "var(--text)" }}>
          <span aria-hidden className="shrink-0" style={{ color: "var(--text3)" }}>{ICONS[row.kind](ICON.sm)}</span>
          <span className="min-w-0">{row.sentence}</span>
        </div>
        {row.people.length > 0 && (
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px]" style={{ color: "var(--text2)" }}>
            {row.people.map((p) => <PersonLine key={p.key} p={p} size={ICON.lg} strike={row.kind === "unassign" && !row.noop} />)}
          </div>
        )}
        {row.detail && (row.kind === "comment"
          ? <div className="mt-1 text-[11.5px] leading-relaxed whitespace-pre-wrap rounded px-2 py-1.5 overflow-y-auto" data-detail=""
              style={{ color: "var(--text2)", background: "var(--bg)", borderLeft: "2px solid var(--surface-line)", maxHeight: 96, overflowWrap: "anywhere" }}>{row.detail}</div>
          : <div className="mt-0.5 text-[11px]" style={{ color: "var(--text3)" }}>{row.detail}</div>)}
        {row.note && <div className="mt-0.5 text-[10.5px]" style={{ color: "var(--text3)" }}>{row.note}</div>}
        {row.noop && idle && <div className="mt-0.5 text-[11px]" data-says-noop="" style={{ color: "var(--text3)" }}>Nothing happens here: {lower(row.noop)}</div>}
        {state === "skipped" && !idle && <div className="mt-0.5 text-[11px]" style={{ color: "var(--text3)" }}>{why === "not run" ? "Not run" : `Skipped: ${why ?? lower(row.noop ?? "nothing to do")}`}</div>}
        {state === "failed" && <div className="mt-0.5 text-[11px]" style={{ color: "var(--error)" }}>{why ?? "Jira did not accept it"}</div>}
      </div>
    </li>
  );
}

/** "Move to In Review" reads as a title with the card in the middle: "Move ORBIT-1042 to In Review?". */
export const titleOf = (verb: string, key: string): string => {
  const m = /^Move to (.+)$/.exec(verb);
  return m ? `Move ${key} to ${m[1]}?` : `${verb} ${key}?`;
};

const lower = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

/** What the footer says, from where the dialog is. One sentence, always ending in what is true. */
export function footerLine(o: { phase: Phase; writes: boolean; answer: StepAnswer & { task?: { status?: string } | undefined } | null; settled: readonly Settled[]; card: string }): { text: string; tone: "plain" | "warn" | "bad" | "good" } {
  if (o.phase === "idle") return { text: o.writes ? "Nothing in Jira has changed yet." : "Nothing in Jira has changed yet. Changes in Jira are off: turn them on in Settings to run this.", tone: "plain" };
  if (o.phase === "running") return { text: "Writing to Jira…", tone: "plain" };
  const a = o.answer;
  if (!a || !a.ok) return { text: a ? plainFailure(a) : "Jira would not answer. Nothing in Jira was changed.", tone: "bad" };
  const failed = o.settled.filter((s) => s.state === "failed");
  if (failed.length) {
    return {
      text: `Partly done. ${failed.map((s) => `${s.row.sentence} did not go through: ${s.why ?? "Jira did not accept it"}`).join("; ")}. Nothing was retried.`,
      tone: "warn",
    };
  }
  if (o.settled.every((s) => s.state === "skipped")) return { text: "Nothing needed to change.", tone: "plain" };
  const now = a.task?.status;
  return { text: now ? `Done. ${o.card} is now ${now}.` : "Done.", tone: "good" };
}

/** Tab stays inside the dialog, and what had the focus gets it back. */
export function useFocusTrap(on: boolean, root: React.RefObject<HTMLElement | null>) {
  useEffect(() => {
    if (!on) return;
    const before = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Tab" || !root.current) return;
      const f = [...root.current.querySelectorAll<HTMLElement>("button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex='-1'])")].filter((x) => x.offsetParent !== null || x === document.activeElement);
      if (!f.length) return;
      const first = f[0]!, last = f[f.length - 1]!;
      const at = document.activeElement;
      if (e.shiftKey && (at === first || !root.current.contains(at))) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && (at === last || !root.current.contains(at))) { e.preventDefault(); first.focus(); }
    };
    window.addEventListener("keydown", onKey, true);
    return () => { window.removeEventListener("keydown", onKey, true); before?.focus?.(); };
  }, [on, root]);
}

export function StepDialog({ spec, onDone }: { spec: StepDialogSpec; onDone: (r: StepDialogResult) => void }) {
  const reduced = useReducedMotion() === true;
  const first = spec.to ?? spec.moves[0]?.toStatus ?? "";
  const [to, setTo] = useState(first);
  const [clear, setClear] = useState(false);
  const [assign, setAssign] = useState<string | null | undefined>(undefined);
  const [comment, setComment] = useState(spec.comment);
  const [phase, setPhase] = useState<Phase>("idle");
  const [answer, setAnswer] = useState<(StepAnswer & { task?: { status?: string } | undefined }) | null>(null);
  const [shown, setShown] = useState(0);
  const panel = useRef<HTMLDivElement>(null);
  const confirm = useRef<HTMLButtonElement>(null);
  const firstField = useRef<HTMLDivElement>(null);

  const choice: JiraStepChoice = {
    ...(spec.asks.status && to ? { to } : null),
    ...(spec.asks.clear ? { clear } : null),
    ...(spec.asks.assign && assign !== undefined ? { assign } : null),
    ...(spec.asks.comment ? { comment } : null),
  };
  const target = spec.to ?? (spec.asks.status ? (to || null) : null);
  const rows = useMemo(
    () => planRows({ blocks: spec.blocks, card: spec.card, target, choice, pr: spec.pr, linked: spec.linked, people: spec.people }),
    [spec, target, to, clear, assign, comment],
  );
  const settled = settleRows(rows, phase, answer);
  const label = actionLabel(rows);
  const foot = footerLine({ phase, writes: spec.writes, answer, settled, card: spec.card.key });
  const asked = spec.asks.status || spec.asks.clear || spec.asks.assign || spec.asks.comment;
  const finished = phase === "finished";

  // The settle goes down the list, one row at a time; with reduced motion it is all at once.
  useEffect(() => {
    if (phase !== "finished") { setShown(0); return; }
    if (reduced) { setShown(rows.length); return; }
    setShown(0);
    const t = setInterval(() => setShown((n) => { if (n + 1 >= rows.length) clearInterval(t); return n + 1; }), 110);
    return () => clearInterval(t);
  }, [phase, reduced, rows.length]);

  const go = async () => {
    if (phase !== "idle" || !spec.writes || !label) return;
    setPhase("running");
    const r = await spec.run(choice).catch((): StepAnswer => ({ ok: false, error: "Could not reach the server" }));
    setAnswer(r);
    setPhase("finished");
  };
  const close = () => { if (phase !== "running") onDone(finished ? answer : null); };

  useFocusTrap(true, panel);
  useEffect(() => {
    const t = setTimeout(() => { (asked ? firstField.current?.querySelector<HTMLElement>("button, input, textarea") : confirm.current)?.focus(); }, 40);
    return () => clearTimeout(t);
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); }
      else if (e.key === "Enter" && phase === "idle" && !(e.target instanceof HTMLTextAreaElement) && !(e.target instanceof HTMLButtonElement)) { e.preventDefault(); e.stopPropagation(); void go(); }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  const statusOptions = [...new Map(spec.moves.map((m) => [m.toStatus, m])).values()].map((m) => ({ value: m.toStatus, label: m.toStatus, tint: m.color, pill: true, dim: m.toKind === "done" }));
  const person = (p: PlanPerson) => ({ value: p.writeKey ?? p.key, label: p.name, icon: <Face m={p} size={ICON.lg} /> });
  const toColor = spec.moves.find((m) => m.toStatus === target)?.color;
  const dur = reduced ? 0 : 0.16;
  return (
    <>
      <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: dur }}
        className="fixed inset-0 agx-scrim" style={{ zIndex: 10004 }} onClick={close} />
      <div className="fixed inset-0 flex items-center justify-center p-6 pointer-events-none" style={{ zIndex: 10005 }}>
        <motion.div ref={panel} role="dialog" aria-modal="true" aria-label={titleOf(spec.verb, spec.card.key).replace(/\?$/, "")} data-step-dialog=""
          initial={{ opacity: 0, scale: 0.98, y: 6 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.98 }} transition={{ duration: dur }}
          className="pointer-events-auto w-full max-w-[560px] rounded-xl overflow-hidden flex flex-col"
          style={{ background: "var(--surface-card)", border: EDGE, boxShadow: "0 20px 60px rgba(0,0,0,0.5)", maxHeight: "calc(100vh - 48px)" }}>
          <div className="px-4 pt-3.5 pb-3 overflow-y-auto min-h-0">
            <div className="text-[13px] font-medium" style={{ color: "var(--text)" }}>{titleOf(spec.verb, spec.card.key)}</div>
            <div className="mt-3"><CardRef id={spec.card.key} title={spec.card.title} /></div>

            <div className="mt-3 rounded-lg px-3 py-2.5 flex items-center gap-3" style={{ border: EDGE }} data-step-strip="">
              <span style={FIELD_KEY}>Status</span>
              <StatusMove from={spec.card.status || "No status"} fromColor={spec.card.statusColor} to={target ?? undefined} toColor={toColor} />
            </div>

            {asked && (
              <div ref={firstField} className="mt-3 grid items-center gap-y-2" style={{ gridTemplateColumns: "84px 1fr" }} data-asked="">
                {spec.asks.status && <>
                  <div style={FIELD_KEY}>Move to</div>
                  <Select value={to} title="Status" disabled={phase !== "idle"} align="left" onChange={setTo} options={statusOptions} />
                </>}
                {spec.asks.clear && spec.card.assignee && <>
                  <div style={FIELD_KEY}>Take off</div>
                  <label className="flex items-center gap-2 text-[11.5px]" style={{ color: "var(--text2)" }}>
                    <input type="checkbox" checked={clear} disabled={phase !== "idle"} onChange={(e) => setClear(e.target.checked)} />
                    <PersonLine p={spec.card.assignee} size={ICON.lg} />
                  </label>
                </>}
                {spec.asks.assign && <>
                  <div style={FIELD_KEY}>Give it to</div>
                  <Select value={assign === undefined ? "" : assign === null ? NOBODY : assign} title="Assignee" disabled={phase !== "idle"} align="left"
                    onChange={(v) => setAssign(v === "" ? undefined : v === NOBODY ? null : v)}
                    options={[{ value: "", label: "Leave as is", dim: true }, { value: NOBODY, label: "Nobody" }, ...spec.people.map(person)]} />
                </>}
                {spec.asks.comment && <>
                  <div style={{ ...FIELD_KEY, alignSelf: "start", paddingTop: 6 }}>Comment</div>
                  <textarea value={comment} rows={3} disabled={phase !== "idle"} className="w-full px-2 py-1 rounded-md text-[12px]"
                    style={{ background: "var(--bg)", color: "var(--text)", boxShadow: "inset 0 0 0 1px var(--surface-line)" }} onChange={(e) => setComment(e.target.value)} />
                </>}
              </div>
            )}

            <div className="mt-4 mb-2 flex items-center gap-2" style={FIELD_KEY}>
              <span>{phase === "idle" ? "What will happen" : "What happened"}</span>
              <span className="flex-1" style={{ borderTop: LINE }} />
            </div>
            {rows.length > 0 ? <Timeline rows={settled} phase={phase} shown={shown} still={reduced} /> : <div className="text-[11.5px]" style={{ color: "var(--text3)" }}>This step has nothing to do.</div>}
            <div className="sr-only" role="status" aria-live="polite">{finished ? foot.text : ""}</div>
          </div>

          <div className="px-4 pt-2.5 pb-3 flex flex-col gap-2.5" style={{ borderTop: LINE }}>
            <div className="flex items-start gap-1.5 text-[11px] leading-snug" data-step-foot={foot.tone}
              style={{ color: foot.tone === "bad" ? "var(--error)" : foot.tone === "warn" ? "var(--warning-ink)" : foot.tone === "good" ? "var(--success)" : "var(--text3)" }}>
              {(foot.tone === "warn" || foot.tone === "bad") && <WarningIcon size={ICON.sm} className="shrink-0" />}
              <span>{foot.text}</span>
            </div>
            <div className="flex items-center justify-end gap-2">
              {!finished && (
                <button onClick={close} disabled={phase === "running"} className="text-[11px] px-2.5 py-1 rounded disabled:opacity-40 shrink-0" style={{ color: "var(--text2)", border: EDGE }}>Cancel</button>
              )}
              <button ref={confirm} onClick={finished ? close : () => { void go(); }} disabled={!finished && (phase === "running" || !spec.writes || !label)}
                className="text-[11px] px-2.5 py-1 rounded font-medium disabled:opacity-40 min-w-0 text-left leading-snug"
                style={{ color: "var(--on-primary)", background: "var(--primary)" }} title={finished ? undefined : label ?? undefined}>
                {finished ? "Close" : phase === "running" ? "Running…" : label ?? "Nothing to change"}
              </button>
            </div>
          </div>
        </motion.div>
      </div>
    </>
  );
}

/**
 * `const { show, dialog } = useStepDialog()` — render `dialog`, await `show(spec)`. It resolves when the dialog
 * is closed: with the server's answer when the step ran, null when it was cancelled before.
 */
export function useStepDialog() {
  const [pending, setPending] = useState<Pending | null>(null);
  const open = useRef<Pending | null>(null);
  const noteAsker = useOwnedQuestion(pending, () => open.current?.resolve(null));
  const show = (spec: StepDialogSpec): Promise<StepDialogResult> => new Promise((resolve) => {
    open.current?.resolve(null);
    noteAsker();
    const next: Pending = { ...spec, resolve: (r) => { open.current = null; setPending(null); resolve(r); } };
    open.current = next;
    setPending(next);
  });
  const dialog = (
    <AnimatePresence>
      {pending && <Portal><StepDialog key={pending.card.key} spec={pending} onDone={pending.resolve} /></Portal>}
    </AnimatePresence>
  );
  return { show, dialog };
}
