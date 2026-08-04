// Taking the status line slot, and giving it back.
//
// `statusLine` is one slot in settings.json rather than a list, so there is no
// adding to it without owning it — and it renders in every Claude Code session
// several times a second. Getting this wrong does not degrade a feature, it
// puts a broken status line in front of somebody all day.
//
// So the properties worth pinning are the ones about somebody else's command:
// it survives being wrapped, it comes back byte-identical on uninstall, and the
// two installers (this one and hooks/install_hooks.py) write the same string —
// otherwise the Python side cannot undo what the button did.
import { describe, expect, test, beforeEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { _internal } from "../src/hooksetup.ts";

const { installStatusLine, uninstallStatusLine, chainedFrom, shQuote } = _internal as any;

const SL = "/opt/agentglass/hooks/statusline.sh";
const MINE = "bash /home/x/.claude/statusline-command.sh";

describe("wrapping somebody else's status line", () => {
  test("it is kept, as an argument our script will call", () => {
    const cfg: any = { statusLine: { type: "command", command: MINE } };
    installStatusLine(cfg, SL);
    expect(cfg.statusLine.command).toBe(`sh "${SL}" '${MINE}'`);
    // And it is right there in the file the user reads — nothing of ours is
    // hidden anywhere else for uninstall to depend on.
    expect(cfg.statusLine.command).toContain(MINE);
  });

  test("uninstall hands it back exactly", () => {
    const cfg: any = { statusLine: { type: "command", command: MINE } };
    installStatusLine(cfg, SL);
    uninstallStatusLine(cfg);
    expect(cfg.statusLine).toEqual({ type: "command", command: MINE });
  });

  test("re-installing re-points our path without wrapping twice", () => {
    const cfg: any = { statusLine: { type: "command", command: MINE } };
    installStatusLine(cfg, "/old/hooks/statusline.sh");
    installStatusLine(cfg, SL);
    expect(cfg.statusLine.command).toBe(`sh "${SL}" '${MINE}'`);
    expect(cfg.statusLine.command).not.toContain("/old/hooks");
    // Still one uninstall away from where we started.
    uninstallStatusLine(cfg);
    expect(cfg.statusLine.command).toBe(MINE);
  });

  test("an empty slot is taken plainly, and left empty again", () => {
    const cfg: any = {};
    installStatusLine(cfg, SL);
    expect(cfg.statusLine.command).toBe(`sh "${SL}"`);
    uninstallStatusLine(cfg);
    expect("statusLine" in cfg).toBe(false);
  });

  test("a status line that is not ours is never removed", () => {
    const cfg: any = { statusLine: { type: "command", command: MINE } };
    uninstallStatusLine(cfg);
    expect(cfg.statusLine.command).toBe(MINE);
  });

  test("a command with quotes and spaces survives the round trip", () => {
    // The realistic nasty one: a path with a space and a shell one-liner with
    // its own quoting. If the wrap mangles this, the user's status line breaks
    // on the next render and the cause is in a file they never edited.
    for (const cmd of [
      "bash '/home/My Files/line.sh'",
      `sh -c "echo it's here"`,
      "printf '%s' hi",
      "node /a/b.js --flag=x",
    ]) {
      const cfg: any = { statusLine: { type: "command", command: cmd } };
      installStatusLine(cfg, SL);
      uninstallStatusLine(cfg);
      expect(cfg.statusLine.command).toBe(cmd);
    }
  });

  test("chainedFrom refuses to read a command that is not ours", () => {
    expect(chainedFrom(MINE)).toBe(null);
    expect(chainedFrom("")).toBe(null);
  });
});

// The two installers write into the same slot, so a string one of them writes
// the other has to recognise and unpick. shlex.quote is the reference.
describe("the two installers agree on quoting", () => {
  const havePython = spawnSync("python3", ["--version"]).status === 0;

  test.if(havePython)("shQuote matches shlex.quote", () => {
    const cases = [
      MINE, "bash '/home/My Files/line.sh'", `sh -c "echo it's here"`,
      "plain", "with space", "semi;colon", "dollar$sign", "back\\slash", "new\nline",
    ];
    const py = spawnSync("python3", ["-c",
      "import json,shlex,sys; print(json.dumps([shlex.quote(s) for s in json.load(sys.stdin)]))"],
      { input: JSON.stringify(cases), encoding: "utf8" });
    expect(py.status).toBe(0);
    expect(cases.map(shQuote)).toEqual(JSON.parse(py.stdout));
  });

  test.if(havePython)("the Python installer can undo what this one wrote", () => {
    const home = mkdtempSync(join(tmpdir(), "agx-sl-"));
    mkdirSync(join(home, ".claude"), { recursive: true });
    const path = join(home, ".claude", "settings.json");
    const repoHooks = join(import.meta.dir, "..", "..", "hooks");

    // Written by this installer, pointing at the real script the Python one
    // will also recognise.
    const cfg: any = { statusLine: { type: "command", command: MINE } };
    installStatusLine(cfg, join(repoHooks, "statusline.sh"));
    writeFileSync(path, JSON.stringify(cfg, null, 2));

    const r = spawnSync("python3", [join(repoHooks, "install_hooks.py"), "--uninstall", "--project", home],
      { encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(JSON.parse(readFileSync(path, "utf8")).statusLine).toEqual({ type: "command", command: MINE });
  });
});

// The script itself. It runs on every render, so what matters is that it always
// gets out of the way: the chained command runs and owns stdout on every path,
// including the ones where we do nothing at all.
describe("the forwarder script", () => {
  const script = join(import.meta.dir, "..", "..", "hooks", "statusline.sh");
  const WITH = JSON.stringify({
    model: { display_name: "Opus" },
    rate_limits: { five_hour: { used_percentage: 13 }, seven_day: { used_percentage: 51 } },
  });
  const WITHOUT = JSON.stringify({ model: { display_name: "Opus" } });

  let posts: any[] = [];
  let url = "";
  let stampDir = "";
  let server: ReturnType<typeof Bun.serve> | null = null;

  beforeEach(() => {
    posts = [];
    server?.stop(true);
    server = Bun.serve({ port: 0, async fetch(req) { posts.push(await req.json()); return new Response("{}"); } });
    url = `http://127.0.0.1:${server.port}`;
    // Its own TMPDIR, so the throttle stamp is this test's and not the machine's.
    stampDir = mkdtempSync(join(tmpdir(), "agx-sl-stamp-"));
  });

  async function run(payload: string, chained: string) {
    const p = Bun.spawn(["sh", script, chained], {
      stdin: new TextEncoder().encode(payload),
      env: { ...process.env, AGENTGLASS_SERVER: url, TMPDIR: stampDir, AGENTGLASS_TOKEN: "t" },
      stdout: "pipe", stderr: "pipe",
    });
    const out = await new Response(p.stdout).text();
    await p.exited;
    // The POST is backgrounded so the status line never waits on a socket.
    await Bun.sleep(250);
    return out;
  }

  test("the chained status line runs and owns the output", async () => {
    expect(await run(WITH, "printf THEIRS")).toBe("THEIRS");
    expect(posts).toHaveLength(1);
    expect(posts[0].rate_limits.five_hour.used_percentage).toBe(13);
  });

  test("a payload with no rate_limits still renders, and sends nothing", async () => {
    expect(await run(WITHOUT, "printf THEIRS")).toBe("THEIRS");
    expect(posts).toHaveLength(0);
  });

  test("a throttled tick still renders", async () => {
    await run(WITH, "printf ONE");
    expect(await run(WITH, "printf TWO")).toBe("TWO");
    // One reading per interval for the whole machine: these numbers are
    // account-wide, so the second tick has nothing to add.
    expect(posts).toHaveLength(1);
  });

  test("the payload reaches the chained command on stdin, unread by us", async () => {
    // Our own read of stdin must not consume it: the wrapped status line is
    // usually a jq script and gets nothing if we swallow the input.
    expect(await run(WITHOUT, "grep -c display_name")).toBe("1\n");
  });

  test("no chained command means no output of our own", async () => {
    expect(await run(WITH, "")).toBe("");
  });

  test("an unreachable server does not break the render", async () => {
    server?.stop(true);
    server = null;
    expect(await run(WITH, "printf THEIRS")).toBe("THEIRS");
  });

  test("a chained command that fails does not take the tick with it", async () => {
    // Somebody's status line erroring is their problem to see, not a reason
    // for the forwarder to start failing hooks.
    const p = Bun.spawn(["sh", script, "exit 3"], {
      stdin: new TextEncoder().encode(WITHOUT),
      env: { ...process.env, AGENTGLASS_SERVER: url, TMPDIR: stampDir },
      stdout: "pipe", stderr: "pipe",
    });
    await p.exited;
    expect(p.exitCode).toBe(0);
  });
});
