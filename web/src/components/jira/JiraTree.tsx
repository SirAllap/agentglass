/*
 * The Tasks > Jira sidebar: space > component > epic, drawn from the rows
 * lib/jiraTree.ts decides. Row sizes, indents and gaps are the mockup's
 * spacing table: a rail row is 28 and an epic row 44, the row box always starts
 * at the rail's 8 and the indent is padding inside it (8 + 16 * level), so a
 * fill never moves when a branch opens.
 *
 * Choosing a row only WRITES the selection (`api.select`); what the main pane
 * does with it is the pane's own business.
 */
import { Fragment, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { PrCardMenu } from "../PrCardMenu.tsx";
import { CTRL_H, LINE } from "../workspace/Chrome.tsx";
import { ICON } from "../../lib/iconSize.ts";
import { tipAttr, type TipSpec } from "../../lib/tip.ts";
import { Face } from "../TrackerPeoplePick.tsx";
import { openExternal } from "../../lib/externalUrl.ts";
import { BoxIcon, ClockIcon, EyeIcon, EyeOffIcon, FlagIcon, ListIcon, MoreIcon, SearchIcon } from "../../lib/glyphIcons.tsx";
import type { JiraTreeApi } from "../../lib/useJiraTree.ts";
import {
  EPIC_H, ROW_H, browseUrl, buildRows, componentMenu, componentUrl, epicMenu, epicProgress, epicTip, focusable, keyC, keyE, keyS, meMenu,
  rowSelected, spaceMenu, targetOf, toneOf, viewMenu, type TreeMenuId, type TreeRow, type TreeSelection, type TreeView,
  SHAPES, shapeOf, type TreeShape,
} from "../../lib/jiraTree.ts";
import type { CardMenu } from "../../lib/prCardMenu.ts";

const ring = "color-mix(in srgb, var(--text) 14%, transparent)";
const hair = "color-mix(in srgb, var(--text) 10%, transparent)";

/** What the screen around the tree owns: the rows that are not Jira spaces, and how to reach them. */
export interface TreeOutside {
  q: string;
  /** Jira reports no connection: the rail says so and nothing else. */
  connected: boolean | null;
  views: TreeView[];
  meCount?: number;
  meFace?: ReactNode;
  looked: number;
  sprint?: string;
  /** Which of the outside rows is the lit one. */
  lit: { me?: boolean; looked?: boolean; sprint?: boolean; view?: string | null };
  onMe: () => void;
  onLooked: () => void;
  onSprint: () => void;
  onView: (id: string) => void;
  onTakeOffView: (id: string) => void;
  /** A space, component or epic was chosen: the screen may want to follow. */
  onPicked: (sel: TreeSelection) => void;
  onReadMe: () => void;
  /** Rows the screen draws itself (folders and lists saved before spaces), under the tree. */
  legacy?: ReactNode;
}

const Tile = ({ children, tone, dashed, dim }: { children: ReactNode; tone?: string; dashed?: boolean; dim?: boolean }) => (
  <span aria-hidden className="shrink-0 grid place-items-center" style={{
    width: 20, height: 20, borderRadius: 6, color: tone ?? "var(--text3)", opacity: dim ? 0.55 : undefined,
    background: dashed ? "transparent" : `color-mix(in srgb, ${tone ?? "var(--text3)"} 14%, transparent)`,
    boxShadow: dashed ? undefined : `inset 0 0 0 1px color-mix(in srgb, ${tone ?? "var(--text3)"} 30%, transparent)`,
    outline: dashed ? "1px dashed var(--border)" : undefined, outlineOffset: dashed ? -1 : undefined,
    font: "700 9.5px/1 var(--font-mono, ui-monospace, monospace)",
  }}>{children}</span>
);

const Chev = ({ open }: { open: boolean }) => (
  <svg viewBox="0 0 16 16" width={ICON.xs} height={ICON.xs} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"
    className="agx-rail-chev" style={{ transform: open ? "rotate(90deg)" : "none" }}><path d="M6 3.5 10.5 8 6 12.5" /></svg>
);

const count = (n: ReactNode, style?: CSSProperties) => (
  <span className="tabular-nums shrink-0" style={{ fontSize: 10.5, color: "var(--text4)", ...style }}>{n}</span>
);

export function JiraTree({ api, out, onCloseLegacyMenu }: { api: JiraTreeApi; out: TreeOutside; onCloseLegacyMenu?: () => void }) {
  const [menu, setMenu] = useState<{ row: TreeRow; x: number; y: number } | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [focus, setFocus] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const p = api.prefs;
  const rows = useMemo(() => buildRows({
    spaces: api.spaces, reads: api.reads, prefs: p, q: out.q, views: out.views.map((v) => ({ ...v, label: p.names[v.id] ?? v.label })),
    meCount: out.meCount, looked: out.looked, sprint: out.sprint, listed: api.listed, listError: api.listError,
  }), [api.spaces, api.reads, p, out.q, out.views, out.meCount, out.looked, out.sprint, api.listed, api.listError]);
  const stops = useMemo(() => focusable(rows), [rows]);
  const stop = stops.some((r) => r.key === focus) ? focus : (stops.find((r) => out.lit.me ? r.kind === "me" : rowSelected(r, api.selection)) ?? stops[0])?.key ?? null;
  const site = api.site;

  const focusKey = (key: string) => {
    setFocus(key);
    root.current?.querySelector<HTMLElement>(`[data-tree-key="${CSS.escape(key)}"]`)?.focus();
  };
  const choose = (r: TreeRow) => {
    onCloseLegacyMenu?.();
    if (r.kind === "me") { api.select(null); out.onMe(); return; }
    if (r.kind === "looked") { api.select(null); out.onLooked(); return; }
    if (r.kind === "sprint") { out.onSprint(); return; }
    if (r.kind === "more") { api.flag("all", keyC(r.space, r.component), true); return; }
    if (r.kind === "view") { const t = targetOf(r); if (t) api.select(t); else api.select(null); out.onView(r.view.id); return; }
    const t = targetOf(r);
    if (!t) return;
    api.select(t);
    if (r.kind === "space" && !r.open) api.toggle(keyS(r.space.key), true);
    if (r.kind === "component" && !r.open && r.hasKids) api.toggle(r.key, true);
    out.onPicked(t);
  };
  const toggleRow = (r: TreeRow, to?: boolean) => {
    if (r.kind === "space") api.toggle(r.key, to ?? !r.open);
    else if (r.kind === "component" && r.hasKids) api.toggle(r.key, to ?? !r.open);
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const el = (e.target as HTMLElement).closest<HTMLElement>('[role="treeitem"]');
    if (!el || (e.target as HTMLElement).tagName === "INPUT") return;
    const at = stops.findIndex((r) => r.key === el.dataset.treeKey);
    const r = stops[at];
    if (!r) return;
    const go = (to: number) => { e.preventDefault(); const t = stops[Math.max(0, Math.min(stops.length - 1, to))]; if (t) focusKey(t.key); };
    if (e.key === "ArrowDown") go(at + 1);
    else if (e.key === "ArrowUp") go(at - 1);
    else if (e.key === "Home") go(0);
    else if (e.key === "End") go(stops.length - 1);
    else if (e.key === "ArrowRight") { e.preventDefault(); if ((r.kind === "space" || r.kind === "component") && !(r as { open: boolean }).open) toggleRow(r, true); else go(at + 1); }
    else if (e.key === "ArrowLeft") {
      e.preventDefault();
      if ((r.kind === "space" || r.kind === "component") && (r as { open: boolean }).open) toggleRow(r, false);
      else { const up = stops.slice(0, at).reverse().find((x) => x.level < r.level); if (up) focusKey(up.key); }
    } else if (e.key === "Enter" || e.key === " ") { e.preventDefault(); choose(r); }
    else if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) {
      e.preventDefault();
      const b = el.getBoundingClientRect();
      setMenu({ row: r, x: b.left + 48, y: b.bottom });
    }
  };

  /* Reveals an epic where it also sits: opens that component, shows all of its epics, and puts the keyboard on the row. */
  const showUnder = (space: string, component: string, epic: string) => {
    const ck = keyC(space, component);
    api.toggle(ck, true);
    api.flag("all", ck, true);
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const el = root.current?.querySelector<HTMLElement>(`[data-tree-key="${CSS.escape(keyE(space, component, epic))}"]`);
      el?.scrollIntoView({ block: "nearest" });
      el?.focus();
    }));
  };

  const copy = (text: string) => { void navigator.clipboard?.writeText(text).catch(() => {}); };
  const facts = (key: string, hidden = 0) => ({ hidden, site: !!site, pinned: !!p.pinned[key] });
  const hiddenIn = (space: string) => Object.keys(p.hidden).filter((k) => k.startsWith(`c:${space}/`) || k.startsWith(`e:${space}/`)).length;

  const menuOf = (r: TreeRow): CardMenu<TreeMenuId> | null => {
    switch (r.kind) {
      case "space": return spaceMenu(r.space, facts(r.key, hiddenIn(r.space.key)), shapeOf(api.prefs, r.space.key));
      case "component": {
        const tree = api.reads[r.space]?.tree;
        const empties = (tree?.components ?? []).filter((c) => c.empty && c.id !== undefined).map((c) => c.name);
        return componentMenu(api.spaces.find((s) => s.key === r.space)?.name ?? r.space, { name: r.name, issues: r.issues, empty: r.empty }, { ...facts(r.key), empties, none: r.none });
      }
      case "epic": return epicMenu(r.epic, r.component ?? "", r.also, facts(r.key));
      case "me": return meMenu(r.count);
      case "view": return viewMenu(r.view, facts(r.key));
      default: return null;
    }
  };
  const act = (r: TreeRow, id: TreeMenuId) => {
    const space = r.kind === "space" ? r.space.key : "space" in r && typeof r.space === "string" ? r.space : "";
    switch (id) {
      case "open": choose(r); break;
      case "jira":
        if (!site) break;
        if (r.kind === "space") openExternal(browseUrl(site, r.space.key));
        else if (r.kind === "component") openExternal(componentUrl(site, r.space, r.none ? undefined : r.name));
        else if (r.kind === "epic") openExternal(browseUrl(site, r.epic.key));
        else if (r.kind === "view") openExternal(r.view.url);
        break;
      case "under": if (r.kind === "epic" && r.also[0]) showUnder(r.space, r.also[0], r.epic.key); break;
      case "pin": api.flag("pinned", r.key, !p.pinned[r.key]); break;
      case "hide": api.flag("hidden", r.key, true); break;
      case "showhidden":
        api.setPrefs((x) => ({ ...x, hidden: Object.fromEntries(Object.entries(x.hidden).filter(([k]) => !k.startsWith(`c:${space}/`) && !k.startsWith(`e:${space}/`))) }));
        break;
      case "reread": if (r.kind === "me") out.onReadMe(); else if (space) void api.read(space, true); break;
      case "copykey": copy(r.kind === "space" ? r.space.key : r.kind === "epic" ? r.epic.key : ""); break;
      case "copylink":
        if (!site) break;
        copy(r.kind === "epic" ? browseUrl(site, r.epic.key) : r.kind === "component" ? componentUrl(site, r.space, r.none ? undefined : r.name) : "");
        break;
      case "copyaddr": if (r.kind === "space" && site) copy(browseUrl(site, r.space.key)); else if (r.kind === "view" && r.view.url) copy(r.view.url); break;
      case "collapse":
        if (r.kind === "space") for (const c of api.reads[r.space.key]?.tree?.components ?? []) api.toggle(keyC(r.space.key, c.id ? c.name : undefined), false);
        else if (r.kind === "component") api.toggle(r.key, false);
        break;
      case "hideempty": api.flag("hideEmpty", space, true); break;
      case "shape:both": case "shape:epics": api.setShape(space, id.slice(6) as TreeShape); break;
      case "takeoff":
        if (r.kind === "space") void api.edit({ remove: r.space.key });
        else if (r.kind === "view") out.onTakeOffView(r.view.id);
        break;
      case "hideme": api.setPrefs((x) => ({ ...x, hideMe: true })); break;
      case "rename": if (r.kind === "view") setRenaming(r.view.id); break;
      case "edit": break;
    }
  };

  const guides = (lv: number) => Array.from({ length: lv }, (_, k) => (
    <i key={k} aria-hidden className="absolute" style={{ left: 16 + 16 * k, top: 0, bottom: 0, width: 1, background: hair }} />
  ));

  const shell = (r: TreeRow, body: ReactNode, o: { h?: number; lv?: number; tip?: string | TipSpec; label: string; expanded?: boolean; dim?: boolean; busy?: boolean } = { label: "" }) => {
    const sel = out.lit.me ? r.kind === "me" : r.kind === "looked" ? !!out.lit.looked : r.kind === "sprint" ? !!out.lit.sprint : r.kind === "view" ? out.lit.view === r.view.id || rowSelected(r, api.selection) : rowSelected(r, api.selection);
    const lv = o.lv ?? r.level;
    return (
      <div key={r.key} role="treeitem" data-tree-key={r.key} aria-level={lv + 1} aria-expanded={o.expanded} aria-selected={sel} aria-busy={o.busy || undefined}
        aria-label={o.label} tabIndex={stop === r.key ? 0 : -1}
        data-tip={o.tip ? tipAttr(o.tip) : undefined}
        onFocus={() => setFocus(r.key)}
        onClick={() => choose(r)}
        onContextMenu={(e) => { if (!menuOf(r)) return; e.preventDefault(); e.stopPropagation(); setMenu({ row: r, x: e.clientX, y: e.clientY }); }}
        className="agx-rail-row group relative flex items-center select-none"
        style={{
          height: o.h ?? ROW_H, gap: 6, paddingLeft: 8 + 16 * lv, paddingRight: 8, borderRadius: 8, cursor: "pointer", fontSize: 12,
          color: sel ? "var(--text)" : "var(--text2)", fontWeight: sel ? 600 : 400, outlineOffset: -2,
        }}>
        {sel && <span aria-hidden className="absolute" style={{ left: 0, top: 6, bottom: 6, width: 2, borderRadius: 2, background: "var(--primary)" }} />}
        {guides(lv)}
        {body}
        {/* The right-click menu is where a space or a board leaves the sidebar, and nobody right-clicks to look: the same menu, one press away. Shown on hover and on focus; the space is kept so a count never moves. */}
        {(r.kind === "space" || r.kind === "view") && (
          <button type="button" tabIndex={-1} aria-label={`More for ${o.label}`} aria-haspopup="menu" aria-expanded={menu?.row.key === r.key} data-tip="More"
            onClick={(e) => { e.stopPropagation(); const b = e.currentTarget.getBoundingClientRect(); setMenu({ row: r, x: b.left, y: b.bottom + 4 }); }}
            className="agx-btn shrink-0 grid place-items-center opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 aria-expanded:opacity-100"
            style={{ width: CTRL_H.compact, height: CTRL_H.compact, borderRadius: 6, color: "var(--text3)" }}>
            <MoreIcon size={ICON.sm} />
          </button>
        )}
      </div>
    );
  };

  const twisty = (r: TreeRow, open: boolean | undefined) => (
    <span aria-hidden className="shrink-0 grid place-items-center" style={{ width: 16, height: 16, color: "var(--text4)" }}
      onClick={open === undefined ? undefined : (e) => { e.stopPropagation(); toggleRow(r); }}>
      {open !== undefined && <Chev open={open} />}
    </span>
  );

  const rename = (v: TreeView) => (
    <input autoFocus defaultValue={p.names[v.id] ?? v.label} aria-label="Rename" spellCheck={false}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Escape") setRenaming(null);
        if (e.key === "Enter") {
          const t = e.currentTarget.value.trim();
          api.setPrefs((x) => { const names = { ...x.names }; if (t && t !== v.label) names[v.id] = t; else delete names[v.id]; return { ...x, names }; });
          setRenaming(null);
        }
      }}
      onBlur={() => setRenaming(null)}
      className="min-w-0 flex-1 rounded-md" style={{ height: 22, padding: "0 6px", background: "var(--surface-inset, var(--bg2))", boxShadow: `inset 0 0 0 1px ${ring}`, fontSize: 12 }} />
  );

  const draw = (r: TreeRow): ReactNode => {
    switch (r.kind) {
      case "caption":
        return <div key={r.key} role="presentation" className="flex items-center" style={{ height: 22, padding: "0 8px", marginTop: 12, fontSize: 10.5, letterSpacing: "0.04em", textTransform: "uppercase", color: "var(--text4)" }}>{r.label}</div>;
      case "components":
        return (
          <div key={r.key} role="presentation" className="flex items-center" style={{ height: 22, gap: 6, marginTop: 8, padding: "0 8px 0 24px", fontSize: 10.5, letterSpacing: "0.04em", textTransform: "uppercase", color: "var(--text4)" }}>
            <span style={{ letterSpacing: 0, textTransform: "none" }}>View by</span>
            <div role="radiogroup" aria-label="View this space by" className="flex items-center" style={{ height: 20, padding: 2, gap: 2, borderRadius: 8, background: "var(--surface-inset, var(--bg2))" }}>
              {SHAPES.map((x) => {
                const on = r.shape === x.id;
                return (
                  <button key={x.id} role="radio" aria-checked={on} onClick={() => api.setShape(r.space, x.id)} data-tip={x.sub}
                    className="agx-btn" style={{ height: 16, padding: "0 8px", borderRadius: 6, fontSize: 10.5, letterSpacing: 0, textTransform: "none", color: on ? "var(--text1, var(--text))" : "var(--text3)", background: on ? "var(--surface-raised, var(--bg))" : "transparent", fontWeight: on ? 600 : 400 }}>
                    {x.label}
                  </button>
                );
              })}
            </div>
            <span className="flex-1" />
            {r.hid > 0 && <span style={{ letterSpacing: 0, textTransform: "none" }}>{r.hid} empty hidden</span>}
            {r.canHide && (
              <button onClick={() => api.flag("hideEmpty", r.space, !r.hideEmpty)} aria-pressed={r.hideEmpty}
                aria-label={r.hideEmpty ? "Show components with no issues" : "Hide components with no issues"}
                data-tip={r.hideEmpty ? "Show components with no issues" : "Hide components with no issues"}
                className="agx-btn shrink-0 grid place-items-center"
                style={{ width: 20, height: 20, borderRadius: 6, color: r.hideEmpty ? "var(--info-ink)" : "var(--text3)", background: r.hideEmpty ? "color-mix(in srgb, var(--info) 12%, transparent)" : undefined }}>
                {r.hideEmpty ? <EyeOffIcon size={ICON.xs} /> : <EyeIcon size={ICON.xs} />}
              </button>
            )}
          </div>
        );
      case "me":
        return shell(r, <>
          {twisty(r, undefined)}
          {out.meFace ?? <span aria-hidden style={{ width: 16, height: 16, borderRadius: 999, border: "1.5px solid var(--text3)" }} />}
          <span className="truncate min-w-0 flex-1">{r.label}</span>{r.count != null && count(r.count)}
        </>, { label: r.label, tip: "Your open cards, on the site you connected." });
      case "looked":
        return shell(r, <>
          {twisty(r, undefined)}<ClockIcon size={ICON.sm} className="shrink-0" />
          <span className="truncate min-w-0 flex-1">{r.label}</span>{count(r.count)}
        </>, { label: r.label, tip: "Cards you have opened by id. Forgotten when the app closes." });
      case "sprint":
        return shell(r, <>
          {twisty(r, undefined)}<FlagIcon size={ICON.sm} className="shrink-0" />
          <span className="truncate min-w-0 flex-1">{r.label}</span>{count("active")}
        </>, { label: r.label, tip: "The active sprint of the open board" });
      case "space": {
        const tone = toneOf(r.space.key);
        return shell(r, <>
          {twisty(r, r.open)}<Tile tone={tone}>{r.space.key[0]}</Tile>
          <span className="truncate min-w-0 flex-1" data-tip={tipAttr(r.space.name)} style={{ fontWeight: 600, color: "var(--text)" }}>{r.space.name}</span>
          {r.error
            ? <span className="shrink-0 tabular-nums" data-tip={tipAttr(r.throttled ? "Jira is slowing us down. Showing the last read." : "Could not read this space")} style={{ fontSize: 10.5, color: "var(--error-ink)" }}>!</span>
            : r.count != null && count(r.count)}
        </>, { label: `${r.space.name}, ${r.space.key}`, expanded: r.open, busy: r.loading });
      }
      case "component":
        return shell(r, <>
          {twisty(r, r.hasKids ? r.open : undefined)}
          <Tile dashed={r.none} dim={r.empty && !r.none}><BoxIcon size={ICON.xs} /></Tile>
          <span className="truncate min-w-0 flex-1" data-tip={tipAttr(r.none ? "Issues with no component" : r.name)} style={{ opacity: r.empty && !r.none ? 0.55 : undefined }}>{r.name}</span>
          {count(r.issues, { opacity: r.empty && !r.none ? 0.55 : undefined })}
        </>, { label: `${r.name}, component`, expanded: r.hasKids ? r.open : undefined });
      case "epic": {
        const pr = epicProgress(r.epic);
        const tone = toneOf(r.epic.key);
        const tip = epicTip(r.epic, r.also);
        return shell(r, <>
          {/* The lilac ring is the shared mark: this epic also sits under another component. */}
          <span aria-hidden className="shrink-0" style={{ width: 8, height: 8, borderRadius: 999, background: tone, boxShadow: r.shared ? "0 0 0 2px var(--surface-nav), 0 0 0 3.5px var(--merged)" : undefined, marginLeft: 8 }} />
          <span className="min-w-0 flex-1 flex flex-col" style={{ gap: 2, opacity: r.dim ? 0.6 : undefined }}>
            <span className="truncate" style={{ fontSize: 12, fontWeight: 600, color: "var(--text)", lineHeight: 1.3 }}>{r.epic.summary}</span>
            <span className="flex items-center" style={{ gap: 8, fontSize: 10.5, color: "var(--text3)", lineHeight: 1.3 }}>
              <span className="tabular-nums">{r.epic.key}</span>
              <span aria-hidden className="shrink-0 overflow-hidden" style={{ width: 48, height: 4, borderRadius: 2, background: pr.zero ? undefined : "color-mix(in srgb, var(--text) 14%, transparent)", boxShadow: pr.zero ? "inset 0 0 0 1px var(--border)" : undefined }}>
                <i className="block h-full" style={{ width: `${pr.pct}%`, background: "var(--success)" }} />
              </span>
              <span className="tabular-nums">{pr.text}</span>
            </span>
          </span>
          {/* The assignee's face at the right end, 18 px; the row's own tip names both people. A muted ring where nobody holds it. */}
          <span className="shrink-0 inline-flex" style={{ marginRight: 8, opacity: r.dim ? 0.6 : undefined }} data-epic-person="assignee">
            {r.epic.assignee ? <Face m={{ name: r.epic.assignee.name, avatar: r.epic.assignee.avatar }} />
              : <span aria-hidden className="shrink-0" style={{ width: ICON.lg, height: ICON.lg, borderRadius: 999, boxShadow: "inset 0 0 0 1px var(--border)", opacity: 0.6 }} />}
          </span>
        </>, { h: EPIC_H, tip, label: `${r.epic.key} ${r.epic.summary}, ${pr.text}, ${r.epic.assignee?.name ?? "unassigned"}` });
      }
      case "noepic":
        return shell(r, <>
          <span aria-hidden className="shrink-0" style={{ width: 8, height: 8, borderRadius: 999, boxShadow: "inset 0 0 0 1.5px var(--text4)", marginLeft: 8 }} />
          <span className="truncate min-w-0 flex-1" style={{ fontSize: 11.5, color: "var(--text3)" }}>No epic</span>{count(r.n)}
        </>, { label: "No epic" });
      case "more":
        return (
          <div key={r.key} role="treeitem" data-tree-key={r.key} aria-level={3} tabIndex={stop === r.key ? 0 : -1} aria-label={`Show ${r.n} more`}
            onFocus={() => setFocus(r.key)} onClick={() => choose(r)}
            className="agx-rail-row relative flex items-center select-none"
            style={{ height: ROW_H, gap: 6, paddingLeft: 8 + 16 * 2, paddingRight: 8, borderRadius: 8, cursor: "pointer", fontSize: 11, color: "var(--text3)" }}>
            {guides(2)}<span style={{ width: 16 }} /><span style={{ width: 8 }} /><span>Show {r.n} more</span>
          </div>
        );
      case "note":
        return <div key={r.key} role="status" style={{ padding: "8px 12px", fontSize: 11, color: r.error ? "var(--error-ink)" : "var(--text3)" }}>{r.text}</div>;
      case "skeleton":
        return (
          <div key={r.key} aria-hidden className="flex flex-col" style={{ gap: 16, padding: "16px 8px" }}>
            {r.widths.map((w, i) => (
              <div key={i} className="flex items-center" style={{ gap: 12 }}>
                <span style={{ width: 8, height: 8, borderRadius: 999, background: "var(--border)" }} />
                <b className="agx-skeleton" style={{ width: `${w}%`, height: 12, borderRadius: 6 }} />
              </div>
            ))}
          </div>
        );
      case "view":
        return shell(r, <>
          {twisty(r, undefined)}
          {r.view.kind === "board" ? <ListIcon size={ICON.sm} className="shrink-0" /> : <SearchIcon size={ICON.sm} className="shrink-0" />}
          {renaming === r.view.id ? rename(r.view) : <span className="truncate min-w-0 flex-1" data-tip={tipAttr(r.view.label)}>{r.view.label}</span>}
          {r.view.count != null && count(r.view.count)}
        </>, { label: r.view.label });
    }
  };

  const menuView = menu && menuOf(menu.row);
  if (out.connected === false) {
    return <div role="status" style={{ padding: "8px 12px", fontSize: 11, color: "var(--text3)" }}>No Jira connected.</div>;
  }
  return (
    <>
      <div ref={root} role="tree" aria-label="Jira spaces" onKeyDown={onKey} style={{ padding: "8px 8px 16px" }}>
        {rows.map((r) => <Fragment key={r.key}>{draw(r)}</Fragment>)}
        {rows.length === 0 && out.q.trim() !== "" && <div style={{ padding: "8px 12px", fontSize: 11, color: "var(--text3)" }}>Nothing matches “{out.q.trim()}”.</div>}
        {out.legacy}
      </div>
      {menu && menuView && (
        <PrCardMenu<TreeMenuId> menu={menuView} x={menu.x} y={menu.y} onClose={() => setMenu(null)} onPick={(id) => act(menu.row, id)} />
      )}
    </>
  );
}

/** The line at the foot of the rail: which site, how many spaces. */
export function JiraRailFoot({ site, spaces }: { site: string | null; spaces: number }) {
  return (
    <div className="shrink-0 flex items-center" style={{ height: 32, padding: "0 12px", gap: 6, borderTop: LINE, fontSize: 10.5, color: "var(--text4)" }}>
      <span className="truncate min-w-0">{site ?? "Jira"}</span><span className="flex-1" />
      <span className="shrink-0">{spaces} space{spaces === 1 ? "" : "s"}</span>
    </div>
  );
}
