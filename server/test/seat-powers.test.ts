/*
 * WHAT THE SEAT MAY DO IS A CREDENTIAL, NOT A SENTENCE.
 *
 * The seat's prompt tells it what it may do, and a prompt is a wish. These are
 * the tests for the wall: a chair set to `speak` holds a token that cannot
 * prompt an agent, and one set to `nudge` holds one that cannot start or stop
 * one, whatever either of them has been told.
 *
 * The failure this guards against is specific and has happened in this
 * repository before, to the clone: an agent the server starts inherits the
 * environment, the machine token is in it, and the thing being fenced ends up
 * holding the key to the fence.
 */
import { describe, expect, test } from "bun:test";
import { seatAllows, mintSeatToken, revokeSeatTokens, seatTokenCount, callerFor, allowed } from "../src/auth.ts";

const ROOT = "/home/a/code/orbit";
const req = (method: string) => new Request("http://x/", { method });
const withToken = (t: string) => ({ req: new Request("http://x/", { headers: { Authorization: `Bearer ${t}` } }), url: new URL("http://x/") });

describe("a chair set to speak", () => {
  test("reads everything a view reads", () => {
    expect(seatAllows("speak", "GET", "/agents/board")).toBe(true);
    expect(seatAllows("speak", "GET", "/lantern/settings")).toBe(true);
  });

  test("cannot prompt, start or stop an agent", () => {
    for (const p of ["/agents/named/prompt", "/agents/named/start", "/agents/named/stop", "/agents/named/keys"]) {
      expect(seatAllows("speak", "POST", p)).toBe(false);
    }
  });

  test("can still say its line: reporting is the whole job", () => {
    expect(seatAllows("speak", "POST", "/seat/say")).toBe(true);
  });
});

describe("a chair set to nudge", () => {
  test("may unstick an agent that is already running", () => {
    expect(seatAllows("nudge", "POST", "/agents/named/prompt")).toBe(true);
    expect(seatAllows("nudge", "POST", "/agents/named/read")).toBe(true);
  });

  test("may not start one, and may not stop one", () => {
    expect(seatAllows("nudge", "POST", "/agents/named/start")).toBe(false);
    expect(seatAllows("nudge", "POST", "/agents/named/stop")).toBe(false);
  });
});

describe("a chair set to assign", () => {
  test("may start and stop named agents", () => {
    expect(seatAllows("assign", "POST", "/agents/named/start")).toBe(true);
    expect(seatAllows("assign", "POST", "/agents/named/stop")).toBe(true);
  });

  test("still may not do a thing nobody wrote down", () => {
    /* Deny by default: a route invented next month is out of reach before
       anybody thinks about it. These are real routes the seat has no business
       with — opening a shell, answering a gate, changing the workspace. */
    for (const p of ["/terminal/pty", "/gate/decide", "/workspace", "/projects/clone", "/understudy/halt"]) {
      expect(seatAllows("assign", "POST", p)).toBe(false);
    }
    expect(seatAllows("assign", "DELETE", "/agents/named/stop")).toBe(false);
  });
});

describe("the credential, end to end", () => {
  test("a seat token resolves to the seat principal, carrying its powers", () => {
    const t = mintSeatToken(ROOT, "nudge");
    const { req: r, url } = withToken(t);
    const caller = callerFor(r, url, "the-machine-token");
    expect(caller?.principal).toBe("seat");
    expect(caller?.seat?.powers).toBe("nudge");
    revokeSeatTokens(ROOT);
  });

  test("`allowed` grades it by powers and NEVER by its scope", () => {
    /* The token says `full` so its reads work. If `allowed` ever consulted the
       scope alongside the powers — an `||` on that line — every write this
       fence withholds would come straight back. */
    const t = mintSeatToken(ROOT, "speak");
    const { req: _r, url } = withToken(t);
    const caller = callerFor(new Request("http://x/", { headers: { Authorization: `Bearer ${t}` } }), url, "the-machine-token")!;
    expect(caller.scope).toBe("full");
    expect(allowed(caller, "POST", "/agents/named/prompt")).toBe(false);
    expect(allowed(caller, "POST", "/terminal/pty")).toBe(false);
    revokeSeatTokens(ROOT);
  });

  test("emptying the chair revokes it: a credential does not outlive its seating", () => {
    const before = seatTokenCount();
    const t = mintSeatToken(ROOT, "assign");
    expect(seatTokenCount()).toBe(before + 1);
    revokeSeatTokens(ROOT);
    expect(seatTokenCount()).toBe(before);
    const caller = callerFor(new Request("http://x/", { headers: { Authorization: `Bearer ${t}` } }), new URL("http://x/"), "the-machine-token");
    expect(caller).toBeNull();
  });

  test("seating again does not leave the old one behind", () => {
    const before = seatTokenCount();
    revokeSeatTokens(ROOT);
    mintSeatToken(ROOT, "speak");
    revokeSeatTokens(ROOT);
    mintSeatToken(ROOT, "assign");
    expect(seatTokenCount()).toBe(before + 1);
    revokeSeatTokens(ROOT);
  });
});

describe("methods that are neither a read nor a named POST", () => {
  test("are refused at every level", () => {
    for (const powers of ["speak", "nudge", "assign"] as const) {
      expect(seatAllows(powers, "PUT", "/seat/say")).toBe(false);
      expect(seatAllows(powers, "DELETE", "/agents/named/prompt")).toBe(false);
    }
    expect(req("GET").method).toBe("GET");
  });
});
