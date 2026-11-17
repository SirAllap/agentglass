/*
 * workers.unixSockets: the sandbox's Unix-socket keys.
 *
 * Off must leave the sandbox exactly as it was, since no socket key
 * existed before the setting; "all" is the CLI's own
 * all-sockets switch. There is no "tmux and adb only": `allowUnixSockets`
 * opened nothing in a real turn (see socketKeys). The setting is per project and an agent may only
 * narrow it.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sandboxFor } from "../src/agents/headless.ts";
import { workerRole } from "../../shared/workerRoles.ts";
import type { Envelope } from "../../shared/orchestration.ts";
import { workerUnixSockets } from "../src/preflightStore.ts";
import { classOf } from "../../shared/settingClass.ts";

const builder = workerRole("builder")!;
const env: Envelope = { write: "worktree", commit: true, network: false, docker: false, deny: [] };

describe("workers.unixSockets in the sandbox", () => {
  const cwd = mkdtempSync(join(tmpdir(), "agx-sock-"));
  const net = (s?: "off" | "all") => (sandboxFor(builder, env, cwd, undefined, s) as { network: Record<string, unknown> }).network;

  test("off writes no socket key, so the sandbox is byte-identical to before", () => {
    const before = JSON.stringify(sandboxFor(builder, env, cwd));
    expect(JSON.stringify(sandboxFor(builder, env, cwd, undefined, "off"))).toBe(before);
    expect(Object.keys(net())).toEqual(["allowedDomains", "strictAllowlist", "allowLocalBinding"]);
  });
  test("all is the CLI's all-sockets switch", () => {
    expect(net("all").allowAllUnixSockets).toBe(true);
  });
  test("the sandbox's other keys do not move with the setting", () => {
    const strip = (n: Record<string, unknown>) => ({ ...n, allowAllUnixSockets: undefined });
    expect(strip(net("all"))).toEqual(strip(net()));
  });
  test("a project with nothing set reaches no Unix socket: \"all\" opens the docker socket and the ssh-agent, so it is never the default", () => {
    expect(workerUnixSockets("/home/a/orbit-nothing-set")).toBe("off");
  });
  test("cleanup", () => { rmSync(cwd, { recursive: true, force: true }); });
});

describe("workers.unixSockets as a setting", () => {
  test("an escalation an agent may only narrow", () => {
    const row = classOf("workers.unixSockets")!;
    expect(row.class).toBe("escalation");
    expect(row.narrows?.("all", "off")).toBe(true);
    expect(row.narrows?.("off", "all")).toBe(false);
  });
});
