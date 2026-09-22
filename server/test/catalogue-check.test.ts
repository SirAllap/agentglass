/*
 * The check a catalogue pull request has to pass before it merges.
 *
 * It exists because the listing's only guard used to be a status the listing
 * wrote about itself. So it trusts nothing the approval run said: it reads
 * the two versions of the file, clones the named repository at the pinned
 * commit, and holds the entry to what that commit contains.
 *
 * The fixture is a real git repository on disk. The script is written for
 * GitHub URLs, and git's own `url.<base>.insteadOf` — set through the
 * environment for the child process only — sends those to the fixture, so
 * the script under test is the one CI runs, with no seam cut into it.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contentHash, walkPluginDir } from "../src/plugin-sources.ts";

const CHECK = new URL("../../scripts/catalogue-check.py", import.meta.url).pathname;
const ci = await Bun.file(new URL("../../.github/workflows/ci.yml", import.meta.url)).text();

const OWNER = "SirAllap";
let root = "", repo = "", sha = "", hash = "", moved = "", forked = "", forkedHash = "", tagged = "", taggedHash = "";

const git = (cwd: string, ...args: string[]) => {
  const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "agx-catalogue-check-"));
  repo = join(root, "acme", "orbit-clock");
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "plugin.json"), JSON.stringify({
    name: "orbit-clock", publisher: "acme", description: "Puts the time in a panel.",
    entrypoint: "python3 -u clock.py", scope: "read",
  }));
  writeFileSync(join(repo, "clock.py"), "print('tick')\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "one");
  sha = git(repo, "rev-parse", "HEAD");
  const walked = walkPluginDir(repo);
  hash = contentHash(repo, walked.files);
  // The author pushes after the listing: the pinned commit must still be
  // what is checked, not the branch's new tip.
  writeFileSync(join(repo, "clock.py"), "print('something else')\n");
  git(repo, "commit", "-q", "-am", "two");
  moved = git(repo, "rev-parse", "HEAD");
  // A commit only a fork has. GitHub serves any object in a fork network by
  // id from every repository in it, and shows a fork's pull request head
  // under the parent's refs/pull/; the fixture does both.
  git(repo, "config", "uploadpack.allowAnySHA1InWant", "true");
  git(repo, "checkout", "-q", "-b", "side");
  writeFileSync(join(repo, "clock.py"), "print('from somebody else')\n");
  git(repo, "commit", "-q", "-am", "fork");
  forked = git(repo, "rev-parse", "HEAD");
  forkedHash = contentHash(repo, walkPluginDir(repo).files);
  git(repo, "update-ref", "refs/pull/1/head", forked);
  // And a release that is a tag and no longer any branch's.
  git(repo, "reset", "-q", "--hard", sha);
  writeFileSync(join(repo, "clock.py"), "print('a release')\n");
  git(repo, "commit", "-q", "-am", "release");
  tagged = git(repo, "rev-parse", "HEAD");
  taggedHash = contentHash(repo, walkPluginDir(repo).files);
  git(repo, "tag", "v0.9", tagged);
  git(repo, "checkout", "-q", "main");
  git(repo, "branch", "-D", "side");
});

afterAll(() => { try { rmSync(root, { recursive: true, force: true }); } catch { /* fine */ } });

const shelf = (plugins: unknown[]) => ({ name: "agentglass plugins", owner: OWNER, plugins });
const existing = {
  id: "local-review", title: "Local Review", publisher: "someone", verified: false, scope: "read", draws: [],
  source: { kind: "git", url: "https://github.com/someone/local-review", ref: "f".repeat(40) },
  sha256: "e".repeat(64), description: "Already listed.", categories: [], added: "2026-09-01",
};
const entry = (over: Record<string, unknown> = {}) => ({
  id: "orbit-clock", title: "Orbit Clock", publisher: "acme", verified: false, scope: "read", draws: [],
  source: { kind: "git", url: "https://github.com/acme/orbit-clock", ref: sha },
  sha256: hash, description: "Puts the time in a panel.", categories: ["other"], added: "2026-09-22",
  ...over,
});

/** `gitconfig`, when given, is the global git config the check runs under. */
function check(base: unknown, head: unknown, gitconfig?: string): { code: number | null; out: string } {
  const at = mkdtempSync(join(root, "run-"));
  writeFileSync(join(at, "base.json"), JSON.stringify(base));
  writeFileSync(join(at, "head.json"), JSON.stringify(head));
  if (gitconfig !== undefined) writeFileSync(join(at, "gitconfig"), gitconfig);
  const r = spawnSync("python3", [CHECK, join(at, "base.json"), join(at, "head.json")], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH, HOME: root,
      GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: gitconfig === undefined ? "/dev/null" : join(at, "gitconfig"),
      GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: `url.file://${root}/.insteadOf`, GIT_CONFIG_VALUE_0: "https://github.com/",
    },
  });
  return { code: r.status, out: r.stdout + r.stderr };
}

describe("a listing that holds", () => {
  test("one entry added, pinned, and the commit it names is what it says", () => {
    const r = check(shelf([existing]), shelf([existing, entry()]));
    expect(r.out).toContain("one entry, pinned");
    expect(r.code).toBe(0);
  });

  test("the same repository replacing its own entry with a new commit", () => {
    const old = entry({ source: { kind: "git", url: "https://github.com/acme/orbit-clock.git", ref: "1".repeat(40) }, sha256: "2".repeat(64) });
    expect(check(shelf([old]), shelf([entry()])).code).toBe(0);
  });

  test("a commit that is on a tag and no branch", () => {
    const r = check(shelf([existing]), shelf([existing, entry({ source: { kind: "git", url: "https://github.com/acme/orbit-clock", ref: tagged }, sha256: taggedHash })]));
    expect(r.out).toContain("one entry, pinned");
    expect(r.code).toBe(0);
  });

  test("a pull request that touches no entry has nothing for this to pass", () => {
    expect(check(shelf([existing]), shelf([existing])).out).toContain("changes 0 entries");
  });

  // The app checks out with core.autocrlf off, so the check does too: a
  // runner whose git wrote CRLF would pin a hash no install can reach.
  test("a git that turns line endings to CRLF hashes the bytes an install gets", () => {
    const r = check(shelf([existing]), shelf([existing, entry()]), "[core]\n\tautocrlf = true\n");
    expect(r.out).toContain("one entry, pinned");
    expect(r.code).toBe(0);
  });
});

describe("a listing that does not", () => {
  const refused = (head: unknown, why: string, base: unknown = shelf([existing])) => {
    const r = check(base, head);
    expect(r.code, r.out).toBe(1);
    expect(r.out).toContain(why);
  };

  test("two entries at once", () => refused(shelf([existing, entry(), entry({ id: "orbit-two" })]), "changes 2 entries"));
  test("an entry removed on the way", () => refused(shelf([entry()]), "removes local-review"));
  test("another entry edited on the way", () => refused(shelf([{ ...existing, description: "Rewritten." }, entry()]), "changes 2 entries"));
  test("a repository taking an id listed from another", () =>
    refused(shelf([{ ...entry(), id: "local-review" }]), "a different repository cannot take its place"));
  // Python's `$` matches before a trailing newline; each of these passed its
  // pattern and failed later, if at all, for some other reason.
  test("a commit, a hash or a repository with a newline on the end", () => {
    refused(shelf([existing, entry({ source: { kind: "git", url: "https://github.com/acme/orbit-clock", ref: `${sha}\n` } })]), "not pinned to a full commit");
    refused(shelf([existing, entry({ sha256: `${hash}\n` })]), "no content hash");
    refused(shelf([existing, entry({ source: { kind: "git", url: "https://github.com/acme/orbit-clock\n", ref: sha } })]), "not a public GitHub repository");
  });
  // The approval pins the tip of the named repository; a hand edit could
  // name any commit the fork network holds and still fetch it by id.
  test("a commit that only a fork has, under the repository's name", () =>
    refused(shelf([existing, entry({ source: { kind: "git", url: "https://github.com/acme/orbit-clock", ref: forked }, sha256: forkedHash })]), "not on a branch or a tag"));
  // What the approval derives from the manifest, and a hand edit could say
  // otherwise: a card that draws where the plugin does not, needs another
  // app, or carries another plugin's title.
  test("places it draws that the manifest does not declare", () => refused(shelf([existing, entry({ draws: ["panel"] })]), "draws"));
  test("an app version the manifest does not ask for", () => refused(shelf([existing, entry({ minApp: "0.1.0" })]), "minApp"));
  test("a title that is not the id's", () => refused(shelf([existing, entry({ title: "Local Review" })]), "title"));
  test("a branch instead of a commit", () => refused(shelf([existing, entry({ source: { kind: "git", url: "https://github.com/acme/orbit-clock", ref: "main" } })]), "not pinned to a full commit"));
  test("no hash", () => refused(shelf([existing, entry({ sha256: undefined })]), "no content hash"));
  test("a hash that is not the tree's", () => refused(shelf([existing, entry({ sha256: "0".repeat(64) })]), "not the pinned"));
  test("the tip the author pushed after the label, under the old hash", () =>
    refused(shelf([existing, entry({ source: { kind: "git", url: "https://github.com/acme/orbit-clock", ref: moved } })]), "not the pinned"));
  test("an id that is not the manifest's name", () => refused(shelf([existing, entry({ id: "clock" })]), "the app installs into the manifest's name"));
  test("a scope the manifest does not ask for", () => refused(shelf([existing, entry({ scope: "full" })]), "the manifest asks for"));
  test("a publisher the manifest does not say", () => refused(shelf([existing, entry({ publisher: "someone else" })]), "not the manifest's"));
  test("verified set by the listing", () => refused(shelf([existing, entry({ verified: true })]), "`verified`"));
  test("the project's name on a stranger's repository", () => refused(shelf([existing, entry({ publisher: "Agent Glass" })]), "reserves"));
  test("a preview read from a branch", () =>
    refused(shelf([existing, entry({ preview: "https://raw.githubusercontent.com/acme/orbit-clock/HEAD/preview.png" })]), "preview"));
  test("a source that is not GitHub", () =>
    refused(shelf([existing, entry({ source: { kind: "git", url: "https://example.com/acme/orbit-clock", ref: sha } })]), "not a public GitHub repository"));
  test("a commit the repository does not have", () =>
    refused(shelf([existing, entry({ source: { kind: "git", url: "https://github.com/acme/orbit-clock", ref: "3".repeat(40) } })]), "could not fetch"));
  test("the catalogue's own owner changed", () => refused({ ...shelf([existing, entry()]), owner: "acme" }, "name or owner changed"));
});

describe("the git the check and the listing jobs run", () => {
  // A runner that smudged LFS would pin a hash over files an install, which
  // does not, never has; and a plugin's .lfsconfig would pick the host.
  test("asks nobody for a password and fetches nothing through LFS", async () => {
    const script = await Bun.file(CHECK).text();
    const cloneAt = script.slice(script.indexOf("def clone_at("), script.indexOf("\ndef ", script.indexOf("def clone_at(") + 1));
    expect(cloneAt).toContain('"GIT_TERMINAL_PROMPT": "0"');
    expect(cloneAt).toContain('"GIT_LFS_SKIP_SMUDGE": "1"');
    for (const [file, job] of [["plugin-submission.yml", "  read:"], ["plugin-approve.yml", "  list:"]] as const) {
      const text = await Bun.file(new URL(`../../.github/workflows/${file}`, import.meta.url)).text();
      const head = text.slice(text.indexOf(`\n${job}\n`), text.indexOf("    steps:", text.indexOf(`\n${job}\n`)));
      expect(head, file).toContain('GIT_TERMINAL_PROMPT: "0"');
      expect(head, file).toContain('GIT_LFS_SKIP_SMUDGE: "1"');
    }
  });
});

describe("the words a card uses", () => {
  // The approval turns a manifest's keys into the catalogue's words, and the
  // check turns them again to compare: two copies of one map.
  test("are the same in the approval and in the check", async () => {
    const approval = await Bun.file(new URL("../../.github/workflows/plugin-approve.yml", import.meta.url)).text();
    const script = await Bun.file(CHECK).text();
    const map = (src: string) => {
      const m = src.match(/WORD = (\{[^}]*\})/);
      expect(m, "a WORD map").not.toBeNull();
      return JSON.parse(m![1]!) as Record<string, string>;
    };
    expect(map(script)).toEqual(map(approval));
  });
});

describe("wired into CI", () => {
  /** The job, from its key to the next top-level job. */
  const job = ci.slice(ci.indexOf("\n  catalogue:\n"), ci.indexOf("\n  platform:\n"));

  test("it is a job of its own that runs the script on every pull request", () => {
    expect(job.length).toBeGreaterThan(100);
    expect(job).toContain("python3 scripts/catalogue-check.py landing/plugins.json");
    expect(job, "and it never skips, so it can be a required check").not.toMatch(/^    if: (?!\$\{\{ !cancelled\(\) \}\})/m);
  });

  test("a failed file list is a failure, not a skipped check that reads as passed", () => {
    /* A job skipped because what it needs failed reports "skipped", and a
       required check that was skipped does not block a merge. So it runs
       after a failed `changes` too, and says so in red. */
    expect(job).toContain("    if: ${{ !cancelled() }}");
    expect(job).toContain("if: needs.changes.result != 'success'");
  });

  test("the check it runs is the base branch's, not the pull request's", () => {
    expect(job).toContain("ref: ${{ github.event.pull_request.base.sha }}");
    expect(job).toContain('git show "$HEAD_SHA:landing/plugins.json"');
  });

  test("it clones a stranger's repository holding nothing worth taking", () => {
    expect(job).toContain("persist-credentials: false");
    expect(job).toContain("contents: read");
    expect(job).not.toContain("secrets.");
  });

  test("a catalogue change with anything else in it fails, rather than skipping the check", () => {
    expect(job).toContain("needs.changes.outputs.catalogue_only != 'true'");
    expect(ci).toContain('if [ "$files" = "landing/plugins.json" ]; then');
  });
});

/*
 * The catalogue this repository publishes, as it stands. An entry with no
 * commit and no hash installs whatever its default branch holds that day,
 * which is the exposure the rest of this file exists to close — so every
 * entry on the shelf is pinned, not only the ones listed from now on.
 */
describe("the published catalogue", () => {
  test("pins every entry to a commit and the hash of its tree, and reads its picture there", async () => {
    const shelf = (await Bun.file(new URL("../../landing/plugins.json", import.meta.url)).json()) as {
      plugins: { id: string; source: { ref: unknown }; sha256?: unknown; preview?: string; verified?: unknown }[];
    };
    expect(shelf.plugins.length).toBeGreaterThan(0);
    for (const p of shelf.plugins) {
      expect(String(p.source.ref), `${p.id} ref`).toMatch(/^[0-9a-f]{40}$/);
      expect(String(p.sha256), `${p.id} sha256`).toMatch(/^[0-9a-f]{64}$/);
      expect(p.verified, `${p.id} verified`).toBe(false);
      if (p.preview) expect(p.preview, `${p.id} preview`).toContain(`/${p.source.ref}/`);
    }
  });
});
