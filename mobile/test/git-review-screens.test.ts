/*
 * The rules of the Git screens that live in source, because nothing here can
 * mount a screen: a Log row opens its commit, every tab can be pulled, a switch
 * with work in the tree asks first, and nothing on the way writes.
 */
import { expect, test } from "bun:test";

const read = (p: string): Promise<string> => Bun.file(new URL(p, import.meta.url)).text();
const repos = await read("../app/(tabs)/repos.tsx");
const commitScreen = await read("../app/git-commit.tsx");
const diffScreen = await read("../app/git-diff.tsx");

/** The body of one `view === "x" ? (` block, up to the next one. */
function tab(view: string): string {
  const at = repos.indexOf(`view === "${view}" ? (`);
  expect(at).toBeGreaterThan(0);
  const next = repos.indexOf("view === \"", at + 10);
  return repos.slice(at, next < 0 ? undefined : next);
}

test("a Log row opens the commit it names, carrying what the screen can show at once", () => {
  const log = tab("log");
  expect(log).toContain('pathname: "/git-commit"');
  expect(log).toContain("hash: c.hash");
  expect(log).toContain("subject: c.subject");
});

test("all five tabs can be pulled to refresh, each through the one helper", () => {
  for (const view of ["changes", "log", "branches", "stash", "pr"]) {
    const src = view === "changes" ? repos.slice(0, repos.indexOf('view === "log" ? (')) : tab(view);
    expect(src, view).toContain("refreshControl={pullWith(");
  }
  // And none of them builds its own, which is how a sixth goes without a hint.
  expect(repos.match(/<RefreshControl\s/g)?.length).toBe(1);
});

test("every tab says it can be pulled", () => {
  expect(repos.match(/<PullHint/g)?.length).toBeGreaterThanOrEqual(5);
  expect(repos).toContain("Pull down to refresh");
});

test("the branch on the header is read from git, on focus, not from the repository list", () => {
  expect(repos).toContain("status?.branch ?? repo?.branch");
  expect(repos).toContain("useFocusEffect(");
  expect(repos).not.toContain("{repo.branch}");
});

test("Push is decided by the branch's upstream and the log, not by the repository list's ahead", () => {
  expect(repos).toContain("disabled={!push.canPush}");
  expect(repos).not.toContain("repo?.ahead");
  expect(repos).not.toContain("repo.ahead");
});

test("a branch switch with changes in the tree goes through a confirm sheet", () => {
  const press = repos.slice(repos.indexOf("switchWarning(dirtyCount, b.name)"));
  // The question comes before the checkout call in the row's handler.
  expect(press.indexOf("setSwitching(b.name)")).toBeLessThan(press.indexOf('"/git/checkout"'));
  expect(repos).toContain("Switch anyway");
});

test("staging does not clear the log Push is counted from", () => {
  const act = repos.slice(repos.indexOf("const act = useCallback("), repos.indexOf("const files = useMemo("));
  const stage = act.indexOf('path === "/git/stage"');
  expect(stage).toBeGreaterThan(0);
  expect(stage).toBeLessThan(act.indexOf("setCommits(null)"));
});

test("the commit and diff screens only read, and say where the ticks live", () => {
  for (const src of [commitScreen, diffScreen]) {
    expect(src).not.toContain('method: "POST"');
    expect(src).not.toContain("/git/stage");
  }
  expect(commitScreen).toContain("/git/commit-diff?root=");
  expect(commitScreen).toContain("stay on this phone");
  expect(diffScreen).toContain("/git/commit-diff?");
  expect(diffScreen).toContain("marks stay on this phone");
});

test("the diff walks files by changing its own path, so the back button still goes to the list", () => {
  expect(diffScreen).toContain("router.setParams({ path: to })");
  expect(diffScreen).not.toContain("router.replace");
});

test("Wrap is a control in the header and its off state scrolls sideways", () => {
  expect(diffScreen).toContain("setWrap((w) => !w)");
  expect(diffScreen).toContain("<ScrollView horizontal");
});

test("Push is reachable once every file is committed", () => {
  // `files` is empty on a clean tree, and the composer used to need it: a
  // never-pushed branch with nothing left to commit had a chip and no button.
  const at = repos.indexOf('view === "changes" && (files.length > 0 || push.canPush)');
  expect(at).toBeGreaterThan(0);
  const composer = repos.slice(at, repos.indexOf("Why a button is dim", at));
  expect(composer).toContain("onPress={() => { void act(\"push\"");
  // The commit half stays behind a dirty tree; Push is not nested in it.
  expect(composer).toContain("{files.length > 0 ? (");
  const commitHalf = composer.slice(composer.indexOf("{files.length > 0 ? ("), composer.indexOf("label={push.label}"));
  expect(commitHalf).not.toContain("label={push.label}");
});

test("a branch switch asks when the status has not been read", () => {
  expect(repos).toContain("const dirtyCount = status ? files.length : null;");
  expect(repos).not.toContain("switchWarning(files.length");
});

test("an expander's answer after Next file is dropped, and it is a full thumb tall", () => {
  const expand = diffScreen.slice(diffScreen.indexOf("const expand = useCallback("));
  const after = expand.indexOf("await ask");
  expect(after).toBeGreaterThan(0);
  expect(expand.indexOf("onScreen.current !== mine")).toBeGreaterThan(after);
  expect(expand.indexOf("onScreen.current !== mine")).toBeLessThan(expand.indexOf("text.current = {"));
  expect(diffScreen).toContain("onScreen.current = `${hash ?? \"\"}|${path}`;");
});
