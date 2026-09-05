/*
 * A phone pairing with a real agentglass server, end to end.
 *
 * This boots `server/src/index.ts` — the actual server, with remote access on —
 * plays the desk over its own routes and the phone with the app's own modules.
 * It is slow by the standards of the files next to it, and it earns that by
 * being the only place two claims are checked rather than asserted:
 *
 *   1. The credential the desk seals comes out readable on a runtime with no
 *      WebCrypto. `pairing.test.ts` proves the crypto agrees; this proves the
 *      six HTTP steps around it do too — the ticket, the six digits, the
 *      accept, and the one-shot collect.
 *
 *   2. The live socket is reachable from a client that is not a browser.
 *      `trustedCaller` refuses an upgrade that carries no Origin unless the
 *      caller is *this machine*, so the app sends one naming the address it is
 *      talking to. If that rule is ever tightened, this goes red here rather
 *      than on somebody's phone.
 *
 * WHAT "UNLESS THE CALLER IS THIS MACHINE" MEANS, because this file used to say
 * something else and was wrong for three hours because of it. The rule was
 * `LOOPBACK_ONLY` — a property of the BIND, decided once at startup — and
 * dd1f558 changed it to `from === "loopback"`, a property of the REQUEST. It
 * had to: `tailscale serve` terminates TLS and re-dials 127.0.0.1, so a
 * 127.0.0.1 bind stays `LOOPBACK_ONLY` while the whole tailnet can reach it,
 * and the old rule handed every Origin-less tailnet caller the trusted answer
 * — `websocat wss://<name>/terminal/pty`, with a token, would have got a shell.
 *
 * The negative control here was built on the old rule: bind 0.0.0.0 so
 * `LOOPBACK_ONLY` is false, then connect from 127.0.0.1 and watch the refusal.
 * Under the rule that now exists that caller IS loopback, so it is accepted and
 * the assertion failed — and two commit messages called that failure
 * "pre-existing" and "out of scope". It was neither. It was this branch, three
 * hours old.
 *
 * Checked rather than assumed before the control was rewritten:
 *   * A browser always sends Origin on a WebSocket upgrade, so "no Origin" is a
 *     non-browser caller and cannot be a drive-by.
 *   * On a non-loopback bind a token is not optional — `resolveToken(false)`
 *     reads or generates one, and `/stream` is in neither OPEN nor LOCAL_SINKS
 *     — so this widens nothing that was not already behind the credential.
 *   * A caller arriving through the proxy resolves to `remote` and is refused.
 *     That is the one worth an assertion rather than a sentence, and it is the
 *     control below.
 *
 * Every success is paired with the failure that gives it meaning: a wrong code
 * is refused, a stranger's token is refused, and a socket from off this machine
 * without the Origin is refused. Without those three, a green run would only
 * prove the server was up.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { announce, installed, pairing } from "./npm-deps.ts";

announce("pairing-e2e.test.ts");

const { TICKET_TTL_MS, leftOnTicket, makeKeys, unseal } = pairing;

// Not 4000: a developer running the cockpit while the tests run would otherwise
// have this suite talk to their own machine's real server and pair with it.
const PORT = 4917;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const MACHINE_TOKEN = "a-machine-token-for-this-suite";

let server: ReturnType<typeof Bun.spawn> | null = null;
let dbDir = "";

const json = async <T,>(response: Response): Promise<T> => (await response.json()) as T;

/*
 * THE DESK IS A BROWSER, and it has to send an Origin to prove it.
 *
 * `desk` sent a bare machine token, which is what a bare machine token used to
 * be enough for. It is not any more, and deliberately: an agent running as the
 * user can read that token off disk, so with it alone it could ask for a
 * pairing ticket, accept its OWN ticket, and mint a device with any label it
 * liked — then release its own held calls through the device branch, needing
 * no Origin at all, with the audit line reading as a phone somebody had once
 * approved. See mayReleaseAHold in server/src/index.ts.
 *
 * So accepting a pairing is the HUMAN half, and the human half is a browser on
 * this machine. This suite was still testing the door as it was before that
 * fix, and had been failing on `/pair/accept` ever since.
 */
const desk = (path: string, body?: unknown): Promise<Response> =>
  fetch(ORIGIN + path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      authorization: `Bearer ${MACHINE_TOKEN}`,
      origin: ORIGIN,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const asPhone = (path: string, body: unknown): Promise<Response> =>
  fetch(ORIGIN + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

/**
 * Open `/stream` and say whether it got there, and why not when it did not.
 *
 * `as` is who the server should think is calling:
 *   "browser" — an Origin naming this server, which is what the app sends.
 *   "local"   — no Origin, from 127.0.0.1: a non-browser caller on this machine.
 *   "remote"  — no Origin, and the header `tailscale serve` puts on a request it
 *               is forwarding for somebody on the tailnet.
 *
 * "remote" needs no proxy process. `proxiedByTailscaled` decides on the uid that
 * owns the connecting socket, and the `--preload` seam on the server tells it
 * this runner's uid is the proxy's — so a direct connection carrying the
 * forwarding header is treated exactly as one arriving through serve. Its stage
 * 1 is the presence of a forwarding header, so every other request in this file
 * is unaffected by the seam and stays the plain loopback caller it was.
 */
type Caller = "browser" | "local" | "remote";

/** Not this machine's own tailnet address, so the peer is a device and not self.
 *  The same address `server/test/serve-proxy.test.ts` speaks for. */
const PHONE = "100.101.102.103";

function trySocket(as: Caller, token: string): Promise<{ open: boolean; why: string }> {
  return new Promise((resolve) => {
    const url = `${ORIGIN.replace(/^http/, "ws")}/stream?token=${encodeURIComponent(token)}`;
    // Bun's WebSocket takes request options where the DOM's takes subprotocols
    // — the same extension React Native has, which is what lets either of them
    // put an Origin on the upgrade at all. `lib.dom` describes the browser one.
    const Ctor = WebSocket as unknown as new (
      url: string,
      options?: { headers?: Record<string, string> },
    ) => WebSocket;
    const headers: Record<string, string> | null =
      as === "browser" ? { Origin: ORIGIN } :
      as === "remote" ? { "X-Forwarded-For": PHONE } :
      null;
    const ws = headers ? new Ctor(url, { headers }) : new Ctor(url);
    // A successful open is followed by the close this function itself asks
    // for, so without a latch the answer is overwritten by its own cleanup.
    let settled = false;
    const done = (open: boolean, why: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.close(); } catch { /* already gone */ }
      resolve({ open, why });
    };
    const timer = setTimeout(() => done(false, "timed out"), 5_000);
    ws.onopen = () => done(true, "");
    ws.onclose = (e: CloseEvent) => done(false, `close ${e.code} ${e.reason}`);
    ws.onerror = () => { /* a close always follows, and it carries the reason */ };
  });
}

beforeAll(async () => {
  dbDir = mkdtempSync(join(tmpdir(), "agx-pair-e2e-"));
  server = Bun.spawn([
    "bun", "run",
    /*
     * The seam that lets a test stand in for tailscaled.
     *
     * `proxiedByTailscaled` decides on the uid owning the connecting socket,
     * because that is the one thing about a loopback connection a non-root
     * process cannot forge. A test runs as the developer and never as root, so
     * without this the "a forwarded caller is refused" control below could only
     * run on a machine with Tailscale configured — i.e. never in CI, on exactly
     * the boundary that must not regress. `--preload` goes AFTER `run`; `bun
     * --preload X run Y` prints the usage banner and exits, which surfaces here
     * only as a beforeAll timeout. An absolute path, not one relative to `cwd`:
     * measured, `--preload test/fixtures/trust-test-proxy.ts` from that cwd is
     * `error: preload not found`, and with stderr ignored that also arrives as
     * a beforeAll timeout and nothing else.
     */
    "--preload", join(import.meta.dir, "..", "..", "server", "test", "fixtures", "trust-test-proxy.ts"),
    "src/index.ts",
  ], {
    cwd: join(import.meta.dir, "..", "..", "server"),
    env: {
      ...process.env,
      AGENTGLASS_PORT: String(PORT),
      // Bound wide because the phone is a real off-box client and this file is
      // the only place that is true end to end. It is no longer what makes the
      // negative control below work — that is the caller's own address now, not
      // the bind — but a loopback bind would still make the positive weaker
      // than the thing it stands for.
      AGENTGLASS_BIND: "0.0.0.0",
      AGENTGLASS_TRUST_LAN: "1",
      AGENTGLASS_TOKEN: MACHINE_TOKEN,
      AGENTGLASS_DB: join(dbDir, "e2e.db"),
      /*
       * Where the paired devices are written. Not a tidiness preference — it
       * is the difference between a test and an accident, twice over:
       *
       *   * Without it the suite appends fake devices to the developer's real
       *     `~/.config/agentglass/devices.json`. That happened while this file
       *     was being written, and two "Ada's phone" rows with working
       *     credentials had to be picked back out by hand.
       *   * `devices.ts` knows about this and refuses any path outside the
       *     scratch directory under NODE_ENV=test — so the server the child
       *     runs would silently fail to persist the device it just minted, and
       *     the credential this test collects would authenticate as nobody.
       *     A 401 four steps downstream is how that reads.
       *
       * `dbDir` is under the system temp directory, which is exactly the one
       * place that guard allows.
       */
      XDG_CONFIG_HOME: dbDir,
      AGENTGLASS_SCAN_DISABLED: "1",
      AGENTGLASS_NOTIFY: "",
      /*
       * Same class of accident as `XDG_CONFIG_HOME` above, and it very nearly
       * happened the same way. The server sweeps tmux window sizes at boot over
       * every socket in `$TMUX_TMPDIR/tmux-<uid>`; unset, that directory is the
       * developer's own, holding the sessions they are working in. This file
       * spawns with `...process.env`, so NODE_ENV=test does reach the child and
       * `tmuxctl.ts` would refuse the walk — but that is a guard behaving
       * correctly, not a reason to point the child at a live socket directory.
       */
      TMUX_TMPDIR: join(dbDir, "tmux"),
    },
    stdout: "ignore",
    /*
     * Piped, not ignored — and drained, so a chatty boot cannot fill the pipe
     * and block the child. Ignoring it is what turned every boot failure into
     * the same sentence, "the server never answered", with the reason thrown
     * away: a port already held, a missing binary, a crash on the first line.
     * On a runner, that sentence is all anybody gets.
     */
    stderr: "pipe",
  });

  let said = "";
  void (async () => {
    try { for await (const c of server!.stderr as ReadableStream<Uint8Array>) said += new TextDecoder().decode(c); }
    catch { /* the child went away; whatever was read is what we have */ }
  })();

  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(`${ORIGIN}/health`)).ok) return; } catch { /* not up yet */ }
    await Bun.sleep(250);
  }
  // What the child said, and whether it is even alive — the two facts that tell
  // "it crashed" from "it is running and cannot be reached from here".
  const alive = server!.exitCode === null && server!.signalCode === null;
  throw new Error(
    `the server never answered ${ORIGIN}/health — child ${alive ? "still running" : `gone (exit ${server!.exitCode}, signal ${server!.signalCode})`}` +
    (said.trim() ? `\n--- its stderr ---\n${said.trim().slice(-2000)}` : "\n(it printed nothing)"),
  );
}, 40_000);

afterAll(async () => {
  server?.kill();
  await server?.exited;
  if (dbDir) rmSync(dbDir, { recursive: true, force: true });
});

describe.skipIf(!installed)("a phone pairing with a real server", () => {
  test("the whole handshake, and then the socket", async () => {
    const ticket = await json<{ ok: boolean; id: string; code: string }>(await desk("/pair/ticket", {}));
    expect(ticket.ok).toBe(true);
    expect(ticket.code).toMatch(/^\d{6}$/);

    const keys = makeKeys();

    // The wrong six digits, first. It must be refused AND must leave the
    // invitation alive — the person is about to type it again.
    const wrong = await json<{ ok: boolean; left?: number }>(
      await asPhone("/pair/claim", { ticket: ticket.id, code: "000000", label: "Phone", pub: keys.pub }),
    );
    expect(wrong.ok).toBe(false);
    expect(wrong.left).toBe(4);

    const claim = await json<{ ok: boolean; secret: string; error?: string }>(
      await asPhone("/pair/claim", {
        ticket: ticket.id, code: ticket.code, label: "A phone", pub: keys.pub,
      }),
    );
    // The key came from @noble, not from WebCrypto. The server cannot tell,
    // which is the property this whole app rests on.
    expect(claim.error ?? "").toBe("");
    expect(claim.ok).toBe(true);

    const accepted = await json<{ ok: boolean; device?: { label: string } }>(
      await desk("/pair/accept", { ticket: ticket.id, scope: "answer" }),
    );
    expect(accepted.ok).toBe(true);

    const collected = await json<{
      state: string; wrapped: { pub: string; iv: string; data: string }; scope: string;
    }>(await fetch(
      `${ORIGIN}/pair/collect?ticket=${encodeURIComponent(ticket.id)}` +
      `&secret=${encodeURIComponent(claim.secret)}`,
    ));
    expect(collected.state).toBe("accepted");
    expect(collected.scope).toBe("answer");

    const token = unseal(collected.wrapped, keys.priv, ticket.id);
    expect(token.length).toBeGreaterThan(20);

    // A credential is only worth having if it opens something. No Origin
    // header, which is what every REST call from the app looks like.
    const gates = await fetch(`${ORIGIN}/gate/pending`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(gates.status).toBe(200);

    const stranger = await fetch(`${ORIGIN}/gate/pending`, {
      headers: { authorization: "Bearer not-a-real-token" },
    });
    expect(stranger.status).toBe(401);

    const withOrigin = await trySocket("browser", token);
    expect(withOrigin.why).toBe("");
    expect(withOrigin.open).toBe(true);

    /*
     * The control that makes the one above mean something: a caller off this
     * machine is refused even holding a credential this server minted itself.
     *
     * Driven through the forwarding header rather than through the bind. The
     * bind is a property of the server and says nothing about who is calling;
     * `trustedCaller` asks the REQUEST, so the control has to be a request that
     * really did come from somewhere else. Same shape as
     * `server/test/serve-proxy.test.ts`, on the socket rather than on REST.
     */
    const forwarded = await trySocket("remote", token);
    expect(forwarded.open, "an Origin-less upgrade forwarded from the tailnet was accepted").toBe(false);

    /*
     * WHICH gate refused it, and this assertion is the reason the one above is
     * worth anything.
     *
     * A closed WebSocket says `1002 Expected 101 status code` for every
     * non-upgrade answer, so on its own it cannot tell "the Origin rule turned
     * this away" from "the token was rejected" — and a control that would pass
     * on a 401 is a control that stops noticing when the Origin rule is
     * deleted. The same request over plain HTTP carries the body. Measured
     * against this server: the forwarded caller with a good token gets 403
     * `cross-origin write blocked`, and the same caller with a bad one gets 401
     * `unauthorized — pass ?token=`, so the two are distinguishable and this is
     * the first.
     */
    const refused = await fetch(`${ORIGIN}/stream?token=${encodeURIComponent(token)}`, {
      headers: { "X-Forwarded-For": PHONE },
    });
    expect(refused.status).toBe(403);
    expect(await refused.text()).toContain("cross-origin write blocked");

    /*
     * And the case the old control was accidentally asserting on — stated
     * outright instead, so the rule is written down where it is enforced.
     *
     * A non-browser caller ON this machine is trusted, because a browser always
     * sends Origin on an upgrade, so nothing here can be a drive-by; because a
     * local process already has everything this would grant it; and because on
     * this bind it still had to present the token. `hooks/send_event.py` and
     * `websocat` against one's own desk are the callers this keeps working.
     */
    expect((await trySocket("local", token)).open).toBe(true);
  }, 30_000);

  test("the phone can find out how long it has, before it types anything", async () => {
    /*
     * `/pair/info` against the real server, with the real `Date` header.
     *
     * This is the difference between a form that says the invitation expired
     * ninety seconds ago *after* an address, twelve characters and six digits
     * have been typed, and one that says so before any of it. It takes no
     * credential — it cannot, it is the step before there is one.
     *
     * The skewed-clock assertion is the one worth having: it is run against
     * the header this server actually sent, so it fails if Bun ever stops
     * sending `Date` — which is the only thing holding the countdown up on a
     * phone whose clock is not the computer's.
     */
    const ticket = await json<{ id: string }>(await desk("/pair/ticket", {}));

    const info = await fetch(`${ORIGIN}/pair/info?ticket=${encodeURIComponent(ticket.id)}`);
    const seen = await json<{ ok: boolean; expiresAt: number | null }>(info);
    expect(seen.ok).toBe(true);
    expect(typeof seen.expiresAt).toBe("number");

    const date = info.headers.get("date");
    expect(date).toBeTruthy();
    const left = leftOnTicket(seen.expiresAt!, date, Date.now() + 3_600_000);
    expect(left).toBeGreaterThan(TICKET_TTL_MS - 10_000);
    expect(left).toBeLessThanOrEqual(TICKET_TTL_MS);

    // And the answer the screen turns into "that invitation has run out".
    const gone = await json<{ ok: boolean; expiresAt: number | null }>(
      await fetch(`${ORIGIN}/pair/info?ticket=no-such-ticket`),
    );
    expect(gone.ok).toBe(false);
    expect(gone.expiresAt).toBeNull();
  }, 30_000);

  test("a credential is collected once and only once", async () => {
    // The second collect must find nothing: a credential two devices can fetch
    // is a credential two devices hold.
    const ticket = await json<{ id: string; code: string }>(await desk("/pair/ticket", {}));
    const keys = makeKeys();
    const claim = await json<{ secret: string }>(
      await asPhone("/pair/claim", { ticket: ticket.id, code: ticket.code, label: "A phone", pub: keys.pub }),
    );
    await desk("/pair/accept", { ticket: ticket.id, scope: "read" });

    const url = `${ORIGIN}/pair/collect?ticket=${encodeURIComponent(ticket.id)}` +
      `&secret=${encodeURIComponent(claim.secret)}`;
    expect((await json<{ state: string }>(await fetch(url))).state).toBe("accepted");
    expect((await json<{ state: string }>(await fetch(url))).state).toBe("unknown");
  }, 30_000);
});
