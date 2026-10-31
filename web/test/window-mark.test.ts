/*
 * One mark per tab, or none. The strip says what matters (needs you, failed,
 * working, back from a restart) and stays silent about a shell sitting idle;
 * unread output is a bold name, not a mark. The same words feed the aria-label
 * and the tooltip, so a screen reader hears what the colour says.
 */
import { describe, expect, test } from "bun:test";
import { windowMark } from "../src/lib/windowMark.ts";

const m = (over: Parameters<typeof windowMark>[0] extends infer T ? Partial<T> : never) => windowMark({ name: "api", ...over });

describe("which mark", () => {
  test("waiting is the amber needs-you mark", () => expect(m({ status: "waiting" }).mark).toBe("needs-you"));
  test("an agent error is the red failed mark", () => expect(m({ status: "error" }).mark).toBe("failed"));
  test("a dead pane is the red failed mark", () => expect(m({ dead: true }).mark).toBe("failed"));
  test("working is the breathing ring", () => expect(m({ status: "working" }).mark).toBe("working"));
  test("restored is the rest clock", () => expect(m({ restored: true }).mark).toBe("restored"));
  test("idle, done and no agent at all draw nothing", () => {
    for (const status of ["idle", "done", undefined] as const) expect(m({ status }).mark).toBeNull();
  });
  test("dead beats a stale working status", () => expect(m({ dead: true, status: "working" }).mark).toBe("failed"));
  test("restored beats the status it came back with: nothing is running", () => {
    expect(m({ restored: true, status: "working" }).mark).toBe("restored");
  });
});

describe("unread is a weight, not a mark", () => {
  test("the bell flag bolds the name and adds no mark", () => {
    const r = m({ flags: "#!" });
    expect(r.unread).toBe(true);
    expect(r.mark).toBeNull();
  });
  test("other flags do not", () => expect(m({ flags: "*Z-" }).unread).toBe(false));
  test("unread sits beside a mark, never instead of it", () => {
    const r = m({ flags: "!", status: "waiting" });
    expect(r.unread).toBe(true);
    expect(r.mark).toBe("needs-you");
  });
});

describe("words", () => {
  test("aria-label: name, state, new output", () => {
    expect(m({ status: "waiting", flags: "!" }).label).toBe("api, needs you, new output");
  });
  test("a quiet window is just its name", () => {
    const r = m({});
    expect(r.label).toBe("api");
    expect(r.title).toBe("");
  });
  test("unread alone still reads", () => expect(m({ flags: "!" }).label).toBe("api, new output"));
  test("tooltip is the state words", () => {
    expect(m({ status: "waiting" }).title).toBe("needs you");
    expect(m({ status: "working" }).title).toBe("working");
    expect(m({ status: "error" }).title).toBe("failed");
  });
  test("exited says the status when it is known", () => {
    expect(m({ dead: true, exitCode: 137 }).title).toBe("exited (137)");
    expect(m({ dead: true }).title).toBe("exited");
  });
  test("restored says what was running when it is known", () => {
    expect(m({ restored: true, wasRunning: "Claude Code" }).title).toBe("was running Claude Code");
    expect(m({ restored: true }).title).toBe("restored");
  });
});
