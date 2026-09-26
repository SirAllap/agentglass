// The desktop shell adopts a server already on its port only when that server
// proves it holds the token.
//
// What went wrong before: the shell probed 127.0.0.1:4000/health, and a body
// saying `service: "agentglass"` was the whole identity check. Any process
// that binds the port first can say that, and the shell then sent it the
// token (the remote-status probe, every renderer request) and pointed the
// terminal's socket at it. The probe lives in electron/server-probe.js, which
// requires nothing from Electron, so it is imported here directly.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { healthProof } from "../src/auth.ts";
import { freePort } from "./freePort.ts";
import { TMUX_TEST_TMPDIR } from "./tmuxTmp.ts";
import { SERVER_BOOT_MS } from "./serverBoot.ts";

const require = createRequire(import.meta.url);
const shell = require("../../electron/server-probe.js") as {
  healthProof(token: string, port: number, nonce: string): string;
  probe(port: number, opts: { token: string | null; allowUnproven?: boolean; timeoutMs?: number }): Promise<"ours" | "foreign" | "free">;
};

const TOKEN = "orbit-test-token-0123456789abcdef";

type Seen = { url: string; auth: string | null };

/** A local server answering /health the way `answer` says, recording every request. */
function squatter(answer: (url: URL, port: number) => Record<string, unknown>) {
  const seen: Seen[] = [];
  const srv = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req, s) {
      const url = new URL(req.url);
      seen.push({ url: req.url, auth: req.headers.get("authorization") });
      return Response.json(answer(url, s.port!));
    },
  });
  return { srv, seen, port: srv.port! };
}

const marker = { ok: true, service: "agentglass", clients: 0 };

describe("the shell's probe", () => {
  test("computes the same proof as the server", () => {
    expect(shell.healthProof(TOKEN, 4000, "abc")).toBe(healthProof(TOKEN, 4000, "abc"));
    expect(shell.healthProof(TOKEN, 4000, "abc")).not.toBe(healthProof(TOKEN, 4001, "abc"));
  });

  test("does not adopt an impostor that only says it is agentglass, and sends it no token", async () => {
    const s = squatter(() => marker);
    try {
      expect(await shell.probe(s.port, { token: TOKEN, allowUnproven: false })).toBe("foreign");
      expect(s.seen.length).toBeGreaterThan(0);
      for (const r of s.seen) {
        expect(r.auth).toBeNull();
        expect(r.url).not.toContain(TOKEN);
      }
    } finally { s.srv.stop(true); }
  });

  test("does not adopt a server whose proof was made with another token", async () => {
    const s = squatter((u, port) => ({ ...marker, proof: healthProof("some-other-token", port, u.searchParams.get("challenge") ?? "") }));
    try {
      expect(await shell.probe(s.port, { token: TOKEN })).toBe("foreign");
    } finally { s.srv.stop(true); }
  });

  test("does not adopt a proof relayed from a genuine server on another port", async () => {
    // What a squatter gets by forwarding the challenge to a real server
    // elsewhere: an answer bound to that server's port, not this one.
    const s = squatter((u, port) => ({ ...marker, proof: healthProof(TOKEN, port + 1, u.searchParams.get("challenge") ?? "") }));
    try {
      expect(await shell.probe(s.port, { token: TOKEN })).toBe("foreign");
    } finally { s.srv.stop(true); }
  });

  test("does not adopt a server that replays a proof for another challenge", async () => {
    const s = squatter((_u, port) => ({ ...marker, proof: healthProof(TOKEN, port, "a-challenge-seen-earlier") }));
    try {
      expect(await shell.probe(s.port, { token: TOKEN })).toBe("foreign");
    } finally { s.srv.stop(true); }
  });

  test("adopts an unproven server only when told to, for a development shell", async () => {
    // `make desktop-dev` points the shell at `make dev`, whose server runs
    // without a token and has nothing to prove with. The packaged app never
    // passes allowUnproven.
    const s = squatter(() => marker);
    try {
      expect(await shell.probe(s.port, { token: TOKEN, allowUnproven: true })).toBe("ours");
    } finally { s.srv.stop(true); }
  });

  test("says free when nothing listens", async () => {
    expect(await shell.probe(await freePort(), { token: TOKEN })).toBe("free");
  });
});

describe("a real server", () => {
  let dir = "";
  let port = 0;
  let proc: ReturnType<typeof Bun.spawn> | null = null;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "agx-adopt-"));
    port = await freePort();
    proc = Bun.spawn(["bun", "run", new URL("../src/index.ts", import.meta.url).pathname], {
      env: {
        PATH: [dirname(process.execPath), "/usr/local/bin", "/usr/bin", "/bin"].join(":"),
        TMUX_TMPDIR: TMUX_TEST_TMPDIR,
        HOME: dir,
        XDG_CONFIG_HOME: join(dir, "config"),
        XDG_DATA_HOME: join(dir, "data"),
        XDG_CACHE_HOME: join(dir, "cache"),
        AGENTGLASS_STATE_DIR: join(dir, "state"),
        CLAUDE_CONFIG_DIR: join(dir, ".claude"),
        AGENTGLASS_ROOT: dir,
        AGENTGLASS_DB: join(dir, "f.db"),
        AGENTGLASS_SCAN_DISABLED: "1",
        AGENTGLASS_PORT: String(port),
        AGENTGLASS_TOKEN: TOKEN,
      },
      stdout: "ignore", stderr: "pipe",
    });
    for (let i = 0; i < 150; i++) {
      try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return; } catch { /* not up yet */ }
      await Bun.sleep(100);
    }
    throw new Error("the server did not come up: " + (await new Response(proc.stderr as ReadableStream).text()).slice(0, 400));
  }, SERVER_BOOT_MS);

  afterAll(() => {
    try { proc?.kill(); } catch { /* already gone */ }
    rmSync(dir, { recursive: true, force: true });
  });

  test("proves it holds the token, and is adopted without allowUnproven", async () => {
    expect(await shell.probe(port, { token: TOKEN, allowUnproven: false })).toBe("ours");
  });

  test("is not adopted by a shell holding a different token", async () => {
    expect(await shell.probe(port, { token: "a-rotated-token", allowUnproven: false })).toBe("foreign");
  });

  test("ignores an oversized challenge rather than hashing it", async () => {
    const j = (await (await fetch(`http://127.0.0.1:${port}/health?challenge=${"x".repeat(200)}`)).json()) as { proof?: string };
    expect(j.proof).toBeUndefined();
  });
});

// main.js is the Electron entry point and cannot be imported under bun, so the
// token paths past adoption are asserted against its source. What they hold:
// a sidecar that failed to come up (a squatter won the bind, or every port was
// taken) leaves apiOrigin pointing at a server nobody proved, and nothing may
// send it the token.
const main = await Bun.file(new URL("../../electron/main.js", import.meta.url)).text();
const body = (sig: string) => {
  const at = main.indexOf(sig);
  expect(at).toBeGreaterThan(-1);
  let depth = 0;
  for (let i = main.indexOf("{", at); i < main.length; i++) {
    if (main[i] === "{") depth++;
    else if (main[i] === "}" && --depth === 0) return main.slice(at, i + 1);
  }
  throw new Error("unbalanced " + sig);
};

describe("the shell after a failed start", () => {
  test("takes the token back from every window before reporting the failure", () => {
    const f = body("function reportSidecar(");
    const revoke = f.indexOf('"ag:server-changed", { token: null');
    expect(revoke).toBeGreaterThan(-1);
    expect(revoke).toBeLessThan(f.indexOf('"ag:server-failed"'));
  });

  test("does not hand a later window the token", () => {
    expect(main).toContain('e.returnValue = sidecarFailure ? null : currentToken()');
  });

  test("does not poll an unproven server with the token", () => {
    expect(main).toContain("token: () => (sidecarUp ? currentToken() : \"\")");
  });

  test("does not push the token after a restart that did not come up", () => {
    expect(body("async function restartSidecar(")).toContain("token: sidecarUp ? currentToken() : null");
  });
});
