/*
 * Keys somebody added themselves.
 *
 * ── what this is for ─────────────────────────────────────────────────────
 * The twenty-four built-in keys are the ones every terminal needs. What people
 * actually reach for on a phone is narrower and personal, and a lot of it is
 * not a control code at all: `git status`, `/clear`, `npm test`, a project's
 * one long command nobody wants to type with a thumb. A macro key is worth
 * more per press than any control code left on the bar.
 *
 * ── text, and the one control code that is not text ──────────────────────
 * A custom key sends its text and, if asked, a Return after it. That second
 * half is the whole difference between putting a command on the line and
 * RUNNING it, which is a decision worth making per key rather than assuming:
 * `git status` wants to run, a long flag string wants to be edited first.
 *
 * ── why the text is not escaped or interpreted ───────────────────────────
 * What is typed is what is sent. There is no `\n` or `\t` decoding, and that
 * is deliberate — a phone keyboard cannot type a backslash-n by accident but
 * it can type it on purpose, and a person writing a path with a backslash in
 * it would otherwise find it eaten. The built-in keys are where control codes
 * live, and they are written in TypeScript by somebody who can test them.
 *
 * ── pure ─────────────────────────────────────────────────────────────────
 * Storage is termPrefs.ts. Everything here is a rule about the shape, so every
 * rule is testable — and the rules matter, because a malformed one reaches a
 * key bar rather than an error.
 */

/** The most that can be added. Not a storage limit — the keystore would hold
 *  hundreds — but a bar limit: past a dozen, the thing being scrolled is the
 *  problem the settings screen exists to solve. */
export const MAX_CUSTOM = 12;

/** How long a label may be. Two or three characters is a key; more is a word
 *  wearing a key's clothes, and it pushes everything after it off the fold. */
export const MAX_LABEL = 10;

export interface CustomKey {
  /** Stable across edits, so a reorder in the layout survives a rename. */
  id: string;
  /** What the bar draws. */
  label: string;
  /** What goes down the socket, exactly as typed. */
  text: string;
  /** Send a Return after it — the difference between writing a command and
   *  running one. */
  enter: boolean;
}

/** An id nothing else will take. `custom:` is a namespace so a custom key can
 *  never collide with a built-in one in the layout's order or hidden set. */
export const mintId = (now: number, salt: number): string =>
  `custom:${now.toString(36)}${Math.floor(salt * 1e6).toString(36)}`;

/**
 * Whether this is a key worth keeping, and why not when it is not.
 *
 * Returns the reason rather than a boolean so the screen can say it. An empty
 * label draws a key nobody can hit on purpose; empty text draws one that does
 * nothing when they do.
 */
export function problemWith(key: { label: string; text: string }): string | null {
  if (!key.label.trim()) return "It needs something to show on the bar.";
  if (key.label.trim().length > MAX_LABEL) return `The label is at most ${MAX_LABEL} characters.`;
  if (!key.text) return "It needs something to send.";
  return null;
}

/** Trimmed where trimming is right and not where it is not.
 *
 *  The LABEL is trimmed: leading space in a thing drawn on a key is a mistake
 *  every time. The TEXT is not: a trailing space is how somebody writes a
 *  prefix they mean to finish typing — `git checkout ` — and eating it makes
 *  the key worse in a way that is hard to see. */
export function tidy(key: CustomKey): CustomKey {
  return { ...key, label: key.label.trim() };
}

/** Add one, refusing past the cap and refusing a bad one. Returns the list
 *  unchanged rather than throwing: the caller has already asked `problemWith`
 *  and this is the second line of that defence. */
export function add(list: readonly CustomKey[], key: CustomKey): CustomKey[] {
  if (list.length >= MAX_CUSTOM) return [...list];
  if (problemWith(key)) return [...list];
  return [...list, tidy(key)];
}

export function remove(list: readonly CustomKey[], id: string): CustomKey[] {
  return list.filter((k) => k.id !== id);
}

/**
 * A stored value, read defensively.
 *
 * Anything that is not the shape this file writes is dropped, per entry rather
 * than wholesale: one bad row in a list of eight should cost that row, not the
 * seven around it. A keystore value is the one input here that can come from a
 * different version of the app.
 */
export function parseCustom(value: unknown): CustomKey[] {
  if (!Array.isArray(value)) return [];
  const out: CustomKey[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Partial<CustomKey>;
    if (typeof r.id !== "string" || !r.id) continue;
    if (typeof r.label !== "string" || typeof r.text !== "string") continue;
    if (seen.has(r.id)) continue;
    const key: CustomKey = { id: r.id, label: r.label, text: r.text, enter: r.enter === true };
    if (problemWith(key)) continue;
    seen.add(r.id);
    out.push(tidy(key));
    if (out.length >= MAX_CUSTOM) break;
  }
  return out;
}

/** What actually goes down the socket. `\r`, not `\n`: a terminal's Return is
 *  a carriage return, and a line feed at a shell prompt is not the same key. */
export const bytesFor = (key: CustomKey): string => (key.enter ? `${key.text}\r` : key.text);
