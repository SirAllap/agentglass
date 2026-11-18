import { describe, expect, test } from "bun:test";
import { parseDnd } from "../src/desktopDnd.ts";

// Desktop DND is read from Omarchy's shell IPC. Anything it does not answer
// with on/off is "not known here", and the web keeps its own switch.
describe("parseDnd", () => {
  test("on and off, with the newline the shell prints", () => {
    expect(parseDnd("on\n")).toBe(true);
    expect(parseDnd("off\n")).toBe(false);
  });
  test("anything else is not a state", () => {
    expect(parseDnd("")).toBeNull();
    expect(parseDnd("error: no such target")).toBeNull();
  });
});
