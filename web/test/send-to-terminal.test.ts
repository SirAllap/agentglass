/*
 * Every hand-off that used to open the Chat view now starts the person's default
 * engine in a window on the terminal engine: which engine, the window's name,
 * what is said afterwards, and that the request goes through the terminal's
 * one-slot door with the prompt as written.
 */
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { globalStubs } from "./stubGlobal";

const stubGlobal = globalStubs();
let mod: typeof import("../src/lib/sendToTerminal.ts");
let issue: typeof import("../src/lib/termIssue.ts");

beforeAll(async () => {
  stubGlobal("location", new URL("http://localhost:5173/"));
  stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {}, clear: () => {}, key: () => null, length: 0 } as unknown as Storage);
  stubGlobal("window", new EventTarget());
  mod = await import("../src/lib/sendToTerminal.ts");
  issue = await import("../src/lib/termIssue.ts");
});
afterEach(() => issue.clearTermIssue());

describe("windowNameFor", () => {
  test("keeps letters, digits and dashes, and bounds the length", () => {
    expect(mod.windowNameFor("Review #1042")).toBe("Review-1042");
    expect(mod.windowNameFor("  Resolve merge conflicts ")).toBe("Resolve-merge-conflicts");
    expect(mod.windowNameFor("a".repeat(80)).length).toBe(40);
    expect(mod.windowNameFor("???")).toBe("agent");
  });
});

describe("sendToTerminal", () => {
  test("leaves the prompt and checkout in the terminal's slot and names no engine: the server picks the default", async () => {
    void mod.sendToTerminal("/home/ana/code/orbit", "review it", "Review #1042");
    await Bun.sleep(5);
    expect(issue.termIssue()).toMatchObject({ cwd: "/home/ana/code/orbit", name: "Review-1042", prompt: "review it", agent: true, yolo: false, title: "Review #1042", reuse: true });
    expect(issue.termIssue()?.kind).toBeUndefined();
  });

  test("an engine named for one send travels with that send only", async () => {
    void mod.sendToTerminal("/home/ana/code/orbit", "x", "A", "opencode");
    await Bun.sleep(5);
    expect(issue.termIssue()?.kind).toBe("opencode");
    issue.clearTermIssue();
    void mod.sendToTerminal("/home/ana/code/orbit", "x", "B");
    await Bun.sleep(5);
    expect(issue.termIssue()?.kind).toBeUndefined();
  });

  test("a resume leaves the session id and no prompt", () => {
    void mod.resumeInTerminal("/home/ana/code/orbit", "aaaaaaaa-1111-4222-8333-000000000001");
    expect(issue.termIssue()).toMatchObject({ resumeId: "aaaaaaaa-1111-4222-8333-000000000001", prompt: "", cwd: "/home/ana/code/orbit" });
  });
});

describe("sentNote", () => {
  test("says where it went, or why it did not", () => {
    expect(mod.sentNote({ ok: true }, "#7")).toEqual({ ok: true, text: "#7 is waiting in a pane" });
    expect(mod.sentNote({ ok: true, reused: true }, "#7").text).toContain("already has its tab open");
    expect(mod.sentNote({ ok: false, error: "no tmux" }, "#7")).toEqual({ ok: false, text: "Not started: no tmux" });
  });
});
