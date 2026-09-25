// Paths in terminal output that are worth offering as links.
//
// The detector here is pure and only says what LOOKS like a path. Whether it
// exists is a question for the engine, asked afterwards and cached (see
// termPathLinks.ts): a line of build output is full of `and/or` and `1/2`, and
// a link on every one of them would be a screen of underlines.

export interface PathCandidate {
  /** Offset of the first character in the text handed in. */
  start: number;
  /** Offset one past the last character. */
  end: number;
  /** The path as printed, quotes and trailing punctuation removed. */
  text: string;
}

/*
 * Where a path may begin: the start of the line, or after something that
 * cannot be part of a word. Never after `:` or `/`, which is what keeps
 * `https://host/a/b` from yielding `//host/a/b`.
 */
const LEAD = String.raw`(?<![^\s(\[{<=,;])`;
const STOP = String.raw`\s"'` + "`" + String.raw`<>()\[\]{}|*?,;`;
const ROOTED = String.raw`(?:~\/|\/|\.{1,2}\/)`;
const QUOTED = new RegExp(String.raw`(["'` + "`" + String.raw`])(${ROOTED}[^"'` + "`" + String.raw`\n]*?)\1`, "g");
const BARE = new RegExp(String.raw`${LEAD}(${ROOTED}[^${STOP}]*|[A-Za-z0-9_][\w.-]*\/[^${STOP}]*)`, "g");

/** A sentence ends after a path more often than the path contains the mark. */
const TRAILING = /[.:!]+$/;

export function pathCandidates(line: string): PathCandidate[] {
  const out: PathCandidate[] = [];
  const taken: [number, number][] = [];
  const free = (s: number, e: number) => taken.every(([a, b]) => e <= a || s >= b);

  // Quoted first: it is the only way a path with spaces in it is one path.
  for (const m of line.matchAll(QUOTED)) {
    const text = m[2]!;
    if (text.length < 2 || text.includes("://")) continue;
    const start = m.index! + 1;
    out.push({ start, end: start + text.length, text });
    taken.push([m.index!, m.index! + m[0].length]);
  }

  for (const m of line.matchAll(BARE)) {
    let text = m[1]!;
    const start = m.index!;
    if (!free(start, start + text.length)) continue;
    if (text.includes("://")) continue;
    // `src/a.ts:12:3` is how compilers and grep name a place IN a file.
    text = text.replace(TRAILING, "").replace(/:\d+(?::\d+)?$/, "").replace(TRAILING, "");
    if (text.length < 2 || text === "~/" || text === "./" || text === "../") continue;
    if (continuesAcrossASpace(line, start + text.length, text)) continue;
    out.push({ start, end: start + text.length, text });
  }
  return out.sort((a, b) => a.start - b.start);
}

/*
 * `~/My Docs/x.png` unquoted is `~/My` followed by a word that is itself a
 * path, and linking the first half sends somebody to the wrong folder. When
 * the next word looks like more of a path (it has a slash, or ends in an
 * extension) the run is left alone: a person who wants it linked quotes it, and
 * the failure is "no link" rather than "a link to something else".
 *
 * A trailing slash ends the argument — `~/a/b/ (c/d.png)` is a folder followed
 * by a note — and so does a next word that opens with a bracket or a quote.
 */
function continuesAcrossASpace(line: string, at: number, text: string): boolean {
  if (text.endsWith("/")) return false;
  const next = /^ ([^\s"'`(\[{<]\S*)/.exec(line.slice(at));
  if (!next) return false;
  return next[1]!.includes("/") || /\.[A-Za-z0-9]{1,5}$/.test(next[1]!);
}

/** Where a printed path points, given home and the folder the shell started in. */
export function resolvePrinted(text: string, home: string, cwd: string): string | null {
  if (text.startsWith("~") && !home) return null;
  if (!text.startsWith("/") && !text.startsWith("~") && !cwd) return null;
  const parts = (text.startsWith("/") ? text
    : text === "~" || text.startsWith("~/") ? `${home}${text.slice(1)}`
    : `${cwd}/${text}`).split("/");
  const out: string[] = [];
  for (const p of parts) {
    if (p === "" || p === ".") continue;
    if (p === "..") { out.pop(); continue; }
    out.push(p);
  }
  return "/" + out.join("/");
}
