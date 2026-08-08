/*
 * What a paired phone's turn is allowed to BE.
 *
 * `/chat/send` is one of the three routes an `answer` device may POST, because
 * answering an agent is what a phone is for. Two fields in its body were
 * trusted completely, and both are execution:
 *
 *   mode:"bypassPermissions"      -> claude --dangerously-skip-permissions
 *   allowedTools:["Bash", …]      -> the same reach, one tool at a time, and
 *                                    it works with chatBypass switched OFF
 *
 * Measured from a device holding nothing but `answer`, against a real server
 * with the token gate live, in the server's own workspaceRoot:
 *
 *   POST /chat/send {mode:"bypassPermissions", resumeId:""}   -> 200, and
 *     -p --output-format stream-json --verbose --model claude-opus-5 --dangerously-skip-permissions
 *   POST /chat/send {allowedTools:["Bash","Write","Edit"]}    -> 200, and
 *     -p --output-format stream-json --verbose --model claude-opus-5 --permission-mode default --allowedTools Bash Write Edit
 *
 * The same device is refused `/terminal/pty` (403) and `/git/push` (403). It
 * read the directory to run in off `/projects`, which its `read` half allows.
 *
 * So these tests are written against the ARGUMENTS a scope produces, not
 * against the status a route answers: every request in the report above
 * answered 200, correctly, having built a command line nobody had authorised.
 * `planTurn` itself cannot be exercised without a real `claude` on PATH (see
 * chat-effort.test.ts for the same reason), so the two pure halves it is now
 * made of are pinned here instead.
 */
import { describe, expect, test } from "bun:test";
import { scopedTurn, turnArgv, type TurnPlan } from "../src/chat.ts";
import type { Scope } from "../src/devices.ts";

/** A planned turn, as planTurn would hand it to the spawn. */
const plan = (over: Partial<Extract<TurnPlan, { ok: true }>> = {}): Extract<TurnPlan, { ok: true }> => ({
  ok: true,
  dir: "/repo",
  text: "hello",
  model: "claude-opus-5",
  mode: "default",
  effort: "",
  resumeId: "",
  images: [],
  allow: [],
  ...over,
});

/** What a caller of `scope` ends up running, asking for everything. */
function argvFor(scope: Scope, asked: { mode: string; allowedTools?: unknown; resumeId: string }): string[] {
  const s = scopedTurn(scope, asked.mode, asked.allowedTools, asked.resumeId);
  if (!s.ok) throw new Error(s.error);
  return turnArgv("claude", plan({ mode: s.mode, allow: s.allow, resumeId: asked.resumeId }));
}

describe("a device paired to answer", () => {
  const SESSION = "11111111-2222-3333-4444-555555555555";

  test("cannot skip permissions, however it asks", () => {
    const argv = argvFor("answer", { mode: "bypassPermissions", resumeId: SESSION });
    expect(argv).not.toContain("--dangerously-skip-permissions");
    expect(argv).toContain("--permission-mode");
    expect(argv[argv.indexOf("--permission-mode") + 1]).toBe("default");
  });

  test("cannot pre-approve a tool, which is the same thing spelled out", () => {
    const argv = argvFor("answer", { mode: "default", allowedTools: ["Bash", "Write", "Edit"], resumeId: SESSION });
    expect(argv).not.toContain("--allowedTools");
    expect(argv.join(" ")).not.toContain("Bash");
  });

  test("cannot ask for acceptEdits either — anything but the machine prompts", () => {
    // Not because acceptEdits is the same as bypass, but because the promise on
    // the phone's settings screen is "reply to a session that is running", and
    // a reply does not get to change what that session may do unattended.
    const argv = argvFor("answer", { mode: "acceptEdits", resumeId: SESSION });
    expect(argv[argv.indexOf("--permission-mode") + 1]).toBe("default");
  });

  test("cannot start a session at all: a turn with no resumeId is not a reply", () => {
    for (const mode of ["default", "plan", "acceptEdits", "bypassPermissions"]) {
      const s = scopedTurn("answer", mode, [], "");
      expect(s.ok, mode).toBe(false);
      if (!s.ok) expect(s.error).toContain("full access");
    }
  });

  test("and still gets its reply through", () => {
    // The half that must keep working: this is what the phone is for.
    const argv = argvFor("answer", { mode: "default", resumeId: SESSION });
    expect(argv).toEqual([
      "claude", "-p", "--output-format", "stream-json", "--verbose",
      "--model", "claude-opus-5", "--permission-mode", "default", "--resume", SESSION,
    ]);
  });

  test("a look-only device is clamped the same way, if it ever gets here", () => {
    // It cannot: scopeNeeded("POST","/chat/send") is "answer". Written as
    // "anything that is not full" rather than as "answer" so the rule does not
    // have to be revisited when a fourth scope appears.
    expect(scopedTurn("read", "bypassPermissions", ["Bash"], "")).toMatchObject({ ok: false });
    expect(scopedTurn("read", "bypassPermissions", ["Bash"], SESSION)).toEqual({ ok: true, mode: "default", allow: [] });
  });
});

describe("the desk", () => {
  const SESSION = "11111111-2222-3333-4444-555555555555";

  test("holds the machine's token, so nothing about it changes", () => {
    const argv = argvFor("full", { mode: "bypassPermissions", allowedTools: ["Bash"], resumeId: "" });
    expect(argv).toContain("--dangerously-skip-permissions");
    // No --allowedTools next to it: bypass already allows everything, and that
    // has been true since before any of this — see planTurn.
    expect(argv).not.toContain("--allowedTools");
  });

  test("keeps its allowlist in the prompting modes", () => {
    const argv = argvFor("full", { mode: "acceptEdits", allowedTools: ["Bash(git status)", "Read"], resumeId: "" });
    expect(argv.slice(argv.indexOf("--allowedTools"))).toEqual(["--allowedTools", "Bash(git status)", "Read"]);
    expect(argv[argv.indexOf("--permission-mode") + 1]).toBe("acceptEdits");
  });

  test("starts new sessions, which is the difference that matters", () => {
    expect(scopedTurn("full", "default", [], "")).toMatchObject({ ok: true });
    expect(argvFor("full", { mode: "default", resumeId: "" })).not.toContain("--resume");
    expect(argvFor("full", { mode: "default", resumeId: SESSION })).toContain("--resume");
  });

  test("and a tool spec that was rubbish is still dropped on the way", () => {
    // The allowlist filter is not replaced by the scope check, it runs under it.
    const argv = argvFor("full", { mode: "default", allowedTools: ["Bash", "; rm -rf ~", 7], resumeId: "" });
    expect(argv.slice(argv.indexOf("--allowedTools"))).toEqual(["--allowedTools", "Bash"]);
  });
});

describe("turnArgv", () => {
  test("carries effort, structured input and resume exactly as the spawn did", () => {
    // Pinned because this function was lifted out of chatStreamPlanned: if it
    // drifts from what the spawn used to build, every chat changes behaviour
    // and nothing says so.
    const argv = turnArgv("/usr/bin/claude", plan({
      mode: "plan", effort: "high", resumeId: "abcd1234-abcd", allow: ["Read"],
      images: [{ mediaType: "image/png", data: "aGk=" }],
    }));
    expect(argv).toEqual([
      "/usr/bin/claude", "-p", "--output-format", "stream-json", "--verbose",
      "--model", "claude-opus-5", "--effort", "high",
      "--input-format", "stream-json", "--permission-mode", "plan",
      "--allowedTools", "Read", "--resume", "abcd1234-abcd",
    ]);
  });

  test("a plain turn stays byte for byte what it was", () => {
    expect(turnArgv("claude", plan())).toEqual([
      "claude", "-p", "--output-format", "stream-json", "--verbose",
      "--model", "claude-opus-5", "--permission-mode", "default",
    ]);
  });
});
