/* Two worktrees share one stash stack; a failed op must pop its OWN stash.
   And one checkout is one write turn whatever path spells it. */
import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitWriteTurn, withAutoStash } from "../src/gitwork.ts";

const sh = (cwd: string, ...a: string[]) => {
  const r = Bun.spawnSync(["git", "-c", "user.email=t@t", "-c", "user.name=t", ...a], { cwd, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function repo() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "agx-stashrace-")));
  const a = join(base, "a");
  mkdirSync(join(a, "sub"), { recursive: true });
  sh(base, "init", "-q", "-b", "main", a);
  writeFileSync(join(a, "sub", "f"), "x");
  sh(a, "add", "."); sh(a, "commit", "-qm", "init");
  const b = join(base, "b");
  sh(a, "worktree", "add", "-q", "-b", "other", b);
  return { a, b };
}

test("a failed op pops its own stash, not the other worktree's", async () => {
  const { a, b } = repo();
  writeFileSync(join(a, "only-a"), "a");
  writeFileSync(join(b, "only-b"), "b");
  const fail = (ms: number) => async () => { await sleep(ms); return { ok: false, error: "boom" }; };
  const ra = withAutoStash(a, fail(400));
  await sleep(150);
  const rb = withAutoStash(b, fail(600));
  await Promise.all([ra, rb]);
  expect(existsSync(join(a, "only-a"))).toBe(true);
  expect(existsSync(join(a, "only-b"))).toBe(false);
  expect(existsSync(join(b, "only-b"))).toBe(true);
  expect(existsSync(join(b, "only-a"))).toBe(false);
});

test("a subdirectory of a checkout shares its write turn", async () => {
  const { a } = repo();
  const rel = await gitWriteTurn(a);
  let got = false;
  const second = gitWriteTurn(join(a, "sub")).then((r) => { got = true; return r; });
  await sleep(300);
  expect(got).toBe(false);
  rel();
  (await second)();
});
