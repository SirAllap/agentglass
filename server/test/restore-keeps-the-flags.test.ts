/*
 * THE FLAGS ARE PART OF THE DESK.
 *
 * The restore rebuilt every agent pane as a plain `claude --resume <id>`,
 * whatever it had actually been started with. The owner opens every session
 * with `--dangerously-skip-permissions` — measured on his own machine, four
 * panes of four — so a restore handed him back a desk that behaved differently
 * from the one he had, pane by pane, and he had to notice and fix each one.
 *
 * And a desk is not uniform: ten panes started one way and two the other come
 * back with the distinction flattened. That is the app deciding something it
 * was never asked to decide. In his words, it does not even consider it.
 *
 * What is tested here is the rule, not the machine: `agentArgsOf` takes the
 * argv the kernel holds for the process under a pane and says what a restored
 * pane should be started with. The end-to-end path needs a real CLI and a real
 * reboot; this is the part that can be pinned.
 */
import { describe, expect, test } from "bun:test";
import { agentArgsOf, runArgs, type CapturedPane } from "../src/tmuxrestore.ts";

const ID = "ae162752-359d-4df2-b70d-12efbb62ce7e";

describe("what a restored pane is started with", () => {
  test("the flag this user runs everything with survives", () => {
    /* His panes, verbatim from /proc on 2026-09-03. */
    expect(agentArgsOf(["claude", "--dangerously-skip-permissions"]))
      .toEqual(["--dangerously-skip-permissions"]);
    expect(agentArgsOf(["claude", "--dangerously-skip-permissions", "--resume", ID]))
      .toEqual(["--dangerously-skip-permissions"]);
  });

  test("a pane that was NOT started that way does not acquire it", () => {
    /* The other half of his complaint: a desk of ten yolo panes and two plain
       ones has to come back as ten and two. */
    expect(agentArgsOf(["/home/someone/.local/bin/claude", "--resume", ID])).toEqual([]);
  });

  test("the id is never carried in the flags — it is re-supplied, validated", () => {
    for (const argv of [
      ["claude", "--resume", ID],
      ["claude", `--resume=${ID}`],
      ["claude", "--session-id", ID],
      ["claude", `--session-id=${ID}`],
    ]) {
      expect(agentArgsOf(argv), argv.join(" ")).toEqual([]);
    }
  });

  test("a one-shot prompt is not replayed hours later", () => {
    /* `-p` runs one prompt and exits. Replaying it would re-run whatever was
       asked this morning and then take the window down as it left. */
    expect(agentArgsOf(["claude", "-p", "delete the branch", "--model", "opus"]))
      .toEqual(["--model", "opus"]);
    expect(agentArgsOf(["claude", "--print", "--model", "opus"])).toEqual(["--model", "opus"]);
  });

  test("a flag it has never seen is kept, because the person chose it", () => {
    /* An allow-list would drop tomorrow's flag silently, which is the same
       mistake this whole file is about, in a smaller box. */
    expect(agentArgsOf(["claude", "--brand-new-flag", "value", "--model", "sonnet"]))
      .toEqual(["--brand-new-flag", "value", "--model", "sonnet"]);
  });

  test("values with spaces survive, which is why this reads argv and not `ps` output", () => {
    expect(agentArgsOf(["claude", "--append-system-prompt", "be terse and kind"]))
      .toEqual(["--append-system-prompt", "be terse and kind"]);
  });

  test("nothing with a newline in it reaches a command line, and the line has a ceiling", () => {
    expect(agentArgsOf(["claude", "--model\nrm -rf /", "--effort", "high"]))
      .toEqual(["--effort", "high"]);
    expect(agentArgsOf(["claude", ...Array.from({ length: 80 }, (_, i) => `--f${i}`)])).toHaveLength(32);
  });

  test("an empty argv is an empty answer, not a crash", () => {
    expect(agentArgsOf([])).toEqual([]);
    expect(agentArgsOf(["claude"])).toEqual([]);
  });

  test("the end of the options is not a flag: nothing after `--` is replayed, and `--` itself is gone", () => {
    /* A launcher that ends its options with `--` before the brief. Kept, the
       rebuilt line read `claude … -- --resume <id>`: the id and the flag became
       the new session's first prompt, and the conversation was not resumed. */
    const argv = ["claude", "--model", "opus", "--disallowedTools", "Bash(git push)", "Bash(gh release:*)",
      "--", "Read the brief and follow it"];
    expect(agentArgsOf(argv)).toEqual(["--model", "opus", "--disallowedTools", "Bash(git push)", "Bash(gh release:*)"]);
    expect(agentArgsOf(argv, (t) => t === "Read the brief and follow it"))
      .toEqual(["--model", "opus", "--disallowedTools", "Bash(git push)", "Bash(gh release:*)"]);
  });

  test("a photograph that already holds `--` still resumes: the id is never past the end of the options", () => {
    const pane = { agentSession: ID, agentArgs: ["--model", "opus", "--"], startCommand: "" } as unknown as CapturedPane;
    const line = runArgs("all", pane, "/bin/claude");
    expect(line).toEqual(["/bin/claude", "--model", "opus", "--resume", ID]);
  });

  test("the ceiling cuts where a flag begins, never between a flag and its value", () => {
    const argv = ["claude", ...Array.from({ length: 31 }, (_, i) => `--f${i}`), "--model", "opus", "--effort", "high"];
    const kept = agentArgsOf(argv);
    expect(kept.at(-1)).not.toBe("--model");
    expect(kept).toHaveLength(31);
  });
});
