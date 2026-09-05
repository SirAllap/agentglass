/*
 * A test that boots the real server writes wherever the server writes: the
 * browser audit log, the container ledger, the engine's tmux conf, all under
 * the state directory. Measured on 2026-09-05: twenty-four suites jailed
 * XDG_CONFIG_HOME and the database and left the state directory alone, and
 * the developer's real ~/.local/state/agentglass/browser-audit.log had grown
 * to 1.2 MB of test fixtures ("agent-four", "t-gone"). The tmux isolation
 * lint caught the same shape for sockets; this is the same lint for state.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const here = new URL(".", import.meta.url).pathname;

describe("every suite that boots the server", () => {
  test("names a state directory of its own", () => {
    const offenders: string[] = [];
    for (const f of readdirSync(here)) {
      if (!f.endsWith(".test.ts") || f === "server-boot-jails-state.test.ts") continue;
      const src = readFileSync(join(here, f), "utf8");
      if (!/Bun\.spawn\(\["bun", "run", [^\]]*index\.ts/.test(src)) continue;
      if (!/AGENTGLASS_STATE_DIR|XDG_STATE_HOME/.test(src)) offenders.push(f);
    }
    expect(offenders, "boots src/index.ts without AGENTGLASS_STATE_DIR or XDG_STATE_HOME in its env").toEqual([]);
  });
});
