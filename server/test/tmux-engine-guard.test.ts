/*
 * Under NODE_ENV=test, tmux()/tmuxSync() must refuse — and spawn nothing — when
 * TMUX_TMPDIR is not a private directory. Run in a child with a `tmux` stub
 * first on PATH that writes a marker file if it is ever executed.
 */
import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync, chmodSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TMUX_TEST_TMPDIR } from "./tmuxTmp.ts";

const SRC = join(import.meta.dir, "../src/tmuxpane.ts");

function run(tmuxTmpdir: string | undefined, underBun = true) {
  const dir = mkdtempSync(join(tmpdir(), "agx-guard-"));
  const marker = join(dir, "ran");
  mkdirSync(join(dir, "bin"));
  writeFileSync(join(dir, "bin/tmux"), `#!/bin/sh\ntouch ${marker}\nexit 0\n`);
  chmodSync(join(dir, "bin/tmux"), 0o755);
  const env: Record<string, string> = {
    PATH: `${dir}/bin:${process.env.PATH}`, HOME: dir, NODE_ENV: "test", TMPDIR: tmpdir(),
    AGENTGLASS_TMUX_PATH: join(dir, "bin/tmux"), XDG_CONFIG_HOME: join(dir, "cfg"),
  };
  if (underBun) env.AGX_UNDER_BUN_TEST = "1";
  if (tmuxTmpdir) env.TMUX_TMPDIR = tmuxTmpdir;
  const code = `import { tmux, tmuxSync, engineAttachArgv } from ${JSON.stringify(SRC)};
    const a = await tmux(["list-sessions"]); const b = tmuxSync(["list-sessions"]);
    console.log(JSON.stringify([a.ok, b.ok, a.stderr, b.stderr, engineAttachArgv("/home/someone/code/orbit")]));`;
  const r = Bun.spawnSync([process.execPath, "-e", code], { env, stdout: "pipe", stderr: "pipe" });
  return { out: new TextDecoder().decode(r.stdout).trim() || new TextDecoder().decode(r.stderr), ran: existsSync(marker) };
}

describe("engine socket guard under test", () => {
  it("refuses and spawns nothing with TMUX_TMPDIR unset", () => {
    const { out, ran } = run(undefined);
    const [a, b, ea, eb] = JSON.parse(out.split("\n").pop()!);
    expect([a, b]).toEqual([false, false]);
    expect(ea).toContain("refused under test");
    expect(eb).toContain("refused under test");
    expect(ran).toBe(false);
  });
  it("engineAttachArgv is null while the guard refuses", () => {
    const { out } = run(undefined);
    expect(JSON.parse(out.split("\n").pop()!)[4]).toBeNull();
  });
  it("NODE_ENV=test alone (no bun-test marker) is not refused: a person's shell cannot break the app", () => {
    const { out } = run(undefined, false);
    expect(JSON.parse(out.split("\n").pop()!)[2]).not.toContain("refused under test");
  });
  it("a TMUX_TMPDIR with a trailing slash is still private", () => {
    expect(run(TMUX_TEST_TMPDIR + "/").ran).toBe(true);
  });
  it("the mirror sweeper is not started under the guard", () => {
    expect(require("node:fs").readFileSync(join(import.meta.dir, "../src/index.ts"), "utf8"))
      .toContain("if (!engineRefused()) startMirrorSweeper(");
  });
  it("refuses a TMUX_TMPDIR that does not exist", () => {
    expect(run("/nonexistent-agx-guard").ran).toBe(false);
  });
  it("refuses TMUX_TMPDIR that resolves to the live engine's place", () => {
    const uid = process.getuid?.() ?? 0;
    for (const d of ["/tmp", `/tmp/tmux-${uid}`, `/tmp/../tmp`]) {
      if (!existsSync(d)) continue;
      expect(run(d).ran).toBe(false);
    }
  });
  it("lets a private TMUX_TMPDIR through to the spawn", () => {
    expect(run(TMUX_TEST_TMPDIR).ran).toBe(true);
  });
});
