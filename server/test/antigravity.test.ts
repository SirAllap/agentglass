import { test, expect, describe } from "bun:test";
import { antigravityArgs } from "../src/antigravity.ts";

// The command line that starts a run. It is pure, and the kind of thing that breaks silently — a mode flag that stops
// being passed still runs, it just runs with more authority than the label
// claims.

const BIN = "/usr/bin/agy";
const UUID = "78126291-f204-4b7a-b218-9a7e7ba9ac9a";

describe("the command line", () => {
  test("a first turn names the model and asks for the streaming format", () => {
    const a = antigravityArgs(BIN, "gemini-3.1-pro-high", "request-review", "", "hello");
    expect(a).toEqual([BIN, "-p", "hello", "--output-format", "stream-json", "--model", "gemini-3.1-pro-high"]);
  });

  test("the default mode is spelled by passing no flag", () => {
    // `--mode` only accepts accept-edits and plan; passing it "request-review"
    // is rejected outright, so the default has to be the absence of the flag.
    const a = antigravityArgs(BIN, "m", "request-review", "", "hi");
    expect(a).not.toContain("--mode");
    expect(a).not.toContain("--dangerously-skip-permissions");
  });

  test("plan and accept-edits ride --mode", () => {
    expect(antigravityArgs(BIN, "m", "plan", "", "hi")).toContain("--mode");
    expect(antigravityArgs(BIN, "m", "plan", "", "hi")).toContain("plan");
    expect(antigravityArgs(BIN, "m", "accept-edits", "", "hi")).toContain("accept-edits");
  });

  test("the unattended mode is its own flag, not a --mode value", () => {
    const a = antigravityArgs(BIN, "m", "always-proceed", "", "hi");
    expect(a).toContain("--dangerously-skip-permissions");
    expect(a).not.toContain("--mode");
  });

  test("a follow-up resumes the conversation it belongs to", () => {
    const a = antigravityArgs(BIN, "m", "request-review", UUID, "again");
    expect(a).toContain("--conversation");
    expect(a[a.indexOf("--conversation") + 1]).toBe(UUID);
  });

  test("the prompt is one argv element, however odd it looks", () => {
    // It goes in argv rather than on stdin, so a prompt full of quotes,
    // newlines and leading dashes must survive as a single value rather than
    // being read as more flags.
    const nasty = "--model evil\n'; rm -rf /\n\"quoted\"";
    const a = antigravityArgs(BIN, "m", "request-review", "", nasty);
    expect(a[1]).toBe("-p");
    expect(a[2]).toBe(nasty);
    expect(a.filter((x) => x === "--model")).toHaveLength(1);
  });
});

