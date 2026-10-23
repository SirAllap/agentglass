/*
 * The browser's chrome, for a browser that agents drive and people visit.
 *
 * There is no tab strip and no sidebar: the page takes the whole panel, and
 * every tab lives in one pill floating at the top of it. One element, four
 * sizes, all of them one clip-path on a box that is always full size (so the
 * box never re-lays out and nothing inside it stretches):
 *
 *   compact  104 x 30 — the mark, a live dot, the tab count. At rest.
 *   pill     hover or focus. Whose page this is and what the agent is doing;
 *            or, when the page is the person's, their bar: back, forward,
 *            reload, the address, the tab count, the menu, Hand back.
 *   tucked   36 x 14 at the very top edge, once the page is the person's: the
 *            page is theirs, so nothing of ours floats over what they may need
 *            to click. Hover it and the pill drops from there.
 *   open     the overview: one box per container, its tabs as pictures, a
 *            count on each box and one sentence on top. For the person only —
 *            no agent verb reads or drives it.
 *
 * Each card shows the last picture seen of its tab (kept by the panel), so
 * the overview opens at once; the page in front is refreshed as it opens. A
 * sleeping tab has no page, so it shows its initial, and a background tab's
 * picture is as old as the last time it was in front. Ceiling: folders and the
 * shelf live in the classic list, not here.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { BrowserTab } from "../../lib/browserTabs.ts";
import type { Activity } from "../../lib/browserAgentActivity.ts";
import { boxState, tabState } from "../../lib/browserAgentActivity.ts";
import { LivingMark } from "../Logo.tsx";
import { StateIcon, useAgentLive } from "./AgentPresence.tsx";
import { CloseIcon } from "./icons.tsx";

/** How long "You have this tab" stays where the person is looking before the island tucks away. */
export const TUCK_AFTER_MS = 2500;

export interface IslandProps {
  tabs: BrowserTab[];
  activeId: string | null;
  acts: Activity;
  /** A profile id ("" is the default) as the person named it. */
  spaceName: (profile: string) => string;
  /** The last thing the agent did on the page in front, in a few words. */
  /** The page in front's address as the bar shows it. */
  address: string;
  canBack: boolean;
  canForward: boolean;
  loading: boolean;
  onShow: (id: string) => void;
  onClose: (id: string) => void;
  onNew: () => void;
  onAddress: () => void;
  onBack: () => void;
  onForward: () => void;
  onReload: () => void;
  onStop: () => void;
  onMenu: (at: DOMRect) => void;
  onToggle: (tab: string) => void;
  /** A fresh picture of an awake tab, or null. */
  picture: (id: string) => Promise<string | null>;
  /** The last picture seen of a tab, at once, or null. */
  lastPicture: (id: string) => string | null;
  /** Tells the panel when the island has tucked, so the dock goes too. */
  onTucked: (tucked: boolean) => void;
}

const host = (url: string) => { try { return new URL(url).host; } catch { return url; } };

export function BrowserIsland(p: IslandProps) {
  const { tabs, activeId, acts } = p;
  const box = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const [tucked, setTucked] = useState(false);
  const [pics, setPics] = useState<Record<string, string>>({});
  const active = tabs.find((t) => t.id === activeId) ?? null;
  const act = active ? acts[active.id] : undefined;
  const live = useAgentLive(act);
  /* An agent that holds the tab but has stopped acting leaves it to the person:
     the pill gives back the address and the arrows instead of naming a driver
     nobody can see. */
  const driving = !!act && !act.paused && live;
  const working = driving && act!.working > 0;
  /* The page is the person's when no agent is acting on it, or when they took it. */
  const yours = !driving;

  useEffect(() => {
    if (!yours || open) { setTucked(false); return; }
    const t = setTimeout(() => setTucked(true), TUCK_AFTER_MS);
    return () => clearTimeout(t);
  }, [yours, open, activeId]);
  useEffect(() => { p.onTucked(tucked); }, [tucked]); // eslint-disable-line react-hooks/exhaustive-deps

  /* One box per container, in the order the tabs are in; who holds each tab is
     the live ask if there is one, else the name the tab kept across a restart. */
  /* The overview's states age (Thinking turns Done), and nothing else re-renders it while it is open. */
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { if (!open) return; setNow(Date.now()); const t = setInterval(() => setNow(Date.now()), 5000); return () => clearInterval(t); }, [open]);
  const groups = useMemo(() => {
    const by = new Map<string, BrowserTab[]>();
    for (const t of tabs) { const k = t.profile || ""; if (!by.has(k)) by.set(k, []); by.get(k)!.push(t); }
    return [...by.entries()].map(([profile, list]) => {
      const held = list.filter((t) => acts[t.id]?.agent || t.agent);
      const states = Object.fromEntries(list.map((t) => [t.id, tabState(acts[t.id], t.agent, now)]));
      return { profile, name: p.spaceName(profile), list, held: held.length, states, state: boxState(Object.values(states)) };
    });
  }, [tabs, acts, p.spaceName, now]); // eslint-disable-line react-hooks/exhaustive-deps
  const agents = useMemo(() => [...new Set(tabs.map((t) => acts[t.id]?.agent || t.agent).filter(Boolean) as string[])], [tabs, acts]);
  const heldTabs = tabs.filter((t) => acts[t.id]?.agent || t.agent).length;
  const heldBoxes = groups.filter((g) => g.held).length;

  /*
   * The pill grows into the overview. What grows is ONE empty dark shape (a
   * solid colour, nothing inside it), because Electron draws here without the
   * GPU and that is the only thing the size of the page that is cheap to
   * repaint every frame; a copy of the page flying into its card, or the
   * overview's own content clipped as it grew, stuttered (measured on the
   * installed app). The content arrives once the shape is nearly full and
   * leaves first on the way back; all of it CSS transitions, so a reversal
   * halfway runs back from where it is.
   */
  const [shown, setShown] = useState(false);
  const [snap, setSnap] = useState(false);
  const closer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const unsnap = () => requestAnimationFrame(() => requestAnimationFrame(() => setSnap(false)));
  /* The shape starts at the size of the pill that was clicked and ends at the
     resting capsule, whose icons fade in over its last stretch: it lands as
     the capsule, never as an empty dark pill waiting for its content. */
  const PILL = yours ? { w: 300, h: 40, r: 20 } : { w: 210, h: 36, r: 18 };
  const CAPSULE = { w: 52, h: 30, r: 15 };
  const [morph, setMorph] = useState(PILL);
  const finish = useCallback(() => {
    if (closer.current) { clearTimeout(closer.current); closer.current = null; }
    setSnap(true); setOpen(false); unsnap();
  }, []);
  const show = useCallback(() => {
    if (closer.current) { clearTimeout(closer.current); closer.current = null; }
    setMorph(PILL);
    const front = activeId;
    const now: Record<string, string> = {};
    for (const t of tabs) { const src = p.lastPicture(t.id); if (src) now[t.id] = src; }
    setPics(now);
    if (!open) { setSnap(true); setOpen(true); unsnap(); }
    requestAnimationFrame(() => setShown(true));
    // the page in front is the one worth refreshing; a hidden guest gives no picture
    if (front) void p.picture(front).then((src) => { if (src) setPics((m) => ({ ...m, [front]: src })); });
  }, [open, tabs, activeId, p, yours]); // eslint-disable-line react-hooks/exhaustive-deps
  const hide = useCallback((pick?: string) => {
    if (!open) return;
    if (pick && pick !== activeId) p.onShow(pick);
    setMorph(CAPSULE);
    setShown(false);
    // done when the shape's own transition ends; the timer only covers one that never reports
    if (closer.current) clearTimeout(closer.current);
    closer.current = setTimeout(finish, 700);
  }, [open, activeId, p, finish]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => { if (closer.current) clearTimeout(closer.current); }, []);

  /* Escape is the overview's alone while it is up: other window handlers
     (the address box, the panel) must not close something else on the same key. */
  const hideRef = useRef(hide);
  hideRef.current = hide;
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); e.stopImmediatePropagation(); hideRef.current(); } };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open]);
  // focus lands on the page you were on once, when it opens, never again on a re-render
  useEffect(() => { if (open) box.current?.querySelector<HTMLElement>(".agx-isl-card.is-on")?.focus({ preventScroll: true }); }, [open]);

  /* Opened from the tucked arrow, the pill comes down 12 px, out from under a
     pointer resting on the edge: hover alone then closed it and reopened it in
     a loop. While peeking it stays open as long as the pointer is over the
     pill or the gap above it, and closes on the island's usual grace after. */
  const [peek, setPeek] = useState(false);
  useEffect(() => {
    if (!peek) return;
    let t: ReturnType<typeof setTimeout> | undefined;
    const move = (e: PointerEvent) => {
      const el = box.current; if (!el) return;
      const r = el.getBoundingClientRect(), half = (yours ? 300 : 210) + 16, mid = r.left + r.width / 2;
      const inside = e.clientX > mid - half && e.clientX < mid + half && e.clientY < r.top + (yours ? 40 : 36) + 12;
      if (inside) { clearTimeout(t); t = undefined; } else if (!t) t = setTimeout(() => setPeek(false), 700);
    };
    document.addEventListener("pointermove", move);
    return () => { document.removeEventListener("pointermove", move); clearTimeout(t); };
  }, [peek, yours]);
  useEffect(() => { if (!tucked || open) setPeek(false); }, [tucked, open]);

  const cls = "agx-isl" + (open ? " is-open" : "") + (shown ? " is-shown" : "") + (snap ? " is-snap" : "") + (tucked ? " is-tucked" : "") + (peek ? " is-peek" : "") + (yours ? " is-yours" : "") + (act?.paused ? " is-taken" : "");
  const dot = act?.paused ? "is-taken" : working ? "is-working" : "";
  return (
    <>
      {open && <div className={"agx-isl-scrim" + (shown ? " is-shown" : "")} onClick={() => hide()} />}
      <div ref={box} className={cls} role={open ? "dialog" : undefined} aria-label={open ? "Every tab" : undefined}
        onPointerEnter={() => { if (tucked && !open) setPeek(true); }}
        style={{ "--pw": `${morph.w}px`, "--ph": `${morph.h}px`, "--pr": `${morph.r}px` } as React.CSSProperties}>
        {/* under the collapsed content, so the capsule's icons are on top of it as it lands */}
        {open && <div className="agx-isl-morph" aria-hidden
          onTransitionEnd={(e) => { if (!shown && e.target === e.currentTarget && e.propertyName === "clip-path") finish(); }} />}
        {/* the collapsed island is never unmounted: it only changes opacity, so no frame waits for it */}
        {(
          <>
            <span className="agx-isl-compact" aria-hidden>
              <LivingMark size={16} style={{ color: "#a78bfa" }} />
              <span className={"agx-isl-dot " + dot} />
              <span className="agx-isl-num" title={`${tabs.length} tabs open`}>{tabs.length}</span>
            </span>
            <span className="agx-isl-tuck" aria-hidden>
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m4 6 4 4 4-4" /></svg>
            </span>
            {yours ? (
              <div className="agx-isl-bar">
                <button type="button" className="agx-isl-ib" aria-label="Back" disabled={!p.canBack} onClick={p.onBack}><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M10 3 5 8l5 5" /></svg></button>
                <button type="button" className="agx-isl-ib" aria-label="Forward" disabled={!p.canForward} onClick={p.onForward}><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="m6 3 5 5-5 5" /></svg></button>
                <button type="button" className="agx-isl-ib" aria-label={p.loading ? "Stop" : "Reload"} onClick={p.loading ? p.onStop : p.onReload}>
                  {p.loading
                    ? <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"><path d="m4 4 8 8M12 4l-8 8" /></svg>
                    : <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M13 8a5 5 0 1 1-1.5-3.5M13 2.5v3h-3" /></svg>}
                </button>
                <button type="button" className="agx-isl-addr" onClick={p.onAddress} title="Type an address (Ctrl+L)">{p.address || "Type an address"}</button>
                <button type="button" className="agx-isl-ib" aria-label="Menu" onClick={(e) => p.onMenu(e.currentTarget.getBoundingClientRect())}><svg viewBox="0 0 16 16" fill="currentColor"><circle cx="3.5" cy="8" r="1.2" /><circle cx="8" cy="8" r="1.2" /><circle cx="12.5" cy="8" r="1.2" /></svg></button>
                <button type="button" className="agx-isl-count" aria-label="Show every tab" onClick={show}>{tabs.length}</button>
                {act?.paused && <button type="button" className="agx-isl-hand" onClick={() => active && p.onToggle(active.id)}>Hand back</button>}
              </div>
            ) : (
              <button type="button" className="agx-isl-status" aria-label="Show every tab" onClick={show}>
                <LivingMark size={17} style={{ color: "#a78bfa" }} />
                <span className="agx-isl-title">{active?.title || (active ? host(active.url) : "")}</span>
                <span className="agx-isl-doing"><span className={"agx-isl-dot " + dot} /><span className="agx-isl-doing-t">{act!.agent}</span></span>
                <span className="agx-isl-num" title={`${tabs.length} tabs open`}>{tabs.length}</span>
              </button>
            )}
          </>
        )}
        {open && (
          <div className="agx-isl-mc">
            <div className="agx-isl-head">
              <p className="agx-isl-sum">
                {agents.length === 0 ? <>No agent is using a tab right now</>
                  : <><strong>{agents.length === 1 ? agents[0] : `${agents.length} agents`}</strong> {agents.length === 1 ? "is" : "are"} using <strong>{heldBoxes} {heldBoxes === 1 ? "container" : "containers"}</strong> and <strong>{heldTabs} {heldTabs === 1 ? "tab" : "tabs"}</strong></>}
                {tabs.length - heldTabs > 0 && <span className="agx-isl-mine">you have {tabs.length - heldTabs} of your own</span>}
              </p>
              <button type="button" className="agx-isl-ib" aria-label="Close" onClick={() => hide()}><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"><path d="m4 4 8 8M12 4l-8 8" /></svg></button>
            </div>
            <div className="agx-isl-boxes">
              {groups.map((g) => (
                <section key={g.profile} className={"agx-isl-box" + (g.held ? " is-agent" : "") + (g.state && g.state.key !== "done" ? " is-live" : "")} style={{ "--n": g.list.length + 1 } as React.CSSProperties}>
                  <header>
                    <span className="agx-isl-bn">{g.name}</span>
                    <span className="agx-isl-bc">{g.list.length} {g.list.length === 1 ? "tab" : "tabs"}{g.held ? ` · agent on ${g.held}` : ""}</span>
                    {g.state && <span key={g.state.key} className={"agx-isl-state is-" + g.state.key}><StateIcon k={g.state.key} />{g.state.word}</span>}
                  </header>
                  <div className="agx-isl-row">
                    {g.list.map((t) => {
                      const who = acts[t.id]?.agent || t.agent;
                      const st = g.states[t.id];
                      return (
                        <div key={t.id} data-tab={t.id} role="button" tabIndex={0}
                          className={"agx-isl-card" + (t.id === activeId ? " is-on" : "")}
                          onClick={() => hide(t.id)} onKeyDown={(e) => { if (e.target !== e.currentTarget) return; if (e.key === "Enter" || e.key === " ") { e.preventDefault(); hide(t.id); } }}>
                          {/* The halo and the satellite ride outside the picture, which clips. */}
                          <div className={"agx-isl-shot" + (st ? " is-" + (st.key === "done" || st.key === "thinking" || st.key === "yours" ? st.key : "active") : "")}>
                          {st && st.key !== "done" && <><span className="agx-isl-halo" aria-hidden /><span className="agx-isl-sat" aria-hidden /></>}
                          {st?.key === "done" && <span className="agx-isl-done" aria-hidden><StateIcon k="done" /></span>}
                          <div className="agx-isl-thumb">
                            {pics[t.id] ? <img src={pics[t.id]} alt="" /> : <span className="agx-isl-mono">{(t.title || host(t.url) || "?").slice(0, 1).toUpperCase()}{t.asleep && <small>Asleep</small>}</span>}
                            <button type="button" className="agx-isl-x" aria-label={`Close ${t.title || "tab"}`} onClick={(e) => { e.stopPropagation(); p.onClose(t.id); }}><CloseIcon size={12} /></button>
                          </div>
                          </div>
                          <div className="agx-isl-cap">
                            <span className="agx-isl-name">{t.title || host(t.url)}</span>
                            <span className={"agx-isl-who" + (who ? " is-agent" : "")} title={st ? st.word : undefined}>{who ?? "You"}</span>
                          </div>
                        </div>
                      );
                    })}
                    <button type="button" className="agx-isl-card agx-isl-new" onClick={() => { setOpen(false); p.onNew(); }}>
                      <svg width="20" height="20" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"><path d="M8 3v10M3 8h10" /></svg>
                      <span>New tab</span>
                    </button>
                  </div>
                </section>
              ))}
            </div>
          </div>
        )}
      </div>
    </>
  );
}
