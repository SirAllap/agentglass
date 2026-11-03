// The heading over a day's commits, in the words a person would say: "Yesterday", "Two days ago",
// and past a week the date itself. Calendar days in the viewer's zone, not 24-hour blocks: a commit
// from 23:50 last night is "Yesterday" at 00:10, whatever the clock distance.
const WORDS = ["Today", "Yesterday", "Two days ago", "Three days ago", "Four days ago", "Five days ago", "Six days ago"];

export function commitDayLabel(iso: string | null | undefined, now: Date, fallback: string): string {
  if (!iso) return fallback;
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return fallback;
  const day = (d: Date) => Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
  const n = Math.round((day(now) - day(at)) / 86_400_000);
  return n >= 0 && n < WORDS.length ? WORDS[n]! : fallback;
}
