/*
 * Shell integration goes on a shell, and only on a shell.
 *
 * The instrumentation was written when `ptyOpen` had two outcomes: a shell and
 * an editor. It now also attaches to tmux — the engine, a resumed desk, a
 * phone's pane — and runs agent CLIs, and every one of those would have been
 * handed the shim: `-il` to nvim, and the snippet's variables into a tmux
 * server, which then hands them to every shell it ever spawns, out of a scratch
 * rc directory that is deleted when this one session closes.
 *
 * `chooseRun` is the seam that decides it. The argv it returns is checked here
 * too, because the priority order is what the panel relies on and a swap
 * between two of these is not visible in a screenshot.
 */
import { test, expect } from "bun:test";
import { chooseRun } from "../src/terminal.ts";

const SHELL = ["/bin/bash", "-il"];
const base = {
  attachArgv: null as string[] | null,
  agentRun: [] as string[],
  editorArgv: null as string[] | null,
  engine: null as string[] | null,
  resume: null as string[] | null,
  shellArgv: SHELL,
};

test("a plain shell is ours, and is what runs", () => {
  const { run, ownShell } = chooseRun(base);
  expect(run).toBe(SHELL);
  expect(ownShell).toBe(true);
});

test("a pane attach is not ours", () => {
  const attachArgv = ["tmux", "-L", "agentglass", "attach"];
  const { run, ownShell } = chooseRun({ ...base, attachArgv });
  expect(run).toBe(attachArgv);
  expect(ownShell).toBe(false);
});

test("an agent CLI is not ours", () => {
  const agentRun = ["claude", "--resume"];
  const { run, ownShell } = chooseRun({ ...base, agentRun });
  expect(run).toBe(agentRun);
  expect(ownShell).toBe(false);
});

test("a file viewer is not ours", () => {
  const editorArgv = ["nvim", "-R", "/tmp/x.ts"];
  const { run, ownShell } = chooseRun({ ...base, editorArgv });
  expect(run).toBe(editorArgv);
  expect(ownShell).toBe(false);
});

test("the engine and a resumed desk are not ours", () => {
  const engine = ["tmux", "-L", "agentglass", "new-session", "-A"];
  const resume = ["tmux", "-L", "default", "attach"];
  expect(chooseRun({ ...base, engine }).ownShell).toBe(false);
  expect(chooseRun({ ...base, resume }).ownShell).toBe(false);
  // Engine before resume: a console that docked on the engine must not be
  // handed the desk session it happened to have open.
  expect(chooseRun({ ...base, engine, resume }).run).toBe(engine);
});

test("priority: attach beats an agent, which beats a viewer, which beats the engine", () => {
  const attachArgv = ["tmux", "attach"];
  const agentRun = ["claude"];
  const editorArgv = ["nvim", "-R", "/tmp/x"];
  const engine = ["tmux", "new-session"];
  expect(chooseRun({ ...base, attachArgv, agentRun, editorArgv, engine }).run).toBe(attachArgv);
  expect(chooseRun({ ...base, agentRun, editorArgv, engine }).run).toBe(agentRun);
  expect(chooseRun({ ...base, editorArgv, engine }).run).toBe(editorArgv);
  expect(chooseRun({ ...base, engine }).run).toBe(engine);
});
