/*
 * One worker on the path: the card the approved mockup's PR-card family draws.
 * It is presentational only — it takes the flow, the role, its place, the marks
 * from `canvasRules.ts` and the live counts (D4's shape, or nothing), and calls
 * back. The words are `workerCardView.ts`'s and the menu rows
 * `workerCardMenu.ts`'s, so neither is decided in JSX.
 *
 * One press configures: Configure, Enter, double-click and the menu's edit rows
 * all open the same editor. The card never edits anything itself.
 */
import { useEffect, useRef, useState } from "react";
import type { Flow, FlowRole } from "../../../../../shared/flow.ts";
import { workerCardModel, workerCardText, type LiveCounts } from "../../../lib/workerCardView.ts";
import { chainTip } from "../../../lib/chainTip.ts";
import { tipAttr } from "../../../lib/tip.ts";
import { menuOpensEditor, workerCardMenu, type WorkerMenuAct } from "../../../lib/workerCardMenu.ts";
import { ICON } from "../../../lib/iconSize.ts";
import type { BlockMark } from "./canvasRules.ts";
import { FlowIcon } from "./flowIcons.tsx";
import { engineName, stageLabel } from "./flowScreenCopy.ts";

/** The engine letter the mockup puts in a route badge: Claude, OpenCode, Codex. */
const engineLetter = (id: string): string =>
  id === "claude" ? "C" : id === "opencode" ? "O" : id === "codex" ? "X" : (engineName(id)[0] ?? "?").toUpperCase();

export function WorkerCard(p: {
  flow: Flow;
  role: FlowRole;
  mark?: BlockMark;
  x: number;
  y: number;
  selected: boolean;
  dragging: boolean;
  /** What the board says this role is doing now; absent before D4 answers. */
  counts?: LiveCounts | null;
  /** Whether the policy stops this role before it runs. */
  ask?: boolean;
  onPointerDown: (e: React.PointerEvent) => void;
  onOpen: () => void;
  onSelect: () => void;
  onArrow: (dir: -1 | 1) => void;
  onConfigure: () => void;
  onAddAfter?: () => void;
  onRemove?: () => void;
}) {
  const { flow, role } = p;
  const m = workerCardModel(flow, role, p.counts, p.mark?.chain);
  const [menu, setMenu] = useState(false);
  const root = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!menu) return;
    const away = (e: PointerEvent) => { if (!root.current?.contains(e.target as Node)) setMenu(false); };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") setMenu(false); };
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", key);
    return () => { document.removeEventListener("pointerdown", away); document.removeEventListener("keydown", key); };
  }, [menu]);

  const rows = workerCardMenu(flow, role);
  const press = (act: WorkerMenuAct) => {
    setMenu(false);
    if (menuOpensEditor(act)) { p.onConfigure(); return; }
    if (act === "after") { p.onAddAfter?.(); return; }
    if (act === "remove") { p.onRemove?.(); return; }
    if (act === "copy") void navigator.clipboard?.writeText(workerCardText(flow, role, p.counts)).catch(() => {});
  };

  const person = role.actor === "person";
  // The mark says which engine a rule moved it off. The route draws the chain in force, so that step is named here, not drawn.
  const rule = p.mark?.because
    ? { name: p.mark.because.replace(/^Because: /, ""), was: (p.mark.was ?? "its usual engine").replace(/^usually /, "") }
    : null;
  const tip = m.chain.length
    ? chainTip({ chain: m.chain, rounds: m.attempts?.of ?? null, ask: !!p.ask, running: m.tone === "run", pass: m.pass, fail: m.fail, rule })
    : null;
  // The strip says what the board read, and only that: a role nobody has read yet says so instead of "Idle".
  const strip = person ? "Asks you" : !m.liveWord ? "Not read yet" : m.liveWord;
  const stripIcon = person ? "hand" : m.tone === "run" ? null : m.tone === "wait" ? "hand" : m.tone === "idle" ? "check" : "clock";
  const step = m.step ?? 1;
  const of = Math.max(1, flow.path.length);
  const ring = circumference(24);
  const shown = Math.min(step, of);
  return (
    <div ref={root} className="fe-blk fe-wk" data-mark={p.mark?.kind} data-focus={p.mark?.focus ? "" : undefined} data-warn={p.mark?.warn ? "" : undefined}
      data-tone={m.tone ?? undefined} data-fe-hit data-fe-block={role.id} role="button" tabIndex={0} aria-pressed={p.selected}
      data-dragging={p.dragging ? "" : undefined} data-gate={person ? "" : undefined} data-readonly={role.readsOnly ? "" : undefined} data-required={m.required ? "" : undefined}
      style={{ left: p.x, top: p.y, "--hue": `var(--${role.hue})` } as React.CSSProperties}
      aria-label={`${role.name}, ${stageLabel(flow, role.stage)}. ${role.does}${m.chain.length ? ` Runs on ${engineName(m.chain[0]!.engine)} ${m.chain[0]!.model}.` : " A person answers."}`}
      onPointerDown={(e) => { if (!(e.target as HTMLElement).closest(".fe-wkmenu, .fe-wk-more")) p.onPointerDown(e); }}
      onDoubleClick={p.onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter") { e.preventDefault(); p.onOpen(); }
        else if (e.key === " ") { e.preventDefault(); p.onSelect(); }
        else if (e.key === "ArrowRight") { e.preventDefault(); p.onArrow(1); }
        else if (e.key === "ArrowLeft") { e.preventDefault(); p.onArrow(-1); }
      }}>
      <div className="fe-wk-h">
        {stripIcon ? <FlowIcon name={stripIcon} size={ICON.xs} /> : <span className="fe-wk-pulse" aria-hidden="true" />}
        <span className="fe-wk-v">{strip}</span>
        {m.attempts && <span className="fe-wk-sk" data-tip="Rounds its failing arrow allows before it asks you"><FlowIcon name="loop" size={ICON.xs} />{m.attempts.word}</span>}
      </div>
      <div className="fe-wk-body">
        <span className="fe-wk-ring" data-tip={m.step ? `Step ${step} of ${of} on the path` : "Not on the path"} aria-hidden="true">
          <svg viewBox="0 0 56 56">
            <circle cx="28" cy="28" r="24" fill="none" stroke="var(--border)" strokeWidth="5" />
            <circle cx="28" cy="28" r="24" fill="none" stroke="var(--hue)" strokeWidth="5" strokeLinecap="butt"
              strokeDasharray={ring} strokeDashoffset={ring * (1 - shown / of)} transform="rotate(-90 28 28)" />
          </svg>
          <span className="fe-wk-n">{shown}<small>of {of}</small></span>
        </span>
        <div className="fe-wk-text">
          <div className="fe-wk-nm">{role.name}<span className="fe-wk-num">#{step}</span></div>
          <div className="fe-wk-stg">{stageLabel(flow, role.stage)}</div>
          <div className="fe-wk-tk">
            {p.mark?.tag || rule
              ? <span className="fe-chip fe-chip-acc" data-tip={p.mark?.because ?? "A rule decides this block"}><FlowIcon name="gauge" size={ICON.xs} />{p.mark?.tag ?? "by a rule"}</span>
              : <span className="fe-chip"><FlowIcon name="check" size={ICON.xs} />as set</span>}
            {m.required && <span className="fe-chip fe-chip-ok" data-tip={m.requiredTip}><FlowIcon name="lock" size={ICON.xs} />{m.requiredWord}</span>}
          </div>
        </div>
      </div>
      <div className="fe-wk-route" data-tip={tip ? tipAttr({ name: tip.title, detail: tip.detail, chain: tip }) : undefined}>
        {person ? (
          <><span className="fe-wk-av fe-wk-av-you" aria-hidden="true"><FlowIcon name="hand" size={ICON.xs} /></span><span className="fe-wk-rl">You · this session</span></>
        ) : m.chain.length ? m.chain.map((c, i) => (
          <span key={`${i}-${c.engine}-${c.model}`} className="fe-wk-avrow">
            {i > 0 && <span className="fe-wk-ar" aria-hidden="true">→</span>}
            <span className="fe-wk-av" data-engine={c.engine} title={`${engineName(c.engine)} · ${c.model}`}>{engineLetter(c.engine)}</span>
            {i === 0 && <span className="fe-wk-rl">{c.model || "its default"}</span>}
          </span>
        )) : <span className="fe-wk-rl">No engine</span>}
      </div>
      <div className="fe-wk-cells">
        <div data-tone={m.tone === "run" ? "run" : undefined} data-tip={p.counts ? "What the board read for this role a moment ago" : "The board has not answered yet"}>
          <small>Last</small><b>{m.liveWord ?? "—"}</b>
        </div>
        <div data-tip={m.failTip}><small>Tries</small><b>{m.attempts ? m.attempts.of : "—"}</b></div>
        <div data-tip={p.counts ? "What this role has cost so far" : "No cost has been read"}><small>Cost</small><b>{m.cost}</b></div>
      </div>
      {rule && (
        <div className="fe-wk-reason" data-tip={p.mark?.because}>
          <FlowIcon name="gauge" size={ICON.xs} />
          <span>{rule.name}{p.mark?.was ? ` · base ${rule.was}` : ""}</span>
        </div>
      )}
      <div className="fe-wk-nxt">
        <span className="fe-wk-ok" data-tip={`When it passes, ${m.pass} is next`}><FlowIcon name="check" size={ICON.xs} />{m.pass}</span>
        <span className="fe-wk-no" data-tip={m.failTip}><FlowIcon name="x" size={ICON.xs} />{m.fail}</span>
      </div>
      <div className="fe-wk-evl">
        <span className="fe-wk-does">↳ {role.does}</span>
        <span className="fe-sp" />
        {role.readsOnly && <span className="fe-wk-tg" data-tip="It can read and run, and cannot write"><FlowIcon name="lock" size={ICON.xs} /></span>}
        {!person && <span className="fe-wk-tg" data-tip={`${role.tools.length} of 5 tools granted`}><FlowIcon name="tag" size={ICON.xs} />{role.tools.length}</span>}
        <span className="fe-wk-tg" data-tip="It starts every turn from this note"><FlowIcon name="note" size={ICON.xs} /></span>
      </div>
      <div className="fe-wk-ft">
        {person
          ? <button type="button" className="fe-btn fe-btn-primary" data-size="sm" data-act="review" onClick={(e) => { e.stopPropagation(); p.onSelect(); }}><FlowIcon name="hand" size={ICON.xs} />Review</button>
          : <button type="button" className="fe-btn" data-size="sm" data-act="details" onClick={(e) => { e.stopPropagation(); p.onSelect(); }}><FlowIcon name="note" size={ICON.xs} />Open details</button>}
        <button type="button" className="fe-btn" data-size="sm" onClick={(e) => { e.stopPropagation(); p.onConfigure(); }}>
          <FlowIcon name="gear" size={ICON.xs} />Configure
        </button>
        <span className="fe-sp" />
        <button type="button" className="fe-sq fe-wk-more" aria-haspopup="menu" aria-expanded={menu} aria-label={`Menu for ${role.name}`} data-tip={`Menu for ${role.name}`}
          onClick={(e) => { e.stopPropagation(); setMenu(!menu); }}><FlowIcon name="dots" size={ICON.md} /></button>
      </div>
      {menu && (
        <div className="fe-wkmenu" role="menu" aria-label={`${role.name} actions`}>
          {rows.map((r) => (
            <button key={r.act} type="button" role="menuitem" disabled={!r.enabled} data-danger={r.danger ? "" : undefined}
              title={r.why ?? undefined} onClick={(e) => { e.stopPropagation(); if (r.enabled) press(r.act); }}>
              {r.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

const circumference = (r: number): number => 2 * Math.PI * r;
