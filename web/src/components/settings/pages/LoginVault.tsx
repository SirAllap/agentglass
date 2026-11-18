/*
 * Settings ▸ Browser ▸ Login vault: what is in the vault, who took it last,
 * which sites ask the person each time, the pull log, and Remove / Empty
 * (mockup states 3, 7, 8). Every word and number comes from Electron main's
 * `ag:vaultList`; no cookie name or value ever reaches this side.
 *
 * Sensitive is the person's mark, by hand (decision 3): the app only suggests
 * it. The OK for a sensitive pull is Electron main's own system dialog, not a
 * card in this window: nothing drawn here can say yes to one.
 * One read of the vault (useVault) feeds the whole page: the flow (who is
 * signed in now, state 4), the expired-login asks (state 6), the rules
 * sentence and the site list.
 */
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { vaultCall, vaultSignedIn } from "../../../lib/desktop.ts";
import { ago, defaultVaultOptions, goodUntil, lastTakenBy, pullWhat, readListing, reimportAsks, reimportLine, siteLog, sourceOf, boxSummary, vaultBoxes, vaultShown, withPut, type PutDone, type VaultBox, type VaultListing } from "../../../lib/loginVault.ts";
import { BlockedIcon, CrossIcon, ListIcon, LockIcon, RefreshIcon } from "../../../lib/glyphIcons.tsx";
import { ICON } from "../../../lib/iconSize.ts";
import { LINE, Button, FilterField } from "../../workspace/Chrome.tsx";
import { Switch as HouseSwitch } from "../../SettingRow.tsx";
import { SettingRow } from "../shell/SettingRow.tsx";
import { instantSave } from "../save/index.ts";
import { AskCard, SentenceSlot, Initial, SignInGlyph, SignOutGlyph, TrashGlyph, VaultSlot } from "./LoginFlow.tsx";

const clock = (s: number): string => new Date(s * 1000).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" });
const CELL = { minHeight: 32 } as const;
/* One grid for the header and every row: fixed tracks for the four icon buttons, so a header sits over its column. */
const GRID = "minmax(0,1.9fr) minmax(0,1.35fr) minmax(0,1.35fr) 72px 28px 28px 28px";
const DAY_S = 86_400;
/** Login good until, as a tone and a bar: red when gone, amber inside two days, green otherwise; the bar fills over 180 days. */
function expiryLook(expires: number | null, now: number): { tone: string; fill: number; gone: boolean } {
  if (expires === null) return { tone: "var(--text2)", fill: 0, gone: false };
  const left = expires - now;
  if (left <= 0) return { tone: "var(--error-ink)", fill: 1, gone: true };
  return { tone: left < 2 * DAY_S ? "var(--warning-ink)" : "var(--text2)", fill: Math.min(1, Math.max(0.04, left / (180 * DAY_S))), gone: false };
}
function ExpiryBar({ expires, now }: { expires: number | null; now: number }) {
  const e = expiryLook(expires, now);
  if (expires === null) return null;
  return (
    <span aria-hidden className="relative inline-block shrink-0 overflow-hidden rounded-full" style={{ width: 40, height: 4, background: "var(--surface-inset)" }}>
      <span className="absolute inset-y-0 left-0 rounded-full" style={{ width: `${e.fill * 100}%`, background: e.gone ? "repeating-linear-gradient(135deg, var(--error) 0 3px, transparent 3px 6px)" : e.tone === "var(--warning-ink)" ? "var(--warning)" : "var(--success)" }} />
    </span>
  );
}
/* About twelve rows, then the list scrolls inside instead of pushing the page. */
export const LIST_MAX = 12 * 32 + 64;

/** The search row both site lists share (the vault table and the import
 *  picker): "Search sites", the buttons that act on the shown rows, the count. */
export function SiteSearchRow({ query, onQuery, label, count, children, ...attrs }: { query: string; onQuery: (q: string) => void; label: string; count: string; children?: ReactNode; [data: `data-${string}`]: unknown }) {
  return (
    <div {...attrs} className="flex flex-wrap items-center gap-2 px-3 py-2 text-[12px]" style={{ borderTop: LINE }}>
      <FilterField value={query} onChange={onQuery} placeholder="Search sites" label={label} className="min-w-0 flex-1" />
      {children}
      <span role="status" className="tabular-nums" style={{ color: "var(--text2)" }}>{count}</span>
    </div>
  );
}

type RowCopy = { label: string; help: string };

/** What `vault-list` adds per site for the sign-in-on-visit panel. */
type VisitFlags = { site: string; sensitive?: boolean; suggestedVisit?: boolean; mostUsed?: boolean };

/**
 * The panel shown before "Sign agents in on first visit" is turned on: the
 * sites that look sensitive (host words and brands) and the most-used ones,
 * each once. `marked` are already sensitive: shown, never changed. Pure.
 */
export function visitPanelSites(vaults: readonly { sites: readonly VisitFlags[] }[]): { looks: string[]; used: string[]; marked: ReadonlySet<string> } {
  const looks = new Set<string>();
  const used = new Set<string>();
  const marked = new Set<string>();
  for (const v of vaults) for (const s of v.sites) {
    if (s.sensitive) marked.add(s.site);
    if (s.suggestedVisit) looks.add(s.site);
    else if (s.mostUsed) used.add(s.site);
  }
  for (const s of looks) used.delete(s);
  const sorted = (x: Set<string>) => [...x].sort((a, b) => a.localeCompare(b));
  return { looks: sorted(looks), used: sorted(used), marked };
}

type Reply = { ok: boolean; error?: string; code?: string };
type VaultVerb = "vaultImport" | "vaultSettings" | "vaultRemove" | "vaultSignOut";

/** The vault as main answers it, and the calls that change it. One per page:
 *  the flow, the rules sentence and the site list all draw from the same read. */
export function useVault(reload: number, enabled = true) {
  const [list, setList] = useState<VaultListing | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [lanes, setLanes] = useState<{ lane: string; agent: string; sites: string[] }[]>([]);
  /* Sign-in on visit: the sealed setting as main's helper read it. Main keeps it on unless the person turned it off. */
  const [onVisit, setOnVisit] = useState(false);
  const load = useCallback(() => {
    void vaultSignedIn().then(setLanes);
    void vaultCall("vaultList").then((a) => {
      const l = readListing(a);
      setOnVisit(a.ok && a.signInOnVisit === true);
      setList(l);
      setErr(l ? null : String(a.error ?? "The vault did not open."));
    });
  }, []);
  useEffect(() => { if (enabled) load(); }, [load, reload, enabled]);
  const act = async (p: Promise<Reply>) => {
    setBusy(true);
    const r = await p;
    setBusy(false);
    if (!r.ok && r.error !== "cancelled") setErr(r.error || "That did not work.");
    load();
  };
  const call = (name: VaultVerb, args?: Record<string, unknown>) => (vaultCall as unknown as (n: VaultVerb, a?: Record<string, unknown>) => Promise<Reply>)(name, args);
  /* A box is every container of one browser: Remove takes each, and stops at the first No. */
  const removeEach = (vaults: readonly string[], site?: string) => void act((async () => {
    for (const vault of vaults) {
      const r = await call("vaultRemove", site ? { vault, site } : { vault });
      if (!r.ok) return r;
    }
    return { ok: true };
  })());
  return {
    list, err, setErr, busy, setBusy, lanes, onVisit, load, act, call, removeEach,
    mark: (site: string, sensitive: boolean) => void act(call("vaultSettings", { site, sensitive })),
    markNoCopy: (site: string, noCopy: boolean) => void act(call("vaultSettings", { site, noCopy })),
    refresh: (source: string, sites: readonly { site: string }[]) => void act(call("vaultImport", { source, sites: [...new Set(sites.map((s) => s.site))] })),
    removeBox: (b: VaultBox) => removeEach(b.vaults),
    signOutLane: (lane: string) => void act(call("vaultSignOut", { lane })),
    emptyAll: () => void act(call("vaultRemove", { all: true })),
  };
}
export type Vault = ReturnType<typeof useVault>;

/** Counts the flow and the section's rail entry show: unique sites, and the sensitive ones. */
export function vaultCounts(boxes: readonly VaultBox[]): { sites: number; sensitive: number } {
  const seen = new Map<string, boolean>();
  for (const b of boxes) for (const s of b.sites) seen.set(s.site, (seen.get(s.site) ?? false) || s.sensitive);
  return { sites: seen.size, sensitive: [...seen.values()].filter(Boolean).length };
}

/** "2 agents signed in · last pull 12 min ago", or what stops them. */
export function vaultNow(v: Vault, signed: number, now: number): { live: boolean; text: string } {
  if (!v.list) return { live: false, text: "Agents get signed-out pages until the vault opens" };
  if (!v.list.vaults.some((x) => x.sites.length)) return { live: false, text: "No agent can sign in anywhere yet" };
  const last = v.list.pulls.filter((p) => p.event === "pull").reduce((a, p) => Math.max(a, p.at), 0);
  const who = signed ? `${signed} agent${signed === 1 ? "" : "s"} signed in` : "No agent signed in";
  return { live: signed > 0, text: last ? `${who} · last pull ${ago(last, now)}` : who };
}

/** State 6: the sites an agent found expired, each with "Refresh from …". */
export function VaultAsks({ v }: { v: Vault }) {
  const [notNow, setNotNow] = useState<ReadonlySet<string>>(new Set());
  if (!v.list) return null;
  const now = Math.floor(Date.now() / 1000);
  const asks = reimportAsks(v.list).filter((a) => !notNow.has(`${a.site}@${a.at}`));
  return (
    <>
      {asks.map((a) => (
        <div key={`${a.site}-${a.at}`} data-vault-reimport={a.site}>
          <AskCard title={`${a.agent || "An agent"} needs a fresh login for ${a.site}`}
            actions={<>
              <Button size="compact" disabled={v.busy} onClick={() => v.refresh(sourceOf(a.vault.vault), a.vault.sites)}><RefreshIcon size={ICON.sm} />{`Refresh from ${a.vault.label || "the browser"}`}</Button>
              <Button size="compact" tone="quiet" onClick={() => setNotNow(new Set([...notNow, `${a.site}@${a.at}`]))}>Not now</Button>
            </>}>
            <span style={{ color: "var(--warning-ink)" }}>{reimportLine(a, now)}</span>{`. Sign in to ${a.site} in ${a.vault.label || "that browser"} first if it is signed out there too.`}
          </AskCard>
        </div>
      ))}
    </>
  );
}

/** The two agent rules as one sentence, and the panel shown before sign-in on visit turns on. */
export function VaultRules({ v, signOut, signInOnVisit, defaultVault }: { v: Vault; signOut: RowCopy; signInOnVisit: RowCopy; defaultVault: RowCopy }) {
  /* The turn-on panel: null = closed; else the sites kept marked sensitive. */
  const [visitKeep, setVisitKeep] = useState<ReadonlySet<string> | null>(null);
  const list = v.list;
  const visit = visitPanelSites((list?.vaults ?? []) as unknown as { sites: VisitFlags[] }[]);
  /* Turn on: the marks first (stop at the first that fails, switch stays off),
     then the setting, which main gates with its own native dialog. */
  const turnOnVisit = async (keep: readonly string[]) => {
    v.setBusy(true);
    for (const site of keep) {
      const r = await v.call("vaultSettings", { site, sensitive: true });
      if (!r.ok) { v.setBusy(false); v.setErr(r.error || "That did not work."); v.load(); return; }
    }
    const r = await v.call("vaultSettings", { signInOnVisit: true });
    v.setBusy(false);
    setVisitKeep(null);
    if (!r.ok && r.code !== "cancelled") v.setErr(r.error || "That did not work.");
    v.load();
  };
  const visitRow = (site: string) => {
    const already = visit.marked.has(site);
    const on = already || (visitKeep?.has(site) ?? false);
    return (
      <div key={site} role="row" data-visit-site={site} className="flex items-center gap-2" style={CELL}>
        <span role="cell" className="min-w-0 break-all" style={{ color: "var(--text)" }}>{site}</span>
        <span role="cell" className="ml-auto flex items-center gap-2">
          {already && <span style={{ color: "var(--text3)" }}>Already sensitive</span>}
          <button type="button" role="switch" aria-checked={on} aria-label={`${site} is sensitive`} disabled={already || v.busy}
            className="agx-switch-hit inline-flex items-center rounded-full"
            onClick={() => { if (!visitKeep) return; const next = new Set(visitKeep); if (next.has(site)) next.delete(site); else next.add(site); setVisitKeep(next); }}>
            <HouseSwitch on={on} />
          </button>
        </span>
      </div>
    );
  };
  const outOn = list?.signOutAtEnd ?? true;
  const visitOn = v.onVisit || visitKeep !== null;
  return (
    <div data-vault-rules className="px-4 py-3.5" style={{ borderTop: LINE }}>
      <p className="agx-vf-sent">
        {"When an agent’s task ends, "}
        <span className="agx-vf-hug"><SentenceSlot kind="switch" {...signOut} on={outOn} disabled={!list || v.busy} onText="sign it out" offText="keep it signed in"
          icon={outOn ? <SignOutGlyph /> : <CrossIcon size={ICON.sm} />}
          onChange={(x) => instantSave(outOn, x, (y) => void v.act(v.call("vaultSettings", { signOutAtEnd: y })))} />.</span>
        {" When it first opens a site the vault has, "}
        <span className="agx-vf-hug"><SentenceSlot kind="switch" {...signInOnVisit} on={visitOn} disabled={!list || v.busy} onText="sign it in" offText="wait for it to ask"
          icon={visitOn ? <SignInGlyph /> : <CrossIcon size={ICON.sm} />}
          onChange={(x) => {
            /* Off is free. On does not save here: it opens the panel first. */
            if (!x) { setVisitKeep(null); if (v.onVisit) void v.act(v.call("vaultSettings", { signInOnVisit: false })); return; }
            setVisitKeep(new Set([...visit.looks, ...visit.used].filter((s) => !visit.marked.has(s))));
          }} />.</span>
        {" Sensitive sites always ask me. A site in more than one vault signs in from "}
        <SentenceSlot kind="select" {...defaultVault} value={list?.defaultVault ?? ""} options={defaultVaultOptions(list?.vaults ?? [])} disabled={!list || v.busy}
          onChange={(x) => void v.act(v.call("vaultSettings", { defaultVault: x || null }))} />.
      </p>
      {visitKeep && (
        <div data-visit-panel className="mt-2 flex flex-col gap-1 rounded-lg px-3 py-2 text-[12px]" style={{ background: "var(--surface-inset)" }}>
          <span style={{ color: "var(--text)" }}>Sites that look sensitive</span>
          <span style={{ color: "var(--text2)" }}>Each is marked sensitive, so agents are not signed in to it on a visit. Unmark the ones that are fine.</span>
          <div role="table" aria-label="Sites that look sensitive" className="flex flex-col">
            {!visit.looks.length && <div className="py-1" style={{ color: "var(--text3)" }}>No site in the vault looks sensitive.</div>}
            {visit.looks.map(visitRow)}
          </div>
          {visit.used.length > 0 && <>
            <span className="pt-1" style={{ color: "var(--text)" }}>Your most-used sites</span>
            <div role="table" aria-label="Your most-used sites" className="flex flex-col">{visit.used.map(visitRow)}</div>
          </>}
          <span className="flex items-center justify-end gap-2 pt-1">
            <Button size="compact" autoFocus disabled={v.busy} onClick={() => setVisitKeep(null)}>Cancel</Button>
            <Button size="compact" tone="primary" disabled={v.busy} onClick={() => void turnOnVisit([...visitKeep])}>Turn on</Button>
          </span>
        </div>
      )}
    </div>
  );
}

/** `put`: the browser the person just put in, drawn as its box at once;
 *  `putting`: a put is running, so the vault is not called empty meanwhile.
 *  `emptyAction` / `lockedAction`: what the empty and locked slots offer. */
export function VaultSites({ v, empty: emptyRow, put = null, putting = false, emptyText, emptyAction, lockedAction }: { v: Vault; empty: RowCopy; put?: PutDone | null; putting?: boolean; emptyText: string; emptyAction: ReactNode; lockedAction: ReactNode }) {
  const [log, setLog] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [sensitiveOnly, setSensitiveOnly] = useState(false);
  const now = Math.floor(Date.now() / 1000);
  const { list, err, busy } = v;

  /* The bulk buttons: the same call the row switch makes, once per shown site, then one reload. */
  const markAll = async (sites: readonly string[], sensitive: boolean) => {
    v.setBusy(true);
    let bad: string | null = null;
    for (const site of sites) {
      const r = await v.call("vaultSettings", { site, sensitive });
      if (!r.ok && !bad) bad = r.error || "That did not work.";
    }
    v.setBusy(false);
    if (bad) v.setErr(bad);
    v.load();
  };

  if (!list) {
    if (!err) return null;
    return (
      <VaultSlot tone="error" title="The vault is locked" actions={<>
        <Button tone="primary" disabled={busy} onClick={v.load}><RefreshIcon size={ICON.sm} />Try again</Button>
        {lockedAction}
      </>}>{`${err} Unlock the system keyring (sign in to your desktop again), then try again.`}</VaultSlot>
    );
  }
  const boxes = vaultBoxes(withPut(list, put).vaults);
  if (!boxes.length) {
    return putting
      ? <div role="status" className="px-3 py-3 text-[12px]" style={{ color: "var(--text2)" }}>Putting your logins in the vault.</div>
      : <VaultSlot tone="empty" title="The vault is empty" actions={emptyAction}>{emptyText}</VaultSlot>;
  }
  const shown = vaultShown(boxes, query, sensitiveOnly);
  return (
    <>
      <SiteSearchRow data-vault-tools query={query} onQuery={setQuery} label="Search sites in the vault" count={shown.count}>
        <Button size="compact" on={sensitiveOnly} aria-pressed={sensitiveOnly} onClick={() => setSensitiveOnly(!sensitiveOnly)}><LockIcon size={ICON.sm} />Sensitive only</Button>
        <Button size="compact" disabled={busy || !shown.toMark.length} onClick={() => void markAll(shown.toMark, true)}>Mark shown sensitive</Button>
        <Button size="compact" tone="quiet" disabled={busy || !shown.toUnmark.length} onClick={() => void markAll(shown.toUnmark, false)}>Unmark shown</Button>
      </SiteSearchRow>
      <div data-vault-list className="overflow-y-auto" style={{ maxHeight: LIST_MAX, borderTop: LINE }}>
      {shown.groups.map(({ vault: b, sites }) => (
        <div key={b.source} data-vault-box={b.source} className="flex flex-col">
          <div className="sticky top-0 z-[1] flex items-center gap-2 px-3 py-1.5 text-[12px]" style={{ color: "var(--text2)", background: "var(--surface-card)" }}>
            <Initial name={b.label} size={22} />
            <span className="min-w-0"><b style={{ color: "var(--text)" }}>{b.label}</b>{` · ${boxSummary(b, now)} · encrypted, key in keyring.`}</span>
            <span className="ml-auto flex items-center gap-2">
              <Button size="compact" disabled={busy || b.pending} aria-label={`Import again from ${b.label}`} onClick={() => v.refresh(b.source, b.sites)}><RefreshIcon size={ICON.sm} />Import again</Button>
              <Button size="compact" tone="quiet" disabled={busy || b.pending} aria-label={`Remove ${b.label} from the vault`} onClick={() => v.removeBox(b)}>Remove</Button>
            </span>
          </div>
          <div role="table" aria-label={`Sites in ${b.label}`} className="flex flex-col px-3 pb-2 text-[12px]">
            <div role="row" className="grid items-center gap-2 px-0.5 text-[10px] font-bold uppercase tracking-[.06em]" style={{ gridTemplateColumns: GRID, minHeight: 28, color: "var(--text3)" }}>
              <span role="columnheader">Site</span><span role="columnheader">Login good until</span><span role="columnheader">Last taken by</span>
              <span role="columnheader" className="grid place-items-center">Sensitive</span>
              <span role="columnheader"><span className="sr-only">Never copy</span></span>
              <span role="columnheader" className="col-span-2"><span className="sr-only">Log and remove</span></span>
            </div>
            {!sites.length && <div className="py-1" style={{ color: "var(--text3)" }}>No site here matches.</div>}
            {sites.map((s) => (
              <div key={`${s.vault}|${s.site}`} className="flex flex-col">
                <div role="row" data-vault-site={s.site} className="grid items-center gap-2 px-0.5" style={{ gridTemplateColumns: GRID, minHeight: 36 }}>
                  <span role="cell" className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5" style={{ color: "var(--text)" }}>
                    <Initial name={s.site} size={20} />
                    <span className="min-w-0 font-mono text-[12px] [overflow-wrap:anywhere]">{s.site}</span>
                    {s.suggested && !s.sensitive && <span className="shrink-0 whitespace-nowrap rounded px-1.5 text-[10px]" style={{ border: "1px dashed color-mix(in srgb, var(--warning) 60%, transparent)", color: "var(--warning-ink)" }}>Suggested sensitive</span>}
                  </span>
                  <span role="cell" className="flex min-w-0 items-center gap-2 tabular-nums" style={{ color: b.pending ? "var(--text2)" : expiryLook(s.expires, now).tone }}>
                    {!b.pending && <ExpiryBar expires={s.expires} now={now} />}
                    <span className="truncate">{b.pending ? "Checking" : goodUntil(s.expires, now)}</span>
                  </span>
                  <span role="cell" className="truncate" style={{ color: "var(--text2)" }}>{lastTakenBy(list.pulls, s.site, now)}</span>
                  <span role="cell" className="grid place-items-center">
                    <Button size="hit" square tone="quiet" role="switch" aria-checked={s.sensitive} label={`${s.site} is sensitive`}
                      style={s.sensitive ? { background: "color-mix(in srgb, var(--warning) 18%, transparent)", color: "var(--warning-ink)", boxShadow: "inset 0 0 0 1px color-mix(in srgb, var(--warning) 45%, transparent)" } : undefined}
                      onClick={() => v.mark(s.site, !s.sensitive)}><LockIcon size={ICON.sm} /></Button>
                  </span>
                  <span role="cell" className="grid place-items-center">
                    <Button size="hit" square tone="quiet" on={s.noCopy === true} aria-pressed={s.noCopy === true} disabled={busy}
                      label={s.noCopy ? `Never copy ${s.site}: agents are told to ask you to sign in inside agentglass's own browser` : `Never copy ${s.site}: for sites that sign you out elsewhere when a login is copied`}
                      onClick={() => v.markNoCopy(s.site, !s.noCopy)}><BlockedIcon size={ICON.sm} /></Button>
                  </span>
                  <span role="cell" className="grid place-items-center">
                    <Button size="hit" square tone="quiet" label={`Pull log for ${s.site}`} aria-expanded={log === s.site} onClick={() => setLog(log === s.site ? null : s.site)}><ListIcon size={ICON.sm} /></Button>
                  </span>
                  <span role="cell" className="grid place-items-center">
                    <Button size="hit" square tone="quiet" style={{ color: "var(--error-ink)" }} label={`Remove ${s.site} from this vault`} disabled={busy || b.pending} onClick={() => v.removeEach(s.vaults, s.site)}><TrashGlyph /></Button>
                  </span>
                </div>
                {log === s.site && s === b.sites.find((x) => x.site === s.site) && <SiteLog site={s.site} listing={list} />}
              </div>
            ))}
          </div>
        </div>
      ))}
      </div>
      <div className="m-3 rounded-lg" style={{ border: LINE, borderColor: "color-mix(in srgb, var(--error) 28%, transparent)", background: "color-mix(in srgb, var(--error) 5%, var(--surface-card))" }}>
        <SettingRow kind="control" {...emptyRow}
          control={<Button tone="danger" disabled={busy} onClick={v.emptyAll}><TrashGlyph />Empty vault</Button>} />
      </div>
      {err && <div role="alert" className="px-3 py-2 text-[12px]" style={{ color: "var(--error-ink)" }}>{err}</div>}
    </>
  );
}

/** State 7: one site's pulls and sign-outs, newest first. */
function SiteLog({ site, listing }: { site: string; listing: VaultListing }) {
  const rows = siteLog(listing.pulls, site);
  return (
    <div role="table" aria-label={`${site} log`} className="flex flex-col rounded-md mb-1 px-2 py-1" style={{ background: "var(--surface-inset)" }}>
      <div className="text-[11px] py-1" style={{ color: "var(--text3)" }}>Every pull, every sign-out. Names and counts only.</div>
      {!rows.length && <div className="text-[12px] py-1" style={{ color: "var(--text2)" }}>No agent has taken this site yet.</div>}
      {rows.map((p, i) => (
        <div key={`${p.at}-${i}`} role="row" className="grid items-center gap-2 text-[12px]" style={{ gridTemplateColumns: "minmax(0,1fr) minmax(0,1.2fr) minmax(0,1fr) minmax(0,1.4fr)", minHeight: 26 }}>
          <span role="cell" className="tabular-nums" style={{ color: "var(--text3)" }}>{clock(p.at)}</span>
          <span role="cell" className="truncate">{p.agent || "an agent"}</span>
          <span role="cell" className="truncate" style={{ color: "var(--text2)" }}>{p.lane}</span>
          <span role="cell" style={{ color: p.event === "refused" ? "var(--warning-ink)" : "var(--text2)" }}>{`${pullWhat(p)}${(p as { cause?: unknown }).cause === "visit" ? " · on visit" : ""}`}</span>
        </div>
      ))}
    </div>
  );
}
