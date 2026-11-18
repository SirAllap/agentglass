/*
 * The socket a browser CLI asks over when its window's env says
 * AGENTGLASS_BROWSER_OFF but the pane running it IS the project's adopted
 * seat (seatcred.ts).
 *
 * The first version of this fix named the caller by `TMUX_PANE`, a plain
 * environment variable any worker can forge. These tests exist to prove the
 * replacement never reads anything the caller sent about itself: identity
 * comes only from the kernel's SO_PEERCRED of the connecting socket and a
 * real /proc ancestry walk from that pid.
 *
 * Two layers:
 *  - `matchingSeat`/`ancestry` against REAL spawned processes (not stubs),
 *    proving the ancestor walk and the forged-env case the brief asks for.
 *  - The whole socket, end to end, with the tmux/db lookup swapped out via
 *    `__setSeatCandidates` so the SO_PEERCRED read itself is exercised
 *    without needing a real adopted seat and a real tmux server.
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { createConnection, createServer } from "node:net";
import { mkdtempSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ancestry, matchingSeat, matchingSeatInChain, seatCandidateEligible, startSeatCredSocket, stopSeatCredSocket,
  __setSeatCandidates,
} from "../src/seatcred.ts";
import { callerFor, allowed, mintWorkerToken, revokeWorkerTokens } from "../src/auth.ts";

/**
 * Whether THIS process may bind a unix-domain socket at all, judged by
 * actually trying one, not by `process.platform`: the brief's own
 * motivation for this socket is that a worker's SANDBOX blocks unix sockets
 * outright — part of the defense, not a gap in it — and this suite's own
 * agent runs inside exactly that kind of sandbox. Measured here: even a
 * bare `net.createServer().listen(<path>)` fails with no further errno,
 * which is the sandbox's seccomp filter refusing the `bind()` syscall, not a
 * bug in `seatcred.ts`. Where that is true, the socket-level describe below
 * is skipped with a message saying so — the real seat pane's own tmux pane
 * is NOT behind this kind of sandbox and is expected to run it.
 */
function canBindUnixSocket(): Promise<boolean> {
  return new Promise((resolve) => {
    if (process.platform !== "linux") return resolve(false);
    const path = join(tmpdir(), `agx-seatcred-probe-${process.pid}.sock`);
    try { unlinkSync(path); } catch { /* fine */ }
    const s = createServer(() => {});
    (s as unknown as { on(event: "error", cb: () => void): void }).on("error", () => resolve(false));
    s.listen(path, () => {
      s.close();
      try { unlinkSync(path); } catch { /* fine */ }
      resolve(true);
    });
  });
}

const UNIX_SOCKETS_WORK = await canBindUnixSocket();

describe.skipIf(process.platform !== "linux")("matchingSeat — real processes, no env read", () => {
  let child: ReturnType<typeof Bun.spawn> | null = null;

  afterEach(() => {
    child?.kill();
    child = null;
  });

  test("a process descended from the seat pane's own pid matches it", async () => {
    // This test process stands in for the seat pane's shell; the spawned
    // child's parent is therefore exactly this process's pid, so `ancestry`
    // reading real /proc rows finds it one hop up.
    child = Bun.spawn(["sleep", "5"], { stdout: "ignore", stderr: "ignore" });
    await Bun.sleep(50); // let /proc/<child>/stat exist
    const seat = { root: "/home/a/code/orbit", name: "orchestrator", livePid: process.pid };
    expect(matchingSeat(child.pid, [seat])).toEqual(seat);
    expect(ancestry(child.pid)).toContain(process.pid);
  });

  test("a sibling process with a forged TMUX_PANE is refused — the env is never read", async () => {
    // `sibling` is a second child of THIS process, exactly like `child`
    // above — a real process, not a descendant of whatever pid the seat
    // candidate below names. Its env claims the seat's pane id; `matchingSeat`
    // takes no `env` argument at all, so there is nothing for that claim to
    // reach. The candidate's `livePid` is `child`'s pid (a real, different
    // process this process is NOT a descendant of, and sibling is not either).
    child = Bun.spawn(["sleep", "5"], { stdout: "ignore", stderr: "ignore" });
    await Bun.sleep(50);
    const sibling = Bun.spawn(["sleep", "5"], {
      stdout: "ignore", stderr: "ignore",
      env: { ...process.env, TMUX_PANE: "%999" }, // forged, and irrelevant
    });
    try {
      await Bun.sleep(50);
      const seat = { root: "/home/a/code/orbit", name: "orchestrator", livePid: child!.pid };
      expect(matchingSeat(sibling.pid, [seat])).toBeNull();
    } finally {
      sibling.kill();
    }
  });

  test("a dead seat (no live candidate at all) is refused", () => {
    expect(matchingSeat(process.pid, [])).toBeNull();
  });

  test("init (pid 1) is never treated as anybody's ancestor", () => {
    expect(ancestry(process.pid)).not.toContain(1);
  });

  test("a chain captured up front matches the same as walking it live (fix for the pid-reuse race)", async () => {
    // Round 2, finding 2: the ancestry walk used to happen lazily, after
    // `liveSeatCandidates`'s own awaits. `matchingSeatInChain` takes an
    // already-walked chain, proving the split works the same as the
    // pid-based `matchingSeat` it now wraps.
    child = Bun.spawn(["sleep", "5"], { stdout: "ignore", stderr: "ignore" });
    await Bun.sleep(50);
    const chain = new Set(ancestry(child.pid));
    const seat = { root: "/home/a/code/orbit", name: "orchestrator", livePid: process.pid };
    expect(matchingSeatInChain(chain, [seat])).toEqual(seat);
    expect(matchingSeatInChain(new Set(), [seat])).toBeNull();
  });
});

// Skipped, with a reason in the title, where this process's own sandbox
// refuses the bind() a unix socket needs — exactly the restriction the
// comment in seatcred.ts documents for a WORKER's sandbox. A seat pane is
// not sandboxed this way; run this file there to exercise these.
describe.skipIf(!UNIX_SOCKETS_WORK)("the seat-credential socket, end to end (skipped if this sandbox blocks unix sockets)", () => {
  let dir = "";

  afterAll(() => {
    stopSeatCredSocket();
    __setSeatCandidates(null);
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  async function freshSocket(): Promise<string> {
    dir = dir || mkdtempSync(join(tmpdir(), "agx-seatcred-"));
    stopSeatCredSocket(); // closes whatever this file's previous test started
    const prevHome = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = dir;
    startSeatCredSocket();
    if (prevHome === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prevHome;
    const path = join(dir, "agentglass", "seat-cred", "seat-cred.sock");
    // `listen()` binds asynchronously; a connect sent before that finishes
    // fails ENOENT, so wait for the file rather than racing it.
    const { existsSync } = await import("node:fs");
    for (let i = 0; i < 50 && !existsSync(path); i++) await Bun.sleep(10);
    if (!existsSync(path)) throw new Error(`${path} never appeared`);
    return path;
  }

  function ask(path: string): Promise<{ ok: boolean; token?: string; profile?: string; error?: string }> {
    return new Promise((resolve, reject) => {
      const sock = createConnection(path, () => {
        sock.write("seat-credential\n");
      });
      const chunks: Buffer[] = [];
      sock.on("data", (c) => chunks.push(Buffer.from(c)));
      sock.on("end", () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        } catch (e) {
          reject(e);
        }
      });
      sock.on("error", reject);
    });
  }

  test("a connecting process under the adopted pane's identity gets a token", async () => {
    // We are both ends of this connection, so SO_PEERCRED on the server side
    // reports THIS test process's own pid. Standing that pid in as the
    // seat's `livePid` is the self case of "descended from the seat pane" —
    // the real multi-process case is covered above, over real /proc rows;
    // this half proves the socket plumbing (SO_PEERCRED + the reply) itself.
    __setSeatCandidates(async () => [{ root: "/home/a/code/orbit", name: "orchestrator", livePid: process.pid }]);
    const path = await freshSocket();
    const res = await ask(path);
    expect(res.ok).toBe(true);
    expect(res.token).toMatch(/^wk_/);
    expect(res.profile).toBe("seat-cred:orchestrator");
  });

  test("no matching seat (a dead or absent one) is refused, never given a token", async () => {
    __setSeatCandidates(async () => []); // the empty answer `liveSeatCandidates` gives for a dead seat
    const path = await freshSocket();
    const res = await ask(path);
    expect(res.ok).toBe(false);
    expect(res.token).toBeUndefined();
    expect(res.error).toMatch(/no adopted seat/);
  });

  test("a throwing candidatesFor still gets a reply, never a bare close", async () => {
    // Round 3: `candidatesFor().then(...)` had no `.catch`, so a rejection
    // here used to leave the socket closed with an empty body and nothing
    // in the log. The handler must now reply ok:false either way.
    __setSeatCandidates(async () => { throw new Error("boom"); });
    const path = await freshSocket();
    const res = await ask(path);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/boom/);
  });

  test("the socket file is private: mode 0600", async () => {
    __setSeatCandidates(async () => []);
    const path = await freshSocket();
    const { statSync } = await import("node:fs");
    // The directory is the fence: another user cannot reach the socket whatever the file's mode.
    expect(statSync(join(path, "..")).mode & 0o777).toBe(0o700);
    // The file is chmod'ed in listen's callback, a moment after it appears.
    for (let i = 0; i < 50 && (statSync(path).mode & 0o777) !== 0o600; i++) await Bun.sleep(10);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  test("two close asks from one seat both stay live (replace: false)", async () => {
    // Round 2, finding 4: a second mint for the same seat used to revoke the
    // first in flight. Ask twice back to back and expect BOTH tokens to still
    // resolve to a caller afterwards.
    __setSeatCandidates(async () => [{ root: "/home/a/code/orbit", name: "orchestrator", livePid: process.pid }]);
    const path = await freshSocket();
    const first = await ask(path);
    const second = await ask(path);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(first.token).not.toBe(second.token);
    for (const t of [first.token!, second.token!]) {
      expect(callerFor(new Request("http://x/", { headers: { authorization: `Bearer ${t}` } }), new URL("http://x/"), "mk_unused"))
        .toMatchObject({ principal: "seat-browser" });
    }
    revokeWorkerTokens("seat-cred:orchestrator");
  });
});

describe("a self-started seat is a candidate too, not only an adopted one", () => {
  // Root cause: `liveSeatCandidates` used to skip any row with an empty
  // `adoptedPane`, but a seat this app started itself (never adopted) is
  // just as resolvable through `seated()` — via `AgentOps.agentNamed()` —
  // so excluding it on that column alone meant a self-started chair's stuck
  // OFF-with-no-reason pane could never be rescued, even after a `/seat/adopt`
  // retry (adopting needs the person's own click, which an automated retry
  // does not have).
  test("not ended, with no adoptedPane, is still eligible", () => {
    expect(seatCandidateEligible({ endedAt: null })).toBe(true);
  });

  test("a stood-down seat (ended) is not eligible, adopted or not", () => {
    expect(seatCandidateEligible({ endedAt: Date.now() })).toBe(false);
  });
});

describe("the seat-cred socket's token is browser-only, not a full worker credential", () => {
  afterEach(() => revokeWorkerTokens("seat-cred:orchestrator"));

  function seatBrowserCaller() {
    const t = mintWorkerToken("seat-cred:orchestrator", 60_000, false);
    const caller = callerFor(
      new Request("http://x/", { headers: { authorization: `Bearer ${t}` } }),
      new URL("http://x/"),
      "mk_unused",
    );
    if (!caller) throw new Error("expected a caller");
    return caller;
  }

  test("resolves to its own principal, not a plain worker's", () => {
    expect(seatBrowserCaller()).toMatchObject({ kind: "machine", scope: "full", principal: "seat-browser" });
  });

  test("403s on a shell route and a settings write", () => {
    const caller = seatBrowserCaller();
    expect(allowed(caller, "GET", "/terminal/pty")).toBe(false);
    expect(allowed(caller, "POST", "/settings")).toBe(false);
  });

  test("200s (is allowed) on a browser relay route", () => {
    const caller = seatBrowserCaller();
    expect(allowed(caller, "POST", "/browser/observe")).toBe(true);
  });
});
