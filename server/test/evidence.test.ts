// What the evidence says about a running tool call.
//
// The old rule was elapsed time alone: warn at five minutes, write the pair off
// at thirty. It is wrong in both directions — half the warnings were healthy
// builds, and a genuinely long job vanished from the fleet while it was still
// working — because slow and hung look identical from the input side.
//
// These pin the replacement. The classifier is pure and takes its sources as
// numbers, so every case below is a claim that can be argued with rather than a
// machine that happened to behave.
import { describe, expect, test } from "bun:test";
import { classify, watchesDirectory } from "../src/evidence.ts";

const NOW = 1_700_000_000_000;
const ago = (ms: number) => NOW - ms;
const min = (n: number) => n * 60_000;
const none = { transcriptAt: null, targetAt: null, dirAt: null };

describe("a tool that names the file it will touch", () => {
  test("the file changed since the call opened: working", () => {
    expect(classify({ tool_name: "Edit", since: ago(min(8)) }, { ...none, targetAt: ago(min(1)) }, NOW)).toBe("working");
  });

  test("eight minutes and the file has not moved: stuck", () => {
    // The case the elapsed-time rule could not see. Nothing about the duration
    // decides this — a file that was going to change would have changed.
    expect(classify({ tool_name: "Write", since: ago(min(8)) }, { ...none, targetAt: ago(min(30)) }, NOW)).toBe("stuck");
  });

  test("a call younger than the quiet window is not accused", () => {
    // An Edit that opened four seconds ago has not failed to do anything yet.
    expect(classify({ tool_name: "Edit", since: ago(4000) }, { ...none, targetAt: ago(min(30)) }, NOW)).toBe("working");
  });

  test("a target we cannot read at all is `unknown`, not `stuck`", () => {
    // A file the tool has not created yet, or an input we could not parse.
    // "The file did not move" and "there is no file to look at" are different
    // claims and only the first accuses anybody.
    expect(classify({ tool_name: "Write", since: ago(min(8)) }, none, NOW)).toBe("unknown");
  });
});

describe("a tool that leaves nothing behind", () => {
  test("minutes of open Glob is stuck", () => {
    // There is no such thing as a slow Glob, so silence really is the answer.
    expect(classify({ tool_name: "Glob", since: ago(min(6)) }, none, NOW)).toBe("stuck");
  });

  test("a Read that just started is fine", () => {
    expect(classify({ tool_name: "Read", since: ago(2000) }, none, NOW)).toBe("working");
  });
});

describe("Bash, which may write anywhere or nowhere", () => {
  test("something moved in its working directory: working", () => {
    expect(classify({ tool_name: "Bash", since: ago(min(20)) }, { ...none, dirAt: ago(1000) }, NOW)).toBe("working");
  });

  test("a twenty-minute build that has written nothing is `unknown`, not `stuck`", () => {
    // The honest answer. A command can legitimately compute for a long time
    // writing nothing — a query, a fetch, a test run held on stdout — and
    // claiming a hang we cannot see is exactly how the five-minute warning lost
    // its credibility.
    expect(classify({ tool_name: "Bash", since: ago(min(20)) }, none, NOW)).toBe("unknown");
  });

  test("directory movement from before the call started is not evidence for it", () => {
    // The build output that was already there when the command began says
    // nothing about whether the command is running.
    expect(classify({ tool_name: "Bash", since: ago(min(20)) }, { ...none, dirAt: ago(min(40)) }, NOW)).toBe("unknown");
  });
});

describe("tools whose work happens somewhere we cannot watch", () => {
  test("a WebFetch is never accused", () => {
    expect(classify({ tool_name: "WebFetch", since: ago(min(45)) }, none, NOW)).toBe("unknown");
  });

  test("an MCP tool is never accused", () => {
    expect(classify({ tool_name: "mcp__figma__get_design", since: ago(min(45)) }, none, NOW)).toBe("unknown");
  });

  test("and neither is asked for a directory scan", () => {
    // Reading a project directory to decide whether a WebFetch is alive is work
    // spent to learn nothing.
    expect(watchesDirectory("WebFetch")).toBe(false);
    expect(watchesDirectory("mcp__x__y")).toBe(false);
    expect(watchesDirectory("Edit")).toBe(false);
    expect(watchesDirectory("Bash")).toBe(true);
  });
});

describe("telling a lost pair from a hang", () => {
  // Measured against a real run: the CLI writes the tool_use record about three
  // seconds after a call opens and then nothing until the result. So transcript
  // growth well after the call began means the result landed and our Post event
  // did not — our bookkeeping failed, the session is fine.
  test("the transcript grew long after the call opened: lost, not stuck", () => {
    expect(classify({ tool_name: "Bash", since: ago(min(10)) }, { ...none, transcriptAt: ago(min(2)) }, NOW)).toBe("lost");
  });

  test("growth inside the settle window is the call being recorded, not the CLI moving on", () => {
    // Three seconds after the call opened is the tool_use record. Reading that
    // as "the CLI moved on" would mark every call lost the moment it started.
    expect(classify({ tool_name: "Bash", since: ago(min(10)) }, { ...none, transcriptAt: ago(min(10)) + 3000 }, NOW)).toBe("unknown");
  });

  test("a quiet transcript during a long Bash is normal and accuses nobody", () => {
    // The measurement that shaped all of this: the transcript does not grow
    // while a command runs. A rule built on it would call every long build hung.
    expect(classify({ tool_name: "Bash", since: ago(min(15)) }, { ...none, transcriptAt: ago(min(16)) }, NOW)).toBe("unknown");
  });
});
