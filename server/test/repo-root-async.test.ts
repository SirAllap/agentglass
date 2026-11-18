// repoRootOfAsync must not hold the event loop while git runs. A stub `git`
// that sleeps stands in for a slow repo; a timer ticking meanwhile proves the
// loop kept turning. The sync twin is the control: it must block on the same stub.
import { describe, expect, test, afterAll } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { __resetGitCapForTest, repoRootOf, repoRootOfAsync } from "../src/git.ts";

const dir = mkdtempSync(join(tmpdir(), "agx-slowgit-"));
const bin = join(dir, "bin");
Bun.spawnSync(["mkdir", bin]);
writeFileSync(join(bin, "git"), `#!/bin/sh\nsleep 0.6\necho ${dir}\n`);
chmodSync(join(bin, "git"), 0o755);
const realPath = process.env.PATH;
process.env.PATH = `${bin}:${realPath}`;
__resetGitCapForTest();
afterAll(() => {
  process.env.PATH = realPath;
  __resetGitCapForTest();
  rmSync(dir, { recursive: true, force: true });
});

async function worstGap(work: () => Promise<unknown> | unknown): Promise<number> {
  let last = performance.now();
  let worst = 0;
  const tick = setInterval(() => {
    const now = performance.now();
    worst = Math.max(worst, now - last);
    last = now;
  }, 20);
  await work();
  clearInterval(tick);
  worst = Math.max(worst, performance.now() - last);
  return worst;
}

describe("repoRootOfAsync", () => {
  test("loop keeps ticking while a slow git runs", async () => {
    let root = null as string | null;
    const gap = await worstGap(async () => { root = await repoRootOfAsync(dir); });
    expect(root).toBe(dir);
    expect(gap).toBeLessThan(300);
  });

  test("control: the sync twin blocks the loop on the same stub", async () => {
    const gap = await worstGap(async () => { await Promise.resolve(); repoRootOf(dir); });
    expect(gap).toBeGreaterThan(500);
  });
});
