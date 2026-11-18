/*
 * AGENTGLASS_PORT set on purpose (an isolated test server) loses to the live
 * app's port file, by design — a pane inherits a stale one. The CLIs did it
 * silently, so a probe meant for :4713 opened tabs in the person's own app.
 * Each bin/ CLI now names both ports and AGENTGLASS_SERVER on stderr.
 * The port file points at a closed port, so nothing is reached.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = join(import.meta.dir, "..", "..");
const CLIS = ["agentglass-agent", "agentglass-browser", "agentglass-browser-mcp", "agentglass-cleanup", "agentglass-plugin", "agentglass-ui"];
const home = mkdtempSync(join(tmpdir(), "agx-portnote-"));
mkdirSync(join(home, "agentglass"));
const portFile = join(home, "agentglass", "port");
writeFileSync(portFile, "1\n");
afterAll(() => rmSync(home, { recursive: true, force: true }));

const stderrOf = async (cli: string, extra: Record<string, string>) => {
  const p = Bun.spawn(["python3", "-I", join(REPO, "bin", cli), "--help"], {
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, XDG_CONFIG_HOME: home, ...extra },
    stdin: "ignore", stdout: "ignore", stderr: "pipe",
  });
  const t = setTimeout(() => p.kill(), 8000);
  const err = await new Response(p.stderr).text();
  clearTimeout(t);
  return err;
};

describe.skipIf(!Bun.which("python3"))("a CLI told AGENTGLASS_PORT that the port file overrides", () => {
  for (const cli of CLIS) {
    test(`${cli} says which port it used and how to reach the other`, async () => {
      const err = await stderrOf(cli, { AGENTGLASS_PORT: "4713" });
      /* The way out is only for a test server: after the app restarts on
         another port, AGENTGLASS_PORT in a pane is the dead one, and advice
         to point AGENTGLASS_SERVER at it sent every later call there. */
      expect(err).toContain(`${cli}: using :1 from ${portFile}, not AGENTGLASS_PORT=4713. A pane can inherit a stale one, and then nothing is wrong. Only if you started a test server on :4713, set AGENTGLASS_SERVER=http://127.0.0.1:4713`);
    }, 10000);
  }

  test("silent when the two agree, or when AGENTGLASS_SERVER already decides", async () => {
    expect(await stderrOf("agentglass-browser", { AGENTGLASS_PORT: "1" })).not.toContain("AGENTGLASS_PORT=");
    expect(await stderrOf("agentglass-browser", { AGENTGLASS_PORT: "4713", AGENTGLASS_SERVER: "http://127.0.0.1:1" })).not.toContain("AGENTGLASS_PORT=");
  }, 20000);
});
