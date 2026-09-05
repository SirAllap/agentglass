/*
 * The understudy's fence, read as a list rather than as a rule.
 *
 * This file is a unit test on purpose, and it is the one place in the suite
 * that is allowed to be pedantic about a handful of literal strings. The
 * understudy watches him work and never acts, and "never acts" is not a
 * property you can assert over a route table — every other scope test in this
 * directory derives its expectations from index.ts so it keeps being true as
 * that file grows, which is right for a rule and wrong for a promise. A promise
 * is kept by naming what it covers and failing when the name changes.
 *
 * So: the allowlist is enumerated and compared to a written-out array, and the
 * routes that would turn a watcher into an actor are asserted by name. Adding a
 * route to UNDERSTUDY_POST without touching this file is a failing test, which
 * is the review this feature needs and cannot get any other way.
 */
import { describe, expect, test } from "bun:test";
import {
  UNDERSTUDY_POST,
  UNDERSTUDY_NO_TOKEN_ERROR,
  understudyAllows,
  understudyRequiresToken,
} from "../src/auth.ts";

describe("the allowlist itself", () => {
  test("is exactly these two routes, written out so a third one cannot arrive quietly", () => {
    // Sorted rather than in declaration order: the assertion is about the set,
    // not about which line somebody typed first.
    expect([...UNDERSTUDY_POST].sort()).toEqual(["/understudy/halt", "/understudy/mode"]);
  });

  test("is a positive list — everything it does not name is refused", () => {
    expect(understudyAllows("POST", "/understudy/mode")).toBe(true);
    expect(understudyAllows("POST", "/understudy/halt")).toBe(true);
    // Same prefix, not on the list. A prefix rule here would hand every future
    // /understudy/* route a write grant on the day it is created, and the
    // routes this feature will grow are the ones that make it act.
    expect(understudyAllows("POST", "/understudy/act")).toBe(false);
    expect(understudyAllows("POST", "/understudy")).toBe(false);
  });
});

describe("the two names that must never appear on it", () => {
  test("/chat/send — speaking as him into an agent that is already running", () => {
    expect(UNDERSTUDY_POST.has("/chat/send")).toBe(false);
    expect(understudyAllows("POST", "/chat/send")).toBe(false);
    // And the neighbour that does the same thing one keystroke at a time.
    expect(understudyAllows("POST", "/chat/pane/key")).toBe(false);
  });

  test("/terminal/tmux/windows — reshaping his desk out from under him", () => {
    expect(UNDERSTUDY_POST.has("/terminal/tmux/windows")).toBe(false);
    expect(understudyAllows("POST", "/terminal/tmux/windows")).toBe(false);
  });
});

describe("the acts it is not for", () => {
  test("deciding a gate is a person's job, and the understudy is not a person", () => {
    // The whole v1 claim is "it predicts and compares". A gate decision is the
    // exact act it is scored *against* in class C6, so being able to make one
    // would let the thing being measured write the measurement.
    expect(understudyAllows("POST", "/gate/decide")).toBe(false);
  });

  test("git writes, pull-request writes and card writes are all refused", () => {
    for (const r of [
      "/git/push", "/git/commit", "/git/reset", "/git/discard", "/git/worktree/add",
      "/prs/merge", "/prs/close", "/prs/comment",
      "/clickup/task", "/clickup/comment", "/clickup/status", "/clickup/write",
      "/control", "/chat/attach", "/editor/open", "/docker/rm", "/update/run",
    ]) {
      expect(understudyAllows("POST", r), `${r} is reachable by the understudy`).toBe(false);
    }
  });

  test("a route nobody has written yet is already refused", () => {
    expect(understudyAllows("POST", "/some/route/invented/next/month")).toBe(false);
  });

  test("and so is every verb that is not GET, HEAD or POST", () => {
    // Deny-by-default over methods too. A DELETE added for some tidy-up route
    // would otherwise inherit whatever the POST rule happened to say.
    for (const m of ["DELETE", "PUT", "PATCH", "OPTIONS", "TRACE", "post", "get"]) {
      expect(understudyAllows(m, "/understudy/mode"), m).toBe(false);
      expect(understudyAllows(m, "/sessions"), m).toBe(false);
    }
  });
});

describe("what it may do, because looking is the job", () => {
  test("reads are allowed wholesale", () => {
    for (const r of ["/sessions", "/gate/pending", "/gate/history", "/actions", "/prs", "/health"]) {
      expect(understudyAllows("GET", r), r).toBe(true);
      expect(understudyAllows("HEAD", r), r).toBe(true);
    }
  });

  test("except the GETs that are not reads", () => {
    // /terminal/pty is a WebSocket upgrade wearing a GET, so a rule that
    // trusted the method would hand an interactive shell to the one caller
    // whose entire promise is that it does not act.
    expect(understudyAllows("GET", "/terminal/pty")).toBe(false);
    // And the imported browsing history, which is private data rather than
    // anything the understudy scores.
    expect(understudyAllows("GET", "/browser/places/all")).toBe(false);
  });

  test("and /git/status, which is a read that had to be a POST", () => {
    // Its argument is a filesystem path, which has no business in a URL. This
    // is how the understudy sees which branch a piece of work started on.
    expect(understudyAllows("POST", "/git/status")).toBe(true);
  });
});

describe("the fence is inert without a token", () => {
  /*
   * The property that makes everything above conditional, asserted so it cannot
   * be forgotten: on a zero-config loopback server `resolveToken` hands back a
   * null token, index.ts never identifies anybody, and none of these rules are
   * ever consulted. Enabling the understudy there has to be refused outright —
   * see understudyRequiresToken in auth.ts.
   */
  test("no token means refuse", () => {
    expect(understudyRequiresToken(null)).toBe(true);
    expect(understudyRequiresToken(undefined)).toBe(true);
    expect(understudyRequiresToken("")).toBe(true);
  });

  test("a token means the rules above are actually enforced, so enabling is fine", () => {
    expect(understudyRequiresToken("a-real-machine-token")).toBe(false);
  });

  test("and the refusal says what to do about it", () => {
    // A 409 that does not name the variable sends people to re-pair a phone,
    // which fixes nothing.
    expect(UNDERSTUDY_NO_TOKEN_ERROR).toContain("AGENTGLASS_TOKEN");
  });
});
