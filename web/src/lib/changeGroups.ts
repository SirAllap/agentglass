/*
 * The places a file changed, rather than the lines.
 *
 * The rail down the editor listed one entry per changed line: sixty-three
 * numbers for a file with four changes in it. "130, 131, 132 … 141" is not
 * twelve things, it is one — a function somebody added — and a list that says
 * otherwise is a list nobody reads.
 *
 * So: consecutive changes fold into a RANGE, each range carries how much it
 * changed and, where the language makes it findable, the name of the thing it
 * is inside. That is what you are actually looking for; the number is what
 * confirms it.
 */

export interface ChangeGroup {
  /** First and last line of the run, in the new file. */
  from: number;
  to: number;
  added: number;
  removed: number;
  /** `def foo`, `class Bar`, `export function baz` — trimmed to something that
   *  fits a 190px rail. Empty when nothing nameable was found. */
  symbol: string;
  /** The changed lines inside the range, for unfolding one place into the lines
   *  it is made of. A range is the answer nine times out of ten; the tenth is
   *  a forty-line block where you want the third edit. */
  lines: number[];
}

/**
 * How far apart two changed lines can be and still be one place.
 *
 * Three is the gap a blank line and a comment leave between two edits inside the
 * same function. Past that they read as two things, and merging them would put
 * one entry over a run of forty lines with a hole in the middle.
 */
const NEAR = 3;

/**
 * The definition a line declares, if it declares one.
 *
 * Deliberately shallow and multi-language: this is a label for a rail, not a
 * parser. A line that is obviously a declaration in Python, TypeScript, Go,
 * Rust or Java gets its name taken; everything else gets nothing, which is a
 * better answer than a guess that reads like a bug.
 */
export function symbolOf(line: string): string {
  const text = line.replace(/^[+\- ]/, "").trim();
  const m = /^(?:export\s+|default\s+|public\s+|private\s+|protected\s+|static\s+|async\s+|pub\s+)*(?:(?:def|class|function|fn|func|interface|type|struct|enum|impl|module|trait)\s+([A-Za-z_$][\w$]*)|(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function\b|\())/.exec(text);
  const name = m?.[1] ?? m?.[2];
  if (!name) return "";
  const kind = /^(?:export\s+|default\s+|public\s+|private\s+|protected\s+|static\s+|async\s+|pub\s+)*(\w+)/.exec(text)?.[1] ?? "";
  return /^(def|class|function|fn|func|interface|type|struct|enum|impl|module|trait)$/.test(kind) ? `${kind} ${name}` : name;
}

/** One hunk, as both halves of the app hold it. */
export interface HunkLike { newStart: number; lines: string[] }

/**
 * Group a file's hunks into places.
 *
 * The symbol is looked for INSIDE the hunk, walking back from the change to the
 * nearest declaration — including the context lines the diff carries for
 * exactly this reason. A change that has no declaration above it in its own
 * hunk gets no name rather than the name of something further up the file that
 * this side cannot see.
 */
export function groupHunks(hunks: HunkLike[], cap = 400): ChangeGroup[] {
  const out: ChangeGroup[] = [];
  for (const h of hunks) {
    let line = h.newStart;
    /** Declarations seen so far in this hunk, newest last. */
    let heading = "";
    let open: ChangeGroup | null = null;
    const close = () => { if (open) { out.push(open); open = null; } };

    for (const raw of h.lines) {
      const changed = raw.startsWith("+") || raw.startsWith("-");
      const sym = symbolOf(raw);
      if (sym && !changed) heading = sym;

      if (changed) {
        if (open && line - open.to > NEAR) close();
        if (!open) open = { from: line, to: line, added: 0, removed: 0, symbol: sym || heading, lines: [] };
        // A declaration ON a changed line names the group better than whatever
        // came before it: this IS the new function.
        if (sym && !raw.startsWith("-")) open.symbol = sym;
        open.to = Math.max(open.to, line);
        if (open.lines[open.lines.length - 1] !== line) open.lines.push(line);
        if (raw.startsWith("+")) open.added++; else open.removed++;
      }
      // A deletion has no line in the new file, so the cursor does not advance.
      if (!raw.startsWith("-")) line++;
      if (sym && changed && !raw.startsWith("-")) heading = sym;
      if (out.length >= cap) { close(); return out.slice(0, cap); }
    }
    close();
  }
  return out.slice(0, cap);
}

/** The same, from a unified patch as text — the shape the pull request holds. */
export function groupPatch(patch: string, cap = 400): ChangeGroup[] {
  const hunks: (HunkLike & { context: string })[] = [];
  let cur: (HunkLike & { context: string }) | null = null;
  for (const raw of patch.split("\n")) {
    const head = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@ ?(.*)$/.exec(raw);
    if (head) {
      cur = { newStart: Number(head[1]), lines: [], context: head[2] ?? "" };
      hunks.push(cur);
      continue;
    }
    if (cur) cur.lines.push(raw);
  }
  const groups = groupHunks(hunks, cap);
  /* The hunk header carries the enclosing symbol — `@@ … @@ def foo(self):` —
     and it is the only place a name is available for a change at the very top
     of a hunk. Used as the fallback, never over a declaration found inside. */
  let i = 0;
  for (const h of hunks) {
    const fallback = symbolOf(h.context) || h.context.trim();
    while (i < groups.length && groups[i]!.from < h.newStart + h.lines.length + 1) {
      if (!groups[i]!.symbol && fallback) groups[i]!.symbol = fallback.slice(0, 60);
      i++;
    }
  }
  return groups;
}

/** What the rail's header says: how many places, and the totals. */
export function groupTotals(groups: ChangeGroup[]): { places: number; added: number; removed: number } {
  return {
    places: groups.length,
    added: groups.reduce((n, g) => n + g.added, 0),
    removed: groups.reduce((n, g) => n + g.removed, 0),
  };
}

/** Which group a line is inside, or the nearest one above it. -1 when there are
 *  none. This is what makes the rail follow the cursor. */
export function groupAt(groups: ChangeGroup[], line: number): number {
  if (!groups.length) return -1;
  let best = -1;
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i]!;
    if (line >= g.from && line <= g.to) return i;
    if (g.from <= line) best = i;
  }
  return best === -1 ? 0 : best;
}

/** The lines of a group, for the ones that want to expand it. */
export const groupLabel = (g: ChangeGroup): string => (g.from === g.to ? String(g.from) : `${g.from}–${g.to}`);
