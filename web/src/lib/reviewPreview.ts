/*
 * A prompt template with a demo pull request filled in, so the person sees what
 * the agent will be told before saving. The values are invented (acme/orbit,
 * ORBIT-1042): this is the shape of the substitution, not a real pull request.
 * The server fills in the real ones when the button is pressed (expandRecipe).
 */
import type { ReviewRecipeGroup } from "../../../shared/types.ts";

const REVIEW_DEMO: Record<string, string> = {
  number: "1042", repo: "acme/orbit", head: "3f9a2c1", since: "b71e0d4", branch: "fix/reconnect-on-wake",
  title: "Fix reconnect on wake", author: "ada", url: "https://github.com/acme/orbit/pull/1042",
  card: "ORBIT-1042", cardUrl: "https://tracker.example/ORBIT-1042", who: "Sam", note: "ready for another look",
};
const CONFLICT_DEMO: Record<string, string> = {
  number: "1042", repo: "acme/orbit", branch: "fix/reconnect-on-wake", base: "main", title: "Fix reconnect on wake",
  files: "src/sync.ts\nsrc/net.ts", worktree: "~/code/orbit-fix",
};

export interface PreviewPart { text: string; filled: boolean }

/** The template cut into plain text and filled-in values; a placeholder with no demo value stays as written. */
export function previewParts(template: string, group: ReviewRecipeGroup): PreviewPart[] {
  const demo = group === "conflicts" ? CONFLICT_DEMO : REVIEW_DEMO;
  const out: PreviewPart[] = [];
  let last = 0;
  for (const m of template.matchAll(/\{(\w+)\}/g)) {
    const v = demo[m[1]!];
    if (v === undefined) continue;
    if (m.index! > last) out.push({ text: template.slice(last, m.index), filled: false });
    out.push({ text: v, filled: true });
    last = m.index! + m[0].length;
  }
  if (last < template.length) out.push({ text: template.slice(last), filled: false });
  return out;
}

/** "1,240 chars · ~335 tokens": a guess at the cost of sending it, at about 3.7 characters a token. */
export const sizeWords = (text: string): string =>
  `${text.length.toLocaleString("en-US")} chars · ~${Math.ceil(text.length / 3.7).toLocaleString("en-US")} tokens`;
