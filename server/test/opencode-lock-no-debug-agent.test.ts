/*
 * OpenCode 2.x has no `debug agent <name>`, and nothing else it ships reports an
 * agent's merged rules (measured on 2.1.4: `debug agents` lists nothing,
 * `debug config` lists files). A lock nobody can check must refuse the worker,
 * with a message that says which OpenCode and what to do. The OpenCode here is a
 * script on disk, so the test does not depend on the installed one.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as ops from "../src/agentops.ts";

const dir = mkdtempSync(join(tmpdir(), "agx-oc-nodebug-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function fake(name: string, body: string): string {
  const file = join(dir, name);
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, 0o755);
  return file;
}
const lock = JSON.stringify({ default_agent: "build", permission: { bash: { "git push *": "deny" } } });
const env = { OPENCODE_CONFIG_CONTENT: lock };
const v2 = (extra = "") => `if [ "$1" = --version ]; then echo "opencode v2.1.4"; exit 0; fi\n${extra}echo 'Unknown subcommand "agent" for "opencode debug"' >&2; exit 1`;

describe.skipIf(process.platform !== "linux")("a locked worker needs an OpenCode that can show its rules", () => {
  test("2.x without `debug agent`: refused, saying the version, why and what to do", async () => {
    const why = await ops.openCodeLockLoosened(fake("v2", v2()), dir, env);
    expect(why).not.toBeNull();
    expect(why).toContain("OpenCode 2.1.4");
    expect(why).toContain("cannot show the rules");
    expect(why).toContain("Put this role on Claude");
  });

  test("it does not even say the version when OpenCode will not: still refused", async () => {
    const why = await ops.openCodeLockLoosened(fake("mute", `exit 1`), dir, env);
    expect(why).toContain("cannot show the rules");
  });

  test("the old `debug agent` still works: a lock that holds passes, a loosened one is named", async () => {
    const rules = (action: string) => JSON.stringify({ permission: [{ permission: "bash", pattern: "git push *", action }] });
    const holds = fake("old-holds", `[ "$1 $2" = "debug agent" ] && { printf '%s' '${rules("deny")}'; exit 0; }\nexit 1`);
    const loose = fake("old-loose", `[ "$1 $2" = "debug agent" ] && { printf '%s' '${rules("allow")}'; exit 0; }\nexit 1`);
    expect(await ops.openCodeLockLoosened(holds, dir, env)).toBeNull();
    expect(await ops.openCodeLockLoosened(loose, dir, env)).toContain("git push");
  });

  test("garbage on stdout with exit 0 is refused, not vouched for", async () => {
    const why = await ops.openCodeLockLoosened(fake("garbage", `echo 'not json at all'`), dir, env);
    expect(why).toContain("could not be read");
  });
});
