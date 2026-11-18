// The git panel's reads ran `git()`, a blocking spawn with a 15 s limit, on
// the server's only thread: a `log --follow`, a `blame` or a three-dot diff on
// a large repository held every panel and the event stream until git was done.
// A blocking search of the same kind was measured holding the installed app
// for 9.7 s and 19.9 s. These reads now wait for git beside the loop.
import { expect, test } from "bun:test";

const gitwork = await Bun.file(new URL("../src/gitwork.ts", import.meta.url)).text();
const index = await Bun.file(new URL("../src/index.ts", import.meta.url)).text();

const READS = [
  "conflicts", "baseCandidates", "log", "commitDiff", "compareRefs", "refs",
  "blameFile", "fileHistory", "reflog", "stashFiles", "stashList", "listSnapshots",
];

/** The function's own text, comment lines out, up to its own closing brace. */
function bodyOf(name: string): string {
  const at = gitwork.indexOf(`export async function ${name}(`);
  if (at < 0) return "";
  return gitwork.slice(at, gitwork.indexOf("\n}\n", at)).split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
}

test("each read is async and asks git without holding the loop", () => {
  for (const name of READS) {
    const body = bodyOf(name);
    expect(body, name).not.toBe("");
    expect(body, name).toContain("await gitAsync(root, ");
    // No blocking call left: `git(` not preceded by a letter or a dot.
    expect(/(^|[^A-Za-z.])git\(/.test(body), name).toBe(false);
    expect(body, name).not.toContain("spawnSync");
  }
});

test("every route that serves one waits for it", () => {
  const routes: [string, string][] = [
    ['"/git/conflicts"', "await gitConflicts("],
    ['"/git/base-candidates"', "await baseCandidates("],
    ['"/git/log"', "await gitLog("],
    ['"/git/commit-diff"', "await commitDiff("],
    ['"/git/refs"', "await refs("],
    ['"/git/snapshots"', "await listSnapshots("],
    ['"/git/stashes"', "await stashList("],
    ['"/git/blame"', "await blameFile("],
    ['"/git/file-history"', "await fileHistory("],
    ['"/git/stash-files"', "await gitStashFiles("],
    ['"/git/compare"', "await compareRefs("],
  ];
  const lines = index.split("\n");
  for (const [route, call] of routes) {
    const line = lines.find((l) => l.includes(route) && !/^\s*(\/\/|\*)/.test(l)) ?? "";
    expect(line, route).toContain(call);
  }
  // The reflog route reads its root on the line before.
  expect(index).toContain("entries: await gitReflog(root,");
});

// The three verbs that go to the network. Measured on the installed app: a
// `git pull` from the Git panel held the loop 3,220 ms. Their short local reads
// (symbolic-ref, config, remote) may stay blocking; the network call may not.
test("push, pull and fetch send their network call through the async runner", () => {
  const net: Record<string, string> = { push: '"push"', pull: '"pull", "--ff-only"', fetch: "argv" };
  for (const [name, arg] of Object.entries(net)) {
    const body = bodyOf(name);
    expect(body, name).not.toBe("");
    expect(body, name).toContain("runAsync(root, ");
    expect(body, name).not.toMatch(/(^|[^A-Za-z.])run\(root, /);
    expect(body, name).toContain(arg);
  }
  expect(bodyOf("pull")).toContain("withAutoStashAsync(root, ");
  for (const route of ["gitPush", "gitPull", "gitFetch"]) expect(index).toContain(`res = await ${route}(`);
});
