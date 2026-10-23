/*
 * Who is driving a tab, drawn two ways: a pill on its row in the bar, and a
 * chip in the toolbar for the tab in front that opens the last things the agent
 * did there. Both reserve the same slot for the "working" spinner, so a tab
 * does not change width when an ask starts or ends.
 */
import { useRef, useState } from "react";
import { AnchoredMenu } from "../AnchoredMenu.tsx";
import { CTRL_H, EDGE } from "../workspace/Chrome.tsx";
import { ICON } from "../../lib/iconSize.ts";
import { ago, type TabAgent } from "../../lib/browserAgentActivity.ts";
import { SpinnerIcon } from "./icons.tsx";

const tint = (paused: boolean) => (paused ? "var(--warning)" : "var(--primary)");
const ink = (paused: boolean) => (paused ? "var(--warning-ink)" : "var(--primary-ink)");

const Slot = ({ on }: { on: boolean }) => (
  <span className="shrink-0 grid place-items-center" style={{ width: ICON.xs, height: ICON.xs }} aria-hidden>
    {on ? <SpinnerIcon size={ICON.xs} /> : null}
  </span>
);

const stateWord = (a: TabAgent) => (a.paused ? "you have this tab" : a.working > 0 ? "working" : "idle");

export function AgentPill({ agent }: { agent: TabAgent }) {
  return (
    <span className="shrink-0 flex items-center gap-1 rounded-lg px-1.5 text-[9px]"
      title={`${agent.agent}: ${stateWord(agent)}`}
      style={{ height: CTRL_H.compact - 6, maxWidth: 76, color: ink(agent.paused), background: `color-mix(in srgb, ${tint(agent.paused)} 16%, transparent)` }}>
      <span className="truncate">{agent.agent}</span>
      <Slot on={agent.working > 0} />
    </span>
  );
}

export function AgentChip({ agent }: { agent: TabAgent }) {
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement | null>(null);
  const now = Date.now();
  const rows = [...agent.log].reverse();
  return (
    <>
      <button ref={btn} onClick={() => setOpen((v) => !v)} aria-haspopup="menu" aria-expanded={open}
        title={`${agent.agent} is driving this tab (${stateWord(agent)}). Click for what it did.`}
        aria-label={`${agent.agent}: ${stateWord(agent)}. Show its last actions`}
        className="min-w-0 flex items-center gap-1 rounded-lg px-1.5 text-[10px]"
        style={{ height: CTRL_H.compact, color: ink(agent.paused), background: `color-mix(in srgb, ${tint(agent.paused)} 16%, transparent)` }}>
        <span className="truncate">{agent.agent}</span>
        <Slot on={agent.working > 0} />
      </button>
      {open && (
        <AnchoredMenu anchor={btn} align="right" minWidth={260} placeKey={rows.length} onClose={() => setOpen(false)}>
          <div className="px-2 py-1 text-[10px]" style={{ color: "var(--text3)", borderBottom: EDGE }}>
            {agent.agent} · {stateWord(agent)}
          </div>
          {rows.length === 0 && <div className="px-2 py-2 text-[10px]" style={{ color: "var(--text4)" }}>Nothing done on this tab yet.</div>}
          {rows.map((r, i) => (
            <div key={i} className="flex items-center gap-2 px-2 text-[10px] min-w-0" style={{ minHeight: CTRL_H.compact, color: "var(--text2)" }}>
              <span className="shrink-0 tabular-nums w-7" style={{ color: "var(--text4)" }}>{ago(now, r.at)}</span>
              <span className="shrink-0">{r.verb}</span>
              <span className="min-w-0 flex-1 truncate" style={{ color: "var(--text3)" }} title={r.target}>{r.target}</span>
              <span className="shrink-0" style={{ color: r.ok ? "var(--success-ink)" : "var(--error-ink)" }}>{r.ok ? "ok" : "failed"}</span>
            </div>
          ))}
        </AnchoredMenu>
      )}
    </>
  );
}
