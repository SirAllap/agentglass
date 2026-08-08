// "There is no pull request for this branch" and "I could not ask" are two
// different sentences, and for a while they were the same value.
//
// `prsForBranch` answered `{ ok: true, into: [] }` when `gh` was uninstalled,
// logged out, or killed by its 25s timeout — which is byte for byte what it
// answers for a branch nobody has opened a pull request from. The header drew
// what it draws for silence: nothing. Measured by taking `gh` off the PATH:
// `{"ok":true,"repo":"…","into":[]}`.
//
// Nothing tested this function at all, so the fix had no lock on it. This is
// the lock, and it is written the way the failure was found — by running the
// real thing against a real repository with a real (or absent) `gh`, rather
// than by mocking the module the server imports at load time.
//
// Two mechanics make that possible and neither is optional:
//
//   * every `gh` case runs in a CHILD process. `ghBin()` calls `Bun.which("gh")`
//     with no explicit PATH, and that resolves against the PATH the process
//     STARTED with — so a PATH assignment inside this file would change
//     nothing. A child starts with the PATH we hand it.
//   * `GH_CONFIG_DIR` points at an empty directory and every `GH_TOKEN`-shaped
//     variable is stripped, so "logged out" is the real `gh` reaching its real
//     logged-out branch (exit 4, no network) without this suite ever reading —
//     or writing — the credentials of whoever is running it.
import { describe, expect, test, beforeAll } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const dir = realpathSync(mkdtempSync(join(tmpdir(), "agx-prbranch-")));
process.env.XDG_CONFIG_HOME = dir;
process.env.AGENTGLASS_DB = join(dir, "b.db");

const { prsForBranch } = await import("../src/prs.ts");
/** The same module, by path: the child processes import it themselves. */
const PRS_MODULE = fileURLToPath(new URL("../src/prs.ts", import.meta.url));

/** Is `gh` on this machine at all? Both answers are testable; they are just
 *  different sentences, and the test says which one it expects. */
const GH = Bun.which("gh");

// ---------------------------------------------------------------------------
// a repository, a fake `gh`, and a way to run the real function next to both
// ---------------------------------------------------------------------------

const GH_CFG = join(dir, "gh-config-empty"); // stays empty: that IS logged out
const BIN = join(dir, "bin");                // a PATH with git and nothing else
const SHIM = join(dir, "shim");              // a PATH whose `gh` is ours
const DRIVER = join(dir, "ask.mjs");
const GH_LOG = join(dir, "gh-argv.log");

const hermeticGit = {
  GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@e",
  GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@e",
  GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null",
};

function git(cwd: string, ...args: string[]): void {
  Bun.spawnSync(["git", ...args], { cwd, env: { ...process.env, ...hermeticGit }, stdout: "pipe", stderr: "pipe" });
}

/** A repository on disk, with the remote a caller would find there. */
function repoWith(name: string, remote?: string): string {
  const root = join(dir, name);
  mkdirSync(root, { recursive: true });
  git(root, "init", "-q", "-b", "main", ".");
  if (remote) git(root, "remote", "add", "origin", remote);
  return realpathSync(root);
}

let REPO = "";   // origin is github.com/acme/orbit
let PLAIN = "";  // a repository with no remote at all

beforeAll(() => {
  REPO = repoWith("orbit", "https://github.com/acme/orbit.git");
  PLAIN = repoWith("plain");

  mkdirSync(GH_CFG, { recursive: true });
  mkdirSync(BIN, { recursive: true });
  mkdirSync(SHIM, { recursive: true });

  // A PATH with git on it and no `gh`. `repoIdFor` still has to work, so this
  // is "gh is not installed" rather than "nothing is installed".
  const realGit = Bun.which("git");
  if (realGit) writeFileSync(join(BIN, "git"), `#!/bin/sh\nexec ${realGit} "$@"\n`);
  chmodSync(join(BIN, "git"), 0o755);

  /*
   * A stand-in for the ONE thing that cannot be reached without a network and
   * somebody's credentials: a successful answer.
   *
   * It stands in for the transport and nothing else — the arguments, the spawn,
   * the JSON parse and every line of `shape()` are the server's own. It also
   * writes down what it was called with, which is how the tests below can say
   * "gh was never asked" and mean it.
   */
  writeFileSync(join(SHIM, "gh"), [
    "#!/bin/sh",
    'printf "%s\\n" "$*" >> "$AGX_GH_LOG"',
    'for a in "$@"; do',
    '  [ "$a" = "--head" ] && { printf "%s" "$AGX_GH_HEAD"; exit 0; }',
    '  [ "$a" = "--base" ] && { printf "%s" "$AGX_GH_BASE"; exit 0; }',
    "done",
    'printf "[]"',
    "",
  ].join("\n"));
  chmodSync(join(SHIM, "gh"), 0o755);

  writeFileSync(DRIVER, [
    "// Imports the real module and prints what it answered. Its own process, so",
    "// the PATH it was handed is the PATH `Bun.which` sees.",
    "const [mod, root, branch] = process.argv.slice(2);",
    "const { prsForBranch } = await import(mod);",
    'process.stdout.write("RESULT " + JSON.stringify(await prsForBranch(root, branch)) + "\\n");',
    "",
  ].join("\n"));
});

type Answer = Awaited<ReturnType<typeof prsForBranch>>;

/** Run the real `prsForBranch` in a child with an environment we chose. */
function ask(root: string, branch: string, env: Record<string, string>): Answer {
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    // Anything that could log `gh` in on this machine is not part of the test.
    if (/^(GH|GITHUB)_/.test(k) || v === undefined) continue;
    clean[k] = v;
  }
  const r = Bun.spawnSync([process.execPath, DRIVER, PRS_MODULE, root, branch], {
    env: {
      ...clean, ...hermeticGit,
      XDG_CONFIG_HOME: dir, AGENTGLASS_DB: join(dir, "child.db"),
      GH_CONFIG_DIR: GH_CFG, AGX_GH_LOG: GH_LOG,
      ...env,
    },
    stdout: "pipe", stderr: "pipe",
  });
  const out = new TextDecoder().decode(r.stdout);
  const line = out.split("\n").find((l) => l.startsWith("RESULT "));
  if (!line) throw new Error(`no answer from the child: ${out}${new TextDecoder().decode(r.stderr)}`);
  return JSON.parse(line.slice("RESULT ".length)) as Answer;
}

const shimLog = () => { try { return readFileSync(GH_LOG, "utf8"); } catch { return ""; } };

// ---------------------------------------------------------------------------

describe("the branch name is an argument to a command", () => {
  /*
   * It is interpolated into `gh pr list --head <branch>`, so a name that reads
   * as an option is a way to steer somebody else's CLI. The guard refuses
   * rather than sanitising: there is no legal branch called `-X`, and a
   * refusal cannot be got wrong the way an escape can.
   */
  test("nothing to look up is a refusal, not an empty answer", async () => {
    for (const branch of ["", "   ", "\t\n"]) {
      const r = await prsForBranch(REPO, branch);
      expect(r.ok).toBe(false);
      expect(r.error).toBe("no branch");
      expect(r.into).toEqual([]);
      // Not `needsAuth`: gh is fine, the caller asked for nothing.
      expect(r.needsAuth).toBeUndefined();
    }
  });

  test("a name that would read as an option is refused", async () => {
    for (const branch of ["-x", "--repo", "-", "--json=x"]) {
      const r = await prsForBranch(REPO, branch);
      expect(r.ok).toBe(false);
      expect(r.error).toBe("no branch");
    }
  });

  test("a name with whitespace in it is refused — one word, one argument", async () => {
    // Two words is two arguments on a command line and one here, and rather
    // than pick, this refuses. No legal branch name contains a space anyway.
    for (const branch of ["feat/a b", "a\tb", "a\nb"]) {
      const r = await prsForBranch(REPO, branch);
      expect(r.ok).toBe(false);
      expect(r.error).toBe("no branch");
    }
    // A name that is only padded is trimmed rather than refused — that is
    // somebody's paste, not an attack. Asserted in the child, below, because
    // proving it goes through means letting a `gh` run.
  });

  test("the parameter is `unknown`, and everything that is not a string is nothing", async () => {
    // It arrives from `url.searchParams.get(...)`, which can be null.
    for (const branch of [null, undefined, 42, {}, ["main"]]) {
      const r = await prsForBranch(REPO, branch);
      expect(r.ok).toBe(false);
      expect(r.error).toBe("no branch");
    }
  });

  test("`gh` is never spawned for a refused name", () => {
    // The point of the guard, and the only way to prove it: run the real
    // function with our own `gh` first on the PATH, and read its log.
    const before = shimLog();
    const r = ask(REPO, "-x", { PATH: `${SHIM}:${process.env.PATH ?? ""}`, AGX_GH_HEAD: "[]", AGX_GH_BASE: "[]" });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("no branch");
    expect(shimLog()).toBe(before);
  }, 30_000);
});

describe("a checkout GitHub has never heard of", () => {
  /*
   * A repository with no GitHub remote is not an authentication problem, and
   * saying so would send the user to `gh auth login` for a directory where
   * logging in changes nothing. `needsAuth` is the flag the panel reads to
   * offer that button.
   */
  test("no remote is its own answer, and does not claim to be auth", async () => {
    const r = await prsForBranch(PLAIN, "main");
    expect(r.ok).toBe(false);
    expect(r.error).toBe("no GitHub remote here");
    expect(r.needsAuth).toBeUndefined();
    expect(r.repo).toBeUndefined();
    expect(r.into).toEqual([]);
  });

  test("a directory that is not a repository at all answers the same way", async () => {
    const r = await prsForBranch(join(dir, "nope"), "main");
    expect(r.ok).toBe(false);
    expect(r.needsAuth).toBeUndefined();
  });
});

describe("could not ask is not the same as nothing to say", () => {
  test("gh is not installed", () => {
    const r = ask(REPO, "feat/acme-panel", { PATH: BIN });
    expect(r.ok).toBe(false);
    expect(r.needsAuth).toBe(true);
    expect(r.error).toBe("the gh CLI is not installed");
    expect(r.into).toEqual([]);
    expect(r.from).toBeUndefined();
    // The repository is known even when the question could not be asked — the
    // panel needs it to name what it is failing to speak about.
    expect(r.repo).toBe("acme/orbit");
  }, 30_000);

  test("gh is installed and logged out", () => {
    // `GH_CONFIG_DIR` is an empty directory and no `GH_*`/`GITHUB_*` variable
    // survives `ask()`, so the real `gh` takes its real logged-out exit (4, and
    // no network) — the state a user who has never run `gh auth login` is in.
    const r = ask(REPO, "feat/acme-panel", {});
    expect(r.ok).toBe(false);
    expect(r.needsAuth).toBe(true);
    expect(r.into).toEqual([]);
    expect(r.repo).toBe("acme/orbit");
    expect(r.error).toBe(GH ? "gh is not signed in to GitHub" : "the gh CLI is not installed");
  }, 30_000);

  test("a `gh` that answers with something that is not a list", () => {
    // The timeout kills the process mid-stream and `ghJson` returns null for
    // unparseable output exactly as it does for a non-zero exit. Same answer:
    // an empty list would be a lie either way.
    const r = ask(REPO, "feat/acme-panel", {
      PATH: `${SHIM}:${process.env.PATH ?? ""}`,
      AGX_GH_HEAD: "not json at all", AGX_GH_BASE: "[]",
    });
    expect(r.ok).toBe(false);
    expect(r.needsAuth).toBe(false); // gh is here and can be reached: this is GitHub's fault
    expect(r.error).toBe("GitHub did not answer");
    expect(r.into).toEqual([]);
  }, 30_000);
});

describe("what a found pull request looks like", () => {
  /*
   * The shape is the contract. `PrBranchSummary` is a `Pick<PrSummary, …>` of
   * ten fields and every consumer is typed against it — so a value that does
   * not match its own declared type is a crash waiting at a render, which is
   * how `checks.failure` took the Source control view to a black screen.
   */
  const head = [{
    number: 481,
    title: "Rail layout: one column, two rails",
    author: { login: "acme-bot", id: "U_1" },
    state: "OPEN",
    isDraft: false,
    headRefName: "feat/acme-panel",
    baseRefName: "main",
    url: "https://github.com/acme/orbit/pull/481",
    updatedAt: "2026-08-07T09:12:00Z",
    // What `gh` really sends for a pull request nobody has reviewed. The
    // declared type says `… | null`, and the empty string is neither.
    reviewDecision: "",
  }];
  const base = [
    { number: 12, title: "one", author: { login: "rmoreno" }, state: "OPEN", isDraft: true,
      headRefName: "fix/a", baseRefName: "feat/acme-panel", url: "u1", updatedAt: "t1", reviewDecision: "APPROVED" },
    { number: 13, title: "two", author: null, state: "SOMETHING_NEW", isDraft: false,
      headRefName: "fix/b", baseRefName: "feat/acme-panel", url: "u2", updatedAt: "t2", reviewDecision: null },
  ];

  const answer = (): Answer => ask(REPO, "feat/acme-panel", {
    PATH: `${SHIM}:${process.env.PATH ?? ""}`,
    AGX_GH_HEAD: JSON.stringify(head), AGX_GH_BASE: JSON.stringify(base),
  });

  test("an empty reviewDecision is null, because that is what the type promises", () => {
    const r = answer();
    expect(r.ok).toBe(true);
    expect(r.from?.reviewDecision).toBeNull();
    // Not the empty string, and not undefined: a consumer writing `=== null`
    // or switching over the three names has to be right.
    expect(r.from?.reviewDecision).not.toBe("");
    expect("reviewDecision" in (r.from ?? {})).toBe(true);
    // A real decision is passed through untouched.
    expect(r.into[0]?.reviewDecision).toBe("APPROVED");
    expect(r.into[1]?.reviewDecision).toBeNull();
  }, 30_000);

  test("every field is built, and nothing else comes along", () => {
    const r = answer();
    expect(r.repo).toBe("acme/orbit");
    expect(r.needsAuth).toBeUndefined();
    expect(r.error).toBeUndefined();
    expect(r.from).toEqual({
      number: 481,
      title: "Rail layout: one column, two rails",
      author: "acme-bot",
      state: "OPEN",
      isDraft: false,
      headRefName: "feat/acme-panel",
      baseRefName: "main",
      url: "https://github.com/acme/orbit/pull/481",
      updatedAt: "2026-08-07T09:12:00Z",
      reviewDecision: null,
    });
    // `author.id` did not survive, and neither would `checks`: this lookup buys
    // the cheap field set on purpose and a consumer that finds a rollup on it
    // would be reading something nobody fetched.
    expect(Object.keys(r.from ?? {}).sort()).toEqual([
      "author", "baseRefName", "headRefName", "isDraft", "number",
      "reviewDecision", "state", "title", "updatedAt", "url",
    ]);
    expect("checks" in (r.from ?? {})).toBe(false);
  }, 30_000);

  test("the incoming list keeps its order and its coercions", () => {
    const r = answer();
    expect(r.into.map((p) => p.number)).toEqual([12, 13]);
    expect(r.into[0]?.isDraft).toBe(true);
    // A state nobody has seen before is OPEN rather than a string the union
    // does not contain — and an author that is not an object is not `[object
    // Object]` on screen either.
    expect(r.into[1]?.state).toBe("OPEN");
    expect(r.into[1]?.author).toBe("");
  }, 30_000);

  test("head and base are two separate questions, asked cheaply", () => {
    writeFileSync(GH_LOG, "");
    answer();
    const calls = shimLog().trim().split("\n");
    expect(calls).toHaveLength(2);
    // One argument, not glued to the flag — which is what makes the leading-`-`
    // guard load-bearing rather than decorative.
    expect(calls.some((c) => c.includes("--head feat/acme-panel --state open"))).toBe(true);
    expect(calls.some((c) => c.includes("--base feat/acme-panel --state open"))).toBe(true);
    // One branch has one pull request out of it; a base with twenty incoming is
    // a number, not a list.
    expect(calls.find((c) => c.includes("--head"))).toContain("--limit 5");
    expect(calls.find((c) => c.includes("--base"))).toContain("--limit 20");
    // The expensive field, measured at four times the cost of all the others
    // together, is not among them.
    expect(shimLog()).not.toContain("statusCheckRollup");
  }, 30_000);

  test("a padded name is trimmed, not refused", () => {
    writeFileSync(GH_LOG, "");
    const r = ask(REPO, "  feat/acme-panel  ", {
      PATH: `${SHIM}:${process.env.PATH ?? ""}`,
      AGX_GH_HEAD: JSON.stringify(head), AGX_GH_BASE: "[]",
    });
    expect(r.ok).toBe(true);
    expect(r.from?.number).toBe(481);
    // And what `gh` was handed is the trimmed name — not the padding, which
    // would match no branch on GitHub and read as "no pull request".
    expect(shimLog()).toContain("--head feat/acme-panel --state open");
  }, 30_000);
});
