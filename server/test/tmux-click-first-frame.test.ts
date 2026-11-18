/* The first `session` / `locksession` click had no frame to check the name
   against and was dropped. It now waits for the first read. A stand-in `tmux`
   answers, so no real server is needed. */
import { afterAll, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TMUX_ISOLATED } from "./tmuxIsolated.ts";

const dir = mkdtempSync(join(tmpdir(), "agx-faketmux-"));
const frame = ["C-a", "agx-prefix-end", "c\t/dev/pts/9\tmain\t$0\t80\t24\toff\t1", "w\t$0\t@0\t0\tmain\t1\t\t\t80\t24", "w\t$1\t@1\t0\tother\t1\t\t\t80\t24"].join("\\n");
writeFileSync(join(dir, "tmux"), `#!/bin/sh
case "$*" in
  *"#{pid}"*) echo 4242 ;;
  *set-environment*) ;;
  *show-environment*) echo "A=1" ;;
  *) printf '${frame}\\n' ;;
esac
`);
chmodSync(join(dir, "tmux"), 0o755);
// Every test file shares this process (AGENTS.md): a stand-in tmux left on PATH
// answered every later tmux test with this fake frame, 60 failures in one run.
const realPath = process.env.PATH;
process.env.PATH = `${dir}:${realPath}`;
afterAll(() => { process.env.PATH = realPath; rmSync(dir, { recursive: true, force: true }); });

const { readFrameCachedWaiting, readFrameCached } = await import("../src/tmuxctl.ts");

test("the first read of a socket is waited for, not answered with null", async () => {
  const c = { socket: [...TMUX_ISOLATED, "-L", "agx-first-click"], tty: "/dev/pts/9" } as never;
  expect(readFrameCached(c, 1_000)).toBeNull(); // the old caller's answer
  const f = await readFrameCachedWaiting(c, 1_000);
  expect(f).not.toBeNull();
});
