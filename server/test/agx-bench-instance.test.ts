/**
 * agx-bench's launcher (scripts/agx-bench/instance.sh), asserted against its
 * source: starting it for real needs a desktop, which the suite does not have.
 */
import { describe, expect, test } from "bun:test";

const SH = await Bun.file(new URL("../../scripts/agx-bench/instance.sh", import.meta.url)).text();
/* Comment lines out, so a sentence ABOUT a command is not the command. */
const CODE = SH.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");

describe("the isolated instance", () => {
  /* Measured: a bench instance's own database reached 431 MB in half an hour
     and filled the user's /tmp quota — the sidecar was importing every agent
     transcript under the real HOME, which the bench never reads and which is
     nobody's business to copy into a scratch directory. The other harnesses
     in scripts/ already switch the scan off; the launcher did not. */
  test("the launcher switches the transcript scan off", () => {
    const env = CODE.slice(CODE.indexOf("start)"), CODE.indexOf('> "$DIR/launch.env"'));
    expect(env).toContain("export AGENTGLASS_SCAN_DISABLED=1");
  });
});

describe("the window never lands on a screen", () => {
  /* A headless output shows up to the person as a second monitor and breaks
     their screenshots, so the launcher never creates one: the window goes,
     silent and unfocused, to a workspace of the real monitor nobody uses, and
     `start` refuses while that workspace is the one on screen. */
  test("no virtual output is created, or removed", () => {
    expect(CODE).not.toMatch(/hyprctl output (create|remove)/);
    expect(CODE).not.toContain("hl.monitor(");
  });

  test("the window goes to its workspace silently, without focus, and start checks it landed there", () => {
    expect(CODE).toMatch(/WS=\$\{AGX_BENCH_WORKSPACE:-5\}/);
    expect(CODE).toContain('workspace = \\"$WS silent\\"');
    expect(CODE).toContain("no_initial_focus = true");
    expect(CODE).toContain("activeWorkspace']['id']==$WS");
    expect(CODE).toContain(`if [ "\${AT:-}" != "$WS" ]; then`);
  });
});
