/*
 * `kill-server` returns before the server has gone, and a test that starts the
 * same server again straight after talks to one on its way out.
 *
 * engine-window-no-empty failed twice inside a full `make check` and passed
 * alone every time: its fourth and fifth steps `kill-server` and then make a
 * session at once, and `engineWindowRunning` answered null — tmux had said
 * `server exited unexpectedly` to the new client. Reproduced with ten busy
 * loops beside a kill-server / new-session loop on an isolated socket, 14 % of
 * cycles failed, none when idle. `killServerAndWait` is the fix; this file is
 * what stops it being undone.
 *
 * The first two tests use a stand-in for tmux whose kill-server returns at
 * once and whose "server" (a `sleep`) dies 300 ms later, so they do not depend
 * on how loaded the machine is: a helper that stops waiting at the kill goes
 * red on every run.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { killServerAndWait, socketDirUnder } from "./tmuxTmp.ts";

const REAL_TMPDIR = process.env.TMUX_TMPDIR;
let tmp = "";
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "agx-ksw-"));
  process.env.TMUX_TMPDIR = tmp;
});
afterAll(() => {
  if (REAL_TMPDIR === undefined) delete process.env.TMUX_TMPDIR;
  else process.env.TMUX_TMPDIR = REAL_TMPDIR;
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

/** A tmux whose kill-server is slow to take effect, like the real one under load. */
function slowDyingServer(dieAfterMs: number) {
  const server = Bun.spawn(["sleep", "60"]);
  const run = async (args: string[]) => {
    if (args[0] === "display-message") return { ok: true, stdout: `${server.pid}\n` };
    if (args[0] === "kill-server") { setTimeout(() => server.kill(), dieAfterMs); return { ok: true, stdout: "" }; }
    return { ok: false, stdout: "" };
  };
  return { server, run };
}

describe("killServerAndWait", () => {
  it("does not return while the server's process is still there, and takes its socket file", async () => {
    const dir = socketDirUnder(tmp);
    mkdirSync(dir, { recursive: true });
    const sock = join(dir, "agx-ksw-sock");
    writeFileSync(sock, "");
    const { server, run } = slowDyingServer(300);
    try {
      const t0 = Date.now();
      await killServerAndWait(run, "agx-ksw-sock");
      expect(Date.now() - t0).toBeGreaterThanOrEqual(250);
      expect(() => process.kill(server.pid, 0)).toThrow();
      expect(existsSync(sock)).toBe(false);
    } finally { server.kill(); }
  });

  it("throws, rather than carry on, for a server that will not die", async () => {
    const server = Bun.spawn(["sleep", "60"]);
    const run = async (args: string[]) => ({ ok: true, stdout: args[0] === "display-message" ? `${server.pid}\n` : "" });
    try {
      await expect(killServerAndWait(run, "agx-ksw-none", 100)).rejects.toThrow(/still running/);
    } finally { server.kill(); }
  });

  it("is what engine-window-no-empty uses between its servers: no bare kill-server mid-file", async () => {
    // The file's afterAll is the one place a bare kill is right: nothing is
    // started after it. Comment lines are dropped so the prose above cannot count.
    const src = (await Bun.file(join(import.meta.dir, "engine-window-no-empty.test.ts")).text())
      .split("\n").filter((l) => !/^\s*(\/\/|\/?\*)/.test(l)).join("\n");
    expect(src.match(/tmux\(\["kill-server"\]\)/g) ?? []).toHaveLength(1);
    expect(src.match(/killServerAndWait\(tmux, SOCKET\)/g) ?? []).toHaveLength(2);
  });
});
