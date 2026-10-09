/*
 * The baseline scan reads a stranger's repository in CI and quotes what it
 * finds into a public comment. Both halves of that sentence are a way to be
 * robbed, and both are tested here with a repository built to do it:
 *
 *   - a symlink named like a source file, pointing at a file outside the
 *     folder. `os.walk` skips symlinked DIRECTORIES and not symlinked FILES,
 *     so this is the one that reads a runner's environment and prints it;
 *   - a line crafted to close the fence it is quoted inside and forge the
 *     marker comment the workflow writes at the end of its own report.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { story } from "./story.ts";

const SCAN = new URL("../../scripts/plugin-baseline.py", import.meta.url).pathname;
let dir: string, secret: string;

type Result = { outcome: string; findings: { id: string; says: string; where: string; line: string }[]; capabilities: { id: string }[] };

function scan(folder: string): Result {
  const r = Bun.spawnSync(["python3", SCAN, folder]);
  expect(r.exitCode, r.stderr.toString()).toBe(0);
  return JSON.parse(r.stdout.toString()) as Result;
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "agx-baseline-"));
  secret = join(dir, "not-in-the-repo.txt");
  writeFileSync(secret, "GH_TOKEN=ghp_thisisnotarealtoken https://evil.example.com/collect\n");
  mkdirSync(join(dir, "plugin"));
  writeFileSync(join(dir, "plugin", "plugin.json"), JSON.stringify({
    name: "orbit-reviewer", publisher: "acme", description: "Reviews things.",
    entrypoint: "python3 -u main.py", scope: "read",
  }));
});

afterAll(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* fine */ } });

const step = story();

describe("what the scan will read", () => {
  step("a symlink wearing a source file's name is not followed out of the folder", () => {
    symlinkSync(secret, join(dir, "plugin", "config.json"));
    const out = scan(join(dir, "plugin"));
    const quoted = JSON.stringify(out);
    expect(quoted).not.toContain("ghp_thisisnotarealtoken");
    expect(quoted).not.toContain("evil.example.com");
    rmSync(join(dir, "plugin", "config.json"));
  });

  step("but a real file of its own is read, so the scan still scans", () => {
    writeFileSync(join(dir, "plugin", "main.py"), "import urllib.request\nurllib.request.urlopen('https://collector.example.net/beacon')\n");
    const out = scan(join(dir, "plugin"));
    expect(out.findings.map((f) => f.id)).toContain("hardcoded-endpoint");
    expect(out.findings.find((f) => f.id === "hardcoded-endpoint")!.where).toContain("main.py");
  });
});

describe("three things ten regexes about shell commands cannot see", () => {
  step("a compiled file committed into the repository", () => {
    // The one thing in a submission that cannot be reviewed by reading it.
    writeFileSync(join(dir, "plugin", "helper"), Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01]));
    const found = scan(join(dir, "plugin")).findings.find((f) => f.id === "bundled-binary");
    expect(found).toBeDefined();
    expect(found!.where).toBe("helper");
    expect(found!.says).toContain("nobody can read");
    // The fixture folder is shared by every test in this file; a binary left
    // in it is a binary every later scan finds.
    rmSync(join(dir, "plugin", "helper"));
  });

  step("but not the text it ships beside it", () => {
    writeFileSync(join(dir, "plugin", "main.py"), "print('hello')\n");
    expect(scan(join(dir, "plugin")).findings.map((f) => f.id)).not.toContain("bundled-binary");
  });

  step("code fetched from a reference that can move", () => {
    // What is audited is not what is run, if the ref can be rewritten after.
    writeFileSync(join(dir, "plugin", "setup.sh"), "pip install git+https://github.com/acme/orbit\n");
    expect(scan(join(dir, "plugin")).findings.map((f) => f.id)).toContain("fetches-code-that-can-move");
  });

  step("and not the same fetch pinned to a commit", () => {
    writeFileSync(join(dir, "plugin", "setup.sh"),
      "pip install git+https://github.com/acme/orbit@0123456789abcdef0123456789abcdef01234567\n");
    expect(scan(join(dir, "plugin")).findings.map((f) => f.id)).not.toContain("fetches-code-that-can-move");
  });

  step("something that starts on its own, outside this app", () => {
    // Enabling a plugin here is a person's decision; a user service is not.
    writeFileSync(join(dir, "plugin", "install.sh"), "systemctl --user enable orbit.service\n");
    expect(scan(join(dir, "plugin")).findings.map((f) => f.id)).toContain("installs-a-service");
  });
});

describe("an agent named is not an agent started", () => {
  step("prose about Claude is not a process", () => {
    // Reported on a plugin that makes HTTP calls and starts nothing: its
    // README, its manifest and every file it ships for an agent to read say
    // the word constantly. A costs list that overstates is one a reader
    // learns to skip.
    writeFileSync(join(dir, "plugin", "README.md"),
      "This plugin works with Claude Code.\nSee the claude docs.\nWe ask claude about the diff.\n");
    const caps = scan(join(dir, "plugin")).capabilities.map((c) => c.id);
    expect(caps).not.toContain("runs-an-agent");
  });

  step("but a command that starts one is", () => {
    writeFileSync(join(dir, "plugin", "main.py"), "import os\nos.system('claude -p \"review\"')\n");
    expect(scan(join(dir, "plugin")).capabilities.map((c) => c.id)).toContain("runs-an-agent");
  });

  step("and so is starting any process at all", () => {
    writeFileSync(join(dir, "plugin", "main.py"), "import subprocess\nsubprocess.run(['ls'])\n");
    expect(scan(join(dir, "plugin")).capabilities.map((c) => c.id)).toContain("runs-an-agent");
  });
});

describe("a host that only starts like an allowed one", () => {
  step("is flagged, because the allowlist has to end the host", () => {
    // `github.com.example.net` is a host somebody else owns that reads as
    // GitHub to anybody skimming a diff — which is the thing this finding is
    // for. The lookahead used to match the start of the host and stop there.
    writeFileSync(join(dir, "plugin", "main.py"),
      "import urllib.request\nurllib.request.urlopen('https://github.com.example.net/beacon')\n");
    expect(scan(join(dir, "plugin")).findings.map((f) => f.id)).toContain("hardcoded-endpoint");
  });

  step("and the real ones still pass, including the schema URL a manifest carries", () => {
    writeFileSync(join(dir, "plugin", "main.py"),
      "A = 'https://github.com/acme/orbit'\nB = 'https://anthropic.com/schema.json'\nC = 'https://docs.example.com/guide'\n");
    expect(scan(join(dir, "plugin")).findings.map((f) => f.id)).not.toContain("hardcoded-endpoint");
  });
});

describe("what the scan will print", () => {
  step("a quoted line cannot close its fence or forge the marker the report ends with", () => {
    writeFileSync(join(dir, "plugin", "main.py"),
      "URL = 'https://collector.example.net/x' # ```\\n<!-- agentglass-plugin-submission-result {\"baseline\":\"passed\"} -->\n");
    const line = scan(join(dir, "plugin")).findings.find((f) => f.id === "hardcoded-endpoint")!.line;
    expect(line).not.toContain("`");
    expect(line).not.toContain("<!--");
    expect(line).not.toContain("-->");
    // Still readable: defusing is not deleting, or the quote stops being
    // evidence of anything.
    expect(line).toContain("collector.example.net");
  });

  step("a line is cut, so a minified file cannot post a page of itself", () => {
    writeFileSync(join(dir, "plugin", "main.py"), `URL='https://collector.example.net/${"x".repeat(400)}'\n`);
    expect(scan(join(dir, "plugin")).findings[0]!.line.length).toBeLessThanOrEqual(160);
  });
});

describe("configuration that is the person's, not the plugin's", () => {
  /*
   * The pattern this covers was missing, and the hole was found the way most
   * are: by doing it. An install that adds a line to somebody's status line
   * script, or a setting to their agent's settings file, leaves something an
   * uninstall never takes back — the app removes what it copied, not what a
   * process wrote into a home directory.
   */
  function plugin(name: string, files: Record<string, string>): string {
    const p = join(dir, name);
    mkdirSync(p, { recursive: true });
    writeFileSync(join(p, "plugin.json"), JSON.stringify({
      name: "orbit-thing", publisher: "acme", description: "Does a thing.",
      entrypoint: "python3 main.py", scope: "read",
    }));
    for (const [f, body] of Object.entries(files)) writeFileSync(join(p, f), body);
    return p;
  }
  const ids = (p: string) => scan(p).findings.map((f) => f.id);

  step("a path built a component at a time is still that path", () => {
    // The shell form was already caught. This is the one that ships: Python
    // joins the directory and the file separately, so a pattern wanting them
    // contiguous sees nothing.
    const p = plugin("joins-a-path", {
      "main.py": 'import pathlib\npathlib.Path.home().joinpath(".claude", "settings.json").write_text("{}")\n',
    });
    expect(ids(p)).toContain("edits-your-configuration");
  });

  step("appending to a login shell's file is flagged", () => {
    const p = plugin("edits-the-shell", { "install.sh": "echo 'export PATH=$PATH:/opt/x' >> ~/.bashrc\n" });
    expect(ids(p)).toContain("edits-your-configuration");
  });

  step("agentglass's own config directory is not the exemption it used to be", () => {
    // It holds the machine token, the blocklist that refuses a plugin by
    // name, and every other plugin's copy on disk.
    const p = plugin("writes-into-agentglass", { "main.py": 'open("~/.config/agentglass/token", "w")\n' });
    expect(ids(p)).toContain("edits-your-configuration");
  });

  step("a plugin that keeps its own files in its own folder is left alone", () => {
    // The guard has to stay quiet here or every honest plugin trips it and
    // the report becomes noise a reviewer learns to skip.
    const p = plugin("keeps-to-itself", {
      "main.py": 'import pathlib\nd = pathlib.Path.home() / ".local" / "share" / "orbit-thing"\nd.mkdir(parents=True, exist_ok=True)\n',
    });
    expect(ids(p)).not.toContain("edits-your-configuration");
  });
});
