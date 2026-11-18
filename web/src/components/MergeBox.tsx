// The merge box: who moves next, where the pull request is on its way to merge,
// and what stands in the way — drawn from one decision (shared/mergePath.ts).
//
// This component decides nothing. Every sentence, every count and the order of
// the rows arrive in `path`; what is left here is the layout and which real
// control sits in each slot. The merge button itself (with its method menu, its
// spinner and its behind-the-base confirmation) belongs to the panel and comes
// in as a node, so there is one of it whether it appears in the hero or in the
// footer.
//
// Laid out to the approved mockup (merge-box 08, light and dark): a hero with
// the sentence and the two actions, a strip of four stages with the one that
// holds the merge lit, then the list in three columns — what it is, why it
// blocks, who moves it — and a footer that says what "Merge when green" does
// and does not cover. Under 640px of its own width the strip goes 2x2 and the
// "why" drops under the "what", the way the columns of a table do on a phone.
import { type CSSProperties, type ReactNode } from "react";
import { canNudge, jewelFraction } from "../lib/prQuestion.ts";
import { ClockIcon, CrossIcon, DoneIcon } from "../lib/glyphIcons.tsx";
import { WarningIcon } from "../lib/glyphIcons.tsx";
import { GroupIcon } from "./settingsNavIcons.tsx";
import { ICON } from "../lib/iconSize.ts";
import { actionInFooter, heroPlacement, type Hero, type MergePath, type PathAction, type Stage } from "../../../shared/mergePath.ts";
import { Button, CTRL_H, EDGE } from "./workspace/Chrome.tsx";
import { wash } from "../lib/reviewBar.ts";
import type { OverviewRow, Tone, Verdict } from "../lib/prOverviewView.ts";

export const MERGEBOX_CSS = `
.agx-mb{container:agx-mb / inline-size}
.agx-mb-spin{transform-origin:50% 50%;animation:agx-spin 1.1s linear infinite}
@media (prefers-reduced-motion: reduce){.agx-mb-spin{animation:agx-breathe 1.6s ease-in-out infinite}}
`;

/** Tint and ink for each way a thing can be going. */
const TONE = {
  you: { tint: "var(--error)", ink: "var(--error-ink)" },
  wait: { tint: "var(--warning)", ink: "var(--warning-ink)" },
  ok: { tint: "var(--success)", ink: "var(--success-ink)" },
  idle: { tint: "var(--text3)", ink: "var(--text3)" },
} as const;

/** The banner and the rows speak in three tones; the table below keeps the path's own four. */
const TONE_OF: Record<Tone, { tint: string; ink: string }> = { ok: TONE.ok, warn: TONE.wait, bad: TONE.you };

function Bubble({ n, tone, filled, done }: { n: number; tone: { tint: string; ink: string }; filled: boolean; done?: boolean }) {
  return (
    <span aria-hidden className="shrink-0 grid place-items-center rounded-full text-[10.5px] font-semibold tabular-nums"
      style={{
        width: 22, height: 22,
        background: filled ? tone.tint : "transparent", color: filled ? "var(--bg)" : tone.ink,
        border: filled ? "none" : `1.5px solid ${tone.tint}`,
      }}>
      {done ? <DoneIcon size={ICON.xs} /> : n}
    </span>
  );
}

/** Mockup 05's jewel: the merge icon in a ring, the arc being how many of the four stages are done. */
export function Jewel({ fraction, tone, ok, size = 44 }: { fraction: number; tone: { tint: string; ink: string }; ok: boolean; size?: number }) {
  const r = 19, c = 2 * Math.PI * r;
  return (
    <span aria-hidden data-testid="pr-jewel" className="shrink-0 relative grid place-items-center" style={{ width: size, height: size, color: tone.ink }}>
      <svg width={size} height={size} viewBox="0 0 44 44" className="absolute inset-0">
        <circle cx="22" cy="22" r={r} fill="none" stroke={wash(tone.tint, 22)} strokeWidth="3" />
        <circle cx="22" cy="22" r={r} fill="none" stroke={tone.tint} strokeWidth="3" strokeLinecap="round" strokeDasharray={`${Math.max(fraction, ok ? 1 : 0.04) * c} ${c}`} transform="rotate(-90 22 22)" />
      </svg>
      {ok ? <DoneIcon size={size < 30 ? ICON.xs : ICON.sm} /> : <WarningIcon size={size < 30 ? ICON.xs : ICON.sm} />}
    </span>
  );
}

/** The four stages as a line: the one that holds the merge is ringed, the finished ones are green and joined. */
function Stepper({ stages }: { stages: Stage[] }) {
  return (
    <ol data-testid="pr-stepper" className="grid m-0 p-0 list-none gap-0" style={{ gridTemplateColumns: `repeat(${stages.length}, minmax(0,1fr))` }}>
      {stages.map((s, i) => {
        const tone = s.status === "done" ? TONE.ok : s.status === "blocked" ? TONE.you : s.status === "wait" ? TONE.wait : TONE.idle;
        const next = stages[i + 1];
        return (
          <li key={s.key} data-stage={s.key} data-status={s.status} className="relative min-w-0 pr-2">
            {next && <span aria-hidden className="absolute" style={{ left: 26, right: -2, top: 11, height: 2, background: s.status === "done" ? TONE.ok.tint : wash("var(--text)", 12) }} />}
            <span className="relative inline-flex" style={{ boxShadow: s.current ? `0 0 0 3px ${wash(tone.tint, 22)}` : undefined, borderRadius: 999 }}>
              <Bubble n={s.n} tone={tone} filled={s.status === "done"} done={s.status === "done"} />
            </span>
            <div className="text-[11.5px] font-semibold mt-1 truncate" style={{ color: "var(--text)" }}>{s.label}</div>
            <div className="text-[10.5px] truncate" style={{ color: s.status === "blocked" ? tone.ink : "var(--text3)", fontFamily: "var(--font-mono, monospace)" }}>{s.need ?? s.sub}</div>
          </li>
        );
      })}
    </ol>
  );
}

export function MergeBox({
  path, onAction, busy, noticeNode, notes, actionDisabled, pendingAction, verdict, summary, onGo, onRerun, rerunDisabled, onNudge, now, rerunText, optionalFailed, onRerunOptional,
}: {
  path: MergePath;
  /** `from` is the box of the button pressed, for an action that opens something beside it. */
  onAction: (a: PathAction, from?: DOMRect) => void;
  busy: boolean;
  /** A notice about the branch action (the dock holds the button): full width, under the list. */
  noticeNode?: ReactNode;
  /** Things only the panel knows about this branch (a confirmation, the files that conflict), as rows under the list. */
  notes?: ReactNode;
  /** Actions that cannot be taken right now, with the reason. */
  actionDisabled?: Partial<Record<PathAction["id"], string>>;
  pendingAction?: PathAction["id"];
  /** The banner's sentence and the four rows under it (lib/prOverviewView.ts). */
  verdict: Verdict;
  summary: OverviewRow[];
  /** See checks / Open conversation. */
  onGo: (to: "checks" | "conversation") => void;
  /** Run the failed checks again, from the Checks row; absent when the hero already offers it. */
  onRerun?: () => void;
  rerunDisabled?: string;
  /** Chase the reviewers; drawn on a row that waits on a person. */
  onNudge?: () => void;
  /** The NOW line: the run as a bar, with the usual duration (lib/prQuestion.ts nowBar). */
  /** The hero rerun button's words, with the count (lib/prQuestion.ts rerunLabel). */
  rerunText?: string;
  /** Optional or other-CI checks that failed, and the Re-run for them (the old table's rows). */
  optionalFailed?: number;
  onRerunOptional?: () => void;
  now?: { green: number; running: number; failed: number; total: number; usual: string | null } | null;
}) {
  const { hero, stages, rows, callout } = path;
  const tone = TONE_OF[verdict.tone];
  const heroTop = heroPlacement(hero).top;

  const action = (a: PathAction, primary: boolean): ReactNode => {
    if (actionInFooter(a.id)) return null; // branch moves live in the footer, in every state (see heroPlacement)
    if (a.id === "history") return null; // the history is its own box under the description
    return (
      <Button key={a.id} size="regular" tone={primary ? "primary" : "plain"}
        disabled={busy || !!actionDisabled?.[a.id]} title={actionDisabled?.[a.id]} pending={pendingAction === a.id}
        style={primary ? { background: "var(--text)", color: "var(--bg)", borderColor: "var(--text)" } : undefined}
        onClick={(e) => onAction(a, e.currentTarget.getBoundingClientRect())}>
        {a.id === "rerun" && rerunText ? rerunText : a.label}
      </Button>
    );
  };

  const stepperMoves: ReactNode[] = [];
  for (const r of rows) {
    if (r.link) stepperMoves.push(
      <Button key={`${r.id}-log`} tone="quiet" size="compact" onClick={() => onAction({ id: "open-log", label: r.link!.label, url: r.link!.url })}
        className="underline underline-offset-2" style={{ color: "var(--text)" }}>{r.link.label}</Button>);
    if (r.action) stepperMoves.push(action(r.action, false));
    if (canNudge(r) && r.person && onNudge) stepperMoves.push(
      <Button key={`${r.id}-nudge`} size="compact" data-testid="row-nudge" disabled={busy} title="Write the reminder and copy it" onClick={onNudge}>Nudge {r.person.login}</Button>);
  }

  const rowTone = (t: Tone) => TONE_OF[t];
  return (
    <div className="agx-mb flex flex-col gap-3.5">
      <style>{MERGEBOX_CSS}</style>

      {/* The verdict, in the mockup's one sentence. The path still says who has to move; its buttons (re-run, open the log, ask for a review, unstick) stay here. */}
      <div className="agx-mb-big flex items-center gap-3 px-3.5 py-3 rounded-xl"
        style={{ background: wash(tone.tint, 7), boxShadow: `inset 0 0 0 1px ${wash(tone.tint, 28)}` }}>
        <Jewel fraction={jewelFraction(stages)} tone={tone} ok={verdict.tone === "ok"} />
        <div className="min-w-0 flex-1">
          <h2 className="text-[13px] leading-[1.45] m-0 font-normal" style={{ color: "var(--text)" }}>
            <b className="font-semibold" style={{ color: tone.ink }}>{verdict.lead}</b> {verdict.text}
          </h2>
          {hero.warnings?.map((w) => (
            <p key={w} className="text-[12px] font-semibold leading-snug mt-1.5 flex items-center gap-1.5" style={{ color: TONE.wait.ink }}>
              <span aria-hidden className="shrink-0 flex">{/^only (a bot|bots) /.test(w) ? <GroupIcon name="bot" size={ICON.sm} /> : <WarningIcon size={ICON.sm} />}</span>{w}
            </p>
          ))}
          {verdict.tone !== "ok" && hero.sub && <p className="text-[11.5px] leading-snug mt-1" style={{ color: "var(--text3)" }}>{hero.sub}</p>}
          {(heroTop.some((a) => a.id !== "history") || (verdict.tone !== "ok" && hero.after)) && (
            <div className="flex items-center gap-2 flex-wrap mt-2">
              {heroTop.map((a) => action(a, a === hero.primary))}
              {verdict.tone !== "ok" && hero.after && <span className="text-[10.5px]" style={{ color: "var(--text3)" }}>{hero.after}</span>}
            </div>
          )}
        </div>
      </div>

      <Stepper stages={stages} />

      {!!optionalFailed && optionalFailed > 0 && (
        <div data-testid="pr-optional-failed" className="flex items-center gap-2 flex-wrap text-[11.5px]" style={{ color: "var(--text3)" }}>
          <span>optional · {optionalFailed} failed</span>
          {onRerunOptional && <Button size="compact" disabled={busy || !!rerunDisabled} title={rerunDisabled ?? "Run the failed checks again"} onClick={onRerunOptional}>Re-run</Button>}
        </div>
      )}

      {/* Checks, Review, Conflicts, Branch: one line each, the button that goes to the thing. */}
      <div className="grid gap-1.5" data-overview-rows>
        {summary.map((r) => {
          const t = rowTone(r.tone);
          return (
            <div key={r.key} data-row={r.key} data-tone={r.tone} className="grid items-center gap-2.5 px-3 py-2 rounded-xl text-[12.5px] leading-snug"
              style={{ gridTemplateColumns: "22px minmax(0,1fr) auto", background: wash(t.tint, 6), boxShadow: r.tone === "ok" ? undefined : `inset 0 0 0 1px ${wash(t.tint, 22)}`, color: "var(--text2)" }}>
              <span aria-hidden className="grid place-items-center" style={{ color: t.tint }}>
                {r.tone === "ok" ? <DoneIcon size={ICON.sm} /> : r.key === "checks" && r.tone === "warn" ? <ClockIcon size={ICON.sm} /> : <WarningIcon size={ICON.sm} />}
              </span>
              <div className="min-w-0 break-words"><b className="font-semibold" style={{ color: "var(--text)" }}>{r.label}</b> <span className="text-[11.5px]" style={{ color: "var(--text3)" }}>{r.text}</span></div>
              <span className="flex items-center gap-1.5">
                {r.rerun && onRerun && (
                  <Button size="compact" disabled={busy || !!rerunDisabled} title={rerunDisabled ?? "Run the failed checks again"} onClick={onRerun}>Re-run failed</Button>
                )}
                {r.go && <Button size="compact" onClick={() => onGo(r.go!)}>{r.go === "checks" ? "See checks" : "Open conversation"}</Button>}
              </span>
            </div>
          );
        })}
      </div>

      {/* What the old who-moves-it table could do that the stepper cannot, as one row under it: chase a reviewer, open a failing log, the one move a row offers. */}
      {stepperMoves.length > 0 && (
        <div data-testid="pr-stepper-moves" className="flex items-center gap-2 flex-wrap">
          {stepperMoves.map((m) => m)}
        </div>
      )}

      {now && now.total > 0 && (
        <div data-testid="pr-now" className="flex items-center gap-3 px-3.5 py-2 rounded-xl text-[11.5px]" style={{ background: wash("var(--border)", 12), color: "var(--text2)" }}>
          <span className="text-[9.5px] tracking-[0.12em]" style={{ color: "var(--text3)", fontFamily: "var(--font-mono, monospace)" }}>NOW</span>
          <span aria-hidden className="flex h-1.5 w-28 shrink-0 rounded-full overflow-hidden" style={{ background: wash("var(--text)", 10) }}>
            <span style={{ width: `${(now.green / now.total) * 100}%`, background: TONE.ok.tint }} />
            <span style={{ width: `${(now.failed / now.total) * 100}%`, background: "var(--error-ink)" }} />
          </span>
          <span className="min-w-0 flex-1 truncate" style={{ fontFamily: "var(--font-mono, monospace)" }}>
            {now.green}/{now.total} green{now.running > 0 ? ` · ${now.running} running` : ""}{now.failed > 0 ? ` · ${now.failed} failed` : ""}
          </span>
          {now.usual && <span className="shrink-0 text-[10.5px]" style={{ color: "var(--text3)", fontFamily: "var(--font-mono, monospace)" }}>{now.usual}</span>}
        </div>
      )}

      {notes && <div className="rounded-xl overflow-hidden" style={{ border: EDGE }}>{notes}</div>}

      {/* ONE footer row. It was two: the merge group on one line and the
          secondary actions (update, draft, close) on a second, so the box
          spent a row on buttons that are all "what else can be done". The
          secondary group sits left, the merge group right, and the callout,
          when there is one, above the row on a line of its own; when they do not fit, the groups wrap under each other
          instead of squeezing. */}
      {(callout || noticeNode) && (
        <div className="flex items-center gap-x-3 gap-y-2 flex-wrap px-4 py-3 rounded-xl" style={{ border: EDGE, background: wash("var(--border)", 12) }}>
          {callout && (
            <span className="flex items-center gap-2 min-w-0 basis-full pl-3 text-[11.5px] font-semibold leading-snug"
              style={{ color: "var(--text)", boxShadow: `inset 2px 0 0 ${callout.tone === "warn" ? TONE.wait.tint : TONE.ok.tint}` }}>
              <span aria-hidden className="shrink-0" style={{ color: callout.tone === "warn" ? TONE.wait.ink : TONE.ok.ink }}>
                {callout.tone === "warn" ? <WarningIcon size={ICON.sm} /> : <DoneIcon size={ICON.sm} />}
              </span>
              {callout.text}
            </span>
          )}
          {noticeNode && <div className="basis-full min-w-0 flex flex-col gap-1.5">{noticeNode}</div>}
        </div>
      )}
    </div>
  );
}
