// The conflict screen's reads (which two sides, which files, one file's
// blocks) ran blocking git spawns on the server's only thread: up to eight
// for the sides alone. A blocking spawn of the same kind was measured holding
// the installed app for 9.7 s and 19.9 s. The read routes now call awaited
// twins; the write paths keep the blocking ones. What is pinned here is that
// a twin answers exactly what the original does, in every stopped state.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  conflictBlocks, conflictBlocksAsync, conflictFile, conflictFileAsync,
  mergeInfo, mergeInfoAsync, mergeSession, mergeSessionAsync,
} from "../src/gitwork.ts";
import { __setSessionPath } from "../src/mergesession.ts";
import { identify } from "./gitIdentity.ts";

const gitwork = await Bun.file(new URL("../src/gitwork.ts", import.meta.url)).text();
const index = await Bun.file(new URL("../src/index.ts", import.meta.url)).text();

const dir = realpathSync(mkdtempSync(join(tmpdir(), "agx-merge-async-")));
const rootBefore = process.env.AGENTGLASS_ROOT;
const merging = join(dir, "merging");
const rebasing = join(dir, "rebasing");
const plain = join(dir, "plain");
const notRepo = join(dir, "not-a-repo");

const git = (cwd: string, ...args: string[]) =>
  Bun.spawnSync(["git", "-c", "user.email=t@e.st", "-c", "user.name=T", "-c", "commit.gpgsign=false", ...args], { cwd, stdout: "pipe", stderr: "pipe" });

/** main and feat both changed a.txt; `stop` is what leaves the repository mid-operation. */
function build(repo: string, stop: "merge" | "rebase" | "none"): void {
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main", ".");
  identify(repo);
  writeFileSync(join(repo, "a.txt"), "top\nbase\nbottom\n");
  git(repo, "add", "-A"); git(repo, "commit", "-qm", "seed");
  git(repo, "checkout", "-q", "-b", "feat");
  writeFileSync(join(repo, "a.txt"), "top\ntheirs\nbottom\n");
  git(repo, "add", "-A"); git(repo, "commit", "-qm", "feat side");
  git(repo, "checkout", "-q", "main");
  writeFileSync(join(repo, "a.txt"), "top\nours\nbottom\n");
  git(repo, "add", "-A"); git(repo, "commit", "-qm", "main side");
  if (stop === "merge") git(repo, "merge", "feat");
  if (stop === "rebase") { git(repo, "checkout", "-q", "feat"); git(repo, "rebase", "main"); }
}

beforeAll(() => {
  process.env.AGENTGLASS_ROOT = dir;
  __setSessionPath(join(dir, "session.json"));
  build(merging, "merge");
  build(rebasing, "rebase");
  build(plain, "none");
  mkdirSync(notRepo, { recursive: true });
}, 30_000);

afterAll(() => {
  __setSessionPath(null);
  if (rootBefore === undefined) delete process.env.AGENTGLASS_ROOT; else process.env.AGENTGLASS_ROOT = rootBefore;
  rmSync(dir, { recursive: true, force: true });
});

test("the two sides are the same whichever way they are asked for", async () => {
  const m = await mergeInfo(merging);
  expect(m.state).toBe("merging");
  expect(m.ours?.ref).toBe("main");
  expect(m.theirs?.ref).toBe("feat");
  expect(await mergeInfoAsync(merging)).toEqual(m);

  // A rebase inverts the sides and counts its steps: the case most worth agreeing on.
  const r = await mergeInfo(rebasing);
  expect(r.state).toBe("rebasing");
  expect(r.ours?.ref).toBe("main");
  expect(r.step).toBe(1);
  expect(await mergeInfoAsync(rebasing)).toEqual(r);

  const c = await mergeInfo(plain);
  expect(c).toEqual({ ok: true, state: "clean", ours: null, theirs: null });
  expect(await mergeInfoAsync(plain)).toEqual(c);
});

test("the session and the file's conflicts are the same too", async () => {
  // The blocking one first: it makes the observation, and the twin must read the same record.
  const s = await mergeSession(merging);
  expect(s.files).toEqual(["a.txt"]);
  // The async one is what the route answers, and it also counts the conflict places per file (ConflictMode reads them); the rest is the same.
  const { places, ...a } = await mergeSessionAsync(merging);
  expect(places).toEqual({ "a.txt": 1 });
  expect(a).toEqual(s);
  expect(await mergeSessionAsync(plain)).toEqual(await mergeSession(plain));

  const b = await conflictBlocks(merging, "a.txt");
  expect(b.blocks.length).toBe(1);
  expect(await conflictBlocksAsync(merging, "a.txt")).toEqual(b);
  expect(await conflictFileAsync(merging, "a.txt")).toEqual(await conflictFile(merging, "a.txt"));
  expect((await conflictBlocksAsync(merging, "../../etc/passwd")).ok).toBe(false);
});

test("somewhere that is not a repository gets the same refusal", async () => {
  expect(await mergeInfoAsync(notRepo)).toEqual(await mergeInfo(notRepo));
  expect(await mergeSessionAsync(notRepo)).toEqual(await mergeSession(notRepo));
  expect(await conflictBlocksAsync(notRepo, "a.txt")).toEqual(await conflictBlocks(notRepo, "a.txt"));
  expect(await conflictFileAsync(notRepo, "a.txt")).toEqual(await conflictFile(notRepo, "a.txt"));
});

test("a timer ticks while the sides are read", async () => {
  let ticks = 0;
  const timer = setInterval(() => { ticks++; }, 1);
  await mergeInfoAsync(merging);
  clearInterval(timer);
  expect(ticks).toBeGreaterThan(0);
});

/** A function's own text, comment lines out, up to its own closing brace. */
function bodyOf(head: string): string {
  const at = gitwork.indexOf(head);
  if (at < 0) return "";
  return gitwork.slice(at, gitwork.indexOf("\n}\n", at)).split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
}

test("no twin, and nothing a twin calls for git, makes a blocking call", () => {
  const heads = [
    "export async function mergeInfoAsync(", "export async function mergeSessionAsync(",
    "export async function conflictBlocksAsync(", "export async function conflictFileAsync(",
    "async function refAtAsync(", "async function subjectOfAsync(", "async function sideOfAsync(",
  ];
  for (const head of heads) {
    const body = bodyOf(head);
    expect(body, head).not.toBe("");
    // `git(` not preceded by a letter or a dot is the blocking one; so is the cached blocking root.
    expect(/(^|[^A-Za-z.])git\(/.test(body), head).toBe(false);
    expect(/(^|[^A-Za-z.])repoRoot\(/.test(body), head).toBe(false);
    expect(body, head).not.toContain("spawnSync");
  }
  expect(bodyOf("export async function mergeInfoAsync(")).toContain("await sideOfAsync(root, ");
  expect(bodyOf("export async function mergeSessionAsync(")).toContain("await mergeInfoAsync(root)");
});

test("the four read routes wait for the twins", () => {
  const routes: [string, string][] = [
    ['"/git/merge-info"', "await mergeInfoAsync("],
    ['"/git/merge-session"', "await mergeSessionAsync("],
    ['"/git/conflict-blocks"', "await conflictBlocksAsync("],
    ['"/git/conflict-file"', "await conflictFileAsync("],
  ];
  const lines = index.split("\n");
  for (const [route, call] of routes) {
    // The route's own answer line: the held-back check above it names the route too.
    const line = lines.find((l) => l.includes(`pathname === ${route}) return`) && !/^\s*(\/\/|\*)/.test(l)) ?? "";
    expect(line, route).toContain(call);
  }
});
