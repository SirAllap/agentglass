/*
 * `agentglass-plugin validate` and the app must agree about what a manifest is.
 *
 * The CLI carries its own copy of the rules, in Python, and it has to: a
 * plugin's CI runs it with no agentglass anywhere, which is the whole point of
 * having it. Two copies of a rule set drift — quietly, and in the direction
 * that lets a broken plugin through a green check.
 *
 * So both are run over the same cases here. The app's `validateManifest` is
 * the original; the CLI is the copy; a case where they disagree fails this
 * test, whichever one is right.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { validateManifest } from "../src/plugins.ts";
import { contentHash, walkPluginDir } from "../src/plugin-sources.ts";

const CLI = new URL("../../bin/agentglass-plugin", import.meta.url).pathname;

/** A manifest that installs, as the base every case bends. */
const OK = {
  name: "orbit-reviewer",
  publisher: "acme",
  description: "Reviews pull requests and keeps the findings local.",
  entrypoint: "python3 -u reviewer.py",
  scope: "read",
};

const CASES: { what: string; manifest: unknown }[] = [
  { what: "the plain one", manifest: OK },
  { what: "everything it can declare", manifest: {
    ...OK, icon: "icon.svg", color: "#8B5CF6",
    contributes: {
      panels: [{ id: "main", title: "Reviews", icon: "review" }],
      prNotes: true,
      prActions: [{ id: "review", label: "Local review" }, { id: "cancel", label: "Stop" }],
      settings: [{ key: "repos", type: "multi", label: "Repositories", options: ["acme/orbit"] }],
    },
  } },
  { what: "no name", manifest: { ...OK, name: undefined } },
  { what: "a name that walks out of the folder", manifest: { ...OK, name: "../elsewhere" } },
  { what: "a name that is a dot", manifest: { ...OK, name: "." } },
  { what: "a hidden name", manifest: { ...OK, name: ".secret" } },
  { what: "an empty publisher", manifest: { ...OK, publisher: "   " } },
  { what: "no description", manifest: { ...OK, description: "" } },
  { what: "a description of 501 characters", manifest: { ...OK, description: "x".repeat(501) } },
  { what: "an entrypoint with a newline in it", manifest: { ...OK, entrypoint: "python3 x.py\nrm -rf /" } },
  { what: "a scope nobody offers", manifest: { ...OK, scope: "root" } },
  { what: "contributes as a list", manifest: { ...OK, contributes: [] } },
  { what: "nine panels", manifest: { ...OK, contributes: { panels: Array.from({ length: 9 }, (_, i) => ({ id: `p${i}`, title: "P" })) } } },
  { what: "a panel id with a capital in it", manifest: { ...OK, contributes: { panels: [{ id: "Main", title: "Reviews" }] } } },
  { what: "the same panel twice", manifest: { ...OK, contributes: { panels: [{ id: "a", title: "A" }, { id: "a", title: "B" }] } } },
  { what: "a panel with no title", manifest: { ...OK, contributes: { panels: [{ id: "a" }] } } },
  { what: "prNotes as a string", manifest: { ...OK, contributes: { prNotes: "yes" } } },
  { what: "six pull request actions", manifest: { ...OK, contributes: { prActions: Array.from({ length: 6 }, (_, i) => ({ id: `a${i}`, label: "Go" })) } } },
  { what: "an action label of 29 characters", manifest: { ...OK, contributes: { prActions: [{ id: "a", label: "x".repeat(29) }] } } },
  { what: "the same action twice", manifest: { ...OK, contributes: { prActions: [{ id: "a", label: "A" }, { id: "a", label: "B" }] } } },
  { what: "a settings field with no type", manifest: { ...OK, contributes: { settings: [{ key: "k", label: "K" }] } } },
  { what: "a settings key starting with a digit", manifest: { ...OK, contributes: { settings: [{ key: "1k", type: "string", label: "K" }] } } },
  { what: "the same settings key twice", manifest: { ...OK, contributes: { settings: [{ key: "k", type: "string", label: "A" }, { key: "k", type: "number", label: "B" }] } } },
  { what: "sixty-one settings fields", manifest: { ...OK, contributes: { settings: Array.from({ length: 61 }, (_, i) => ({ key: `k${i}`, type: "string", label: "K" })) } } },
  { what: "an icon outside the folder", manifest: { ...OK, icon: "../../etc/passwd.svg" } },
  { what: "an icon that is a script", manifest: { ...OK, icon: "icon.js" } },
  { what: "a colour that is a word", manifest: { ...OK, color: "purple" } },
  { what: "a colour in three digits", manifest: { ...OK, color: "#abc" } },
  // Python's `$` also matches before one newline at the end of the text, so
  // each of these passed the CLI's copy of a rule the app holds exactly.
  { what: "a name with a newline on the end", manifest: { ...OK, name: "orbit-reviewer\n" } },
  { what: "a panel id with a newline on the end", manifest: { ...OK, contributes: { panels: [{ id: "main\n", title: "Reviews" }] } } },
  { what: "a settings key with a newline on the end", manifest: { ...OK, contributes: { settings: [{ key: "repos\n", type: "string", label: "Repositories" }] } } },
  { what: "an icon with a newline on the end", manifest: { ...OK, icon: "icon.svg\n" } },
  { what: "a colour with a newline on the end", manifest: { ...OK, color: "#8B5CF6\n" } },
  { what: "a minApp with a newline on the end", manifest: { ...OK, minApp: "0.18.0\n" } },
];

function cliSays(manifest: unknown): { ok: boolean; error?: string } {
  const dir = mkdtempSync(join(tmpdir(), "agx-plugin-cli-"));
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "plugin.json"), JSON.stringify(manifest ?? {}));
    const r = Bun.spawnSync(["python3", CLI, "validate", dir]);
    const out = r.stdout.toString().trim();
    const parsed = JSON.parse(out || "{}") as { ok?: boolean; error?: string };
    // The exit code is the half a CI job reads, so it is checked too: a
    // validator that prints a refusal and exits 0 is a green check over a
    // broken plugin.
    expect(r.exitCode, `exit code disagrees with its own answer for ${out}`).toBe(parsed.ok ? 0 : 1);
    return { ok: !!parsed.ok, error: parsed.error };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("the CLI's copy of the manifest rules", () => {
  for (const c of CASES) {
    test(`agrees with the app about ${c.what}`, () => {
      const app = validateManifest(c.manifest);
      const cli = cliSays(c.manifest);
      const appOk = typeof app !== "string";
      expect(cli.ok, `the app ${appOk ? "accepts" : `refuses (${app})`} this one`).toBe(appOk);
      // The words differ only where the app's message is about a field this
      // one reports by a different name; same verdict is the contract, and a
      // message that shares no word with the app's is a message about
      // something else.
      if (!appOk && typeof app === "string") {
        const shared = app.toLowerCase().split(/[^a-z]+/).filter((w) => w.length > 4);
        expect(shared.some((w) => (cli.error ?? "").toLowerCase().includes(w)),
          `app: ${app}\ncli: ${cli.error}`).toBe(true);
      }
    });
  }

  test("says what is missing around the manifest without refusing the plugin", () => {
    const dir = mkdtempSync(join(tmpdir(), "agx-plugin-cli-"));
    try {
      writeFileSync(join(dir, "plugin.json"), JSON.stringify({ ...OK, icon: "icon.svg" }));
      const r = Bun.spawnSync(["python3", CLI, "validate", dir]);
      const out = JSON.parse(r.stdout.toString()) as { ok: boolean; warnings: string[] };
      expect(out.ok).toBe(true);
      expect(r.exitCode).toBe(0);
      expect(out.warnings.join(" ")).toContain("icon.svg");
      expect(out.warnings.join(" ")).toContain("README");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a folder with no manifest, and one that is not JSON, are both refusals with a reason", () => {
    const dir = mkdtempSync(join(tmpdir(), "agx-plugin-cli-"));
    try {
      const empty = Bun.spawnSync(["python3", CLI, "validate", dir]);
      expect(empty.exitCode).toBe(1);
      expect(JSON.parse(empty.stdout.toString()).error).toContain("no plugin.json");
      writeFileSync(join(dir, "plugin.json"), "{ not json");
      const broken = Bun.spawnSync(["python3", CLI, "validate", dir]);
      expect(broken.exitCode).toBe(1);
      expect(JSON.parse(broken.stdout.toString()).error).toContain("not valid JSON");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /*
   * `hash` is what the catalogue pins an entry to, and the app is what
   * refuses an install whose tree hashes to something else. If the two walks
   * differ by one detail — a file order, a separator, a skipped directory —
   * every listed plugin is refused on every machine, or none is checked at
   * all. So the CLI's walk is measured against the app's over a tree built to
   * exercise the details: nested folders, a `.git` directory to skip, a
   * symlink that stays inside the folder, bytes that are not text, and names
   * that sort differently by byte and by locale.
   */
  describe("and its content hash", () => {
    function tree(): string {
      const dir = mkdtempSync(join(tmpdir(), "agx-plugin-hash-"));
      writeFileSync(join(dir, "plugin.json"), JSON.stringify(OK));
      mkdirSync(join(dir, "lib", "deep"), { recursive: true });
      writeFileSync(join(dir, "lib", "deep", "b.py"), "print('b')\n");
      writeFileSync(join(dir, "lib", "a.py"), "print('a')\n");
      writeFileSync(join(dir, "Zed.md"), "# capital sorts before lower in bytes\n");
      writeFileSync(join(dir, "icon.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0d, 0x0a, 0xff]));
      writeFileSync(join(dir, "empty"), "");
      // One name past the BMP and one just under its top: UTF-16 puts the
      // first ahead, code points put it behind, and the two walks once
      // sorted one way each.
      writeFileSync(join(dir, "\u{1D537}.md"), "outside the BMP\n");
      writeFileSync(join(dir, "ｚ.md"), "inside the BMP\n");
      mkdirSync(join(dir, ".git", "objects"), { recursive: true });
      writeFileSync(join(dir, ".git", "HEAD"), "ref: refs/heads/main\n");
      symlinkSync("lib/a.py", join(dir, "alias.py"));
      return dir;
    }

    function cliHash(dir: string): { ok: boolean; sha256?: string; files?: number; error?: string; exit: number } {
      const r = Bun.spawnSync(["python3", CLI, "hash", dir]);
      return { ...(JSON.parse(r.stdout.toString() || "{}") as { ok: boolean; sha256?: string; files?: number; error?: string }), exit: r.exitCode };
    }

    test("is the app's hash, over the app's walk, to the byte", () => {
      const dir = tree();
      try {
        const walked = walkPluginDir(dir);
        expect(walked.ok, walked.error ?? "").toBe(true);
        const cli = cliHash(dir);
        expect(cli.exit).toBe(0);
        expect(cli.sha256).toBe(contentHash(dir, walked.files));
        expect(cli.files).toBe(walked.files.length);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test("moves when one byte of one file moves, and not when the history does", () => {
      const dir = tree();
      try {
        const before = cliHash(dir).sha256;
        writeFileSync(join(dir, ".git", "HEAD"), "ref: refs/heads/other\n");
        expect(cliHash(dir).sha256).toBe(before);
        writeFileSync(join(dir, "lib", "a.py"), "print('A')\n");
        expect(cliHash(dir).sha256).not.toBe(before);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    /*
     * A name that is not UTF-8 reached the app's walk with U+FFFD in place of
     * the bad byte. With a file of that U+FFFD name beside it, the walk read
     * the decoy twice and never the real one, so the real one could change
     * under an approval. A name with a backslash is a path to the app's
     * resolver on every platform. Both walks now refuse either name.
     */
    test("refuses a name that is not UTF-8, and one with a backslash, in both walks", () => {
      for (const name of [Buffer.from([0x72, 0x75, 0x6e, 0xff]), Buffer.from("back\\slash")]) {
        const dir = tree();
        try {
          writeFileSync(Buffer.concat([Buffer.from(dir + "/lib/"), name]), "echo hidden\n");
          writeFileSync(join(dir, "lib", "run\uFFFD"), "echo decoy\n");
          const walked = walkPluginDir(dir);
          expect(walked.ok, String(name)).toBe(false);
          const cli = cliHash(dir);
          expect(cli.ok, String(name)).toBe(false);
          expect(cli.exit).toBe(1);
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      }
    });

    test("moves when a link inside the folder is pointed at another file", () => {
      const dir = tree();
      try {
        const before = cliHash(dir).sha256;
        rmSync(join(dir, "alias.py"));
        symlinkSync("lib/deep/b.py", join(dir, "alias.py"));
        const after = cliHash(dir);
        expect(after.ok).toBe(true);
        expect(after.sha256).not.toBe(before);
        expect(after.sha256).toBe(contentHash(dir, walkPluginDir(dir).files));
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test("refuses what the app refuses: a link that leaves the folder", () => {
      const dir = tree();
      try {
        symlinkSync("/etc/hostname", join(dir, "out.txt"));
        expect(walkPluginDir(dir).ok).toBe(false);
        const cli = cliHash(dir);
        expect(cli.ok).toBe(false);
        expect(cli.exit).toBe(1);
        expect(cli.error).toContain("outside");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test("and a link to an absolute path, or out and back in by the folder's name", () => {
      const absolute = tree();
      const around = tree();
      try {
        symlinkSync(join(absolute, "lib", "a.py"), join(absolute, "abs.py"));
        symlinkSync(join("..", basename(around), "lib", "a.py"), join(around, "around.py"));
        for (const dir of [absolute, around]) {
          expect(walkPluginDir(dir).ok).toBe(false);
          const cli = cliHash(dir);
          expect(cli.ok).toBe(false);
          expect(cli.exit).toBe(1);
        }
      } finally {
        rmSync(absolute, { recursive: true, force: true });
        rmSync(around, { recursive: true, force: true });
      }
    });
  });
});
