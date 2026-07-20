import { test, expect } from "bun:test";
import { slashCommand } from "../src/transcripts.ts";

test("reads a command with args", () => {
  const raw = "<command-message>pr-resolve-reviews</command-message>\n<command-name>/pr-resolve-reviews</command-name>\n<command-args>16866</command-args>";
  expect(slashCommand(raw)).toBe("/pr-resolve-reviews 16866");
});

test("reads a command with no args", () => {
  expect(slashCommand("<command-name>/scrum</command-name><command-args></command-args>")).toBe("/scrum");
});

test("tolerates a missing args tag", () => {
  expect(slashCommand("<command-name>/scrum</command-name>")).toBe("/scrum");
});

test("copes with a name written without its slash", () => {
  expect(slashCommand("<command-name>scrum</command-name>")).toBe("/scrum");
});

test("keeps multi-word args", () => {
  expect(slashCommand("<command-name>/loop</command-name><command-args>5m check the deploy</command-args>"))
    .toBe("/loop 5m check the deploy");
});

// Session plumbing, not an instruction to the agent — showing "/clear" as a
// user turn would put noise where the actual request should be.
test("drops session-plumbing commands", () => {
  for (const c of ["clear", "compact", "cost", "init", "resume", "exit", "quit"]) {
    expect(slashCommand(`<command-name>/${c}</command-name>`)).toBeNull();
  }
});

test("returns null for ordinary text", () => {
  expect(slashCommand("just a normal message")).toBeNull();
  expect(slashCommand("")).toBeNull();
});

test("returns null for other meta markup", () => {
  expect(slashCommand("<system-reminder>be careful</system-reminder>")).toBeNull();
  expect(slashCommand("<local-command-stdout>ok</local-command-stdout>")).toBeNull();
});

test("args spanning lines are collapsed into one line, trimmed", () => {
  expect(slashCommand("<command-name>/x</command-name><command-args>\n  16866\n</command-args>")).toBe("/x 16866");
});
