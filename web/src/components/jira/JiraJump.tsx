/*
 * The Jira view's jump palette (mockup `#pal`): one box for a card, an epic, a saved search or a JQL line. Ctrl+K inside the
 * Jira view opens it (App asks `openJiraJump`); outside the view the app's own palette answers. The local sections show at once;
 * a JQL line gets its count after a typing pause (one count-only call), and a key not on the board is fetched on Enter.
 */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { JiraBoardEpic, ProviderTask } from "../../../../shared/providers.ts";
import type { BoardSource } from "../../lib/boardSource.ts";
import { api } from "../../lib/api.ts";
import { SearchIcon, StarIcon } from "../../lib/glyphIcons.tsx";
import { ICON } from "../../lib/iconSize.ts";
import { onJiraJump } from "../../lib/jiraQueryPalette.ts";
import { LAYER } from "../../lib/layers.ts";
import { useCloseWithOwner } from "../../lib/layerOwner.ts";
import { countLabel, type ViewCount } from "../../lib/jiraTree.ts";
import { Portal } from "../Portal.tsx";
import { LINE } from "../workspace/Chrome.tsx";
import { keyOf } from "./list/laneModel.ts";
import { epicsOf, jumpRows, placesOf, rankPlaces, type Place, loadRecent, projectOf, pushRecent, readTyped, saveRecent, sectionStep } from "./list/jumpModel.ts";
import type { SavedQuery } from "./list/tabsModel.ts";
import { jiraTreeNow, subscribeJiraTree } from "../../lib/useJiraTree.ts";
import { scopeIdOf } from "../../lib/jiraTree.ts";
import { agentUrgency, fleetNow, onFleet, workerFor } from "../../lib/jiraCardWork.ts";
import { openLive } from "./detail/cardWorkActions.ts";

const PAUSE_MS = 400;
const COUNT_KEEP_MS = 10 * 60_000;
const counted = new Map<string, { at: number; n: ViewCount }>();

type Item =
  | { id: string; sec: string; kind: "jql"; jql: string }
  | { id: string; sec: string; kind: "key"; key: string; epic?: JiraBoardEpic }
  | { id: string; sec: string; kind: "saved"; q: SavedQuery }
  | { id: string; sec: string; kind: "recent"; jql: string }
  | { id: string; sec: string; kind: "epic"; epic: JiraBoardEpic }
  | { id: string; sec: string; kind: "place"; place: Place }
  | { id: string; sec: string; kind: "card"; card: ProviderTask };

export interface JiraJumpProps {
  source: BoardSource;
  cards: readonly ProviderTask[];
  epics: readonly JiraBoardEpic[];
  queries: readonly SavedQuery[];
  /** Turns an account id in a name or a search into the person; the palette never draws one raw. */
  tidy: (text: string) => string;
  /** Only while the Jira view is the one on screen. */
  active: boolean;
  onOpenCard: (t: ProviderTask) => void;
  /** Run a JQL in the view's box and ask the site for all of it. */
  onRunJql: (jql: string) => void;
  /** Open a sidebar place (a space, a component) by its `scope:` id, as a click on its row does. */
  onOpenPlace: (scopeId: string) => void;
}

export function JiraJump({ source, cards, epics, queries, tidy, active, onOpenCard, onRunJql, onOpenPlace }: JiraJumpProps) {
  const [open, setOpen] = useState(false);
  const back = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!active) return;
    return onJiraJump(() => {
      setOpen((o) => {
        if (!o) back.current = document.activeElement as HTMLElement | null;
        return !o;
      });
    });
  }, [active]);
  /* Gone with what opened it. The palette is a Portal, so the bench closing
     over the board does not take it along, and it stayed open over the view
     underneath. Closed on the bench's own announcement (layerOwner.ts), which
     comes before the bench gives the keyboard back, so the terminal gets it
     rather than the page. A view that only stops being active (another page
     taken in the rail) closes it too. Neither path restores the focus: the
     thing that went away does that. */
  const hide = () => { setOpen(false); back.current = null; };
  useCloseWithOwner(hide, { open });
  useEffect(() => {
    if (!active) hide();
  }, [active]);
  const close = () => { setOpen(false); const el = back.current; back.current = null; if (el && el.isConnected) requestAnimationFrame(() => el.focus()); };
  if (!open) return null;
  return <Palette source={source} cards={cards} epics={epics} queries={queries} tidy={tidy} onOpenCard={onOpenCard} onRunJql={onRunJql} onOpenPlace={onOpenPlace} onClose={close} />;
}

function Palette({ source, cards, epics, queries, tidy, onOpenCard, onRunJql, onOpenPlace, onClose }: Omit<JiraJumpProps, "active"> & { onClose: () => void }) {
  const project = useMemo(() => projectOf(cards), [cards]);
  const [text, setText] = useState("");
  const [recent, setRecent] = useState(() => loadRecent(project));
  const [hot, setHot] = useState(0);
  const [counts, setCounts] = useState<Record<string, ViewCount>>({});
  const [jqlCount, setJqlCount] = useState<{ jql: string; n?: number; err?: boolean } | null>(null);
  const [looking, setLooking] = useState<string | null>(null);
  const [miss, setMiss] = useState<string | null>(null);
  const typed = readTyped(text, project);
  const tree = useSyncExternalStore(subscribeJiraTree, jiraTreeNow, jiraTreeNow);
  const places = useMemo(() => placesOf(tree.spaces, tree.reads), [tree.spaces, tree.reads]);
  const found = useMemo(() => (text.trim() && typed.kind === "none" ? rankPlaces(places, text.trim()) : []), [places, text, typed.kind]);
  /* The site's own words search, asked for every query of two or more letters after a pause in typing (the one the board's search box uses). */
  const [site, setSite] = useState<{ q: string; tasks?: ProviderTask[]; err?: boolean } | null>(null);
  const rows = useMemo(() => jumpRows({ text, queries, recent, epics, cards }), [text, queries, recent, epics, cards]);
  /* Nothing typed yet: the board's cards an agent is on lead the list, the ones waiting on you first, then stalled or errored. */
  const fleet = useSyncExternalStore(onFleet, fleetNow, fleetNow);
  const agented = useMemo(() => {
    if (text.trim()) return [];
    const withW = cards.map((c) => ({ c, w: workerFor(keyOf(c), fleet) })).filter((x) => !!x.w);
    return withW.sort((a, b) => agentUrgency(a.w!.status) - agentUrgency(b.w!.status)).slice(0, 5).map((x) => x.c);
  }, [text, cards, fleet]);

  const items = useMemo<Item[]>(() => {
    const out: Item[] = [];
    if (typed.kind === "jql") out.push({ id: "jql", sec: "Run", kind: "jql", jql: typed.jql });
    if (typed.kind === "key") {
      const localEpic = epicsOf(epics, cards).find((e) => e.key.toUpperCase() === typed.key.toUpperCase());
      out.push({ id: "key", sec: localEpic ? "Epic" : "Jump", kind: "key", key: typed.key, epic: localEpic });
    }
    for (const c of agented) out.push({ id: "a:" + c.id, sec: "With an agent", kind: "card", card: c });
    const words = !!text.trim();
    const placeEpics = new Set(found.filter((p) => p.kind === "epic").map((p) => p.key.toUpperCase()));
    const saved = () => { for (const q of rows.saved) out.push({ id: "s:" + q.id, sec: words ? "Places" : "Saved queries", kind: "saved", q }); };
    const recent = () => { for (const r of rows.recent) out.push({ id: "r:" + r, sec: "Recent", kind: "recent", jql: r }); };
    const epicRows = () => {
      for (const p of found) out.push({ id: "p:" + p.id, sec: "Places", kind: "place", place: p });
      for (const e of rows.epics) if (!placeEpics.has(e.key.toUpperCase())) out.push({ id: "e:" + e.key, sec: words ? "Places" : "Epics", kind: "epic", epic: e });
    };
    /* Typed words put the places first, so the Places header is one block; with nothing typed the list is as it was. */
    if (words) { saved(); epicRows(); recent(); } else { saved(); recent(); epicRows(); }
    const shown = new Set(agented.map((c) => c.id));
    for (const c of rows.cards) if (!shown.has(c.id)) out.push({ id: "c:" + c.id, sec: words ? "On this board" : "Cards", kind: "card", card: c });
    if (site && site.q === text.trim() && site.tasks) {
      const have = new Set(cards.map((c) => c.id));
      for (const c of site.tasks) if (!have.has(c.id)) out.push({ id: "j:" + c.id, sec: "In Jira", kind: "card", card: c });
    }
    return out;
  }, [typed.kind, typed.kind === "jql" ? typed.jql : typed.kind === "key" ? typed.key : "", rows, agented, found, site]); // eslint-disable-line react-hooks/exhaustive-deps

  /* Counts of the saved rows on screen: at most 7, one count-only call each, kept 10 minutes. */
  const savedIds = rows.saved.map((q) => q.id).join("\n");
  useEffect(() => {
    const ac = new AbortController();
    const now = Date.now();
    for (const q of rows.saved) {
      const kept = counted.get(q.id);
      if (kept && now - kept.at < COUNT_KEEP_MS) { setCounts((c) => ({ ...c, [q.id]: kept.n })); continue; }
      void api.jiraViewCount(q.id, ac.signal).then((r) => {
        if (ac.signal.aborted) return;
        const n: ViewCount = r.ok && typeof r.count === "number" ? { n: r.count, more: !!r.more } : "err";
        if (n !== "err") counted.set(q.id, { at: Date.now(), n });
        setCounts((c) => ({ ...c, [q.id]: n }));
      }).catch(() => {});
    }
    return () => ac.abort();
  }, [savedIds]); // eslint-disable-line react-hooks/exhaustive-deps

  /* A JQL line is counted after a pause in typing; typing again cancels the call. */
  const jqlLine = typed.kind === "jql" ? typed.jql : null;
  useEffect(() => {
    setJqlCount(null);
    if (!jqlLine) return;
    const ac = new AbortController();
    const timer = setTimeout(() => {
      void api.jiraJqlCount(jqlLine, ac.signal).then((r) => {
        if (!ac.signal.aborted) setJqlCount(r.ok && typeof r.count === "number" ? { jql: jqlLine, n: r.count } : { jql: jqlLine, err: true });
      }).catch(() => {});
    }, PAUSE_MS);
    return () => { clearTimeout(timer); ac.abort(); };
  }, [jqlLine]);

  const words = text.trim();
  /* Global, never scoped to the epic or view open: the board holds only that page's cards, so words always ask the site too. */
  const askSite = typed.kind === "none" && words.length >= 2;
  const nothingLocal = askSite && !rows.saved.length && !rows.cards.length && !rows.epics.length && !found.length;
  useEffect(() => {
    setSite(null);
    if (!askSite) return;
    const ac = new AbortController();
    const timer = setTimeout(() => {
      void source.search(words, false, ac.signal).then((r) => {
        if (!ac.signal.aborted) setSite({ q: words, tasks: r.ok ? (r.tasks ?? []).slice(0, 8) : undefined, err: !r.ok });
      }).catch(() => { if (!ac.signal.aborted) setSite({ q: words, err: true }); });
    }, PAUSE_MS);
    return () => { clearTimeout(timer); ac.abort(); };
  }, [askSite, words]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { setHot(0); setMiss(null); }, [text]);

  const runJql = (jql: string) => {
    const next = pushRecent(recent, jql);
    setRecent(next); saveRecent(project, next);
    onRunJql(jql);
    onClose();
  };
  const openKey = async (key: string, epic?: JiraBoardEpic) => {
    if (epic) { runJql("parent = " + epic.key); return; }
    const hit = cards.find((t) => keyOf(t).toUpperCase() === key.toUpperCase());
    if (hit) { onOpenCard(hit); onClose(); return; }
    setLooking(key); setMiss(null);
    try {
      const r = await source.find(key);
      if (!r.ok || !r.task) { setMiss(r.error ?? "Jira has no such card"); return; }
      if ((r.task.issueType ?? "").toLowerCase() === "epic") runJql("parent = " + key);
      else { onOpenCard(r.task); onClose(); }
    } catch { setMiss("Could not reach the server"); }
    finally { setLooking(null); }
  };
  const choose = (it: Item | undefined) => {
    if (!it) return;
    if (it.kind === "jql" || it.kind === "recent") runJql(it.jql);
    else if (it.kind === "saved") runJql(it.q.jql);
    else if (it.kind === "key") void openKey(it.key, it.epic);
    else if (it.kind === "epic") runJql("parent = " + it.epic.key);
    else if (it.kind === "place") {
      const p = it.place;
      if (p.kind === "epic") { runJql("parent = " + p.key); return; }
      const id = scopeIdOf(p.kind === "space" ? { kind: "space", space: p.space } : { kind: "component", space: p.space, component: p.component });
      if (id) { onOpenPlace(id); onClose(); }
    }
    else { onOpenCard(it.card); onClose(); }
  };

  const keyRef = useRef({ items, hot, text });
  keyRef.current = { items, hot, text };
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const { items: list, hot: at } = keyRef.current;
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onClose(); return; }
      if (e.key === "ArrowDown") { e.preventDefault(); setHot((h) => Math.min(h + 1, list.length - 1)); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); setHot((h) => Math.max(h - 1, 0)); return; }
      if (e.key === "Tab" && list.length) {
        e.preventDefault();
        setHot(sectionStep(list.map((x) => x.sec), at, e.shiftKey ? -1 : 1));
        return;
      }
      /* Shift+Enter on a card an agent is on: its tab, not the card, for the answer the agent is waiting for. */
      if (e.key === "Enter" && e.shiftKey) {
        const it = list[at]; const w = it?.kind === "card" ? workerFor(keyOf(it.card), fleetNow()) : null;
        if (w) { e.preventDefault(); openLive(null, w); onClose(); return; }
      }
      if (e.key === "Enter") { e.preventDefault(); choose(list[at]); }
    };
    document.addEventListener("keydown", key, true);
    return () => document.removeEventListener("keydown", key, true);
  }); // eslint-disable-line react-hooks/exhaustive-deps

  const sections: { sec: string; from: number }[] = [];
  items.forEach((it, i) => { if (!sections.length || sections[sections.length - 1]!.sec !== it.sec) sections.push({ sec: it.sec, from: i }); });
  const label = (sec: string) => sec.toUpperCase();

  return (
    <Portal find z={LAYER.viewer}>
      <div className="fixed inset-0 flex justify-center" data-testid="jira-jump" style={{ background: "color-mix(in srgb, var(--shadow) 35%, transparent)", paddingTop: "12vh" }}
        onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
        <div role="dialog" aria-modal="true" aria-label="Jump to a card, epic or search" className="flex flex-col self-start"
          style={{ width: "min(640px, 92vw)", maxHeight: "70vh", borderRadius: 14, background: "var(--bg)", boxShadow: "inset 0 0 0 1px color-mix(in srgb, var(--text) 12%, transparent), 0 30px 60px -24px var(--shadow)" }}>
          <div className="flex items-center shrink-0" style={{ gap: 8, padding: "14px 16px 10px", color: "var(--text3)" }}>
            <SearchIcon size={ICON.md} />
            <input autoFocus value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} aria-label="Jump to card or epic, or type JQL"
              placeholder="Jump to card or epic, or type JQL: status = 'Code review' AND assignee = me"
              className="flex-1 min-w-0 bg-transparent outline-none text-[13px]" style={{ color: "var(--text)", caretColor: "var(--primary)" }} />
          </div>
          <div className="agx-scroll min-h-0 overflow-y-auto flex flex-col" role="listbox" aria-label="Results" style={{ padding: "0 8px 8px" }}>
            {sections.map(({ sec, from }, si) => {
              const end = si + 1 < sections.length ? sections[si + 1]!.from : items.length;
              return (
                <div key={sec} role="group" aria-label={sec}>
                  <div style={{ padding: "8px 8px 4px", fontSize: 10, letterSpacing: ".06em", color: "var(--text3)" }}>{sec === "Run" || sec === "Jump" ? "" : label(sec)}</div>
                  {items.slice(from, end).map((it, k) => {
                    const i = from + k;
                    return (
                      <button key={it.id} type="button" role="option" aria-selected={i === hot} onMouseEnter={() => setHot(i)} onClick={() => choose(it)}
                        className="flex items-center text-left min-w-0 w-full"
                        style={{ gap: 8, minHeight: 34, padding: "0 10px", borderRadius: 8, fontSize: 12, background: i === hot ? "color-mix(in srgb, var(--text) 6%, transparent)" : "transparent" }}>
                        {it.kind === "jql" && (<>
                          <span className="shrink-0 font-semibold" style={{ color: "var(--primary)" }}>Run as JQL</span>
                          <span className="min-w-0 flex-1 truncate" style={{ color: "var(--text3)" }}>{tidy(it.jql)}</span>
                          <span className="shrink-0 tabular-nums" style={{ color: "var(--text3)", opacity: jqlCount && jqlCount.jql === it.jql && jqlCount.n !== undefined ? 1 : 0.5 }}>
                            {jqlCount && jqlCount.jql === it.jql ? (jqlCount.n !== undefined ? jqlCount.n + " cards" : jqlCount.err ? "—" : "Searching Jira...") : "Searching Jira..."}
                          </span>
                        </>)}
                        {it.kind === "key" && (<>
                          <span className="shrink-0 tabular-nums" style={{ fontSize: 10.5, padding: "2px 6px", borderRadius: 5, boxShadow: "inset 0 0 0 1px color-mix(in srgb, var(--text) 14%, transparent)" }}>{it.key}</span>
                          <span className="min-w-0 flex-1 truncate" style={{ color: "var(--text)" }}>
                            {it.epic ? it.epic.name : cards.find((t) => keyOf(t).toUpperCase() === it.key)?.title ?? (looking === it.key ? "Searching Jira..." : "Open " + it.key)}
                          </span>
                          {it.epic && (
                            <span className="shrink-0" style={{ fontSize: 11, fontWeight: 600, color: "var(--warning)", background: "color-mix(in srgb, var(--warning) 16%, transparent)", borderRadius: 5, padding: "1px 8px" }}>
                              Epic · Enter opens task list
                            </span>
                          )}
                        </>)}
                        {it.kind === "saved" && (<>
                          <StarIcon size={ICON.sm} filled />
                          <span className="shrink-0 truncate" style={{ color: "var(--text)", maxWidth: 200 }}>{tidy(it.q.name)}</span>
                          <span className="min-w-0 flex-1 truncate" style={{ color: "var(--text3)" }}>{tidy(it.q.jql)}</span>
                          <span className="shrink-0 tabular-nums" style={{ color: "var(--text3)" }}>{countLabel(counts[it.q.id])}</span>
                        </>)}
                        {it.kind === "recent" && <span className="min-w-0 flex-1 truncate" style={{ color: "var(--text)" }}>{tidy(it.jql)}</span>}
                        {it.kind === "place" && (<>
                          <span className="shrink-0 tabular-nums" style={{ fontSize: 10.5, color: "var(--text3)" }}>{it.place.kind === "epic" ? it.place.key : it.place.space}</span>
                          <span className="min-w-0 flex-1 truncate" style={{ color: "var(--text)" }}>{it.place.name}</span>
                          <span className="shrink-0" style={{ fontSize: 11, color: "var(--text3)" }}>{it.place.kind === "epic" ? "Epic" : it.place.kind === "space" ? "Space" : "Component"}</span>
                        </>)}
                        {it.kind === "epic" && (<>
                          <span className="shrink-0 tabular-nums" style={{ fontSize: 10.5, color: "var(--text3)" }}>{it.epic.key}</span>
                          <span className="min-w-0 flex-1 truncate" style={{ color: "var(--text)" }}>{it.epic.name}</span>
                          <span className="shrink-0" style={{ fontSize: 11, fontWeight: 600, color: "var(--warning)", background: "color-mix(in srgb, var(--warning) 16%, transparent)", borderRadius: 5, padding: "1px 8px" }}>Epic</span>
                        </>)}
                        {it.kind === "card" && (<>
                          <span className="shrink-0 tabular-nums" style={{ fontSize: 10.5, padding: "2px 6px", borderRadius: 5, boxShadow: "inset 0 0 0 1px color-mix(in srgb, var(--text) 14%, transparent)" }}>{keyOf(it.card)}</span>
                          <span className="min-w-0 flex-1 truncate" style={{ color: "var(--text)" }}>{it.card.title}</span>
                          {(() => {
                            /* The agent's own words beat the status: needs you, or what it is doing right now. */
                            const w = workerFor(keyOf(it.card), fleet);
                            if (w?.status === "waiting") return <span className="shrink-0" style={{ color: "var(--warning-ink)", fontWeight: 600 }}>needs you</span>;
                            if (w?.status === "stalled" || w?.status === "errored") return <span className="shrink-0" style={{ color: "var(--error-ink)", fontWeight: 600 }}>{w.status}</span>;
                            if (w?.status === "working" && w.doing) return <span className="shrink-0 truncate" style={{ color: "var(--text3)", maxWidth: 180 }}>{w.doing}</span>;
                            return <span className="shrink-0 truncate" style={{ color: "var(--text3)", maxWidth: 140 }}>{it.card.status}</span>;
                          })()}
                        </>)}
                      </button>
                    );
                  })}
                </div>
              );
            })}
            {!items.length && nothingLocal && !(site && site.q === words) && <div style={{ padding: "16px 10px", fontSize: 12, color: "var(--text3)" }}>Searching Jira...</div>}
            {!items.length && (!nothingLocal || (site && site.q === words)) && <div style={{ padding: "16px 10px", fontSize: 12, color: "var(--text3)" }}>{site && site.q === words && site.err ? "Jira search failed. Try a key, a number or a JQL line." : "Nothing here matches. Type a key, a number or a JQL line."}</div>}
            {miss && <div role="status" style={{ padding: "6px 10px", fontSize: 11, color: "var(--error-ink)" }}>{miss}</div>}
          </div>
          <div className="flex items-center shrink-0" style={{ gap: 12, padding: "8px 16px", fontSize: 10.5, color: "var(--text3)", borderTop: LINE }}>
            <span>Up/Down navigate</span><span>Enter jump</span><span>⇧Enter agent's tab</span><span>Esc close</span>
            <span className="flex-1" /><span>bare number = key, &quot;q:&quot; = JQL</span>
          </div>
        </div>
      </div>
    </Portal>
  );
}
