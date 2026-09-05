/*
 * The named-agent verbs, without tmux: what a screen means, which keys a
 * script may press, and every refusal `start` makes BEFORE it touches the
 * engine — the yolo gate above all, because a script that can pass the raw
 * flag has bought what Settings refused.
 */
import { describe, expect, test } from "bun:test";
import { keyNamed, stateOfScreen, startAgent, validName, refusedArg, NAME_RE } from "../src/agentops.ts";
import { SPELLINGS } from "../src/agents/launch.ts";

const READY = [
  "╭──────────────────────────────╮",
  "│ ❯ Try \"fix the failing test\"  │",
  "╰──────────────────────────────╯",
  "  ? for shortcuts",
].join("\n").replace("│ ❯", "❯");
const WORKING = "⏺ Reading files…\n  (esc to interrupt)\n\n❯ \n";
const PERMISSION = "Bash(rm -rf build)\n  Do you want to proceed?\n  ❯ 1. Yes\n  2. No\n  Esc to cancel\n";
const SHELL = "$ \n";

describe("what a screen says", () => {
  test("a drawn input box is ready; a turn in flight is working; a prompt on a person is needs-you", () => {
    expect(stateOfScreen(READY)).toBe("ready");
    expect(stateOfScreen(WORKING)).toBe("working");
    expect(stateOfScreen(PERMISSION)).toBe("needs-you");
  });
  test("a shell with no CLI drawn yet is starting; no screen at all is gone", () => {
    expect(stateOfScreen(SHELL)).toBe("starting");
    expect(stateOfScreen(null)).toBe("gone");
  });
  test("needs-you outranks working: a permission prompt is drawn while the turn is still open", () => {
    expect(stateOfScreen(WORKING + PERMISSION)).toBe("needs-you");
  });
});

describe("the keys a script may press", () => {
  test("by the names the worker already uses, case-insensitive", () => {
    expect(keyNamed("enter")).toBe("Enter");
    expect(keyNamed("Enter")).toBe("Enter");
    expect(keyNamed("escape")).toBe("Escape");
    expect(keyNamed("ctrl-c")).toBe("C-c");
  });
  test("and nothing else — text goes through prompt, never send-keys", () => {
    expect(keyNamed("rm -rf /")).toBeNull();
    expect(keyNamed("C-d")).toBeNull();
    expect(keyNamed(42)).toBeNull();
  });
});

describe("names", () => {
  test("a name is what a script types and tmux is told: plain, short, no separators tmux reads", () => {
    expect(validName("proj1234")).toBe(true);
    expect(validName("proj1234-2")).toBe(true);
    expect(validName("a.b_c")).toBe(true);
    expect(validName("")).toBe(false);
    expect(validName("-lead")).toBe(false);
    expect(validName("has space")).toBe(false);
    expect(validName("colon:target")).toBe(false);
    expect(validName("x".repeat(65))).toBe(false);
    expect(validName(7)).toBe(false);
    expect(NAME_RE.source).toContain("63");
  });
});

describe("start refuses before it reaches the engine", () => {
  const base = { root: "/nowhere", cwd: "/nowhere", yoloAllowed: true };
  test("a bad name", async () => {
    expect(await startAgent({ ...base, name: "no good" })).toEqual({ ok: false, error: "bad-name" });
  });
  test("an unknown CLI", async () => {
    expect(await startAgent({ ...base, name: "w", kind: "vim" })).toEqual({ ok: false, error: "no-cli" });
  });
  test("an arg with a newline in it", async () => {
    expect(await startAgent({ ...base, name: "w", args: ["--flag\n--other"] })).toEqual({ ok: false, error: "bad-args" });
  });
  test("the yolo flag asked for when Settings refuse it", async () => {
    expect(await startAgent({ ...base, name: "w", yolo: true, yoloAllowed: false })).toEqual({ ok: false, error: "yolo-refused" });
  });
  test("the raw yolo flag smuggled through the pass-through args, whatever Settings say", async () => {
    for (const flag of ["--dangerously-skip-permissions", "--yolo", "--full-auto"]) {
      expect(await startAgent({ ...base, name: "w", args: [flag] })).toEqual({ ok: false, error: "arg-refused", flag });
    }
  });

  test("and every other way of saying it — named in the refusal, never dropped", async () => {
    /*
     * The three-string list above held the door while these walked through
     * it. Measured against that list: each passed, with chatBypass OFF.
     */
    const smuggled: string[][] = [
      ["--permission-mode", "bypassPermissions"],
      ["--permission-mode=bypassPermissions"],
      ["--settings", '{"permissions":{"defaultMode":"bypassPermissions"}}'],
      ["--mcp-config", "/tmp/tools.json"],
      ["--allowedTools", "Bash"], ["--allowed-tools", "Bash"], ["--disallowedTools", ""],
      ["--add-dir", "/"],
      ["--sandbox", "danger-full-access"], ["-a", "never"], ["--ask-for-approval", "never"],
      ["--dangerously-bypass-approvals-and-sandbox"],
      ["--dangerously-anything-new"],
      ["--Skip-Permissions-Please"], ["--no-yolo-really"], ["--run-full-auto"],
    ];
    for (const args of smuggled) {
      const r = await startAgent({ ...base, name: "w", args: ["--model", "x", ...args] });
      expect(r, JSON.stringify(args)).toEqual({ ok: false, error: "arg-refused", flag: args[0]! });
    }
  });

  test("the bypass flag of EVERY kind launch.ts knows is in the gate, so a new vendor cannot arrive without it", () => {
    for (const [kind, s] of Object.entries(SPELLINGS)) {
      expect(refusedArg([s.bypass]), `${kind}'s ${s.bypass} passed`).toBe(s.bypass);
    }
  });

  test("an ordinary flag, and a value that merely contains a hot word, still pass", () => {
    /* `--model`, `--remote-control`, a prompt mentioning "dangerous": the gate
       is on flags, not on prose. A refusal that fired on the word inside a
       positional would make "review the dangerous-goods form" unstartable. */
    expect(refusedArg(["--model", "opus", "--verbose", "review the dangerous-goods form", "yolo-mode.md"])).toBeNull();
  });
});
