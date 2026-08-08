/*
 * A sidecar that never starts must not be silent, and must not take the app
 * with it.
 *
 * TWO FAULTS, one door. `ensureServer` polled forty times at 300ms and then
 * fell off the end of its loop returning `undefined` — the same value it
 * returns on success — with `void ensureServer(adopt)` as its only caller: no
 * `then`, no `catch`, no flag. `createWindow()` had already run, so the app was
 * on screen with a configured, apparently verified origin and nothing behind
 * it. And the `spawn` had no `error` listener at all, which for a missing
 * binary is not a degraded start but no start: measured on Node, `spawn` does
 * NOT throw for ENOENT, it emits `error` asynchronously, and an unhandled
 * `error` on an EventEmitter is re-thrown — in the main process, that is the
 * whole app.
 *
 * Driven for real, against the actual electron/main.js, because both faults are
 * in the WIRING and every shape that could see them is a shape that runs it.
 * The `electron` module is stubbed (see fixtures/electron-stub.cjs) so this
 * needs no display: nothing appears on anybody's screen, and the machine this
 * was written on has no virtual one — Electron's own `--ozone-platform=headless`
 * was tried first and segfaults here on EGL.
 *
 * Every spawn gets its own PATH, its own XDG_CONFIG_HOME and a port the kernel
 * says is free, so a real agentglass running on this machine is neither adopted
 * nor disturbed — and neither is the copy of this suite running next door.
 *
 * The port used to be a literal (4831/4841/4851), which is the failure
 * `freePort.ts` was written about and this file was the last to keep. Two
 * overlapping runs and the loser's fake server cannot bind; the shell's health
 * poll then reaches the WINNER's server, which answers `{"ok":true,
 * "service":"agentglass"}` and cannot be told apart by that route. The loser
 * sees a sidecar that came up, emits one report instead of two, and
 * `expect(said).toHaveLength(2)` fails in a file nobody touched.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { freePort } from "./freePort.ts";

const ELECTRON = new URL("../../electron", import.meta.url).pathname;
const STUB = new URL("./fixtures/electron-stub.cjs", import.meta.url).pathname;
const NODE = Bun.which("node");
const HAVE = !!NODE && process.platform === "linux";

/** A dev-mode start spawns `bun run server/src/index.ts`, so what is on PATH
 *  decides which failure this is. Node itself must stay reachable — it is the
 *  thing running the harness. */
const SYS_PATH = "/usr/bin:/bin:/usr/local/bin";

const dirs: string[] = [];
function scratch(): string {
  const d = join(tmpdir(), `agx-shell-${process.pid}-${dirs.length}`);
  mkdirSync(join(d, "cfg"), { recursive: true });
  mkdirSync(join(d, "bin"), { recursive: true });
  dirs.push(d);
  return d;
}
afterAll(() => { for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* fine */ } } });

/**
 * Run electron/main.js under node and hand back every IPC message it sent.
 *
 * The loader below is the whole trick: `Module._resolveFilename` is patched so
 * `require("electron")` lands on the stub. `main.js` is otherwise untouched —
 * same file, same order, same `app.whenReady()` path.
 */
async function runShell(opts: { path: string; port: number; home: string; expect: number }): Promise<{ code: number | null; ipc: { channel: string; payload: unknown }[]; out: string }> {
  const loader = `
    const Module = require("module");
    const orig = Module._resolveFilename;
    Module._resolveFilename = function (req, ...rest) {
      if (req === "electron") return ${JSON.stringify(STUB)};
      return orig.call(this, req, ...rest);
    };
    require(${JSON.stringify(join(ELECTRON, "main.js"))});
    // Long enough to cover the give-up (40 x 300ms) plus the spawn, and it is a
    // ceiling rather than a wait: every case here reports well before it.
    setTimeout(() => process.exit(0), 20000);
  `;
  const proc = Bun.spawn([NODE!, "-e", loader], {
    cwd: ELECTRON,
    env: {
      PATH: opts.path,
      HOME: opts.home,
      XDG_CONFIG_HOME: join(opts.home, "cfg"),
      AGX_PROBE_HOME: opts.home,
      AGENTGLASS_PORT: String(opts.port),
      // Leave as soon as this many reports have gone out, rather than sitting
      // out the ceiling above. See the note on `send` in the stub.
      AGX_PROBE_EXIT_AFTER: String(opts.expect),
    },
    stdout: "pipe", stderr: "pipe",
  });
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  const ipc = out.split("\n").flatMap((line) => {
    const m = /^AGX-IPC (\S+) (.*)$/.exec(line);
    if (!m) return [];
    try { return [{ channel: m[1]!, payload: JSON.parse(m[2]!) }]; } catch { return []; }
  });
  return { code, ipc, out: out + err };
}

const failure = (r: Awaited<ReturnType<typeof runShell>>) =>
  r.ipc.filter((m) => m.channel === "ag:server-failed").map((m) => m.payload as Record<string, unknown> | null);

describe.if(HAVE)("the shell when its sidecar will not start", () => {
  test("a missing server program does not kill the app — it is reported", async () => {
    const home = scratch();
    const r = await runShell({ path: SYS_PATH, port: await freePort(), home, expect: 1 });

    /*
     * THE ASSERTION THIS FILE EXISTS FOR. On the version before the fix this is
     * exit 1 with `Error: spawn bun ENOENT` and an "Unhandled 'error' event"
     * stack on stderr — measured through this exact harness. A packaged build
     * whose sidecar had not been copied in did not start badly, it did not
     * start.
     */
    expect(r.code).toBe(0);
    expect(r.out).not.toContain("Unhandled 'error' event");

    const said = failure(r);
    // Once, and not twice. Both the `exit` listener and the give-up at the end
    // of the poll can describe a startup failure, and with both reporting the
    // same one came out twice — measured, and fixed by giving the loop the
    // verdict while it is still waiting.
    expect(said).toHaveLength(1);
    expect(said[0]).toMatchObject({ reason: "missing" });
    // Named, because "the server is missing" is not actionable and "this file
    // is missing" is. `bun` here; the compiled sidecar's path in a package.
    expect(String(said[0]!.where)).toContain("bun");
    expect(String(said[0]!.fix)).toBeTruthy();
  }, 60_000);

  test("a server that starts and dies is told apart from one that is missing", async () => {
    const home = scratch();
    const fake = join(home, "bin", "bun");
    writeFileSync(fake, "#!/bin/sh\necho 'error: EADDRINUSE 0.0.0.0:'\"$AGENTGLASS_PORT\" >&2\nexit 1\n");
    chmodSync(fake, 0o755);
    const port = await freePort();
    const r = await runShell({ path: `${join(home, "bin")}:${SYS_PATH}`, port, home, expect: 1 });

    expect(r.code).toBe(0);
    const said = failure(r);
    expect(said).toHaveLength(1);
    expect(said[0]).toMatchObject({ reason: "exited" });
    /*
     * The server's OWN words. `stdio: "ignore"` used to send them to /dev/null,
     * which threw away the only text that names the real cause — and a bind
     * clash is the commonest cause there is. Piped and drained rather than
     * buffered: a pipe nobody reads fills at 64KB and blocks the writer, so a
     * chatty server would hang instead of running.
     */
    expect(String(said[0]!.detail)).toContain("EADDRINUSE");
    // The port is in the fix text because "something else may hold it" is only
    // actionable with the number; asserted against the one this run was given.
    expect(String(said[0]!.fix)).toContain(String(port));
  }, 60_000);

  test("a server that comes up says so, and its later death is its own event", async () => {
    const home = scratch();
    const fake = join(home, "bin", "bun");
    // Answers /health as agentglass for a moment, then dies. Two events, in
    // order: the recovery that clears the banner, and the death that brings it
    // back with different words — "it was running and stopped" is not "check
    // whether something else holds the port".
    writeFileSync(fake, `#!/usr/bin/env python3
import http.server, socketserver, threading, os, sys, json, time
socketserver.TCPServer.allow_reuse_address = True
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        b = json.dumps({"service": "agentglass", "ok": True, "clients": 0}).encode()
        self.send_response(200); self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(b))); self.end_headers(); self.wfile.write(b)
    def log_message(self, *a): pass
srv = socketserver.TCPServer(("127.0.0.1", int(os.environ["AGENTGLASS_PORT"])), H)
threading.Thread(target=srv.serve_forever, daemon=True).start()
time.sleep(3)
print("fatal: the database went away", file=sys.stderr)
os._exit(3)
`);
    chmodSync(fake, 0o755);
    const r = await runShell({ path: `${join(home, "bin")}:${SYS_PATH}`, port: await freePort(), home, expect: 2 });

    expect(r.code).toBe(0);
    const said = failure(r);
    expect(said).toHaveLength(2);
    // Null first: a server that answered is a banner that must come DOWN. A
    // report that only ever appeared would be a permanent lie after the next
    // successful restart.
    expect(said[0]).toBeNull();
    expect(said[1]).toMatchObject({ reason: "exited" });
    expect(String(said[1]!.what)).toContain("was running and stopped");
    expect(String(said[1]!.detail)).toContain("the database went away");
  }, 60_000);
});
