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
