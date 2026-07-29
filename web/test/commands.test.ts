/*
 * A project's own commands, on a device with no terminal.
 *
 * `/terminal/commands` reads the Makefile targets and package.json scripts of
 * every directory in a checkout, with the comment above each target as its
 * description. The cockpit puts them above the shell as one-tap buttons. The
 * phone never asked for them, because a phone has no shell to put them above —
 * and that is the wrong conclusion. What a phone has is an agent.
 */
import { describe, expect, it } from "bun:test";
import { commandRows, promptFor, commandsEmpty } from "../src/mobile/commands.ts";
import type { ProjectCommand, TerminalCommands } from "../../shared/types.ts";

const c = (over: Partial<ProjectCommand> = {}): ProjectCommand =>
  ({ name: "test", cmd: "make test", desc: "", dir: "", ...over });

const tc = (over: Partial<TerminalCommands> = {}): TerminalCommands =>
  ({ enabled: true, make: [], scripts: [], ...over });

describe("the list", () => {
  it("keeps a make target and a script that share a name", () => {
    // `make test` and `npm run test` are two different commands. A project
    // whose Makefile wraps its scripts is the common case, and dropping either
    // makes the list quietly disagree with the repository.
    const rows = commandRows(tc({
      make: [c({ name: "test", cmd: "make test" })],
      scripts: [c({ name: "test", cmd: "npm run test" })],
    }));
    expect(rows.map((r) => r.cmd)).toEqual(["make test", "npm run test"]);
  });

  it("drops a genuine duplicate", () => {
    const rows = commandRows(tc({
      make: [c({ cmd: "make test" }), c({ cmd: "make test" })],
    }));
    expect(rows).toHaveLength(1);
  });

  it("treats the same command in two packages as two commands", () => {
    // A monorepo runs `npm run build` in each of them, and they are not the
    // same build.
    const rows = commandRows(tc({
      scripts: [c({ name: "build", cmd: "npm run build", dir: "web" }),
                c({ name: "build", cmd: "npm run build", dir: "server" })],
    }));
    expect(rows).toHaveLength(2);
  });

  it("puts the root first, then reads a monorepo top-down", () => {
    const rows = commandRows(tc({
      scripts: [
        c({ name: "build", cmd: "a", dir: "web" }),
        c({ name: "build", cmd: "b", dir: "server" }),
        c({ name: "dev", cmd: "c", dir: "" }),
      ],
    }));
    expect(rows.map((r) => r.dir)).toEqual(["", "server", "web"]);
  });

  it("keeps the make version when a Makefile and a script are the same command", () => {
    // Rare, and the reason the two lists are collected in that order rather
    // than merged: `make test` written in both places is one command, and the
    // Makefile is where the project says so.
    const rows = commandRows(tc({
      make: [c({ name: "test", cmd: "make test" })],
      scripts: [c({ name: "t", cmd: "make test" })],
    }));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe("make");
  });

  it("puts make above scripts, because a target is the entry point", () => {
    const rows = commandRows(tc({
      make: [c({ name: "zzz", cmd: "make zzz" })],
      scripts: [c({ name: "aaa", cmd: "npm run aaa" })],
    }));
    expect(rows[0]!.kind).toBe("make");
  });

  it("gives every row a key that is unique and stable", () => {
    const input = tc({
      make: [c({ cmd: "make test" })],
      scripts: [c({ name: "test", cmd: "npm run test" }), c({ name: "b", cmd: "npm run b", dir: "web" })],
    });
    const keys = commandRows(input).map((r) => r.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(commandRows(input).map((r) => r.key)).toEqual(keys);
  });

  it("ignores a command with nothing to run", () => {
    expect(commandRows(tc({ make: [c({ cmd: "" }), c({ cmd: "   " })] }))).toEqual([]);
  });

  it("survives a payload that is not there yet", () => {
    expect(commandRows(null)).toEqual([]);
    expect(commandRows(undefined)).toEqual([]);
    expect(commandRows({ enabled: true } as TerminalCommands)).toEqual([]);
  });
});

describe("what the agent is asked", () => {
  it("carries the command verbatim", () => {
    // Paraphrasing it is how you end up running something else.
    expect(promptFor(c({ cmd: "make test" }))).toContain("`make test`");
  });

  it("says where, when it is not the root", () => {
    expect(promptFor(c({ cmd: "npm run build", dir: "web" }))).toContain("in web");
    expect(promptFor(c({ cmd: "npm run build", dir: "" }))).not.toContain(" in ");
  });

  it("passes on the description, because a target called `up` means nothing", () => {
    expect(promptFor(c({ cmd: "make up", desc: "Bring the stack up" })))
      .toContain("Bring the stack up");
    expect(promptFor(c({ desc: "   " }))).not.toContain("What it does");
  });

  it("asks for the failure, not just the outcome", () => {
    expect(promptFor(c())).toMatch(/fails/);
  });
});

describe("why there is nothing to show", () => {
  it("distinguishes the three ways of being empty", () => {
    // An empty list said the same thing about a project with no scripts, a
    // server with the terminal switched off, and a payload that had not
    // arrived. They are different facts and two of them are not about you.
    expect(commandsEmpty(null)).toBe("Still reading the project");
    expect(commandsEmpty(tc({ enabled: false, reason: "env" }))).toContain("switched off");
    expect(commandsEmpty(tc({ enabled: false, reason: "windows" }))).toContain("host");
    expect(commandsEmpty(tc())).toContain("No Makefile targets");
  });

  it("says nothing when there is something to say it about", () => {
    expect(commandsEmpty(tc({ make: [c()] }))).toBeNull();
  });

  it("explains a disabled terminal even without a reason", () => {
    const why = commandsEmpty(tc({ enabled: false }));
    expect(why).toBeTruthy();
    expect(why).not.toContain("undefined");
  });
});
