// The pure half of "Add a GitHub repo": what a pasted string means, what the
// answer card says for each lookup, and what a failed refresh may and may not
// do to a stored row.
import { describe, expect, test } from "bun:test";
import {
  REMOTE_MAX, addRemote, canAdd, cardState, forgetRemote, mergeAnswer, parseRepoInput, pickedRoot, rowState, showFirstRunHero, showRemoteShelf, wantedRemoteRoot,
  type LookupAnswer, type RemoteRepo,
} from "../src/lib/remoteRepos";

const FOUND: Extract<LookupAnswer, { found: true }> = { found: true, repo: "Acme/Orbit-API", private: true, description: "secret words", defaultBranch: "main", openPrs: 14 };
const row = (repo: string, extra: Partial<RemoteRepo> = {}): RemoteRepo => ({ repo, addedAt: 1, lastSeen: 1, ...extra });

describe("parseRepoInput", () => {
  test("every accepted shape gives the same repository", () => {
    for (const s of [
      "acme/orbit", " acme/orbit ", "https://github.com/acme/orbit", "http://github.com/acme/orbit/", "https://www.github.com/acme/orbit.git",
      "github.com/acme/orbit", "git@github.com:acme/orbit.git", "ssh://git@github.com/acme/orbit", "https://github.com/acme/orbit/tree/main/src",
      "https://github.com/acme/orbit/issues/9",
    ]) expect(parseRepoInput(s)).toEqual({ kind: "repo", repo: "acme/orbit" });
  });
  test("a pull request link also gives the number", () => {
    expect(parseRepoInput("https://github.com/acme/orbit/pull/322")).toEqual({ kind: "repo", repo: "acme/orbit", pr: 322 });
    expect(parseRepoInput("https://github.com/acme/orbit/pull/322/files?x=1#y")).toEqual({ kind: "repo", repo: "acme/orbit", pr: 322 });
    expect(parseRepoInput("https://github.com/acme/orbit/pull/abc")).toEqual({ kind: "repo", repo: "acme/orbit" });
  });
  test("another host is its own answer", () => {
    for (const s of ["https://gitlab.com/acme/orbit", "git@gitlab.com:acme/orbit.git", "gitlab.com/acme/orbit"]) expect(parseRepoInput(s)).toEqual({ kind: "other-host" });
  });
  test("empty and bad input never become a repository", () => {
    expect(parseRepoInput("   ")).toEqual({ kind: "empty" });
    for (const s of ["acme", "acme/", "/orbit", "-acme/orbit", "acme/..", "acme/or bit", "acme/orbit;ls", "javascript:alert(1)", "https://github.com/acme", "a".repeat(40) + "/x"]) {
      expect(parseRepoInput(s).kind).toBe("invalid");
    }
  });
});

describe("list", () => {
  test("add is case-insensitive, stores the canonical name, and never stores the description", () => {
    const one = addRemote([], FOUND, 5);
    expect(one).toEqual([{ repo: "Acme/Orbit-API", addedAt: 5, lastSeen: 5, openPrs: 14, private: true }]);
    expect(JSON.stringify(one)).not.toContain("secret words");
    expect(addRemote(one, { ...FOUND, repo: "acme/orbit-api" }, 9)).toEqual(one);
  });
  test("a full list refuses and never evicts", () => {
    const full = Array.from({ length: REMOTE_MAX }, (_, i) => row(`acme/r${i}`));
    expect(addRemote(full, FOUND, 9)).toEqual(full);
  });
  test("forget is case-insensitive", () => {
    expect(forgetRemote([row("Acme/Orbit")], "acme/orbit")).toEqual([]);
  });
});

describe("mergeAnswer", () => {
  test("found refreshes the counts and clears every problem flag", () => {
    const r = mergeAnswer(row("Acme/Orbit-API", { openPrs: 2, gone: true, noAccess: true, missedOnce: true }), FOUND, 7);
    expect(r).toEqual({ repo: "Acme/Orbit-API", addedAt: 1, lastSeen: 7, openPrs: 14, private: true });
  });
  test("one not-found is not gone; the second is", () => {
    const first = mergeAnswer(row("acme/orbit", { openPrs: 3 }), { found: false, error: "not-found" }, 7);
    expect(first.gone).toBeUndefined();
    expect(first.openPrs).toBe(3);
    expect(mergeAnswer(first, { found: false, error: "not-found" }, 8).gone).toBe(true);
  });
  test("unreachable changes nothing; no-access keeps the counts", () => {
    const r = row("acme/orbit", { openPrs: 3 });
    expect(mergeAnswer(r, { found: false, error: "unreachable" }, 7)).toEqual(r);
    const na = mergeAnswer(r, { found: false, error: "no-access" }, 7);
    expect(na).toEqual({ ...r, noAccess: true });
    expect(na.gone).toBeUndefined();
  });
  test("a found answer in between resets the not-found streak", () => {
    const a = mergeAnswer(row("acme/orbit"), { found: false, error: "not-found" }, 2);
    const b = mergeAnswer(a, FOUND, 3);
    expect(mergeAnswer(b, { found: false, error: "not-found" }, 4).gone).toBeUndefined();
  });
});

describe("rowState", () => {
  test("gone beats everything, checking beats the rest", () => {
    expect(rowState(row("a/b", { gone: true }), true, true)).toBe("gone");
    expect(rowState(row("a/b", { noAccess: true }), true, false)).toBe("checking");
    expect(rowState(row("a/b", { noAccess: true }), false, true)).toBe("no-access");
    expect(rowState(row("a/b"), false, true)).toBe("unreachable");
    expect(rowState(row("a/b"), false, false)).toBe("ok");
  });
});

describe("cardState", () => {
  const p = parseRepoInput("acme/orbit");
  const done = (answer: LookupAnswer) => ({ phase: "done", answer }) as const;
  test("one state per situation, and only found can be added", () => {
    expect(cardState(parseRepoInput(""), { phase: "idle" }, [])).toBe("empty");
    expect(cardState(parseRepoInput("nonsense"), { phase: "idle" }, [])).toBe("empty");
    expect(cardState(parseRepoInput("https://gitlab.com/a/b"), { phase: "idle" }, [])).toBe("only-github");
    expect(cardState(p, { phase: "checking" }, [])).toBe("checking");
    expect(cardState(p, done(FOUND), [])).toBe("found");
    expect(cardState(p, done({ found: false, error: "not-found" }), [])).toBe("not-found");
    expect(cardState(p, done({ found: false, error: "no-access" }), [])).toBe("no-access");
    expect(cardState(p, done({ found: false, error: "gh-not-signed-in" }), [])).toBe("not-signed-in");
    expect(cardState(p, done({ found: false, error: "gh-missing" }), [])).toBe("gh-missing");
    expect(cardState(p, done({ found: false, error: "unreachable" }), [])).toBe("unreachable");
    expect(cardState(p, done(FOUND), [row("ACME/Orbit")])).toBe("already");
    const full = Array.from({ length: REMOTE_MAX }, (_, i) => row(`acme/r${i}`));
    expect(cardState(p, done(FOUND), full)).toBe("full");
    const states = ["empty", "only-github", "checking", "found", "not-found", "no-access", "not-signed-in", "gh-missing", "unreachable", "already", "full"] as const;
    expect(states.filter((s) => canAdd(s))).toEqual(["found"]);
  });
});

describe("opening a remote with nothing local", () => {
  test("a gh: root is valid with no local project, and has no way back", () => {
    expect(pickedRoot("gh:acme/orbit", null, null)).toEqual({ away: { root: "gh:acme/orbit", repo: "acme/orbit", back: null }, root: "gh:acme/orbit" });
  });
  test("with a local project the way back is that project; a second remote keeps the first one's", () => {
    const local = { root: "/code/orbit", repo: "acme/orbit" };
    const first = pickedRoot("gh:acme/api", null, local);
    expect(first.away?.back).toEqual(local);
    expect(pickedRoot("gh:acme/web", first.away, { root: "gh:acme/api", repo: "acme/api" }).away?.back).toEqual(local);
  });
  test("a local root ends the loan", () => {
    expect(pickedRoot("/code/orbit", { root: "gh:acme/api", repo: "acme/api", back: null }, null)).toEqual({ away: null, root: "/code/orbit" });
  });
  test("the dialog's request names a root without asking what is local", () => {
    expect(wantedRemoteRoot({ repo: "acme/api" })).toBe("gh:acme/api");
    expect(wantedRemoteRoot(null)).toBeNull();
  });
});

describe("the dialog with only remotes", () => {
  test("the first-run hero gives way to a remote; the shelf shows on first run too", () => {
    expect(showFirstRunHero(true, 0)).toBe(true);
    expect(showFirstRunHero(true, 1)).toBe(false);
    expect(showFirstRunHero(false, 0)).toBe(false);
    expect(showRemoteShelf(true, 1)).toBe(true);
    expect(showRemoteShelf(true, 0)).toBe(false);
    expect(showRemoteShelf(false, 3)).toBe(false);
  });
});
