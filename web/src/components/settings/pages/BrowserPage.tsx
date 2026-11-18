import { useCallback, useEffect, useState, type CSSProperties } from "react";
import { api } from "../../../lib/api.ts";
import { setting } from "../../../lib/settingsRegistry.ts";
import { SEARCH_ENGINE_LABELS, normalizeNavigationUrl, type SearchEngine } from "../../../lib/browserUrl.ts";
import { Switch } from "../../SettingRow.tsx";
import { homePageRaw, setHomePage, searchEngine, agentsWithoutScreen,importHistory, setImportHistory, importBookmarks, setImportBookmarks, pickImportRows } from "../../../lib/browserPrefs.ts";
import { browserPlaces, CAN_IMPORT_COOKIES, cookieSources, importCookies, forgetCookies, vaultCall, wipeContainers, type CookieSource } from "../../../lib/desktop.ts";
import { loadProfiles, retireIds, saveProfiles, unusedContainers, unusedFromStore, IDLE_DROP_MS, MAX_PROFILES } from "../../../lib/browserProfiles.ts";
import { countFor, forgetProfileTabs, readSession } from "../../../lib/browserSession.ts";
import { laneContainers } from "../../../lib/laneManager.ts";
import { chooseShown, chosenLine, looksSensitive, pickShown, signedInCards, vaultBoxes, withPut, type PutDone, type PutIn } from "../../../lib/loginVault.ts";
import { LIST_MAX, SiteSearchRow, VaultAsks, VaultRules, VaultSites, useVault, vaultCounts, vaultNow, type Vault } from "./LoginVault.tsx";
import { DownGlyph, FLOW_CSS, SentenceSlot, Initial, KeyGlyph, NowLine, VaultFlow } from "./LoginFlow.tsx";
import { rowId } from "../../../lib/settingsIndex.ts";
import { CrossIcon, DoneIcon, LockIcon } from "../../../lib/glyphIcons.tsx";
import { ICON } from "../../../lib/iconSize.ts";
import { allSites, bestSource, lockedWhy, reachable } from "../../../lib/cookiePick.ts";
import { Select } from "../../Select.tsx";
import { LINE, Button, Checkbox } from "../../workspace/Chrome.tsx";
import { BrowserPreview } from "../previews/index.ts";
import { SettingsPage } from "../shell/SettingsPage.tsx";
import { Section } from "../shell/Section.tsx";
import { SettingRow } from "../shell/SettingRow.tsx";
import { TextCommitField, instantSave } from "../save/index.ts";
import { BROWSER_ROWS } from "./pageRows.ts";
import type { PageCtx } from "./ctx.ts";

const COPY = Object.fromEntries(BROWSER_ROWS.map((r) => [r.id, r]));
const row = (id: string) => ({ label: COPY[id].label, help: COPY[id].help });

const AGENT_LINES = [
  "Using agentglass-browser, open my dashboard and tell me what is on it.",
  "With agentglass-browser, go to the staging app, log in with my session, and check the checkout flow.",
  "Take a screenshot of the open PR page with agentglass-browser and tell me what is failing.",
];
/** Mockup state 2: what the vault copies and what it never reads. */
const VAULT_COPIES: readonly (readonly [boolean, string])[] = [
  [true, "Cookies that keep you signed in"], [false, "Passwords (never read)"],
  [true, "Expiry of each login"], [false, "Cookie values in any log or reply"],
  [false, "History and bookmarks (stay in your browser)"],
];
const WHY_COOKIES = "Electron has no place for a password manager's popup, so pages behind a login work here by bringing your cookies over. Import brings every site of a profile; Choose sites lets you leave some behind. Anyone who can use this window, including an agent driving it, is signed in to whatever comes across.";

/** The import's own state: which browser, which sites, where they go. Same calls as before. */
function useImport(onVault: () => void) {
  const [sources, setSources] = useState<CookieSource[] | null>(null);
  const [pick, setPick] = useState("");
  const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set());
  const [showSites, setShowSites] = useState(false);
  const [siteQuery, setSiteQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<{ err: boolean; text: string } | null>(null);
  const [hist, setHist] = useState(importHistory());
  const [marks, setMarks] = useState(importBookmarks());
  const [putIn, setPutIn] = useState<PutIn>("both");
  /* The browser just put in: its box shows at once, before the list reloads. */
  const [put, setPut] = useState<PutDone | null>(null);
  const [putting, setPutting] = useState(false);
  const load = useCallback(() => {
    void cookieSources().then((r) => {
      if (!r.ok) { setSaid({ err: true, text: r.error || "Can't look at your browsers right now." }); setSources([]); return; }
      const list = r.sources ?? [];
      setSources(list);
      const best = bestSource(list);
      if (best) setPick((p) => p || best.id);
    });
  }, []);
  useEffect(() => { if (CAN_IMPORT_COOKIES) load(); }, [load]);
  const current = (sources ?? []).find((s) => s.id === pick) ?? null;
  useEffect(() => { setChosen(current ? allSites(current.sites) : new Set()); }, [current?.id]);

  /** Opens the site chooser on one browser, every site chosen. */
  const open = (id: string) => {
    const s = (sources ?? []).find((x) => x.id === id);
    if (!s?.readable || !s.sites.length) return;
    setPick(id); setChosen(allSites(s.sites)); setSiteQuery(""); setShowSites(true); setSaid(null);
  };
  const run = async (kind: "import" | "forget", only: ReadonlySet<string> = chosen) => {
    const sites = [...only];
    if (!sites.length || !current) return;
    setBusy(true); setSaid(null);
    const profileIds = loadProfiles(globalThis.localStorage ?? null).map((p) => p.id);
    /* "Put in" the vault: main asks with its own confirm and answers counts only. */
    if (kind === "import" && putIn !== "browser") {
      setPutting(true);
      const v = await vaultCall("vaultImport", { source: current.id, sites });
      setPutting(false);
      if (v.ok) { setPut({ source: current.id, label: current.label, at: Math.floor(Date.now() / 1000), sites: current.sites.filter((x) => only.has(x.site)) }); setShowSites(false); }
      onVault();
      if (!v.ok) { setBusy(false); if (v.error !== "cancelled") setSaid({ err: true, text: v.error || "The vault did not take them." }); return; }
      if (putIn === "vault") { setBusy(false); setSaid({ err: false, text: `Put ${sites.length} site${sites.length === 1 ? "" : "s"} in the vault. Agents can take one site at a time.` }); return; }
    }
    const r = kind === "import" ? await importCookies(current.id, sites) : await forgetCookies(sites, profileIds);
    if (!r.ok) { setBusy(false); if (r.error !== "cancelled") setSaid({ err: true, text: r.error || "That did not work." }); return; }
    if (kind === "forget") { setBusy(false); setSaid({ err: false, text: `Removed cookies for ${sites.length} site${sites.length === 1 ? "" : "s"}.` }); return; }
    const res = r as { set?: number; failed?: unknown[] };
    let pages = 0;
    if (hist || marks) {
      try {
        const keep = pickImportRows(await browserPlaces(current.id), hist, marks);
        if (keep.length) pages = (await api.saveBrowserPlaces(current.id, keep)).saved ?? 0;
      } catch { /* the logins are in; the history is a bonus */ }
    }
    setBusy(false);
    setShowSites(false);
    setSaid({ err: false, text: `Brought in ${res.set ?? 0} cookies for ${sites.length} site${sites.length === 1 ? "" : "s"}.${pages ? ` And ${pages.toLocaleString()} pages of history.` : ""} Open the browser and you should be signed in.` });
  };
  return { sources: sources ?? [], current, setPick, chosen, setChosen, showSites, setShowSites, siteQuery, setSiteQuery, busy, said, hist, setHist, marks, setMarks, putIn, setPutIn, put, putting, open, run };
}
type Import = ReturnType<typeof useImport>;

/** The words "into …" reads in the import sentence. */
const PUT_IN_SENTENCE: Readonly<Record<PutIn, string>> = { both: "the vault and my browser", vault: "the vault only", browser: "my browser only" };

/** Login vault: the flow, the import sentence, the chooser, the agent rules (mockup direction C). */
function Logins({ v, imp }: { v: Vault; imp: Import }) {
  const [showWhy, setShowWhy] = useState(false);
  const { current, putIn } = imp;
  const now = Math.floor(Date.now() / 1000);
  const boxes = v.list ? vaultBoxes(withPut(v.list, imp.put).vaults) : [];
  const signed = v.list ? signedInCards(v.lanes, v.list.pulls) : [];
  const counts = vaultCounts(boxes);
  const state = vaultNow(v, signed.length, now);
  const locked = !v.list && v.err ? v.err : null;
  const picked = pickShown(current?.sites ?? [], imp.siteQuery);
  const allShownIn = picked.rows.every((s) => imp.chosen.has(s.site));
  const noneShownIn = picked.rows.every((s) => !imp.chosen.has(s.site));
  const toggleSite = (site: string) => imp.setChosen((c) => { const n = new Set(c); if (n.has(site)) n.delete(site); else n.add(site); return n; });
  return (
    <Section id="logins" title="Login vault" intro="Where your logins come from, where they sit, who is using them." count={v.list ? String(counts.sites) : undefined}>
      <style>{FLOW_CSS}</style>
      <VaultFlow sources={imp.sources} boxes={boxes} signed={signed} locked={locked} sites={counts.sites} sensitive={counts.sensitive} now={now} busy={v.busy || imp.busy}
        onImportFrom={imp.open} onRefresh={(b) => v.refresh(b.source, b.sites)} onRemove={v.removeBox} onSignOut={(c) => v.signOutLane(c.lane)} onRetry={v.load}
        nowLine={<NowLine live={state.live}>{state.text}</NowLine>} />
      <VaultAsks v={v} />
      <div data-import-sentence className="px-4 py-3.5" style={{ borderTop: LINE }}>
        <p className="agx-vf-sent">
          {"Copy my logins from "}
          <SentenceSlot kind="select" {...row("browser.importFrom")} value={current?.id ?? ""} disabled={!imp.sources.some(reachable)}
            lead={current ? <Initial name={current.label} size={18} /> : null}
            options={imp.sources.filter(reachable).map((x) => ({ value: x.id, label: x.readable ? x.label : `${x.label} (locked)` }))}
            onChange={(id) => { imp.setPick(id); imp.setShowSites(false); }} />
          {" into "}
          <span className="agx-vf-hug"><SentenceSlot kind="select" agentNever="decides where the owner's logins go: credentials" {...row("browser.putIn")} value={putIn}
            options={(Object.keys(PUT_IN_SENTENCE) as PutIn[]).map((k) => ({ value: k, label: PUT_IN_SENTENCE[k] }))} onChange={(x) => imp.setPutIn(x as PutIn)} />,</span>
          {" and bring "}
          <SentenceSlot kind="switch" agentNever="imports the owner's cookies and history from another browser: credentials" {...row("browser.importHistory")} on={imp.hist} onText="history" offText="history" strike
            onChange={(x) => instantSave(imp.hist, x, (y) => { setImportHistory(y); imp.setHist(y); })} />
          {" "}
          <span className="agx-vf-hug"><SentenceSlot kind="switch" agentNever="imports the owner's cookies and history from another browser: credentials" {...row("browser.importBookmarks")} on={imp.marks} onText="bookmarks" offText="bookmarks" strike
            onChange={(x) => instantSave(imp.marks, x, (y) => { setImportBookmarks(y); imp.setMarks(y); })} />.</span>
        </p>
        {current && !current.readable && <div role="note" className="mt-1 text-[12px]" style={{ color: "var(--warning-ink)" }}>{lockedWhy(current)}</div>}
        <div className="mt-2.5 flex flex-wrap items-center gap-2.5">
          <span className="inline-flex min-w-[220px] flex-1 items-center gap-1.5 text-[12px]" style={{ color: "var(--text3)" }}><KeyGlyph />The vault reads that browser once. No agent reads it after that.</span>
          <span data-row={rowId(row("browser.sites").label)}>
            <Button tone="primary" aria-expanded={imp.showSites} disabled={!current?.readable || imp.busy || !current.sites.length || (locked !== null && putIn !== "browser")}
              onClick={() => { if (imp.showSites) imp.setShowSites(false); else if (current) imp.open(current.id); }}><DownGlyph />Choose sites and import</Button>
          </span>
        </div>
      </div>
      {current?.readable && imp.showSites && (
        <div data-import-sites role="dialog" aria-label={`Choose sites from ${current.label}`} className="mx-4 mb-3 flex flex-col gap-2 rounded-xl py-2" style={{ background: "var(--surface-card)", border: LINE }}>
          <SiteSearchRow data-import-tools query={imp.siteQuery} onQuery={imp.setSiteQuery} label="Search sites to import" count={picked.count}>
            <Button size="compact" onClick={() => imp.setChosen(chooseShown(imp.chosen, picked.rows, true))} disabled={!picked.rows.length || allShownIn}>All</Button>
            <Button size="compact" onClick={() => imp.setChosen(chooseShown(imp.chosen, picked.rows, false))} disabled={!picked.rows.length || noneShownIn}>None</Button>
          </SiteSearchRow>
          <div className="flex items-center gap-2 px-3 text-[12px]" style={{ color: "var(--text2)" }}>
            <Initial name={current.label} size={22} />
            <b style={{ color: "var(--text)" }}>{current.label}</b>
            <span className="tabular-nums">{chosenLine(imp.chosen.size, current.sites.length)}</span>
            <span className="ml-auto text-[11px]" style={{ color: "var(--text3)" }}>Cookies</span>
          </div>
          <div className="agx-scroll mx-3 flex flex-col gap-0.5 overflow-y-auto" style={{ maxHeight: LIST_MAX }}>
            {!picked.rows.length && <div className="px-2 py-1 text-[12px]" style={{ color: "var(--text3)" }}>No site here matches.</div>}
            {picked.rows.map((s) => (
              <div key={s.site} className="flex items-center justify-between gap-2 px-2" style={{ minHeight: 28 }}>
                <Checkbox checked={imp.chosen.has(s.site)} onChange={() => toggleSite(s.site)}><span className="break-all" style={{ color: "var(--text)" }}>{s.site}</span></Checkbox>
                <span className="flex items-center gap-2">
                  {looksSensitive(s.site) && <span className="agx-chip agx-chip-warn inline-flex items-center gap-1 text-[10px] px-1.5 rounded border"><LockIcon size={ICON.xs} />Sensitive</span>}
                  <span className="tabular-nums text-[11px]" style={{ color: "var(--text3)" }}>{s.cookies}</span>
                </span>
              </div>
            ))}
          </div>
          {putIn !== "browser" && (
            <ul aria-label="What goes in the vault" className="grid gap-x-4 gap-y-1 text-[12px] list-none mx-3 my-0 p-0 pt-2" style={{ gridTemplateColumns: "1fr 1fr", borderTop: LINE, color: "var(--text2)" }}>
              {VAULT_COPIES.map(([yes, what]) => <li key={what}><span aria-hidden className="inline-flex align-middle" style={{ color: yes ? "var(--success-ink)" : "var(--error-ink)" }}>{yes ? <DoneIcon size={ICON.xs} /> : <CrossIcon size={ICON.xs} />}</span> <span className="sr-only">{yes ? "Copied: " : "Not copied: "}</span>{what}</li>)}
            </ul>
          )}
          <div className="flex flex-wrap items-center gap-2 px-3 pt-2 text-[12px]" style={{ borderTop: LINE, color: "var(--text3)" }}>
            <span className="inline-flex min-w-0 items-center gap-1.5"><KeyGlyph />{putIn === "browser" ? "Copied into your own browser container only." : "Saved encrypted. The key lives in the system keyring, never in a file."}</span>
            <span className="ml-auto flex items-center gap-2">
              <Button tone="quiet" onClick={() => void imp.run("forget")} disabled={imp.busy || !imp.chosen.size}>Forget them again</Button>
              <Button onClick={() => imp.setShowSites(false)}>Cancel</Button>
              <Button tone="primary" onClick={() => void imp.run("import")} disabled={imp.busy || !imp.chosen.size}>{putIn === "browser" ? `Bring in ${imp.chosen.size}` : `Put ${imp.chosen.size} in the vault`}</Button>
            </span>
          </div>
        </div>
      )}
      {imp.said && <div role={imp.said.err ? "alert" : "status"} className="px-4 pb-3 text-[12px]" style={{ color: imp.said.err ? "var(--error-ink)" : "var(--text2)" }}>{imp.said.text}</div>}
      <VaultRules v={v} signOut={row("browser.vaultSignOut")} signInOnVisit={row("browser.vaultSignInOnVisit")} defaultVault={row("browser.vaultDefault")} />
      <SettingRow kind="link" {...row("browser.whyCookies")} linkText={showWhy ? "Hide" : "Read why"} onOpen={() => setShowWhy(!showWhy)} />
      {showWhy && <div role="note" className="px-3 py-2 text-[12px]" style={{ color: "var(--text2)" }}>{WHY_COOKIES}</div>}
    </Section>
  );
}

/** Sites in the vault: the table, search and bulk sensitive, and Empty vault. */
function VaultList({ v, imp }: { v: Vault; imp: Import }) {
  const best = bestSource(imp.sources);
  const ready = best?.readable ? best.sites.length : 0;
  return (
    <Section id="sites" title="Sites in the vault">
      <div data-row={rowId(row("browser.vaultSites").label)}>
        <VaultSites v={v} empty={row("browser.vaultEmpty")} put={imp.put} putting={imp.putting}
          emptyText={ready ? `Pick a browser above and press Import. ${best!.label} has ${ready} sites ready. Agents can then take one site at a time.` : "Pick a browser above and press Import. Agents can then take one site at a time."}
          emptyAction={best && ready ? <Button tone="primary" disabled={imp.busy} onClick={() => imp.open(best.id)}><DownGlyph />{`Import ${ready} from ${best.label}`}</Button> : null}
          lockedAction={<Button tone="quiet" disabled={!imp.current?.readable} onClick={() => { imp.setPutIn("browser"); if (imp.current) imp.open(imp.current.id); }}>Import to my browser only</Button>} />
      </div>
    </Section>
  );
}

/** How many agent containers "Remove unused" would take, and taking them.
 *  The Browser panel answers when it is mounted; otherwise the stored list. */
function unusedIds(): string[] {
  const live = unusedContainers();
  if (live) return live.list().map((p) => p.id);
  const session = readSession();
  return unusedFromStore(globalThis.localStorage ?? null, (id) => countFor(session, id), laneContainers(), Date.now()).gone.map((p) => p.id);
}
/** Only the ids the confirm showed, and only those still unused now. */
function removeUnused(only: readonly string[]): number {
  const live = unusedContainers();
  if (live) return live.remove(only);
  const store = globalThis.localStorage ?? null;
  const session = readSession();
  const { gone, kept } = unusedFromStore(store, (id) => countFor(session, id), laneContainers(), Date.now(), only);
  if (!gone.length) return 0;
  saveProfiles(store, kept);
  retireIds(store, gone.map((p) => p.id));
  for (const p of gone) forgetProfileTabs(p.id);
  void wipeContainers(gone.map((p) => p.id));
  return gone.length;
}

/** Every container slot as a square: yours, an agent's, unused (hatched), free. The words under it say the same in numbers. */
function ContainerMap({ total, count, hours }: { total: number; count: number; hours: number }) {
  const profiles = loadProfiles(globalThis.localStorage ?? null);
  const unused = new Set(unusedIds());
  const agents = profiles.filter((p) => !unused.has(p.id) && p.name.startsWith("agent:")).length;
  const yours = 1 + profiles.filter((p) => !unused.has(p.id) && !p.name.startsWith("agent:")).length;
  const gone = Math.min(count, unused.size || count);
  const used = Math.min(MAX_PROFILES, yours + agents + gone);
  const cell = (i: number) => (i < yours ? "yours" : i < yours + agents ? "agent" : i < used ? "unused" : "free");
  const look: Record<string, CSSProperties> = {
    yours: { background: "var(--primary)" },
    agent: { background: "var(--success)" },
    unused: { background: "repeating-linear-gradient(135deg, color-mix(in srgb, var(--warning) 70%, transparent) 0 2px, transparent 2px 4px)", boxShadow: "inset 0 0 0 1px color-mix(in srgb, var(--warning) 45%, transparent)" },
    // A free slot is drawn, not just tinted: --surface-inset alone vanished against the dark card.
    free: { background: "color-mix(in srgb, var(--text) 7%, transparent)", boxShadow: "inset 0 0 0 1px color-mix(in srgb, var(--text) 16%, transparent)" },
  };
  return (
    <div className="flex flex-col gap-2 px-3 pb-3 pt-1">
      <div role="img" aria-label={`${used} of ${MAX_PROFILES} containers used: ${yours} yours, ${agents} agents, ${gone} unused`} className="grid gap-1" style={{ gridTemplateColumns: "repeat(auto-fill, 12px)", maxWidth: 32 * 15 }}>
        {Array.from({ length: MAX_PROFILES }, (_, i) => <span key={i} className="rounded-sm" style={{ width: 12, height: 12, ...look[cell(i)] }} />)}
      </div>
      <div role="status" className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] tabular-nums" style={{ color: "var(--text2)" }}>
        {(["yours", "agent", "unused"] as const).map((k) => (
          <span key={k} className="inline-flex items-center gap-1.5"><i aria-hidden className="inline-block rounded-sm" style={{ width: 10, height: 10, ...look[k] }} />{k === "yours" ? `Yours · ${yours}` : k === "agent" ? `Agents · ${agents}` : `Unused · ${gone}`}</span>
        ))}
        <span style={{ color: "var(--text3)" }}>{used} of {MAX_PROFILES}</span>
      </div>
      <div className="text-[12px]" style={{ color: "var(--text3)" }}>Unused: made by an agent, no tab, idle over {hours} h. Yours is never removed.</div>
      <span className="sr-only">{total} container{total === 1 ? "" : "s"} saved.</span>
    </div>
  );
}

/** Containers: the agent ones nobody uses any more, gone in one go. */
function Containers() {
  const [total, setTotal] = useState(() => loadProfiles(globalThis.localStorage ?? null).length);
  const [count, setCount] = useState(() => unusedIds().length);
  /* The ids the confirm counts, fixed when it opens: "Remove 2" removes those 2. */
  const [asking, setAsking] = useState<string[] | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const hours = IDLE_DROP_MS / 3_600_000;
  const go = () => {
    const n = asking ? removeUnused(asking) : 0;
    setAsking(null);
    setSaid(`Removed ${n} container${n === 1 ? "" : "s"}, with their cookies and storage.`);
    setTotal(loadProfiles(globalThis.localStorage ?? null).length);
    setCount(unusedIds().length);
  };
  return (
    <Section id="containers" title="Containers">
      <SettingRow kind="control" {...row("browser.removeUnused")}
        control={<Button disabled={!count} onClick={() => { setSaid(null); const ids = unusedIds(); setCount(ids.length); setAsking(ids.length ? ids : null); }}>Remove unused</Button>} />
      <ContainerMap count={count} hours={hours} total={total} />
      {asking && (
        <div role="alertdialog" className="flex items-center gap-2 px-3 py-2 text-[12px]" style={{ color: "var(--text2)" }}>
          <span className="flex-1">Remove {asking.length} agent container{asking.length === 1 ? "" : "s"} and their cookies?</span>
          <Button onClick={() => setAsking(null)}>Cancel</Button>
          <Button onClick={go}>Remove {asking.length}</Button>
        </div>
      )}
      {said && <div role="status" className="px-3 py-2 text-[12px]" style={{ color: "var(--text2)" }}>{said}</div>}
    </Section>
  );
}

/** Browser on the new shell. Who may drive it lives on Permissions. */
export function BrowserPage({ c }: { c: PageCtx }) {
  const [home, setHome] = useState(homePageRaw);
  const [engine, setEngine] = useState<SearchEngine>(searchEngine);
  const [noScreen, setNoScreen] = useState(agentsWithoutScreen);
  const [why, setWhy] = useState(false);
  const [agentHelp, setAgentHelp] = useState(false);
  const [copied, setCopied] = useState(false);
  const [vaultTick, setVaultTick] = useState(0);
  const vault = useVault(vaultTick, CAN_IMPORT_COOKIES);
  const imp = useImport(() => setVaultTick((t) => t + 1));
  const validHome = (v: string) => (!v.trim() || normalizeNavigationUrl(v.trim()) ? null : "That is not an address this will open. Use http(s), or leave it empty.");
  return (
    <SettingsPage wide title="Browser" purpose="Where the browser opens, and how it gets your logins."
      sections={[
        { id: "opens", title: "Where it opens", kind: "normal", body: (
          <Section id="opens" title="Where it opens" side={<BrowserPreview compact home={home} searchEngine={SEARCH_ENGINE_LABELS[engine]} />}>
            <SettingRow kind="control" agentNever="a page the browser opens by itself, with the owner's signed-in sessions: not something an agent points elsewhere" {...row("browser.home")} control={<TextCommitField label="Home page" value={home} placeholder="https://duckduckgo.com" validate={validHome} onSave={(v) => { setHomePage(v); setHome(homePageRaw()); }} />} />
            <SettingRow kind="control" {...row("browser.searchEngine")} control={<Select align="right" value={engine} options={(Object.keys(SEARCH_ENGINE_LABELS) as SearchEngine[]).map((id) => ({ value: id, label: SEARCH_ENGINE_LABELS[id] }))} onChange={(v) => instantSave<string>(engine, v, (x) => { setting("browser.searchEngine").set(x); setEngine(x as SearchEngine); })} />} />
          </Section>) },
        ...(CAN_IMPORT_COOKIES ? [
          { id: "logins", title: "Login vault", kind: "normal" as const, body: <Logins v={vault} imp={imp} /> },
          { id: "sites", title: "Sites in the vault", kind: "normal" as const, body: <VaultList v={vault} imp={imp} /> },
        ] : []),
        { id: "containers", title: "Containers", kind: "normal", body: <Containers /> },
        { id: "agents", title: "For agents", kind: "normal", body: (
          <Section id="agents" title="For agents">
            <SettingRow kind="control" {...row("browser.agentsWithoutScreen")} control={
              <button type="button" role="switch" aria-checked={noScreen} aria-label="Let agents browse with the pane closed"
                onClick={() => instantSave<boolean>(noScreen, !noScreen, (x) => { setting("browser.agentsWithoutScreen").set(x); setNoScreen(x); })}
                className="agx-switch-hit inline-flex items-center rounded-full"><Switch on={noScreen} /></button>} />
            <SettingRow kind="link" {...row("browser.agentsHelp")} linkText={agentHelp ? "Hide help" : "Open help"} onOpen={() => setAgentHelp(!agentHelp)} />
            {agentHelp && <div data-agents-help style={{ borderTop: LINE }}>
            <SettingRow kind="control" {...row("browser.agentLines")} control={<Button onClick={() => { void navigator.clipboard?.writeText(AGENT_LINES.join("\n")).then(() => setCopied(true)).catch(() => undefined); }}>{copied ? "Copied" : "Copy"}</Button>} />
            <SettingRow kind="link" {...row("browser.whyWindow")} linkText={why ? "Hide" : "Read why"} onOpen={() => setWhy(!why)} />
            {why && <div role="note" className="px-3 py-2 text-[12px]" style={{ color: "var(--text2)" }}>An agent that fetches a URL from its shell gets the signed-out page, because your logins live in a browser. This one has them.</div>}
            <SettingRow kind="link" label="Who may drive, sites and verbs" help="Lives on Permissions." linkText="Open Permissions" onOpen={() => c.setPane("permBrowser" as never)} />
            </div>}
          </Section>) },
      ]} />
  );
}
