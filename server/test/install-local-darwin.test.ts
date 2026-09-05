/*
 * install-local.sh on a Mac: refuse first, not fail in the middle.
 *
 * The script is the Linux install end to end — linux-unpacked, ~/.local/share,
 * a .desktop file. On a Mac it used to spend the packaging minutes and then
 * stop at the first path that was another OS's, with a message blaming
 * electron-builder. It now checks the OS before doing anything and prints what
 * a Mac does instead: the .dmg, named per architecture as the release job
 * names it.
 *
 * Driven for real: the script runs under bash with a `uname` on PATH that
 * answers Darwin, and with `node` and `bunx` stubbed to leave a mark — so the
 * assertion "it never started packaging" is a fact about a run, not a reading
 * of the text.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "..", "..", "electron", "install-local.sh");
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* fine */ } } });

/** A PATH whose `uname` says `os`, and whose `node`/`bunx` record being called. */
function fakeMachine(os: string): { path: string; mark: string } {
  const d = join(tmpdir(), `agx-install-darwin-${process.pid}-${dirs.length}`);
  dirs.push(d);
  mkdirSync(join(d, "bin"), { recursive: true });
  const mark = join(d, "packaged");
  const tool = (name: string, body: string) => {
    writeFileSync(join(d, "bin", name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(d, "bin", name), 0o755);
  };
  tool("uname", `echo ${os}`);
  tool("node", `touch ${JSON.stringify(mark)}; exit 0`);
  tool("bunx", `touch ${JSON.stringify(mark)}; exit 0`);
  // The real ones stay reachable for everything else the script needs (cat,
  // dirname, mkdir…) — after our directory, so ours win.
  return { path: `${join(d, "bin")}:/usr/bin:/bin`, mark };
}

async function run(os: string): Promise<{ code: number; err: string; mark: string }> {
  const m = fakeMachine(os);
  const p = Bun.spawn(["bash", SCRIPT], {
    env: { PATH: m.path, HOME: join(tmpdir(), `agx-install-darwin-home-${process.pid}`) },
    stdout: "pipe", stderr: "pipe",
  });
  const err = await new Response(p.stderr).text();
  const code = await p.exited;
  return { code, err, mark: m.mark };
}

describe("install-local.sh on Darwin", () => {
  test("stops before packaging, with a distinct exit code and the .dmg names for both architectures", async () => {
    const r = await run("Darwin");
    expect(r.code).toBe(2);
    expect(existsSync(r.mark)).toBe(false); // neither node build.mjs nor electron-builder ran
    expect(r.err).toContain("has no macOS half");
    expect(r.err).toContain("agentglass_<version>_arm64.dmg");
    expect(r.err).toContain("agentglass_<version>_x64.dmg");
    expect(r.err).toContain("/releases/latest");
    // And not the old, wrong diagnosis.
    expect(r.err).not.toContain("electron-builder did not produce");
  });

  test("on Linux the check is silent and the script goes on to package", async () => {
    // The stubbed `node` exits 0 without producing anything, so the script
    // fails a little later at the linux-unpacked check — which is exactly the
    // point: it got past the OS gate and started the build.
    const r = await run("Linux");
    expect(existsSync(r.mark)).toBe(true);
    expect(r.err).not.toContain("has no macOS half");
  });
});
