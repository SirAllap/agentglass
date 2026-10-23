/*
 * Every computer this phone is paired to, and which one is in front.
 *
 * One keystore value, `agentglass.hosts`, holding the whole list. Each entry
 * keeps its token and its address together for the reason host.ts gives for
 * the single record: a credential and the machine it opens are both present or
 * both gone. Five entries are about a kilobyte, well inside what the keystore
 * takes in one value.
 *
 * ── what the list does not do ─────────────────────────────────────────────
 * There is no manual order. The list is most recently used first, which is the
 * order the switcher shows, and `lastUsed` is the only thing that sorts it.
 *
 * ── the cap ───────────────────────────────────────────────────────────────
 * Five. The app keeps one socket per computer while the foreground service
 * runs, so the cap is what bounds idle sockets and battery, not a taste.
 *
 * ── migration ─────────────────────────────────────────────────────────────
 * Before this file the phone kept one record under `agentglass.host`. The
 * first load that finds no list wraps that record as the only entry, writes
 * the list, and deletes the old key only after the list reads back. A write
 * that fails leaves the old key where it was and the app still opens on the
 * computer it knew, so the worst a full keystore can do is try again on the
 * next launch. A crash between the write and the delete leaves both keys, and
 * the list wins on the next load, which finishes the delete.
 *
 * ── order of changes ──────────────────────────────────────────────────────
 * Every change reads the list, edits it and writes it back, so two started
 * together would each start from the same list and the later write would drop
 * the earlier one — and what gets dropped can be a token. They run one at a
 * time instead.
 */
import type { Host } from "./host.ts";
import { normalizeOrigin } from "./pairing.ts";

interface Keystore {
  WHEN_UNLOCKED?: number;
  getItemAsync(key: string): Promise<string | null>;
  setItemAsync(key: string, value: string, options?: { keychainAccessible?: number }): Promise<void>;
  deleteItemAsync(key: string): Promise<void>;
}

let injected: Keystore | null = null;
/** For tests: `mock.module` on the keystore is process-wide under `bun test`,
 *  so two files that each fake it overwrite each other. Null puts the real
 *  one back. */
export function __useKeystore(fake: Keystore | null): void {
  injected = fake;
}

/** Required lazily and by a literal name, as talkPref.ts does: Metro still
 *  resolves it at build time, and `bun test` never loads the native module
 *  unless a test asks for it. */
function keystore(): Keystore {
  return injected ?? (require("expo-secure-store") as Keystore);
}

const KEY = "agentglass.hosts";
/** The single record this list replaced. Read for migration, then deleted. */
const LEGACY_KEY = "agentglass.host";

export const MAX_HOSTS = 5;

export interface HostEntry extends Host {
  /** Made at pairing and kept when the same address is paired again, so what
   *  hangs off a computer (notifications, marks) survives a re-pair. */
  id: string;
  /** The owner's own alias. The computer's own name stays the fallback. */
  name?: string;
  lastUsed: number;
  /** When the computer answered 401: it took this phone off its list. The
   *  entry stays, so the list can say so and offer to forget it, instead of
   *  the computer vanishing from the phone without a word. Pairing it again
   *  replaces the entry and so clears this. */
  revoked?: number;
}

export interface HostList {
  /** Null only when `hosts` is empty. */
  active: string | null;
  /** Most recently used first. */
  hosts: HostEntry[];
}

const TOO_MANY = `This phone can watch at most ${MAX_HOSTS} computers. Forget one to add another.`;

const EMPTY: HostList = { active: null, hosts: [] };

/** The same computer under two spellings must not become two entries. */
const sameOrigin = (origin: string): string => normalizeOrigin(origin) ?? origin.trim();

function safeParse(raw: string): unknown {
  try { return JSON.parse(raw); } catch { return null; }
}

function hashOf(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h * 33) ^ text.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

function newId(): string {
  // crypto, not Math.random: the id is no secret, but a scanner rightly calls a
  // PRNG the wrong tool for an identifier. rng.ts (loaded by the root layout)
  // gives Hermes the same getRandomValues the server has.
  const r = crypto.getRandomValues(new Uint8Array(5));
  return Date.now().toString(36) + Array.from(r, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** A parsed record, or null when it lacks the two things nothing works without. */
function entryFrom(raw: unknown, fallbackId: string): HostEntry | null {
  const h = raw as Partial<HostEntry> | null;
  if (!h || typeof h !== "object" || !h.origin || !h.token) return null;
  return {
    id: typeof h.id === "string" && h.id ? h.id : fallbackId,
    origin: h.origin,
    token: h.token,
    label: h.label || "This computer",
    scope: h.scope ?? "answer",
    pairedAt: h.pairedAt ?? 0,
    ...(typeof h.name === "string" && h.name ? { name: h.name } : {}),
    lastUsed: typeof h.lastUsed === "number" ? h.lastUsed : (h.pairedAt ?? 0),
    ...(typeof h.revoked === "number" && h.revoked > 0 ? { revoked: h.revoked } : {}),
  };
}

function tidy(hosts: HostEntry[], active: string | null | undefined): HostList {
  const sorted = [...hosts].sort((a, b) => b.lastUsed - a.lastUsed);
  const chosen = sorted.find((h) => h.id === active) ?? sorted[0];
  return { active: chosen?.id ?? null, hosts: sorted };
}

function parseList(raw: string): HostList | null {
  try {
    const data = JSON.parse(raw) as { hosts?: unknown[]; active?: string };
    if (!Array.isArray(data.hosts)) return null;
    const hosts = data.hosts
      .map((h, i) => entryFrom(h, `host-${i}`))
      .filter((h): h is HostEntry => h !== null);
    return tidy(hosts, data.active);
  } catch {
    return null;
  }
}

/** Throws when the keystore will not open. That is NOT an empty keystore: a
 *  change made from "empty" would write a one-entry list over the tokens of the
 *  other four, so only `loadHosts` (display) turns it into an empty list. */
const get = (key: string): Promise<string | null> => keystore().getItemAsync(key);

async function write(list: HostList): Promise<void> {
  const body = JSON.stringify({ v: 1, active: list.active, hosts: list.hosts });
  await keystore().setItemAsync(KEY, body, { keychainAccessible: keystore().WHEN_UNLOCKED });
}

async function read(): Promise<HostList> {
  const raw = await get(KEY);
  const stored = raw ? parseList(raw) : null;
  const legacyRaw = await get(LEGACY_KEY);
  if (stored) {
    // The crash between the write and the delete: finish the delete.
    if (legacyRaw) await keystore().deleteItemAsync(LEGACY_KEY).catch(() => {});
    return stored;
  }
  // `pairedAt` doubles as the first lastUsed, so the order after a migration
  // is deterministic.
  const parsed = legacyRaw ? safeParse(legacyRaw) as { origin?: string } | null : null;
  // The id comes from the address while the old key is still the only copy, so
  // it is the same on every load until the write lands, and Forget can find it.
  const legacy = parsed ? entryFrom(parsed, `legacy-${hashOf(parsed.origin ?? "")}`) : null;
  if (!legacy) return EMPTY;
  const list = tidy([legacy], legacy.id);
  try {
    await write(list);
    // Deleted only once the list reads back with the token in it.
    const back = parseList((await get(KEY)) ?? "");
    if (back?.hosts[0]?.token === legacy.token) {
      await keystore().deleteItemAsync(LEGACY_KEY).catch(() => {});
    }
  } catch {
    // The old key stays. This load answers from memory, with an id that will
    // be made again next time; nothing is keyed by it until the write lands.
  }
  return list;
}

let queue: Promise<unknown> = Promise.resolve();
function serial<T>(job: () => Promise<T>): Promise<T> {
  const run = queue.then(job, job);
  queue = run.catch(() => {});
  return run;
}

/** The list as stored, migrating an old install on the way. */
export function loadHosts(): Promise<HostList> {
  // For display: a keystore that will not open shows as nothing paired.
  return serial(read).catch(() => EMPTY);
}

/** Edit the list under the queue. `edit` returns null for "nothing to change",
 *  which writes nothing. */
function change(edit: (list: HostList) => HostList | null): Promise<HostList> {
  return serial(async () => {
    const list = await read();
    const next = edit(list);
    if (!next) return list;
    await write(next);
    return next;
  });
}

/** Strictly after everything already stored, so two switches in one
 *  millisecond still have an order. */
const stamp = (list: HostList): number =>
  Math.max(Date.now(), ...list.hosts.map((h) => h.lastUsed + 1));

/**
 * Pair a computer and make it the active one. The same address paired again
 * replaces its key and keeps its entry (id, name); a new address is added, up
 * to MAX_HOSTS, and past that nothing is written.
 */
export function addHost(host: Host): Promise<HostList> {
  return change((list) => {
    const origin = sameOrigin(host.origin);
    const old = list.hosts.find((h) => sameOrigin(h.origin) === origin);
    if (!old && list.hosts.length >= MAX_HOSTS) throw new Error(TOO_MANY);
    const entry: HostEntry = {
      origin,
      token: host.token,
      label: host.label,
      scope: host.scope,
      pairedAt: host.pairedAt,
      id: old?.id ?? newId(),
      ...(old?.name ? { name: old.name } : {}),
      lastUsed: stamp(list),
    };
    const rest = list.hosts.filter((h) => h !== old);
    return tidy([entry, ...rest], entry.id);
  });
}

/** Change one entry in place. `edit` returning null means "nothing to
 *  change", which writes nothing; an id that is not there changes nothing. */
function editOne(id: string, edit: (target: HostEntry, list: HostList) => HostEntry | null, active?: string): Promise<HostList> {
  return change((list) => {
    const target = list.hosts.find((h) => h.id === id);
    const next = target ? edit(target, list) : null;
    return next ? tidy(list.hosts.map((h) => (h === target ? next : h)), active ?? list.active) : null;
  });
}

/** Switch to a computer. An id that is not in the list changes nothing. */
export const setActive = (id: string): Promise<HostList> =>
  editOne(id, (t, list) => ({ ...t, lastUsed: stamp(list) }), id);

/** An empty name clears the alias. */
export function renameHost(id: string, name: string): Promise<HostList> {
  const alias = name.trim();
  return editOne(id, ({ name: _old, ...bare }) => (alias ? { ...bare, name: alias } : bare));
}

/**
 * Forget a computer.
 *
 * The phone's half only, as host.ts has always said: the token stays valid at
 * the computer until somebody revokes the device there. When the active one
 * goes, the next most recently used takes its place.
 */
export function removeHost(id: string): Promise<HostList> {
  return change((list) => {
    if (!list.hosts.some((h) => h.id === id)) return null;
    return tidy(list.hosts.filter((h) => h.id !== id), list.active === id ? null : list.active);
  });
}

/** The computer answered 401 to `token`. Marks the entry; the other computers
 *  are not touched, which is why this is not a forget. Marking twice keeps the
 *  first time and writes nothing. */
export const markRevoked = (id: string, token: string): Promise<HostList> =>
  // Only for the key that got the 401: a re-pair keeps the id, and a late 401
  // for the old key must not mark the new one removed.
  editOne(id, (t) => (t.revoked || t.token !== token ? null : { ...t, revoked: Date.now() }));

/** A key for state that belongs to one computer: two of them can both have a
 *  checkout at /home/x/orbit, and a tick made on one must not show on the other. */
export function computerKey(host: { id?: string } | null | undefined, key: string): string {
  return `${host?.id ?? ""}\0${key}`;
}
