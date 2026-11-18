/*
 * A saved search's two small surfaces: the popover that names it (Personal or Team, Enter saves) and the "..." menu
 * (Rename, Duplicate, Copy JQL, Share as team, Remove). Both take the controller from `useJiraSavedViews`; neither reaches
 * the site. "Remove" deletes the local entry only and says so, behind a confirm.
 */
import { readable } from "../../../lib/personNames.ts";
import { useEffect, useRef, useState, type RefObject } from "react";
import { AnchoredMenu } from "../../AnchoredMenu.tsx";
import { MenuRow, MenuRule } from "../../ContextMenu.tsx";
import { INPUT, INPUT_STYLE, Segmented } from "../../workspace/Chrome.tsx";
import { Ctl } from "./ListControls.tsx";
import type { SavedViewsCtl } from "../../../lib/useJiraSavedViews.ts";
import { MAX_VIEW_TABS, namedTabCount, tabRoom, type SavedQuery } from "./tabsModel.ts";
import { tipAttr } from "../../../lib/tip.ts";

const WHO = [{ id: "me", label: "Personal" }, { id: "team", label: "Team" }] as const;

/** Names a saved search. `query` is the entry that already exists (the one-click save made it); Enter keeps the name. */
export function QueryPopover({ anchor, query, ctl, heading, onClose }: {
  anchor: RefObject<HTMLElement | null>; query: SavedQuery; ctl: SavedViewsCtl; heading: string; onClose: () => void;
}) {
  const [name, setName] = useState(readable(query.name));
  const [who, setWho] = useState<"me" | "team">(query.team ? "team" : "me");
  const [tab, setTab] = useState(!!query.tab);
  const full = !tabRoom(namedTabCount(), ctl.queries.filter((q) => q.tab && q.id !== query.id).length);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const box = useRef<HTMLInputElement>(null);
  useEffect(() => { box.current?.select(); }, []);
  const commit = async () => {
    const next = name.trim() || query.name;
    const patch: { name?: string; team?: boolean; tab?: boolean } = {};
    if (next !== query.name) patch.name = next;
    if ((who === "team") !== query.team) patch.team = who === "team";
    if (tab !== !!query.tab) patch.tab = tab;
    if (!Object.keys(patch).length) { onClose(); return; }
    setBusy(true); setErr(null);
    const r = await ctl.edit(query.id, patch);
    setBusy(false);
    if (r.ok) onClose(); else setErr(r.error ?? "Could not save");
  };
  return (
    <AnchoredMenu anchor={anchor} align="left" minWidth={280} keepTab focus="input" onClose={onClose}>
      <div className="flex flex-col" style={{ gap: 8, padding: 8 }} data-testid="jira-query-pop">
        <span className="text-[11px] font-semibold" style={{ color: "var(--text)" }}>{heading}</span>
        <input ref={box} value={name} aria-label="Name of this search" spellCheck={false} maxLength={80} disabled={busy}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); void commit(); } }}
          className={INPUT} style={INPUT_STYLE} />
        <span className="agx-jacc inline-flex"><Segmented label="Who sees it" value={who} options={WHO} onChange={setWho} /></span>
        <label className="flex items-center text-[11.5px]" style={{ gap: 8, color: "var(--text2)", opacity: full && !tab ? 0.5 : 1 }}
          {...(full && !tab ? { "data-tip": tipAttr(`${MAX_VIEW_TABS} tabs at most`) } : null)}>
          <input type="checkbox" checked={tab} disabled={busy || (full && !tab)} onChange={(e) => setTab(e.target.checked)} />
          Show as tab
        </label>
        <span className="text-[10.5px]" style={{ color: "var(--text3)" }}>Enter saves. It lives on this machine; nothing changes in Jira.</span>
        {err && <span role="status" className="text-[11px]" style={{ color: "var(--error-ink)" }}>{err}</span>}
        <span className="inline-flex justify-end" style={{ gap: 8 }}>
          <Ctl tone="quiet" onClick={onClose}>Cancel</Ctl>
          <Ctl tone="primary" disabled={busy} onClick={() => void commit()}>Save</Ctl>
        </span>
      </div>
    </AnchoredMenu>
  );
}

/** The "..." menu of one saved search. Rename hands over to the popover; Remove asks first. */
export function QueryMenu({ anchor, query, ctl, onRename, onEdit, onNote, onClose }: {
  anchor: RefObject<HTMLElement | null>; query: SavedQuery; ctl: SavedViewsCtl;
  onRename: () => void; onNote?: (text: string) => void; onClose: () => void;
  /** Open the view builder on this view's search. */
  onEdit?: (q: SavedQuery) => void;
}) {
  const [confirm, setConfirm] = useState(false);
  const done = (text: string) => { onNote?.(text); onClose(); };
  const run = async (p: Promise<{ ok: boolean; error?: string }>, ok: string) => {
    const r = await p;
    done(r.ok ? ok : r.error ?? "Could not do that");
  };
  return (
    <AnchoredMenu anchor={anchor} align="left" minWidth={232} placeKey={confirm ? 1 : 0} onClose={onClose}>
      {confirm ? (
        <div className="flex flex-col" style={{ gap: 8, padding: 8 }} data-testid="jira-query-remove">
          <span className="text-[11.5px] font-semibold" style={{ color: "var(--text)" }}>Remove “{readable(query.name)}”?</span>
          <span className="text-[10.5px]" style={{ color: "var(--text3)" }}>It leaves this list only. Nothing in Jira is deleted or changed.</span>
          <span className="inline-flex justify-end" style={{ gap: 8 }}>
            <Ctl onClick={() => setConfirm(false)}>Keep it</Ctl>
            <Ctl tone="danger" onClick={() => void run(ctl.remove(query.id), "Removed from this list")}>Remove</Ctl>
          </span>
        </div>
      ) : (
        <>
          {onEdit && <MenuRow onClick={() => { onClose(); onEdit(query); }}>Edit search…</MenuRow>}
          <MenuRow onClick={() => { onClose(); onRename(); }}>Rename</MenuRow>
          <MenuRow onClick={() => void run(ctl.duplicate(query.id), "Duplicated")}>Duplicate</MenuRow>
          <MenuRow onClick={() => { void navigator.clipboard?.writeText(query.jql).catch(() => {}); done("Copied the JQL"); }}>Copy JQL</MenuRow>
          <MenuRow disabled={query.team} hint={query.team ? "already" : undefined}
            onClick={() => void run(ctl.edit(query.id, { team: true }), "Shared as a team search")}>Share as team</MenuRow>
          <MenuRule />
          <MenuRow danger onClick={() => setConfirm(true)}>Remove (local only)</MenuRow>
        </>
      )}
    </AnchoredMenu>
  );
}
