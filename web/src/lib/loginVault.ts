/*
 * The words the Login vault section shows (Settings ▸ Browser, mockup states
 * 3, 7 and 8). Pure, so they are tested without a window. Every input is what
 * Electron main answers from `ag:vaultList`: names, counts, times in seconds.
 * Never a cookie name or value.
 */

export interface VaultSiteRow {
  site: string; cookies: number; session: number; expires: number | null;
  sensitive: boolean; suggested: boolean; needsStorage: boolean; isDefault: boolean;
  /** "Never copy": the vault keeps this login out of every lane and jar. An
   *  old main sends no key: read as false. */
  noCopy?: boolean;
}
export interface VaultRow { vault: string; label: string; updatedAt: number; sites: VaultSiteRow[] }
export interface PullRow { at: number; event: "pull" | "refused" | "signout"; site: string; agent: string; lane: string; vault?: string; count: number; why?: string }
export interface VaultListing { vaults: VaultRow[]; pulls: PullRow[]; signOutAtEnd: boolean; defaultVault?: string | null }

/** The choices for "a site in several vaults signs in from": none, then each
 *  vault that holds a site. A label two vaults share carries its id, so each
 *  choice names one. Pure. */
export function defaultVaultOptions(vaults: readonly VaultRow[]): { value: string; label: string }[] {
  const held = vaults.filter((v) => v.sites.length);
  const twice = (l: string) => held.filter((v) => (v.label || v.vault) === l).length > 1;
  return [
    { value: "", label: "ask me" },
    ...held.map((v) => { const l = v.label || v.vault; return { value: v.vault, label: twice(l) ? `${l} (${v.vault})` : l }; }),
  ];
}

/** Main's answer, kept only where it has the shape the section draws. */
export function readListing(a: { ok: boolean; [k: string]: unknown }): VaultListing | null {
  if (!a.ok) return null;
  const vaults = Array.isArray(a.vaults) ? (a.vaults as VaultRow[]).filter((v) => v && typeof v.vault === "string" && Array.isArray(v.sites)) : [];
  const pulls = Array.isArray(a.pulls) ? (a.pulls as PullRow[]).filter((p) => p && typeof p.site === "string" && typeof p.at === "number") : [];
  return { vaults, pulls, signOutAtEnd: a.signOutAtEnd !== false, defaultVault: typeof a.defaultVault === "string" && a.defaultVault ? a.defaultVault : null };
}

const DAY = 86_400;

/** "in 41 days", "in 2 hours", "Expired yesterday", "Ends with the session". */
export function goodUntil(expires: number | null, now: number): string {
  if (expires === null) return "Ends with the session";
  const left = expires - now;
  if (left <= 0) {
    const ago = Math.floor(-left / DAY);
    return ago < 1 ? "Expired today" : ago < 2 ? "Expired yesterday" : `Expired ${ago} days ago`;
  }
  if (left < 3600) return `in ${Math.max(1, Math.round(left / 60))} min`;
  if (left < DAY) { const h = Math.round(left / 3600); return `in ${h} hour${h === 1 ? "" : "s"}`; }
  const d = Math.round(left / DAY);
  return `in ${d} day${d === 1 ? "" : "s"}`;
}

/** "12 min ago", "1 h ago", "2 d ago". */
export function ago(at: number, now: number): string {
  const s = Math.max(0, now - at);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < DAY) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / DAY)} d ago`;
}

/** The last agent that took this site, or "Never". */
export function lastTakenBy(pulls: readonly PullRow[], site: string, now: number): string {
  let last: PullRow | null = null;
  for (const p of pulls) if (p.site === site && p.event === "pull" && (!last || p.at > last.at)) last = p;
  return last ? `${last.agent || "an agent"} · ${ago(last.at, now)}` : "Never";
}

/** One log line's "What" column: what happened, never a value. */
export function pullWhat(p: PullRow): string {
  if (p.event === "pull") return `Pulled ${p.count}`;
  if (p.event === "signout") return p.why ? `Signed out (${p.why})` : "Signed out";
  return `Refused${p.why ? `: ${p.why}` : ""}`;
}

/** One site's log, newest first. */
export const siteLog = (pulls: readonly PullRow[], site: string): PullRow[] =>
  pulls.filter((p) => p.site === site).sort((a, b) => b.at - a.at);

/** "8 sites from Zen · imported today 09:12". */
export function vaultSummary(v: VaultRow, now: number): string {
  const n = v.sites.length;
  const when = v.updatedAt ? ` · imported ${ago(v.updatedAt, now)}` : "";
  return `${n} site${n === 1 ? "" : "s"} from ${v.label || v.vault}${when}`;
}

/** Where an Import puts the logins (state 2's "Put in"). */
export type PutIn = "both" | "vault" | "browser";
export const PUT_IN_LABEL: Readonly<Record<PutIn, string>> = {
  both: "Vault and my browser",
  vault: "Vault only",
  browser: "My browser only",
};

/** The browser profile a vault was read from: its id is `<profile>/<container>`. */
export const sourceOf = (vault: string): string => { const i = vault.lastIndexOf("/"); return i > 0 ? vault.slice(0, i) : vault; };

/** Mockup state 4: one card per lane and site signed in from the vault now. */
export interface SignedInCard { lane: string; agent: string; site: string; count: number; at: number | null }
export function signedInCards(lanes: readonly { lane: string; agent: string; sites: readonly string[] }[], pulls: readonly PullRow[]): SignedInCard[] {
  const out: SignedInCard[] = [];
  for (const l of lanes) {
    for (const site of l.sites) {
      let last: PullRow | null = null;
      for (const p of pulls) if (p.lane === l.lane && p.site === site && p.event === "pull" && (!last || p.at > last.at)) last = p;
      out.push({ lane: l.lane, agent: l.agent || last?.agent || "", site, count: last?.count ?? 0, at: last?.at ?? null });
    }
  }
  return out;
}

/** "From the vault · 31 cookies · 12 min ago". */
export function signedInLine(c: SignedInCard, now: number): string {
  return `From the vault · ${c.count} cookie${c.count === 1 ? "" : "s"}${c.at === null ? "" : ` · ${ago(c.at, now)}`}`;
}

/** Mockup state 6: an agent found a site's vault login expired, after the
 *  last import of the vault that holds it. One ask per site, newest agent. */
export interface ReimportAsk { site: string; agent: string; at: number; vault: VaultRow }
export function reimportAsks(l: VaultListing): ReimportAsk[] {
  const out = new Map<string, ReimportAsk>();
  for (const p of l.pulls) {
    if (p.event !== "refused" || p.why !== "expired") continue;
    const vault = l.vaults.find((v) => v.sites.some((s) => s.site === p.site));
    if (!vault || p.at < vault.updatedAt) continue;
    const had = out.get(p.site);
    if (!had || p.at > had.at) out.set(p.site, { site: p.site, agent: p.agent, at: p.at, vault });
  }
  return [...out.values()].sort((a, b) => b.at - a.at);
}

/** "The vault login expired · last import 3 h ago from Zen". */
export function reimportLine(a: ReimportAsk, now: number): string {
  return `The vault login expired · last import ${a.vault.updatedAt ? ago(a.vault.updatedAt, now) : "unknown"} from ${a.vault.label || "the browser"}`;
}

/** The vault helper's own hint (server/src/loginvault.ts suggestSensitive),
 *  for the import list's Sensitive tag before a site is in any vault. */
const SENSITIVE_WORDS = ["admin", "bank", "banking", "billing", "prod", "console", "payroll", "finance"];
export const looksSensitive = (site: string): boolean => site.toLowerCase().split(/[.\-_]+/).some((w) => SENSITIVE_WORDS.includes(w));

/** Mockup state 3: one box per browser imported. The store keeps one vault
 *  per `<profile>/<container>`; a box holds every container of one profile.
 *  A site is one row per box: the same site in two containers (or written
 *  `.app.orbit.dev` and `app.orbit.dev`) is merged for display only, good
 *  until the latest expiry, with `vaults` naming every container it is in. */
export interface BoxSite extends VaultSiteRow { vault: string; vaults: string[] }
export interface VaultBox { source: string; label: string; vaults: string[]; updatedAt: number; pending: boolean; sites: BoxSite[] }
const noContainer = (label: string): string => label.replace(/ — container .+$/, "");
const siteKey = (site: string): string => site.replace(/^\./, "").toLowerCase();
function mergeSite(into: BoxSite, s: VaultSiteRow, vault: string): void {
  into.cookies += s.cookies;
  into.session += s.session;
  into.expires = into.expires === null ? s.expires : s.expires === null ? into.expires : Math.max(into.expires, s.expires);
  into.sensitive ||= s.sensitive;
  into.noCopy = (into.noCopy ?? false) || s.noCopy === true;
  into.suggested ||= s.suggested;
  into.needsStorage ||= s.needsStorage;
  into.isDefault ||= s.isDefault;
  if (!into.vaults.includes(vault)) into.vaults.push(vault);
}
export function vaultBoxes(vaults: readonly (VaultRow & { pending?: boolean })[]): VaultBox[] {
  const out = new Map<string, VaultBox>();
  const rows = new Map<string, Map<string, BoxSite>>();
  for (const v of vaults) {
    if (!v.sites.length) continue;
    const source = sourceOf(v.vault);
    let box = out.get(source);
    if (!box) { box = { source, label: noContainer(v.label || source), vaults: [], updatedAt: 0, pending: false, sites: [] }; out.set(source, box); rows.set(source, new Map()); }
    if (v.vault.endsWith("/0") && v.label) box.label = v.label;
    box.vaults.push(v.vault);
    box.updatedAt = Math.max(box.updatedAt, v.updatedAt || 0);
    box.pending ||= v.pending === true;
    const bySite = rows.get(source)!;
    for (const s of v.sites) {
      const key = siteKey(s.site);
      const had = bySite.get(key);
      if (had) { mergeSite(had, s, v.vault); continue; }
      const row: BoxSite = { ...s, site: key, vault: v.vault, vaults: [v.vault] };
      bySite.set(key, row);
      box.sites.push(row);
    }
  }
  for (const b of out.values()) b.sites.sort((a, c) => a.site.localeCompare(c.site) || a.vault.localeCompare(c.vault));
  return [...out.values()];
}

/** "8 sites from Zen · imported 3 h ago". A site in two containers counts once. */
export function boxSummary(b: VaultBox, now: number): string {
  const n = new Set(b.sites.map((s) => s.site)).size;
  const when = b.pending ? " · just put in" : b.updatedAt ? ` · imported ${ago(b.updatedAt, now)}` : "";
  return `${n} site${n === 1 ? "" : "s"} from ${b.label}${when}`;
}

/** A put the vault said yes to, drawn at once (state 3 right after state 2)
 *  until the listing holds that browser. Counts only, from the picker. */
export interface PutDone { source: string; label: string; at: number; sites: readonly { site: string; cookies: number }[] }
export function withPut(l: VaultListing, put: PutDone | null): VaultListing & { vaults: (VaultRow & { pending?: boolean })[] } {
  if (!put || !put.sites.length || l.vaults.some((v) => v.sites.length && sourceOf(v.vault) === put.source)) return l;
  const row: VaultRow & { pending: true } = {
    vault: `${put.source}/0`, label: put.label, updatedAt: put.at, pending: true,
    sites: put.sites.map((s) => ({ site: s.site, cookies: s.cookies, session: 0, expires: null, sensitive: false, suggested: looksSensitive(s.site), needsStorage: false, isDefault: false })),
  };
  return { ...l, vaults: [...l.vaults, row] };
}

/** State 2's head line: "8 of 214 chosen". */
export const chosenLine = (chosen: number, total: number): string => `${chosen} of ${total} chosen`;

/** What the site list shows: one search across every box, an optional
 *  "Sensitive only" filter, the count line, and the site names the bulk
 *  buttons act on (only rows shown, each site once, only those that change). */
export interface VaultShown<V = VaultRow, S = VaultSiteRow> { groups: { vault: V; sites: S[] }[]; shown: number; total: number; count: string; toMark: string[]; toUnmark: string[] }
export function vaultShown<V extends { sites: readonly VaultSiteRow[] }>(vaults: readonly V[], query: string, sensitiveOnly: boolean): VaultShown<V, V["sites"][number]> {
  const q = query.trim().toLowerCase();
  let total = 0;
  const groups = vaults.filter((v) => v.sites.length).map((v) => {
    total += v.sites.length;
    return { vault: v, sites: v.sites.filter((s) => matches(q)(s.site) && (!sensitiveOnly || s.sensitive)) };
  });
  const rows = groups.flatMap((g) => g.sites);
  const pick = (want: boolean) => [...new Set(rows.filter((s) => s.sensitive !== want).map((s) => s.site))];
  return { groups, shown: rows.length, total, count: shownLine(rows.length, total), toMark: pick(true), toUnmark: pick(false) };
}

/** The count both site lists show: "12 of 303 sites". */
export const shownLine = (shown: number, total: number): string => `${shown} of ${total} site${total === 1 ? "" : "s"}`;
const matches = (q: string) => (site: string): boolean => !q || site.toLowerCase().includes(q);

/** The import picker's list under the same search: the rows shown, in the
 *  order given, and the count line. */
export function pickShown<S extends { site: string }>(sites: readonly S[], query: string): { rows: S[]; count: string } {
  const hit = matches(query.trim().toLowerCase());
  const rows = sites.filter((s) => hit(s.site));
  return { rows, count: shownLine(rows.length, sites.length) };
}
/** All / None on the picker: only the shown rows change; a choice outside
 *  the search stays as it was. */
export function chooseShown(chosen: ReadonlySet<string>, rows: readonly { site: string }[], on: boolean): Set<string> {
  const next = new Set(chosen);
  for (const r of rows) { if (on) next.add(r.site); else next.delete(r.site); }
  return next;
}
