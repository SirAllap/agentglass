/*
 * The named-agent verbs, without tmux: what a screen means, which keys a
 * script may press, and every refusal `start` makes BEFORE it touches the
 * engine — the yolo gate above all, because a script that can pass the raw
 * flag has bought what Settings refused.
 */
import { describe, expect, test } from "bun:test";
import { keyNamed, stateOfScreen, startAgent, validName, refusedArg, namedAgentArgv, NAME_RE } from "../src/agentops.ts";
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

  test("the Gemini CLI's own spellings of yolo: the shorthand, and the mode as a separate word", () => {
    /* `gemini -y` and `gemini --approval-mode yolo` both start it with every
       prompt answered yes, and the Qwen Code CLI kept both from it. The word
       `yolo` as its own argument does not start with a dash, so the word
       pattern never saw it; only the flag name can refuse it. */
    for (const args of [["-y"], ["--approval-mode", "yolo"], ["--approval-mode", "auto_edit"]]) {
      expect(refusedArg(args), JSON.stringify(args)).toBe(args[0]!);
    }
  });

  test("the Qwen Code and Gemini name for extra directories, not only its alias", () => {
    /* `--add-dir` is refused, and in both CLIs it is only the alias of
       `--include-directories`, which reaches the same option under its own
       name and passed. */
    for (const args of [["--include-directories", "/"], ["--include-directories=/"]]) {
      expect(refusedArg(args), JSON.stringify(args)).toBe(args[0]!);
    }
  });

  test("a refused short flag grouped with others, or with its value glued on", () => {
    /* The gate compared the whole arg with its set, so `-y` was caught and
       `-cy` — continue and yolo, to a CLI whose parser groups short options —
       was not. Codex's `-a` takes its value glued the same way. */
    for (const args of [["-cy"], ["-yc"], ["-anever"], ["-ca", "never"], ["-cy=true"]]) {
      expect(refusedArg(args), JSON.stringify(args)).toBe(args[0]!);
    }
    for (const args of [["-c"], ["-p"], ["-m", "opus"], ["-cp"]]) {
      expect(refusedArg(args), JSON.stringify(args)).toBeNull();
    }
  });

  test("a Codex config override that loosens approvals or the sandbox, in every spelling", () => {
    /* `codex -c key=value` overrides any key of config.toml, so
       `-c approval_policy=never` is `-a never` under another name, and the value
       rides as its own word, which the gate skipped as a positional. Also its
       short `-s` for `--sandbox`, and `--approve-for-me`. Measured against
       codex-cli 0.155.1's --help. */
    const refused: [string[], string][] = [
      [["-c", "approval_policy=never"], "-c approval_policy=never"],
      [["--config", "sandbox_mode=danger-full-access"], "--config sandbox_mode=danger-full-access"],
      [["--config=approval_policy=never"], "--config=approval_policy=never"],
      [["-c=sandbox_mode=danger-full-access"], "-c=sandbox_mode=danger-full-access"],
      [["-capproval_policy=never"], "-capproval_policy=never"],
      [["-c", 'approval_policy="never"'], '-c approval_policy="never"'],
      [["-c", '"approval_policy"="never"'], '-c "approval_policy"="never"'],
      [["-c", 'sandbox_mode = "danger-full-access"'], '-c sandbox_mode = "danger-full-access"'],
      [["-c", "'sandbox_mode=danger-full-access'"], "-c 'sandbox_mode=danger-full-access'"],
      [["-c", "sandbox_workspace_write.network_access=true"], "-c sandbox_workspace_write.network_access=true"],
      [["-c", 'sandbox_permissions=["disk-full-read-access"]'], '-c sandbox_permissions=["disk-full-read-access"]'],
      [["-c", 'projects."/srv/acme".trust_level="trusted"'], '-c projects."/srv/acme".trust_level="trusted"'],
      [["-c", 'projects={"/srv/acme"={trust_level="trusted"}}'], '-c projects={"/srv/acme"={trust_level="trusted"}}'],
      [["-c", "profile=loose"], "-c profile=loose"],
      [["-c", 'profiles.loose.approval_policy="never"'], '-c profiles.loose.approval_policy="never"'],
      [["-c", "approvals_reviewer=auto"], "-c approvals_reviewer=auto"],
      [["-c", 'default_permissions="full"'], '-c default_permissions="full"'],
      [["-c", 'mcp_servers.tools.command="/tmp/tools"'], '-c mcp_servers.tools.command="/tmp/tools"'],
      [["-s", "danger-full-access"], "-s"],
      [["--approve-for-me"], "--approve-for-me"],
    ];
    for (const [args, named] of refused) expect(refusedArg(["--model", "x", ...args]), JSON.stringify(args)).toBe(named);
    for (const args of [["-c", 'model="o3"'], ["--config", "shell_environment_policy.inherit=all"], ["-c", 'model_reasoning_effort="high"'], ["-c"], ["-c", 'instructions="ask for approval first"']]) {
      expect(refusedArg(args), JSON.stringify(args)).toBeNull();
    }
  });

  test("OpenCode's --auto, whose help text says dangerous but whose name does not", async () => {
    /* `opencode --auto` approves every permission that is not explicitly
       denied. The word pattern reads the flag, not its help, so it passed with
       chatBypass off and OpenCode started with its prompts answered. */
    for (const args of [["--auto"], ["--auto=true"]]) {
      expect(refusedArg(args), JSON.stringify(args)).toBe(args[0]!);
      expect(await startAgent({ ...base, yoloAllowed: false, name: "w", kind: "opencode", args })).toEqual({ ok: false, error: "arg-refused", flag: args[0]! });
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

describe("the command line a named agent starts with", () => {
  test("pass-through flags go before the prompt, not between a prompt flag and its value", () => {
    /* OpenCode, Gemini and Qwen Code take the prompt on a flag. The flags were
       spliced in before the last element, which for them is the prompt's
       VALUE: `opencode --prompt --model x "go"` hands `--model` to `--prompt`
       and the prompt to nobody. */
    expect(namedAgentArgv("/usr/bin/opencode", "opencode", { name: "w", prompt: "go", args: ["--model", "x"] }, false))
      .toEqual(["/usr/bin/opencode", "--model", "x", "--prompt", "go"]);
    expect(namedAgentArgv("/usr/bin/qwen", "qwen", { name: "w", prompt: "go", args: ["--model", "x"] }, false))
      .toEqual(["/usr/bin/qwen", "--model", "x", "--prompt-interactive", "go"]);
  });

  test("and Claude's stays as it was: flags after the name, the prompt last", () => {
    expect(namedAgentArgv("/usr/bin/claude", "claude", { name: "w", prompt: "go", remoteControl: "w", args: ["--model", "opus"] }, true))
      .toEqual(["/usr/bin/claude", "--name", "w", "--remote-control", "w", "--model", "opus", "go"]);
    expect(namedAgentArgv("/usr/bin/claude", "claude", { name: "w", args: ["--model", "opus"] }, false))
      .toEqual(["/usr/bin/claude", "--model", "opus"]);
  });
});
