/*
 * A stack as a card: collapse, name, the checkout it came from, one small
 * square per container, "N/M up · K need you", one button for the likely next
 * step on the whole stack, and a menu for the rest. The column labels sit on
 * the same grid as the rows beneath, so the figures are never anonymous.
 */
import type { ReactNode } from "react";
import { displayName, groupMenu, KINDS, kindOf } from "../../lib/dockerState.ts";
import { stackMap } from "../../lib/dockerTriage.ts";
import type { GroupView } from "../../lib/dockerView.ts";
import { BranchIcon, CaretIcon, MoreIcon, PlayIcon, RefreshIcon } from "../../lib/glyphIcons.tsx";
import { ICON } from "../../lib/iconSize.ts";
import { Button } from "../workspace/Chrome.tsx";
import { Square } from "./Glyphs.tsx";

export interface GroupConfirm { verb: "restart" | "stop"; n: number }

export function StackCard({ group, readOnly, busy, folded, menuOpen, confirm, onToggle, onMenu, onGroupVerb, onConfirm, children }: {
  group: GroupView; readOnly: boolean; busy: boolean; folded: boolean; menuOpen: boolean;
  confirm: GroupConfirm | null;
  onToggle: () => void;
  onMenu: (el: HTMLElement) => void;
  onGroupVerb: (verb: "start" | "restart", ids: string[]) => void;
  onConfirm: (yes: boolean) => void;
  children?: ReactNode;
}) {
  const { key, containers, summary, chip } = group;
  const btn = groupMenu(containers, { readOnly }).button;
  const squares = stackMap(containers);
  return (
    <section className="dk-stack" data-folded={folded || undefined} aria-label={key}>
      <div className="dk-sh">
        <button type="button" className="dk-tg" onClick={onToggle} aria-expanded={!folded} title={folded ? "Expand" : "Collapse"} aria-label={`${folded ? "Expand" : "Collapse"} ${key}`}>
          <CaretIcon size={ICON.sm} />
        </button>
        <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0, overflow: "hidden" }}>
          <b title={key} style={{ fontSize: 13, fontWeight: 600, color: "var(--text)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", minWidth: 0, flex: "0 1 auto" }}>{key}</b>
          {chip && (
            <span className="dk-own" data-foreign={chip.foreign || undefined}
              title={`${chip.foreign ? "Started from another checkout: " : ""}${chip.text}`}>
              <BranchIcon size={ICON.xs} />{chip.text}
            </span>
          )}
          <span className="dk-mini" aria-hidden>
            {squares.map((s) => {
              const c = containers.find((x) => x.id === s.id)!;
              return <Square key={s.id} kind={kindOf(c)} small title={`${displayName(c)}: ${KINDS[s.kind].word}`} />;
            })}
          </span>
        </div>
        <span className="dk-tally">{summary.up}/{summary.total} up{summary.need ? <> · <b>{summary.need} {summary.need === 1 ? "needs" : "need"} you</b></> : null}</span>
        <Button data-verb={btn.verb} disabled={btn.disabled || busy}
          title={btn.reason ?? (btn.verb === "start" ? `Start every container in ${key}` : `Restart every running container in ${key}`)}
          onClick={() => onGroupVerb(btn.verb, btn.ids)}>
          {btn.verb === "start" ? <PlayIcon size={ICON.xs} /> : <RefreshIcon size={ICON.sm} />}{btn.label}
        </Button>
        <button type="button" className="dk-more" data-open={menuOpen || undefined} aria-label={`More for ${key}`} aria-haspopup="menu" aria-expanded={menuOpen}
          disabled={readOnly} title={readOnly ? "Read-only instance: writes are turned off" : "More: start, restart or stop the whole stack"}
          onClick={(e) => onMenu(e.currentTarget)}>
          <MoreIcon size={ICON.sm} />
        </button>
      </div>
      {confirm && (
        <div className="dk-confirm" role="alertdialog">
          <span>{confirm.verb} {confirm.n} container{confirm.n === 1 ? "" : "s"} in <b>{key}</b>?</span>
          <Button size="compact" tone="warn" onClick={() => onConfirm(true)}>{confirm.verb}</Button>
          <Button size="compact" tone="quiet" onClick={() => onConfirm(false)}>Cancel</Button>
        </div>
      )}
      {!folded && (
        <>
          <div className="dk-cols dk-ch" aria-hidden><span /><span>Container</span><span>CPU</span><span>Memory</span><span>Port</span><span /><span /></div>
          {children}
        </>
      )}
    </section>
  );
}
