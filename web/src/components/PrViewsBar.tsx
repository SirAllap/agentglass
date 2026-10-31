// The views bar: Main, QA and the rest as one segmented control, a dot on the
// one whose rules changed, the "Save to <view>" pill, and one menu for what
// else a view can do. It replaces the preset chips; the data is usePrViews.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { VIEW_LIMITS, emptyLanes, type LaneFilter, type PrView } from "../../../shared/prFilter.ts";
import { lanesToText, parseRuleText } from "../lib/prFilterSyntax.ts";
import { addParsed, newNodeId } from "../lib/prFilterTree.ts";
import { viewDirty, viewHotkey } from "../lib/prFilterView.ts";
import { cleanName, freeName } from "../lib/filterPresets.ts";
import type { PrViewFailure, PrViewsApi } from "./usePrViews.ts";
import { Pop, PopHead, PfIcon } from "./PrFilterPop.tsx";
import { Button, EDGE, INPUT, INPUT_STYLE, LINE, tintEdge } from "./workspace/Chrome.tsx";
import { ICON } from "../lib/iconSize.ts";

/** How many views sit in the row before the rest go behind the menu. */
export const VISIBLE_CHIPS = 4;

type Panel = null | { kind: "menu" | "new" | "rename" | "paste"; anchor: HTMLElement; id?: string };

function Item({ children, onClick, tone, disabled, right }: { children: ReactNode; onClick: () => void; tone?: "danger"; disabled?: boolean; right?: ReactNode }) {
  return (
    <button type="button" role="menuitem" disabled={disabled} onClick={onClick}
      className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-[12px] text-left agx-hover disabled:opacity-40"
      style={{ color: tone === "danger" ? "var(--error-ink)" : "var(--text2)" }}>
      {children}{right && <span className="ml-auto text-[11px]" style={{ color: "var(--text4)" }}>{right}</span>}
    </button>
  );
}

export function PrViewsBar({ api, counts, live, setLive, sort, hotkeys, everyone }: {
  api: PrViewsApi;
  /** PRs each view would show on this board, by view id. */
  counts: Map<string, number>;
  live: LaneFilter;
  setLive: (f: LaneFilter) => void;
  sort: { options: { value: string; label: string }[]; value: string; onPick: (v: string) => void };
  hotkeys: boolean;
  /** Per repository: whether the lanes take in every open PR, not only yours and the ones you were asked to review. */
  everyone?: { on: boolean; toggle: (on: boolean) => void };
}) {
  const { views, active } = api;
  const dirty = !!active && viewDirty(live, active.filter);
  const [panel, setPanel] = useState<Panel>(null);
  const [draft, setDraft] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const moreRef = useRef<HTMLButtonElement>(null);
  const shown = views.slice(0, VISIBLE_CHIPS);
  const rest = views.slice(VISIBLE_CHIPS);
  /* The active view hidden behind the menu stays pressed there: say so on the button. */
  const activeHidden = !!active && rest.some((v) => v.id === active.id);

  const apply = (v: PrView) => { api.setActive(v.id); setLive(structuredClone(v.filter)); setPanel(null); };
  const open = (kind: NonNullable<Panel>["kind"], anchor: HTMLElement | null, text = "", id?: string) => {
    if (!anchor) return;
    setDraft(text); setProblem(null); setPanel({ kind, anchor, id });
  };
  const fail = (why: PrViewFailure | null, name: string): boolean => {
    if (!why) return false;
    setProblem(why === "offline" ? "The server could not be reached" : failureText(why, name));
    return true;
  };

  /* Alt+1..9 applies the nth view, the way the chips did. */
  const latest = useRef({ views, apply });
  latest.current = { views, apply };
  useEffect(() => {
    if (!hotkeys) return;
    let altHeld = false;
    const h = (e: KeyboardEvent) => {
      if (e.key === "Alt") { altHeld = true; return; }
      const n = viewHotkey(e, altHeld);
      const v = n == null ? undefined : latest.current.views[n];
      if (v) { e.preventDefault(); latest.current.apply(v); }
    };
    const up = (e: KeyboardEvent) => { if (e.key === "Alt") altHeld = false; };
    const release = () => { altHeld = false; };
    window.addEventListener("keydown", h);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", release);
    document.addEventListener("visibilitychange", release);
    return () => {
      window.removeEventListener("keydown", h);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", release);
      document.removeEventListener("visibilitychange", release);
    };
  }, [hotkeys]);

  const viewMenu = (v: PrView) => (
    <>
      <PopHead>View · {v.name}</PopHead>
      <Item onClick={() => open("rename", panel?.anchor ?? null, v.name, v.id)}>Rename…</Item>
      {active?.id === v.id && dirty && <Item onClick={() => { api.save({ ...v, filter: live }); setPanel(null); }}>Save to {v.name}</Item>}
      <Item onClick={() => open("new", panel?.anchor ?? null, freeName(`${v.name} 2`, views))}>Save as new view…</Item>
      {active?.id === v.id && dirty && <Item onClick={() => { setLive(structuredClone(v.filter)); setPanel(null); }}>Discard changes</Item>}
      <Item onClick={() => { void navigator.clipboard?.writeText(lanesToText(v.filter)); setPanel(null); }} right={<code className="font-mono truncate max-w-[110px] inline-block align-bottom">{lanesToText(v.filter) || "no rules"}</code>}>Copy rules as text</Item>
      <Item onClick={() => open("paste", panel?.anchor ?? null, "", v.id)}>Paste rules from text…</Item>
      <Item disabled={views.length >= VIEW_LIMITS.views} onClick={() => { api.saveNew(freeName(`${v.name} copy`, views), v.filter); setPanel(null); }}>Duplicate</Item>
      <Item disabled={views[0]?.id === v.id} onClick={() => api.move(v.id, -1)}>Move left</Item>
      <Item disabled={views[views.length - 1]?.id === v.id} onClick={() => api.move(v.id, 1)}>Move right</Item>
      <div className="my-1" style={{ borderTop: LINE }} />
      <Item tone="danger" onClick={() => { api.remove(v.id); setPanel(null); }}>Delete view</Item>
    </>
  );

  const submitName = () => {
    if (!panel) return;
    if (panel.kind === "new" && !fail(api.saveNew(draft, live), draft)) setPanel(null);
    if (panel.kind === "rename" && panel.id && !fail(api.rename(panel.id, draft), draft)) setPanel(null);
  };
  const submitPaste = () => {
    const r = parseRuleText(draft, { newId: newNodeId });
    if ("error" in r) { setProblem(r.error); return; }
    setLive(addParsed(emptyLanes(), r.add));
    setPanel(null);
  };

  return (
    <div className="flex items-center gap-1.5 min-w-0" role="toolbar" aria-label="Views">
      <div className="flex items-center gap-1.5 min-w-0 overflow-x-auto agx-scroll py-0.5">
        {shown.map((v, i) => {
          const on = active?.id === v.id;
          return (
            <button key={v.id} type="button" aria-pressed={on} onClick={() => apply(v)}
              onContextMenu={(e) => { e.preventDefault(); open("menu", e.currentTarget, "", v.id); }}
              title={`${v.name} — ${lanesToText(v.filter) || "no rules"}${counts.has(v.id) ? ` · ${counts.get(v.id)} on the board` : ""} · Alt+${i + 1}`}
              className="agx-vchip">
              {v.name}
              <kbd aria-hidden className="agx-vchip-k">{i + 1}</kbd>
              {on && dirty && <span aria-label="changed" className="agx-vchip-dirty" />}
            </button>
          );
        })}
      </div>

      {/* As drawn: Save view only while the chosen view has changed. */}
      {active && dirty && (
        <Button size="hit" onClick={() => api.save({ ...active, filter: live })} title={`Save the changes to ${active.name}`}><PfIcon name="check" size={14} />Save view</Button>
      )}
      {/* Always: a view can be started from any rules, saved or not. Clearing the rules is the rules row's (Clear rules, Undo). */}
      <Button size="hit" onClick={(e) => open("new", e.currentTarget, freeName(active ? `${active.name} 2` : "View", views))} title="Keep these rules as a new view"><PfIcon name="plus" size={14} />Save as view…</Button>
      {/* Per repository, beside the views because it changes what the lanes hold, not what a rule matches. */}
      {everyone && (
        <Button size="hit" on={everyone.on} aria-pressed={everyone.on} onClick={() => everyone.toggle(!everyone.on)}
          data-tip={everyone.on
            ? "Showing every open pull request in this repository. Turn off to show only yours and the ones you were asked to review."
            : "Show every open pull request in this repository in the lanes, not only yours and the ones you were asked to review."}>
          <PfIcon name="eye" size={ICON.sm} />Show everyone's PRs
        </Button>
      )}
      {/* Not inside the chips: it owns the views that do not fit, the sort and the options, so it reads as a control of the row. */}
      <button ref={moreRef} type="button" aria-haspopup="menu" aria-expanded={panel?.kind === "menu"} aria-label="More views, sort and view options" title="More views, sort and view options"
        onClick={() => (panel?.kind === "menu" ? setPanel(null) : open("menu", moreRef.current, "", active?.id))}
        className="agx-btn inline-flex items-center justify-center gap-1 h-[26px] min-w-[26px] px-1 rounded-lg shrink-0 text-[11px]"
        style={{ color: "var(--text)", border: tintEdge("var(--text)", 22), background: activeHidden ? "var(--surface-inset)" : "transparent" }}>
        <PfIcon name="dots" size={14} />{rest.length > 0 && <span className="text-[10.5px] tabular-nums">{rest.length}</span>}
      </button>
      {api.undo && <Button size="compact" onClick={api.restore} title="Bring the deleted view back"><PfIcon name="undo" />Undo delete “{api.undo.name}”</Button>}

      {panel?.kind === "menu" && (
        <Pop anchor={panel.anchor} onClose={() => setPanel(null)} width={300} align="right" label="Views">
          <div className="p-1.5" role="menu">
            {rest.length > 0 && <PopHead>More views</PopHead>}
            {rest.map((v) => <Item key={v.id} onClick={() => apply(v)} right={active?.id === v.id ? <PfIcon name="check" /> : counts.get(v.id)}>{v.name}</Item>)}
            {rest.length > 0 && <div className="my-1" style={{ borderTop: LINE }} />}
            {(() => { const target = views.find((v) => v.id === panel.id) ?? active; return target ? <>{viewMenu(target)}<div className="my-1" style={{ borderTop: LINE }} /></> : null; })()}
            <Item disabled={views.length >= VIEW_LIMITS.views} onClick={() => open("new", panel.anchor, freeName("View", views))}>New view from these rules…</Item>
            <div className="my-1" style={{ borderTop: LINE }} />
            <PopHead>Sort lanes</PopHead>
            {sort.options.map((o) => <Item key={o.value} onClick={() => { sort.onPick(o.value); setPanel(null); }} right={o.value === sort.value ? <PfIcon name="check" /> : undefined}>{o.label}</Item>)}
          </div>
        </Pop>
      )}
      {(panel?.kind === "new" || panel?.kind === "rename") && (
        <Pop anchor={panel.anchor} onClose={() => setPanel(null)} width={260} label={panel.kind === "new" ? "Name the view" : "Rename the view"}>
          <form className="p-2" onSubmit={(e) => { e.preventDefault(); submitName(); }}>
            <PopHead>{panel.kind === "new" ? "Save these rules as a view" : "Rename view"}</PopHead>
            <input ref={focusSelect} value={draft} maxLength={VIEW_LIMITS.name + 8} onChange={(e) => { setDraft(e.target.value); setProblem(null); }} aria-label="View name"
              className={`${INPUT} w-full`} style={problem ? { ...INPUT_STYLE, border: tintEdge("var(--error)", 100) } : INPUT_STYLE} />
            {problem && <div className="text-[11px] mt-1" style={{ color: "var(--error-ink)" }}>{problem}</div>}
            <div className="flex justify-end gap-1.5 mt-2"><Button size="compact" onClick={() => setPanel(null)}>Cancel</Button><Button size="compact" tone="primary" type="submit">Save</Button></div>
          </form>
        </Pop>
      )}
      {panel?.kind === "paste" && (
        <Pop anchor={panel.anchor} onClose={() => setPanel(null)} width={320} align="right" label="Paste rules">
          <div className="p-2">
            <PopHead>Paste rules as text</PopHead>
            <textarea autoFocus value={draft} onChange={(e) => { setDraft(e.target.value); setProblem(null); }} rows={3} spellCheck={false} aria-label="Rules as text" placeholder="-BETA is:conflict ci:passing"
              className="w-full rounded-md px-2 py-1.5 text-[12px] font-mono" style={{ border: problem ? tintEdge("var(--error)", 100) : EDGE, background: "var(--bg)", color: "var(--text)" }} />
            {problem && <div className="text-[11px] mt-1" style={{ color: "var(--error-ink)" }}>{problem}</div>}
            <div className="text-[11px] mt-1" style={{ color: "var(--text4)" }}>Replaces the rules on the board. Save the view to keep them.</div>
            <div className="flex justify-end gap-1.5 mt-2"><Button size="compact" onClick={() => setPanel(null)}>Cancel</Button><Button size="compact" tone="primary" onClick={submitPaste}>Use these rules</Button></div>
          </div>
        </Pop>
      )}
    </div>
  );
}

/** Stable on purpose: an inline ref callback would re-select the text on every keystroke. */
const focusSelect = (el: HTMLInputElement | null) => { el?.focus(); el?.select(); };

/** Why a name or a save was refused, in the words the name box shows. */
export const failureText = (why: Exclude<PrViewFailure, "offline">, name = ""): string => {
  if (why === "taken") return `“${cleanName(name)}” is taken`;
  if (why === "empty") return "Give it a name";
  if (why === "long") return `${VIEW_LIMITS.name} characters at most`;
  if (why === "full") return `${VIEW_LIMITS.views} views is the limit. Delete one first`;
  return "That view is gone";
};
