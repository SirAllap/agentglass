/*
 * Reading a destination out of somebody else's sentence.
 *
 * Its own file, and no imports: this is a pure function over two strings, the
 * only thing in the notification path that can be wrong in an interesting way,
 * and putting it beside a module that reaches for `location` would make it
 * untestable outside a browser. sysNotify.ts calls it; nothing else needs to.
 */
/**
 * "7937 commits to pull on WEB-1042-Account-Status-Update…"
 *
 * A row like that names a job and gives you nowhere to do it: the repository is
 * the title, the branch is buried at the end of a sentence, and the reader's
 * next move is to go and find both by hand. Both are right there in the text.
 *
 * Deliberately narrow. It matches the shape git tooling actually writes —
 * commits to pull or push, a branch behind or ahead — and declines everything
 * else rather than guessing, because a button that opens the wrong repository
 * is worse than no button. The branch is optional: knowing the repository alone
 * is already enough to be worth a click.
 */
const GIT_JOB = /\b(?:commits?|commit)\s+to\s+(?:pull|push)\b|\bbranch is (?:behind|ahead)\b|\bbehind by\b|\bahead by\b/i;
const ON_BRANCH = /\bon\s+([A-Za-z0-9._\/-]{2,120})/;

export function gitDestination(n: { app?: string; summary?: string; body?: string }): { kind: "git"; repo: string; branch?: string } | null {
  const text = `${n.summary ?? ""} ${n.body ?? ""}`;
  if (!GIT_JOB.test(text)) return null;
  // The title is the checkout it happened in — that is the convention these
  // notifications already follow, and the only candidate in the message.
  const repo = (n.summary ?? "").trim();
  if (!repo || /\s/.test(repo)) return null;
  const branch = ON_BRANCH.exec(n.body ?? "")?.[1]?.replace(/[.,;:]$/, "");
  return { kind: "git", repo, ...(branch ? { branch } : {}) };
}

/**
 * Which repos are worth a "branches behind" bell row here.
 *
 * `/git/repos` with no project open is a whole-machine sweep — every repo this
 * INSTALL has ever seen an agent touch, not the folders this particular window
 * was pointed at. A note about a checkout on the other side of the machine is
 * not a bell row, it is a wrong number: the same fact rendered from a place
 * that has no reason to know it. `roots` is what the person actually added
 * (`configuredRepoDirs()` on the server); a repo is worth a row here only when
 * its own root sits under one of them.
 *
 * Empty `roots` is a machine with no folders configured yet — the picker's own
 * seed has not run, or nobody has added one — and filtering everything out in
 * that state would just make the feature look broken. So it is the one case
 * that keeps today's behaviour: nothing to narrow by, nothing narrowed.
 */
export function notesWorthyRepos<T extends { root: string }>(repos: T[], roots: string[]): T[] {
  if (!roots.length) return repos;
  const under = (repo: string, root: string) => repo === root || repo.startsWith(root.endsWith("/") ? root : `${root}/`);
  return repos.filter((r) => roots.some((root) => under(r.root, root)));
}
