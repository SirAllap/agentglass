/*
 * What comes back from the microphone, and what to do with it.
 *
 * ── the shape of the feature ─────────────────────────────────────────────
 * The phone records; the computer transcribes. Expo Go carries no speech
 * recogniser and cannot be given one — a native module that is not in the
 * client simply is not there — so the recogniser lives where every other heavy
 * thing in this app lives, which is the machine on the other end of the socket.
 * See server/src/dictate.ts.
 *
 * ── and why the text is INSERTED rather than sent ────────────────────────
 * Dictation is wrong often enough that a transcript which submitted itself
 * would be a question nobody read arriving at an agent. So what comes back
 * lands in the compose field, where it can be corrected, and the person presses
 * send. That also makes it composable: dictate a sentence, type a path after
 * it, send once.
 *
 * ── pure ─────────────────────────────────────────────────────────────────
 * The recorder is required lazily by the screen. Everything here is a rule
 * about the answer, so the rules are testable — and they are the part that
 * fails quietly: a transcript joined without a space runs two words together
 * in the middle of somebody's command.
 */

/** What `/terminal/dictate` answers with. */
export interface Said {
  ok: boolean;
  text?: string;
  error?: string;
}

/**
 * The words, or the reason there are none.
 *
 * `ok` alone is not enough for the same reason it is not enough for an image
 * upload: a route can succeed and still have nothing to say, and a screen that
 * trusted the flag would put "undefined" in somebody's field.
 */
export function wordsFrom(said: Said | null | undefined): { text: string } | { error: string } {
  if (!said) return { error: "The computer did not answer." };
  if (!said.ok) return { error: said.error || "That could not be transcribed." };
  const text = typeof said.text === "string" ? said.text.trim() : "";
  if (!text) return { error: "Nothing was heard." };
  return { text };
}

/**
 * The transcript, put into what is already in the field.
 *
 * A space between them unless there is one already, and never a leading one on
 * an empty field. This is the rule that fails quietly: `git commit -m` followed
 * by a dictated sentence with no gap is `git commit -mfix the thing`, which is
 * a flag nobody typed.
 *
 * It appends rather than replaces because the field is a composition — the
 * whole point of not sending automatically is that dictating is one part of
 * writing a line, not the whole of it.
 */
export function joinDictated(existing: string, dictated: string): string {
  const said = dictated.trim();
  if (!said) return existing;
  if (!existing) return said;
  return /\s$/.test(existing) ? `${existing}${said}` : `${existing} ${said}`;
}

/** The name sent up with the bytes. Only the extension is read on the other
 *  side, and it decides how the file is written — a recording called `.m4a`
 *  that is really webm is one whisper opens and rejects. */
export function nameFor(uri: string): string {
  const ext = /\.(m4a|mp3|wav|ogg|webm|aac)(\?|$)/i.exec(uri)?.[1];
  return ext ? `speech.${ext.toLowerCase()}` : "speech.m4a";
}
