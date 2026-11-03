// Pure decisions behind the Repo insights modal, kept out of the screen so a
// test can press them (there is no renderer in this project).
import type { Changelog } from "../../../shared/types.ts";

/** The changelog as markdown, or "" when there is nothing to copy. */
export function changelogMarkdown(c: Changelog | null): string {
  if (!c?.sections.length) return "";
  const head = c.from ? `# Changelog ${c.from}..${c.to}` : `# Changelog (to ${c.to})`;
  const body = c.sections.map((s) => `## ${s.title}\n\n${s.entries.map((e) => `- ${e.scope ? `**${e.scope}:** ` : ""}${e.subject} (${e.hash})`).join("\n")}`).join("\n\n");
  return `${head}\n\n${body}\n`;
}

/** What an empty changelog says. Every subject lands in a section (the ones
 *  that are not conventional go under "Other"), so no sections means no
 *  commits in the range, not "no conventional commits". */
export function emptyChangelogText(c: Changelog): string {
  if (c.empty) return "no commits yet";
  if (!c.from) return "no commits in range";
  return c.to === "HEAD" ? `nothing since ${c.from}` : `nothing between ${c.from} and ${c.to}`;
}

/** Copy `text`, and say what happened either way. */
export async function copyText(text: string, write: (t: string) => Promise<void>): Promise<"copied" | "failed"> {
  try { await write(text); return "copied"; } catch { return "failed"; }
}
