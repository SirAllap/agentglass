/*
 * The open pull requests the link sheet offers, as rows it can draw.
 *
 * They come from `/prs/list?filter=all&state=open`, the route the PR board
 * reads, so the sheet lists what the board shows. Pull requests the card
 * already names are left out: the sheet draws those itself, first, as "already
 * linked". One row per pull request address, newest number first.
 *
 * Ceiling: one page per repository (the server's first page), and at most
 * three repositories. The paste field stays for anything past that.
 */
import type { PrSummary } from "../../../shared/types.ts";

export interface LinkPick {
  number: number;
  title: string;
  url: string;
  /** "feat/ORBIT-1042 · green" — branch, then what the checks say. */
  detail: string;
  tone: "good" | "bad" | "plain";
}

function checkWord(p: Pick<PrSummary, "isDraft" | "checks">): { word: string; tone: LinkPick["tone"] } {
  if (p.isDraft) return { word: "draft", tone: "plain" };
  const r = p.checks;
  if (!r || !r.total) return { word: "no checks", tone: "plain" };
  if (r.failure > 0 || r.verdict === "red") return { word: "failing", tone: "bad" };
  if (r.verdict === "green") return { word: "green", tone: "good" };
  return { word: `${r.success} of ${r.total} checks`, tone: "plain" };
}

export function linkPicks(
  lists: readonly (readonly Pick<PrSummary, "number" | "title" | "url" | "headRefName" | "isDraft" | "checks" | "state">[])[],
  alreadyUrls: readonly string[],
): LinkPick[] {
  const skip = new Set(alreadyUrls);
  const seen = new Set<string>();
  const out: LinkPick[] = [];
  for (const list of lists) {
    for (const p of list) {
      if (p.state !== "OPEN" || skip.has(p.url) || seen.has(p.url)) continue;
      seen.add(p.url);
      const c = checkWord(p);
      out.push({ number: p.number, title: p.title, url: p.url, detail: `${p.headRefName} · ${c.word}`, tone: c.tone });
    }
  }
  return out.sort((a, b) => b.number - a.number);
}
