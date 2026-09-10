/*
 * The repository is public, and three things kept getting into it.
 *
 * A private message, quoted verbatim in a comment. A real person's name, out
 * of a chat notification that happened to be open. A link to an assistant
 * session, appended to a pull request body by tooling.
 *
 * All three were fixed by hand more than once, which is the definition of a
 * thing that needs a lock rather than a promise. So this reads the tree the
 * way `mobile/test/tap-floor.test.ts` reads it — source is a fact, and a fact
 * is testable — and fails the build before the next one ships.
 *
 * It lives in server/ because that is what `make test` and CI's build job run,
 * and it scans every workspace rather than this one.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");

/** Everything a person writes. Not lockfiles, not generated files, and not
 *  `node_modules` — a dependency's own prose is not ours to police. */
const SKIP_DIR = new Set([
  "node_modules", ".git", "dist", "build", "coverage", ".expo", "android", "ios",
  "web-shims", "static", "vendor",
]);
const TEXT = /\.(ts|tsx|js|jsx|mjs|cjs|md|json|ya?ml|html|css|sh)$/;

function files(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIR.has(entry)) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) { out.push(...files(path)); continue; }
    if (!TEXT.test(entry) || /\.generated\./.test(entry)) continue;
    if (entry === "bun.lock" || entry === "package-lock.json") continue;
    out.push(path);
  }
  return out;
}

const tree = files(ROOT).map((path) => ({
  path: path.slice(ROOT.length + 1),
  text: readFileSync(path, "utf8"),
}));

/** This file quotes the very patterns it bans, so it cannot scan itself. */
const scanned = tree.filter((f) => !f.path.endsWith("test/private-content.test.ts"));

const hits = (re: RegExp): string[] =>
  scanned.flatMap(({ path, text }) => {
    const found = text.match(re);
    return found ? [`${path}: ${found[0].slice(0, 60)}`] : [];
  });

describe("nothing private is in the tree", () => {
  test("there is a tree to read at all", () => {
    // A scan that stops finding files is a test that passes for the wrong
    // reason. The number is a floor, not a count.
    expect(scanned.length).toBeGreaterThan(200);
  });

  test("no link to an assistant session", () => {
    // Written clean and appended by tooling on pull request CREATION, which is
    // why the rule in CLAUDE.md is to read the body back afterwards.
    expect(hits(/claude\.ai\/code\/session[_/][A-Za-z0-9]+/)).toEqual([]);
  });

  test("no session trailer in a committed template or script", () => {
    expect(hits(/Claude-Session:\s*https?:\/\//)).toEqual([]);
  });

  test("a comment does not quote a message somebody sent", () => {
    /*
     * The heuristic is language. This codebase is written in English, and every
     * one of these got in as a quoted Spanish sentence — so a quoted run with
     * three different Spanish function words in it is the shape of the thing.
     *
     * The first version of this rule looked for one word from a list of twelve
     * and looked at raw source, and it found four of the twenty-three that were
     * actually in the tree. Both halves were wrong:
     *
     *   A comment wraps. `"la app sigue\n * rota"` is one quote to a reader and
     *   two lines to a regex, so the comment is FLATTENED before it is read.
     *
     *   One word is not a signal. "de" and "la" are in half the identifiers in
     *   any codebase; three distinct ones inside one pair of quotes is not an
     *   accident.
     *
     * Deliberately still a tripwire for the mistake that was actually made, and
     * not a language detector — the rule it protects is written in CLAUDE.md,
     * and somebody reading a failure here should go and read that.
     */
    const SPANISH = /\b(?:la|el|los|las|un|una|que|de|del|en|es|no|si|al|lo|se|con|por|para|más|pero|como|esto|esta|este|sigue|roto|rota|puedo|puedes|hay|está|estoy|tengo|quiero|cuando|porque|entonces|donde|nada|todo|muy|bien|mal|vale|gracias|movil|móvil|pantalla|boton|botón|aqui|aquí|abajo|arriba|deberia|debería|solo|sólo|ni|ve|otra|hacer|desde|sin|sobre|entre|hasta|entonces)\b/gi;
    const COMMENT = /\/\*[\s\S]*?\*\/|\/\/[^\n]*/g;
    const QUOTED = /["“«]([^"”»]{8,260})["”»]/g;

    const quoted = scanned.flatMap(({ path, text }) => {
      const found: string[] = [];
      for (const comment of text.match(COMMENT) ?? []) {
        // Unwrapped: the leading `*` of each line goes, and so does the break.
        const flat = comment.replace(/\s*\n\s*\*?\s*/g, " ");
        for (const [, run] of flat.matchAll(QUOTED)) {
          const words = new Set((run.match(SPANISH) ?? []).map((w) => w.toLowerCase()));
          if (words.size >= 3) found.push(`${path}: ${run.slice(0, 60)}`);
        }
      }
      return found;
    });

    expect(
      quoted,
      "a comment is quoting somebody's own words. Say what the defect WAS — "
      + "who mentioned it, and in which language, is not documentation.",
    ).toEqual([]);
  });

  test("and the rules it enforces are written down", () => {
    // A lock with no explanation beside it is a lock somebody deletes.
    const rules = readFileSync(join(ROOT, "CLAUDE.md"), "utf8");
    expect(rules).toContain("This repository is public");
    expect(rules).toContain("test/private-content.test.ts");
  });
});
