/*
 * The head of an open container: its state as glyph and word, its name with the
 * health and checkout badges, the same one action and "..." its row has, plus
 * Shell, and the step through the list when the list is not beside it.
 */
import { useRef, useState, type CSSProperties } from "react";
import type { DockerContainer } from "../../../../shared/types.ts";
import { displayName, kindOf, KINDS, READ_ONLY_REASON, type MenuItem, type RowVerb } from "../../lib/dockerState.ts";
import { healthTint, ownerTitle } from "../../lib/dockerRow.ts";
import type { stepOf } from "../../lib/dockerView.ts";
import { BranchIcon, CaretIcon, DoneIcon, TerminalIcon, WarningIcon } from "../../lib/glyphIcons.tsx";
import { ICON } from "../../lib/iconSize.ts";
import { IconButton } from "../workspace/Chrome.tsx";
import { ActionButton, MoreButton } from "./ContainerRow.tsx";
import { Badge, CubeIcon } from "./Glyphs.tsx";
import { RowMenu } from "./RowMenu.tsx";

export interface BarProps {
  step: ReturnType<typeof stepOf>;
  /** The "i / n" step is for the full-width view; a split list is already beside it. */
  showStep: boolean;
  readOnly: boolean;
  busy: boolean;
  onStep: (id: string) => void;
  onVerb: (v: RowVerb) => void;
  onMenuPick: (v: MenuItem["verb"]) => void;
}

export function DetailBar({ c, bar }: { c: DockerContainer; bar: BarProps }) {
  const { step, showStep, readOnly, busy, onStep, onVerb, onMenuPick } = bar;
  const [menu, setMenu] = useState(false);
  const anchor = useRef<HTMLElement | null>(null);
  const kind = kindOf(c);
  const turn = (deg: number) => ({ display: "flex", transform: `rotate(${deg}deg)` });
  const health = c.health || null;
  const tint = healthTint(c.health);
  const running = (c.state || "").toLowerCase() === "running";
  return (
    <div className="dk-dhd">
      <span className="dk-tile" role="img" aria-label={KINDS[kind].word} title={KINDS[kind].word} style={{ "--tone": KINDS[kind].tone } as CSSProperties}><CubeIcon size={17} /></span>
      <div style={{ minWidth: 0 }}>
        <div className="t1">
          <span title={c.name}>{displayName(c)}</span>
          {health && tint && <Badge tint={tint} title={c.healthError ?? undefined}>{health === "unhealthy" ? <WarningIcon size={12} /> : <DoneIcon size={12} />}{health}</Badge>}
          {c.owner?.foreign && (
            <Badge tint="var(--merged-ink)" title={`Started from another checkout\n${ownerTitle(c.owner)}`}>
              <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}><BranchIcon size={ICON.xs} />{c.owner.worktree}</span>
            </Badge>
          )}
        </div>
        <div className="t2" title={[c.name, c.image, c.owner?.worktree].filter(Boolean).join(" · ")}>
          {[c.name, c.image, c.owner?.worktree].filter(Boolean).join(" · ")}
        </div>
      </div>
      <div className="acts">
        {showStep && step.n > 1 && (
          <span className="dk-step">
            <IconButton onClick={() => step.prev && onStep(step.prev)} title="Previous container (k)" bare disabled={!step.prev}><span style={turn(180)}><CaretIcon size={ICON.sm} /></span></IconButton>
            <span>{step.i} / {step.n}</span>
            <IconButton onClick={() => step.next && onStep(step.next)} title="Next container (j)" bare disabled={!step.next}><CaretIcon size={ICON.sm} /></IconButton>
          </span>
        )}
        <ActionButton c={c} readOnly={readOnly} busy={busy} onVerb={onVerb} labelled />
        <button type="button" className="dk-chip" onClick={() => onMenuPick("shell")} disabled={!running || readOnly}
          title={readOnly ? READ_ONLY_REASON : running ? "Open a shell in this container in the console below" : "Start the container first"}>
          <TerminalIcon size={ICON.sm} />Shell
        </button>
        <MoreButton chip c={c} open={menu} onMenu={(el) => { anchor.current = el; setMenu(true); }} />
        {menu && <RowMenu anchor={anchor} c={c} where="detail" readOnly={readOnly} onPick={onMenuPick} onClose={() => setMenu(false)} />}
      </div>
    </div>
  );
}
