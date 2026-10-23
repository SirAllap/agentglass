/** One run of a sentence: plain words, or the words that were between backticks. */
export interface TickRun { code: boolean; text: string }

/**
 * Splits "not logged in — run `gh auth login`" into plain and code runs. The
 * server writes its hints with backticks (they read fine in a log), and a
 * settings row showed them as literal characters. A backtick with no partner
 * stays as it was typed, so a stray one never swallows the rest of the line.
 */
export function splitTicks(s: string): TickRun[] {
  const out: TickRun[] = [];
  const re = /`([^`\n]+)`/g;
  let at = 0;
  for (let m = re.exec(s); m; m = re.exec(s)) {
    if (m.index > at) out.push({ code: false, text: s.slice(at, m.index) });
    out.push({ code: true, text: m[1]! });
    at = m.index + m[0].length;
  }
  if (at < s.length) out.push({ code: false, text: s.slice(at) });
  return out;
}
