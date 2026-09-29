import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  frameToEvent, hermesArgs, hermesConfiguredModel, hermesMode, hermesModel,
  hermesModels, hermesSession, hermesStream, newFrameContext, promptEvent,
  HERMES_APP, MODEL_RE, SESSION_RE,
} from "../src/hermes.ts";

const BIN = "/usr/bin/hermes";
const SID = "20260917_104709_fdc54d";

describe("the command line", () => {
  test("a first turn names the model and asks for the streaming format", () => {
    const a = hermesArgs(BIN, "anthropic/claude-sonnet-4", "", "default", "hello");
    expect(a).toEqual([BIN, "chat", "-q", "hello", "--format", "stream-json", "--no-restore-cwd", "-m", "anthropic/claude-sonnet-4"]);
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
    const nasty = "--model evil\n'; rm -rf /\n\"quoted\"";
    const a = hermesArgs(BIN, "m", "", "default", nasty);
    expect(a[2]).toBe("-q");
    expect(a[3]).toBe(nasty);
    expect(a.filter((x) => x === "-m")).toHaveLength(1);
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

describe("guards on the send path", () => {
  const prevDisabled = process.env.AGENTGLASS_HERMES_DISABLED;
  const prevRoot = process.env.AGENTGLASS_ROOT;
  const prevBin = process.env.AGENTGLASS_HERMES;
  afterEach(() => {
    if (prevDisabled === undefined) delete process.env.AGENTGLASS_HERMES_DISABLED;
    else process.env.AGENTGLASS_HERMES_DISABLED = prevDisabled;
    if (prevRoot === undefined) delete process.env.AGENTGLASS_ROOT;
    else process.env.AGENTGLASS_ROOT = prevRoot;
    if (prevBin === undefined) delete process.env.AGENTGLASS_HERMES;
    else process.env.AGENTGLASS_HERMES = prevBin;
  });

  test("AGENTGLASS_HERMES_DISABLED refuses before spawn", () => {
    process.env.AGENTGLASS_HERMES_DISABLED = "1";
    const r = hermesStream("/tmp", "hi", "anthropic/claude-sonnet-4", "", "default");
    expect(r.status).toBe(403);
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
