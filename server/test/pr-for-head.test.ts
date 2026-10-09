// The base of a stacked pull request, found by branch name when the board's
// list does not hold it.
//
// `prForHead` is one `gh pr list --head <branch> --state all` per branch,
// remembered and shared, and what it must NEVER do is answer "no pull request"
// for a question it could not ask — a base that is merely unreachable would be
// drawn as a broken stack. So the tests below run the real function against a
// fake `gh` that stands in for the transport and nothing else (arguments, spawn,
// JSON parse and shaping are the server's own), written the way
// pr-branch-lookup.test.ts does it: every `gh` case in a CHILD process, because
// `Bun.which("gh")` resolves against the PATH the process started with.
import { beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const dir = realpathSync(mkdtempSync(join(tmpdir(), "agx-prhead-")));
const PRS_MODULE = fileURLToPath(new URL("../src/prs.ts", import.meta.url));
const SHIM = join(dir, "shim");
const GH_CFG = join(dir, "gh-config-empty");
const DRIVER = join(dir, "ask.mjs");
const hermeticGit = {
  GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@e", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@e",
  GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null",
};
let REPO = "";
let n = 0;

beforeAll(() => {
  REPO = join(dir, "orbit");
  mkdirSync(REPO, { recursive: true });
  for (const a of [["init", "-q", "-b", "main", "."], ["remote", "add", "origin", "https://github.com/acme/orbit.git"]])
    Bun.spawnSync(["git", ...a], { cwd: REPO, env: { ...process.env, ...hermeticGit } });
  REPO = realpathSync(REPO);
  mkdirSync(SHIM, { recursive: true });
  mkdirSync(GH_CFG, { recursive: true });
  writeFileSync(join(SHIM, "gh"), [
    "#!/bin/sh",
    'printf "%s\\n" "$*" >> "$AGX_GH_LOG"',
    'case "$1" in',
    '  auth) echo "Logged in to github.com account tester"; exit 0;;',
    '  pr) if [ -n "$AGX_FAIL_FIRST" ] && [ ! -f "$AGX_GH_LOG.failed" ]; then touch "$AGX_GH_LOG.failed"; exit 1; fi',
    '      if [ -n "$AGX_ALWAYS_FAIL" ]; then exit 1; fi',
    '      cat "$AGX_GH_JSON"; exit 0;;',
    "esac",
    'printf "[]"',
    "",
  ].join("\n"));
  chmodSync(join(SHIM, "gh"), 0o755);
  writeFileSync(DRIVER, [
    "const [mod, root, mode, ...branches] = process.argv.slice(2);",
    "const { prForHead } = await import(mod);",
    "const out = [];",
    'if (mode === "par") out.push(...await Promise.all(branches.map((b) => prForHead(root, b))));',
    'else for (const b of branches) out.push(await prForHead(root, b));',
    'process.stdout.write("RESULT " + JSON.stringify(out) + "\\n");',
    "",
  ].join("\n"));
});

type Row = Record<string, unknown>;
type Answer = { ok: boolean; pr?: Record<string, unknown> | null; needsAuth?: boolean; error?: string };

/** Run the real function in a child whose `gh` is ours; returns what it answered and what `gh` was asked. */
function run(rows: Row[] | null, mode: "seq" | "par", branches: string[], env: Record<string, string> = {}): { out: Answer[]; asked: string[] } {
  const id = ++n;
  const log = join(dir, `gh-${id}.log`);
  const json = join(dir, `rows-${id}.json`);
  writeFileSync(json, JSON.stringify(rows ?? []));
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^(GH|GITHUB)_/.test(k) && v !== undefined) clean[k] = v;
  const r = Bun.spawnSync([process.execPath, DRIVER, PRS_MODULE, REPO, mode, ...branches], {
    env: { ...clean, ...hermeticGit, PATH: `${SHIM}:${process.env.PATH}`, XDG_CONFIG_HOME: dir, AGENTGLASS_DB: join(dir, `c${id}.db`),
      GH_CONFIG_DIR: GH_CFG, AGX_GH_LOG: log, AGX_GH_JSON: json, ...env },
    stdout: "pipe", stderr: "pipe",
  });
  const text = new TextDecoder().decode(r.stdout);
  const line = text.split("\n").find((l) => l.startsWith("RESULT "));
  if (!line) throw new Error(`no answer: ${text}${new TextDecoder().decode(r.stderr)}`);
  let asked: string[] = [];
  try { asked = readFileSync(log, "utf8").split("\n").filter((l) => l.startsWith("pr list")); } catch { /* never spawned */ }
  return { out: JSON.parse(line.slice(7)) as Answer[], asked };
}

const row = (number: number, state: string, o: Row = {}): Row =>
  ({ number, state, isDraft: false, headRefName: "feat/a", baseRefName: "main", isCrossRepository: false, url: `https://github.com/acme/orbit/pull/${number}`, updatedAt: "2026-10-01T00:00:00Z", ...o });

describe("the branch name is an argument", () => {
  test("a name that would read as an option, or has whitespace, is refused and gh is never spawned", () => {
    const { out, asked } = run([row(1, "OPEN")], "seq", ["-x", "--repo", "a b", ""]);
    expect(out.every((o) => o.ok === false && o.error === "no branch")).toBe(true);
    expect(asked).toEqual([]);
  });
  test("it is asked with --head, --state all and a small limit, and nothing else", () => {
    const { asked } = run([row(1, "OPEN")], "seq", ["feat/a"]);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain("--head feat/a");
    expect(asked[0]).toContain("--state all");
    expect(asked[0]).toContain("--limit 5");
  });
});

describe("which pull request answers", () => {
  test("an open one wins over a newer closed one", () => {
    const { out } = run([row(5, "CLOSED", { updatedAt: "2026-10-05T00:00:00Z" }), row(4, "OPEN")], "seq", ["feat/a"]);
    expect(out[0]!.pr?.number).toBe(4);
  });
  test("with none open, the newest wins (a branch name gets reused)", () => {
    const { out } = run([row(2, "MERGED", { updatedAt: "2026-09-01T00:00:00Z" }), row(3, "CLOSED", { updatedAt: "2026-10-02T00:00:00Z" })], "seq", ["feat/a"]);
    expect(out[0]!.pr?.number).toBe(3);
    expect(out[0]!.pr?.state).toBe("CLOSED");
  });
  test("a fork's pull request from a branch of the same name is not the base", () => {
    const { out } = run([row(9, "OPEN", { isCrossRepository: true })], "seq", ["feat/a"]);
    expect(out[0]).toEqual({ ok: true, pr: null });
  });
  test("a row whose head is not the branch asked about is dropped (--head matches loosely on some gh versions)", () => {
    const { out } = run([row(9, "OPEN", { headRefName: "feat/ab" })], "seq", ["feat/a"]);
    expect(out[0]).toEqual({ ok: true, pr: null });
  });
  test("the answer carries only what the board needs, built field by field", () => {
    const { out } = run([row(7, "MERGED", { isDraft: true, baseRefName: "feat/z", secret: "x" })], "seq", ["feat/a"]);
    expect(out[0]!.pr).toEqual({ number: 7, state: "MERGED", isDraft: true, headRefName: "feat/a", baseRefName: "feat/z", url: "https://github.com/acme/orbit/pull/7" });
  });
  test("nobody ever opened one: ok, and null", () => {
    expect(run([], "seq", ["feat/a"]).out[0]).toEqual({ ok: true, pr: null });
  });
});

describe("one request per branch", () => {
  test("asked twice in a row it is asked of GitHub once", () => {
    const { out, asked } = run([row(1, "OPEN")], "seq", ["feat/a", "feat/a"]);
    expect(out.map((o) => o.pr?.number)).toEqual([1, 1]);
    expect(asked).toHaveLength(1);
  });
  test("asked five times at once it is asked of GitHub once", () => {
    const { out, asked } = run([row(1, "OPEN")], "par", Array(5).fill("feat/a"));
    expect(out.map((o) => o.pr?.number)).toEqual([1, 1, 1, 1, 1]);
    expect(asked).toHaveLength(1);
  });
  test("two branches are two requests", () => {
    expect(run([row(1, "OPEN")], "par", ["feat/a", "feat/b"]).asked).toHaveLength(2);
  });
});

describe("a question that could not be asked is not an answer", () => {
  test("gh failing is ok:false, never a null pull request", () => {
    const { out } = run([], "seq", ["feat/a"], { AGX_ALWAYS_FAIL: "1" });
    expect(out[0]!.ok).toBe(false);
    expect(out[0]!.pr).toBeUndefined();
  });
  test("and it is not remembered: the next ask goes to GitHub again and can succeed", () => {
    const { out, asked } = run([row(1, "OPEN")], "seq", ["feat/a", "feat/a"], { AGX_FAIL_FIRST: "1" });
    expect(out[0]!.ok).toBe(false);
    expect(out[1]!.ok).toBe(true);
    expect(out[1]!.pr?.number).toBe(1);
    expect(asked).toHaveLength(2);
  });
});
