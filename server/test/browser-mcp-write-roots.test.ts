/*
 * Where the browser door's two writing verbs may put a file.
 *
 * `record` and `download` do not write from the MCP server: the app's own
 * process makes the directory and writes the frames, the gif and the file
 * (browserdrive.ts `recordFrames` / `downloadFile`), outside the shell — so
 * outside the sandbox the shell runs in. The path is the caller's, which for a
 * worker is a model's, and a role whose shell may write one folder must not be
 * able to put files in a home directory through this door.
 *
 * The door refuses before it calls the relay, so what is asserted here is the
 * decision: a sentence instead of a write, and the untouched relay on the
 * inside.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { noteBrowserReady, resetBrowserDrive, runLanes, runSteps, setBrowserSink, settleBrowser, turnWriteRefusal } from "../src/browserdrive.ts";
import { freePort } from "./freePort.ts";
import { TMUX_TEST_TMPDIR } from "./tmuxTmp.ts";
import { SERVER_BOOT_MS } from "./serverBoot.ts";

const MCP = new URL("../../bin/agentglass-browser-mcp", import.meta.url).pathname;
const HAVE_PY = !!Bun.which("python3");

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const scratch = () => { const d = mkdtempSync(join(tmpdir(), "agx-mcp-roots-")); dirs.push(d); return d; };

const PROBE = [
  "import importlib.machinery, importlib.util, json, os, sys",
  'loader = importlib.machinery.SourceFileLoader("mcp_under_test", os.environ["MCP_PATH"])',
  'spec = importlib.util.spec_from_loader("mcp_under_test", loader)',
  "m = importlib.util.module_from_spec(spec)",
  "loader.exec_module(m)",
  "sent = []",
  "def fake_call(op, body, timeout=120):",
  "    sent.append(body)",
  '    return {"ok": True, "value": {"sent": body}}',
  "m.call = fake_call",
  'req = json.loads(sys.argv[1])',
  'out = m.run("browser_" + req["verb"], req["args"])',
  'print(json.dumps({"out": out, "sent": sent}))',
].join("\n");

/** One tool call against the door, with the relay stubbed: what it answered and
 *  whether the relay was asked at all. */
function callDoor(
  roots: string | null, cwd: string, verb: string, args: Record<string, unknown>,
): { refused: boolean; text: string; sent: Record<string, unknown>[] } {
  const state = scratch();
  const p = Bun.spawnSync(["python3", "-c", PROBE, JSON.stringify({ verb, args })], {
    cwd,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: state,
      MCP_PATH: MCP,
      AGENTGLASS_BROWSER_STATE_DIR: join(state, "browser"),
      ...(roots === null ? {} : { AGX_TURN_WRITE_ROOTS: roots }),
    },
    stdout: "pipe", stderr: "pipe",
  });
  const said = p.stdout.toString().trim();
  if (!said) throw new Error(`python said nothing; stderr: ${p.stderr.toString()}`);
  const r = JSON.parse(said) as { out: { content: { text: string }[]; isError?: boolean }; sent: Record<string, unknown>[] };
  return { refused: r.out.isError === true, text: r.out.content.map((c) => c.text).join("\n"), sent: r.sent };
}

describe.skipIf(!HAVE_PY)("the browser door writes only inside the turn's roots", () => {
  const work = () => {
    const root = scratch();
    const wt = join(root, "orbit");
    const run = join(root, "worker-runs", "w1");
    mkdirSync(wt, { recursive: true });
    mkdirSync(run, { recursive: true });
    return { root, wt, run, roots: `${wt}:${run}` };
  };

  test("record: a directory outside them is refused with a sentence, and the relay is not called", () => {
    const { root, wt, roots } = work();
    const outside = join(root, "orbit-home", ".ssh");
    const r = callDoor(roots, wt, "record", { dir: outside, frames: 2, shared: true });
    expect(r.refused).toBe(true);
    expect(r.text).toContain("outside this turn's writable roots");
    expect(r.text).toContain(outside);
    expect(r.sent).toEqual([]);
  });

  test("record: the worktree and the turn's own folder are both inside", () => {
    const { wt, run, roots } = work();
    for (const dir of [join(wt, "shots"), run]) {
      const r = callDoor(roots, wt, "record", { dir, frames: 2, shared: true });
      expect(r.refused).toBe(false);
      expect(r.sent[0]!.dir).toBe(dir);
    }
  });

  test("record: the gif is a path too, and one outside them is refused", () => {
    const { root, wt, roots } = work();
    const inside = callDoor(roots, wt, "record", { dir: join(wt, "shots"), gif: join(wt, "shots", "a.gif"), frames: 2, shared: true });
    expect(inside.refused).toBe(false);
    expect(inside.sent[0]!.gif).toBe(join(wt, "shots", "a.gif"));
    const outside = join(root, "credentials.txt");
    const r = callDoor(roots, wt, "record", { dir: join(wt, "shots"), gif: outside, frames: 2, shared: true });
    expect(r.refused).toBe(true);
    expect(r.text).toContain(outside);
    expect(r.sent).toEqual([]);
  });

  test("download: the page names the file, but the directory is still the door's call", () => {
    const { root, wt, run, roots } = work();
    const outside = callDoor(roots, wt, "download", { selector: "#a", dir: root, shared: true });
    expect(outside.refused).toBe(true);
    expect(outside.sent).toEqual([]);
    const inside = callDoor(roots, wt, "download", { selector: "#a", dir: run, shared: true });
    expect(inside.refused).toBe(false);
    expect(inside.sent[0]!.dir).toBe(run);
  });

  test("a link inside the worktree that points out of it is the place it points at", () => {
    const { root, wt, roots } = work();
    const home = join(root, "home");
    mkdirSync(home, { recursive: true });
    symlinkSync(home, join(wt, "link"));
    const r = callDoor(roots, wt, "record", { dir: join(wt, "link", "shots"), frames: 2, shared: true });
    expect(r.refused).toBe(true);
    expect(r.sent).toEqual([]);
  });

  test("trace: the file is written by the app's process, so its path is held too", () => {
    /* `browser_trace action=stop path=…` was forwarded and written by the app
       (browserdrive.ts `traceRecording`), outside the shell and this door's
       check: any writing role could put a trace file anywhere. */
    const { root, wt, run, roots } = work();
    const outside = callDoor(roots, wt, "trace", { action: "stop", path: join(root, "autostart", "x.json"), shared: true });
    expect(outside.refused).toBe(true);
    expect(outside.text).toContain("outside this turn's writable roots");
    expect(outside.sent).toEqual([]);
    const inside = callDoor(roots, wt, "trace", { action: "stop", path: join(run, "trace.json"), shared: true });
    expect(inside.refused).toBe(false);
    expect(inside.sent[0]!.path).toBe(join(run, "trace.json"));
  });

  test("cdp: arming a download in a directory of the caller's choosing is the same write", () => {
    /* `browser_cdp` hands the whole protocol to a role that acts, and
       `Browser.setDownloadBehavior` takes a `downloadPath`: the page's next
       file lands there without `download`'s check ever running. */
    const { root, wt, run, roots } = work();
    for (const method of ["Browser.setDownloadBehavior", "Page.setDownloadBehavior"]) {
      const r = callDoor(roots, wt, "cdp", {
        method, params: { behavior: "allow", downloadPath: join(root, "systemd", "user") }, shared: true,
      });
      expect(r.refused).toBe(true);
      expect(r.text).toContain("outside this turn's writable roots");
      expect(r.sent).toEqual([]);
    }
    const inside = callDoor(roots, wt, "cdp", {
      method: "Browser.setDownloadBehavior", params: { behavior: "allow", downloadPath: run }, shared: true,
    });
    expect(inside.refused).toBe(false);
    expect(inside.sent[0]!.params).toEqual({ behavior: "allow", downloadPath: run });
  });

  test("cdp: a relative downloadPath is refused, because Chromium resolves it in its own cwd", () => {
    /* The door resolves what the caller sent, so "assets" was checked as
       `<worktree>/assets` and passed. Chromium resolves a relative directory
       against the browser process, so the page's next file landed in the app's
       own working directory instead. */
    const { run, wt, roots } = work();
    for (const path of ["assets", "./assets", "../outside"]) {
      const r = callDoor(roots, wt, "cdp", { method: "Browser.setDownloadBehavior", params: { behavior: "allow", downloadPath: path }, shared: true });
      expect(r.refused).toBe(true);
      expect(r.text).toContain("absolute");
      expect(r.sent).toEqual([]);
    }
    const fine = callDoor(roots, wt, "cdp", { method: "Browser.setDownloadBehavior", params: { behavior: "allow", downloadPath: join(run, "dl") }, shared: true });
    expect(fine.refused).toBe(false);
  });

  test("a batch step that arms a download outside the roots is refused, and the relay is not called", () => {
    /* `do` and a lane carry their own verbs, so the `cdp` branch above never
       runs: the batch went from the door to `runSteps` and the protocol call
       reached the page. A worker has no `browser_download`; a step is not the
       way around that. */
    const { root, wt, run, roots } = work();
    const outside = join(root, "systemd", "user");
    for (const body of [
      { steps: [
        { op: "cdp", args: { method: "Browser.setDownloadBehavior", params: { behavior: "allow", downloadPath: outside } } },
        { op: "click", args: { selector: "#get" } },
      ] },
      { lanes: [{ page: "t1", steps: [
        { op: "cdp", args: { method: "Page.setDownloadBehavior", params: { behavior: "allow", downloadPath: outside } } },
      ] }] },
    ]) {
      const r = callDoor(roots, wt, "do", { page: "t1", ...body });
      expect(r.refused).toBe(true);
      expect(r.text).toContain("outside this turn's writable roots");
      expect(r.text).toContain(outside);
      expect(r.sent).toEqual([]);
    }
    // A step inside the roots is a step a worker may make, and the roots ride
    // on the body so the route can check it again where the write happens.
    const inside = callDoor(roots, wt, "do", { page: "t1", steps: [
      { op: "cdp", args: { method: "Browser.setDownloadBehavior", params: { behavior: "allow", downloadPath: run } } },
    ] });
    expect(inside.refused).toBe(false);
    expect(inside.sent[0]!.roots).toEqual([realpathSync(wt), realpathSync(run)]);
  });

  test("cdp: arming a download with no directory puts it in the browser's own, and is refused for a turn", () => {
    /* `Browser.setDownloadBehavior {behavior:"allow"}` names no directory, so
       the file lands in Chromium's own download folder — the person's. The
       path rule only ran when a path was named, so this was forwarded. */
    const { wt, roots } = work();
    for (const method of ["Browser.setDownloadBehavior", "Page.setDownloadBehavior"]) {
      const r = callDoor(roots, wt, "cdp", { method, params: { behavior: "allow" }, page: "t1" });
      expect(r.refused).toBe(true);
      expect(r.text).toContain("no downloadPath");
      expect(r.sent).toEqual([]);
    }
    // Turning it off names no directory and writes nothing.
    const off = callDoor(roots, wt, "cdp", { method: "Browser.setDownloadBehavior", params: { behavior: "deny" }, page: "t1" });
    expect(off.refused).toBe(false);
  });

  test("the work tree's own `.git` and `.claude` are inside it by prefix and are refused", () => {
    /* `download` writes a file whose name the page chooses into `dir`, so
       `dir=<tree>/.git/hooks` plants the hook the git deny exists to close, and
       `<tree>/.claude` plants project settings. */
    const { wt, roots } = work();
    for (const dir of [join(wt, ".git", "hooks"), join(wt, ".git"), join(wt, ".claude"), join(wt, ".claude", "deep")]) {
      const r = callDoor(roots, wt, "download", { selector: "#a", dir, shared: true });
      expect(r.refused).toBe(true);
      expect(r.text).toContain("refused");
      expect(r.sent).toEqual([]);
    }
    const fine = callDoor(roots, wt, "download", { selector: "#a", dir: join(wt, "shots"), shared: true });
    expect(fine.refused).toBe(false);
  });

  test("the door hands the app's route the roots, so the check can be made again where the write is", () => {
    const { wt, run, roots } = work();
    const r = callDoor(roots, wt, "download", { selector: "#a", dir: run, shared: true });
    expect(r.refused).toBe(false);
    expect(r.sent[0]!.roots).toEqual([realpathSync(wt), realpathSync(run)]);
  });

  test("that second check resolves the path again, so a directory swapped for a link is followed", () => {
    /* The door resolved `<wt>/shots` in its own process; the turn's shell then
       replaced it with a link. `realpath` at check time saw the old name. */
    const { root, wt } = work();
    const home = join(root, "home");
    mkdirSync(home, { recursive: true });
    symlinkSync(home, join(wt, "shots"));
    expect(turnWriteRefusal(join(wt, "shots", "frame-001.png"), [wt])).toContain("outside this turn's writable roots");
    expect(turnWriteRefusal(join(wt, "fine.png"), [wt])).toBe("");
  });

  test("a server nobody started for a turn is held to where it stands", () => {
    const { root, wt } = work();
    const inside = callDoor(null, wt, "record", { dir: join(wt, "shots"), frames: 2, shared: true });
    expect(inside.refused).toBe(false);
    const outside = callDoor(null, wt, "record", { dir: root, frames: 2, shared: true });
    expect(outside.refused).toBe(true);
    expect(outside.text).toContain("outside this turn's writable roots");
  });
});

describe("the route refuses before it writes, not only the door", () => {
  /* The door's check runs in the MCP process; the directory is made and written
     by the app's own process (`recordFrames`, `downloadFile`, `traceRecording`),
     so the path is checked again there — with the roots the door sent. */
  let box = "", base = "", proc: ReturnType<typeof Bun.spawn> | null = null;
  const roots: string[] = [];

  beforeAll(async () => {
    box = scratch(); roots.push(box);
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    proc = Bun.spawn(["bun", "run", new URL("../src/index.ts", import.meta.url).pathname], {
      env: {
        PATH: process.env.PATH ?? "",
        HOME: box,
        TMUX_TMPDIR: TMUX_TEST_TMPDIR,
        XDG_CONFIG_HOME: box,
        XDG_STATE_HOME: box,
        XDG_DATA_HOME: box,
        XDG_CACHE_HOME: box,
        AGENTGLASS_STATE_DIR: box,
        AGENTGLASS_ROOT: box,
        AGENTGLASS_DB: join(box, "f.db"),
        AGENTGLASS_SCAN_DISABLED: "1",
        AGENTGLASS_PORT: String(port),
      },
      stdout: "ignore", stderr: "ignore",
    });
    for (let i = 0; i < 150; i++) {
      try { if ((await fetch(base + "/health")).ok) break; } catch { /* not up yet */ }
      await Bun.sleep(100);
    }
  }, SERVER_BOOT_MS);

  afterAll(() => {
    try { proc?.kill(); } catch { /* already gone */ }
  });

  const post = (op: string, body: unknown) =>
    fetch(`${base}/browser/${op}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });

  test("a download whose roots are the turn's, into a directory outside them, is refused and nothing is made", async () => {
    const wt = join(box, "orbit");
    mkdirSync(wt, { recursive: true });
    const outside = join(box, "systemd-user");
    const r = await post("download", { selector: "#a", dir: outside, roots: [wt] });
    const said = (await r.json()) as { ok: boolean; error?: string };
    expect(said.ok).toBe(false);
    expect(said.error).toContain("outside this turn's writable roots");
    expect(existsSync(outside)).toBe(false);
  });

  test("the person's own call names no roots and is not held to a turn's", async () => {
    const own = join(box, "own-downloads");
    const r = await post("download", { selector: "#a", dir: own });
    const said = (await r.json()) as { ok: boolean; error?: string };
    expect(said.ok).toBe(false); // nobody is mounted here to arm it
    expect(said.error ?? "").not.toContain("writable roots");
  });
});

describe("a batch step is held where the step becomes a call", () => {
  /* The door reads the steps a caller sent; this is the same rule one layer
     down, where a step becomes an ask. A body that reached the route another
     way, or a step whose path the door could not see, still cannot put a
     download in a directory the turn may not write. */
  afterEach(() => resetBrowserDrive());

  const batch = () => {
    const root = scratch();
    const wt = join(root, "orbit");
    mkdirSync(wt, { recursive: true });
    return { root, wt, outside: join(root, "autostart") };
  };

  test("`do`: an asked download outside the roots is refused before the window is asked", async () => {
    const { wt, outside } = batch();
    let asked = 0;
    setBrowserSink({ send: () => { asked++; }, listeners: () => 1 });
    const r = await runSteps(
      [{ op: "cdp", args: { method: "Browser.setDownloadBehavior", params: { behavior: "allow", downloadPath: outside } } }],
      { roots: [wt] },
    );
    expect(r.ok).toBe(false);
    expect(r.steps[0]!.error).toContain("outside this turn's writable roots");
    expect(asked).toBe(0);
    // And one that names no directory at all is the browser's own folder.
    const bare = await runSteps(
      [{ op: "cdp", args: { method: "Page.setDownloadBehavior", params: { behavior: "allow" } } }],
      { roots: [wt] },
    );
    expect(bare.ok).toBe(false);
    expect(bare.steps[0]!.error).toContain("no downloadPath");
    expect(asked).toBe(0);
    // A lane carries the same roots down to its steps.
    const lane = await runLanes(
      [{ page: "t1", steps: [{ op: "cdp", args: { method: "Page.setDownloadBehavior", params: { behavior: "allow", downloadPath: outside } } }] }],
      { roots: [wt] },
    );
    expect(lane.ok).toBe(false);
    expect((lane.lanes[0]!.steps as Array<{ error?: string }>)[0]!.error).toContain("outside this turn's writable roots");
    expect(asked).toBe(0);
  });

  test("`do`: a relative downloadPath is refused where the step becomes a call", async () => {
    const { wt } = batch();
    let asked = 0;
    setBrowserSink({ send: () => { asked++; }, listeners: () => 1 });
    const r = await runSteps(
      [{ op: "cdp", args: { method: "Browser.setDownloadBehavior", params: { behavior: "allow", downloadPath: "assets" } } }],
      { roots: [wt] },
    );
    expect(r.ok).toBe(false);
    expect(r.steps[0]!.error).toContain("absolute");
    expect(asked).toBe(0);
  });

  test("`do`: a step inside the roots is still a step, and one that names no roots is the person's own", async () => {
    const { wt } = batch();
    let asked = 0;
    setBrowserSink({ send: (a) => { asked++; queueMicrotask(() => settleBrowser(a.id, { ok: true, value: true })); }, listeners: () => 1 });
    noteBrowserReady("w1", true);
    const inside = await runSteps(
      [{ op: "click", args: { selector: "#a" } }], { roots: [wt] },
    );
    expect(inside.ok).toBe(true);
    const own = await runSteps([{ op: "click", args: { selector: "#a" } }], {});
    expect(own.ok).toBe(true);
    expect(asked).toBe(2);
  });
});
