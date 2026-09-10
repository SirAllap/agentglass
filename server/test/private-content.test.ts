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

/** git, or an empty string when it cannot answer — no remote, a shallow clone,
 *  a tarball with no history at all. A check that cannot read is not a check
 *  that passed, but it must not be a check that fails on a fresh clone. */
function run(...args: string[]): string {
  const r = Bun.spawnSync(args, { cwd: ROOT, stdout: "pipe", stderr: "ignore" });
  return r.exitCode === 0 ? new TextDecoder().decode(r.stdout).trim() : "";
}

/** Everything a person writes. Not lockfiles, not generated files, and not
 *  `node_modules` — a dependency's own prose is not ours to police. */
const SKIP_DIR = new Set([
  "node_modules", ".git", "dist", "build", "coverage", ".expo", "android", "ios",
  "web-shims", "static", "vendor",
  /* The packaged app. It is git-ignored, so CI never sees it and a checkout
     never has it — but a machine that has run the installer does, and the
     vendored JavaScript inside it tripped the quote rule on a regular
     expression full of Spanish-looking fragments. Somebody else's build output
     is not somebody's writing. */
  "dist-app",
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

/* Shared by every rule below, because they ask the same question of different
   surfaces: a comment, a whole comment, a commit message. */
const SPANISH = /\b(?:la|el|los|las|un|una|que|de|del|en|es|no|si|al|lo|se|con|por|para|más|pero|como|esto|esta|este|sigue|roto|rota|puedo|puedes|hay|está|estoy|tengo|quiero|cuando|porque|entonces|donde|nada|todo|muy|bien|mal|vale|gracias|movil|móvil|pantalla|boton|botón|aqui|aquí|abajo|arriba|deberia|debería|solo|sólo|ni|ve|otra|hacer|desde|sin|sobre|entre|hasta)\b/gi;
const COMMENT = /\/\*[\s\S]*?\*\/|\/\/[^\n]*/g;
const QUOTED = /["“«]([^"”»]{8,260})["”»]/g;

/* Accented strings that are somebody's PRODUCT, not somebody. Named here rather
   than guessed at, because the alternative is a rule that fires on every theme
   this app can wear. */
const NOT_A_PERSON = new Set(["Rosé Pine", "Rosé Pine Moon", "Rosé Pine Dawn", "Catppuccin Frappé"]);

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

  /*
   * SPANISH THAT IS NOT IN QUOTES.
   *
   * The rule above catches a quoted sentence, which is the shape the mistake
   * took every time it was made. It is not the shape of the mistake: a
   * paraphrase of the same conversation, unquoted, says exactly as much about
   * who said it and reads as prose. This codebase is written in English, so a
   * run of Spanish anywhere in a comment is either a quote with the quotes
   * taken off or a comment nobody else here can read.
   *
   * Four distinct function words rather than the three a quote needs: without
   * the quotation marks there is no boundary, so the window is a whole comment
   * and the bar has to be higher for the same confidence.
   */
  test("a comment is not written in Spanish at all", () => {
    const flagged = scanned.flatMap(({ path, text }) => {
      const found: string[] = [];
      for (const comment of text.match(COMMENT) ?? []) {
        const flat = comment.replace(/\s*\n\s*\*?\s*/g, " ");
        const words = new Set((flat.match(SPANISH) ?? []).map((w) => w.toLowerCase()));
        if (words.size >= 4) found.push(`${path}: ${flat.slice(0, 70)}`);
      }
      return found;
    });
    expect(
      flagged,
      "a comment is written in Spanish. Taking the quotation marks off a "
      + "conversation does not make it documentation.",
    ).toEqual([]);
  });

  /*
   * A NAME THAT CAME OFF SOMEBODY'S SCREEN.
   *
   * There is no scan that separates a person from an identifier, and this does
   * not pretend to be one. It checks the shape the leak actually had, three
   * times out of three: a Spanish full name, accents and all, pasted into a
   * fixture or an example straight from a task board open on the other screen.
   *
   * A cast of invented people is the way past it — the names below, or any
   * other with no accent on them. That is a narrower rule than "no real
   * names", and it is the part of it a machine can hold.
   */
  test("no accented full name in a fixture or a comment", () => {
    const NAME = /["'`]([A-ZÁÉÍÓÚÑ][a-záéíóúñ]{2,}(?: [A-ZÁÉÍÓÚÑ][a-záéíóúñ]{2,})+)["'`]/g;
    const ACCENT = /[áéíóúñÁÉÍÓÚÑ]/;
    const named = scanned.flatMap(({ path, text }) => {
      const found: string[] = [];
      for (const [, name] of text.matchAll(NAME)) {
        if (ACCENT.test(name) && !NOT_A_PERSON.has(name)) found.push(`${path}: ${name}`);
      }
      return found;
    });
    expect(
      named,
      "a full name with Spanish accents is in the tree. If it is a person, it "
      + "is somebody's; use an invented one.",
    ).toEqual([]);
  });

  /*
   * THE MESSAGES, WHICH NOTHING HERE HAS EVER READ.
   *
   * A commit message is as public as the file it changes, and it is where the
   * two banned things collected: twenty-seven local commits carried a session
   * link as a trailer, and nine quoted a conversation. Both would have gone out
   * with the first push, past a lock that had only ever looked at the tree.
   *
   * Only the commits that have not left this machine. What is already on the
   * remote cannot be fixed by failing a build, and a lock that goes red over
   * history nobody can change is a lock people learn to skip.
   */
  test("a commit that has not been pushed carries neither a session link nor a quote", () => {
    const range = run("git", "rev-parse", "--verify", "--quiet", "origin/main")
      ? "origin/main..HEAD"
      : "HEAD~50..HEAD";
    const log = run("git", "log", range, "--format=%H%x00%B%x00%x00");
    if (!log) return; // Nothing local to check — a fresh clone, or everything pushed.
    const bad: string[] = [];
    for (const entry of log.split("\0\0").filter((e) => e.trim())) {
      const [sha, body = ""] = entry.split("\0");
      const at = sha.trim().slice(0, 8);
      if (/Claude-Session:|claude\.ai\/code\/session/.test(body)) bad.push(`${at}: a session link`);
      const flat = body.replace(/\s+/g, " ");
      for (const [, quoted] of flat.matchAll(QUOTED)) {
        const words = new Set((quoted.match(SPANISH) ?? []).map((w) => w.toLowerCase()));
        if (words.size >= 3) { bad.push(`${at}: ${quoted.slice(0, 50)}`); break; }
      }
    }
    expect(
      bad,
      "an unpushed commit message carries a private session link or quotes a "
      + "conversation. Reword it before it leaves: git rebase -i, or squash.",
    ).toEqual([]);
  });

  test("and the rules it enforces are written down", () => {
    // A lock with no explanation beside it is a lock somebody deletes.
    const rules = readFileSync(join(ROOT, "CLAUDE.md"), "utf8");
    expect(rules).toContain("This repository is public");
    expect(rules).toContain("test/private-content.test.ts");
  });
});
