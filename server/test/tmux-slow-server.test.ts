/**
 * A slow tmux server must cost one timeout, not one per call in a loop.
 *
 * Measured: server-stall.log held 11.6 s, 11.8 s and 6.3 s stalls labelled
 * `tmux show-options`, and typing froze for 5-7 s. prefixKeys reads two
 * options in a row, each a blocking spawn that waits out TMUX_TIMEOUT_MS.
 * A stub `tmux` that sleeps stands in for the slow server; the probe runs in
 * its own process so the stub on PATH touches nothing else.
 */
import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

test("after one timeout the rest of a read loop answers at once", () => {
  const root = mkdtempSync(join(tmpdir(), "agx-slow-"));
  try {
    writeFileSync(join(root, "tmux"), "#!/bin/sh\nexec sleep 6\n");
    chmodSync(join(root, "tmux"), 0o755);
    const probe = `
      import { prefixKeys } from ${JSON.stringify(join(import.meta.dir, "../src/tmuxctl.ts"))};
      const t = { socket: ["-f", "/dev/null", "-L", "agx-slow-${process.pid}"], id: "$0" } as any;
      const a = performance.now();
      prefixKeys(t);
      console.log(Math.round(performance.now() - a));
    `;
    const r = Bun.spawnSync(["bun", "-e", probe], {
      stdout: "pipe", stderr: "pipe", env: { ...process.env, PATH: `${root}:${process.env.PATH}`, TMUX_TMPDIR: root },
    });
    const ms = Number(r.stdout.toString().trim().split("\n").pop());
    expect(Number.isFinite(ms)).toBe(true);
    // One timeout is 2000 ms. Two in a row is 4000+.
    expect(ms).toBeLessThan(3000);
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 20000);
