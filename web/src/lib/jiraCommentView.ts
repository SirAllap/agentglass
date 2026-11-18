/*
 * What a Jira comment shows beyond its words, as pure functions the card
 * draws from: the people it mentions as chips, its exact date and "(edited)"
 * line, and the address that opens Jira on that one comment.
 *
 * A mention reaches the pane as `@Name` in the Markdown with `{id, name}`
 * beside it (server/src/jiraAdf.ts reads the ADF `mention` node that way, and
 * writes it back from the same pair). Only a name in that list becomes a chip,
 * so an email address or a typed `@` with nobody behind it stays text.
 *
 * Reactions are not here on purpose: Jira's public REST has no endpoint for
 * them, only the private one its own web app uses.
 */

export type MentionPart = string | { mention: string };

const WORD = /[\p{L}\p{N}_]/u;

/**
 * Split text into plain runs and the `@Name` mentions in it, for the names
 * given. The longest name wins where one starts another ("@Ada" and "@Ada
 * Orbit"), and a mention must stand on its own: not after a letter (so
 * `ada@orbit.dev` stays an address) and not run into the next word.
 */
export function mentionParts(text: string, names: readonly string[]): MentionPart[] {
  const want = [...new Set(names.filter((n) => n.trim()))].sort((a, b) => b.length - a.length);
  if (!want.length || !text.includes("@")) return [text];
  const out: MentionPart[] = [];
  let run = "";
  let i = 0;
  while (i < text.length) {
    const at = text.indexOf("@", i);
    if (at < 0) break;
    run += text.slice(i, at);
    const before = at > 0 ? text[at - 1]! : "";
    const name = before && WORD.test(before) ? undefined : want.find((n) => {
      if (!text.startsWith(n, at + 1)) return false;
      const after = text[at + 1 + n.length];
      return after === undefined || !WORD.test(after);
    });
    if (name) {
      if (run) out.push(run);
      run = "";
      out.push({ mention: name });
      i = at + 1 + name.length;
    } else {
      run += "@";
      i = at + 1;
    }
  }
  run += text.slice(i);
  if (run) out.push(run);
  return out;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const two = (n: number) => String(n).padStart(2, "0");
const clock = (d: Date) => `${two(d.getHours())}:${two(d.getMinutes())}`;

/** "12 Nov 2026, 16:42", in the viewer's own time zone. Empty for no date. */
export function exactDate(at: number): string {
  if (!(at > 0)) return "";
  const d = new Date(at);
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}, ${clock(d)}`;
}

/**
 * "(edited 12 Nov, 17:05)": the year only when it is not the year the comment
 * was written, since the line sits right after that date. "(edited)" when Jira
 * said it changed but not when.
 */
export function editedLabel(created: number, editedAt?: number): string {
  if (!editedAt || !(editedAt > 0)) return "(edited)";
  const d = new Date(editedAt);
  const year = created > 0 && new Date(created).getFullYear() === d.getFullYear() ? "" : ` ${d.getFullYear()}`;
  return `(edited ${d.getDate()} ${MONTHS[d.getMonth()]}${year}, ${clock(d)})`;
}

/** The hover line on "(edited …)": the full date, and who changed it when Jira named them. */
export function editedTip(editedAt?: number, by?: string): string {
  const when = editedAt ? exactDate(editedAt) : "";
  if (when && by) return `Edited ${when} by ${by}`;
  if (when) return `Edited ${when}`;
  return by ? `Edited by ${by}` : "Changed after it was written";
}

/**
 * The address that opens the card in Jira scrolled to one comment, built from
 * the card's own address (`https://site/browse/ORBIT-1042`), so a site served
 * under a path keeps it. Null when the card has no address to build on.
 */
export function commentLink(cardUrl: string | undefined, key: string, id: string): string | null {
  if (!cardUrl || !key || !id) return null;
  let u: URL;
  try { u = new URL(cardUrl); } catch { return null; }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  const at = u.pathname.indexOf("/browse/");
  const base = at >= 0 ? u.pathname.slice(0, at) : u.pathname.replace(/\/+$/, "");
  return `${u.origin}${base}/browse/${encodeURIComponent(key)}?focusedCommentId=${encodeURIComponent(id)}`;
}

/** The roster an edit sends: the people the comment already named, then anyone picked with `@` while changing it, once each. */
export function editRoster(kept: readonly { id: string; name: string }[], picked: readonly { id: string; name: string }[]): { id: string; name: string }[] {
  const seen = new Set<string>();
  const out: { id: string; name: string }[] = [];
  for (const m of [...kept, ...picked]) if (m.id && !seen.has(m.id)) { seen.add(m.id); out.push({ id: m.id, name: m.name }); }
  return out;
}
