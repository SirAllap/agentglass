/*
 * Where the Tasks tab opens, and the tab it opens on.
 *
 * The source was component state with no memory, so every visit re-ran the
 * ranking in model/taskProviders.ts: a machine with Jira and ClickUp opened on
 * Jira every time, even for somebody who had spent the morning on the ClickUp
 * list. The desk answered this in web/src/lib/taskLanding.ts, and this is that
 * order without the settings the desk has.
 *
 * Keyed by computer and kept in the keystore, the shape
 * src/notifications/watchSince.ts uses for the alert cursor: `tracker` is a
 * DIFFERENT product on the next machine this phone is paired to, so carrying
 * one machine's pick to another would open on a tracker nobody there chose.
 * One keystore value per computer because a key may only hold letters, digits,
 * dots, dashes and underscores — the address is not a key, the computer's id is.
 * A value that cannot be read is "never chosen", which opens on the ranking
 * and is a working board.
 *
 * `openTaskSource` is pure — the remembered id arrives as an argument — so the
 * precedence is asserted without a screen. The small store under it is the
 * pill's half.
 */

interface KeystoreModule {
  getItemAsync(key: string): Promise<string | null>;
  setItemAsync(key: string, value: string): Promise<void>;
}

let injected: KeystoreModule | null = null;
/** For tests: `mock.module` on the keystore is process-wide under `bun test`,
 *  so two files that each fake it overwrite each other. Null puts the real one
 *  back. The same seam as lib/hosts.ts. */
export function __useKeystore(fake: KeystoreModule | null): void {
  injected = fake;
}

/** Required lazily and by a literal name for the reason written in
 *  notifications/talkPref.ts: Metro resolves `require` at build time by reading
 *  the string, and `bun test` has no keystore, where the `null` is what lets
 *  this load. */
function keystore(): KeystoreModule | null {
  try {
    return injected ?? (require("expo-secure-store") as KeystoreModule);
  } catch {
    return null;
  }
}

const key = (computer: string): string => `agentglass.tasks.source.${computer}`;
const remembered = new Map<string, string>();

/** What the pill writes when somebody picks a source. */
export function rememberTaskSource(computer: string | undefined, id: string): void {
  if (!computer) return;
  remembered.set(computer, id);
  void keystore()?.setItemAsync(key(computer), id).catch(() => {
    // Stays live for this run; the next launch opens on the ranking, which is
    // a working board.
  });
}

/** The source this computer was last on, as this run knows it. */
export function lastTaskSource(computer: string | undefined): string | null {
  return (computer && remembered.get(computer)) || null;
}

/** The source this computer was last on, read from the phone's own copy once.
 *  A pick made while the read is in flight is newer than what was stored and
 *  is what comes back. */
export async function readTaskSource(computer: string | undefined): Promise<string | null> {
  if (!computer) return null;
  if (!remembered.has(computer)) {
    try {
      const stored = await keystore()?.getItemAsync(key(computer));
      if (stored && !remembered.has(computer)) remembered.set(computer, stored);
    } catch {
      // Unreadable is "never chosen", which opens on the ranking.
    }
  }
  return remembered.get(computer) ?? null;
}

/** For a test. */
export function __resetTaskSources(): void { remembered.clear(); }

export interface TaskOpen {
  /** The bar as it stands, in the pill's order. */
  available: readonly string[];
  /** What is on screen while the visit lasts — somebody's own pick. */
  current?: string | null;
  /** The source the last visit ended on, per computer. */
  last?: string | null;
  /** A deep link naming a source: an errand, not a change of mind. */
  explicit?: string | null;
}

/**
 * Which source the tab opens on.
 *
 * Precedence, the desk's order:
 *
 *  1. an explicit target — somebody asked for that card, and a link is not a
 *     statement about where they want to live between errands;
 *  2. the tab on screen — so a visit does not jump backwards to what the store
 *     said before this one;
 *  3. the remembered source — the whole point: the tracker last used;
 *  4. the first source the machine offers.
 *
 * Unlike the desk, an explicit target is checked against the bar. The desk's
 * comes from a bar that exists; this one comes from a route the phone may have
 * followed on another machine (`?source=jira` with no Jira connected), and a
 * tab that is not there is a blank screen. `null` is "no bar yet" — the pill
 * has not answered, and nothing is drawn.
 */
export function openTaskSource({ available, current, last, explicit }: TaskOpen): string | null {
  const ok = (v: string | null | undefined): v is string => !!v && available.includes(v);
  if (ok(explicit)) return explicit;
  if (ok(current)) return current;
  if (ok(last)) return last;
  return available[0] ?? null;
}
