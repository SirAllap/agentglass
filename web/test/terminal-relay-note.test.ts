// The relay's switch is read when the server starts, so what is saved and
// what is running can differ, and the environment can hold it either way. The
// line under the switch says which; a switch that reads "on" over a relay
// that is not running is how it went off unnoticed.
import { expect, test } from "bun:test";
import { terminalRelayNote } from "../src/lib/terminalRelayNote.ts";

test("saved and running agree, or the line says when they will", () => {
  expect(terminalRelayNote(true, true, null)).toBe("The relay is running.");
  expect(terminalRelayNote(false, false, null)).toBeNull();
  expect(terminalRelayNote(true, false, null)).toContain("the next time the app starts");
  expect(terminalRelayNote(false, true, null)).toContain("stops the next time the app starts");
  // Nothing known about the server: no claim either way.
  expect(terminalRelayNote(true, null, null)).toBeNull();
});

test("an environment that holds the switch is named, whatever is saved", () => {
  for (const stored of [true, false]) {
    expect(terminalRelayNote(stored, true, "1")).toContain("AGENTGLASS_TERMRELAY=1");
    expect(terminalRelayNote(stored, false, "0")).toContain("the relay is off");
  }
});
