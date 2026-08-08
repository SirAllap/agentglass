/*
 * Searching a branch you are not on.
 *
 * The question that asked for this: "which migration numbers already exist on
 * origin/master, so I know mine does not collide". The working tree cannot
 * answer it, and every alternative is worse than reading the object store —
 * fetch and check out loses your place, a second worktree puts a whole checkout
 * on disk for a listing, and the browser is the trip this app exists to avoid.
 *
 * Real repositories with a real remote throughout: whether `ls-tree` sees a
 * branch's files without touching the worktree is not a thing to mock.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { findFiles, grepFiles, fileText, fileToTemp, listRefs, resolveRef } = await import("../src/files.ts");

let box = "", origin = "", clone = "";
let hadRoot: string | undefined;

const run = (cwd: string, ...args: string[]) => Bun.spawnSync(["git", ...args], {
  cwd,
  env: { ...process.env, GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@t.test", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@t.test" },
});
const put = (repo: string, rel: string, body: string) => {
  mkdirSync(join(repo, rel.split("/").slice(0, -1).join("/")), { recursive: true });
  writeFileSync(join(repo, rel), body);
  run(repo, "add", rel);
};

beforeEach(() => {
  box = mkdtempSync(join(tmpdir(), "agx-ref-"));
  hadRoot = process.env.AGENTGLASS_ROOT;
  process.env.AGENTGLASS_ROOT = box;

  const seed = join(box, "seed");
  mkdirSync(seed, { recursive: true });
  run(seed, "init", "-q", "-b", "master");
  // Upstream's migrations — the thing being asked about.
  put(seed, "src/billing/migrations/0095_order_is_gift_wrapped.py", "# 0095\n");
  put(seed, "src/billing/migrations/0096_entry_date.py", "# 0096\nDEPENDS = 'billing/0095'\n");
  run(seed, "commit", "-qm", "upstream migrations");

  origin = join(box, "origin.git");
  clone = join(box, "work");
  run(box, "clone", "-q", "--bare", seed, origin);
  run(box, "clone", "-q", origin, clone);

  // And this checkout's own, which upstream has never seen.
  put(clone, "src/billing/migrations/0097_returnlabelrequest.py", "# 0097 mine\n");
  run(clone, "commit", "-qm", "my migration");
});

afterEach(() => {
  if (hadRoot === undefined) delete process.env.AGENTGLASS_ROOT;
  else process.env.AGENTGLASS_ROOT = hadRoot;
  rmSync(box, { recursive: true, force: true });
});

describe("which files a branch has", () => {
  it("lists the branch's migrations, not this checkout's", () => {
    const r = findFiles(clone, "billing/migrations", 300, "origin/master");
    expect(r.ok).toBe(true);
    const names = r.files.map((f) => f.split("/").pop());
    expect(names).toContain("0095_order_is_gift_wrapped.py");
    expect(names).toContain("0096_entry_date.py");
    /*
     * The whole point, in one assertion: 0097 exists HERE and not upstream, so
     * a search of origin/master must not report it. A search that quietly fell
     * back to the working tree would list it and answer "collision" about a
     * number that is free.
     */
    expect(names).not.toContain("0097_returnlabelrequest.py");
  });

  it("still sees this checkout's own when no ref is asked for", () => {
    const r = findFiles(clone, "billing/migrations");
    expect(r.files.map((f) => f.split("/").pop())).toContain("0097_returnlabelrequest.py");
  });

  it("says which ref answered, so a surprising list can be explained", () => {
    expect(findFiles(clone, "migrations", 300, "origin/master").via).toContain("origin/master");
  });

  it("finds the folders on that branch too", () => {
    expect(findFiles(clone, "migrations", 300, "origin/master").dirs)
      .toContain("src/billing/migrations");
  });

  it("never touches the worktree to answer", () => {
    // `ls-tree` reads the object store. If this ever became a checkout, the
    // file below would vanish and take uncommitted work with it.
    writeFileSync(join(clone, "scratch.txt"), "uncommitted");
    findFiles(clone, "migrations", 300, "origin/master");
    expect(existsSync(join(clone, "scratch.txt"))).toBe(true);
    expect(existsSync(join(clone, "src/billing/migrations/0097_returnlabelrequest.py"))).toBe(true);
  });
});

describe("refusing a ref that is not there", () => {
  it("says so instead of answering with nothing", () => {
    /*
     * The failure mode worth the extra call. "No results" for a mistyped
     * branch reads as "your number is free", which is the exact wrong
     * conclusion to hand somebody checking for a collision.
     */
    const r = findFiles(clone, "migrations", 300, "origin/mister");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("origin/mister");
  });

  it("refuses anything that could be read as an option", () => {
    expect(resolveRef(clone, "--upload-pack=touch /tmp/pwn")).toBeNull();
    expect(resolveRef(clone, "origin/master extra")).toBeNull();
    expect(resolveRef(clone, "")).toBeNull();
  });

  it("accepts a real one", () => {
    expect(resolveRef(clone, "origin/master")).toBe("origin/master");
  });
});

describe("searching a branch's contents", () => {
  it("greps the branch, with the line and the number", () => {
    const r = grepFiles(clone, "0095", 200, "origin/master");
    expect(r.ok).toBe(true);
    expect(r.hits.length).toBeGreaterThan(0);
    const hit = r.hits.find((h) => h.rel.endsWith("0096_entry_date.py"))!;
    expect(hit.line).toBe(2);
    // The ref prefix git puts on every line is stripped, so a hit here and a
    // hit on a branch look the same to whatever renders them.
    expect(hit.rel.startsWith("origin/")).toBe(false);
    expect(hit.rel).toBe("src/billing/migrations/0096_entry_date.py");
  });

  it("does not find this checkout's own text on the branch", () => {
    expect(grepFiles(clone, "0097 mine", 200, "origin/master").hits).toEqual([]);
    expect(grepFiles(clone, "0097 mine", 200).hits.length).toBeGreaterThan(0);
  });
});

describe("opening one of them", () => {
  it("reads the file as that branch has it", () => {
    const r = fileText(clone, "src/billing/migrations/0096_entry_date.py", "origin/master");
    expect(r.ok).toBe(true);
    expect(r.text).toContain("0095");
  });

  it("says so for a file that is only here", () => {
    // Opening it against the branch must not silently show the local copy.
    const r = fileText(clone, "src/billing/migrations/0097_returnlabelrequest.py", "origin/master");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("origin/master");
  });
});

describe("which branches to offer", () => {
  it("lists the remote-tracking branches", () => {
    const r = listRefs(clone);
    expect(r.ok).toBe(true);
    expect(r.remote).toContain("origin/master");
  });

  it("lists the LOCAL ones too", () => {
    /*
     * Asked for explicitly: "I need to be able to pick the local branch from
     * there". A branch sitting in this repository that this worktree is not on
     * could only be looked at by checking it out — moving you off your work —
     * or by cutting yet another worktree for a listing.
     */
    run(clone, "branch", "spike/no-checkout");
    const r = listRefs(clone);
    expect(r.local).toContain("spike/no-checkout");
    expect(r.local).toContain("master");
  });

  it("says which branch this worktree is already on", () => {
    // So the list can mark it rather than offer it as somewhere else to go.
    expect(listRefs(clone).head).toBe("master");
  });

  it("drops origin/HEAD, which is an alias for one already listed", () => {
    expect(listRefs(clone).remote.some((x) => x.endsWith("/HEAD"))).toBe(false);
  });

  it("puts the default branch first, because it is the one being asked about", () => {
    run(clone, "push", "-q", "origin", "master:zzz-topic");
    run(clone, "fetch", "-q", "origin");
    expect(listRefs(clone).remote[0]).toBe("origin/master");
  });

  it("offering a branch never moves this worktree", () => {
    // The promise the control makes. Reading refs and then searching one must
    // leave HEAD and the working tree exactly where they were.
    const before = Bun.spawnSync(["git", "-C", clone, "rev-parse", "HEAD"]).stdout.toString();
    listRefs(clone);
    findFiles(clone, "migrations", 300, "origin/master");
    const after = Bun.spawnSync(["git", "-C", clone, "rev-parse", "HEAD"]).stdout.toString();
    expect(after).toBe(before);
    expect(existsSync(join(clone, "src/billing/migrations/0097_returnlabelrequest.py"))).toBe(true);
  });
});

/*
 * Writing a branch's copy out so an editor can open it.
 *
 * Why this is not "the viewer already has the text": only markdown is worth
 * rendering, and everything else in a checkout is code, which belongs in the
 * editor that knows its language. The palette used to send a `.py` found on
 * another branch to the document viewer instead, which renders MARKDOWN — so it
 * arrived with its lines collapsed into paragraphs, its `**` bold and its
 * backticks as chips.
 *
 * An editor needs a path, and this file has none here. That is the whole reason
 * for a temp file, and the assertion below is the reason it cannot be the
 * working tree's path.
 */
describe("a branch's copy, on disk for the editor", () => {
  it("writes the branch's content, not this checkout's", () => {
    const rel = "src/billing/migrations/0096_entry_date.py";
    // The same path, different on each side — which is the case that makes
    // opening the working tree's copy wrong rather than merely stale.
    put(clone, rel, "# 0096\nDEPENDS = 'billing/0095'\nLOCAL_EDIT = True\n");
    run(clone, "commit", "-qm", "local edit");

    const r = fileToTemp(clone, rel, "origin/master");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const wrote = readFileSync(r.file, "utf8");
    expect(wrote).toContain("DEPENDS");
    expect(wrote).not.toContain("LOCAL_EDIT");
    // And the disk really does say something else, so the assertion above is
    // about the ref rather than about a file that happened to match.
    expect(readFileSync(join(clone, rel), "utf8")).toContain("LOCAL_EDIT");
  });

  it("writes outside the checkout", () => {
    const r = fileToTemp(clone, "src/billing/migrations/0095_order_is_gift_wrapped.py", "origin/master");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // A temp file inside the checkout turns up in somebody's `git status` an
    // hour later wearing a name that looks like theirs.
    expect(r.file.startsWith(clone)).toBe(false);
    expect(existsSync(r.file)).toBe(true);
  });

  it("names the file after the ref, so two of them are telling apart", () => {
    const rel = "src/billing/migrations/0095_order_is_gift_wrapped.py";
    const a = fileToTemp(clone, rel, "origin/master");
    const b = fileToTemp(clone, rel, "master");
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    // The same basename twice says nothing in an editor's tab strip, and the
    // same path on two branches is exactly what somebody is comparing.
    expect(a.file.split("/").pop()).not.toBe(b.file.split("/").pop());
    expect(a.file.split("/").pop()).toContain("origin-master");
  });

  it("refuses a path that branch does not have, rather than writing an empty file", () => {
    // 0097 exists HERE and not upstream. An empty temp file would open in the
    // editor as a real, blank version of a file that does not exist.
    const r = fileToTemp(clone, "src/billing/migrations/0097_returnlabelrequest.py", "origin/master");
    expect(r.ok).toBe(false);
  });

  it("refuses a ref that does not exist, and one that was not given", () => {
    expect(fileToTemp(clone, "src/billing/migrations/0095_order_is_gift_wrapped.py", "no/such/branch").ok).toBe(false);
    expect(fileToTemp(clone, "src/billing/migrations/0095_order_is_gift_wrapped.py", "").ok).toBe(false);
  });

  it("is contained by the same rules as every other reader here", () => {
    // `inside()` is fileText's, and this borrows it rather than growing a second
    // set of rules to keep in step.
    expect(fileToTemp(clone, "../../etc/passwd", "origin/master").ok).toBe(false);
  });
});
