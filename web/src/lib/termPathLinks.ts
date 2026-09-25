// The half of path links that needs the engine: does this path exist, and
// where does the shell's `~` point.
//
// It sits next to the URL link the terminal already has rather than inside it.
// The URL addon decides on a regex alone, synchronously; a path is only a link
// once the engine has said it is there, which is an answer that arrives later.
// The provider interface allows exactly that, and the addon's does not.

import type { ILink, ILinkProvider, Terminal } from "@xterm/xterm";
import { api } from "./api.ts";
import { openFinderAt } from "./finderTarget.ts";
import { pathCandidates, resolvePrinted, type PathCandidate } from "./termPaths.ts";

export type Known = "dir" | "file" | null;

/*
 * Cached by absolute path, and the in-flight ask is cached too: hovering the
 * same line twice, or a build log that prints one path forty times, is one
 * request. A miss is cached like a hit — the alternative is asking again on
 * every mouse move over `and/or`. The cost is that a file created after the
 * first look stays unlinked until the cache turns over; 30 s is the ceiling.
 */
const TTL_MS = 30_000;
const known = new Map<string, { at: number; kind: Promise<Known> }>();

function kindOf(abs: string): Promise<Known> {
  const hit = known.get(abs);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.kind;
  const kind = api.previewFacts(abs).then((f): Known => (!f.ok ? null : f.kind === "dir" ? "dir" : "file"))
    // A failed ask is not an answer: forget it so the next hover asks again.
    .catch((): Known => { known.delete(abs); return null; });
  known.set(abs, { at: Date.now(), kind });
  if (known.size > 500) known.delete(known.keys().next().value!);
  return kind;
}

let homeCache: Promise<string> | null = null;
const homeDir = () => (homeCache ??= api.diskPlaces().then((r) => r.home || "").catch(() => { homeCache = null; return ""; }));

/**
 * The candidates in a line that turn out to be there. The lookup is a
 * parameter so the rule — "only a path that exists is linked" — is a thing a
 * test can hold without an engine.
 */
interface Target { cand: PathCandidate; abs: string; kind: "dir" | "file" }
const MAX_PER_LINE = 8;

export async function linkTargets(
  text: string, home: string, cwd: string, lookup: (abs: string) => Promise<Known>,
): Promise<Target[]> {
  const out: Target[] = [];
  // A build log can print dozens on one line; the first few are the ones under a pointer.
  await Promise.all(pathCandidates(text).slice(0, MAX_PER_LINE).map(async (cand) => {
    const abs = resolvePrinted(cand.text, home, cwd);
    const kind = abs ? await lookup(abs) : null;
    if (abs && kind) out.push({ cand, abs, kind });
  }));
  return out.sort((a, b) => a.cand.start - b.cand.start);
}

export function registerPathLinks(term: Terminal, cwd: string): void {
  const provider: ILinkProvider = {
    provideLinks(y, done) {
      const buf = term.buffer.active;
      /* A long path wraps, and a wrapped line is one line to a reader. Join
         the rows, remember where each offset lands. Wide characters make the
         column arithmetic below a little wrong; a path has none. */
      let top = y - 1;
      while (top > 0 && buf.getLine(top)?.isWrapped) top--;
      let text = "";
      let row = top;
      for (;;) {
        const line = buf.getLine(row);
        if (!line) break;
        text += line.translateToString(false);
        row++;
        if (!buf.getLine(row)?.isWrapped) break;
      }
      const cols = term.cols;
      const at = (i: number) => ({ x: (i % cols) + 1, y: top + Math.floor(i / cols) + 1 });
      const inRow = (c: PathCandidate) => at(c.start).y <= y && y <= at(c.end - 1).y;
      void homeDir().then((home) => linkTargets(text, home, cwd, kindOf)).then((found) => {
        const links = found.filter((f) => inRow(f.cand)).map((f): ILink => ({
          range: { start: at(f.cand.start), end: at(f.cand.end - 1) },
          text: f.cand.text,
          activate: () => openFinderAt(f.abs, f.kind),
        }));
        done(links.length ? links : undefined);
      });
    },
  };
  term.registerLinkProvider(provider);
}
