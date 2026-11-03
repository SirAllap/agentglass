/*
 * `--as "(default)"` IS `--shared`: `stamped` drops the field for that identity,
 * so the two requests are byte-identical on the wire. A lock over flag prefixes
 * cannot name a value the CLI maps onto the same identity, and `--profile`,
 * AGENTGLASS_PROFILE, padding and case are that name too.
 *
 * So the refusal is at the CLI's identity, once: while AGENTGLASS_ROLE names a
 * worker role (the app sets it when it starts a worker on either path), the
 * person's own container is refused under any spelling. This runs the real CLI
 * because the mapping is the thing being tested; no request is built.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cli = join(import.meta.dir, "../../bin/agentglass-browser");
const python = Bun.which("python3");
// No token, no state and no server of the person's: a refused call never
// reaches any of them, and a call that gets through stops on this instead.
const scratch = mkdtempSync(join(tmpdir(), "agx-cli-worker-id-"));

async function run(env: Record<string, string>, ...args: string[]): Promise<{ code: number; err: string }> {
  const base: Record<string, string> = {
    PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "",
    XDG_CONFIG_HOME: scratch, AGENTGLASS_BROWSER_STATE_DIR: join(scratch, "state"),
  };
  const p = Bun.spawn({ cmd: [python!, cli, ...args], env: { ...base, ...env }, stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  void out;
  return { code: await p.exited, err };
}

const ROLES = ["scout", "builder", "reviewer", "verifier"];

describe.skipIf(!python)("a worker's browser CLI refuses the person's own container", () => {
  test("every spelling of the shared identity and every worker role", async () => {
    const spellings: string[][] = [
      ["--shared", "read"],
      ["read", "--shared"],
      ["--as", "(default)", "read"],
      ["--as=(default)", "read"],
      ["--profile", "(default)", "read"],
      ["--as", " (DEFAULT) ", "read"],
    ];
    for (const role of ROLES) {
      for (const argv of spellings) {
        const r = await run({ AGENTGLASS_ROLE: role }, ...argv);
        expect({ role, argv, code: r.code }).toEqual({ role, argv, code: 2 });
        expect(r.err).toContain("runs as a worker role");
      }
    }
  });

  test("AGENTGLASS_PROFILE is the same identity and is refused with it", async () => {
    for (const role of ROLES) {
      const r = await run({ AGENTGLASS_ROLE: role, AGENTGLASS_PROFILE: "(default)" }, "read");
      expect({ role, code: r.code }).toEqual({ role, code: 2 });
      expect(r.err).toContain("runs as a worker role");
    }
  });

  test("only the shared identity is caught: a worker's own name still parses", async () => {
    // It gets past the identity check and stops for want of a server, which is
    // the proof the refusal is about the identity and not about workers.
    const r = await run({ AGENTGLASS_ROLE: "builder", AGENTGLASS_SERVER: "http://127.0.0.1:9" }, "--as", "orbit-1", "read");
    expect(r.err).not.toContain("runs as a worker role");
  });

  test("a verb the relay never runs for a worker is not sent to open a tab", async () => {
    const env = { AGENTGLASS_ROLE: "builder", AGENTGLASS_BROWSER_AS: "orbit-1", AGENTGLASS_SERVER: "http://127.0.0.1:9" };
    for (const argv of [["eval", "1+1"], ["cookies"], ["trace"]]) {
      const verb = argv[0]!;
      const r = await run(env, ...argv);
      expect({ verb, code: r.code }).toEqual({ verb, code: 1 });
      expect({ verb, says: r.err.includes(`does not run "${verb}" for a worker credential`) })
        .toEqual({ verb, says: true });
      expect({ verb, advisesOpening: r.err.includes("open one:") }).toEqual({ verb, advisesOpening: false });
    }
    // The same shell, a verb a worker does run, still gets the no-tab advice.
    const read = await run(env, "read");
    expect(read.err).toContain("open one:");
  });
});
