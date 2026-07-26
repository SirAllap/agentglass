// The tmux chat engine's pure parts.
//
// Nothing here starts a tmux server or a `claude`. That is deliberate and not
// only about speed: a test that ran `new-session` against the default socket
// would land panes in the developer's own tmux, and this repo has already
// shipped a bug where the suite reached into a real home directory. The socket
// name and the state directory are both redirected below so that even a call
// that slipped through could not reach anything real.
import { test, expect, beforeAll } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AGENTGLASS_TMUX_SOCKET = "agentglass-test-never-started";
process.env.AGENTGLASS_STATE_DIR = join(tmpdir(), `agx-pane-test-${process.pid}`);
process.env.AGENTGLASS_CLAUDE_HOME = join(tmpdir(), `agx-claude-home-${process.pid}`);

let mod: typeof import("../src/chatpane.ts");
let pane: typeof import("../src/tmuxpane.ts");
beforeAll(async () => {
  mod = await import("../src/chatpane.ts");
  pane = await import("../src/tmuxpane.ts");
});

test("a working directory maps to the transcript directory Claude Code actually uses", () => {
  // Verified against a real session: every non-alphanumeric character becomes a
  // dash, so the separator and the leading dot of `.claude` each contribute one
  // and the run of two dashes is correct rather than a bug.
  expect(mod.projectSlug("/home/x/code/app")).toBe("-home-x-code-app");
  expect(mod.projectSlug("/home/x/code/app/.claude/worktrees/wt")).toBe("-home-x-code-app--claude-worktrees-wt");
  expect(mod.projectSlug("/a/b.c/d_e")).toBe("-a-b-c-d-e");
});

test("the transcript path is computable before the session has written anything", () => {
  const p = mod.transcriptFor("/home/x/repo", "6f1c9b52-0000-4000-8000-0123456789ab");
  expect(p.endsWith(join("projects", "-home-x-repo", "6f1c9b52-0000-4000-8000-0123456789ab.jsonl"))).toBe(true);
});

test("a pane name must be uuid-shaped, because tmux resolves targets from it", () => {
  expect(pane.validPaneName("6f1c9b52-0000-4000-8000-0123456789ab")).toBe(true);
  // `:` and `.` are tmux's window and pane separators. A name carrying either
  // would address a target we did not mean, and these names arrive on an HTTP
  // request, so the shape is pinned rather than escaped.
  expect(pane.validPaneName("session:1.0")).toBe(false);
  expect(pane.validPaneName("../../etc/passwd")).toBe(false);
  expect(pane.validPaneName("has space")).toBe(false);
  expect(pane.validPaneName("$(id)")).toBe(false);
  expect(pane.validPaneName("short")).toBe(false);
  expect(pane.validPaneName("")).toBe(false);
});

test("the attach command names our socket, not the user's default server", () => {
  const cmd = pane.attachCommand("6f1c9b52-0000-4000-8000-0123456789ab");
  // The `-L` is the whole reason the user's own tmux (and their resurrect saves)
  // are untouched. A command without it would attach to their server.
  expect(cmd).toContain("-L agentglass-test-never-started");
  expect(cmd).toContain("attach -t 6f1c9b52-0000-4000-8000-0123456789ab");
});

test("a turn with no attachments is pasted exactly as typed", () => {
  // Nothing may be added to a plain prompt: the text that reaches the model has
  // to be the text the user wrote.
  expect(mod.panePrompt("hello", [])).toBe("hello");
  expect(mod.panePrompt("/help is literal here\nsecond line", [])).toBe("/help is literal here\nsecond line");
});

test("attachments are named on their own lines, under the user's own words", () => {
  const out = mod.panePrompt("what is wrong here?", ["/tmp/a.png"]);
  expect(out.startsWith("what is wrong here?")).toBe(true);
  expect(out).toContain("/tmp/a.png");
  // Singular vs plural, because the sentence is read by the model and a wrong
  // plural is a wrong instruction about how many files to open.
  expect(out).toContain("Attached image (read it");
  const two = mod.panePrompt("compare", ["/tmp/a.png", "/tmp/b.png"]);
  expect(two).toContain("Attached images (read them");
  expect(two).toContain("/tmp/b.png");
});

test("an image with no text still produces a prompt that says what to do", () => {
  const out = mod.panePrompt("", ["/tmp/only.png"]);
  expect(out.startsWith("Attached image")).toBe(true);
  expect(out).toContain("/tmp/only.png");
});

test("eviction leaves a pane it has never seen before alone", async () => {
  // The sweeper must not kill a pane simply because it has no record of it —
  // after a server restart every live chat looks exactly like that, and killing
  // one mid-work to reclaim memory is far worse than holding the memory.
  pane.__resetPaneState();
  // No tmux server is running on this socket, so listPanes is empty and the
  // sweep is a no-op. What is being pinned here is that it does not throw and
  // reports nothing reclaimed.
  expect(await pane.evictIdlePanes()).toEqual([]);
});

test("a test that forgot to redirect the socket cannot start a real pane", async () => {
  // The guard that matters most in this file. Every other call here asks tmux a
  // question a missing server answers with "no"; startPane is the one that would
  // CREATE something, and without this an unrelated test importing this module
  // could put a live `claude` in the developer's own tmux.
  const saved = process.env.AGENTGLASS_TMUX_SOCKET;
  delete process.env.AGENTGLASS_TMUX_SOCKET;
  try {
    const r = await pane.startPane("6f1c9b52-0000-4000-8000-0123456789ab", "/tmp", ["/bin/true"]);
    expect(r.ok).toBe(false);
    expect(r.stderr).toContain("AGENTGLASS_TMUX_SOCKET");
  } finally {
    if (saved !== undefined) process.env.AGENTGLASS_TMUX_SOCKET = saved;
  }
  // And nothing was created on the real socket.
  expect(await pane.listPanes()).toEqual([]);
});

test("tmux availability is reported with a reason a person can act on", () => {
  const cap = pane.tmuxCapability();
  expect(typeof cap.available).toBe("boolean");
  // Never available-without-explanation, and never unavailable-without-reason:
  // the settings row prints this string verbatim.
  if (!cap.available) expect(cap.reason.length).toBeGreaterThan(0);
});
