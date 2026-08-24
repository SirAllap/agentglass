/*
 * Nothing in the tree names a real organisation, client or workspace.
 *
 * ── why this exists as a test and not as a hook ───────────────────────────
 * It has happened four times — 7d5555f, 4629ec2, 13afc01, 115c23c — and the
 * house rule that came out of it is written in the last of them: measure
 * against the real data, translate before you write. The enforcement that came
 * out of it was a local pre-commit hook, and a local hook is exactly the thing
 * that cannot help here. It lives on one machine. A fresh clone does not have
 * it, CI does not run it, and an agent working in a container has never seen
 * it — which is how a set of test fixtures went in carrying a real project
 * name, a real card title and a real pull request number, all read off a
 * screenshot. A test travels with the repository and runs everywhere the code
 * does.
 *
 * 115c23c also wrote down why the hook missed even on the machine that had it:
 * "the hook knows the names it was told, and the names have variants". So this
 * does not match text. It normalises first — camel case split, case folded,
 * every separator dropped — so `acme-corp`, `Acme Corp`, `acme.corp`,
 * `AcmeCorp` and `ACME_CORP` all arrive at the scan as the same two tokens and
 * one joined pair. Matching a spelling is what fails; matching the word is what
 * does not.
 *
 * Every example in this file is `acme`, and that is not decoration. The prose
 * of a guard is the easiest place in the repository to leak the thing it
 * guards, and it is the one place the guard cannot see: this file is excluded
 * from its own scan, so a real name written here would ship green.
 *
 * ── why the names are hashed ─────────────────────────────────────────────
 * Because this file is in the public repository too. A guard that spells out
 * a name in order to forbid it has published that name, which is the whole of
 * what it was protecting. So what is stored is the SHA-256 of the normalised
 * token and a bare category, never the word. The scan hashes the distinct
 * tokens it finds and compares digests.
 *
 * It is one-way, not secret, and the difference matters. Nobody can read the
 * list back, so a name here is invisible to somebody who does not already have
 * it in mind. But these are single dictionary words, so somebody who suspects
 * a particular one can confirm it with one `sha256sum` — an unsalted digest of
 * a short word is a check, not a vault, and a salt would not help because the
 * salt would have to sit next to it. That trade is the reason the entries
 * below carry a bare category and no story: the guard is worth having, and it
 * is not worth writing down whose names these are or why.
 *
 * Adding one is `printf '%s' <lowercased-and-joined> | sha256sum`. The cost of
 * one-way is that a failure cannot print the offending word — it prints the
 * file, which is where somebody about to fix it is already looking.
 *
 * ── what it deliberately does NOT do ─────────────────────────────────────
 * It does not scan for secrets. Tokens, keys and passwords have their own
 * shapes and their own tooling, and gitleaks-in-a-test-file would be a worse
 * version of something CodeQL already runs. This is the one class of leak that
 * no scanner can find, because a client's project name is an ordinary English
 * word until you know whose it is.
 */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");

/** This file. Excluded from its own scan, and the only exclusion of its kind:
 *  everything else in the tree is fair game, including tests — a fixture is
 *  where the last four of these actually got in. */
const SELF = "server/test/private-names.test.ts";

const sha = (s: string): string => createHash("sha256").update(s).digest("hex");

/**
 * The names, as digests.
 *
 * `what` says only what KIND of thing tripped, in as few words as carry the
 * meaning. It is deliberately not a story: a category is what a reader needs
 * to act, and anything beyond it describes a relationship this file has no
 * business publishing.
 *
 * To add one: lowercase it, strip every separator, and hash it — `printf '%s'
 * acmecorp | sha256sum`. Add both the bare word and the run-together form when
 * a name has a suffix, because the run-together form tokenises as one word and
 * the bare one will not catch it.
 */
const FORBIDDEN: { hash: string; what: string }[] = [
  {
    hash: "6627835f988e2c5e50533d491163072d3f4f41f5c8b04630150debb3722ca2dd",
    what: "an organisation name",
  },
  {
    hash: "f9cbcb01b91b6ea12f4e562a63ee35327cef361013901597dc3f21854ba89d81",
    what: "the same name, run together with its suffix",
  },
];

/** Extensions worth reading. Anything else is either binary or a lockfile, and
 *  a name arriving through one of those is not the failure this is about. */
const TEXT = /\.(ts|tsx|js|jsx|mjs|cjs|json|md|ya?ml|html|css|sh|py|txt|toml|xml|svg|plist|gradle|pro|kt|java|rb)$/i;

/** A megabyte. Above it is a generated bundle or a vendored blob, and
 *  tokenising one costs more than the leak it could hold. */
const CAP = 1_048_576;

const tracked = (): string[] => {
  const git = Bun.spawnSync(["git", "ls-files", "-z"], { cwd: ROOT });
  expect(git.exitCode, "git ls-files failed — is this a checkout?").toBe(0);
  return git.stdout.toString().split("\0").filter(Boolean);
};

/**
 * Every distinct word in a string, normalised.
 *
 * Camel case is split BEFORE folding, or `AcmeCorp` stays one token and the
 * bare-word digest never fires on it. Adjacent pairs are emitted joined,
 * because that is what a two-word name looks like once its separator is gone
 * — and the separator is the half the old hook was matching on.
 */
function words(text: string): Set<string> {
  const out = new Set<string>();
  const parts = text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/);
  for (let i = 0; i < parts.length; i++) {
    const one = parts[i];
    if (!one || one.length < 3) continue;
    out.add(one);
    const next = parts[i + 1];
    if (next && one.length + next.length <= 40) out.add(one + next);
  }
  return out;
}

const files = tracked();

/**
 * Digests already worked out, kept across files.
 *
 * A repository's words repeat far more than they differ — `const`, `return`,
 * `the`, every identifier in every import — so without this the scan hashes the
 * same token thousands of times and spends its whole budget on SHA-256. It went
 * in because the scan timed out on a cold run at five seconds while passing at
 * two on a warm one, and a guard that goes red on the clock rather than on the
 * tree is one people learn to ignore.
 */
const judged = new Map<string, string | null>();

/** What this token is, if it is anything. `null` is a real answer and is
 *  cached: the tokens that are fine are the overwhelming majority, and they are
 *  the ones worth not hashing twice. */
function verdictOn(token: string, banned: Map<string, string>): string | null {
  const known = judged.get(token);
  if (known !== undefined) return known;
  const what = banned.get(sha(token)) ?? null;
  judged.set(token, what);
  return what;
}

describe("no private names in the tree", () => {
  test("there is a tree to scan at all", () => {
    // A scan that reads nothing passes forever. This is the only thing
    // standing between that and a green tick.
    expect(files.length).toBeGreaterThan(100);
  });

  test("the digests are digests", () => {
    for (const f of FORBIDDEN) {
      expect(f.hash, `${f.what}: not a sha256`).toMatch(/^[0-9a-f]{64}$/);
      // Present, and that is all that is asked of it. This check used to
      // demand a long one, which is how the first version of this file ended
      // up carrying a sentence about whose names these were. Short is the
      // requirement now, not the concession.
      expect(f.what.length, "every entry names its category").toBeGreaterThan(3);
      expect(f.what.length, "a category, not a story — say less").toBeLessThan(60);
    }
  });

  test("the scan can still see a name when there is one", () => {
    // The normaliser is the whole guard, so it is proven against every shape
    // the last four incidents actually arrived in, using a word that is not
    // one of the forbidden ones.
    const shapes = ["Acme Corp", "acme-corp", "acme.corp", "AcmeCorp", "ACME_CORP", "acme/corp"];
    for (const shape of shapes) {
      expect(words(shape).has("acmecorp"), `${shape} did not normalise`).toBe(true);
    }
  });

  /* A minute, not the default five seconds. What bounds this test is the size
     of the tree, which grows, and on a cold filesystem the reads alone have
     already come within a whisker of the default. A timeout here is a guard
     against hanging, not a performance assertion — and a guard that fails
     intermittently on timing is worse than no guard, because the next red one
     gets waved through. */
  test("no tracked file contains one", () => {
    const banned = new Map(FORBIDDEN.map((f) => [f.hash, f.what]));
    const hits: string[] = [];

    for (const path of files) {
      if (path === SELF || !TEXT.test(path)) continue;
      const full = join(ROOT, path);
      let text: string;
      try {
        if (statSync(full).size > CAP) continue;
        text = readFileSync(full, "utf8");
      } catch {
        continue; // deleted between listing and reading, or not decodable
      }
      // The path counts too: a file NAMED after a client leaks it from the
      // directory listing, without anybody opening it.
      for (const token of words(`${path} ${text}`)) {
        const what = verdictOn(token, banned);
        if (what) { hits.push(`${path} — ${what}`); break; }
      }
    }

    expect(
      [...new Set(hits)],
      "a real name is in the tree. The house rule is 115c23c's: measure "
      + "against the real data, translate before you write. Replace it with an "
      + "invented one — the repository already has a cast (acme/shop-api, "
      + "orbit, atlas, /w/…, /home/me) — rather than adding an exception here.",
    ).toEqual([]);
  }, 60_000);
});
