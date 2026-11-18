/*
 * The login vault, on Electron main's side (plan part C and D).
 *
 * Main is the only process that ever holds a pulled site's values: the
 * one-shot vault helper (server/src/cookieread.ts `vault-pull`) writes them on
 * its pipe to main, main sets them into ONE ephemeral lane and drops them.
 * The server and the agent get a count, never this.
 *
 * Requires nothing from Electron, so the decisions here are tested with bun
 * (server/test/vault-pull.test.ts).
 */
"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");

/** Same place server/src/loginvault.ts `vaultDir` uses. */
function vaultDirFor(env = process.env, home = os.homedir()) {
  if (env.AGX_VAULT_DIR) return env.AGX_VAULT_DIR;
  const data = env.XDG_DATA_HOME || path.join(home, ".local", "share");
  return path.join(data, "agentglass", "vaults");
}

/**
 * Main's own book of lanes it filled from the vault (decision F2). "Remove"
 * and "Empty vault" sweep from here, not from any list a renderer sends.
 */
function createVaultLanes() {
  /** @type {Map<string, { partition: string, agent: string, sites: Map<string, string> }>} */
  const lanes = new Map();
  /* Raised by every Remove and Empty (finding 6): a pull that asked the
     person before the vault changed sees a new number and stops. */
  let epoch = 0;
  return {
    epoch() { return epoch; },
    bump() { epoch += 1; return epoch; },
    /** @param {string} lane @param {string} partition @param {string} agent @param {string} site @param {string} vault */
    mark(lane, partition, agent, site, vault) {
      const row = lanes.get(lane) || { partition, agent, sites: new Map() };
      row.sites.set(site, vault);
      lanes.set(lane, row);
    },
    /** @param {string} lane */
    has(lane) { return lanes.has(lane); },
    /** @param {string} lane */
    get(lane) { return lanes.get(lane); },
    /** @param {string} lane */
    drop(lane) { const r = lanes.get(lane); lanes.delete(lane); return r; },
    /** Lanes holding a login from `vault`, or every filled lane when it is empty.
     *  @param {string} [vault] */
    holding(vault) {
      return [...lanes.entries()]
        .filter(([, r]) => !vault || [...r.sites.values()].includes(vault))
        .map(([lane, r]) => ({ lane, ...r }));
    },
    ids() { return [...lanes.keys()]; },
  };
}

/**
 * Why a pull is refused, in one sentence, or null when it may go ahead.
 * Checked BEFORE the helper is spawned, so a refused pull never opens a vault.
 * @param {{ readonly: boolean, lane: { ephemeral: boolean } | undefined, site: string }} req
 */
function pullRefusal(req) {
  if (req.readonly) return "the browser is in read-only mode, so it cannot sign a lane in from the vault";
  if (!req.site || !/^[a-z0-9.-]{1,253}$/.test(req.site)) return "name one site, like acme.test";
  if (!req.lane) return "there is no lane with that id; open one with browser_lane new --ephemeral first";
  if (!req.lane.ephemeral) {
    return "a persistent browser profile cannot pull from the vault; open an ephemeral lane (browser_lane new --ephemeral) so the login dies with the task";
  }
  return null;
}

/**
 * A vault cookie as `session.cookies.set` takes it. Partitioned ones cannot go
 * this way (Electron's cookies.set has no partition key), so they are left for
 * the lane's page over CDP and counted.
 * @param {any} c
 */
function toLaneCookie(c) {
  if (!c || typeof c !== "object" || c.partitionKey) return null;
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const k of ["url", "name", "value", "domain", "path", "secure", "httpOnly", "sameSite", "expirationDate"]) {
    if (c[k] !== undefined) out[k] = c[k];
  }
  /* An explicit path on every cookie: left out, Chromium derives it from the url ("/x/y" -> "/x"), and the hash would read "/". */
  if (typeof out.path !== "string" || !out.path.startsWith("/")) out.path = defaultPathOf(out.url);
  return out;
}

/** Chromium's default cookie path (RFC 6265 5.1.4): the url's path up to its last "/", or "/".
 * @param {unknown} url */
function defaultPathOf(url) {
  try {
    const p = new URL(String(url)).pathname;
    const i = p.lastIndexOf("/");
    return i > 0 ? p.slice(0, i) : "/";
  } catch { return "/"; }
}

/**
 * One pull-log line: site, agent, lane, time, count. Anything else a caller
 * passes is dropped here, so a value can never reach the file by accident.
 * @param {string} dir
 * @param {{ event: string, site: string, agent: string, lane: string, vault?: string, count: number, why?: string, cause?: string, left?: number, vaultLeft?: number | null }} e
 * @param {number} [now]
 */
function appendPullLog(dir, e, now = Math.floor(Date.now() / 1000)) {
  const line = {
    at: now,
    event: ["pull", "refused", "signout"].includes(e.event) ? e.event : "refused",
    site: String(e.site || "").slice(0, 253),
    agent: String(e.agent || "").slice(0, 64),
    lane: String(e.lane || "").slice(0, 64),
    ...(e.vault ? { vault: String(e.vault).slice(0, 128) } : {}),
    count: Number.isFinite(e.count) ? e.count : 0,
    ...(e.why ? { why: String(e.why).slice(0, 200) } : {}),
    /* A wipe's proof: how many cookies the site still holds, and how many of them the vault put in. */
    ...(Number.isFinite(e.left) ? { left: e.left } : {}),
    ...(typeof e.vaultLeft === "number" ? { vaultLeft: e.vaultLeft } : {}),
    /* No book to read back: the proof is unknown, and the log says so. */
    ...(e.vaultLeft === null ? { proof: "unknown" } : {}),
    /* What started it: a first visit, or the `vault` verb. Anything else is dropped. */
    ...(e.cause === "visit" || e.cause === "verb" ? { cause: e.cause } : {}),
  };
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, "pulls.jsonl");
  fs.appendFileSync(file, JSON.stringify(line) + "\n", { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return line;
}

/**
 * A vault settings change that needs main's own native confirm: taking the
 * "sensitive" mark off a site (finding 2), because the next pull of it then
 * asks nobody; and turning "Sign agents out" off (New 2), because no lane
 * signs out at task end after that. Turning either one on stays free.
 * @param {{ site?: unknown, sensitive?: unknown, signOutAtEnd?: unknown }} ask
 */
function settingsNeedConfirm(ask) {
  return settingsConfirmDialogs(ask).length > 0;
}

/** The native confirms a settings change needs, in order; [] = none.
 *  Turning "Sign agents in on first visit" ON is one of them: it loosens, so
 *  only the person's answer to main's own dialog lets it through. Off is free.
 *  @param {{ site?: unknown, sensitive?: unknown, signOutAtEnd?: unknown, signInOnVisit?: unknown }} ask
 *  @param {{ visitSites?: number }} [info] how many vault sites are not sensitive */
function settingsConfirmDialogs(ask, info = {}) {
  if (!ask) return [];
  const out = [];
  if (ask.sensitive === false) out.push(sensitiveOffDialog(typeof ask.site === "string" ? ask.site : ""));
  if (ask.noCopy === false) out.push(noCopyOffDialog(typeof ask.site === "string" ? ask.site : ""));
  if (ask.signOutAtEnd === false) out.push(signOutOffDialog());
  if (ask.signInOnVisit === true) out.push(signInOnVisitOnDialog(typeof info.visitSites === "number" ? info.visitSites : null));
  return out;
}

/** Main's confirm for turning sign-in on visit on. Cancel is the default.
 *  @param {number | null} n the vault sites that are not marked sensitive */
function signInOnVisitOnDialog(n) {
  const count = n === null ? "" : ` (${n} site${n === 1 ? "" : "s"})`;
  return {
    type: /** @type {"warning"} */ ("warning"), buttons: ["Cancel", "Turn on"], defaultId: 0, cancelId: 0, noLink: true,
    title: "Login vault",
    message: "Sign agents in on their first visit?",
    detail: `Agents will be signed in to every site in your vault that is not marked sensitive${count}, the first time they open it in a new container.`,
  };
}

/**
 * Main's site index for sign-in on visit, from one `vault-list` answer:
 * names and flags only, never a value. "failed" when the vault could not be
 * read: then no on-visit pull runs until the next rebuild.
 * @param {any} answer
 * @returns {{ on: boolean, sites: Map<string, { vaults: string[], sensitive: boolean, noCopy: boolean }> } | "failed"}
 */
function visitIndexFrom(answer) {
  if (!answer || answer.ok !== true || !Array.isArray(answer.vaults)) return "failed";
  /** @type {Map<string, { vaults: string[], sensitive: boolean, noCopy: boolean }>} */
  const sites = new Map();
  for (const v of answer.vaults) {
    if (!v || typeof v.vault !== "string" || !Array.isArray(v.sites)) continue;
    for (const s of v.sites) {
      if (!s || typeof s.site !== "string") continue;
      const row = sites.get(s.site) ?? { vaults: [], sensitive: false, noCopy: false };
      row.vaults.push(v.vault);
      row.sensitive ||= s.sensitive === true;
      row.noCopy ||= s.noCopy === true;
      sites.set(s.site, row);
    }
  }
  return { on: answer.signInOnVisit === true, sites };
}

/** How many vault sites a sign-in on visit could reach (not sensitive, not "never copy").
 *  @param {any} answer a `vault-list` answer */
function visitSiteCount(answer) {
  const idx = visitIndexFrom(answer);
  if (idx === "failed") return null;
  let n = 0;
  for (const row of idx.sites.values()) if (!row.sensitive && !row.noCopy) n += 1;
  return n;
}

/**
 * Whether a sign-in on visit may go on to the helper, decided from what main
 * already holds: null = pull; else the answer, given BEFORE any spawn. Order:
 * read-only mode, main's off marker (`marker` false = off, nothing else
 * read), the index, the sealed setting (the truth), the site, a login the
 * lane already holds, a "never copy" mark, a sensitive mark.
 * @param {{ readonly?: boolean, marker: boolean, index?: ReturnType<typeof visitIndexFrom> | null, hasLogin?: boolean }} state
 * @param {string} site
 * @returns {{ ok: false, code: string, error?: string } | null}
 */
function onVisitDecision(state, site) {
  if (state.readonly) return { ok: false, code: "refused", error: "the browser is in read-only mode, so it cannot sign a lane in from the vault" };
  if (!state.marker) return { ok: false, code: "off" };
  if (!state.index || state.index === "failed") return { ok: false, code: "index", error: "the vault could not be read; ask with browser_vault" };
  if (!state.index.on) return { ok: false, code: "off" };
  const row = state.index.sites.get(site);
  if (!row) return { ok: false, code: "none" };
  if (state.hasLogin) return { ok: false, code: "has-login" };
  if (row.noCopy) return { ok: false, code: "no-copy", error: noCopyLine(site) };
  if (row.sensitive) return { ok: false, code: "sensitive", error: `${site} is marked sensitive: ask for it with browser_vault; the person is asked` };
  return null;
}

/**
 * The same decision with main's lookups as callbacks, so each is reached only
 * when the one before let the ask through: read-only or off = no index read,
 * no spawn; a sealed setting that says off writes main's off marker, so the
 * next visit reads nothing.
 * @param {{ readonly?: boolean, marker: () => boolean, index: () => Promise<ReturnType<typeof visitIndexFrom>>, hasLogin: () => Promise<boolean>, markOff: () => void }} deps
 * @param {string} site
 */
async function visitGate(deps, site) {
  const readonly = deps.readonly === true;
  if (readonly || !deps.marker()) return onVisitDecision({ readonly, marker: false }, site);
  const index = await deps.index();
  const early = onVisitDecision({ marker: true, index }, site);
  if (early && early.code === "off") deps.markOff();
  if (early) return early;
  return onVisitDecision({ marker: true, index, hasLogin: await deps.hasLogin() }, site);
}

/**
 * Put one site's cookies into a lane's jar, checking before EACH one that the
 * lane is still there and (on visit) that main's deadline has not passed.
 * Partitioned ones are returned as CDP cookies for the lane's page. `stop`
 * says why it stopped early; the caller wipes what was set.
 * @param {any[]} cookies
 * @param {{ set: (c: Record<string, unknown>) => Promise<unknown>, gone: () => boolean, late: () => boolean }} io
 */
async function putLaneCookies(cookies, io) {
  let set = 0;
  let failed = 0;
  /** @type {Record<string, unknown>[]} */
  const chips = [];
  /** @type {"gone" | "late" | null} */
  let stop = null;
  for (const c of cookies) {
    if (io.gone()) { stop = "gone"; break; }
    if (io.late()) { stop = "late"; break; }
    if (c && c.partitionKey) { const p = toCdpCookie(c); if (p) chips.push(p); else failed += 1; continue; }
    const cookie = toLaneCookie(c);
    if (!cookie) { failed += 1; continue; }
    try { await io.set(cookie); set += 1; } catch { failed += 1; }
  }
  return { set, failed, chips, stop };
}

/**
 * A deadline for one on-visit pull: main cannot be cancelled from the server,
 * so it gives up on its own, `budgetMs` after the ask arrived (the server
 * waits 5 s longer). Capped, so a window cannot ask for a longer one.
 * `deadlineAt` is the time the server fixed when it sent the ask: a window
 * that read the ask late stops at it, never after (the earlier of the two).
 * @param {unknown} budgetMs
 * @param {number} [now]
 * @param {unknown} [deadlineAt] epoch ms
 */
function visitDeadline(budgetMs, now = Date.now(), deadlineAt = undefined) {
  const MAX = 25_000;
  const b = typeof budgetMs === "number" && Number.isFinite(budgetMs) && budgetMs > 0 ? Math.min(budgetMs, MAX) : MAX;
  const own = now + b;
  return typeof deadlineAt === "number" && Number.isFinite(deadlineAt) ? Math.min(own, deadlineAt) : own;
}

/** Main's confirm for turning "Sign agents out" off. Keep is the default. */
function signOutOffDialog() {
  return {
    type: /** @type {"warning"} */ ("warning"), buttons: ["Keep signing out", "Stay signed in"], defaultId: 0, cancelId: 0, noLink: true,
    title: "Login vault",
    message: "Stop signing agents out when their task ends?",
    detail: "A lane signed in from the vault then stays signed in after the agent is done, until it is idle for 15 minutes.",
  };
}

/** Main's confirm for taking the mark off. Deny is the default.
 *  @param {string} site */
function sensitiveOffDialog(site) {
  return {
    type: /** @type {"warning"} */ ("warning"), buttons: ["Keep sensitive", "Stop asking"], defaultId: 0, cancelId: 0, noLink: true,
    title: "Login vault",
    message: `Stop asking before agents sign in to ${site || "this site"}?`,
    detail: "Agents can then sign in to it from the vault with no question to you.",
  };
}

/** The one sentence an agent gets for a "never copy" site. The same words as
 *  server/src/loginvault.ts `noCopyLine`.
 *  @param {string} site */
function noCopyLine(site) {
  return `${site} logs you out elsewhere when its login is copied. Ask the person to sign in once inside agentglass's own browser.`;
}

/** Main's confirm for taking the "never copy" mark off. Keep is the default.
 *  @param {string} site */
function noCopyOffDialog(site) {
  return {
    type: /** @type {"warning"} */ ("warning"), buttons: ["Keep never copy", "Allow copies"], defaultId: 0, cancelId: 0, noLink: true,
    title: "Login vault",
    message: `Let the vault copy your ${site || "this site"} login?`,
    detail: "Some sites sign you out of every browser when a copy of the login is used somewhere else. Agents could then be signed in to it from the vault.",
  };
}

/**
 * Main's confirm for "Use in my browser" (finding 7). It says the logins go
 * into the person's OWN browser, where no read-verb block applies, and names
 * every sensitive site; with one there, Cancel is the default.
 * @param {string[]} sites the sites being poured in ([] = every site)
 * @param {string[]} sensitive the sensitive ones among them
 * @param {string[]} [noCopy] the "never copy" ones, left out
 */
function useInBrowserDialog(sites, sensitive, noCopy = []) {
  const list = (/** @type {string[]} */ xs) => `${xs.slice(0, 12).join(", ")}${xs.length > 12 ? `, and ${xs.length - 12} more` : ""}`;
  const lines = [];
  if (sites.length) lines.push(list(sites));
  if (sensitive.length) lines.push(`Sensitive: ${list(sensitive)}. These go into your browser too.`);
  if (noCopy.length) lines.push(`Not copied: ${list(noCopy)}. These sign you out elsewhere when their login is copied: sign in to them once inside agentglass's own browser.`);
  lines.push("They go into your own browser, not an agent's lane. Anyone who can use this window — including an agent you let drive it — will be signed in to these sites, and can read these logins there.");
  return {
    type: /** @type {"warning"} */ ("warning"), buttons: ["Use in my browser", "Cancel"], defaultId: 1, cancelId: 1, noLink: true,
    message: sites.length ? `Sign your browser in to ${sites.length} site${sites.length === 1 ? "" : "s"} from this vault?` : "Sign your browser in to every site in this vault?",
    detail: lines.join("\n\n"),
  };
}

/** Electron's sameSite words, as CDP's Network.setCookie says them. */
const CDP_SAME_SITE = { no_restriction: "None", lax: "Lax", strict: "Strict" };

/**
 * A partitioned (CHIPS) vault cookie as CDP `Network.setCookie` takes it, on
 * the lane's own page. Null for one that is not partitioned (that one goes
 * through `cookies.set`, see `toLaneCookie`) or that CDP would refuse: a
 * partitioned cookie must be Secure, and its key must name a top-level site.
 * @param {any} c
 */
function toCdpCookie(c) {
  if (!c || typeof c !== "object" || !c.partitionKey) return null;
  const key = c.partitionKey;
  if (typeof key.topLevelSite !== "string" || !/^https?:\/\/[^/\s]+$/.test(key.topLevelSite)) return null;
  if (!c.secure || typeof c.name !== "string" || typeof c.value !== "string" || typeof c.url !== "string") return null;
  /** @type {Record<string, unknown>} */
  const out = {
    name: c.name, value: c.value, url: c.url, path: typeof c.path === "string" ? c.path : "/",
    secure: true, httpOnly: !!c.httpOnly,
    partitionKey: { topLevelSite: key.topLevelSite, hasCrossSiteAncestor: !!key.hasCrossSiteAncestor },
  };
  /* A host-only cookie has no domain; a domain cookie keeps its leading dot. */
  if (typeof c.domain === "string" && c.domain.startsWith(".")) out.domain = c.domain;
  const ss = CDP_SAME_SITE[/** @type {keyof typeof CDP_SAME_SITE} */ (c.sameSite)];
  if (ss) out.sameSite = ss;
  if (typeof c.expirationDate === "number") out.expires = c.expirationDate;
  return out;
}

/**
 * One origin's site storage (plan cause 7), checked: an http(s) origin and
 * string keys and values only. Null when there is nothing to put in.
 * @param {any} s
 * @returns {{ origin: string, local: Record<string, string> } | null}
 */
function toLaneStorage(s) {
  if (!s || typeof s !== "object" || typeof s.origin !== "string") return null;
  let origin;
  try { origin = new URL(s.origin).origin; } catch { return null; }
  if (!/^https?:/.test(origin) || origin !== s.origin) return null;
  /** @type {Record<string, string>} */
  const local = {};
  for (const [k, v] of Object.entries(s.local && typeof s.local === "object" ? s.local : {})) {
    if (typeof v === "string") local[k] = v;
  }
  return Object.keys(local).length ? { origin, local } : null;
}

/**
 * The script that puts one origin's localStorage into the page, run in an
 * isolated world on that origin's document only. A key the page already has
 * is left alone, so a later write by the site is never undone. The values are
 * JSON inside the source: it goes from main to the lane's own page, nowhere
 * else, the same road its cookies took.
 * @param {{ origin: string, local: Record<string, string> }} s
 */
function storageScript(s) {
  return `(() => { if (location.origin !== ${JSON.stringify(s.origin)}) return 0; `
    + `const d = ${JSON.stringify(s.local)}; let n = 0; `
    + `for (const k of Object.keys(d)) { try { if (localStorage.getItem(k) === null) { localStorage.setItem(k, d[k]); n += 1; } } catch { /* full or blocked */ } } `
    + `return n; })()`;
}

/*
 * An agent's own `--as` container (decision B). It is a `persist:` partition on
 * disk, so what the vault puts in is written down by name, domain and path
 * (never a value), and exactly those are removed when the task ends.
 */

/** The partition of a container id the panel minted, or null. Never the
 *  person's Default (`persist:agentglass-browser`, which has no id). */
function containerPartition(id) {
  if (typeof id !== "string" || !/^[a-z0-9]{1,16}$/.test(id)) return null;
  return `persist:agentglass-browser-${id}`;
}

/** What is kept of one cookie set in a container: enough to remove that one
 *  cookie and no other, never its value. */
function cookieKeyOf(c) {
  if (!c || typeof c !== "object" || typeof c.name !== "string") return null;
  let host = "";
  try { host = new URL(String(c.url || "")).hostname; } catch { /* below */ }
  const domain = typeof c.domain === "string" && c.domain ? c.domain : host;
  if (!domain) return null;
  return {
    name: c.name.slice(0, 256),
    domain: domain.slice(0, 253),
    path: typeof c.path === "string" && c.path ? c.path.slice(0, 1024) : "/",
    secure: c.secure === true,
    hostOnly: !(typeof c.domain === "string" && c.domain),
  };
}

/** `cookies.set` arguments that delete exactly that cookie: same name, domain
 *  (or host-only), path and secure flag, already expired. A cookie of the same
 *  name on another domain or path is a different cookie and is not touched. */
function wipeCookieOf(k) {
  if (!k || typeof k.name !== "string" || typeof k.domain !== "string" || !k.domain) return null;
  const host = k.domain.replace(/^\./, "");
  if (!/^[a-z0-9.-]{1,253}$/i.test(host)) return null;
  const p = typeof k.path === "string" && k.path.startsWith("/") ? k.path : "/";
  return {
    url: `${k.secure ? "https" : "http"}://${host}${p}`,
    name: k.name, value: "", path: p, secure: k.secure === true,
    ...(k.hostOnly ? {} : { domain: k.domain }),
    expirationDate: 1,
  };
}

/** Remove those cookies, one by one; the count removed. */
async function wipeContainerCookies(keys, io) {
  let removed = 0;
  for (const k of Array.isArray(keys) ? keys : []) {
    const c = wipeCookieOf(k);
    if (!c) continue;
    try { await io.set(c); removed += 1; } catch { /* the next one still goes */ }
  }
  return removed;
}

/** Task end in an agent's own container: every cookie the site holds there goes,
 *  not only the ones the vault set (the page rotates its login, and a rotated
 *  cookie is no longer the listed one). The count removed. Never called for
 *  the person's Default: the caller holds an agent's container id. */
async function sweepSiteCookies(site, io) {
  if (typeof site !== "string" || !/^[a-z0-9.-]{1,253}$/.test(site)) return 0;
  let removed = 0;
  let all = [];
  try { all = await io.get({ domain: site }); } catch { return 0; }
  for (const c of Array.isArray(all) ? all : []) {
    if (!c || typeof c.name !== "string" || typeof c.domain !== "string") continue;
    const host = c.domain.replace(/^\./, "");
    if (!/^[a-z0-9.-]{1,253}$/i.test(host)) continue;
    const p = typeof c.path === "string" && c.path.startsWith("/") ? c.path : "/";
    try { await io.remove(`${c.secure ? "https" : "http"}://${host}${p}`, c.name); removed += 1; } catch { /* the next one still goes */ }
  }
  return removed;
}

/** A digest of one cookie's name + domain + path + value, for main's memory only:
 *  never logged, never returned. The domain is the cookie's own, or its url's host. */
function cookieHash(c) {
  if (!c || typeof c.name !== "string") return "";
  let host = "";
  try { host = new URL(String(c.url || "")).hostname; } catch { /* below */ }
  /* Chromium canonicalizes on the way back (".acme.test" for a domain cookie, the bare host for a host-only one): both sides hash the same key. */
  const domain = (typeof c.domain === "string" && c.domain ? c.domain : host).toLowerCase().replace(/^\./, "");
  if (!domain) return "";
  const path = typeof c.path === "string" && c.path ? c.path : "/";
  return require("node:crypto").createHash("sha256").update(JSON.stringify([c.name, domain, path, String(c.value ?? "")])).digest("hex");
}

/** After a wipe: how many cookies the site's jar holds that the vault put in
 *  (same name, domain, path AND value), and how many it holds in all. A cookie
 *  the page set itself under the same name has another value and does not
 *  count. No cap: only the vault's own hashes are looked for. */
async function vaultLeftCount(site, hashes, io) {
  if (typeof site !== "string" || !/^[a-z0-9.-]{1,253}$/.test(site)) return { vaultLeft: 0, left: 0 };
  /* No book (evicted, or never made) is UNKNOWN, not zero: the jar may still hold the vault's cookies. */
  if (!hashes) return { vaultLeft: null, left: 0 };
  try {
    const rest = await io.get({ domain: site });
    const list = Array.isArray(rest) ? rest : [];
    let vaultLeft = 0;
    /** @type {Set<string>} */
    const present = new Set();
    for (const c of list) { const h = cookieHash(c); if (hashes.has(h)) { vaultLeft += 1; present.add(h); } }
    /* The book keeps only what is still in the jar: a wipe never leaves dead entries behind. */
    for (const h of hashes) if (!present.has(h)) hashes.delete(h);
    return { vaultLeft, left: list.length };
  } catch { return { vaultLeft: null, left: 0 }; }
}

module.exports = {
  cookieHash, vaultLeftCount,
  sweepSiteCookies,
  vaultDirFor, createVaultLanes, pullRefusal, toLaneCookie, toCdpCookie, toLaneStorage, storageScript, appendPullLog,
  settingsNeedConfirm, settingsConfirmDialogs, sensitiveOffDialog, noCopyOffDialog, noCopyLine, signOutOffDialog, useInBrowserDialog,
  signInOnVisitOnDialog, putLaneCookies, visitIndexFrom, visitSiteCount, onVisitDecision, visitGate, visitDeadline,
  containerPartition, cookieKeyOf, wipeCookieOf, wipeContainerCookies,
};
