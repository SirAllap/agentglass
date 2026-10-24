/*
 * Turning "keep secrets in the system keyring" on and off: every stored secret
 * moves between the files and the keyring, or none does.
 *
 * The order is the whole point, and it is the same both ways: the destination is
 * written and READ BACK first, the file is rewritten (atomic, 0600) only when
 * every secret is verified, and the setting is persisted last. At every step
 * there is a copy of every secret somewhere:
 *
 *   ON   keyring set + readback for each, then credentials.json gets the mark,
 *        then secrets.json, then the setting. A failure puts the files back and
 *        deletes the keyring items this run wrote.
 *   OFF  every marked secret is read from the keyring, the real values go into
 *        both files (read back), the setting is persisted, and only then are the
 *        keyring items deleted. A failure leaves the marks and the keyring.
 *
 * A crash between two steps leaves a duplicate, never a loss. Either direction
 * is idempotent: a secret already carrying the mark is checked against the
 * keyring instead of written again.
 *
 * Nothing prompts: a locked or missing keyring refuses the switch with the
 * reason and touches nothing. A secret's value is never in the answer.
 */
import { writeSecretsKeyring } from "./config.ts";
import { rewriteSecrets, secretSlots } from "./credentials.ts";
import {
  KEYRING_MARK, exclusive, forget, forgetAll, hydrateKeyring, readyBackend, reasonOf, remember, type SecretBackend,
} from "./keyring.ts";
import { pluginSecretSlots, rewritePluginSecrets } from "./plugins.ts";

export type SwitchResult = { ok: true; moved: number } | { ok: false; error: string };

type Slot = { id: string; value: string };
/** Every stored secret as its file holds it; null when a file cannot be read, because what it holds is then unknown. */
function slots(): Slot[] | null {
  const plugins = pluginSecretSlots();
  return plugins && [...secretSlots(), ...plugins];
}
const UNREADABLE = "could not read the stored secrets, so nothing was changed";

/** Both files, each replaced atomically. If the second cannot be, the first goes back. */
function rewriteBoth(by: ReadonlyMap<string, string>, back: ReadonlyMap<string, string>): boolean {
  if (!rewriteSecrets(by)) return false;
  if (rewritePluginSecrets(by)) return true;
  rewriteSecrets(back);
  return false;
}

/** Move every stored secret to (`on`) or from (`!on`) the keyring, and persist the switch.
 *  Alone in the queue: a token stored or a key saved meanwhile would be read
 *  before the move and written back after it. */
export function setKeyringEnabled(on: boolean): Promise<SwitchResult> {
  return exclusive(async () => {
    try { return on ? await turnOn() : await turnOff(); } catch (e) { return { ok: false, error: reasonOf(e) }; }
  });
}

/** Whether a rewrite that reported failure left any of `ids` marked in a file. */
const stillMarked = (ids: ReadonlySet<string>): boolean => !slots() || slots()!.some((s) => ids.has(s.id) && s.value === KEYRING_MARK);

async function turnOn(): Promise<SwitchResult> {
  let b: SecretBackend;
  try { b = await readyBackend(); } catch (e) { return { ok: false, error: reasonOf(e) }; }

  const all = slots();
  if (!all) return { ok: false, error: UNREADABLE };
  const marks = new Map<string, string>();   // id -> mark, for the files
  const original = new Map<string, string>(); // id -> what the file held, to put back
  const written: { id: string; before: string | null }[] = [];
  const undo = async (): Promise<void> => {
    for (const w of written) {
      forget(w.id);
      try { if (w.before === null) await b.del(w.id); else await b.set(w.id, w.before); } catch { /* best effort */ }
    }
  };

  try {
    for (const s of all) {
      if (s.value === "") continue;
      if (s.value === KEYRING_MARK) {
        // Already moved (an earlier run): it must still be there.
        const v = await b.get(s.id);
        if (v === null) throw new Error("a stored secret is marked as kept in the keyring, but the keyring does not have it");
        remember(s.id, v);
        continue;
      }
      const before = await b.get(s.id);
      await b.set(s.id, s.value);
      written.push({ id: s.id, before });
      if ((await b.get(s.id)) !== s.value) throw new Error("the keyring did not return what was stored");
      remember(s.id, s.value);
      marks.set(s.id, KEYRING_MARK);
      original.set(s.id, s.value);
    }
  } catch (e) {
    await undo();
    return { ok: false, error: reasonOf(e) };
  }

  if (marks.size && !rewriteBoth(marks, original)) {
    // The keyring's copies are deleted only once the files are seen without the
    // marks; if that cannot be seen, they stay, because a file may point at them.
    if (stillMarked(new Set(marks.keys()))) return { ok: false, error: "could not rewrite the files; the secrets stay in the keyring too" };
    await undo();
    return { ok: false, error: "could not rewrite the files, so nothing was moved" };
  }
  const saved = writeSecretsKeyring(true);
  if (!saved.ok) {
    // The files carry the mark; put the values back before the keyring forgets them.
    if (marks.size && (!rewriteBoth(original, marks) || stillMarked(new Set(marks.keys())))) return { ok: false, error: `${saved.error ?? "could not save the switch"}; the secrets stay in the keyring` };
    await undo();
    return { ok: false, error: saved.error ?? "could not save the switch" };
  }
  return { ok: true, moved: marks.size };
}

async function turnOff(): Promise<SwitchResult> {
  const all = slots();
  if (!all) return { ok: false, error: UNREADABLE };
  const marked = all.filter((s) => s.value === KEYRING_MARK);
  if (!marked.length) {
    const saved = writeSecretsKeyring(false);
    forgetAll();
    return saved.ok ? { ok: true, moved: 0 } : { ok: false, error: saved.error ?? "could not save the switch" };
  }
  let b: SecretBackend;
  try { b = await readyBackend(); } catch (e) { return { ok: false, error: reasonOf(e) }; }

  const real = new Map<string, string>();
  const marks = new Map<string, string>();
  for (const s of marked) {
    const v = await b.get(s.id);
    if (v === null) return { ok: false, error: "a stored secret is marked as kept in the keyring, but the keyring does not have it" };
    real.set(s.id, v);
    marks.set(s.id, KEYRING_MARK);
  }
  if (!rewriteBoth(real, marks)) return { ok: false, error: "could not rewrite the files, so the secrets stay in the keyring" };
  const saved = writeSecretsKeyring(false);
  if (!saved.ok) {
    const back = rewriteBoth(marks, real);
    return { ok: false, error: `${saved.error ?? "could not save the switch"}${back ? "" : "; the files hold the real values and the keyring too"}` };
  }
  // Both copies exist now; the keyring's goes last. One that cannot be deleted is
  // a duplicate left behind, which turning it on again replaces.
  for (const id of real.keys()) { try { await b.del(id); } catch { /* duplicate, not a loss */ } }
  forgetAll();
  return { ok: true, moved: real.size };
}

/** Read the keyring again for the secrets the files point at: at boot, and by
 *  hand once an unlocked keyring is available. */
export async function rehydrate(): Promise<void> {
  // Whatever the setting says: a file that carries a mark (a move that stopped
  // before the setting was saved) is read through the keyring too.
  await hydrateKeyring((slots() ?? []).filter((s) => s.value === KEYRING_MARK).map((s) => s.id));
}
