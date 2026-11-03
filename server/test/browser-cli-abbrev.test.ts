/*
 * `--share` is `--shared` spelled shorter: argparse takes any unambiguous
 * prefix of a long option. A worker's lock names the whole flag, so the CLI
 * refuses a prefix outright rather than letting it walk past the rule. This
 * runs the real CLI, because the parser is the thing being tested.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const cli = join(import.meta.dir, "../../bin/agentglass-browser");
const python = Bun.which("python3");

async function run(...args: string[]): Promise<{ code: number; err: string; out: string }> {
  const p = Bun.spawn({ cmd: [python!, cli, ...args], stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return { code: await p.exited, err, out };
}

describe.skipIf(!python)("the browser CLI refuses an abbreviated global flag", () => {
  test("a prefix of --shared, --active or --page is not a flag", async () => {
    for (const argv of [["--share", "read"], ["read", "--share"], ["--acti", "read"], ["read", "--acti"], ["--pag", "t9-ef01", "read"], ["read", "--pag", "t9-ef01"]]) {
      const r = await run(...argv);
      expect({ argv, code: r.code }).toEqual({ argv, code: 2 });
      expect(r.err).toMatch(/unrecognized arguments|invalid choice/);
    }
  });

  test("the verb and its own name still parse, before and after it", async () => {
    for (const argv of [["--as", "orbit-1", "observe", "--help"], ["observe", "--as", "orbit-1", "--help"]]) {
      const r = await run(...argv);
      expect({ argv, code: r.code }).toEqual({ argv, code: 0 });
      expect(r.out).toContain("observe");
    }
  });

  test("a person's ordinary prefix still parses (S4)", async () => {
    // Only the three locked names are kept whole. `--max-t` and `--sho` are
    // prefixes argparse has always taken, and nobody's script broke for them.
    for (const argv of [["--max-t", "5", "observe", "--help"], ["--sho", "observe", "--help"]]) {
      const r = await run(...argv);
      expect({ argv, code: r.code }).toEqual({ argv, code: 0 });
      expect(r.out).toContain("observe");
    }
  });
});
