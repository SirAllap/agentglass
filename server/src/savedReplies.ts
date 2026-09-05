/*
 * The sentences you write over and over on other people's pull requests.
 *
 * "Thanks — we will take this on from here." "This needs a test that fails without
 * the fix." "Could you split the formatting out of this?" Typing them again every
 * time is how they end up shorter and blunter than intended, and GitHub has had
 * saved replies for years for exactly that reason.
 *
 * Stored beside commands.json and review-prompts.json, and for the same reasons: it
 * is a handful of strings, it is not a secret, and being able to open the file in an
 * editor beats any storage engine.
 *
 * There are no built-ins. A catalogue of canned sentences that ships with the app is
 * the app putting words in somebody's mouth — and these get posted under their name,
 * to other people. The list starts empty and says so.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

export interface SavedReply {
  /** Stable across edits, so a rename is not a delete and an add. */
  id: string;
  /** What the menu shows. */
  title: string;
  /** What goes into the box. Markdown, like everything else in a comment. */
  text: string;
}

const FILE = join(
  process.env.XDG_CONFIG_HOME || join(homedir(), ".config"),
  "agentglass",
  "saved-replies.json",
);

/** Test seam, so a suite never reads or writes somebody's own replies. */
let override: string | null = null;
export function __setSavedRepliesPath(p: string | null): void { override = p; cache = undefined; }
const path = (): string => override ?? FILE;

interface Store { replies: SavedReply[] }
let cache: Store | undefined;

/** How many, and how long. Not a storage limit — a menu of eighty sentences is a
 *  menu nobody reads, and a "reply" the length of a chapter is a document. */
export const MAX_REPLIES = 40;
export const MAX_TEXT = 8000;

function load(): Store {
  if (cache) return cache;
  try {
    const p = path();
    const raw = existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as Store) : { replies: [] };
    cache = { replies: Array.isArray(raw?.replies) ? raw.replies.filter(valid) : [] };
  } catch {
    /* A malformed file is not a reason to lose the composer — it is a reason to show
       no replies. The file is left exactly as it is, so whatever is in it can still be
       rescued by hand. */
    cache = { replies: [] };
  }
  return cache;
}

const valid = (r: unknown): r is SavedReply => {
  const x = r as SavedReply;
  return !!x && typeof x.id === "string" && !!x.id
    && typeof x.title === "string" && typeof x.text === "string";
};

function save(store: Store): void {
  const p = path();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(store, null, 2) + "\n");
  cache = store;
}

export function savedReplies(): SavedReply[] {
  return load().replies;
}

/**
 * Add one, or rewrite one that is already there.
 *
 * Trimmed, capped, and refused when it says nothing: an empty reply in a menu is a
 * row that inserts nothing, which reads as a broken menu rather than as an empty
 * string somebody meant.
 */
export function putSavedReply(input: { id?: unknown; title?: unknown; text?: unknown }): { ok: boolean; error?: string; replies?: SavedReply[] } {
  const title = String(input.title ?? "").trim().slice(0, 120);
  const text = String(input.text ?? "").trim().slice(0, MAX_TEXT);
  if (!text) return { ok: false, error: "a saved reply needs something to say" };
  const store = load();
  const id = String(input.id ?? "").trim();
  const at = id ? store.replies.findIndex((r) => r.id === id) : -1;
  if (at >= 0) {
    const next = [...store.replies];
    next[at] = { id, title: title || next[at]!.title, text };
    save({ replies: next });
    return { ok: true, replies: next };
  }
  if (store.replies.length >= MAX_REPLIES) return { ok: false, error: `that is ${MAX_REPLIES} saved replies — the menu stops being a menu` };
  /* `crypto.randomUUID`, not a counter and not `Math.random`: two windows can add one
     at the same moment, and an id that collides silently rewrites somebody else's. */
  const next = [...store.replies, { id: crypto.randomUUID().slice(0, 8), title: title || text.split("\n")[0]!.slice(0, 60), text }];
  save({ replies: next });
  return { ok: true, replies: next };
}

export function removeSavedReply(idIn: unknown): { ok: boolean; replies: SavedReply[] } {
  const id = String(idIn ?? "");
  const store = load();
  const next = store.replies.filter((r) => r.id !== id);
  if (next.length !== store.replies.length) save({ replies: next });
  return { ok: true, replies: next };
}
