/*
 * A file that sets an AGENTGLASS_* variable and never puts it back must not
 * hand it to the next file. See envscope.ts for how, and why a plugin.
 *
 * Three throwaway test files run by a child `bun test` in a scratch directory:
 * two leak AGENTGLASS_ROOT at load and a variable in a hook, the third states
 * what it expects to find. Run once WITHOUT the preload to show
 * the leak is real — a guard that is never seen red proves nothing — and once
 * with it.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "agx-envscope-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/* Symmetric, because the order bun runs files in is the directory's, not the
   name's: whichever runs second must find none of what the first left. */
for (const [me, other] of [["A", "B"], ["B", "A"]] as const) {
  writeFileSync(join(dir, `${me.toLowerCase()}.test.ts`), `import { beforeAll, expect, test } from "bun:test";
process.env.AGENTGLASS_ROOT = "/gone/after/file-${me}";
process.env.TMUX_TMPDIR = "/gone/after/file-${me}/tmux";
beforeAll(() => { process.env.AGENTGLASS_PROBE_${me} = "set in a hook"; });
test("${me} starts clean", () => {
  expect(process.env.AGENTGLASS_PROBE_${other}).toBeUndefined();
  expect(process.env.AGENTGLASS_ROOT).toBe("/gone/after/file-${me}");
});
`);
}
// The root each file sees before its own assignment is the other's, or none.
writeFileSync(join(dir, "c.test.ts"), `import { expect, test } from "bun:test";
test("C finds the root it was started with", () => {
  expect(process.env.AGENTGLASS_ROOT).toBe(process.env.ROOT_AT_START || undefined);
  // The tmux tests refuse any socket outside a TMUX_TMPDIR the process holds.
  expect(process.env.TMUX_TMPDIR).toBe(process.env.TMUX_AT_START || undefined);
});
`);

async function run(preload: boolean) {
  const cmd = ["bun", "test", ...(preload ? ["--preload", new URL("./envscope.ts", import.meta.url).pathname] : []), "a.test.ts", "b.test.ts", "c.test.ts"];
  const env: Record<string, string> = { ...process.env as Record<string, string>, ROOT_AT_START: process.env.AGENTGLASS_ROOT ?? "", TMUX_AT_START: process.env.TMUX_TMPDIR ?? "" };
  const p = Bun.spawn(cmd, { cwd: dir, env, stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  await p.exited;
  return { code: p.exitCode, text: out + err };
}

describe("the AGENTGLASS_* and TMUX_TMPDIR variables a test file leaves behind", () => {
  test("without the plugin the next file inherits them (the thing being fixed)", async () => {
    const r = await run(false);
    expect(r.code).not.toBe(0);
    expect(r.text).toMatch(/[1-9]\d* fail/);
  }, 30_000);

  test("with the plugin the next file starts from what the first one found", async () => {
    const r = await run(true);
    expect(r.text).toContain("3 pass");
    expect(r.code).toBe(0);
  }, 30_000);

  test("both bunfigs load it, from wherever the tests are started", async () => {
    const strip = (s: string) => s.split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");
    expect(strip(await Bun.file(new URL("../bunfig.toml", import.meta.url)).text())).toContain("./test/envscope.ts");
    expect(strip(await Bun.file(new URL("../../bunfig.toml", import.meta.url)).text())).toContain("./server/test/envscope.ts");
  });
});
