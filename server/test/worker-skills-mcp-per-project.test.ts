/*
 * `workers.projectSkills` and `workers.mcpServers` are read per project, like
 * `agents.permissionMode`: a project's own value, else the app-wide one
 * (PER_PROJECT, preflightStore.ts). Turning either off for one project must
 * not change what another project's workers get.
 *
 * In-process, on the scratch database `bun test` gives every file.
 */
import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { db } from "../src/db.ts";
import * as preflightStore from "../src/preflightStore.ts";
import * as agentprobe from "../src/agentprobe.ts";

const dir = realpathSync(mkdtempSync(join(tmpdir(), "agx-skillsmcpproj-")));
const saved = {
  cfg: process.env.XDG_CONFIG_HOME, data: process.env.XDG_DATA_HOME, state: process.env.AGENTGLASS_STATE_DIR,
  tmux: process.env.AGENTGLASS_TMUX_PATH,
};
process.env.XDG_CONFIG_HOME = join(dir, "config");
process.env.XDG_DATA_HOME = join(dir, "data");
process.env.AGENTGLASS_STATE_DIR = join(dir, "state");

const { APP, putSetting, workerProjectSkills, workerMcpModes } = preflightStore;
const { promptHeadless } = await import("../src/agents/policystart.ts");

afterAll(() => {
  for (const [k, v] of [["XDG_CONFIG_HOME", saved.cfg], ["XDG_DATA_HOME", saved.data], ["AGENTGLASS_STATE_DIR", saved.state], ["AGENTGLASS_TMUX_PATH", saved.tmux]] as const) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  rmSync(dir, { recursive: true, force: true });
});

describe("workers.projectSkills and workers.mcpServers per project", () => {
  const orbit = "/home/acme/code/orbit";
  const other = "/home/acme/code/acme-v2";

  test("one project's projectSkills off leaves another project on", () => {
    putSetting(APP, "workers.projectSkills", true);
    putSetting(orbit, "workers.projectSkills", false);
    expect(workerProjectSkills(orbit)).toBe(false);
    expect(workerProjectSkills(other)).toBe(true);
  });

  test("a project with no value of its own takes the app-wide one", () => {
    putSetting(APP, "workers.projectSkills", false);
    expect(workerProjectSkills(other)).toBe(false);
    putSetting(orbit, "workers.projectSkills", true);
    expect(workerProjectSkills(orbit)).toBe(true);
  });

  test("one project's chosen MCP servers never leak into another project's list", () => {
    putSetting(APP, "workers.mcpServers", {});
    putSetting(orbit, "workers.mcpServers", { atlassian: "readOnly" });
    expect(workerMcpModes(orbit)).toEqual({ atlassian: "readOnly" });
    expect(workerMcpModes(other)).toEqual({});
  });
});

/*
 * A seatless worker (seatRoot null) has no seat of its own, but its turn 1
 * (index.ts, `policyRoot = seatRoot ?? projectRootOf(cwd) ?? workspaceRoot()
 * ?? cwd`) still reads `workers.projectSkills`/`workers.mcpServers` from the
 * project its cwd sits in. A resumed or switched turn must read the same row:
 * falling back to the app-wide one instead (as a bare `a.seatRoot` would)
 * drops the project's skills and MCP servers that turn 1 had, because
 * `agentglass-agent prompt` never carries a seat.
 *
 * Only `headlessTurn`'s own write of `mcp-config.json` into the run folder is
 * checked: it happens before `guardTurn`/`startGuarded`, which this test
 * breaks on purpose (a fake, failing tmux) because it cannot boot a real pane
 * in this sandbox.
 */
describe("a seatless worker's resume/switch extras read its cwd's project, same as turn 1", () => {
  const project = join(dir, "acme-v2");
  mkdirSync(project, { recursive: true });
  const brokenTmux = join(dir, "tmux-broken");
  writeFileSync(brokenTmux, "#!/bin/sh\necho 'server exited unexpectedly' >&2\nexit 1\n");
  chmodSync(brokenTmux, 0o755);

  const seed = (name: string) => {
    const now = Date.now();
    db.run(
      "INSERT OR REPLACE INTO named_agent (name, kind, cwd, pane_id, window_id, started_at, ended_at, seat_root, started_by, resume_id, exit_code) VALUES (?, 'claude', ?, '%9999', '@9999', ?, ?, NULL, ?, 'sess-1', 0)",
      [
        name, project, now, now,
        JSON.stringify({
          scope: "global", rule: "base", because: [], position: 0, role: "builder", engine: "claude", model: "sonnet",
          envelope: { write: "worktree", network: false, commit: false, docker: false, deny: [] }, headless: true, turnMinutes: 10, turn: 1,
        }),
      ],
    );
  };

  test("resume: the extras read the cwd project's root, same as turn 1, never the app-wide row", async () => {
    putSetting(APP, "workers.mcpServers", {});
    putSetting(project, "workers.mcpServers", { atlassian: "readOnly" });
    process.env.AGENTGLASS_TMUX_PATH = brokenTmux;
    /* The turn is refused before it reads the extras when the engine is not
       installed (a CI container has no claude). Bun.which does not see a PATH
       changed at run time, so the probe is told where the stand-in is. */
    const bin = join(dir, "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "claude"), "#!/bin/sh\necho '2.0.0 (Claude Code)'\n");
    chmodSync(join(bin, "claude"), 0o755);
    const realProbe = agentprobe.probeEngines;
    const probeSpy = spyOn(agentprobe, "probeEngines").mockImplementation((o = {}) => realProbe({ ...o, which: (c: string) => (c === "claude" ? join(bin, "claude") : Bun.which(c)) }));
    seed("w-seatless-resume");
    const namesSpy = spyOn(preflightStore, "workerMcpModes");
    const skillsSpy = spyOn(preflightStore, "workerProjectSkills");
    try {
      await promptHeadless({ name: "w-seatless-resume", seatRoot: null, cwd: project } as never, "go on");
      expect(namesSpy).toHaveBeenCalledWith(project);
      expect(skillsSpy).toHaveBeenCalledWith(project);
      for (const call of namesSpy.mock.calls) expect(call[0]).not.toBe(undefined);
    } finally {
      probeSpy.mockRestore();
      namesSpy.mockRestore();
      skillsSpy.mockRestore();
    }
  });
});
