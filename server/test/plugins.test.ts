/*
 * The mechanism docs/PLUGINS.md describes: install copies a folder,
 * a bad manifest loses the plugin rather than widening it, nothing runs
 * until a human enables the specific plugin, enabling mints a scoped token
 * and starts the entrypoint as its own process, and disabling actually
 * stops it — a plugin left running after it was disabled is the feature
 * failing.
 */
import { beforeAll, afterAll, beforeEach, afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  validateManifest, validPluginName, manifestHash, installPlugin, updatePlugin, enablePlugin, disablePlugin,
  removePlugin, listPlugins, masterEnabled, setMaster, __resetPlugins,
  MANIFEST_NAME, pluginsConfigDir, pluginsPath, appVersion, versionAtLeast,
} from "../src/plugins.ts";
import { callerFor, pluginTokenCount } from "../src/auth.ts";
import { blocklistPath } from "../src/plugin-blocklist.ts";

const okManifest = {
  name: "watcher", publisher: "someone in the community",
  description: "watches the gate", entrypoint: "true", scope: "read",
};

/** A local plugin folder on disk, ready to install. `run` is a shell body —
 *  by default one that exits immediately, because most tests only care that
 *  install copied and parsed the manifest. Tests that care about the
 *  process itself pass a body that keeps running. */
function fixture(manifest: Record<string, unknown> = okManifest, run = "true"): string {
  const dir = mkdtempSync(join(tmpdir(), "agx-plugin-src-"));
  writeFileSync(join(dir, MANIFEST_NAME), JSON.stringify(manifest));
  writeFileSync(join(dir, "run.sh"), `#!/bin/bash\n${run}\n`);
  chmodSync(join(dir, "run.sh"), 0o755);
  return dir;
}

beforeEach(async () => {
  process.env.NODE_ENV = "test";
  process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "agx-plugins-"));
  await __resetPlugins();
});

afterEach(async () => {
  await __resetPlugins();
});

describe("manifest validation", () => {
  test("a well-formed manifest passes", () => {
    const m = validateManifest(okManifest);
    expect(typeof m).toBe("object");
  });

  test("scope must be one of the three the code already enforces", () => {
    expect(validateManifest({ ...okManifest, scope: "admin" })).toContain("scope");
  });

  test("an empty or oversized entrypoint loses the plugin, not widens it", () => {
    expect(validateManifest({ ...okManifest, entrypoint: "" })).toContain("entrypoint");
    expect(validateManifest({ ...okManifest, entrypoint: "x".repeat(600) })).toContain("entrypoint");
  });

  test("a name outside the safe character set is refused", () => {
    expect(validateManifest({ ...okManifest, name: "../../etc" })).toContain("name");
  });

  test("not an object at all is refused, not coerced", () => {
    expect(validateManifest(null)).toContain("object");
    expect(validateManifest("watcher")).toContain("object");
    expect(validateManifest([1, 2])).toContain("object");
  });

  test("a missing field is refused rather than defaulted", () => {
    const { publisher: _drop, ...rest } = okManifest;
    expect(validateManifest(rest)).toContain("publisher");
  });

  // The character set admits `.` and `..`, and `pluginInstallDir("..")` is
  // the config directory itself — the one `finishInstall` wipes before the
  // copy. `projectadd.ts` kept this guard; the plugin copy had dropped it.
  test("dot, dot-dot and hidden names are refused — they name a directory this must never touch", () => {
    for (const bad of [".", "..", ".git", ".hidden"]) {
      expect(validPluginName(bad)).toBe(false);
      expect(validateManifest({ ...okManifest, name: bad })).toContain("name");
    }
    expect(validPluginName("watcher")).toBe(true);
    expect(validPluginName("my.plugin-2_x")).toBe(true);
    expect(validPluginName(42)).toBe(false);
  });
});

describe("install = copy, no code runs", () => {
  test("a local folder is copied and its manifest recorded", async () => {
    const src = fixture();
    const r = await installPlugin(src);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plugin.name).toBe("watcher");
    expect(r.plugin.enabled).toBe(false);
    expect(existsSync(join(r.plugin.installDir, MANIFEST_NAME))).toBe(true);
    expect(r.plugin.approvedHash).toBeNull();
  });

  test("no manifest at the root is refused", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agx-plugin-src-"));
    const r = await installPlugin(dir);
    expect(r.ok).toBe(false);
  });

  test("a bad manifest is refused and nothing is installed", async () => {
    const src = fixture({ ...okManifest, scope: "root" });
    const r = await installPlugin(src);
    expect(r.ok).toBe(false);
    expect(listPlugins()).toHaveLength(0);
  });

  test("a relative path is refused — it would resolve against the server, not the caller", async () => {
    const r = await installPlugin("relative/path");
    expect(r.ok).toBe(false);
  });

  test("a manifest named `..` leaves the config directory exactly as it was", async () => {
    const cfg = pluginsConfigDir();
    mkdirSync(cfg, { recursive: true });
    const sentinel = join(cfg, "settings-i-care-about.json");
    writeFileSync(sentinel, "{}");
    const r = await installPlugin(fixture({ ...okManifest, name: ".." }));
    expect(r.ok).toBe(false);
    expect(existsSync(sentinel)).toBe(true);
    expect(listPlugins()).toHaveLength(0);
  });
});

describe("a plugin that needs a newer app", () => {
  test("is refused at install, with what it needs and what this is", async () => {
    /* Refused rather than installed and left off: half of what a plugin
       declares is where it draws, and a surface this app does not have is not
       a setting somebody can switch on — it is a panel that never appears
       with nothing saying why. */
    const src = fixture({ ...okManifest, minApp: "9.9.9" } as never);
    const r = await installPlugin(src);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("9.9.9");
      expect(r.error).toContain(appVersion());
    }
    expect(listPlugins()).toHaveLength(0);
  });

  test("installs when the app is that old or newer, and a version that is not one is refused", async () => {
    const src = fixture({ ...okManifest, minApp: "0.0.1" } as never);
    expect((await installPlugin(src)).ok).toBe(true);
    await removePlugin("watcher");
    expect(validateManifest({ ...okManifest, minApp: "0.18" })).not.toBe("minApp must be a version like 0.18.0");
    for (const bad of ["latest", "v1.2.3", "1.2.3.4", "", 3]) {
      expect(validateManifest({ ...okManifest, minApp: bad })).toContain("minApp");
    }
  });

  test("older, newer and equal are told apart, with the parts that are missing read as zero", () => {
    expect(versionAtLeast("0.18.0", "0.18.0")).toBe(true);
    expect(versionAtLeast("0.18", "0.18.0")).toBe(true);
    expect(versionAtLeast("0.18.1", "0.18.0")).toBe(true);
    expect(versionAtLeast("1.0.0", "0.99.99")).toBe(true);
    expect(versionAtLeast("0.17.9", "0.18.0")).toBe(false);
    // 0.9 is older than 0.10, whatever a string comparison would say.
    expect(versionAtLeast("0.9.0", "0.10.0")).toBe(false);
  });
});

describe("consent does not survive an update", () => {
  test("enabling stamps the approved hash", async () => {
    const src = fixture();
    await installPlugin(src);
    const before = listPlugins()[0]!;
    expect(before.approvedHash).toBeNull();
    const r = await enablePlugin("watcher");
    expect(r.ok).toBe(true);
    const after = listPlugins()[0]!;
    expect(after.approvedHash).toBe(after.manifestHash);
    expect(after.enabled).toBe(true);
    await disablePlugin("watcher");
  });

  test("a caller that cannot show the declaration may not approve it", async () => {
    /*
     * Switching a plugin on IS the approval, and the window earns the right
     * to do it by drawing the scope and every place the plugin draws first.
     * A terminal draws nothing, so `agentglass-plugin enable` was one line
     * that granted a new manifest's scope with nobody having read it.
     *
     * `approved` is the caller saying it showed the declaration. Passing
     * false is refused while there is something new to read, and accepted
     * once the approval on file matches what is installed — a plugin already
     * approved is not re-approved by being switched on again.
     */
    const src = fixture();
    await installPlugin(src);
    const cold = await enablePlugin("watcher", false);
    expect(cold.ok).toBe(false);
    if (!cold.ok) expect(cold.error).toContain("--approve");
    expect(listPlugins()[0]!.enabled).toBe(false);

    expect((await enablePlugin("watcher", true)).ok).toBe(true);
    await disablePlugin("watcher");
    // Nothing has changed since it was approved, so this one goes through.
    expect((await enablePlugin("watcher", false)).ok).toBe(true);
    await disablePlugin("watcher");

    // Now it asks for more than it did, and the terminal is turned away again.
    writeFileSync(join(src, MANIFEST_NAME), JSON.stringify({ ...okManifest, scope: "full" }));
    await installPlugin(src);
    const changed = await enablePlugin("watcher", false);
    expect(changed.ok).toBe(false);
    if (!changed.ok) expect(changed.error).toContain("has changed");
    expect(listPlugins()[0]!.enabled).toBe(false);
  });

  test("a scope change on reinstall clears the old approval and disables it", async () => {
    await installPlugin(fixture());
    await enablePlugin("watcher");
    expect(listPlugins()[0]!.enabled).toBe(true);

    // Same name, wider scope — a reviewer approved `read`, not this.
    await installPlugin(fixture({ ...okManifest, scope: "full" }));
    const rec = listPlugins()[0]!;
    expect(rec.scope).toBe("full");
    expect(rec.enabled).toBe(false);
    expect(rec.approvedHash).toBeNull();
    expect(rec.manifestHash).not.toBe(manifestHash(okManifest as never));
  });

  test("hadApproval tells 'never reviewed' apart from 'changed since approved'", async () => {
    await installPlugin(fixture());
    // Never enabled: a fresh install nobody has looked at.
    expect(listPlugins()[0]!.hadApproval).toBe(false);

    await enablePlugin("watcher");
    expect(listPlugins()[0]!.hadApproval).toBe(true);

    // The scope widens — approvedHash clears exactly as above, but this one
    // WAS approved once, and that fact must survive the update for the
    // reviewer to see: "asking for something different now", not "new".
    await installPlugin(fixture({ ...okManifest, scope: "full" }));
    const rec = listPlugins()[0]!;
    expect(rec.approvedHash).toBeNull();
    expect(rec.hadApproval).toBe(true);
  });

  test("an unchanged manifest keeps its approval across a reinstall", async () => {
    await installPlugin(fixture());
    await enablePlugin("watcher");
    await installPlugin(fixture()); // identical manifest
    const rec = listPlugins()[0]!;
    expect(rec.approvedHash).toBe(rec.manifestHash);
    await disablePlugin("watcher");
  });
});

describe("enable = scoped token + separate process; disable actually stops it", () => {
  test("enabling starts a real process and mints a token scoped as declared", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agx-plugin-src-"));
    const marker = join(dir, "marker");
    writeFileSync(join(dir, MANIFEST_NAME), JSON.stringify({ ...okManifest, scope: "answer" }));
    writeFileSync(join(dir, "run.sh"), `#!/bin/bash\necho -n "$AGENTGLASS_READ_TOKEN" > "${marker}"\nsleep 5\n`);
    chmodSync(join(dir, "run.sh"), 0o755);
    // entrypoint is a shell command, not a path — this is what a manifest declares.
    const manifest = { ...okManifest, scope: "answer", entrypoint: "bash run.sh" };
    writeFileSync(join(dir, MANIFEST_NAME), JSON.stringify(manifest));

    const before = pluginTokenCount();
    await installPlugin(dir);
    const r = await enablePlugin("watcher");
    expect(r.ok).toBe(true);
    expect(pluginTokenCount()).toBe(before + 1);

    // Give the child a moment to write its marker.
    for (let i = 0; i < 50 && !existsSync(marker); i++) await Bun.sleep(20);
    expect(existsSync(marker)).toBe(true);
    const token = readFileSync(marker, "utf8");
    expect(token.startsWith("pg_")).toBe(true);

    const caller = callerFor(new Request("http://x", { headers: { authorization: `Bearer ${token}` } }), new URL("http://x"), "unrelated-machine-token");
    expect(caller?.scope).toBe("answer");
    expect(caller?.plugin).toBe("watcher");

    const rec = listPlugins()[0]!;
    expect(rec.running).toBe(true);
    expect(rec.pid).toBeGreaterThan(0);

    await disablePlugin("watcher");
    expect(pluginTokenCount()).toBe(before);
    expect(listPlugins()[0]!.running).toBe(false);
    // The token is dead now, not just the process.
    const dead = callerFor(new Request("http://x", { headers: { authorization: `Bearer ${token}` } }), new URL("http://x"), "unrelated-machine-token");
    expect(dead).toBeNull();
  });

  test("enable refuses when the master switch is off", async () => {
    await installPlugin(fixture());
    await setMaster(false);
    const r = await enablePlugin("watcher");
    expect(r.ok).toBe(false);
    expect(listPlugins()[0]!.enabled).toBe(false);
  });

  test("turning the master switch off stops every running plugin", async () => {
    await installPlugin(fixture({ ...okManifest, entrypoint: "sleep 5" }));
    await enablePlugin("watcher");
    expect(listPlugins()[0]!.running).toBe(true);
    await setMaster(false);
    expect(listPlugins()[0]!.running).toBe(false);
  });
});

describe("remove", () => {
  test("stops the process, deletes the folder, drops the record", async () => {
    const r = await installPlugin(fixture({ ...okManifest, entrypoint: "sleep 5" }));
    if (!r.ok) throw new Error("install failed");
    await enablePlugin("watcher");
    const installDir = r.plugin.installDir;
    expect(existsSync(installDir)).toBe(true);
    const ok = await removePlugin("watcher");
    expect(ok).toBe(true);
    expect(existsSync(installDir)).toBe(false);
    expect(listPlugins()).toHaveLength(0);
  });

  // `plugins.json` is a file on disk; a record whose `installDir` points
  // outside the plugins folder is dropped without deleting anything.
  test("a tampered record pointing outside the plugins folder is dropped, the folder is not deleted", async () => {
    const outside = mkdtempSync(join(tmpdir(), "agx-not-a-plugin-"));
    writeFileSync(join(outside, "keep.txt"), "still here");
    const store = JSON.parse(readFileSync(pluginsPath(), "utf8"));
    store.plugins = [{
      ...okManifest, name: "rogue", source: { kind: "local-path", path: outside }, installDir: outside,
      manifestHash: "x", contentHash: "x", fingerprint: "x", resolvedCommit: null,
      approvedHash: null, approvedFingerprint: null, enabled: false, installedAt: 1, hadApproval: false,
    }];
    writeFileSync(pluginsPath(), JSON.stringify(store));
    expect(await removePlugin("rogue")).toBe(true);
    expect(existsSync(join(outside, "keep.txt"))).toBe(true);
    expect(listPlugins()).toHaveLength(0);
  });

  test("removing something that is not there is not a success", async () => {
    expect(await removePlugin("nobody")).toBe(false);
  });
});

describe("update = re-fetch at the recorded source", () => {
  test("a local-path install has no upstream to re-fetch", async () => {
    const r = await installPlugin(fixture());
    if (!r.ok) throw new Error("install failed");
    expect(r.plugin.source.kind).toBe("local-path");
    const u = await updatePlugin("watcher");
    expect(u.ok).toBe(false);
    if (u.ok) return;
    expect(u.error).toContain("no upstream");
  });

  test("updating something that is not installed is refused", async () => {
    const u = await updatePlugin("nobody");
    expect(u.ok).toBe(false);
  });
});

describe("install sources are a typed shape, not a free string", () => {
  test("a local install records a local-path source", async () => {
    const r = await installPlugin(fixture());
    if (!r.ok) throw new Error("install failed");
    expect(r.plugin.source.kind).toBe("local-path");
  });

  test("a bare git URL with credentials is refused before any clone runs", async () => {
    const r = await installPlugin("https://user:pass@example.com/someone/plugin.git");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("credentials");
  });

  test("plain http as a git source is refused", async () => {
    const r = await installPlugin("http://example.com/someone/plugin.git");
    expect(r.ok).toBe(false);
  });
});

describe("consent fingerprint sees a content-only rewrite the manifest hash cannot", () => {
  test("rewriting the entrypoint script without touching the manifest clears approval", async () => {
    const src = fixture(okManifest, "true");
    await installPlugin(src);
    await enablePlugin("watcher");
    const before = listPlugins()[0]!;
    expect(before.enabled).toBe(true);
    expect(before.approvedFingerprint).toBe(before.fingerprint);
    // Same manifest, same hash — but the script the entrypoint runs changed.
    expect(manifestHash(okManifest as never)).toBe(before.manifestHash);

    const rewritten = fixture(okManifest, "echo pwned");
    await installPlugin(rewritten);
    const after = listPlugins()[0]!;
    expect(after.manifestHash).toBe(before.manifestHash);
    expect(after.contentHash).not.toBe(before.contentHash);
    expect(after.fingerprint).not.toBe(before.fingerprint);
    expect(after.approvedFingerprint).toBeNull();
    expect(after.enabled).toBe(false);
  });

  // Both scripts shipped from the start, so no file's bytes change: only
  // which one the entrypoint reaches. The update used to keep its approval.
  test("pointing a link at another script already in the tree clears approval", async () => {
    const version = (target: string): string => {
      const dir = fixture({ ...okManifest, entrypoint: "bash start.sh" });
      writeFileSync(join(dir, "good.sh"), "echo good\n");
      writeFileSync(join(dir, "evil.sh"), "echo evil\n");
      symlinkSync(target, join(dir, "start.sh"));
      return dir;
    };
    await installPlugin(version("good.sh"));
    await enablePlugin("watcher");
    const before = listPlugins()[0]!;
    expect(before.enabled).toBe(true);

    await installPlugin(version("evil.sh"));
    const after = listPlugins()[0]!;
    expect(after.manifestHash).toBe(before.manifestHash);
    expect(after.contentHash).not.toBe(before.contentHash);
    expect(after.approvedFingerprint).toBeNull();
    expect(after.enabled).toBe(false);
  });
});

describe("kill list", () => {
  test("enable refuses a blocked plugin key, with the reason surfaced", async () => {
    await installPlugin(fixture());
    mkdirSync(pluginsConfigDir(), { recursive: true });
    writeFileSync(blocklistPath(), JSON.stringify([
      { pluginKey: "watcher", reason: "known to exfiltrate tokens", link: "https://example.com/advisory" },
    ]));
    const r = await enablePlugin("watcher");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("exfiltrate");
    expect(listPlugins()[0]!.enabled).toBe(false);
  });

  test("a plugin not on the list enables normally", async () => {
    mkdirSync(pluginsConfigDir(), { recursive: true });
    writeFileSync(blocklistPath(), JSON.stringify([{ pluginKey: "someone-else", reason: "x", link: null }]));
    await installPlugin(fixture());
    const r = await enablePlugin("watcher");
    expect(r.ok).toBe(true);
    await disablePlugin("watcher");
  });
});

/*
 * A catalogue entry names a commit and the hash of its tree, and the install
 * is refused when what arrives is anything else.
 *
 * These run in a child process with a `git` of their own first on PATH: the
 * install calls `git` through Bun.spawn, which resolves it with the PATH the
 * process started with, so a stub has to be there from the start. The stub
 * logs what it was asked and hands the call to the real git with one rewrite
 * — https://github.com/ to a folder of fixture repositories — so nothing
 * reaches the network and the git doing the work is the real one.
 */
describe("a pinned catalogue entry installs its commit or nothing", () => {
  const PLUGINS_TS = new URL("../src/plugins.ts", import.meta.url).pathname;
  let root = "", pinned = "", tip = "", pinnedHash = "";
  const realGit = Bun.which("git") ?? "/usr/bin/git";

  const run = (cwd: string, ...args: string[]) => {
    const r = Bun.spawnSync([realGit, "-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], { cwd });
    if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
    return r.stdout.toString().trim();
  };

  // Its own hooks, because the file's beforeEach resets the in-process store
  // and these touch none of it.
  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "agx-pinned-"));
    const repo = join(root, "fixtures", "acme", "orbit-clock");
    mkdirSync(repo, { recursive: true });
    run(repo, "init", "-q", "-b", "main");
    writeFileSync(join(repo, MANIFEST_NAME), JSON.stringify({ ...okManifest, name: "orbit-clock", entrypoint: "sh run.sh" }));
    writeFileSync(join(repo, "run.sh"), "echo listed\n");
    run(repo, "add", "-A");
    run(repo, "commit", "-q", "-m", "listed");
    pinned = run(repo, "rev-parse", "HEAD");
    const { contentHash, walkPluginDir } = await import("../src/plugin-sources.ts");
    pinnedHash = contentHash(repo, walkPluginDir(repo).files);
    // What the author pushed after the label.
    writeFileSync(join(repo, "run.sh"), "echo something else\n");
    run(repo, "commit", "-q", "-am", "after");
    tip = run(repo, "rev-parse", "HEAD");

    mkdirSync(join(root, "bin"));
    writeFileSync(join(root, "bin", "git"),
      `#!/bin/sh\nprintf 'prompt=%s lfs=%s %s\\n' "$GIT_TERMINAL_PROMPT" "$GIT_LFS_SKIP_SMUDGE" "$*" >> "${root}/git.log"\nexec "${realGit}" -c "url.file://${root}/fixtures/.insteadOf=https://github.com/" "$@"\n`);
    chmodSync(join(root, "bin", "git"), 0o755);
  });

  afterAll(() => { try { rmSync(root, { recursive: true, force: true }); } catch { /* fine */ } });

  type Out = { result: { ok: boolean; error?: string; plugin?: { resolvedCommit: string | null; installDir: string; source: unknown } }; runSh: string | null; listed: number; update?: { ok: boolean; error?: string }; runShAfterUpdate?: string | null; log: string };

  /** One install in a fresh child with its own config, data and database.
   *  `gitconfig` is the user's global git config for that child, and
   *  `onlyGit` leaves the stub git as the one program on its PATH. */
  async function install(op: Record<string, unknown>, how: { gitconfig?: string; onlyGit?: boolean } = {}): Promise<Out> {
    const at = mkdtempSync(join(root, "child-"));
    writeFileSync(join(root, "git.log"), "");
    const globalConfig = how.gitconfig === undefined ? "/dev/null" : join(at, "gitconfig");
    if (how.gitconfig !== undefined) writeFileSync(globalConfig, how.gitconfig);
    const script = join(at, "run.ts");
    writeFileSync(script, `
      import { installFromCatalogue, installPlugin, updatePlugin, listPlugins } from ${JSON.stringify(PLUGINS_TS)};
      import { existsSync, readFileSync } from "node:fs";
      import { join } from "node:path";
      const op = JSON.parse(process.env.OP);
      const guard = { hostCheck: async () => null, fetchImpl: (async () => new Response(JSON.stringify(op.catalogue), { status: 200 })) };
      const result = op.kind === "catalogue"
        ? await installFromCatalogue("https://catalogue.example/plugins.json", op.id, guard)
        : op.kind === "local"
          ? await installPlugin({ kind: "local-path", path: op.path })
          : await installPlugin({ kind: "git", url: op.url, ref: op.ref });
      const at = (r) => r.ok && existsSync(join(r.plugin.installDir, "run.sh")) ? readFileSync(join(r.plugin.installDir, "run.sh"), "utf8") : null;
      const out = { result, runSh: at(result), listed: listPlugins().length };
      if (op.update && result.ok) {
        out.update = await updatePlugin(result.plugin.name);
        out.runShAfterUpdate = at(result);
      }
      console.log(JSON.stringify(out));
    `);
    const p = Bun.spawn([process.execPath, script], {
      cwd: at, stdout: "pipe", stderr: "pipe",
      env: {
        PATH: how.onlyGit ? join(root, "bin") : `${join(root, "bin")}:${process.env.PATH}`, HOME: at, NODE_ENV: "test",
        GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: globalConfig,
        XDG_CONFIG_HOME: join(at, "cfg"), XDG_DATA_HOME: join(at, "data"), XDG_CACHE_HOME: join(at, "cache"),
        AGENTGLASS_STATE_DIR: join(at, "state"), AGENTGLASS_DB: join(at, "agentglass.db"), TMUX_TMPDIR: join(at, "tmux"),
        OP: JSON.stringify(op),
      },
    });
    const [code, out, err] = await Promise.all([p.exited, new Response(p.stdout).text(), new Response(p.stderr).text()]);
    expect(code, err).toBe(0);
    const log = readFileSync(join(root, "git.log"), "utf8");
    return { ...(JSON.parse(out.trim().split("\n").pop()!) as Out), log };
  }

  const entry = (over: Record<string, unknown> = {}) => ({
    id: "orbit-clock", description: "Puts the time in a panel.", categories: [],
    source: { kind: "git", url: "https://github.com/acme/orbit-clock", ref: pinned }, sha256: pinnedHash, ...over,
  });
  const catalogue = (e: unknown) => ({ name: "orbit plugins", owner: "acme", plugins: [e] });

  test("installs the listed commit, not the branch the author pushed to since", async () => {
    const r = await install({ kind: "catalogue", id: "orbit-clock", catalogue: catalogue(entry()) });
    expect(r.result.error ?? "").toBe("");
    expect(r.result.ok).toBe(true);
    expect(r.runSh).toBe("echo listed\n");
    expect(r.result.plugin!.resolvedCommit ?? (r.result.plugin!.source as { marketplace: { resolvedCommit: string } }).marketplace.resolvedCommit).toBe(pinned);
    // By commit id: `clone --branch <sha>` is what git refuses, which is why
    // no entry could be pinned before.
    expect(r.log).toContain(`fetch -q --depth 1 -- https://github.com/acme/orbit-clock ${pinned}`);
    expect(r.log).not.toContain("clone");
    expect(tip).not.toBe(pinned);
  }, 30_000);

  test("refuses a tree that hashes to something the catalogue did not list, and installs nothing", async () => {
    const r = await install({ kind: "catalogue", id: "orbit-clock", catalogue: catalogue(entry({ sha256: "0".repeat(64) })) });
    expect(r.result.ok).toBe(false);
    expect(r.result.error).toContain("hash");
    expect(r.listed).toBe(0);
  }, 30_000);

  test("refuses the tip under the listed hash, which is what a push after the label looks like", async () => {
    const r = await install({ kind: "catalogue", id: "orbit-clock", catalogue: catalogue(entry({ source: { kind: "git", url: "https://github.com/acme/orbit-clock", ref: tip } })) });
    expect(r.result.ok).toBe(false);
    expect(r.result.error).toContain("hash");
    expect(r.listed).toBe(0);
  }, 30_000);

  test("a commit the repository does not have is an error, not the default branch", async () => {
    const r = await install({ kind: "catalogue", id: "orbit-clock", catalogue: catalogue(entry({ source: { kind: "git", url: "https://github.com/acme/orbit-clock", ref: "3".repeat(40) } })) });
    expect(r.result.ok).toBe(false);
    expect(r.listed).toBe(0);
  }, 30_000);

  test("an update of a pinned install fetches the same commit and checks the same hash", async () => {
    const r = await install({ kind: "catalogue", id: "orbit-clock", catalogue: catalogue(entry()), update: true });
    expect(r.update?.error ?? "").toBe("");
    expect(r.update?.ok).toBe(true);
    expect(r.runShAfterUpdate).toBe("echo listed\n");
    expect(r.log.match(new RegExp(`fetch -q --depth 1 -- \\S+ ${pinned}`, "g"))?.length).toBe(2);
  }, 30_000);

  test("a git install typed with a commit id installs that commit", async () => {
    const r = await install({ kind: "git", url: "https://github.com/acme/orbit-clock", ref: pinned });
    expect(r.result.error ?? "").toBe("");
    expect(r.runSh).toBe("echo listed\n");
    expect(r.result.plugin!.resolvedCommit).toBe(pinned);
  }, 30_000);

  /*
   * The folder a plugin lands in was named by the manifest that arrived, not
   * by the entry somebody chose. A listed `orbit-clock` whose repository said
   * `name: local-review` installed over the local-review already on the
   * machine. The entry's id names the folder, and a manifest that disagrees
   * with it is refused before anything is copied.
   */
  test("installs into the folder the catalogue's id names", async () => {
    const r = await install({ kind: "catalogue", id: "orbit-clock", catalogue: catalogue(entry()) });
    expect(r.result.ok).toBe(true);
    expect(r.result.plugin!.installDir.endsWith("/plugins/orbit-clock")).toBe(true);
  }, 30_000);

  test("refuses an entry whose manifest is named something else, and installs nothing", async () => {
    const r = await install({ kind: "catalogue", id: "local-review", catalogue: catalogue(entry({ id: "local-review" })) });
    expect(r.result.ok).toBe(false);
    expect(r.result.error).toContain("local-review");
    expect(r.result.error).toContain("orbit-clock");
    expect(r.listed).toBe(0);
  }, 30_000);

  test("an id that could not be a folder is refused before anything is fetched", async () => {
    const r = await install({ kind: "catalogue", id: "../orbit", catalogue: catalogue(entry({ id: "../orbit" })) });
    expect(r.result.ok).toBe(false);
    expect(r.log).toBe("");
    expect(r.listed).toBe(0);
  }, 30_000);

  /*
   * An install is a server process, and the git it runs must not stop to ask
   * anybody anything: a repository that answers 401 made git prompt on the
   * terminal the server was started from, and a plugin's own .lfsconfig
   * made git-lfs, where the user has it, fetch from whatever host it named.
   */
  test("every git an install runs asks for no password and fetches nothing through LFS", async () => {
    const r = await install({ kind: "catalogue", id: "orbit-clock", catalogue: catalogue(entry()), update: true });
    expect(r.result.ok).toBe(true);
    const lines = r.log.trim().split("\n");
    expect(lines.length).toBeGreaterThan(3);
    for (const line of lines) expect(line).toStartWith("prompt=0 lfs=1 ");
  }, 30_000);

  /*
   * Git for Windows installs with core.autocrlf on, so the checkout the app
   * made rewrote every text file to CRLF, the tree hashed to something no
   * catalogue listed, and every pinned install there was refused. The same
   * setting reproduces it on any machine.
   */
  test("a user whose git turns line endings to CRLF still gets the listed bytes", async () => {
    const r = await install({ kind: "catalogue", id: "orbit-clock", catalogue: catalogue(entry()) }, { gitconfig: "[core]\n\tautocrlf = true\n" });
    expect(r.result.error ?? "").toBe("");
    expect(r.result.ok).toBe(true);
    expect(r.runSh).toBe("echo listed\n");
  }, 30_000);

  // A folder in use can hold a socket or a pipe; `cp -R` copied them and the
  // walk ignores them, so they do not stop an install.
  test("a folder holding a pipe still installs from its path", async () => {
    const folder = mkdtempSync(join(root, "fifo-"));
    writeFileSync(join(folder, MANIFEST_NAME), JSON.stringify({ ...okManifest, name: "orbit-clock", entrypoint: "sh run.sh" }));
    writeFileSync(join(folder, "run.sh"), "echo local\n");
    expect(Bun.spawnSync(["mkfifo", join(folder, "dev.pipe")]).exitCode).toBe(0);
    const local = await install({ kind: "local", path: folder });
    expect(local.result.error ?? "").toBe("");
    expect(local.runSh).toBe("echo local\n");
  }, 30_000);

  // `cp` is not a program Windows has. The copy into place is the app's own,
  // and a link inside the plugin arrives as the same link.
  test("installs where git is the only program there is, and keeps a link a link", async () => {
    const pinnedInstall = await install({ kind: "catalogue", id: "orbit-clock", catalogue: catalogue(entry()) }, { onlyGit: true });
    expect(pinnedInstall.result.error ?? "").toBe("");
    expect(pinnedInstall.runSh).toBe("echo listed\n");

    const folder = mkdtempSync(join(root, "folder-"));
    writeFileSync(join(folder, MANIFEST_NAME), JSON.stringify({ ...okManifest, name: "orbit-clock", entrypoint: "sh run.sh" }));
    writeFileSync(join(folder, "listed.sh"), "echo local\n");
    symlinkSync("listed.sh", join(folder, "run.sh"));
    const local = await install({ kind: "local", path: folder }, { onlyGit: true });
    expect(local.result.error ?? "").toBe("");
    expect(local.runSh).toBe("echo local\n");
    expect(readlinkSync(join(local.result.plugin!.installDir, "run.sh"))).toBe("listed.sh");
  }, 30_000);

  test("an entry that pins nothing still installs the default branch, as a catalogue from elsewhere may", async () => {
    const r = await install({ kind: "catalogue", id: "orbit-clock", catalogue: catalogue(entry({ source: { kind: "git", url: "https://github.com/acme/orbit-clock", ref: null }, sha256: undefined })) });
    expect(r.result.ok).toBe(true);
    expect(r.runSh).toBe("echo something else\n");
    expect(r.log).toContain("clone");
  }, 30_000);
});
