// The server-side hook installer (#187). It writes ~/.claude/settings.json so a
// packaged install can turn on streaming + gating from a button, and it is a
// port of hooks/install_hooks.py — so the property that matters most is that the
// two AGREE: either can undo the other, and neither disturbs a third party's
// hooks. Every case here is one a real settings.json can be in.
import { describe, expect, test, beforeEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { applyHooks, hookStatus, hooksDir, _internal } from "../src/hooksetup.ts";

const { doInstall, doUninstall, isOurs, EVENTS, MARKER } = _internal;

// Each test gets its own HOME so applyHooks/hookStatus (which resolve
// ~/.claude via os.homedir()) touch a throwaway tree, never the real one.
// hooksetup reads homedir() at call time, not import time, so setting it here
// is enough — no module cache to fight.
let HOME = "";
function settingsFile() { return join(HOME, ".claude", "settings.json"); }
function writeSettings(obj: unknown) {
  mkdirSync(join(HOME, ".claude"), { recursive: true });
  writeFileSync(settingsFile(), JSON.stringify(obj, null, 2));
}
function readSettings(): any {
  return JSON.parse(readFileSync(settingsFile(), "utf8"));
}

beforeEach(() => {
  HOME = mkdtempSync(join(tmpdir(), "agx-hooks-"));
  process.env.HOME = HOME;
  delete process.env.USERPROFILE; // homedir() prefers this on some platforms
});

describe("merge logic (pure, no disk)", () => {
  test("install wires all nine events, with the right matchers and --add-chat", () => {
    const cfg: any = {};
    doInstall(cfg, "/x/hooks/send_event.py", "python3");
    // exactly the nine events, no more
    expect(Object.keys(cfg.hooks).sort()).toEqual([...EVENTS.map((e) => e[0])].sort());
    // PreToolUse/PostToolUse carry the "*" matcher; the rest carry none
    expect(cfg.hooks.PreToolUse[0].matcher).toBe("*");
    expect(cfg.hooks.SessionStart[0].matcher).toBeUndefined();
    // --add-chat only on the three transcript-bearing events
    const cmd = (ev: string) => cfg.hooks[ev][0].hooks[0].command;
    expect(cmd("Stop")).toContain("--add-chat");
    expect(cmd("SubagentStop")).toContain("--add-chat");
    expect(cmd("SessionEnd")).toContain("--add-chat");
    expect(cmd("SessionStart")).not.toContain("--add-chat");
    // the script path is quoted (spaced paths break the command otherwise)
    expect(cmd("Stop")).toContain('"/x/hooks/send_event.py"');
  });

  test("a third party's hooks in the same events are preserved", () => {
    const guard = { matcher: "Bash", hooks: [{ type: "command", command: "my-guard.sh" }] };
    const cfg: any = { hooks: { PreToolUse: [guard], Stop: [{ hooks: [{ type: "command", command: "someone-else" }] }] } };
    doInstall(cfg, "/x/hooks/send_event.py", "python3");
    // theirs is still there, and ours was appended after it
    expect(cfg.hooks.PreToolUse[0]).toEqual(guard);
    expect(isOurs(cfg.hooks.PreToolUse[1])).toBe(true);
    expect(cfg.hooks.PreToolUse).toHaveLength(2);
  });

  test("re-installing re-points our entry in place instead of duplicating it", () => {
    const cfg: any = {};
    doInstall(cfg, "/old/hooks/send_event.py", "python3");
    doInstall(cfg, "/new/hooks/send_event.py", "python3");
    const ours = cfg.hooks.Stop.filter(isOurs);
    expect(ours).toHaveLength(1); // not two
    expect(ours[0].hooks[0].command).toContain("/new/hooks/send_event.py");
    expect(ours[0].hooks[0].command).not.toContain("/old/");
  });

  test("uninstall removes only ours, keeps foreign, and prunes empty containers", () => {
    const guard = { matcher: "Bash", hooks: [{ type: "command", command: "my-guard.sh" }] };
    const cfg: any = { otherTopLevel: 1, hooks: {} };
    cfg.hooks.PreToolUse = [guard];
    doInstall(cfg, "/x/hooks/send_event.py", "python3");
    doUninstall(cfg);
    // foreign guard survives; the events that were ONLY ours are gone
    expect(cfg.hooks.PreToolUse).toEqual([guard]);
    expect(cfg.hooks.Stop).toBeUndefined();
    // unrelated top-level keys are never touched
    expect(cfg.otherTopLevel).toBe(1);
  });

  test("uninstall drops the whole hooks object when nothing else is left in it", () => {
    const cfg: any = { theme: "dark" };
    doInstall(cfg, "/x/hooks/send_event.py", "python3");
    doUninstall(cfg);
    expect("hooks" in cfg).toBe(false);
    expect(cfg.theme).toBe("dark");
  });

  test("install then uninstall is a clean round-trip back to the original", () => {
    const original = { hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "guard.sh" }] }] }, permissions: { allow: ["Read"] } };
    const cfg: any = JSON.parse(JSON.stringify(original));
    doInstall(cfg, "/x/hooks/send_event.py", "python3");
    doUninstall(cfg);
    expect(cfg).toEqual(original);
  });

  test("isOurs recognises our command by the send_event.py marker, and only that", () => {
    expect(MARKER).toBe("send_event.py");
    expect(isOurs({ hooks: [{ command: 'python3 "/a/b/send_event.py" --event-type Stop' }] })).toBe(true);
    expect(isOurs({ hooks: [{ command: "someone_elses_thing.py" }] })).toBe(false);
    expect(isOurs({})).toBe(false);
    expect(isOurs({ hooks: "not-an-array" as any })).toBe(false);
  });
});

describe("applyHooks / hookStatus (on disk)", () => {
  test("install writes the file, reports installed, and status agrees", () => {
    const r = applyHooks("install");
    expect(r.ok).toBe(true);
    expect(r.installed).toBe(true);
    expect(r.changed).toBe(true);
    expect(existsSync(settingsFile())).toBe(true);
    expect(hookStatus().installed).toBe(true);
  });

  test("no settings file yet: install creates ~/.claude and writes trailing newline, no backup", () => {
    expect(existsSync(settingsFile())).toBe(false);
    const r = applyHooks("install");
    expect(r.backup).toBeUndefined(); // nothing to back up
    expect(readFileSync(settingsFile(), "utf8").endsWith("}\n")).toBe(true);
  });

  test("installing twice is idempotent: the second call changes nothing and writes no backup", () => {
    applyHooks("install");
    const backupsAfterFirst = readdirSync(join(HOME, ".claude")).filter((f) => f.includes(".bak.agentglass."));
    const r2 = applyHooks("install");
    expect(r2.ok).toBe(true);
    expect(r2.changed).toBe(false);
    expect(r2.installed).toBe(true);
    const backupsAfterSecond = readdirSync(join(HOME, ".claude")).filter((f) => f.includes(".bak.agentglass."));
    expect(backupsAfterSecond).toEqual(backupsAfterFirst); // no new backup for a no-op
  });

  test("a real change backs up the prior file first", () => {
    writeSettings({ permissions: { allow: ["Read"] } });
    const r = applyHooks("install");
    expect(r.changed).toBe(true);
    expect(r.backup).toBeDefined();
    expect(existsSync(r.backup!)).toBe(true);
    // the backup is the pre-change content, verbatim
    expect(JSON.parse(readFileSync(r.backup!, "utf8"))).toEqual({ permissions: { allow: ["Read"] } });
    // and the real file kept the foreign key
    expect(readSettings().permissions.allow).toEqual(["Read"]);
  });

  test("uninstall on a file that never had our hooks is a no-op, not an error", () => {
    writeSettings({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "guard.sh" }] }] } });
    const r = applyHooks("uninstall");
    expect(r.ok).toBe(true);
    expect(r.changed).toBe(false);
    expect(r.installed).toBe(false);
    // foreign guard untouched
    expect(readSettings().hooks.PreToolUse[0].hooks[0].command).toBe("guard.sh");
  });

  test("malformed settings.json is left untouched and reported, never overwritten", () => {
    mkdirSync(join(HOME, ".claude"), { recursive: true });
    writeFileSync(settingsFile(), "{ this is not json ");
    const r = applyHooks("install");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("not valid JSON");
    // the file is exactly as it was — no write, no backup
    expect(readFileSync(settingsFile(), "utf8")).toBe("{ this is not json ");
    expect(readdirSync(join(HOME, ".claude")).filter((f) => f.includes(".bak"))).toHaveLength(0);
  });

  test("empty file is treated as empty config, not a parse error", () => {
    mkdirSync(join(HOME, ".claude"), { recursive: true });
    writeFileSync(settingsFile(), "   \n");
    const r = applyHooks("install");
    expect(r.ok).toBe(true);
    expect(r.installed).toBe(true);
  });

  test("status: bundled is true in a checkout (hooks/ resolves)", () => {
    // This test runs from the repo, so the dev hooks dir must resolve.
    expect(hooksDir()).not.toBeNull();
    expect(hookStatus().bundled).toBe(true);
  });
});

// The strongest check: run the real Python installer against the same input and
// demand a byte-identical settings.json. If the two ever drift, this fails.
// Skipped only where python3 is genuinely absent (never on CI).
describe("golden parity with install_hooks.py", () => {
  const py = spawnSync("python3", ["--version"]);
  const havePython = py.status === 0;
  const repoHooks = hooksDir();

  test.if(havePython && !!repoHooks)("TS applyHooks writes what the Python installer writes", () => {
    const seed = { permissions: { allow: ["Read"] }, hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "guard.sh" }] }] } };

    // TS side: install into this test's HOME.
    writeSettings(seed);
    applyHooks("install");
    const tsOut = readSettings();

    // Python side: a separate project tree, installed via --project so it writes
    // <proj>/.claude/settings.json using the same repo hooks dir.
    const proj = mkdtempSync(join(tmpdir(), "agx-pyproj-"));
    mkdirSync(join(proj, ".claude"), { recursive: true });
    writeFileSync(join(proj, ".claude", "settings.json"), JSON.stringify(seed, null, 2));
    const run = spawnSync("python3", [join(repoHooks!, "install_hooks.py"), "--project", proj], { encoding: "utf8" });
    expect(run.status).toBe(0);
    const pyOut = JSON.parse(readFileSync(join(proj, ".claude", "settings.json"), "utf8"));
    rmSync(proj, { recursive: true, force: true });

    // Same structure, same commands, same everything. (Both resolve send_event.py
    // to the same absolute repo path, so even the command strings match.)
    expect(tsOut).toEqual(pyOut);
  });
});
