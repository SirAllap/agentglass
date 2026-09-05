/*
 * What somebody typed into the finder, read as a question.
 *
 * A finder that only does substring matching makes you do the filtering by
 * eye: two hundred results, and the one you want is a `.png` from this morning
 * somewhere under `~/Documents`. Every one of those three facts is easy to say
 * and impossible to type — so this reads them out of the query itself:
 *
 *     captura ext:png mod:hoy size:>100k in:~/Documents
 *     "PoL ORBIT-1042"          exact, because it is quoted
 *     ordbt                     fuzzy, because it is not
 *
 * Everything here is pure. The filters are applied on the client to rows the
 * server already returned, which is what lets them work identically on all four
 * tabs — the checkout, the machine, the recents and a folder being browsed —
 * without four different backends learning the same syntax.
 */

export interface FinderFilters {
  /** Extensions, without the dot, lowercased. Empty means any. */
  ext: string[];
  /** Bytes. `null` where the side was not given. */
  minBytes: number | null;
  maxBytes: number | null;
  /** Epoch millis: modified at or after / at or before. */
  after: number | null;
  before: number | null;
  /** A path fragment the result has to contain. */
  under: string[];
  /** Only folders, or only files. */
  only: "dir" | "file" | null;
}

export interface FinderQuery {
  /** What is left after the filters are taken out — the actual needle. */
  text: string;
  /** True when it was quoted: match the phrase, not the letters. */
  exact: boolean;
  filters: FinderFilters;
  /** The filter terms as they were written, so the UI can show them as chips
   *  and take them off one at a time. */
  chips: { key: string; value: string; raw: string }[];
}

const EMPTY: FinderFilters = { ext: [], minBytes: null, maxBytes: null, after: null, before: null, under: [], only: null };

/** `10k`, `2.5M`, `900`, `1g` — the sizes people type, in the units they type. */
export function parseSize(v: string): number | null {
  const m = /^([\d.]+)\s*([kmgt])?b?$/i.exec(v.trim());
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  const mult = { k: 1e3, m: 1e6, g: 1e9, t: 1e12 }[(m[2] ?? "").toLowerCase()] ?? 1;
  return Math.round(n * mult);
}

/**
 * `hoy`, `today`, `ayer`, `7d`, `3w`, `2026-08-19`.
 *
 * Both languages on purpose: the person this is for types in Spanish and the
 * words are two each. A day is taken as its start, so "hoy" means everything
 * since midnight rather than the last 24 hours — which is what somebody means
 * when they say it in front of a list of files.
 */
export function parseWhen(v: string, now = new Date()): number | null {
  const s = v.trim().toLowerCase();
  const midnight = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  if (s === "hoy" || s === "today") return midnight(now);
  if (s === "ayer" || s === "yesterday") return midnight(now) - 864e5;
  if (s === "semana" || s === "week") return midnight(now) - 6 * 864e5;
  if (s === "mes" || s === "month") return midnight(now) - 29 * 864e5;
  const rel = /^(\d+)\s*([dwmy])$/.exec(s);
  if (rel) {
    const n = Number(rel[1]);
    const days = { d: 1, w: 7, m: 30, y: 365 }[rel[2] as "d" | "w" | "m" | "y"];
    return midnight(now) - (n * days - 1) * 864e5;
  }
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (iso) return new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3])).getTime();
  return null;
}

/** The `key:value` terms this understands. Anything else stays in the text —
 *  a colon is a legitimate character in a filename and `foo:bar` must still be
 *  searchable as itself. */
const KEYS = new Set(["ext", "size", "mod", "in", "type", "is"]);

export function parseQuery(input: string, now = new Date()): FinderQuery {
  const filters: FinderFilters = { ...EMPTY, ext: [], under: [] };
  const chips: FinderQuery["chips"] = [];
  const words: string[] = [];
  let exact = false;

  // Quoted first, and taken out whole: a phrase is one term however many
  // spaces are in it, and it is what turns a fuzzy match into a literal one.
  let rest = input.replace(/"([^"]*)"/g, (_, phrase: string) => {
    if (phrase.trim()) { words.push(phrase.trim()); exact = true; }
    return " ";
  });

  for (const word of rest.split(/\s+/)) {
    if (!word) continue;
    const at = word.indexOf(":");
    const key = at > 0 ? word.slice(0, at).toLowerCase() : "";
    const value = at > 0 ? word.slice(at + 1) : "";
    if (!KEYS.has(key) || !value) { words.push(word); continue; }

    const chip = { key, value, raw: word };
    switch (key) {
      case "ext":
        for (const e of value.split(",")) {
          const clean = e.trim().replace(/^\./, "").toLowerCase();
          if (clean) filters.ext.push(clean);
        }
        chips.push(chip);
        break;
      case "size": {
        // `>1M`, `<500k`, or a bare size meaning "at least".
        const m = /^([<>]=?)?(.+)$/.exec(value);
        const bytes = parseSize(m?.[2] ?? "");
        if (bytes === null) { words.push(word); break; }
        if ((m?.[1] ?? ">").startsWith("<")) filters.maxBytes = bytes;
        else filters.minBytes = bytes;
        chips.push(chip);
        break;
      }
      case "mod": {
        const m = /^([<>]=?)?(.+)$/.exec(value);
        const when = parseWhen(m?.[2] ?? "", now);
        if (when === null) { words.push(word); break; }
        if ((m?.[1] ?? ">").startsWith("<")) filters.before = when;
        else filters.after = when;
        chips.push(chip);
        break;
      }
      case "in":
        filters.under.push(value.replace(/^~(?=\/|$)/, ""));
        chips.push(chip);
        break;
      case "type":
      case "is":
        if (/^(dir|folder|carpeta)$/i.test(value)) { filters.only = "dir"; chips.push(chip); }
        else if (/^(file|fichero|archivo)$/i.test(value)) { filters.only = "file"; chips.push(chip); }
        else words.push(word);
        break;
    }
  }

  return { text: words.join(" ").trim(), exact, filters, chips };
}

/** Anything a row can be, as far as filtering is concerned. */
export interface Filterable {
  path: string;
  kind: "dir" | "file" | "link";
  bytes?: number | null;
  mtime?: number | null;
}

/**
 * Does this row survive the filters?
 *
 * A row that cannot answer a filter — no size, no date, because the search that
 * produced it never asked for one — is KEPT. The alternative is a filter that
 * silently empties a tab because the backend behind it is thinner than another,
 * which is exactly the inconsistency this whole pass is about.
 */
export function passesFilters(row: Filterable, f: FinderFilters): boolean {
  if (f.only && (f.only === "dir" ? row.kind === "file" : row.kind === "dir")) return false;

  if (f.ext.length) {
    if (row.kind === "dir") return false;
    const dot = row.path.lastIndexOf(".");
    const slash = row.path.lastIndexOf("/");
    const ext = dot > slash ? row.path.slice(dot + 1).toLowerCase() : "";
    if (!f.ext.includes(ext)) return false;
  }

  if (row.bytes != null) {
    if (f.minBytes != null && row.bytes < f.minBytes) return false;
    if (f.maxBytes != null && row.bytes > f.maxBytes) return false;
  }

  if (row.mtime != null) {
    if (f.after != null && row.mtime < f.after) return false;
    if (f.before != null && row.mtime > f.before) return false;
  }

  if (f.under.length) {
    const p = row.path.toLowerCase();
    if (!f.under.some((u) => p.includes(u.toLowerCase()))) return false;
  }
  return true;
}

/**
 * Does the needle match, and how well?
 *
 * Returns a score — higher is better — or -1 for no match. Three tiers, in the
 * order people expect: the name starting with what you typed beats the name
 * containing it, which beats the letters appearing in order somewhere in the
 * path. Quoted queries skip the third tier entirely, which is the whole point
 * of quoting one.
 */
export function scoreMatch(path: string, text: string, exact: boolean): number {
  if (!text) return 0;
  const hay = path.toLowerCase();
  const needle = text.toLowerCase();
  const name = hay.slice(hay.lastIndexOf("/") + 1);

  if (name.startsWith(needle)) return 1000 - name.length;
  if (name.includes(needle)) return 800 - name.length;
  if (hay.includes(needle)) return 600 - hay.length / 100;
  if (exact) return -1;

  // Subsequence: `ordbt` finds `orbit-dashboard`. Scored by how tightly the
  // letters sit together, so a match that reads as the word beats one that
  // happens to have the letters scattered across a long path.
  let i = 0;
  let last = -1;
  let gaps = 0;
  for (const ch of needle) {
    const at = hay.indexOf(ch, i);
    if (at < 0) return -1;
    if (last >= 0) gaps += at - last - 1;
    last = at;
    i = at + 1;
  }
  return Math.max(1, 400 - gaps);
}


/* -------------------------------------------------------------------------
 * Typing a path, the way a shell takes one.
 *
 * `~/Downloads` in a search box means "go there", not "find a file called
 * ~/Downloads" — which is what it used to answer, and it is the difference
 * between a search box and a file browser. Anything that starts like a path is
 * read as a destination: the folder part says where to look, the rest filters
 * what is in it, and Tab completes like it does everywhere else.
 * ---------------------------------------------------------------------- */

export interface PathIntent {
  /** The folder to list. */
  dir: string;
  /** What was typed after the last slash — a filter, and what Tab completes. */
  tail: string;
  /** True when the text ended in a slash: the folder itself, nothing typed. */
  atFolder: boolean;
}

/** Does this read as a path rather than as words? */
export function looksLikePath(raw: string): boolean {
  const q = raw.trim();
  return q === "~" || q === ".." || /^(~|\.{1,2})?\//.test(q) || /^\.\.$/.test(q);
}

/**
 * Where a typed path points.
 *
 * `~` becomes home and a relative one is resolved against where the list
 * already is, exactly as a shell would — `../` from a folder goes up from THAT
 * folder, not from somewhere else.
 */
export function readPath(raw: string, home: string, here: string): PathIntent | null {
  const q = raw.trim();
  if (!looksLikePath(q)) return null;

  let full: string;
  if (q === "~" || q.startsWith("~/")) full = `${home}${q.slice(1)}`;
  else if (q.startsWith("/")) full = q;
  else {
    // Relative: resolve against the current folder, collapsing `.` and `..`
    // the way a shell does rather than handing the string to the server.
    const parts = `${here}/${q}`.split("/");
    const out: string[] = [];
    for (const part of parts) {
      if (!part || part === ".") continue;
      if (part === "..") { out.pop(); continue; }
      out.push(part);
    }
    full = `/${out.join("/")}`;
  }

  full = full.replace(/\/{2,}/g, "/");
  if (q.endsWith("/") || q === "~") return { dir: full.replace(/\/$/, "") || "/", tail: "", atFolder: true };
  const cut = full.lastIndexOf("/");
  return { dir: cut <= 0 ? "/" : full.slice(0, cut), tail: full.slice(cut + 1), atFolder: false };
}

/**
 * What Tab should turn `~/Down` into.
 *
 * The longest prefix every candidate shares, which is what a shell completes
 * to — one match completes the whole name, several complete as far as they
 * agree and stop. Returns null when there is nothing to add, so Tab can fall
 * through to whatever it did before.
 */
export function completion(tail: string, names: string[]): string | null {
  const lower = tail.toLowerCase();
  const hits = names.filter((n) => n.toLowerCase().startsWith(lower));
  if (!hits.length) return null;
  let common = hits[0]!;
  for (const n of hits.slice(1)) {
    let i = 0;
    while (i < common.length && i < n.length && common[i]!.toLowerCase() === n[i]!.toLowerCase()) i++;
    common = common.slice(0, i);
  }
  return common.length > tail.length ? common : (hits.length === 1 ? hits[0]! : null);
}
