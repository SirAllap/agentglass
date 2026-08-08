/*
 * A fixture repository has to carry its own name and address.
 *
 * The code under test — `mergeSession`, `mergeContinue`, `prepareConflictMerge`
 * — runs `git merge` and `git commit` in the user's own checkout, with the
 * user's own identity. That is correct and not negotiable: a merge commit must
 * be authored by the person who made it, so the server must never pass `-c
 * user.email`. A real checkout has an identity; the production path is entitled
 * to assume one.
 *
 * The fixtures did not. They passed `-c user.email=...` on the git calls the
 * TEST makes and nothing at all on the ones the CODE makes, so the commits
 * under test were signed by whatever `~/.gitconfig` happened to say. On a
 * developer's machine that is always something. On ubuntu-latest it is nothing
 * — measured: the only gitconfig on the runner is `/etc/gitconfig`, carrying
 * `safe.directory` and the LFS filters and no `user.*` at all — so `git commit`
 * exits 128 with "Please tell me who you are" and seven tests failed on
 * `.ok === false`, none of them saying why.
 *
 * The tell was which ones failed. Every assertion that a merge was REFUSED
 * passed; only the ones that needed a commit to succeed went red. A refusal
 * looks identical whether it came from the guard being measured or from git
 * declining to author anything, which is what made this read as a logic bug for
 * as long as it did.
 *
 * So the identity goes in the repository's own config, where a real checkout
 * keeps it, rather than onto the test's command lines where the code under test
 * cannot see it. `commit.gpgsign=false` rides along for the mirror-image
 * reason: a developer with `commit.gpgsign=true` set globally has the fixture
 * reaching for a signing key that is not there, which fails the same commits on
 * the opposite kind of machine.
 */
export function identify(repo: string): void {
  for (const [k, v] of [["user.email", "t@e.st"], ["user.name", "T"], ["commit.gpgsign", "false"]]) {
    const r = Bun.spawnSync(["git", "config", k!, v!], { cwd: repo, stdout: "ignore", stderr: "pipe" });
    // Loud, because the quiet version is exactly the failure above: a fixture
    // that silently has no identity does not look broken, it looks like the
    // feature is broken.
    if (r.exitCode !== 0) {
      throw new Error(`could not set ${k} on the fixture repo ${repo}: ${r.stderr.toString().trim()}`);
    }
  }
}
