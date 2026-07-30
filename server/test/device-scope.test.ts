/*
 * What a paired phone is allowed to do, and — the half with teeth — what it is
 * not allowed to do by default.
 *
 * The rule is deny-by-default: anything that changes state and is not named as
 * an answer is `full`. That is the direction that matters. A list of *forbidden*
 * routes fails open every time somebody adds a route and does not update it,
 * and the thing it fails open on is an interactive shell. So most of what is
 * below is written against the route table in index.ts rather than against a
 * handful of paths, so it keeps being true as that file grows.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { callerFor, scopeNeeded, allowed, isAuthExempt, isPairing, isIntake } from "../src/auth.ts";
import { issueDevice, revokeDevice, deviceFor, __resetDevices, type Scope } from "../src/devices.ts";

const src = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");

/** Every route index.ts dispatches on, as it actually writes them. */
const ROUTES = [...new Set([...src.matchAll(/pathname === "(\/[^"]*)"/g)].map((m) => m[1]!))];

/** The ones it only reaches by prefix — the git, docker and pull-request
 *  switches, which is where every write of consequence lives. */
const SWITCH_CASES = [...new Set([...src.matchAll(/case "(\/(?:git|docker|prs)\/[^"]*)":/g)].map((m) => m[1]!))];

const at = (url: string, headers: Record<string, string> = {}) =>
  [new Request(url, { headers }), new URL(url)] as const;

beforeEach(() => {
  process.env.NODE_ENV = "test";
  process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "agx-scope-"));
  __resetDevices();
});

describe("who is asking", () => {
  test("the machine's own token is the machine, and the machine is everything", () => {
    const [req, url] = at("http://x/anything", { authorization: "Bearer machine-token" });
    expect(callerFor(req, url, "machine-token")).toEqual({ kind: "machine", scope: "full" });
  });

  test("a device credential is that device, with the scope it was granted", () => {
    const { token, device } = issueDevice("iPhone", "answer");
    const [req, url] = at("http://x/anything", { authorization: `Bearer ${token}` });
    const c = callerFor(req, url, "machine-token");
    expect(c).toMatchObject({ kind: "device", scope: "answer" });
    expect(c!.device!.id).toBe(device.id);
  });

  test("a credential arriving as ?token= is the same credential", () => {
    // WebSocket upgrades and download navigations cannot carry a header, so a
    // rule that only read the header would leave the phone unable to open the
    // event stream while every fetch worked.
    const { token } = issueDevice("iPhone", "read");
    const [req, url] = at(`http://x/stream?token=${encodeURIComponent(token)}`);
    expect(callerFor(req, url, "machine-token")).toMatchObject({ kind: "device", scope: "read" });
  });

  test("a revoked device is nobody at all", () => {
    const { token, device } = issueDevice("iPhone", "answer");
    revokeDevice(device.id);
    const [req, url] = at("http://x/anything", { authorization: `Bearer ${token}` });
    expect(callerFor(req, url, "machine-token")).toBeNull();
    expect(deviceFor(token)).toBeNull();
  });

  test("no credential, or a wrong one, is nobody", () => {
    issueDevice("iPhone", "full");
    expect(callerFor(...at("http://x/a"), "machine-token")).toBeNull();
    expect(callerFor(...at("http://x/a", { authorization: "Bearer nope" }), "machine-token")).toBeNull();
    expect(callerFor(...at("http://x/a", { authorization: "Bearer " }), "machine-token")).toBeNull();
  });
});

describe("deny by default", () => {
  /**
   * The rule, stated over the tree rather than over today's routes.
   *
   * Every POST index.ts dispatches on must resolve to `full` unless it is one
   * of the handful this file names below as a read or an answer. A route added
   * next month is therefore out of a paired phone's reach until somebody
   * decides otherwise, which is the only default that is safe to forget about.
   */
  const NAMED_LOWER = new Set([
    // Reads wearing POST, because their argument is a filesystem path.
    "/git/status",
    // What a phone is for: answering something that is already asked.
    "/gate/decide", "/chat/send", "/chat/pane/key",
    // A device managing its own notifications — the mechanism that tells it
    // there is something to answer.
    "/push/subscribe", "/push/unsubscribe", "/push/test",
  ]);

  test("every POST route is full access unless it is one of the named few", () => {
    const surprises = [...ROUTES, ...SWITCH_CASES]
      .filter((r) => !NAMED_LOWER.has(r) && !isPairing(r))
      .filter((r) => scopeNeeded("POST", r) !== "full");
    expect(surprises, "a POST is reachable by a phone without anyone deciding that").toEqual([]);
  });

  test("a route nobody has written yet is already full access", () => {
    expect(scopeNeeded("POST", "/some/route/invented/next/month")).toBe("full");
    expect(scopeNeeded("DELETE", "/anything")).toBe("full");
    expect(scopeNeeded("PUT", "/anything")).toBe("full");
  });

  test("the named few really are named — a typo here is a route nobody can reach", () => {
    // Catches the opposite failure: a name in the list that no longer exists,
    // which would leave the real route silently at `full` while this file
    // claims a phone can use it.
    const known = new Set([...ROUTES, ...SWITCH_CASES]);
    for (const r of NAMED_LOWER) expect(known.has(r), `${r} is not a route in index.ts`).toBe(true);
  });
});

describe("the ones that would be a shell", () => {
  test("the terminal is full access, even though it arrives as a GET", () => {
    // A browser cannot put a header on a WebSocket upgrade, so /terminal/pty
    // arrives as GET ?token=. A rule that trusted the method would hand a
    // look-only device an interactive shell on this machine.
    expect(scopeNeeded("GET", "/terminal/pty")).toBe("full");
    const { token } = issueDevice("iPhone", "answer");
    const [req, url] = at(`http://x/terminal/pty?token=${encodeURIComponent(token)}`);
    expect(allowed(callerFor(req, url, "m")!, "GET", "/terminal/pty")).toBe(false);
  });

  test("every git, docker and pull-request write is full access", () => {
    // Enumerated from the switch statements themselves, so a case added to any
    // of them is covered the day it lands.
    expect(SWITCH_CASES.length).toBeGreaterThan(30);
    for (const r of SWITCH_CASES) {
      if (r === "/git/status") continue; // a read; see above
      expect(scopeNeeded("POST", r), `${r} is not full access`).toBe("full");
    }
  });

  test("named individually as well, because these are the ones that hurt", () => {
    for (const r of ["/git/discard", "/git/reset", "/git/push", "/prs/merge", "/prs/close", "/docker/rm", "/update/run", "/chat/attach", "/control", "/editor/open"]) {
      expect(scopeNeeded("POST", r), r).toBe("full");
    }
  });
});

describe("what each level can actually do", () => {
  const caller = (scope: Scope) => {
    const { token } = issueDevice("d", scope);
    const [req, url] = at("http://x/", { authorization: `Bearer ${token}` });
    return callerFor(req, url, "machine-token")!;
  };

  test("a look-only device looks, and decides nothing", () => {
    const c = caller("read");
    expect(allowed(c, "GET", "/sessions")).toBe(true);
    expect(allowed(c, "GET", "/gate/pending")).toBe(true);
    expect(allowed(c, "POST", "/git/status")).toBe(true);
    expect(allowed(c, "POST", "/gate/decide")).toBe(false);
    expect(allowed(c, "POST", "/chat/send")).toBe(false);
  });

  test("an answering device unblocks agents, and operates nothing", () => {
    const c = caller("answer");
    expect(allowed(c, "POST", "/gate/decide")).toBe(true);
    expect(allowed(c, "POST", "/chat/send")).toBe(true);
    expect(allowed(c, "GET", "/sessions")).toBe(true);
    expect(allowed(c, "POST", "/prs/merge")).toBe(false);
    expect(allowed(c, "POST", "/git/push")).toBe(false);
    expect(allowed(c, "POST", "/docker/rm")).toBe(false);
    expect(allowed(c, "GET", "/terminal/pty")).toBe(false);
  });

  test("a full device is the machine, which is what makes it a decision", () => {
    const c = caller("full");
    for (const r of ["/prs/merge", "/git/reset", "/docker/rm", "/control"]) {
      expect(allowed(c, "POST", r), r).toBe(true);
    }
    expect(allowed(c, "GET", "/terminal/pty")).toBe(true);
  });
});

describe("the pairing routes themselves", () => {
  test("are reachable without a credential, because handing one out is the point", () => {
    for (const r of ["/pair/info", "/pair/claim", "/pair/collect", "/pair/ticket", "/pair/accept"]) {
      expect(isAuthExempt(r), r).toBe(true);
    }
  });

  test("and nothing else picked up an exemption on the way", () => {
    // The exemption is a prefix, which is right for a protocol and wrong if it
    // ever widens. `/paired`, `/pairing-stats` and the like are not the prefix.
    expect(isPairing("/pair")).toBe(true);
    expect(isPairing("/pair/anything")).toBe(true);
    expect(isPairing("/paired")).toBe(false);
    expect(isPairing("/repair/x")).toBe(false);
    // The register of everything reachable with no credential at all, and why
    // each one is allowed to be. Changing this list is the moment to re-read
    // it, which is the whole point of writing it out rather than deriving it.
    const OPEN: Record<string, string> = {
      "/health": "answers a fixed shape, so a shell can find which server owns the port",
      "/ingest": "append-only: a local hook has no way to carry a secret",
      "/v1/traces": "append-only OTel sink, same reason",
      "/otlp/v1/traces": "append-only OTel sink, same reason",
      "/v1/logs": "append-only OTel sink, same reason",
      "/otlp/v1/logs": "append-only OTel sink, same reason",
      // Receives nothing and stores nothing — it exists to say there is no
      // metrics receiver here. Gating it would turn a silent 404 into a silent
      // 401, which is the same dead end.
      "/v1/metrics": "refuses, and explains; reads and writes nothing",
      "/otlp/v1/metrics": "refuses, and explains; reads and writes nothing",
    };
    for (const r of ROUTES.filter((r) => !isPairing(r))) {
      if (r in OPEN) continue;
      expect(isAuthExempt(r), `${r} no longer needs a credential`).toBe(false);
    }
    // And nothing on the list has quietly stopped being a route.
    for (const r of Object.keys(OPEN)) {
      expect(isAuthExempt(r), `${r} is listed as open but is not exempt`).toBe(true);
    }
  });

  test("claiming is rate limited, because it is the one with no credential at all", () => {
    // The five-guess cap on a ticket is the real defence; this stops the noise
    // before it gets there.
    expect(isIntake("/pair/claim")).toBe(true);
  });
});
