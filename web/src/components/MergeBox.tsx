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
import { useState, type CSSProperties, type ReactNode } from "react";
import { CrossIcon, DoneIcon } from "../lib/glyphIcons.tsx";
import { WarningIcon } from "../lib/glyphIcons.tsx";
import { ICON } from "../lib/iconSize.ts";
import type { Hero, Mover, MergePath, PathAction, PathRow, Stage } from "../../../shared/mergePath.ts";
import { Button, CTRL_H, EDGE, LINE } from "./workspace/Chrome.tsx";

export const MERGEBOX_CSS = `
.agx-mb{container:agx-mb / inline-size}
.agx-mb-stages{display:grid;grid-template-columns:repeat(4,minmax(0,1fr))}
.agx-mb-row{display:grid;grid-template-columns:32px minmax(0,1.05fr) minmax(0,1.35fr) 104px;column-gap:14px;align-items:start}
.agx-mb-row > .agx-mb-who{justify-self:end}
.agx-mb-head > .agx-mb-what{grid-column:1 / 3}
.agx-mb-head > .agx-mb-why{grid-column:3}
.agx-mb-head > .agx-mb-who{grid-column:4}
.agx-mb-spin{transform-origin:50% 50%;animation:agx-spin 1.1s linear infinite}
@media (prefers-reduced-motion: reduce){.agx-mb-spin{animation:agx-breathe 1.6s ease-in-out infinite}}
@container agx-mb (max-width: 640px){
  .agx-mb-stages{grid-template-columns:repeat(2,minmax(0,1fr))}
  .agx-mb-row{grid-template-columns:32px minmax(0,1fr) auto}
  .agx-mb-row > .agx-mb-why{grid-column:2 / -1;grid-row:2}
  .agx-mb-head > .agx-mb-why{display:none}
  .agx-mb-head > .agx-mb-who{grid-column:3}
}
`;

/** Tint and ink for each way a thing can be going. */
const TONE = {
  you: { tint: "var(--error)", ink: "var(--error-ink)" },
  wait: { tint: "var(--warning)", ink: "var(--warning-ink)" },
  ok: { tint: "var(--success)", ink: "var(--success-ink)" },
  idle: { tint: "var(--text3)", ink: "var(--text3)" },
} as const;

const heroTone = (t: Hero["tone"]) => (t === "ready" ? TONE.ok : t === "wait" ? TONE.wait : TONE.you);
const wash = (tint: string, pct: number) => `color-mix(in srgb, ${tint} ${pct}%, transparent)`;

const moverTone = (m: Mover) => (m === "you" || m === "author" || m === "other" ? TONE.you : m === "fyi" ? TONE.idle : TONE.wait);

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

/** A progress ring: dashed when it has not started, an arc as far as it has got,
 *  a turning quarter when there is nothing to measure it against. */
function Ring({ mode, fraction, tint }: { mode: "queued" | "running" | "failed"; fraction?: number; tint: string }) {
  const r = 8.5, c = 2 * Math.PI * r;
  if (mode === "failed") {
    return (
      <span aria-hidden className="shrink-0 grid place-items-center rounded-full"
        style={{ width: 22, height: 22, background: TONE.you.tint, color: "var(--bg)" }}><CrossIcon size={ICON.xs} /></span>
    );
  }
  const track = wash(tint, 22);
  return (
    <svg aria-hidden width={22} height={22} viewBox="0 0 22 22" className="shrink-0">
      {mode === "queued"
        ? <circle cx="11" cy="11" r={r} fill="none" stroke={tint} strokeWidth="2" strokeDasharray="2.2 3.2" strokeLinecap="round" opacity=".75" />
        : (
          <>
            <circle cx="11" cy="11" r={r} fill="none" stroke={track} strokeWidth="2.5" />
            <circle cx="11" cy="11" r={r} fill="none" stroke={tint} strokeWidth="2.5" strokeLinecap="round"
              className={fraction === undefined ? "agx-mb-spin" : undefined}
              strokeDasharray={`${(fraction ?? 0.25) * c} ${c}`}
              transform={fraction === undefined ? undefined : "rotate(-90 11 11)"} />
          </>
        )}
    </svg>
  );
}

function Who({ row }: { row: Pick<PathRow, "mover" | "moverLabel"> }) {
  const m = row.mover;
  const tone = moverTone(m);
  const solid = m === "you";
  const style: CSSProperties = m === "fyi"
    ? { background: wash("var(--text)", 8), color: "var(--text2)" }
    : solid
    ? { background: tone.tint, color: "var(--bg)" }
    : { background: wash(tone.tint, 8), color: tone.ink, boxShadow: `inset 0 0 0 1px ${wash(tone.tint, 60)}` };
  return (
    <span className="agx-mb-who inline-flex items-center rounded-lg px-2 text-[10px] font-semibold tracking-wider whitespace-nowrap"
      style={{ height: CTRL_H.compact, ...style }}>{row.moverLabel}</span>
  );
}

function StageCell({ s, first }: { s: Stage; first: boolean }) {
  const tone = s.status === "done" ? TONE.ok : s.status === "blocked" ? TONE.you : s.status === "wait" ? TONE.wait : TONE.idle;
  const filled = s.status === "done" || (s.status === "blocked" && s.current);
  return (
    <div className="px-4 py-3 min-w-0"
      style={{
        borderLeft: first ? undefined : LINE,
        background: s.current ? wash(tone.tint, 11) : undefined,
        boxShadow: s.current && first ? `inset 3px 0 0 ${tone.tint}` : undefined,
      }}>
      <div className="flex items-center gap-2">
        <Bubble n={s.n} tone={tone} filled={filled} done={s.status === "done"} />
        <span className="text-[11.5px] font-semibold truncate" style={{ color: s.current || s.status !== "idle" ? tone.ink : "var(--text2)" }}>{s.label}</span>
      </div>
      {s.big && <div className="text-[16px] font-semibold mt-1.5 tabular-nums" style={{ color: tone.ink }}>{s.big}</div>}
      <div className={`text-[10.5px] leading-snug ${s.big ? "mt-1" : "mt-1.5"}`} style={{ color: "var(--text3)" }}>{s.sub}</div>
    </div>
  );
}

function Segments({ segs, total }: { segs: { key: string; count: number; label: string }[]; total: number }) {
  const tint: Record<string, string> = {
    passed: "var(--success)", failed: "var(--error)", running: "var(--warning)",
    skipped: "color-mix(in srgb, var(--text) 45%, transparent)", queued: "color-mix(in srgb, var(--text) 16%, transparent)",
  };
  return (
    <>
      <div className="flex h-2 rounded-full overflow-hidden mt-2" style={{ background: wash("var(--text)", 8) }} role="img"
        aria-label={segs.map((s) => s.label).join(", ")}>
        {segs.map((s) => <div key={s.key} style={{ width: `${(s.count / Math.max(1, total)) * 100}%`, background: tint[s.key] }} />)}
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-0.5 mt-1.5 text-[10px]" style={{ color: "var(--text3)" }}>
        {segs.map((s) => (
          <span key={s.key} className="inline-flex items-center gap-1">
            <span aria-hidden className="inline-block rounded-full" style={{ width: 6, height: 6, background: tint[s.key] }} />{s.label}
          </span>
        ))}
      </div>
    </>
  );
}

export function MergeBox({
  path, onAction, busy, mergeNode, conflictNode, autoNode, extraNode, notes, history, actionDisabled, pendingAction, showMergeRow = true,
}: {
  path: MergePath;
  onAction: (a: PathAction) => void;
  busy: boolean;
  /** The panel's real merge button, method menu and all. */
  mergeNode: ReactNode;
  /** The panel's conflict resolver, where the hero's primary is "Resolve conflicts". */
  conflictNode?: ReactNode;
  /** "Merge when green", or "Cancel auto-merge" once it is armed. */
  autoNode: ReactNode;
  /** The quieter row of what else can be done to the branch. */
  extraNode?: ReactNode;
  /** Things only the panel knows about this branch (a confirmation, the files that conflict), as rows under the list. */
  notes?: ReactNode;
  /** The review history, drawn under the hero while the secondary button has it open. */
  history?: ReactNode;
  /** Actions that cannot be taken right now, with the reason. */
  actionDisabled?: Partial<Record<PathAction["id"], string>>;
  pendingAction?: PathAction["id"];
  /** Whether the footer has a merge button or an auto-merge control to draw; false over a conflict, where neither is offered. */
  showMergeRow?: boolean;
}) {
  const [historyOpen, setHistoryOpen] = useState(false);
  const { hero, stages, rows, otherCi, callout, count } = path;
  const tone = heroTone(hero.tone);
  const counted = rows.filter((r) => r.counted);
  const fyiRows = rows.filter((r) => !r.counted);
  // The strip already says "optional · 58 passed"; a row is for checks still to be heard from.
  const showOther = !!otherCi && otherCi.running + otherCi.queued + otherCi.failed > 0;

  const action = (a: PathAction, primary: boolean): ReactNode => {
    if (a.id === "merge") return mergeNode;
    if (a.id === "resolve-conflicts") return conflictNode ?? null;
    const isHistory = a.id === "history";
    return (
      <Button key={a.id} size="regular" tone={primary ? "primary" : "plain"}
        disabled={busy || !!actionDisabled?.[a.id]} title={actionDisabled?.[a.id]} pending={pendingAction === a.id}
        aria-expanded={isHistory ? historyOpen : undefined}
        style={primary ? { background: "var(--text)", color: "var(--bg)", borderColor: "var(--text)" } : undefined}
        onClick={() => (isHistory ? setHistoryOpen((o) => !o) : onAction(a))}>
        {a.label}
      </Button>
    );
  };

  return (
    <section className="agx-mb rounded-xl overflow-hidden" style={{ border: EDGE, background: "var(--surface-card)" }}>
      <style>{MERGEBOX_CSS}</style>

      <div className="px-4 py-3.5" style={{ boxShadow: `inset 3px 0 0 ${tone.tint}`, background: hero.tone === "ready" ? wash(tone.tint, 7) : undefined }}>
        <div className="text-[10px] font-semibold uppercase tracking-[.13em]" style={{ color: tone.ink }}>{hero.eyebrow}</div>
        <h2 className="text-[17px] leading-snug font-semibold mt-1.5" style={{ color: "var(--text)", maxWidth: "62ch" }}>
          {hero.parts.map((p, k) => p.em ? <span key={k} style={{ color: tone.ink }}>{p.text}</span> : <span key={k}>{p.text}</span>)}
        </h2>
        {hero.sub && <p className="text-[11.5px] leading-snug mt-1.5" style={{ color: "var(--text3)" }}>{hero.sub}</p>}
        {(hero.primary || hero.secondary || hero.after) && (
          <div className="flex items-center gap-2 flex-wrap mt-3">
            {hero.primary && action(hero.primary, true)}
            {hero.secondary && action(hero.secondary, false)}
            {hero.after && <span className="text-[10.5px]" style={{ color: "var(--text3)" }}>{hero.after}</span>}
          </div>
        )}
      </div>
      {historyOpen && history}

      <div className="agx-mb-stages" style={{ borderTop: LINE }}>
        {stages.map((s, k) => <StageCell key={s.key} s={s} first={k === 0} />)}
      </div>

      {(counted.length > 0 || fyiRows.length > 0 || showOther) && (
        <div style={{ borderTop: LINE }}>
          <div className="agx-mb-row agx-mb-head px-4 py-2 text-[9.5px] uppercase tracking-[.12em]"
            style={{ background: wash("var(--text)", 5), color: "var(--text3)", borderBottom: LINE }}>
            <span className="agx-mb-what">
              {count > 0 ? `What stands between you and merge · ${count}` : "Nothing stands between you and merge"}
            </span>
            <span className="agx-mb-why">Why it blocks</span>
            <span className="agx-mb-who">Who moves it</span>
          </div>

          {[...counted, ...fyiRows].map((r) => {
            const t = moverTone(r.mover);
            const onPerson = r.mover === "you" || r.mover === "author" || r.mover === "other";
            return (
              <div key={r.id} className="agx-mb-row px-4 py-3" style={{ borderBottom: LINE, background: onPerson && r.counted ? wash(TONE.you.tint, 7) : undefined }}>
                <span className="pt-0.5">
                  {!r.counted ? <span aria-hidden className="grid place-items-center rounded-full" style={{ width: 22, height: 22, color: "var(--text3)" }}><WarningIcon size={ICON.sm} /></span>
                    : r.mover === "ci" || r.mover === "wait" ? <Ring mode={r.ring?.mode ?? "queued"} fraction={r.ring?.fraction} tint={TONE.wait.tint} />
                    : <Bubble n={r.n} tone={t} filled />}
                </span>
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <b className="text-[12.5px] font-semibold break-words" style={{ color: "var(--text)" }}>{r.title}</b>
                    {r.pill && (
                      <span className="rounded-full px-1.5 text-[9.5px] leading-[15px]"
                        style={{ color: TONE.wait.ink, boxShadow: `inset 0 0 0 1px ${wash(TONE.wait.tint, 65)}` }}>{r.pill}</span>
                    )}
                  </div>
                  {r.sub && <div className="text-[10.5px] mt-0.5 break-words" style={{ color: "var(--text3)" }}>{r.sub}</div>}
                  {r.link && (
                    <button type="button" onClick={() => onAction({ id: "open-log", label: r.link!.label, url: r.link!.url })}
                      className="agx-btn text-[10.5px] mt-1.5 underline underline-offset-2" style={{ color: "var(--text)" }}>{r.link.label}</button>
                  )}
                </div>
                <div className="agx-mb-why text-[11px] leading-snug min-w-0" style={{ color: "var(--text2)" }}>{r.why}</div>
                <Who row={r} />
              </div>
            );
          })}

          {otherCi && showOther && (
            <div className="agx-mb-row px-4 py-3" style={{ borderBottom: callout || extraNode ? LINE : undefined }}>
              <span className="pt-0.5"><Ring mode="queued" tint="var(--text3)" /></span>
              <div className="min-w-0">
                <b className="text-[12.5px] font-semibold" style={{ color: "var(--text)" }}>Other CI</b>
                <div className="text-[10.5px] mt-0.5" style={{ color: "var(--text3)" }}>{otherCi.sub}</div>
              </div>
              <div className="agx-mb-why min-w-0 text-[11px] leading-snug" style={{ color: "var(--text2)" }}>
                {otherCi.text}. {otherCi.tail}.
                <Segments segs={otherCi.segments} total={otherCi.total} />
              </div>
              <Who row={{ mover: "fyi", moverLabel: "FYI" }} />
            </div>
          )}
        </div>
      )}

      {notes && <div style={{ borderTop: LINE }}>{notes}</div>}

      {(callout || (!path.ready && showMergeRow)) && (
        <div className="flex items-center gap-3 flex-wrap px-4 py-3" style={{ borderTop: LINE, background: wash("var(--border)", 12) }}>
          {callout && (
            <span className="flex items-center gap-2 min-w-0 flex-1 basis-56 pl-3 text-[11.5px] font-semibold leading-snug"
              style={{ color: "var(--text)", boxShadow: `inset 2px 0 0 ${callout.tone === "warn" ? TONE.wait.tint : TONE.ok.tint}` }}>
              <span aria-hidden className="shrink-0" style={{ color: callout.tone === "warn" ? TONE.wait.ink : TONE.ok.ink }}>
                {callout.tone === "warn" ? <WarningIcon size={ICON.sm} /> : <DoneIcon size={ICON.sm} />}
              </span>
              {callout.text}
            </span>
          )}
          {!path.ready && showMergeRow && <span className="flex items-center gap-1.5 ml-auto flex-wrap">{mergeNode}{hero.primary?.id !== "arm-auto" && autoNode}</span>}
        </div>
      )}

      {extraNode && <div className="flex items-center gap-1.5 flex-wrap px-4 py-2.5" style={{ borderTop: LINE }}>{extraNode}</div>}
    </section>
  );
}
