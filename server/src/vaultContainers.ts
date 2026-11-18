/*
 * DECISION B: AN AGENT'S OWN `--as` CONTAINER IS SIGNED IN ON ITS FIRST VISIT.
 *
 * That container is a `persist:` partition on disk, so a vault login there
 * would outlive the task. This file is the relay's book that makes it safe:
 *
 * - WHO MADE IT. A container counts as an agent's only when the panel said the
 *   agent's own `open`/`newtab` minted it (`minted: true`, by container id), or
 *   it is a worker's reserved `agent:` container. A name is never enough: an
 *   agent's `--as foo` lands in the person's own `foo` when one exists.
 * - WHAT WENT IN. Each sign-in is written down by cookie name, domain and path
 *   (never a value), on disk, so exactly those are removed when the task ends,
 *   and a crash leaves a list the next start removes.
 * - ONCE. A container + site is tried once, whatever the outcome.
 */
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface CookieKey { name: string; domain: string; path: string; secure: boolean; hostOnly: boolean }
export interface ContainerSignIn {
  /** The panel's container id (the partition is `persist:agentglass-browser-<id>`). */
  container: string;
  /** Its display name when it was signed in, for "its last tab closed" and drops. */
  name: string;
  /** The folded identity of the agent that made it. */
  owner: string;
  site: string;
  cookies: CookieKey[];
}
interface Book { made: Record<string, { owner: string; name: string }>; signIns: ContainerSignIn[] }

const ID_RE = /^[a-z0-9]{1,16}$/;
let book: Book | null = null;
let fileOverride: string | null = null;
/* Container id + "\n" + site already tried. In memory: a restart may try again. */
const tried = new Set<string>();
/* Tab id -> container id, from the replies that named both. */
const tabs = new Map<string, string>();
/* Tabs whose open the panel answered with `agentMade` (the flag on the profile). */
const agentTabs = new Set<string>();

function bookFile(): string {
  if (fileOverride) return fileOverride;
  const dir = process.env.AGENTGLASS_STATE_DIR
    || join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "agentglass");
  return join(dir, "vault-container-signins.json");
}

function cleanKey(k: unknown): CookieKey | null {
  const o = k && typeof k === "object" ? k as Record<string, unknown> : null;
  if (!o || typeof o.name !== "string" || typeof o.domain !== "string" || !o.domain) return null;
  return {
    name: o.name.slice(0, 256), domain: o.domain.slice(0, 253),
    path: typeof o.path === "string" && o.path.startsWith("/") ? o.path.slice(0, 1024) : "/",
    secure: o.secure === true, hostOnly: o.hostOnly === true,
  };
}

function load(): Book {
  if (book) return book;
  book = { made: {}, signIns: [] };
  try {
    const raw = JSON.parse(readFileSync(bookFile(), "utf8")) as Partial<Book>;
    for (const [id, m] of Object.entries(raw.made ?? {})) {
      if (ID_RE.test(id) && m && typeof m.owner === "string" && m.owner) book.made[id] = { owner: m.owner, name: String(m.name ?? "") };
    }
    for (const s of Array.isArray(raw.signIns) ? raw.signIns : []) {
      if (!s || !ID_RE.test(String(s.container)) || typeof s.owner !== "string") continue;
      const cookies = (Array.isArray(s.cookies) ? s.cookies : []).map(cleanKey).filter((k): k is CookieKey => !!k);
      if (cookies.length) book.signIns.push({ container: s.container, name: String(s.name ?? ""), owner: s.owner, site: String(s.site ?? ""), cookies });
    }
  } catch { /* none yet, or unreadable: start empty */ }
  return book;
}

function save(): void {
  const f = bookFile();
  try {
    mkdirSync(dirname(f), { recursive: true, mode: 0o700 });
    const tmp = `${f}.tmp`;
    writeFileSync(tmp, JSON.stringify(load()), { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, f);
  } catch { /* best effort: the in-memory book still drives this run */ }
}

const fold = (s: string) => s.trim().toLowerCase();

/**
 * Record that `owner`'s own ask made this container (panel: `minted`), or a worker's reserved one.
 * `fresh` is a mint the panel just did: the id is new to the list, so any older
 * record under it is a removed container's, and it goes (its sign-ins leave the
 * book without a wipe: the jar under that id is not the one they went into).
 */
export function noteMadeContainer(id: string, name: string, owner: string, fresh = false): void {
  if (!ID_RE.test(id) || !owner.trim()) return;
  const b = load();
  if (b.made[id]?.owner === fold(owner) && !fresh) return;
  /* Not fresh: a later agent naming it does not take it over. */
  if (b.made[id] && !fresh) return;
  if (b.made[id] || b.signIns.some((s) => s.container === id)) disown(b, id);
  b.made[id] = { owner: fold(owner), name };
  save();
}

function disown(b: Book, id: string): void {
  delete b.made[id];
  b.signIns = b.signIns.filter((s) => s.container !== id);
  for (const k of [...tried]) if (k.startsWith(`${id}\n`)) tried.delete(k);
}

/**
 * The panel says this id is not an agent's container (no `agentMade` on it):
 * it was removed and the person made one that got the same id. Nothing here
 * may sign it in or wipe it, so its record and sign-ins leave the book with no
 * wipe — the person's cookies are theirs.
 */
export function disownContainer(id: string): void {
  if (!ID_RE.test(id)) return;
  const b = load();
  if (!b.made[id] && !b.signIns.some((s) => s.container === id)) return;
  disown(b, id);
  save();
}

/** Whether `as` made this container. Never true for the person's Default (no id). */
export function madeByAgent(id: string | undefined, as: string | undefined): boolean {
  if (!id || !as || !ID_RE.test(id)) return false;
  return load().made[id]?.owner === fold(as);
}

/** The made containers with this display name (a drop names one). */
export function madeNamed(name: string): string[] {
  const n = fold(name);
  return Object.entries(load().made).filter(([id, m]) => fold(m.name) === n || id === n).map(([id]) => id);
}

export function forgetMadeContainer(id: string): void {
  const b = load();
  if (!b.made[id]) return;
  delete b.made[id];
  save();
}

export function noteTabContainer(tab: string, id: string, agentMade = false): void {
  if (!tab || !ID_RE.test(id)) return;
  if (tabs.size >= 5000) { tabs.clear(); agentTabs.clear(); }
  tabs.set(tab, id);
  if (agentMade) agentTabs.add(tab); else agentTabs.delete(tab);
}
export function tabContainer(tab: string | undefined): string | undefined { return tab ? tabs.get(tab) : undefined; }
/** Whether the panel said this tab's container carries `agentMade`. */
export function tabAgentMade(tab: string | undefined): boolean { return !!tab && agentTabs.has(tab); }
export function forgetTab(tab: string): void { tabs.delete(tab); agentTabs.delete(tab); }

/** True the first time a container + site is tried. */
export function tryContainerSite(id: string, site: string): boolean {
  const k = `${id}\n${site}`;
  if (tried.has(k)) return false;
  if (tried.size >= 5000) tried.clear();
  tried.add(k);
  return true;
}

export function recordSignIn(s: ContainerSignIn): void {
  const cookies = s.cookies.map(cleanKey).filter((k): k is CookieKey => !!k);
  if (!ID_RE.test(s.container) || !cookies.length) return;
  load().signIns.push({ ...s, owner: fold(s.owner), cookies });
  save();
}

export function signInsWhere(pred: (s: ContainerSignIn) => boolean): ContainerSignIn[] {
  return load().signIns.filter(pred);
}
export function signInsOf(as: string): ContainerSignIn[] { const o = fold(as); return signInsWhere((s) => s.owner === o); }

/** The task is over: every container this agent made may be signed in again on its next first visit. */
export function forgetVisitsOf(as: string): void {
  const o = fold(as);
  for (const [id, m] of Object.entries(load().made)) {
    if (m.owner !== o) continue;
    for (const k of [...tried]) if (k.startsWith(`${id}\n`)) tried.delete(k);
  }
}

/** Removed from the book after the window said they are gone; their sites may be tried again. */
export function dropSignIns(done: readonly ContainerSignIn[]): void {
  const b = load();
  const set = new Set(done);
  b.signIns = b.signIns.filter((s) => !set.has(s));
  for (const s of done) tried.delete(`${s.container}\n${s.site}`);
  save();
}

/** Tests only: a book file of their own, and nothing in memory. */
export function resetVaultContainers(file?: string | null): void {
  if (file !== undefined) fileOverride = file;
  book = null;
  tried.clear();
  tabs.clear();
  agentTabs.clear();
}
