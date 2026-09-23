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
