/**
 * Turning a browser's cookie rows into cookies this app's browser will send.
 *
 * Extensions are a dead end in Electron — unpacked only, no browser action
 * popups, no native messaging — so a password manager cannot live in the
 * built-in browser. Which means the way your logins get there is the way Orca
 * does it: bring the cookies over. That is not a small permission, and the
 * shape of this file is mostly about the two ways it goes quietly wrong.
 *
 * **Accepted and then never sent.** `session.cookies.set` is forgiving. It
 * takes a cookie that Chromium will then decline to attach to any request, and
 * says nothing. Three ways to earn that:
 *
 *   * *host-only vs domain.* Electron normalises `domain` with a leading dot,
 *     so passing it on every row makes every cookie a domain cookie, and
 *     omitting it on every row makes every cookie host-only. Firefox says which
 *     by the leading dot on `host`, and it must be carried across exactly.
 *   * *sameSite.* Electron defaults the field to `"lax"` when it is absent, not
 *     to `"unspecified"`. Anything a site uses cross-site — an embedded frame,
 *     an SSO callback — is then imported successfully and withheld silently. So
 *     every cookie here carries the field explicitly, and Firefox's 256 is
 *     `unspecified`, not `lax`: Chromium's Lax-by-default has a two-minute
 *     top-level-POST exemption that a literal `lax` does not.
 *   * *already expired.* The rows are still in the file, `set` accepts a past
 *     date without complaint, and Chromium purges it moments later.
 *
 * **The wrong lifetime, everywhere, invisibly.** `moz_cookies.expiry` is in
 * MILLISECONDS on any Firefox whose schema is 16 or newer (this machine reads
 * 17). Handed straight to `expirationDate`, which wants seconds, it becomes the
 * year 58356; Chromium clamps to its 400-day cap rather than erroring, so every
 * imported cookie silently gets the same wrong lifetime and nothing looks amiss.
 *
 * Pure on purpose: no filesystem, no sqlite, no Electron. Every rule above is a
 * test in cookie-import.test.ts, which is the only way any of them can be
 * checked at all — none of them fail loudly enough to be found by using it.
 */

/** Electron's cookie shape, hand-declared: the server has no electron
 *  dependency and must typecheck without one. Kept to the fields this sets. */
export type ElectronSameSite = "unspecified" | "no_restriction" | "lax" | "strict";
export interface ElectronCookie {
  url: string;
  name: string;
  value: string;
  /** Omitted entirely for a host-only cookie. Present means "and subdomains". */
  domain?: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  /** Seconds since the epoch. Absent means a session cookie. */
  expirationDate?: number;
  /** Never omitted — see the note above about Electron's default. */
  sameSite: ElectronSameSite;
}

/** CDP's partition key for a CHIPS / total-cookie-protection cookie. */
export interface PartitionKey { topLevelSite: string; hasCrossSiteAncestor: boolean }

/** A cookie that may be partitioned. `cookies.set` has no partition
 *  parameter, so one with `partitionKey` goes through CDP `Network.setCookie`
 *  and must never be handed to `cookies.set` as is. */
export interface ImportedCookie extends ElectronCookie {
  partitionKey?: PartitionKey;
}

export type SourceKind = "firefox" | "chromium";

export type SkipReason =
  | "expired"
  | "session-only"
  | "partitioned"
  | "encrypted"
  | "not-selected"
  | "bad-host"
  | "other-container";

/** A row as it comes out of either family's database, already normalised to
 *  names that mean the same thing on both sides. */
export interface CookieRow {
  host: string;
  name: string;
  value: string;
  path: string;
  /** Seconds since the epoch; 0 or absent for a session cookie. */
  expires: number;
  secure: boolean;
  httpOnly: boolean;
  sameSite: number;
  /** Origin attributes this cannot carry (Firefox `firstPartyDomain`, an
   *  unparsed partition key). Anything non-empty means the cookie is skipped. */
  partition?: string;
  /** Firefox `userContextId`: WHICH container the cookie lives in, "0" or
   *  absent for none. A container is a separate jar, not a partition. */
  container?: string;
  /** The top-level site a partitioned cookie is keyed to. */
  partitionKey?: PartitionKey;
  /** Chromium rows arrive with nothing readable in `value`. */
  encrypted?: boolean;
}

/**
 * Firefox stores expiry in milliseconds from schema 16 onwards.
 *
 * The divisor is the whole point; the boundary is 16 because that is where the
 * column changed. This machine reads 17.
 */
export const FF_MS_SCHEMA = 16;
export function ffExpirySeconds(expiry: number, userVersion: number): number {
  if (!Number.isFinite(expiry)) return 0;
  return userVersion >= FF_MS_SCHEMA ? Math.floor(expiry / 1000) : Math.floor(expiry);
}

/** Chromium counts microseconds from 1601. Floored, because `expirationDate`
 *  is compared as a number and a fractional second is a number nobody meant. */
export function chromeEpochSeconds(microseconds: number): number {
  if (!Number.isFinite(microseconds) || microseconds <= 0) return 0;
  return Math.floor(microseconds / 1_000_000 - 11_644_473_600);
}

/** Firefox's sameSite constants. 256 is SAMESITE_UNSET and is not corruption. */
const SAME_SITE_FF: Record<number, ElectronSameSite> = {
  0: "no_restriction", 1: "lax", 2: "strict", 256: "unspecified",
};
/** Chromium's, where -1 is UNSPECIFIED. */
const SAME_SITE_CHROMIUM: Record<number, ElectronSameSite> = {
  [-1]: "unspecified", 0: "no_restriction", 1: "lax", 2: "strict",
};

/** Unknown values read as `unspecified` rather than throwing: a constant added
 *  by a future Firefox must not abort somebody's whole import. */
export function sameSiteOf(kind: SourceKind, raw: number): ElectronSameSite {
  const table = kind === "firefox" ? SAME_SITE_FF : SAME_SITE_CHROMIUM;
  return table[raw] ?? "unspecified";
}

/**
 * Firefox's `originAttributes` column, split.
 *
 * `^userContextId=2&partitionKey=%28https%2Cacme.test%29` is two different
 * facts: which container (a whole separate jar) and which partition (CHIPS /
 * total cookie protection). Treating any non-empty column as "partitioned"
 * dropped every first-party login made inside a container.
 */
export function parseOriginAttributes(raw: string): { container: string; partitionKey?: string; other: string } {
  const out: { container: string; partitionKey?: string; other: string } = { container: "0", other: "" };
  const rest: string[] = [];
  for (const pair of raw.replace(/^\^/, "").split("&").filter(Boolean)) {
    const eq = pair.indexOf("=");
    const k = eq < 0 ? pair : pair.slice(0, eq);
    const v = eq < 0 ? "" : decodeURIComponent(pair.slice(eq + 1));
    if (k === "userContextId") out.container = v || "0";
    else if (k === "partitionKey") { if (v) out.partitionKey = v; }
    // Private-browsing rows never reach disk; one that did is not a login to copy.
    else rest.push(pair);
  }
  out.other = rest.join("&");
  return out;
}

/**
 * The sameSite to set, which is not always the one read.
 *
 * Chromium refuses `SameSite=None` on a cookie that is not Secure; older
 * Firefox rows hold exactly that, and each one used to land in `failed` with
 * only a count to show for it. Unspecified is what Chromium itself treats such
 * a cookie as, so the login survives with the meaning the browser gives it.
 */
export function sameSiteFor(kind: SourceKind, raw: number, secure: boolean): ElectronSameSite {
  const s = sameSiteOf(kind, raw);
  return s === "no_restriction" && !secure ? "unspecified" : s;
}

/**
 * Firefox's `partitionKey` attribute, `(https,acme.test)` with an optional
 * port and an `f` flag for a cross-site ancestor, as CDP wants it. Null for
 * anything else, which then stays an un-carryable partition.
 */
export function firefoxPartitionKey(raw: string): PartitionKey | null {
  const m = /^\(([a-z]+),([^,()]+)((?:,[^,()]*)*)\)$/.exec(raw.trim());
  if (!m) return null;
  const extra = (m[3] ?? "").split(",").filter(Boolean);
  const port = extra.find((x) => /^\d+$/.test(x));
  return { topLevelSite: `${m[1]}://${m[2]}${port ? `:${port}` : ""}`, hasCrossSiteAncestor: extra.includes("f") };
}

/** Chromium's `top_frame_site_key` (`https://acme.test`). The column carries
 *  no ancestor bit, so it is false (Preflight decision F11). */
export function chromiumPartitionKey(raw: string): PartitionKey | null {
  return /^[a-z]+:\/\/[^/]+$/.test(raw) ? { topLevelSite: raw, hasCrossSiteAncestor: false } : null;
}

/** A leading dot is how both families say "and every subdomain". */
export const isHostOnly = (host: string): boolean => !host.startsWith(".");

/** The address the cookie belongs to. The path is part of it so the two can
 *  never disagree, and the dot is stripped because a URL host has none. */
export function cookieUrl(host: string, path: string, secure: boolean): string {
  const bare = host.replace(/^\./, "");
  const p = path && path.startsWith("/") ? path : "/";
  return `${secure ? "https" : "http"}://${bare}${p}`;
}

/**
 * Second-level suffixes that are really public: `co.uk` is not somebody's
 * domain, `foo.co.uk` is.
 *
 * A short list rather than the whole Public Suffix List, and the shortness is
 * the honest part — this decides how the picker GROUPS sites, so being wrong
 * splits one login into two rows rather than importing anything unintended.
 */
const TWO_LABEL_SUFFIXES = new Set([
  "co.uk", "org.uk", "ac.uk", "gov.uk", "co.jp", "or.jp", "ne.jp", "co.kr",
  "com.au", "net.au", "org.au", "com.br", "com.mx", "com.ar", "co.nz",
  "co.za", "com.tr", "com.cn", "com.sg", "com.hk", "co.in", "com.es",
]);

/**
 * The site a cookie belongs to, as a person thinks of it.
 *
 * Grouping by host would put `.mozilla.org` and `support.mozilla.org` in
 * separate rows — measured, in the very Firefox profile this was written
 * against — and ticking one of them imports half a session, which is the
 * accepted-then-never-sent failure wearing a friendlier face.
 */
export function siteOf(host: string): string {
  const bare = host.replace(/^\./, "").toLowerCase();
  /* An address is its own site: "127.0.0.1" split by dots became "0.1". */
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(bare) || bare.includes(":")) return bare;
  const parts = bare.split(".").filter(Boolean);
  if (parts.length <= 2) return bare;
  const lastTwo = parts.slice(-2).join(".");
  return TWO_LABEL_SUFFIXES.has(lastTwo) ? parts.slice(-3).join(".") : lastTwo;
}

export type Converted = { ok: true; cookie: ImportedCookie } | { ok: false; reason: SkipReason };

/**
 * One row into one cookie, or the named reason it cannot be.
 *
 * `nowSeconds` is passed rather than read so that "already expired" is a
 * decision a test can make.
 */
export function toElectronCookie(
  row: CookieRow, kind: SourceKind, nowSeconds: number, opts: { keepPartitioned?: boolean; keepSession?: boolean } = {},
): Converted {
  if (row.encrypted) return { ok: false, reason: "encrypted" };
  // A partitioned cookie only into a store that can set it partitioned (the
  // vault, poured in through CDP); the person's jar via cookies.set cannot.
  if (row.partitionKey && !opts.keepPartitioned) return { ok: false, reason: "partitioned" };
  // Partition attributes have no representation in `cookies.set` — there is
  // no partition parameter — so importing one unpartitioned changes what it
  // means. Containers are not this: see `container`.
  if (row.partition) return { ok: false, reason: "partitioned" };
  if (!row.host || !row.name) return { ok: false, reason: "bad-host" };
  // A session cookie into the person's jar is refused: the browser it came
  // from will drop it. The vault keeps it (decision F9 labels it), because a
  // login that is only a session cookie is otherwise never importable.
  if (!row.expires && !opts.keepSession) return { ok: false, reason: "session-only" };
  const session = !row.expires;
  if (!session && row.expires <= nowSeconds) return { ok: false, reason: "expired" };

  const path = row.path && row.path.startsWith("/") ? row.path : "/";
  const cookie: ImportedCookie = {
    url: cookieUrl(row.host, path, row.secure),
    name: row.name,
    value: row.value,
    path,
    secure: row.secure,
    httpOnly: row.httpOnly,
    ...(session ? {} : { expirationDate: row.expires }),
    sameSite: sameSiteFor(kind, row.sameSite, row.secure),
  };
  // Present only for a domain cookie. `__Host-` names are rejected outright by
  // Chromium unless the domain is absent, the path is `/`, secure is true and
  // the url is https — which falls out of carrying the flag across honestly.
  if (!isHostOnly(row.host)) cookie.domain = row.host;
  if (row.partitionKey) {
    cookie.partitionKey = row.partitionKey;
    // CHIPS requires Secure; a partitioned cookie that is not is refused anyway.
    if (!cookie.secure) return { ok: false, reason: "partitioned" };
  }
  return { ok: true, cookie };
}

export interface ImportPlan {
  install: ImportedCookie[];
  skipped: Record<SkipReason, number>;
  /** Every site in the source, with how many live cookies it has — what the
   *  picker lists, and it carries no names and no values. */
  sites: { site: string; cookies: number }[];
}

const noSkips = (): Record<SkipReason, number> =>
  ({ expired: 0, "session-only": 0, partitioned: 0, encrypted: 0, "not-selected": 0, "bad-host": 0, "other-container": 0 });

/**
 * What would be imported, and what would not, and why.
 *
 * `sites` is computed from every row so the picker can offer a site the caller
 * did not choose; `install` contains only the chosen ones. An empty selection
 * installs nothing — that is the invariant this whole feature rests on, and it
 * has a test of its own.
 */
export function planImport(
  rows: CookieRow[],
  kind: SourceKind,
  opts: { sites: string[]; nowSeconds: number; container?: string; keepPartitioned?: boolean; keepSession?: boolean },
): ImportPlan {
  const want = opts.container ?? "0";
  const chosen = new Set(opts.sites.map((s) => s.toLowerCase()));
  const skipped = noSkips();
  const install: ImportedCookie[] = [];
  const perSite = new Map<string, number>();

  for (const row of rows) {
    // One plan is one jar: a container's cookies never land in another's.
    if ((row.container ?? "0") !== want) { skipped["other-container"] += 1; continue; }
    const conv = toElectronCookie(row, kind, opts.nowSeconds, { keepPartitioned: opts.keepPartitioned, keepSession: opts.keepSession });
    if (!conv.ok) { skipped[conv.reason] += 1; continue; }
    const site = siteOf(row.host);
    perSite.set(site, (perSite.get(site) ?? 0) + 1);
    if (!chosen.has(site)) { skipped["not-selected"] += 1; continue; }
    install.push(conv.cookie);
  }

  const sites = [...perSite.entries()]
    .map(([site, cookies]) => ({ site, cookies }))
    .sort((a, b) => b.cookies - a.cookies || a.site.localeCompare(b.site));
  return { install, skipped, sites };
}
