/**
 * agx-bench's launcher (scripts/agx-bench/instance.sh), asserted against its
 * source: starting it for real needs a desktop, which the suite does not have.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

describe("a fresh profile opens a project", () => {
  /* Measured: on a profile with no project open the app waits on the project
     picker and never mounts the panels, so no window ever registers its
     browser panel and start timed out after 60 s. The launcher gives the
     instance a project of its own, inside DIR, so the picker has nothing to
     ask. AGENTGLASS_ROOT, because the config file is empty on a new profile. */
  test("launch.env names a project inside DIR, made before the launch", () => {
    const env = CODE.slice(CODE.indexOf("start)"), CODE.indexOf('> "$DIR/launch.env"'));
    expect(env).toMatch(/export AGENTGLASS_ROOT=%q/);
    expect(env).toContain('"$DIR/project"');
    expect(CODE).toMatch(/mkdir -p [^\n]*\bproject\b/);
  });
  test("a start that times out says whether a project was open", () => {
    expect(CODE).toContain("/projects");
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

describe("a relative DIR is the same instance as its absolute path", () => {
  /* The instance recognises its own processes by a file they hold open under
     DIR, and /proc prints those links absolute. Given `bench`, nothing ever
     matched: status said stopped, and stop left Electron and the sidecar
     running on the port. The script is run for real here, with a `sleep`
     holding a file under DIR standing in for Electron. */
  const script = new URL("../../scripts/agx-bench/instance.sh", import.meta.url).pathname;

  test("status finds the process through a relative DIR", async () => {
    const base = mkdtempSync(join(tmpdir(), "agx-inst-"));
    const dir = join(base, "bench");
    mkdirSync(dir);
    const holder = Bun.spawn(["bash", "-c", `exec 3>>"${dir}/hold"; exec sleep 30`]);
    try {
      writeFileSync(join(dir, "electron.pid"), String(holder.pid));
      writeFileSync(join(dir, "port"), "4999");
      await Bun.sleep(100);
      const p = Bun.spawnSync(["bash", script, "status", "bench"], { cwd: base, env: { PATH: process.env.PATH ?? "/usr/bin:/bin" } });
      expect(p.stdout.toString()).toContain(`running: pid ${holder.pid}`);
      expect(p.stdout.toString()).toContain(`dir ${dir}`);
    } finally {
      holder.kill();
      await holder.exited;
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("a DIR that cannot be pasted into the compositor's command is refused", () => {
    for (const bad of ["/tmp/agx bench", '/tmp/agx"bench', "/tmp/agx\\bench"]) {
      const p = Bun.spawnSync(["bash", script, "status", bad], { env: { PATH: process.env.PATH ?? "/usr/bin:/bin" } });
      expect(p.exitCode, bad).toBe(2);
      expect(p.stderr.toString(), bad).toContain("DIR");
    }
  });
});

describe("start does not trust what it did not make", () => {
  test("a DIR owned by somebody else is refused before launch.env is sourced from it", () => {
    expect(CODE).toContain('[ ! -O "$DIR" ]');
    expect(CODE.indexOf('[ ! -O "$DIR" ]')).toBeLessThan(CODE.indexOf('. "$DIR/launch.env"'));
  });

  test("a failed window lookup is 'not yet', so the wrong-workspace check still runs", () => {
    const line = CODE.split("\n").find((l) => l.includes("AT=$(hyprctl clients -j"));
    expect(line).toBeDefined();
    expect(line!).toMatch(/\|\| true\)$/);
  });
});
