/*
 * When each thing in the Inbox was last looked at.
 *
 * The only state this app keeps about YOUR reading rather than the machine's,
 * and the thing that makes "moved since you looked" a claim instead of a
 * guess. Without it every row is new on every cold start, which is the same
 * failure as a badge nobody believes.
 *
 * ── the keystore, for something that is not a secret ──────────────────────
 * `expo-secure-store` is what this app has. It is where the paired credential
 * and the chosen theme already live, and adding a second storage library for
 * one map would be a dependency, a build-time question on three platforms, and
 * a second thing that can fail on a cold start.
 *
 * What it costs is a size limit — the keystore is not a database — which is
 * why `remember` in model/inbox.ts caps the map rather than letting it grow
 * once per pull request you ever open.
 *
 * ── every failure is silence ──────────────────────────────────────────────
 * A keystore read can fail on a device whose keys were invalidated by a
 * biometric change, and a write can fail because the value got too big. Both
 * answer "you have looked at nothing", which shows as rows appearing in
 * `moved` that you had already read. That is the right way round: the opposite
 * failure hides something.
 */

/** The one module read here, required lazily.
 *
 *  `require` with the name written out as a literal, and one function for it,
 *  for the reason theme.ts sets out at length: Metro resolves `require` at
 *  BUILD time by reading the string, so a shared helper taking a name compiles
 *  to a require of a module the bundle does not contain. This file is also
 *  imported by `bun test`, where there is no phone and no keystore, and the
 *  `null` is what makes that work rather than throw. */
interface KeystoreModule {
  getItemAsync(key: string): Promise<string | null>;
  setItemAsync(key: string, value: string): Promise<void>;
}

function keystore(): KeystoreModule | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require("expo-secure-store") as KeystoreModule;
  } catch {
    return null; // not a phone: see the header
  }
}

const KEY = "agentglass.inbox.seen";

/**
 * Read the map back, trusting nothing in it.
 *
 * It is JSON on a device that survives app upgrades, so every value is checked
 * rather than cast. A single bad entry would otherwise reach `buildInbox`,
 * where a NaN compares false against everything and quietly stops one row from
 * ever counting as seen again.
 */
export async function readSeen(): Promise<Record<string, number>> {
  try {
    const raw = await keystore()?.getItemAsync(KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, number> = {};
    for (const [id, at] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof at === "number" && Number.isFinite(at) && at > 0) out[id] = at;
    }
    return out;
  } catch {
    return {};
  }
}

/** Write it back. Answers whether it landed, for a caller that wants to know;
 *  the Inbox does not, because a lost write costs one row reappearing. */
export async function writeSeen(seen: Record<string, number>): Promise<boolean> {
  try {
    const store = keystore();
    if (!store) return false;
    await store.setItemAsync(KEY, JSON.stringify(seen));
    return true;
  } catch {
    return false;
  }
}
