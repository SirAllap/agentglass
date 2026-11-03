/** A commit author's chip: initials and a colour that is the same every time.
 *  Keyed on the author NAME: the log lines carry no email. The same person under two
 *  spellings gets two colours; keying on email waits for the log to return one. */

/** First letters of the first two words, uppercase; one letter for one word. */
export function initialsOf(name: string | undefined | null): string {
  const words = (name ?? "").replace(/<[^>]*>/g, " ").split(/\s+/).filter(Boolean);
  return words.slice(0, 2).map((w) => [...w][0]!.toUpperCase()).join("") || "?";
}

/** 1..8, the `--graph-N` tokens. FNV-1a over the lowercased text: stable, no table. */
export function avatarSlot(key: string | undefined | null): number {
  let h = 0x811c9dc5;
  for (const ch of (key ?? "").trim().toLowerCase()) h = Math.imul(h ^ ch.codePointAt(0)!, 0x01000193) >>> 0;
  return (h % 8) + 1;
}
