const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad = (n: number) => String(n).padStart(2, "0");

/**
 * The actual moment, next to the "3d" that says how long ago it was.
 *
 * A board card already carries `ago()`, and relative time is the right thing
 * for scanning: "3d" tells you at a glance which lane has gone stale. It is the
 * wrong thing for everything else. "3d" cannot be compared against a message in
 * Slack, quoted in a standup, or checked against a deploy — all of which need
 * to know it was Tuesday afternoon and not Tuesday morning. The two answer
 * different questions and the card can afford both.
 *
 * Built by hand rather than through `Intl`, because a card sits in a column of
 * other cards and the stamps have to line up: a formatter that switches between
 * "12 Aug" and "August 12" depending on the machine's locale would break the
 * column on somebody else's laptop, and it would do it silently.
 *
 * Local time, deliberately — the question is what YOUR clock said.
 */
export function stamp(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  const t = d.getTime();
  if (!iso || !Number.isFinite(t)) return "";
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const day = `${d.getDate()} ${MONTHS[d.getMonth()]}`;
  /* The year only when it is not this one. On a board where everything is from
     this quarter it would be four characters of noise on every card, and the
     one card from last December is exactly the one you want it on. */
  return d.getFullYear() === now.getFullYear() ? `${day} ${hm}` : `${day} ${d.getFullYear()} ${hm}`;
}
