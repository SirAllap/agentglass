/*
 * The two privacy properties of the ingest, both learned by breaking them.
 *
 * 1. A gate that cannot find its list must not say "nothing forbidden".
 *    The first real run had XDG_CONFIG_HOME pointed at a scratch directory, the
 *    private-terms list silently resolved to empty, every window passed, and
 *    127 private terms were written into a compiled policy file. The gate could
 *    not distinguish "checked, clean" from "could not check" — and neither
 *    could anything downstream of it.
 *
 * 2. Provenance is a KIND, never a path.
 *    The second run had a working gate and still leaked, because the leak was
 *    not in the text of a rule: it was in the label beside it. Rules carried
 *    `~/.claude/projects/-home-you-code-<employer>/memory/x.md`, and 151
 *    copies of an employer's name went into a generated file. The gate runs
 *    over rule text and could never have caught it.
 *
 * Both tests use a jail with its own terms file, so the suite never reads the
 * developer's real one and never writes near their real policy.
 */
import { describe, expect, test, beforeAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let jail: string;
let U: typeof import("../src/understudy.ts");
let ING: typeof import("../src/understudy-ingest.ts");

beforeAll(async () => {
  jail = mkdtempSync(join(tmpdir(), "agx-ingest-privacy-"));
  mkdirSync(join(jail, "config", "git"), { recursive: true });
  mkdirSync(join(jail, "notes"), { recursive: true });
  process.env.AGENTGLASS_DB = join(jail, "t.db");
  process.env.XDG_CONFIG_HOME = join(jail, "config");
  U = await import("../src/understudy.ts");
  ING = await import("../src/understudy-ingest.ts");
});

const writeTerms = (lines: string[]) => {
  writeFileSync(join(jail, "config", "git", "private-terms.txt"), lines.join("\n") + "\n");
  // The compiled list is cached; the override resets it, which is also how a
  // real caller would pick up an edited file.
  U.__setPrivateTermsPath(join(jail, "config", "git", "private-terms.txt"));
};

describe("the ingest refuses rather than guessing", () => {
  test("termsStatus says whether it actually knows", () => {
    U.__setPrivateTermsPath(join(jail, "config", "git", "does-not-exist.txt"));
    const missing = U.termsStatus();
    expect(missing.ok).toBe(false);
    expect(missing.count).toBe(0);

    writeTerms(["\\bacme-secret\\b", "TICKET-[0-9]{3,}"]);
    const there = U.termsStatus();
    expect(there.ok).toBe(true);
    expect(there.count).toBe(2);
  });

  test("with no terms list, ingest throws instead of reading anything", () => {
    U.__setPrivateTermsPath(join(jail, "config", "git", "does-not-exist.txt"));
    expect(() => ING.ingest()).toThrow();
    // And the refusal names the path so a person can fix it, while saying
    // nothing about what would have been read.
    try {
      ING.ingest();
    } catch (e) {
      expect(String(e)).toContain("private-terms");
    }
  });

  test("the override is explicit and has to be asked for", () => {
    U.__setPrivateTermsPath(join(jail, "config", "git", "does-not-exist.txt"));
    // Nothing is allowed, so this reads nothing either way — the point is that
    // it gets far enough to return a result rather than refusing.
    const r = ING.ingest({ iAcceptNoTermsList: true });
    expect(r.rules).toBe(0);
    expect(r.precedents).toBe(0);
  });
});

describe("provenance never carries a path", () => {
  test("a rule from a private-looking directory keeps the term out of its label", () => {
    writeTerms(["\\bacme\\b"]);

    // A memory directory whose PATH carries the private word, and whose rule
    // text does not. This is exactly the shape that leaked: the gate sees the
    // text, and the directory name rides along in the provenance.
    const memDir = join(jail, "projects", "-home-someone-code-acme", "memory");
    mkdirSync(memDir, { recursive: true });
    writeFileSync(
      join(memDir, "feedback-a-rule.md"),
      "---\nname: r\n---\n\nYou must never push without showing the diff first.\n",
    );

    U.setNever([]);
    const id = U.addExtraSource(memDir, "a project", "rules");
    U.setAllowed(id, true);

    const r = ING.ingest({ maxFilesPerSource: 20 });
    expect(r.rules).toBeGreaterThan(0);

    const dir = ING.policyDir();
    expect(existsSync(dir)).toBe(true);
    let all = readFileSync(join(dir, "constitution.md"), "utf8");
    const books = join(dir, "playbooks");
    if (existsSync(books)) {
      for (const f of readdirSync(books)) all += readFileSync(join(books, f), "utf8");
    }

    // The rule survived…
    expect(all).toContain("never push without showing the diff");
    // …and the directory it came out of did not.
    expect(all.toLowerCase()).not.toContain("acme");
    // Nor did anything path-shaped at all.
    expect(all).not.toContain("/memory/");
    expect(all).not.toMatch(/~\/\.claude/);
  });

  test("the must-not-see list vetoes a path before the file is opened", () => {
    writeTerms(["\\bacme\\b"]);
    const secret = join(jail, "projects", "vault");
    mkdirSync(secret, { recursive: true });
    writeFileSync(join(secret, "notes.md"), "You must always keep the key in the safe.\n");

    const id = U.addExtraSource(secret, "vault", "rules");
    U.setAllowed(id, true);
    U.setNever(["vault"]);

    const r = ING.ingest({ maxFilesPerSource: 20 });
    const dir = ING.policyDir();
    let all = readFileSync(join(dir, "constitution.md"), "utf8");
    const books = join(dir, "playbooks");
    if (existsSync(books)) {
      for (const f of readdirSync(books)) all += readFileSync(join(books, f), "utf8");
    }
    expect(all).not.toContain("keep the key in the safe");
    expect(r).toBeTruthy();
    U.setNever([]);
  });
});
