/*
 * The GitHub links on a card that are not pull requests.
 *
 * ClickUp's own GitHub panel lists them under "Others" (a wiki page a deploy
 * note points at, an issue, a commit). The public API has no field for that
 * panel, but the same link is always typed into the description, and sometimes
 * into the `Github Url` field, both of which arrive with the card. So they are
 * read out of the text we already hold: no request, and no fetch of the target.
 *
 * Ceiling: a link the GitHub integration attached by itself, without being
 * written anywhere on the card, is not here. Pull requests are excluded on
 * purpose; the pull request list above already has them, with their state.
 */

export interface GithubLink {
  /** Canonical `https://github.com/...`, no trailing slash. */
  url: string;
  /** owner/repo/... without the host, for the muted line. */
  path: string;
  /** Short name for the row. */
  title: string;
}

/* The host must START a token (`notgithub.com` fails the lookbehind) and END
   at a slash (`github.com.evil.io` fails the lookahead). The path stops at
   whitespace and at the characters that close a markdown link or an angle
   bracket, so `[t](url)` and `<url>` give the bare url. */
const LINK = /(?<![\w.@/-])(?:https?:\/\/)?(?:www\.)?github\.com(\/[^\s<>"'`)\]]*)/gi;

const CAP = 10;

function clean(path: string): string {
  // A sentence ends after a link: `.`, `,`, `;`, `:`, `!`, `?`, and emphasis marks.
  return path.replace(/[.,;:!?*_~]+$/, "").replace(/\/+$/, "");
}

function label(seg: string[]): string {
  const at = (i: number) => { try { return decodeURIComponent(seg[i] ?? ""); } catch { return seg[i] ?? ""; } };
  if (seg[2] === "wiki") return seg[3] ? at(3).replace(/-/g, " ") : "Wiki";
  if (seg[2] === "issues" && /^\d+$/.test(seg[3] ?? "")) return `Issue #${seg[3]}`;
  if (seg[2] === "commit" && seg[3]) return seg[3].slice(0, 7);
  if (seg.length === 2) return at(1);
  return at(seg.length - 1);
}

/** Every non-pull-request GitHub link in the given texts, in order, once each. */
export function otherGithubLinks(...texts: (string | null | undefined)[]): GithubLink[] {
  const out = new Map<string, GithubLink>();
  for (const text of texts) {
    if (!text) continue;
    for (const m of text.matchAll(LINK)) {
      const path = clean(m[1]!);
      const bare = path.replace(/[?#].*$/, "");
      const seg = bare.split("/").filter(Boolean);
      if (seg.length < 2) continue; // an owner alone is not a place
      if (seg[2] === "pull" && /^\d+$/.test(seg[3] ?? "")) continue;
      const key = bare.toLowerCase();
      if (out.has(key)) continue;
      out.set(key, { url: `https://github.com${path}`, path: seg.join("/"), title: label(seg) });
      if (out.size >= CAP) return [...out.values()];
    }
  }
  return [...out.values()];
}
