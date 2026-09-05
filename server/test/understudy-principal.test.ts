/*
 * "It is not a scope, it is a principal" — the claim, tested from both sides.
 *
 * Two things have to be true at once, and the second is the one that gets lost.
 * The understudy must be fenced no matter what credential it happens to be
 * holding; and adding it must not have moved anything for anybody else. A
 * narrowing that quietly widened the paired phone would be a strictly worse
 * server than the one before this feature existed, and that regression is
 * invisible from inside the understudy's own tests.
 *
 * Callers here are minted through `issueDevice` + `callerFor` rather than
 * written as object literals, because the interesting case is a *real*
 * credential — a `full`-scope device, the widest thing this server can hand
 * out — carrying the understudy principal. If the principal wins over that, no
 * future widening of a scope can reach it.
 *
 * Why this is not a spawned server the way gate-actor-route.test.ts is: that
 * suite tests plumbing, and plumbing has to be walked end to end. Here there is
 * no plumbing to walk yet — v1 mints no understudy credential, so no request
 * can arrive as one, and a live server could only re-assert the device half
 * that device-scope.test.ts already covers. The fence goes up before the thing
 * it fences arrives; that is the only order that works.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { allowed, answersFromADevice, callerFor, scopeNeeded, type Caller } from "../src/auth.ts";
import { issueDevice, __resetDevices, type Scope } from "../src/devices.ts";

const MACHINE = "machine-token-for-this-test";

beforeEach(() => {
  process.env.NODE_ENV = "test";
  // Never the developer's real devices file. See offLimits in devices.ts.
  process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "agx-understudy-"));
  __resetDevices();
});

/** A caller holding a genuine device credential of the given scope. */
function device(scope: Scope): Caller {
  const { token } = issueDevice("Pixel 9", scope);
  const url = new URL("http://x/anything");
  const req = new Request(url.href, { headers: { authorization: `Bearer ${token}` } });
  return callerFor(req, url, MACHINE)!;
}

/** The same credential, wearing the principal. `full` is deliberate: it is the
 *  widest scope this server can mint, so anything refused below is refused
 *  because of the principal and for no other reason. */
const understudy = (scope: Scope = "full"): Caller => ({ ...device(scope), principal: "understudy" });

describe("the understudy, holding the widest credential there is", () => {
  test("cannot speak as him into a running agent", () => {
    const u = understudy();
    expect(allowed(u, "POST", "/chat/send")).toBe(false);
    expect(allowed(u, "POST", "/chat/pane/key")).toBe(false);
    expect(allowed(u, "POST", "/chat/attach")).toBe(false);
    // …and the scope it is carrying would have said yes to every one of them,
    // which is the whole point of the principal being checked first.
    expect(u.scope).toBe("full");
    expect(scopeNeeded("POST", "/chat/send")).toBe("answer");
  });

  test("cannot reshape his desk", () => {
    expect(allowed(understudy(), "POST", "/terminal/tmux/windows")).toBe(false);
    expect(allowed(understudy(), "GET", "/terminal/pty")).toBe(false);
  });

  test("cannot decide the thing it is being scored on", () => {
    expect(allowed(understudy(), "POST", "/gate/decide")).toBe(false);
  });

  test("cannot write to the repository, the pull request or the card", () => {
    const u = understudy();
    for (const r of ["/git/push", "/git/commit", "/git/reset", "/prs/merge", "/clickup/task", "/control"]) {
      expect(allowed(u, "POST", r), r).toBe(false);
    }
  });

  test("and cannot release a hold through the other door either", () => {
    // mayReleaseAHold in index.ts asks answersFromADevice directly, so the
    // refusal has to be there as well as in `allowed`. An answer-scoped
    // credential is the shape that would otherwise sail through.
    expect(answersFromADevice(understudy("answer"))).toBe(false);
    expect(answersFromADevice(understudy("full"))).toBe(false);
  });
});

describe("what it may do, because watching is the job", () => {
  test("reads everything a read-scope device reads", () => {
    const u = understudy();
    for (const r of ["/sessions", "/gate/pending", "/gate/history", "/actions", "/prs"]) {
      expect(allowed(u, "GET", r), r).toBe(true);
    }
  });

  test("and /git/status, which is how it sees where work started", () => {
    expect(allowed(understudy(), "POST", "/git/status")).toBe(true);
  });

  test("and its own two switches, both of which only make it do less", () => {
    expect(allowed(understudy(), "POST", "/understudy/mode")).toBe(true);
    expect(allowed(understudy(), "POST", "/understudy/halt")).toBe(true);
  });
});

describe("and nobody else moved", () => {
  test("a paired answering phone still answers gates", () => {
    // The regression that would be invisible from inside the understudy's own
    // tests: the principal must narrow one caller and touch no other.
    const phone = device("answer");
    expect(phone.principal).toBeUndefined();
    expect(allowed(phone, "POST", "/gate/decide")).toBe(true);
    expect(allowed(phone, "POST", "/chat/send")).toBe(true);
    expect(answersFromADevice(phone)).toBe(true);
    // …and is still stopped everywhere it was stopped before.
    expect(allowed(phone, "POST", "/git/push")).toBe(false);
    expect(allowed(phone, "GET", "/terminal/pty")).toBe(false);
  });

  test("a look-only phone still only looks", () => {
    const phone = device("read");
    expect(allowed(phone, "GET", "/sessions")).toBe(true);
    expect(allowed(phone, "POST", "/git/status")).toBe(true);
    expect(allowed(phone, "POST", "/gate/decide")).toBe(false);
  });

  test("a full device is still the machine", () => {
    const desk = device("full");
    for (const r of ["/prs/merge", "/git/reset", "/control"]) expect(allowed(desk, "POST", r), r).toBe(true);
    expect(allowed(desk, "GET", "/terminal/pty")).toBe(true);
  });

  test("and the machine's own token is untouched", () => {
    const url = new URL("http://x/anything");
    const req = new Request(url.href, { headers: { authorization: `Bearer ${MACHINE}` } });
    const machine = callerFor(req, url, MACHINE)!;
    expect(machine).toEqual({ kind: "machine", scope: "full" });
    expect(machine.principal).toBeUndefined();
    expect(allowed(machine, "POST", "/chat/send")).toBe(true);
    expect(answersFromADevice(machine)).toBe(false); // still not a device; unchanged
  });
});
