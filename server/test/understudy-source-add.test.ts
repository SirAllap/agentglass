/*
 * What a person may add as a source of their own.
 *
 * `POST /understudy/source/add` took any absolute path that existed, and the
 * reader behind it opens every parseable file underneath — `~/.ssh` and
 * `~/.aws` were one request away from the policy bank. The rule lives in
 * understudy-sources.ts and `addExtraSource` refuses through it; the fixture
 * is a fake home with HOME, XDG_CONFIG_HOME and the database all jailed.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const saved = { HOME: process.env.HOME, XDG: process.env.XDG_CONFIG_HOME, DB: process.env.AGENTGLASS_DB, HIST: process.env.HISTFILE };
let home = "";
let U: typeof import("../src/understudy.ts");
let S: typeof import("../src/understudy-sources.ts");

beforeAll(async () => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "agx-source-add-home-")));
  process.env.HOME = home;
  process.env.XDG_CONFIG_HOME = join(home, ".config");
  process.env.AGENTGLASS_DB = join(home, "t.db");
  delete process.env.HISTFILE;
  for (const d of [".ssh", ".aws", ".gnupg", ".docker", ".config/agentglass", ".config/fish", ".claude", ".local/share/fish", "Documents/notes", "code/orbit/.claude"]) {
    mkdirSync(join(home, d), { recursive: true });
  }
  writeFileSync(join(home, ".ssh", "id_key"), "PRIVATE");
  writeFileSync(join(home, ".gitconfig"), "[user]");
  writeFileSync(join(home, ".claude", "settings.json"), "{}");
  writeFileSync(join(home, ".local", "share", "fish", "fish_history"), "- cmd: ls");
  symlinkSync(join(home, ".ssh"), join(home, "Documents", "keys"));
  U = await import("../src/understudy.ts");
  S = await import("../src/understudy-sources.ts");
});
afterAll(() => {
  for (const [k, v] of [["HOME", saved.HOME], ["XDG_CONFIG_HOME", saved.XDG], ["AGENTGLASS_DB", saved.DB], ["HISTFILE", saved.HIST]] as const) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  rmSync(home, { recursive: true, force: true });
});

describe("the rule", () => {
  test("keys, cloud credentials and the app's own configuration are refused outright, by name", () => {
    for (const p of [".ssh", ".ssh/id_key", ".aws", ".gnupg", ".config/agentglass", ".config/agentglass/token"]) {
      const why = S.extraSourceError(join(home, p));
      expect(why, p).not.toBeNull();
      expect(why).toContain("never read as a source");
    }
  });
  test("a link from an innocent place is judged by where it points", () => {
    expect(S.extraSourceError(join(home, "Documents", "keys"))).toContain(".ssh");
    expect(S.extraSourceError(join(home, "Documents", "keys", "id_key"))).toContain(".ssh");
  });
  test("any other hidden folder is refused with the segment named", () => {
    expect(S.extraSourceError(join(home, ".docker"))).toContain(".docker");
    expect(S.extraSourceError(join(home, ".config", "gh", "hosts.yml"))).toContain(".config");
    expect(S.extraSourceError(join(home, "code", "orbit", ".env"))).toContain(".env");
    expect(S.extraSourceError(join(home, ".netrc"))).toContain(".netrc");
  });
  test("the homes the recommended list itself offers stay addable, and a project's .claude too", () => {
    for (const p of [".config/fish", ".claude", ".claude/settings.json", ".gitconfig", ".tmux.conf", ".zshrc", ".bashrc",
      ".zsh_history", ".bash_history", ".local/share/fish/fish_history", "Documents/notes", "code/orbit", "code/orbit/.claude"]) {
      expect(S.extraSourceError(join(home, p)), p).toBeNull();
    }
  });
  test("HISTFILE under the home is the list's own offer, so it is allowed; elsewhere it is not", () => {
    process.env.HISTFILE = join(home, ".histfile");
    try { expect(S.extraSourceError(join(home, ".histfile"))).toBeNull(); } finally { delete process.env.HISTFILE; }
    expect(S.extraSourceError(join(home, ".histfile"))).toContain(".histfile");
  });
});

describe("registering", () => {
  test("a refused path is thrown with the reason, and nothing is registered", () => {
    const before = U.consent().extra.length;
    expect(() => U.addExtraSource(join(home, ".ssh"), "keys", "rules")).toThrow(/never read as a source/);
    expect(() => U.addExtraSource(join(home, ".docker"), "docker", "rules")).toThrow(/hidden folder/);
    expect(U.consent().extra.length).toBe(before);
  });
  test("a plain folder of notes registers as before", () => {
    const id = U.addExtraSource(join(home, "Documents", "notes"), "notes", "precedents");
    expect(id.startsWith("added:")).toBe(true);
    expect(U.consent().extra.some((e) => e.id === id)).toBe(true);
  });
});
