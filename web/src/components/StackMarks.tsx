// The three marks of a stacked pull request: the spine down a board card's left
// edge, the token in its stand line that names the base, and the three-slot
// control in a pull request's header with the ladder behind it.
//
// All of it is drawn from a `Stack` (lib/prStack.ts) and the words in
// lib/prStackWords.ts; this file decides nothing about which pull requests are
// related, only how that looks. The numbers (16px boxes, a 20px token, a 150px
// control) are the approved mockup's and are written down in docs/design-system.md.
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { ICON, MIN_BOX } from "../lib/iconSize.ts";
import { BlockedIcon, CaretIcon, CircleIcon, CrossIcon, DoneIcon, DraftIcon, MergeIcon, PullRequestIcon, WarningIcon } from "../lib/glyphIcons.tsx";
import type { BaseRef, Box, SpineItem, Stack } from "../lib/prStack.ts";
import { tokenSentence, wordOf, type Facts, type Rung, type Tone } from "../lib/prStackWords.ts";
import { CTRL_H } from "./workspace/Chrome.tsx";

/* ------------------------------------------------------------------ spine */

const BOX = MIN_BOX;
const GAP = 2;

/**
 * The height the spine needs, so a card with a long stack grows to hold it.
 * Boxes are never under 20px: a 6-stack card is 140px tall, which is the
 * second cost of a stack and is accepted (see the mockup's "Costs").
 */
export function spineHeight(items: SpineItem[]): number {
  const h = items.map((it) => (it.t === "box" ? BOX : it.t === "gap" ? 16 : it.boxes.length * BOX + (it.boxes.length - 1) * GAP));
  return h.reduce((a, b) => a + b, 0) + GAP * (h.length - 1) + 10 + 2;
}

function BoxView({ b }: { b: Box }) {
  return (
    <span className="agx-stk-b" data-k={b.kind} aria-hidden="true">
      {b.kind === "merged" ? <DoneIcon size={ICON.xs} /> : b.kind === "closed" ? <CrossIcon size={ICON.xs} /> : b.label}
    </span>
  );
}

/**
 * One box per pull request, the same on every card of the stack: solid is this
 * card, tinted is another one on the board, dashed is one that is not (or a base
 * that was closed), a drawn tick is a merged base, "?" a base branch with no pull
 * request. It sits in the card's left padding. Decorative at 16px — under
 * `MIN_BOX` — so the sentence is its name and the token is the target.
 */
export function Spine({ stack, label }: { stack: Stack; label: string }) {
  return (
    <div className="agx-stk" role="img" aria-label={label} title={label} data-warn={stack.broken ? "1" : undefined}>
      {stack.spine.map((it, i) =>
        it.t === "gap" ? <span key={i} className="agx-stk-gap" aria-hidden="true">+{it.hidden}</span>
        : it.t === "fork" ? <span key={i} className="agx-stk-fork">{it.boxes.map((b, j) => <BoxView key={j} b={b} />)}</span>
        : <BoxView key={i} b={it.box} />)}
    </div>
  );
}

/* ------------------------------------------------------------------ token */

function Glyph({ base, tone, draft }: { base: BaseRef; tone: Tone; draft: boolean }) {
  if (base.kind === "merged") return <MergeIcon size={ICON.xs} />;
  if (base.kind === "closed") return <BlockedIcon size={ICON.xs} />;
  if (base.kind === "missing") return <WarningIcon size={ICON.xs} />;
  if (draft) return <DraftIcon size={ICON.xs} />;
  return tone === "ok" ? <DoneIcon size={ICON.xs} /> : tone === "err" ? <CrossIcon size={ICON.xs} />
    : tone === "warn" ? <CircleIcon size={ICON.xs} /> : <PullRequestIcon size={ICON.xs} />;
}

/**
 * The base, in the slot where the long orange base branch used to be: its
 * number, one word for where it stands and, when it can be opened, a caret.
 * Pressing it opens that pull request in this app. Dashed means the base is not
 * on this board; orange means the stack is broken and the word says how.
 *
 * `pending` draws nothing here — the caller keeps the branch name until the
 * lookup answers, so the stand line never shows a guess.
 */
export function BaseToken({ base, facts, onOpen, onLit }: {
  base: BaseRef; facts?: Facts; onOpen: (n: number) => void;
  /** The base card to outline while the pointer is over this; null when it leaves. */
  onLit?: (n: number | null) => void;
}) {
  if (base.kind === "pending") return null;
  const { word, tone } = wordOf(facts, base);
  const sentence = tokenSentence(base, facts);
  const broken = base.kind === "merged" || base.kind === "closed" || base.kind === "missing";
  const off = base.kind === "closed" || (base.kind === "pr" && !facts?.onBoard);
  const style: CSSProperties = { height: BOX };
  const inner = (
    <>
      <span aria-hidden="true" className="flex shrink-0"><Glyph base={base} tone={tone} draft={base.kind === "pr" && (base.draft || !!facts?.draft)} /></span>
      {base.kind === "missing"
        ? <span className="truncate font-semibold" style={{ minWidth: 0 }}>{base.branch}</span>
        : <b className="tabular-nums">#{base.number}</b>}
      <span className="agx-stk-w">· {word}</span>
      {base.kind !== "missing" && <span aria-hidden="true" className="flex shrink-0" style={{ transform: "rotate(-90deg)", color: "var(--text3)" }}><CaretIcon size={ICON.xs} /></span>}
    </>
  );
  const common = { className: "agx-stk-t", "data-tone": tone, "data-off": off ? "" : undefined, "data-broken": broken ? "" : undefined, title: base.kind === "missing" ? sentence : `${sentence}\nBranch: ${base.branch}`, "aria-label": sentence, style } as const;
  if (base.kind === "missing") return <span {...common} data-plain="">{inner}</span>;
  return (
    <button type="button" {...common}
      onClick={(e) => { e.stopPropagation(); onOpen(base.number); }}
      onMouseEnter={() => onLit?.(base.number)} onMouseLeave={() => onLit?.(null)}
      onFocus={() => onLit?.(base.number)} onBlur={() => onLit?.(null)}>
      {inner}
    </button>
  );
}

/* ---------------------------------------------------------------- control */

export interface Neighbour { number: number; word: string; note?: string }

const STEP = CTRL_H.compact;

function Step({ dir, to, onOpen }: { dir: "prev" | "next"; to: Neighbour | null; onOpen: (n: number) => void }) {
  const label = to
    ? `${dir === "prev" ? "Previous" : "Next"}: #${to.number}, ${to.word}${to.note ? `, ${to.note}` : ""}. Open it`
    : dir === "prev" ? "First in the stack: nothing before it, it targets the trunk" : "Last in the stack: nothing after it";
  return (
    <button type="button" className="agx-stk-ar" disabled={!to} title={label} aria-label={label}
      onClick={() => to && onOpen(to.number)}>
      <span aria-hidden="true" className="flex" style={{ transform: `rotate(${dir === "prev" ? 90 : -90}deg)` }}><CaretIcon size={ICON.xs} /></span>
    </button>
  );
}

/**
 * Previous, identifier, next: three slots that never move, so stepping through a
 * stack leaves the header where it was. A missing neighbour keeps its slot,
 * dimmed. The identifier opens the ladder; Escape or a click outside closes it.
 */
export function StackControl({ stack, prev, next, onOpen, rungs, factsOf }: {
  stack: Stack; prev: Neighbour | null; next: Neighbour | null;
  onOpen: (n: number) => void;
  rungs: (n: number) => Rung | undefined;
  factsOf: (n: number) => Facts | undefined;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", away); document.removeEventListener("keydown", esc); };
  }, [open]);
  const tier = `${stack.position}${stack.letter ?? ""} of ${stack.size}`;
  const bars = Math.min(stack.size, 6);
  const mid = `Stack: pull request ${tier}. Open the ladder`;
  return (
    <span className="relative shrink-0 inline-flex align-middle mr-1.5" ref={box}>
      <span className="agx-stk-c" role="group" aria-label={`Stack, pull request ${tier}`} data-broken={stack.broken ? "" : undefined} style={{ height: STEP + 2 }}>
        <Step dir="prev" to={prev} onOpen={onOpen} />
        <button type="button" className="agx-stk-mid" aria-expanded={open} aria-haspopup="dialog" title={mid} onClick={() => setOpen((v) => !v)}>
          <span className="agx-stk-mini" aria-hidden="true">
            {Array.from({ length: bars }, (_, i) => <i key={i} data-cur={i === Math.min(stack.position - 1, bars - 1) ? "" : undefined} />)}
          </span>
          <span className="tabular-nums">{tier}</span>
          <span aria-hidden="true" className="flex" style={{ color: "var(--text3)" }}><CaretIcon size={ICON.xs} /></span>
        </button>
        <Step dir="next" to={next} onOpen={onOpen} />
      </span>
      {open && (
        <div className="absolute z-50 mt-1.5 rounded-lg overflow-hidden agx-menu agx-stk-lad" style={{ left: 0, top: "100%" }} role="dialog" aria-label="Stack">
          <Ladder stack={stack} rungs={rungs} factsOf={factsOf} onOpen={(n) => { setOpen(false); onOpen(n); }} />
        </div>
      )}
    </span>
  );
}

function Ladder({ stack, rungs, factsOf, onOpen }: {
  stack: Stack; rungs: (n: number) => Rung | undefined; factsOf: (n: number) => Facts | undefined; onOpen: (n: number) => void;
}) {
  const open = stack.tiers.flat().filter((b) => b.kind !== "merged" && b.kind !== "closed" && b.kind !== "missing").length;
  const row = (b: Box, key: string): ReactNode => {
    const r = b.number ? rungs(b.number) : undefined;
    const me = b.kind === "cur";
    const gone = b.kind === "merged" || b.kind === "closed";
    const word = b.number ? wordOf(factsOf(b.number), gone ? { kind: b.kind as "merged" | "closed", number: b.number, branch: "" } : { kind: "pr", number: b.number, branch: "", draft: false }).word : "";
    return (
      <div key={key} className="agx-stk-row" data-me={me ? "" : undefined}>
        <div className="agx-stk-rail"><BoxView b={b} /></div>
        <div className="min-w-0">
          {b.kind === "missing" ? (
            <>
              <div style={{ color: "var(--warning-ink)" }}>Base branch has no pull request</div>
              <div className="truncate" style={{ fontSize: 10, color: "var(--text3)" }}>{stack.base?.branch} · nothing to open</div>
            </>
          ) : (
            <>
              <div className="truncate" style={{ color: gone ? "var(--text3)" : "var(--text)" }}>
                <b className="tabular-nums">#{b.number}</b> {r?.title}
              </div>
              <div className="truncate" style={{ fontSize: 10, color: "var(--text3)" }}>{[r?.line, word].filter(Boolean).join(" · ")}</div>
            </>
          )}
        </div>
        <div className="whitespace-nowrap" style={{ fontSize: 10.5, color: "var(--text2)", fontWeight: me ? 600 : 400 }}>
          {me ? "you are here" : b.number ? (
            <button type="button" className="agx-btn px-1 rounded" style={{ color: "var(--primary-ink)" }} onClick={() => onOpen(b.number!)}
              aria-label={`Open #${b.number}`}>open</button>
          ) : null}
        </div>
      </div>
    );
  };
  return (
    <div>
      <div style={{ fontSize: 9.5, textTransform: "uppercase", letterSpacing: "0.07em", color: "var(--text3)", padding: "2px 4px 6px" }}>
        Stack · {open} pull request{open === 1 ? "" : "s"} · base first
      </div>
      {stack.trunk && (
        <div className="agx-stk-row">
          <div className="agx-stk-rail"><span className="agx-stk-trunk">{stack.trunk}</span></div>
          <div className="min-w-0" style={{ alignSelf: "center", color: "var(--text3)" }}>trunk · where the stack lands</div>
          <div />
        </div>
      )}
      {stack.tiers.map((t, i) => t.map((b, j) => row(b, `${i}.${j}`)))}
      <div style={{ padding: "6px 4px 2px", fontSize: 10, color: "var(--text3)" }}>Esc closes</div>
    </div>
  );
}
