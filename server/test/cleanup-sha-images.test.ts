// Images a repository tags with a commit's short sha go with the merged PR that built them, on real git in a temp
// directory with a fake docker. Commits a1..d4 are the branch's; c3 is another checkout's HEAD, d4 the main checkout's.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { parseCleanupConfig, planCleanup } from "../src/cleanup.ts";
import { PR, makeWorld, type World } from "./cleanupFixture.ts";

let w: World;
let a1 = "", b2 = "", c3 = "", d4 = "";
const commit = (name: string) => {
  const f = join(w.wt, `${name}.txt`);
  Bun.write(f, name);
  w.git(w.wt, "add", `${name}.txt`); w.git(w.wt, "commit", "-q", "-m", name);
  return w.git(w.wt, "rev-parse", "HEAD");
};
beforeEach(async () => {
  w = makeWorld();
  a1 = w.git(w.wt, "rev-parse", "HEAD");
  await Bun.sleep(5);
  b2 = commit("b2"); c3 = commit("c3"); d4 = commit("d4");
  w.git(w.main, "checkout", "-q", "--detach", d4);                  // the main checkout is on d4
  w.git(w.main, "worktree", "add", "-q", "--detach", join(w.root, "other"), c3); // another live checkout is on c3
  w.pr.headRefOid = d4;
});
afterEach(() => w?.cleanup());

const img = (sha: string, id: string, repo = "app") => ({ repo, tag: sha, id, size: "1GB" });
const cfg = (template = "app:{sha}") => w.cfg({ dockerImageTagTemplate: template });
const targets = async (c = cfg()) => (await planCleanup(w.main, PR, c, w.ctx())).items.filter((i) => i.kind === "docker-image").map((i) => i.target);

describe("a template with {sha}", () => {
  test("the PR's own commit is removed; one a container uses, one a live checkout is on and one the main checkout is on are kept", async () => {
    w.images = [img(a1.slice(0, 11), "i1"), img(b2.slice(0, 7), "i2"), img(c3.slice(0, 7), "i3"), img(d4.slice(0, 7), "i4"), img(d4.slice(0, 11), "i5")];
    w.containers = [{ name: "stopped-one", state: "exited", image: `app:${b2.slice(0, 7)}` }];
    const plan = await planCleanup(w.main, PR, cfg(), w.ctx());
    expect(plan.items.filter((i) => i.kind === "docker-image").map((i) => i.target)).toEqual([`app:${a1.slice(0, 11)}`]);
    const notes = plan.notes.join("\n");
    expect(notes).toContain(`kept image app:${b2.slice(0, 7)}: a container still uses it`);
    expect(notes).toContain(`kept image app:${c3.slice(0, 7)}: built at the HEAD of a live checkout`);
    expect(notes).toContain(`kept image app:${d4.slice(0, 7)}: built at the HEAD of a live checkout`);
    expect(notes).toContain(`kept image app:${d4.slice(0, 11)}: built at the HEAD of a live checkout`);
  });

  test("an old commit of the PR is a candidate by its 7-char tag too, and the base's own commit never is", async () => {
    const base = w.git(w.main, "rev-parse", "origin/main");
    w.images = [img(a1.slice(0, 7), "i1"), img(base.slice(0, 7), "i0")];
    expect(await targets()).toEqual([`app:${a1.slice(0, 7)}`]);
  });

  test("a slug in the template must be this PR's slug", async () => {
    w.images = [img(`orbit-1042-${a1.slice(0, 7)}`, "i1"), img(`orbit-9999-${a1.slice(0, 7)}`, "i2"), img(a1.slice(0, 7), "i3")];
    expect(await targets(cfg("app:{slug}-{sha}"))).toEqual([`app:orbit-1042-${a1.slice(0, 7)}`]);
  });

  test("a base branch that is not fetched leaves the images and says so", async () => {
    w.images = [img(a1.slice(0, 7), "i1")];
    w.pr.baseRefName = "release-9";
    const plan = await planCleanup(w.main, PR, cfg(), w.ctx());
    expect(plan.items.filter((i) => i.kind === "docker-image")).toEqual([]);
    expect(plan.notes).toContain("sha-tagged images left: base branch release-9 not fetched");
  });

  test("a docker that cannot list images says so instead of looking like nothing to remove", async () => {
    const base = w.ctx();
    const ctx = w.ctx({ run: async (cmd, args, o) => (cmd === "docker" && args[0] === "images" ? { code: 1, stdout: "", stderr: "Cannot connect to the Docker daemon\nmore" } : base.run(cmd, args, o)) });
    const plan = await planCleanup(w.main, PR, cfg(), ctx);
    expect(plan.items.filter((i) => i.kind === "docker-image")).toEqual([]);
    expect(plan.notes).toContain("could not list sha-tagged images: Cannot connect to the Docker daemon");
  });

  test("the contains-slug match does not apply: a tag holding the slug but no PR commit is left alone", async () => {
    w.images = [img("orbit-1042", "i1")];
    expect(await targets()).toEqual([]);
  });
});

describe("the template setting", () => {
  test("needs {slug} or {sha}, each at most once", () => {
    expect(parseCleanupConfig({ dockerImageTagTemplate: "app:latest" })).toEqual({ error: "dockerImageTagTemplate: must contain {slug} or {sha}" });
    expect(parseCleanupConfig({ dockerImageTagTemplate: "app:{sha}-{sha}" })).toHaveProperty("error");
    expect(parseCleanupConfig({ dockerImageTagTemplate: "app:{slug}-{sha}" })).toHaveProperty("value");
    expect(parseCleanupConfig({ dockerImageTagTemplate: "app:{sha}" })).toHaveProperty("value");
    expect(parseCleanupConfig({ dockerImageTagTemplate: "app:{slug}" })).toHaveProperty("value");
  });
  test("the sweep's own lists are validated, and the auto switch is not part of the body", () => {
    expect(parseCleanupConfig({ orphanVolumePatterns: ["app-cache-{slug}"], orphanKeep: ["psql-*"] })).toHaveProperty("value");
    expect(parseCleanupConfig({ orphanVolumePatterns: ["app-cache"] })).toHaveProperty("error");
    expect(parseCleanupConfig({ orphanAutoRemove: true })).toHaveProperty("error");
  });
});
