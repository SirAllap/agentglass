/*
 * The understudy panel derives NOTHING, and this is the test that keeps it that
 * way.
 *
 * The gate that decides whether a class of decision may be offered for
 * promotion is a promise about autonomy. It is stated once, on the server, in
 * `server/src/understudy.ts` — a count of scored decisions, a raw agreement
 * floor, and the lower bound of a Wilson interval — and the frame that reaches
 * the browser carries the ANSWERS: `mode`, `offered`, and a list of sentences
 * saying what is in the way.
 *
 * A panel that recomputed any of that would be a second implementation of the
 * promise. That is not a hypothetical failure mode: the second copy ships
 * inside a bundle, the bundle is cached, and the day somebody moves the
 * threshold there are two numbers in the world and only one of them is the one
 * the server refuses on. The panel would then be able to tell the user a class
 * had earned something the server would not grant, which is the exact sentence
 * this whole feature exists not to be able to say.
 *
 * So: the numbers are not allowed in these files at all. Not as a constant, not
 * in a comparison, not restated in a comment. The failure message names the
 * file and the line, because a test that only says "no" teaches nobody where
 * the rule came from.
 *
 * It also pins the two RETENTION numbers the settings page prints, for the same
 * reason in miniature: they are copied out of server/src/db.ts because a
 * browser cannot import a module that opens a SQLite database, and a copied
 * number that nothing checks is a number that has already drifted.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const DIR = join(import.meta.dir, "..", "src", "components", "understudy");

/**
 * The panel's own files — everything at the top of the understudy folder.
 *
 * `persona/` is excluded and that is a real distinction rather than a
 * convenience: it is the ART, it carries the palette the layers were drawn
 * against, and none of it has ever seen the scorecard.
 *
 * Read from the directory rather than listed by name, so a file added to the
 * panel tomorrow is covered without anybody remembering to add it here — with
 * a floor below, so a rename cannot quietly empty the scan and leave this
 * suite passing over nothing.
 */
const FILES = readdirSync(DIR)
  .filter((f) => f.endsWith(".tsx") || f.endsWith(".ts"))
  .sort()
  .map((f) => ({ rel: `web/src/components/understudy/${f}`, text: readFileSync(join(DIR, f), "utf8") }));

/** Where each hit is, so the failure is actionable rather than a verdict. */
function hits(re: RegExp): string[] {
  const out: string[] = [];
  for (const { rel, text } of FILES) {
    text.split("\n").forEach((ln, i) => {
      if (new RegExp(re.source, re.flags.replace("g", "")).test(ln)) out.push(`${rel}:${i + 1} → ${ln.trim()}`);
    });
  }
  return out;
}

describe("the understudy panel derives nothing", () => {
  test("there are files to check", () => {
    // The floor. Every rule below is an assertion about a set of files, and an
    // empty set satisfies all of them.
    expect(FILES.length).toBeGreaterThanOrEqual(4);
    expect(FILES.map((f) => f.rel)).toContain("web/src/components/understudy/UnderstudyPanel.tsx");
  });

  test("no threshold number appears anywhere, in code or in prose", () => {
    // `80` with word boundaries: `340px` and `1080` are not the gate, and a
    // rule that fired on them would be a rule people learn to work around.
    expect(hits(/\b80\b/g), "the count of scored decisions belongs to the server").toEqual([]);
    expect(hits(/\b0\.70?\b/g), "the raw agreement floor belongs to the server").toEqual([]);
    expect(hits(/\b0\.60?\b/g), "the bound the interval has to clear belongs to the server").toEqual([]);
  });

  test("the bound is never computed here", () => {
    expect(hits(/wilson/gi), "wilsonLower lives in shared/wilson.ts and is called on the server").toEqual([]);
    expect(hits(/Math\.sqrt/g)).toEqual([]);
    expect(hits(/shared\/wilson/g)).toEqual([]);
  });

  test("the agreement ratio is read off the frame, not divided out again", () => {
    // `raw` is on the row. Dividing `hits` by `n` here would be a second
    // opinion about a number the server already published — and the two would
    // differ the moment the server changes what counts.
    expect(hits(/\bhits\s*\//g)).toEqual([]);
    expect(hits(/\/\s*(?:row\.)?n\b/g)).toEqual([]);
  });

  test("nothing is judged against a threshold", () => {
    /*
     * A comparison of a scorecard field against a number. `> 0` is allowed and
     * is not an exception being smuggled in: "is there any record at all" is a
     * question about whether to draw a row, not about whether a class has
     * earned anything. Every other constant on the right of one of these is
     * this file re-deciding something the server decided.
     */
    expect(hits(/\b(?:raw|lb|n|hits|bank)\s*(?:>=|<=|>|<)\s*(?!0\b)[\d.]/g)).toEqual([]);
  });

  test("`offered` is a field, never a conclusion", () => {
    // The strongest statement the server makes about autonomy is a boolean on
    // the row. Assigning to a local called `offered` is how a panel starts
    // having an opinion about it.
    expect(hits(/\boffered\s*=[^=]/g)).toEqual([]);
  });

  test("the blocked sentences are printed, not parsed", () => {
    // The positive half: the reasons a class is not being offered have to
    // actually reach the screen, or the rule above has quietly turned into
    // "show nothing".
    const all = FILES.map((f) => f.text).join("\n");
    expect(all).toContain("blocked");
    expect(all).toMatch(/blocked\.map|blocked\[0\]/);
  });
});

/*
 * The two windows the settings page prints.
 *
 * They live in server/src/db.ts because that is where the sweep that enforces
 * them lives; they are repeated in the panel because a browser cannot import a
 * module that opens a database. That copy is allowed to exist and is not
 * allowed to be wrong.
 */
describe("the retention numbers still match the sweep that enforces them", () => {
  const db = readFileSync(join(import.meta.dir, "..", "..", "server", "src", "db.ts"), "utf8");
  const panel = readFileSync(join(DIR, "UnderstudyPanel.tsx"), "utf8");

  const server = (name: string): number => {
    const m = new RegExp(String.raw`export const ${name}\s*=\s*(\d+)`).exec(db);
    if (!m) throw new Error(`${name} is gone from server/src/db.ts — the panel's copy has nothing to mirror`);
    return Number(m[1]);
  };
  const client = (field: string): number => {
    const m = new RegExp(String.raw`${field}:\s*(\d+)`).exec(panel);
    if (!m) throw new Error(`RETENTION.${field} is gone from UnderstudyPanel.tsx`);
    return Number(m[1]);
  };

  test("sealed situations", () => {
    expect(client("snapshotDays")).toBe(server("UNDERSTUDY_SNAPSHOT_DAYS"));
  });

  test("the bare fact of a write", () => {
    expect(client("stubDays")).toBe(server("UNDERSTUDY_STUB_DAYS"));
  });
});
