/*
 * Reading what somebody typed into the finder.
 *
 * The whole value of this is that four easy-to-say facts — it is a png, it is
 * from this morning, it is bigger than 100k, it is under ~/Documents — stop
 * being things you check by eye over two hundred results. So the parsing has to
 * be right about the things people actually type, and it has to leave alone
 * everything that only LOOKS like a filter: a colon is a legal character in a
 * filename, and `foo:bar` must still find `foo:bar`.
 */
import { describe, expect, test } from "bun:test";
import { completion, looksLikePath, parseQuery, parseSize, parseWhen, passesFilters, readPath, scoreMatch } from "../src/lib/finderQuery.ts";

const NOW = new Date(2026, 7, 19, 14, 30); // 19 Aug 2026, 14:30 local
const midnight = new Date(2026, 7, 19).getTime();

describe("sizes, in the units people type", () => {
  test("the shapes", () => {
    expect(parseSize("900")).toBe(900);
    expect(parseSize("10k")).toBe(10_000);
    expect(parseSize("2.5M")).toBe(2_500_000);
    expect(parseSize("1g")).toBe(1e9);
    expect(parseSize("100KB")).toBe(100_000);
  });

  test("and nothing for what is not a size", () => {
    expect(parseSize("big")).toBe(null);
    expect(parseSize("")).toBe(null);
  });
});

describe("dates, in both languages", () => {
  /* Two words each because the person this is for types in Spanish. "hoy" is
     since midnight, not the last 24 hours — which is what somebody means when
     they say it in front of a list of files. */
  test("today and yesterday", () => {
    expect(parseWhen("hoy", NOW)).toBe(midnight);
    expect(parseWhen("today", NOW)).toBe(midnight);
    expect(parseWhen("ayer", NOW)).toBe(midnight - 864e5);
  });

  test("a span, counted in whole days", () => {
    expect(parseWhen("7d", NOW)).toBe(midnight - 6 * 864e5);
    expect(parseWhen("2w", NOW)).toBe(midnight - 13 * 864e5);
  });

  test("an exact date", () => {
    expect(parseWhen("2026-08-12", NOW)).toBe(new Date(2026, 7, 12).getTime());
  });

  test("and nothing for a word that is not one", () => {
    expect(parseWhen("soon", NOW)).toBe(null);
  });
});

describe("reading a query", () => {
  test("plain text is just text", () => {
    const q = parseQuery("captura pantalla", NOW);
    expect(q.text).toBe("captura pantalla");
    expect(q.chips).toEqual([]);
    expect(q.exact).toBe(false);
  });

  test("filters come out and the needle stays", () => {
    const q = parseQuery("captura ext:png mod:hoy size:>100k in:~/Documents", NOW);
    expect(q.text).toBe("captura");
    expect(q.filters.ext).toEqual(["png"]);
    expect(q.filters.after).toBe(midnight);
    expect(q.filters.minBytes).toBe(100_000);
    // `~` is dropped so the fragment matches an absolute path.
    expect(q.filters.under).toEqual(["/Documents"]);
    expect(q.chips.map((c) => c.raw)).toEqual(["ext:png", "mod:hoy", "size:>100k", "in:~/Documents"]);
  });

  test("several extensions at once", () => {
    expect(parseQuery("shot ext:png,jpg,webp", NOW).filters.ext).toEqual(["png", "jpg", "webp"]);
  });

  test("less-than as well as greater-than", () => {
    const q = parseQuery("size:<500k mod:<2026-08-01", NOW);
    expect(q.filters.maxBytes).toBe(500_000);
    expect(q.filters.before).toBe(new Date(2026, 7, 1).getTime());
  });

  test("folders only, or files only", () => {
    expect(parseQuery("pol type:carpeta", NOW).filters.only).toBe("dir");
    expect(parseQuery("pol is:file", NOW).filters.only).toBe("file");
  });

  test("quotes mean the phrase, and they turn the match literal", () => {
    const q = parseQuery('"PoL ORBIT-1042"', NOW);
    expect(q.text).toBe("PoL ORBIT-1042");
    expect(q.exact).toBe(true);
  });

  /* The one that keeps this honest: everything that only looks like a filter
     has to survive as text, because a colon is a legal character in a name. */
  test("a colon that is not a filter stays in the text", () => {
    expect(parseQuery("foo:bar", NOW).text).toBe("foo:bar");
    expect(parseQuery("http://example.test/x", NOW).text).toBe("http://example.test/x");
    // A known key with a value it cannot read is text too, not a silent drop.
    expect(parseQuery("size:enormous", NOW).text).toBe("size:enormous");
    expect(parseQuery("mod:soon", NOW).text).toBe("mod:soon");
  });
});

describe("filtering a row", () => {
  const png = { path: "/home/dev/Documents/shots/01-task.png", kind: "file" as const, bytes: 284_000, mtime: midnight + 3600_000 };
  const dir = { path: "/home/dev/Documents/shots", kind: "dir" as const, bytes: null, mtime: midnight };

  test("extension, size and date", () => {
    expect(passesFilters(png, parseQuery("ext:png", NOW).filters)).toBe(true);
    expect(passesFilters(png, parseQuery("ext:jpg", NOW).filters)).toBe(false);
    expect(passesFilters(png, parseQuery("size:>100k", NOW).filters)).toBe(true);
    expect(passesFilters(png, parseQuery("size:>1M", NOW).filters)).toBe(false);
    expect(passesFilters(png, parseQuery("mod:hoy", NOW).filters)).toBe(true);
    expect(passesFilters(png, parseQuery("mod:<ayer", NOW).filters)).toBe(false);
  });

  test("a folder has no extension, so an extension filter excludes it", () => {
    expect(passesFilters(dir, parseQuery("ext:png", NOW).filters)).toBe(false);
    expect(passesFilters(dir, parseQuery("type:carpeta", NOW).filters)).toBe(true);
    expect(passesFilters(png, parseQuery("type:carpeta", NOW).filters)).toBe(false);
  });

  test("under a path", () => {
    expect(passesFilters(png, parseQuery("in:~/Documents", NOW).filters)).toBe(true);
    expect(passesFilters(png, parseQuery("in:~/code", NOW).filters)).toBe(false);
  });

  /* A row that cannot answer a filter is kept. The alternative is a filter that
     silently empties one tab because the search behind it returns thinner rows
     than another's — which is the inconsistency this whole pass is about. */
  test("a row with no size or date survives a size or date filter", () => {
    const thin = { path: "/home/dev/Documents/note.md", kind: "file" as const };
    expect(passesFilters(thin, parseQuery("size:>1M", NOW).filters)).toBe(true);
    expect(passesFilters(thin, parseQuery("mod:hoy", NOW).filters)).toBe(true);
    // …but a filter it CAN answer still applies.
    expect(passesFilters(thin, parseQuery("ext:png", NOW).filters)).toBe(false);
  });
});

describe("how well a row matches", () => {
  const p = "/home/dev/Documents/projects/PoL ORBIT-1042/01-task-unclaimed.png";

  test("the name beginning with it beats the name containing it", () => {
    expect(scoreMatch(p, "01-task", false)).toBeGreaterThan(scoreMatch(p, "task", false));
  });

  test("the name beats the rest of the path", () => {
    expect(scoreMatch(p, "task", false)).toBeGreaterThan(scoreMatch(p, "projects", false));
  });

  test("letters in order find it, which is what makes typing less work", () => {
    // IN ORDER, and only in order: `orbdash` is a subsequence of
    // `orbit-dashboard`, `ordbt` is not — its `d` comes before its `t` and the
    // path's does not. Fuzzy is not "the same letters".
    expect(scoreMatch("/home/dev/code/orbit-dashboard", "orbdash", false)).toBeGreaterThan(0);
    expect(scoreMatch("/home/dev/code/orbit-dashboard", "ordbt", false)).toBe(-1);
    expect(scoreMatch("/home/dev/code/orbit-dashboard", "zzz", false)).toBe(-1);
  });

  /* Quoting is how you say "stop being clever". */
  test("a quoted query does not do the clever thing", () => {
    expect(scoreMatch("/home/dev/code/orbit-dashboard", "orbdash", true)).toBe(-1);
    expect(scoreMatch("/home/dev/code/orbit-dashboard", "orbit-dash", true)).toBeGreaterThan(0);
  });

  test("an empty needle matches everything equally", () => {
    expect(scoreMatch(p, "", false)).toBe(0);
  });
});

describe("typing a path, the way a shell takes one", () => {
  const HOME = "/home/dev";

  test("what reads as a path and what does not", () => {
    for (const p of ["~/Downloads", "~", "/etc", "./src", "../", "..", "~/Documents/PoL/"]) {
      expect(looksLikePath(p)).toBe(true);
    }
    // Words are words. `orbit-1042` is a search, not a folder.
    for (const w of ["orbit-1042", "captura png", "PoL ORBIT", ""]) {
      expect(looksLikePath(w)).toBe(false);
    }
  });

  test("~ becomes home, and the last piece is what you are still typing", () => {
    expect(readPath("~/Down", HOME, HOME)).toEqual({ dir: "/home/dev", tail: "Down", atFolder: false });
    expect(readPath("~/Downloads/", HOME, HOME)).toEqual({ dir: "/home/dev/Downloads", tail: "", atFolder: true });
    expect(readPath("~", HOME, HOME)).toEqual({ dir: "/home/dev", tail: "", atFolder: true });
  });

  test("an absolute path is taken as it is", () => {
    expect(readPath("/etc/host", HOME, HOME)).toEqual({ dir: "/etc", tail: "host", atFolder: false });
  });

  /* `../` from a folder goes up from THAT folder — resolved here rather than
     handed to the server as a string with dots in it. */
  test("a relative path is resolved against where the list already is", () => {
    expect(readPath("../", HOME, "/home/dev/Documents/projects")).toMatchObject({ dir: "/home/dev/Documents" });
    expect(readPath("./PoL", HOME, "/home/dev/Documents")).toEqual({ dir: "/home/dev/Documents", tail: "PoL", atFolder: false });
    expect(readPath("../../code", HOME, "/home/dev/Documents/projects")).toEqual({ dir: "/home/dev", tail: "code", atFolder: false });
  });

  test("and words are not a path at all", () => {
    expect(readPath("orbit", HOME, HOME)).toBe(null);
  });
});

describe("what Tab completes to", () => {
  const names = ["Documents", "Downloads", "Desktop", "code"];

  test("as far as the candidates agree, like a shell", () => {
    // `D` and `Do` already ARE the agreement between the candidates, so there
    // is nothing to add — a shell adds nothing there too, and the list below is
    // what tells you why. Null rather than echoing the input, so the caller can
    // tell "completed" from "no move".
    expect(completion("D", names)).toBe(null);
    expect(completion("Do", names)).toBe(null);
    expect(completion("Doc", names)).toBe("Documents"); // only one left: complete it
    expect(completion("c", names)).toBe("code");
  });

  test("nothing to add is null, so Tab can do its other job", () => {
    expect(completion("Documents", names)).toBe("Documents");
    expect(completion("zzz", names)).toBe(null);
  });

  test("case does not stop it", () => {
    expect(completion("doc", names)).toBe("Documents");
  });
});
