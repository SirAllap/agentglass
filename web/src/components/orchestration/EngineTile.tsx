import type { CSSProperties } from "react";
import { agentProvider } from "../../../../shared/agentKinds.ts";
import type { EngineReadiness } from "../../../../shared/types.ts";
import { CTRL_H, EDGE, tintEdge } from "../workspace/Chrome.tsx";
import { engineLetter, engineTileState, tileModel, type EngineTileState } from "./orchestrationCopy.ts";

/**
 * One engine as the page draws it: a neutral letter, its name from the
 * provider table, its model, and its state as a dot AND a word. The reason
 * behind the word is the tile's hover; a tile that cannot be picked says it
 * once, on itself, and has no hover to repeat it.
 *
 * The letter is not a logo: no engine has an icon in this tree and no brand
 * colour is typed here. The dot takes a house hue and its text the matching
 * ink, so the state reads in either theme.
 */
const HUE: Record<EngineTileState["tone"], string | null> = { ok: "var(--success)", warn: "var(--warning)", err: "var(--error)", checking: null };
const INK: Record<EngineTileState["tone"], string> = { ok: "var(--success-ink)", warn: "var(--warning-ink)", err: "var(--error-ink)", checking: "var(--text3)" };

export interface EngineTileProps {
  engine: string;
  model?: string;
  role: "orchestrator" | "worker";
  readiness: readonly EngineReadiness[] | null;
  limitHit?: boolean;
  /** 1, 2, 3: where it stands in a chain. Left out for a lone engine. */
  position?: number;
  /** Makes the tile a button (the pickers). */
  onPick?: () => void;
  selected?: boolean;
  /** Cannot be picked: the tile says why, once. */
  disabled?: boolean;
  /** The reason a disabled tile gives when it is not the probe's own (a field the server holds fixed, a chain at its end). */
  reason?: string;
  /** Marks the tile a picker moves the cursor to when it opens. */
  first?: boolean;
}

export function EngineTile(p: EngineTileProps) {
  const s = engineTileState(p.engine, p.role, p.readiness, !!p.limitHit, p.model);
  const name = agentProvider(p.engine)?.title ?? p.engine;
  const hue = HUE[s.tone];
  const surface: CSSProperties = {
    background: "var(--surface-inset)",
    border: p.selected ? tintEdge("var(--primary)", 60) : EDGE,
    opacity: p.disabled ? 0.7 : 1,
  };
  const body = (
    <>
      {p.position !== undefined && <span className="text-[10px] tabular-nums shrink-0" style={{ color: "var(--text3)" }}>{p.position}</span>}
      <span aria-hidden className="inline-flex items-center justify-center shrink-0 rounded-md text-[11px] font-semibold"
        style={{ width: CTRL_H.compact, height: CTRL_H.compact, background: "var(--surface-card)", border: EDGE, color: "var(--text2)" }}>
        {engineLetter(p.engine)}
      </span>
      <span className="grid min-w-0 text-left gap-0.5">
        <span className="text-[12px] font-medium break-words" style={{ color: "var(--text)" }}>{name}</span>
        <span className="t-mono text-[10px] truncate" style={{ color: "var(--text3)" }}>{tileModel(p.engine, p.role, p.model ?? "")}</span>
        <span className="inline-flex items-center gap-1.5 text-[10px]" style={{ color: INK[s.tone] }}>
          <span aria-hidden className="inline-block rounded-full shrink-0" style={{
            width: 6, height: 6, background: hue ?? "transparent", boxShadow: hue ? undefined : `inset 0 0 0 1px ${INK[s.tone]}`,
          }} />
          {s.word}
        </span>
        {p.disabled && <span className="text-[10px] whitespace-normal" style={{ color: "var(--text3)" }}>{p.reason ?? s.reason}</span>}
      </span>
    </>
  );
  const cls = "agx-engine-tile inline-flex items-start gap-2 rounded-lg px-2.5 py-1.5 min-w-0";
  const title = p.disabled ? undefined : s.reason;
  if (!p.onPick) return <span className={cls} style={surface} title={title} data-tone={s.tone}>{body}</span>;
  return (
    <button type="button" className={cls} style={surface} title={title} data-tone={s.tone}
      aria-pressed={p.selected ?? false} disabled={p.disabled} onClick={p.onPick} data-pick-first={p.first ? "" : undefined}>
      {body}
    </button>
  );
}
