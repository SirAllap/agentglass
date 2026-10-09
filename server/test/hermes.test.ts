import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, realpathSync, symlinkSync } from "node:fs";
import { Database } from "bun:sqlite";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import {
  frameToEvent, hermesArgs, hermesEnv, hermesHome, hermesResumeRefusal, hermesConfiguredModel, hermesMode, hermesModel, HERMES_ENABLED,
  hermesModels, hermesSession, hermesStream, newFrameContext, promptEvent,
  HERMES_APP, MAX_MESSAGE_BYTES, MODEL_RE, SESSION_RE,
} from "../src/hermes.ts";

const BIN = "/usr/bin/hermes";
const HERMES_SRC = await Bun.file(join(import.meta.dir, "..", "src", "hermes.ts")).text();
const SID = "20260917_104709_fdc54d";

describe("the command line", () => {
  test("a first turn names the model and asks for the streaming format", () => {
    const a = hermesArgs(BIN, "anthropic/claude-sonnet-4", "", "default", "hello");
    expect(a).toEqual([BIN, "chat", "--query=hello", "--format", "stream-json", "--no-restore-cwd", "-m", "anthropic/claude-sonnet-4"]);
    expect(a).not.toContain("--yolo");
    expect(a).not.toContain("--resume");
  });

  test("a follow-up resumes the session it belongs to", () => {
    const a = hermesArgs(BIN, "deepseek/deepseek-v4-flash", SID, "default", "again");
    expect(a).toContain("--resume");
    expect(a[a.indexOf("--resume") + 1]).toBe(SID);
  });

  test("the unattended mode is --yolo", () => {
    const a = hermesArgs(BIN, "m", "", "yolo", "hi");
    expect(a).toContain("--yolo");
  });

  test("the default mode is spelled by passing no flag", () => {
    const a = hermesArgs(BIN, "m", "", "default", "hi");
    expect(a).not.toContain("--yolo");
  });

  test("an empty model omits -m so Hermes uses its configured default", () => {
    const a = hermesArgs(BIN, "", "", "default", "hi");
    expect(a).not.toContain("-m");
    expect(a).not.toContain("--model");
  });

  test("every turn passes --no-restore-cwd so --resume cannot escape the spawn cwd", () => {
    // Without it, Hermes chdirs to the session DB's recorded cwd on --resume,
    // which can leave the panel's safeAbs / inScope check behind.
    for (const a of [
      hermesArgs(BIN, "m", "", "default", "hi"),
      hermesArgs(BIN, "m", SID, "default", "again"),
      hermesArgs(BIN, "", "", "yolo", "hi"),
    ]) {
      expect(a).toContain("--no-restore-cwd");
    }
  });

  test("the prompt is one argv element, however odd it looks", () => {
    // It goes in argv rather than on stdin, so a prompt full of quotes,
    // newlines and leading dashes must survive as a single value rather than
    // being read as more flags.
    // `--query=` and the prompt are one element: a separate value starting
    // with `-` is read by argparse as the next flag.
    const nasty = "--model evil\n'; rm -rf /\n\"quoted\"";
    const a = hermesArgs(BIN, "m", "", "default", nasty);
    expect(a[2]).toBe(`--query=${nasty}`);
    expect(a).not.toContain("-q");
    expect(a.filter((x) => x === "-m")).toHaveLength(1);
    expect(hermesArgs(BIN, "", "", "default", "-m evil")[2]).toBe("--query=-m evil");
  });

  test("bypass is refused unless the operator opted in", () => {
    expect(hermesMode("yolo", false)).toBe("default");
    expect(hermesMode("yolo", true)).toBe("yolo");
    expect(hermesMode("default", true)).toBe("default");
    expect(hermesMode("always-proceed", true)).toBe("default");
  });
});

describe("ids", () => {
  test("accepts Hermes's own shapes and refuses the other CLIs'", () => {
    expect(hermesSession(SID)).toBe(SID);
    expect(SESSION_RE.test(SID)).toBe(true);
    // Claude / Antigravity UUIDs have hyphens and no underscores — refused.
    expect(hermesSession("78126291-f204-4b7a-b218-9a7e7ba9ac9a")).toBe("");
    expect(hermesSession("../../etc/passwd")).toBe("");
    // Slashy provider/model ids — Claude's MODEL_RE would reject these.
    expect(hermesModel("deepseek/deepseek-v4-flash-0731")).toBe("deepseek/deepseek-v4-flash-0731");
    expect(MODEL_RE.test("anthropic/claude-sonnet-4")).toBe(true);
    expect(hermesModel("not a model")).toBe("");
    expect(hermesModel("")).toBe("");
  });
});

describe("the configured model", () => {
  test("reads model.default and nothing else in that section", () => {
    const dir = mkdtempSync(join(tmpdir(), "agx-hermes-cfg-"));
    const path = join(dir, "config.yaml");
    writeFileSync(path, "model:\n  provider: nous\n  default: deepseek/deepseek-v4-flash-0731\n  base_url: https://example.test\nother: 1\n");
    expect(hermesConfiguredModel(path)).toBe("deepseek/deepseek-v4-flash-0731");
    expect(hermesModels(path)).toEqual([{ id: "deepseek/deepseek-v4-flash-0731", label: "deepseek/deepseek-v4-flash-0731" }]);
    rmSync(dir, { recursive: true, force: true });
  });

  test("also accepts model.model and model.name aliases", () => {
    const dir = mkdtempSync(join(tmpdir(), "agx-hermes-alias-"));
    const modelPath = join(dir, "model.yaml");
    const namePath = join(dir, "name.yaml");
    writeFileSync(modelPath, "model:\n  model: anthropic/claude-sonnet-4\n");
    writeFileSync(namePath, "model:\n  name: openai/gpt-5\n");
    expect(hermesConfiguredModel(modelPath)).toBe("anthropic/claude-sonnet-4");
    expect(hermesConfiguredModel(namePath)).toBe("openai/gpt-5");
    // `default` still wins when both are present.
    const both = join(dir, "both.yaml");
    writeFileSync(both, "model:\n  default: deepseek/deepseek-v4-flash\n  model: ignored/other\n  name: also/ignored\n");
    expect(hermesConfiguredModel(both)).toBe("deepseek/deepseek-v4-flash");
    rmSync(dir, { recursive: true, force: true });
  });

  test("falls back when the config is missing", () => {
    expect(hermesModels(join(tmpdir(), "no-such-hermes-config.yaml"))).toEqual([
      { id: "anthropic/claude-sonnet-4", label: "anthropic/claude-sonnet-4" },
    ]);
  });
});

describe("frames as events", () => {
  const ctx = () => newFrameContext("/repo");

  test("init opens the session and fixes the model", () => {
    const c = ctx();
    const ev = frameToEvent({ type: "system", subtype: "init", session_id: SID, model: "deepseek/deepseek-v4-flash" }, c)!;
    expect(ev.hook_event_type).toBe("SessionStart");
    expect(ev.source_app).toBe(HERMES_APP);
    expect(ev.session_id).toBe(SID);
    expect(ev.model_name).toBe("deepseek/deepseek-v4-flash");
    expect(c.sessionId).toBe(SID);
    expect(ev.payload!.cwd).toBe("/repo");
    expect(ev.payload!.project_path).toBeTruthy();
  });

  test("an init without a Hermes session id is not an event", () => {
    expect(frameToEvent({ type: "system", subtype: "init", session_id: "" }, ctx())).toBeNull();
    expect(frameToEvent({ type: "system", subtype: "init", session_id: "../../etc/passwd" }, ctx())).toBeNull();
  });

  test("nothing is emitted before a session exists", () => {
    const c = ctx();
    expect(frameToEvent({ type: "tool_use", name: "terminal", tool_call_id: "call_1" }, c)).toBeNull();
  });

  test("tools pair on tool_call_id, and an error is a failure", () => {
    const c = ctx();
    c.sessionId = SID;
    const pre = frameToEvent({ type: "tool_use", name: "terminal", tool_call_id: "call_1", input: { command: "ls" } }, c)!;
    expect(pre.hook_event_type).toBe("PreToolUse");
    expect(pre.payload).toMatchObject({ tool_name: "terminal", tool_use_id: "call_1" });
    const post = frameToEvent({ type: "tool_result", name: "terminal", tool_call_id: "call_1", output: "ok", is_error: true }, c)!;
    expect(post.hook_event_type).toBe("PostToolUseFailure");
    expect(post.payload!.tool_response).toBe("ok");
  });

  test("a tool_result still names its tool if only the use half carried it", () => {
    const c = ctx();
    c.sessionId = SID;
    frameToEvent({ type: "tool_use", name: "terminal", tool_call_id: "call_9" }, c);
    const post = frameToEvent({ type: "tool_result", tool_call_id: "call_9", output: "done" }, c)!;
    expect(post.payload!.tool_name).toBe("terminal");
  });

  test("text deltas are not fleet events", () => {
    const c = ctx();
    c.sessionId = SID;
    expect(frameToEvent({ type: "text", text: "hello" }, c)).toBeNull();
  });

  test("result closes the turn with what it spent", () => {
    const c = ctx();
    c.sessionId = SID;
    const ev = frameToEvent({
      type: "result", session_id: SID, exit_code: 0,
      tokens: { input: 10, output: 4, cache_read: 2, cache_write: 1 },
    }, c)!;
    expect(ev.hook_event_type).toBe("Turn complete");
    expect(ev.payload).toMatchObject({
      usage: { input_tokens: 10, output_tokens: 4, cache_read_tokens: 2, cache_creation_tokens: 1 },
    });
  });

  test("the prompt is its own event once the session exists", () => {
    const c = ctx();
    expect(promptEvent(c, "hello")).toBeNull();
    c.sessionId = SID;
    const ev = promptEvent(c, "hello")!;
    expect(ev.hook_event_type).toBe("UserPromptSubmit");
    expect(ev.payload!.prompt).toBe("hello");
    expect(ev.source_app).toBe(HERMES_APP);
  });
});

async function gitRepo(): Promise<string> {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "agx-hermes-repo-")));
  await Bun.$`git init -q ${dir}`.quiet();
  return dir;
}

describe("the child environment", () => {
  test("never carries the agentglass token", () => {
    for (const mode of ["default", "yolo"] as const) {
      const env = hermesEnv({ PATH: "/usr/bin", AGENTGLASS_TOKEN: "tok-orbit", HOME: "/home/orbit" }, mode);
      expect("AGENTGLASS_TOKEN" in env).toBe(false);
      expect(env.PATH).toBe("/usr/bin");
      expect(env.HOME).toBe("/home/orbit");
    }
  });

  test("an inherited HERMES_YOLO_MODE does not turn a default turn into Bypass", () => {
    // Hermes reads it at import as --yolo for the whole process.
    expect("HERMES_YOLO_MODE" in hermesEnv({ HERMES_YOLO_MODE: "1" }, "default")).toBe(false);
    expect(hermesEnv({}, "yolo").HERMES_YOLO_MODE).toBe("1");
  });

  test("a Hermes gateway or session context it was started from does not follow it in", () => {
    // With _HERMES_GATEWAY=1 Hermes keeps an inherited TERMINAL_CWD, so the
    // tools would run wherever the outer Hermes was rather than here.
    const env = hermesEnv({ PATH: "/usr/bin", _HERMES_GATEWAY: "1", HERMES_CRON_SESSION: "1", HERMES_GATEWAY_SESSION: "orbit", HERMES_PROFILE_HINT: "kept" }, "default");
    expect("_HERMES_GATEWAY" in env).toBe(false);
    expect("HERMES_CRON_SESSION" in env).toBe(false);
    expect("HERMES_GATEWAY_SESSION" in env).toBe(false);
    expect(env.HERMES_PROFILE_HINT).toBe("kept");
    expect(env.PATH).toBe("/usr/bin");
  });

  test("the spawn uses it rather than process.env", () => {
    const code = HERMES_SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(code.includes("hermesEnv(process.env, mo)")).toBe(true);
    expect(code.includes("{ ...process.env }")).toBe(false);
  });
});

describe("guards on the send path", () => {
  const prevDisabled = process.env.AGENTGLASS_HERMES_DISABLED;
  const prevRoot = process.env.AGENTGLASS_ROOT;
  const prevBin = process.env.AGENTGLASS_HERMES;
  const prevBypass = process.env.AGENTGLASS_CHAT_BYPASS;
  // Every guard after the opt-in is only reachable with it on; each test that
  // is about the opt-in itself turns it off again.
  beforeEach(() => { process.env.AGENTGLASS_CHAT_BYPASS = "1"; });
  afterEach(() => {
    if (prevBypass === undefined) delete process.env.AGENTGLASS_CHAT_BYPASS;
    else process.env.AGENTGLASS_CHAT_BYPASS = prevBypass;
    if (prevDisabled === undefined) delete process.env.AGENTGLASS_HERMES_DISABLED;
    else process.env.AGENTGLASS_HERMES_DISABLED = prevDisabled;
    if (prevRoot === undefined) delete process.env.AGENTGLASS_ROOT;
    else process.env.AGENTGLASS_ROOT = prevRoot;
    if (prevBin === undefined) delete process.env.AGENTGLASS_HERMES;
    else process.env.AGENTGLASS_HERMES = prevBin;
  });

  test("AGENTGLASS_HERMES_DISABLED refuses before spawn", async () => {
    // A binary is named so the missing-binary 403 cannot be the one answering.
    process.env.AGENTGLASS_HERMES = "/bin/true";
    process.env.AGENTGLASS_HERMES_DISABLED = "1";
    const r = hermesStream("/tmp", "hi", "anthropic/claude-sonnet-4", "", "default");
    expect(r.status).toBe(403);
    expect(await r.text()).toMatch(/AGENTGLASS_HERMES_DISABLED=1/);
  });

  test("without the bypass opt-in Hermes is neither offered nor run", async () => {
    // Single-query Hermes runs execute_code without asking in its default
    // mode, so the opt-in that covers unattended execution covers all of it.
    process.env.AGENTGLASS_HERMES = "/bin/true";
    delete process.env.AGENTGLASS_HERMES_DISABLED;
    process.env.AGENTGLASS_CHAT_BYPASS = "0";
    expect(HERMES_ENABLED()).toBe(false);
    const r = hermesStream("/tmp", "hi", "", "", "default");
    expect(r.status).toBe(403);
    expect(await r.text()).toMatch(/bypass opt-in/);
    process.env.AGENTGLASS_CHAT_BYPASS = "1";
    expect(HERMES_ENABLED()).toBe(true);
  });

  test("a missing binary is a named 403, not a fake mode", async () => {
    // No hermes on PATH in this sandbox — the early return fires before spawn.
    delete process.env.AGENTGLASS_HERMES_DISABLED;
    delete process.env.AGENTGLASS_HERMES;
    const r = hermesStream("/tmp", "hi", "anthropic/claude-sonnet-4", "", "default");
    // Either disabled-by-missing-bin (403) or invalid cwd (400) depending on
    // whether a hermes happens to be installed; never 200 with a fake stream.
    expect([400, 403]).toContain(r.status);
    if (r.status === 403) {
      const text = await r.text();
      expect(text.toLowerCase()).toMatch(/hermes/);
    }
  });

  test("out-of-scope cwd is refused with the same family of message as Claude", async () => {
    // Point the open project at a real temp repo, then ask for a different one.
    const a = await gitRepo();
    const b = await gitRepo();
    try {
      process.env.AGENTGLASS_ROOT = a;
      // Force the binary path so the missing-bin check does not win first.
      process.env.AGENTGLASS_HERMES = "/bin/true";
      delete process.env.AGENTGLASS_HERMES_DISABLED;
      const r = hermesStream(b, "hi", "anthropic/claude-sonnet-4", "", "default");
      expect(r.status).toBe(403);
      expect(await r.text()).toMatch(/outside the open project/);
    } finally {
      rmSync(a, { recursive: true, force: true });
      rmSync(b, { recursive: true, force: true });
    }
  });

  test("a symlink inside the project that points out of it is refused", async () => {
    // The path reads as inside the open project; what it resolves to is not.
    const a = await gitRepo();
    const b = await gitRepo();
    try {
      symlinkSync(b, join(a, "elsewhere"));
      process.env.AGENTGLASS_ROOT = a;
      process.env.AGENTGLASS_HERMES = "/bin/true";
      delete process.env.AGENTGLASS_HERMES_DISABLED;
      const r = hermesStream(join(a, "elsewhere"), "hi", "", "", "default");
      expect(r.status).toBe(403);
      expect(await r.text()).toMatch(/outside the open project/);
    } finally {
      rmSync(a, { recursive: true, force: true });
      rmSync(b, { recursive: true, force: true });
    }
  });

  test("a prompt the command line cannot carry is a 4xx, not a throw inside the route", async () => {
    // One argv element: the kernel refuses a NUL and anything over 128 KiB,
    // and Bun.spawn throws for both. Measured in UTF-8 bytes, not characters.
    process.env.AGENTGLASS_HERMES = "/bin/true";
    delete process.env.AGENTGLASS_HERMES_DISABLED;
    delete process.env.AGENTGLASS_ROOT;
    const dir = await gitRepo();
    try {
      const nul = hermesStream(dir, "run\0this", "", "", "default");
      expect(nul.status).toBe(400);
      expect(await nul.text()).toMatch(/NUL/);
      const long = hermesStream(dir, "a".repeat(MAX_MESSAGE_BYTES + 1), "", "", "default");
      expect(long.status).toBe(413);
      const cjk = "漢".repeat(40_001); // 40k characters, 120 003 bytes
      expect(cjk.length).toBeLessThan(MAX_MESSAGE_BYTES);
      const wide = hermesStream(dir, cjk, "", "", "default");
      expect(wide.status).toBe(413);
      expect(await wide.text()).toMatch(/KB/);
      const ok = hermesStream(dir, "a".repeat(MAX_MESSAGE_BYTES), "", "", "default");
      expect(ok.status).toBe(200);
      await ok.text();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the child gets the checked home and directory, whatever it inherits", async () => {
    // A stub hermes that writes what it was started with. If the spawn stopped
    // pinning HERMES_HOME, the resume check and Hermes would read two state.dbs.
    const stubDir = realpathSync(mkdtempSync(join(tmpdir(), "agx-hermes-stub-")));
    const home = realpathSync(mkdtempSync(join(tmpdir(), "agx-hermes-home-")));
    const dir = await gitRepo();
    const keys = ["HERMES_HOME", "AGENTGLASS_HERMES_HOME", "TERMINAL_CWD", "_HERMES_GATEWAY"] as const;
    const prev = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    try {
      const stub = join(stubDir, "hermes");
      writeFileSync(stub, [
        "#!/bin/sh",
        'printf "home=%s\\ncwd=%s\\nterm=%s\\ngw=%s\\n" "$HERMES_HOME" "$(pwd -P)" "$TERMINAL_CWD" "${_HERMES_GATEWAY-unset}" > ./.agx-hermes-env',
        "echo '{\"type\":\"result\"}'",
      ].join("\n") + "\n");
      chmodSync(stub, 0o755);
      process.env.AGENTGLASS_HERMES = stub;
      delete process.env.AGENTGLASS_HERMES_DISABLED;
      delete process.env.AGENTGLASS_ROOT;
      process.env.AGENTGLASS_HERMES_HOME = home;
      process.env.HERMES_HOME = "/srv/orbit/hermes";
      process.env.TERMINAL_CWD = "/srv/orbit";
      process.env._HERMES_GATEWAY = "1";
      const r = hermesStream(dir, "hi", "", "", "default");
      expect(r.status).toBe(200);
      await r.text();
      const got = Object.fromEntries(readFileSync(join(dir, ".agx-hermes-env"), "utf8").trim().split("\n").map((l) => l.split(/=(.*)/s).slice(0, 2)));
      expect(got).toEqual({ home, cwd: dir, term: dir, gw: "unset" });
    } finally {
      for (const k of keys) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]; }
      for (const d of [stubDir, home, dir]) rmSync(d, { recursive: true, force: true });
    }
  });

  test("an invalid underscore-less resume id is refused", async () => {
    process.env.AGENTGLASS_HERMES = "/bin/true";
    delete process.env.AGENTGLASS_HERMES_DISABLED;
    delete process.env.AGENTGLASS_ROOT; // unscoped so cwd checks can proceed further
    const dir = await gitRepo();
    try {
      const r = hermesStream(dir, "hi", "anthropic/claude-sonnet-4", "not-a-hermes-id", "default");
      expect(r.status).toBe(400);
      expect(await r.text()).toMatch(/session/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a slashless-invalid model id is refused", async () => {
    process.env.AGENTGLASS_HERMES = "/bin/true";
    delete process.env.AGENTGLASS_HERMES_DISABLED;
    delete process.env.AGENTGLASS_ROOT;
    const dir = await gitRepo();
    try {
      const r = hermesStream(dir, "hi", "not a model", "", "default");
      expect(r.status).toBe(400);
      expect(await r.text()).toMatch(/model/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * A Hermes state.db with the columns the resume path reads, in the shape of
 * upstream hermes_state_common.py's `sessions` table.
 */
function stateDb(dir: string, rows: Array<{ id: string; parent?: string; cwd?: string; yolo?: unknown; config?: string }>): string {
  const path = join(dir, "state.db");
  const db = new Database(path);
  db.run("CREATE TABLE sessions (id TEXT PRIMARY KEY, model_config TEXT, parent_session_id TEXT, cwd TEXT)");
  for (const r of rows) {
    db.query("INSERT INTO sessions (id, model_config, parent_session_id, cwd) VALUES (?, ?, ?, ?)")
      .run(r.id, r.config ?? JSON.stringify(r.yolo === undefined ? { model: "m" } : { model: "m", yolo_mode: r.yolo }), r.parent ?? null, r.cwd ?? null);
  }
  db.close();
  return path;
}

describe("resuming a session cannot move the turn or bring Bypass back", () => {
  // Hermes restores the row's cwd and its yolo_mode on --resume even with
  // --no-restore-cwd; these pin that the server refuses those resumes first.
  const CONT = "20260917_110000_abc123";
  let home = "", repo = "", other = "";
  beforeEach(async () => {
    home = realpathSync(mkdtempSync(join(tmpdir(), "agx-hermes-home-")));
    repo = await gitRepo();
    other = await gitRepo();
  });
  afterEach(() => {
    for (const d of [home, repo, other]) rmSync(d, { recursive: true, force: true });
  });

  test("the same directory and no Bypass resumes", () => {
    const db = stateDb(home, [{ id: SID, cwd: repo }]);
    expect(hermesResumeRefusal(SID, repo, "default", db)).toBeNull();
  });

  test("a session recorded in another directory is refused", () => {
    const db = stateDb(home, [{ id: SID, cwd: other }]);
    expect(hermesResumeRefusal(SID, repo, "default", db)).toMatch(/another directory/);
    expect(hermesResumeRefusal(SID, repo, "yolo", db)).toMatch(/another directory/);
  });

  test("the same directory reached through a symlink is the same directory", () => {
    const link = join(home, "link");
    symlinkSync(repo, link);
    const db = stateDb(home, [{ id: SID, cwd: link }]);
    expect(hermesResumeRefusal(SID, repo, "default", db)).toBeNull();
  });

  test("a session that ran in Bypass resumes only as Bypass", () => {
    const db = stateDb(home, [{ id: SID, cwd: repo, yolo: true }]);
    expect(hermesResumeRefusal(SID, repo, "default", db)).toMatch(/Bypass/);
    expect(hermesResumeRefusal(SID, repo, "yolo", db)).toBeNull();
  });

  test("Bypass is whatever Python's bool() calls true, not only true", () => {
    // Hermes restores it with bool(model_config.get("yolo_mode")).
    for (const yolo of [true, 1, 2.5, "true", "false", "0", [0], { on: 1 }]) {
      const db = stateDb(home, [{ id: SID, cwd: repo, yolo }]);
      expect(hermesResumeRefusal(SID, repo, "default", db)).toMatch(/Bypass/);
      rmSync(db);
    }
    for (const yolo of [false, 0, "", null, [], {}]) {
      const db = stateDb(home, [{ id: SID, cwd: repo, yolo }]);
      expect(hermesResumeRefusal(SID, repo, "default", db)).toBeNull();
      rmSync(db);
    }
  });

  test("a config this side cannot parse is read as Bypass", () => {
    // Python's json reads NaN; JSON.parse does not.
    const db = stateDb(home, [{ id: SID, cwd: repo, config: '{"yolo_mode": NaN}' }]);
    expect(hermesResumeRefusal(SID, repo, "default", db)).toMatch(/Bypass/);
    expect(hermesResumeRefusal(SID, repo, "yolo", db)).toBeNull();
  });

  test("a recorded directory that is not absolute is refused", () => {
    // Hermes resolves it against the spawn directory; this check cannot. The
    // last one names this repo from the test's own cwd, so only the
    // absolute-path rule refuses it.
    for (const cwd of [".", "~/orbit", "acme", relative(process.cwd(), repo)]) {
      const db = stateDb(home, [{ id: SID, cwd }]);
      expect(hermesResumeRefusal(SID, repo, "default", db)).toMatch(/another directory/);
      rmSync(db);
    }
  });

  test("the compression continuation Hermes follows is checked too", () => {
    const moved = stateDb(home, [{ id: SID, cwd: repo }, { id: CONT, parent: SID, cwd: other }]);
    expect(hermesResumeRefusal(SID, repo, "default", moved)).toMatch(/another directory/);
    rmSync(moved);
    const yolo = stateDb(home, [{ id: SID, cwd: repo }, { id: CONT, parent: SID, cwd: repo, yolo: true }]);
    expect(hermesResumeRefusal(SID, repo, "default", yolo)).toMatch(/Bypass/);
  });

  test("an unknown id, or a store it cannot read, is a refusal rather than a pass", () => {
    const db = stateDb(home, [{ id: CONT, cwd: repo }]);
    expect(hermesResumeRefusal(SID, repo, "default", db)).toMatch(/no session/);
    expect(hermesResumeRefusal(SID, repo, "default", join(home, "missing.db"))).toMatch(/cannot read/);
  });

  test("the send path refuses before spawning", async () => {
    const prev = { home: process.env.AGENTGLASS_HERMES_HOME, bin: process.env.AGENTGLASS_HERMES, root: process.env.AGENTGLASS_ROOT, bypass: process.env.AGENTGLASS_CHAT_BYPASS };
    try {
      stateDb(home, [{ id: SID, cwd: other }]);
      process.env.AGENTGLASS_HERMES_HOME = home;
      process.env.AGENTGLASS_HERMES = "/bin/true";
      process.env.AGENTGLASS_CHAT_BYPASS = "1";
      delete process.env.AGENTGLASS_ROOT;
      const r = hermesStream(repo, "again", "", SID, "default");
      expect(r.status).toBe(403);
      expect(await r.text()).toMatch(/another directory/);
    } finally {
      for (const [k, v] of [["AGENTGLASS_HERMES_HOME", prev.home], ["AGENTGLASS_HERMES", prev.bin], ["AGENTGLASS_ROOT", prev.root], ["AGENTGLASS_CHAT_BYPASS", prev.bypass]] as const) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
    }
  });
});

describe("which Hermes home a turn uses", () => {
  test("follows the sticky profile the way hermes does, and pins a profile dir as given", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "agx-hermes-root-")));
    try {
      expect(hermesHome({ HERMES_HOME: root })).toBe(root);
      writeFileSync(join(root, "active_profile"), "default\n");
      expect(hermesHome({ HERMES_HOME: root })).toBe(root);
      writeFileSync(join(root, "active_profile"), "orbit\n");
      expect(hermesHome({ HERMES_HOME: root })).toBe(join(root, "profiles", "orbit"));
      mkdirSync(join(root, "profiles", "acme"), { recursive: true });
      expect(hermesHome({ HERMES_HOME: join(root, "profiles", "acme") })).toBe(join(root, "profiles", "acme"));
      expect(hermesHome({ AGENTGLASS_HERMES_HOME: join(root, "profiles", "acme"), HERMES_HOME: "/elsewhere" })).toBe(join(root, "profiles", "acme"));
      writeFileSync(join(root, "active_profile"), "../escape\n");
      expect(hermesHome({ HERMES_HOME: root })).toBe(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a home under ~/.hermes takes the sticky profile of ~/.hermes, as hermes does", () => {
    // hermes_constants.get_default_hermes_root: anything under the native home
    // reads active_profile there, not in itself.
    const user = realpathSync(mkdtempSync(join(tmpdir(), "agx-hermes-user-")));
    try {
      const native = join(user, ".hermes");
      mkdirSync(join(native, "custom"), { recursive: true });
      writeFileSync(join(native, "active_profile"), "orbit\n");
      writeFileSync(join(native, "custom", "active_profile"), "acme\n");
      expect(hermesHome({ HOME: user, HERMES_HOME: join(native, "custom") })).toBe(join(native, "profiles", "orbit"));
      expect(hermesHome({ HOME: user })).toBe(join(native, "profiles", "orbit"));
      const elsewhere = join(user, "elsewhere");
      mkdirSync(elsewhere);
      expect(hermesHome({ HOME: user, HERMES_HOME: elsewhere })).toBe(elsewhere);
    } finally {
      rmSync(user, { recursive: true, force: true });
    }
  });
});
