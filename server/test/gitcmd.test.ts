import { expect, test } from "bun:test";
import { coalesce, gitChange, runsMutatingGit } from "../src/gitcmd";

const post = (command: string, tool = "Bash") =>
  ({ hook_event_type: "PostToolUse", tool_name: tool, payload: { tool_input: { command } } });

test("git commit broadcasts once, ls never", () => {
  let sent = 0;
  const poke = coalesce(() => { sent++; });
  for (const ev of [post("ls"), post("git commit -m x")]) if (runsMutatingGit(ev)) poke();
  expect(sent).toBe(1);
});

test("matches verbs, flags and chains; rejects look-alikes", () => {
  expect(runsMutatingGit(post("cd x && git -C /r checkout main"))).toBe(true);
  expect(runsMutatingGit(post("git status"))).toBe(false);
  expect(runsMutatingGit(post("echo digit commit"))).toBe(false);
  expect(runsMutatingGit(post("git commit", "Read"))).toBe(false);
  expect(runsMutatingGit({ ...post("git commit"), hook_event_type: "PreToolUse" })).toBe(false);
});

test("coalesce: burst inside 500 ms gives a leading and one trailing send", () => {
  let t = 1000, sent = 0; const q: Array<() => void> = [];
  const poke = coalesce(() => { sent++; }, 500, () => t, (fn) => q.push(fn));
  poke(); poke(); poke();
  expect(sent).toBe(1); expect(q.length).toBe(1);
  t = 1500; q[0]!();
  expect(sent).toBe(2);
});

test("agent git commit: caches are cleared before the git broadcast", () => {
  const log: string[] = [];
  const poke = coalesce(gitChange(() => log.push("clear"), () => log.push("git")), 500);
  if (runsMutatingGit(post("git commit -m x"))) poke();
  expect(log).toEqual(["clear", "git"]);
});
