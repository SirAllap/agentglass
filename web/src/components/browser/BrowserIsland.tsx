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
 * Opening flies the page you were on into its own card (its picture, taken
 * when the overview opens), so you see where it went. Pictures are taken only
 * then and only of awake tabs: a sleeping tab has no page, so it shows its
 * initial. Ceiling: folders and the shelf live in the classic list, not here.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { BrowserTab } from "../../lib/browserTabs.ts";
import type { Activity } from "../../lib/browserAgentActivity.ts";
import { LivingMark } from "../Logo.tsx";
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
  doing: string;
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
  /** A picture of an awake tab, or null. Called only while the overview opens. */
  picture: (id: string) => Promise<string | null>;
  /** Tells the panel when the island has tucked, so the dock goes too. */
  onTucked: (tucked: boolean) => void;
}

const host = (url: string) => { try { return new URL(url).host; } catch { return url; } };
const calmNow = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

export function BrowserIsland(p: IslandProps) {
  const { tabs, activeId, acts } = p;
  const box = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const [tucked, setTucked] = useState(false);
  const [pics, setPics] = useState<Record<string, string>>({});
  const active = tabs.find((t) => t.id === activeId) ?? null;
  const act = active ? acts[active.id] : undefined;
  const driving = !!act && !act.paused;
  const working = driving && act!.working > 0;
  /* The page is the person's when no agent holds it, or when they took it. */
  const yours = !driving;

  useEffect(() => {
    if (!yours || open) { setTucked(false); return; }
    const t = setTimeout(() => setTucked(true), TUCK_AFTER_MS);
    return () => clearTimeout(t);
  }, [yours, open, activeId]);
  useEffect(() => { p.onTucked(tucked); }, [tucked]); // eslint-disable-line react-hooks/exhaustive-deps

  /* One box per container, in the order the tabs are in; who holds each tab is
     the live ask if there is one, else the name the tab kept across a restart. */
  const groups = useMemo(() => {
    const by = new Map<string, BrowserTab[]>();
    for (const t of tabs) { const k = t.profile || ""; if (!by.has(k)) by.set(k, []); by.get(k)!.push(t); }
    return [...by.entries()].map(([profile, list]) => {
      const held = list.filter((t) => acts[t.id]?.agent || t.agent);
      const state = list.some((t) => acts[t.id]?.paused) ? "yours" : list.some((t) => (acts[t.id]?.working ?? 0) > 0) ? "working" : held.length ? "idle" : "";
      return { profile, name: p.spaceName(profile), list, held: held.length, state };
    });
  }, [tabs, acts, p.spaceName]); // eslint-disable-line react-hooks/exhaustive-deps
  const agents = useMemo(() => [...new Set(tabs.map((t) => acts[t.id]?.agent || t.agent).filter(Boolean) as string[])], [tabs, acts]);
  const heldTabs = tabs.filter((t) => acts[t.id]?.agent || t.agent).length;
  const heldBoxes = groups.filter((g) => g.held).length;

  const fly = useCallback((src: string, card: Element | null, outward: boolean) => {
    const b = box.current?.parentElement, c = card?.querySelector(".agx-isl-thumb");
    if (!b || !c || calmNow()) return;
    const s = b.getBoundingClientRect(), r = c.getBoundingClientRect(), k = r.width / s.width;
    const img = document.createElement("img");
    img.src = src; img.className = "agx-isl-fly"; img.alt = "";
    b.appendChild(img);
    c.classList.add("is-hold");
    const full = { transform: "translate(0px, 0px) scale(1)", borderRadius: "0px" };
    const at = { transform: `translate(${r.left - s.left}px, ${r.top - s.top}px) scale(${k})`, borderRadius: `${12 / k}px` };
    const a = img.animate(outward ? [full, at] : [at, full], { duration: outward ? 560 : 380, easing: "cubic-bezier(0.32, 0.72, 0, 1)", fill: "forwards" });
    void a.finished.catch(() => {}).finally(() => { img.remove(); c.classList.remove("is-hold"); });
  }, []);

  /* Opens at once. Waiting for every tab's picture first held the overview
     shut for 1.5 s whenever a background tab was slow to answer (measured
     on the installed app: a hidden DuckDuckGo tab never answered). Now the
     page in front is asked first and gets 250 ms for its flight; every other
     picture fills its card when it arrives, and a card without one shows its
     initial until then. */
  const show = useCallback(() => {
    setPics({});
    setOpen(true);
    const front = activeId;
    const first = front ? p.picture(front).catch(() => null) : Promise.resolve(null);
    void Promise.race([first, new Promise<null>((r) => setTimeout(() => r(null), 250))]).then((src) => {
      if (src && front) requestAnimationFrame(() => fly(src, box.current?.querySelector(`[data-tab="${front}"]`) ?? null, true));
    });
    for (const t of tabs) {
      if (t.asleep) continue;
      const got = t.id === front ? first : p.picture(t.id).catch(() => null);
      void got.then((src) => { if (src) setPics((m) => ({ ...m, [t.id]: src })); });
    }
  }, [tabs, activeId, p, fly]);
  const hide = useCallback((pick?: string) => {
    const id = pick ?? activeId;
    if (id && pics[id]) fly(pics[id]!, box.current?.querySelector(`[data-tab="${id}"]`) ?? null, false);
    setOpen(false);
    // the pictures go with the overview; they are taken fresh the next time
    setTimeout(() => setPics({}), 600);
    if (pick && pick !== activeId) p.onShow(pick);
  }, [activeId, pics, fly, p]);

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

  const cls = "agx-isl" + (open ? " is-open" : "") + (tucked ? " is-tucked" : "") + (yours ? " is-yours" : "") + (act?.paused ? " is-taken" : "");
  const dot = act?.paused ? "is-taken" : working ? "is-working" : "";
  return (
    <>
      {open && <div className="agx-isl-scrim" onClick={() => hide()} />}
      <div ref={box} className={cls} role={open ? "dialog" : undefined} aria-label={open ? "Every tab" : undefined}>
        {!open && (
          <>
            <span className="agx-isl-compact" aria-hidden>
              <LivingMark size={16} style={{ color: "#a78bfa" }} />
              <span className={"agx-isl-dot " + dot} />
              <span className="agx-isl-num">{tabs.length}</span>
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
                <span className="agx-isl-doing"><span className={"agx-isl-dot " + dot} /><span className="agx-isl-doing-t">{act!.agent} · {p.doing || "working"}</span></span>
                <span className="agx-isl-num">{tabs.length}</span>
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
                <section key={g.profile} className={"agx-isl-box" + (g.held ? " is-agent" : "")} style={{ "--n": g.list.length + 1 } as React.CSSProperties}>
                  <header>
                    <span className="agx-isl-bn">{g.name}</span>
                    <span className="agx-isl-bc">{g.list.length} {g.list.length === 1 ? "tab" : "tabs"}{g.held ? ` · agent on ${g.held}` : ""}</span>
                    {g.state && <span className={"agx-isl-state is-" + g.state}><span className="agx-isl-dot" />{g.state === "yours" ? "you have it" : g.state}</span>}
                  </header>
                  <div className="agx-isl-row">
                    {g.list.map((t) => {
                      const who = acts[t.id]?.agent || t.agent;
                      return (
                        <div key={t.id} data-tab={t.id} role="button" tabIndex={0}
                          className={"agx-isl-card" + (t.id === activeId ? " is-on" : "")}
                          onClick={() => hide(t.id)} onKeyDown={(e) => { if (e.target !== e.currentTarget) return; if (e.key === "Enter" || e.key === " ") { e.preventDefault(); hide(t.id); } }}>
                          <div className={"agx-isl-thumb" + ((acts[t.id]?.working ?? 0) > 0 && !acts[t.id]!.paused ? " is-driven" : "")}>
                            {pics[t.id] ? <img src={pics[t.id]} alt="" /> : <span className="agx-isl-mono">{(t.title || host(t.url) || "?").slice(0, 1).toUpperCase()}{t.asleep && <small>Asleep</small>}</span>}
                            <button type="button" className="agx-isl-x" aria-label={`Close ${t.title || "tab"}`} onClick={(e) => { e.stopPropagation(); p.onClose(t.id); }}><CloseIcon size={12} /></button>
                          </div>
                          <div className="agx-isl-cap">
                            <span className="agx-isl-name">{t.title || host(t.url)}</span>
                            <span className={"agx-isl-who" + (who ? " is-agent" : "")}>{who ?? "You"}</span>
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
