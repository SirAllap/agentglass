/*
 * A pull request in a repository with no checkout on this machine.
 *
 * The Inbox lists every pull request GitHub says something about, including
 * ones in upstream projects the person only ever opened a pull request against.
 * Reading one goes through a "root" because that is where the repository's
 * identity comes from, and there is no directory to name — so the row answered
 * with a red, cut-off sentence and nothing to press. A checkout-less root is
 * `gh:owner/name`: the identity is in the name itself, reads work from it, and
 * anything that would have to touch a working tree or write refuses in a full
 * sentence that says why.
 */
import { describe, expect, test } from "bun:test";
import { repoIdFor, prWriteRefusal } from "../src/prs.ts";

describe("a root with no checkout behind it", () => {
  test("names the repository without a directory or a remote", async () => {
    const id = await repoIdFor("gh:acme/orbit");
    expect(id).not.toBeNull();
    expect(id!.nameWithOwner).toBe("acme/orbit");
    expect(id!.owner).toBe("acme");
    expect(id!.name).toBe("orbit");
    expect(id!.host).toBe("github.com");
    expect(id!.key).toBe("github.com/acme/orbit");
  });

  test("only a well-formed owner/name is one", async () => {
    for (const bad of ["gh:", "gh:acme", "gh:acme/orbit/extra", "gh:../etc/passwd", "gh:../..", "gh:./.", "gh:acme/..", "gh:a b/c", "/home/x/gh:acme/orbit", ""]) {
      expect(await repoIdFor(bad)).toBeNull();
      expect(prWriteRefusal(bad)).toBeNull();
    }
  });

  test("a write is refused in a sentence that names the repository and the way out", () => {
    const r = prWriteRefusal("gh:acme/orbit");
    expect(r).not.toBeNull();
    expect(r!.ok).toBe(false);
    expect(r!.error).toContain("acme/orbit");
    expect(r!.error).toMatch(/no checkout/i);
    // Not the git-panel sentence, which is about something else entirely.
    expect(r!.error).not.toMatch(/not a git repository/i);
  });

  test("a real path is not a foreign root, and its writes are the guard's business", () => {
    expect(prWriteRefusal("/home/dev/code/orbit")).toBeNull();
  });
});

describe("the routes that fall back to the open project", () => {
  test("a checkout-less root is not sent to the open project's repository", async () => {
    const src = await Bun.file(new URL("../src/index.ts", import.meta.url)).text();
    // The raw fallback, written out, is what answered for the wrong repository.
    expect(src.split("asked && inScopeReal(asked) ? asked :").length - 1).toBe(1); // only inside prRouteRoot
    expect(src.split("prRouteRoot(asked)").length - 1).toBe(6);
    const fn = src.slice(src.indexOf("function prRouteRoot("), src.indexOf("async function openProjectRepos("));
    expect(fn).toContain("isForeignRoot(asked)");
  });
});
