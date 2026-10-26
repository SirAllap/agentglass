/**
 * One permission mode for every terminal the app opens (launchperm.ts).
 *
 * The defect: the review window started Claude with no mode, so it ran in the
 * CLI's own default while every other agent ran without prompts, and messages
 * sent to it waited on a prompt nobody was looking at. The resume picker wrote
 * its flag inline and no launch carried a deny list.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDenyRules } from "../../shared/launchModes.ts";
import { launchFlags, launchPerm } from "../src/launchperm.ts";
import { agentArgv } from "../src/agentticket.ts";
import { withLaunchFlags } from "../src/recipes.ts";
import { launchDeny, launchMode, writeLaunchPermissions } from "../src/config.ts";

const prevXdg = process.env.XDG_CONFIG_HOME;
let dir = "";
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "agx-launchperm-"));
  process.env.XDG_CONFIG_HOME = dir;
});
afterAll(() => {
  if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = prevXdg;
  rmSync(dir, { recursive: true, force: true });
});

const DENY = ["Bash(gh pr merge:*)", "Bash(gh release:*)"];

describe("the setting", () => {
  test("a fresh install asks, and denies merging and releasing", () => {
    expect(launchMode()).toBe("default");
    expect(launchDeny()).toEqual(DENY);
  });

  test("a write is read back; a rule that does not parse refuses the whole write", () => {
    expect(writeLaunchPermissions({ mode: "bypassPermissions", deny: "Bash(gh pr merge:*)\n\nEdit\n" }).ok).toBe(true);
    expect(launchMode()).toBe("bypassPermissions");
    expect(launchDeny()).toEqual(["Bash(gh pr merge:*)", "Edit"]);
    expect(writeLaunchPermissions({ deny: "Edit\nBash(x'; rm -rf ~)" }).ok).toBe(false);
    expect(writeLaunchPermissions({ mode: "yolo" }).ok).toBe(false);
    expect(launchDeny()).toEqual(["Bash(gh pr merge:*)", "Edit"]);
    expect(writeLaunchPermissions({ mode: "default", deny: DENY.join("\n") }).ok).toBe(true);
  });

  test("no rule can carry shell syntax", () => {
    for (const bad of ["Bash($(id))", "Bash(`id`)", 'Bash("x")', "Bash(a\\b)", "Bash((x))", "-rf", "Bash(x) Edit"]) {
      expect(parseDenyRules(bad).bad, bad).toEqual([bad]);
    }
    expect(parseDenyRules("mcp__orbit__deploy\nBash(git push:*)").rules).toEqual(["mcp__orbit__deploy", "Bash(git push:*)"]);
  });
});

describe("the mode one launch resolves to", () => {
  test("an item's own mode wins over yolo, which wins over the global one", () => {
    writeLaunchPermissions({ mode: "auto" });
    expect(launchPerm().mode).toBe("auto");
    expect(launchPerm(undefined, true).mode).toBe("bypassPermissions");
    expect(launchPerm("default", true).mode).toBe("default");
    expect(launchPerm("acceptEdits").mode).toBe("acceptEdits");
    expect(launchPerm("nonsense").mode).toBe("auto");
    writeLaunchPermissions({ mode: "default" });
  });

  test("the global switch reaches every launch that follows it", () => {
    writeLaunchPermissions({ mode: "bypassPermissions" });
    expect(launchPerm().mode).toBe("bypassPermissions");
    writeLaunchPermissions({ mode: "acceptEdits" });
    expect(launchPerm().mode).toBe("acceptEdits");
    writeLaunchPermissions({ mode: "default" });
  });
});

describe("the command line", () => {
  const perm = { mode: "bypassPermissions" as const, deny: DENY };

  test("Claude: the deny list as one element, then the mode, the prompt last", () => {
    expect(agentArgv("/bin/claude", { prompt: "review 1042", yolo: false, title: "", perm }, false))
      .toEqual(["/bin/claude", "--disallowedTools", DENY.join(" "), "--permission-mode", "bypassPermissions", "review 1042"]);
  });

  test("a launch with perm never also carries the old skip flag", () => {
    const argv = agentArgv("/bin/claude", { prompt: "go", yolo: true, title: "", perm: { mode: "default", deny: [] } }, false);
    expect(argv).toEqual(["/bin/claude", "--permission-mode", "default", "go"]);
  });

  test("another CLI gets its own skip flag for bypass, and nothing it does not take", () => {
    expect(launchFlags("gemini", perm)).not.toContain("--disallowedTools");
    expect(launchFlags("gemini", { mode: "default", deny: DENY })).toEqual([]);
  });

  test("a Command step that starts claude gets the same flags, quoted", () => {
    expect(withLaunchFlags("claude -p \"hi\"", perm))
      .toBe(`claude "--disallowedTools" "${DENY.join(" ")}" "--permission-mode" "bypassPermissions" -p "hi"`);
    expect(withLaunchFlags("claude --permission-mode plan", perm)).toBe("claude --permission-mode plan");
    expect(withLaunchFlags("claudette run", perm)).toBe("claudette run");
    expect(withLaunchFlags("make test", perm)).toBe("make test");
  });
});

/*
 * THE GUARD: a new spawn site that does not go through launchperm.ts fails here.
 *
 * Three checks over server/src, comments stripped:
 *  1. every call of the shared builders (`agentArgv(`, `launchArgv(`) passes a `perm`;
 *  2. a permission flag written as a literal lives only in a file listed below;
 *  3. only a listed file looks up an agent binary — a new one is a new spawn site
 *     and has to be read before it joins the list.
 */
const SRC = join(import.meta.dir, "../src");
function files(d: string): string[] {
  return readdirSync(d).flatMap((n) => {
    const p = join(d, n);
    return statSync(p).isDirectory() ? files(p) : p.endsWith(".ts") ? [p] : [];
  });
}
const stripComments = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
const SOURCES = await Promise.all(files(SRC).map(async (f) => ({ f: f.slice(SRC.length + 1), text: stripComments(await Bun.file(f).text()) })));

/** The text of one call, from its name to its own closing paren. */
function callAt(text: string, at: number): string {
  let depth = 0;
  for (let i = text.indexOf("(", at); i < text.length; i++) {
    if (text[i] === "(") depth++;
    else if (text[i] === ")" && --depth === 0) return text.slice(at, i + 1);
  }
  return text.slice(at);
}

/** Files that write a permission flag themselves, and why that is right for them. */
const OWN_FLAGS: Record<string, string> = {
  "launchperm.ts": "the helper",
  "agentops.ts": "the list of flags a caller may NOT pass",
  "agents/claudecode.ts": "the pane engine: the caller picks its mode",
  "agents/headless.ts": "an unattended one-shot with no terminal",
  "understudy-judge.ts": "an unattended one-shot with no terminal",
  "index.ts": "runAgentIn, an unattended `claude -p` with no terminal",
  "antigravity.ts": "another vendor's engine",
};

/** Files that resolve an agent binary, and how each one launches it. */
const LOOKS_UP_A_BIN: Record<string, string> = {
  "agentticket.ts": "the builder",
  "terminal.ts": "every terminal path: agentArgv or launchFlags",
  "agentops.ts": "named agents: namedAgentArgv",
  "tmuxrestore.ts": "replays a saved launch after a reboot, flags as they were",
  "agents/claudecode.ts": "the pane engine",
  "understudy-judge.ts": "unattended one-shot",
  "walkthrough.ts": "unattended one-shot",
  "index.ts": "runAgentIn (one-shot) and a list of what is installed",
};

describe("every spawn site goes through the helper", () => {
  test("every builder call passes perm", () => {
    const loose: string[] = [];
    for (const { f, text } of SOURCES) {
      for (const m of text.matchAll(/\b(agentArgv|launchArgv)\(/g)) {
        if (/function\s+$/.test(text.slice(Math.max(0, m.index! - 12), m.index))) continue;
        const call = callAt(text, m.index!);
        // launch.ts hands its caller's whole request on, perm included.
        if (f === "agents/launch.ts" && call.startsWith("agentArgv(bin, req,")) continue;
        if (!/\bperm\b/.test(call)) loose.push(`${f}: ${call.slice(0, 80)}`);
      }
    }
    expect(loose, "pass perm: launchPerm(...) from launchperm.ts").toEqual([]);
  });

  test("a permission flag is written only where a launch is not a terminal", () => {
    const own = SOURCES.filter(({ text }) => /"--(dangerously-skip-permissions|permission-mode|disallowedTools|disallowed-tools)"/.test(text)).map(({ f }) => f);
    expect(own.filter((f) => !(f in OWN_FLAGS)), "build the flags with launchFlags/launchPerm").toEqual([]);
  });

  test("a new file that looks up an agent binary is a new spawn site", () => {
    const found = SOURCES.filter(({ text }) => /claudeCode\.bin\(\)|agentBinFor\(|Bun\.which\("claude"\)/.test(text)).map(({ f }) => f);
    expect(found.filter((f) => !(f in LOOKS_UP_A_BIN)), "route it through launchperm.ts, then list it here with how").toEqual([]);
  });
});
