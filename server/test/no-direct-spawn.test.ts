/**
 * No new process start in server/src outside the spawn broker.
 *
 * Measured on the live app: the server froze 1-2.5 s every few minutes with
 * its only thread in kernel_clone, forking itself (~1 GB) for git, docker and
 * tmux children it started outside the broker (broker/wire.ts). A background
 * command goes through `runChild` (broker/brokerRun.ts), `gitAsync` (git.ts)
 * or `gh` (prs.ts), which ask the broker first.
 *
 * Every place left that starts a process itself is listed below with why. The
 * count per file is exact: a new start goes red here, and a start moved onto
 * the broker goes red too until its line here shrinks, so the list never
 * keeps room for a start that is gone.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const SRC = join(import.meta.dir, "../src");

/** A call that starts a process. Types (`typeof Bun.spawn`) and comments are not one.
 *  `spawn`/`spawnSync` imported from "bun" are counted at each call too (bunSpawnNames). */
const START = /\bBun\.spawn(Sync)?\s*\(|\(Bun\.spawn(Sync)?\s+as\b|from\s+["']node:child_process["']|require\(["'](node:)?child_process["']\)|\bspawnSyncAs\(/g;

const BROKER = "the broker itself, or its fallback when no broker is up";
const HOST = "starts a long-lived sidecar process at boot (relay, reader)";
const STREAM = "long-lived or streamed child: the broker answers only when a child ends";
const SYNC = "synchronous: its callers cannot await; moving it means making them async (open)";
const GUI = "a person's click opens an app or editor: once per click, not background";
const SHUTDOWN = "shutdown or self-update path: runs once, the server is leaving";

/** file (relative to server/src) -> [starts allowed, why]. */
const ALLOWED: Record<string, [number, string]> = {
  "broker/brokerHost.ts": [1, BROKER],
  "broker/brokerMain.ts": [1, BROKER],
  "broker/brokerRun.ts": [1, BROKER],
  "git.ts": [3, `${BROKER}; plus the sync git() (${SYNC})`],
  "prs.ts": [2, `${BROKER} for gh; plus the job-log download (${STREAM})`],
  "localMerge.ts": [1, `the single git runner of the local plan merge, ${SYNC}`],
  "loopwatch.ts": [1, "the spawnSyncAs wrapper itself; its callers are counted where they are"],
  "relay/relayHost.ts": [1, HOST],
  "reader/readerHost.ts": [1, HOST],
  "relay/termrelay.ts": [1, "runs in the relay process, not the server"],
  "terminal.ts": [2, `${STREAM} (a pty); and switch-client on a person's click (${GUI})`],
  "dockerlogs.ts": [1, `${STREAM} (docker logs --follow)`],
  "dockerwatch.ts": [1, `${STREAM} (docker events)`],
  "tmuxwatch.ts": [1, `${STREAM} (tmux -C attach)`],
  "volumes.ts": [3, `${STREAM} (gio monitor, mount -m); and udisksctl with a passphrase on stdin and no limit (open)`],
  "agents/opencodeserve.ts": [1, `${STREAM} (a server)`],
  "agentprobe.ts": [1, `${STREAM} (a detached agent)`],
  "dictate.ts": [1, `${STREAM} (recording)`],
  "finderactions.ts": [1, `${STREAM} (a detached command a person started)`],
  "plugin-bridge.ts": [1, "the CLI bridge, its own process with inherited stdio"],
  "plugin-github.ts": [1, `${STREAM} (tarball piped to the response)`],
  "checkOnBase.ts": [1, `${STREAM} (a check run, its output streamed to a capped log, its process group killed on timeout)`],
  "notifications.ts": [2, `${STREAM} (dbus-monitor); and xdg-open on a note a person clicked (${GUI})`],
  "treeAt.ts": [1, `${STREAM} (tar of a tree piped out)`],
  "treeExport.ts": [1, `${STREAM} (spawnGit: ls-tree and cat-file --batch read as they run)`],
  "alerts.ts": [1, "a desktop notification for one alert"],
  "bench.ts": [4, GUI],
  "browse.ts": [3, GUI],
  "browserdrive.ts": [1, GUI],
  "editor.ts": [2, GUI],
  "editorwhere.ts": [1, GUI],
  "openwith.ts": [1, GUI],
  "themesync.ts": [3, "a theme change a person made, sent to tmux and nvim"],
  "selfupdate.ts": [2, SHUTDOWN],
  "agents/ceilings.ts": [1, SYNC],
  "agents/claudecode.ts": [1, SYNC],
  "agents/headless.ts": [3, SYNC],
  "agents/launch.ts": [1, SYNC],
  "childledger.ts": [2, SYNC],
  "config.ts": [1, SYNC],
  "db.ts": [1, SYNC],
  "hooksetup.ts": [1, SYNC],
  "index.ts": [1, SYNC],
  "ownhelpers.ts": [1, SYNC],
  "pdeathsig.ts": [1, `${SYNC}; a boot probe`],
  "plugin-sandbox.ts": [4, `${SYNC}; boot probes`],
  "plugin-sources.ts": [1, SYNC],
  "procchildren.ts": [1, SYNC],
  "proctree.ts": [1, SYNC],
  "pushSeen.ts": [1, SYNC],
  "scopes.ts": [3, SYNC],
  "tmuxbin.ts": [2, `${SYNC}; boot probes`],
  "tmuxconf.ts": [4, `${SYNC}; boot probes`],
  "tmuxctl.ts": [3, `${SYNC} (the sync tmux wrappers)`],
  "tmuxpane.ts": [1, `${SYNC} (tmuxSync, the pty handshake)`],
  "tmuxrestore.ts": [2, `${SYNC}; restore after boot`],
  "worktree.ts": [1, SYNC],
  "machine.ts": [1, SYNC],
  "worktreeseed.ts": [1, SYNC],
  "ignored.ts": [1, SYNC],
  "pushLanding.ts": [1, SYNC],
  "disk.ts": [1, `${STREAM} (a search read as it arrives and stopped at a page of hits)`],
  "diskclean.ts": [1, "a repo script a person runs from cleanup, in its own process group that a timeout kills whole; the broker kills one pid"],
  "mediafacts.ts": [1, "binary output (a video frame as JPEG): the broker answers text only"],
  "plugins.ts": [1, `${STREAM} (a plugin's own process, in its own group)`],
  "remotes.ts": [1, `${STREAM} (gio mount, its prompts answered on stdin)`],
};

/** `import { spawn } from "bun"`: the names it binds `spawn`/`spawnSync` to, aliases included. */
const BUN_IMPORT = /\bimport\s*\{([^}]*)\}\s*from\s*["']bun["']/g;
function bunSpawnNames(text: string): string[] {
  const names: string[] = [];
  for (const m of text.matchAll(BUN_IMPORT)) {
    for (const spec of m[1]!.split(",")) {
      const [name = "", alias] = spec.trim().replace(/^type\s+/, "").split(/\s+as\s+/);
      if ((name === "spawn" || name === "spawnSync") && !spec.trim().startsWith("type ")) names.push((alias ?? name).trim());
    }
  }
  return names;
}

/** Starts per file, comment lines left out. Exported shape for the deliberate-break check below. */
export function countStarts(files: Record<string, string>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [f, text] of Object.entries(files)) {
    const names = bunSpawnNames(text);
    const call = names.length ? new RegExp(`(?<![.\\w$])(?:${names.join("|")})\\s*\\(`, "g") : null;
    let n = 0;
    for (const line of text.split("\n")) {
      const t = line.trim();
      if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) continue;
      n += (line.match(START) ?? []).length;
      if (call) n += (line.match(call) ?? []).length;
    }
    if (n) out[f] = n;
  }
  return out;
}

function sources(): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const e of readdirSync(d)) {
      const p = join(d, e);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith(".ts") && !p.endsWith(".test.ts")) out[relative(SRC, p)] = readFileSync(p, "utf8");
    }
  };
  walk(SRC);
  return out;
}

/** What differs from the list, worded for whoever broke it. Empty when it matches. */
export function offences(found: Record<string, number>): string[] {
  const bad: string[] = [];
  for (const [f, n] of Object.entries(found)) {
    const allowed = ALLOWED[f]?.[0] ?? 0;
    if (n > allowed) bad.push(`${f}: ${n} process starts, ${allowed} allowed. Use runChild (broker/brokerRun.ts) or gitAsync; or list it here with why.`);
    if (n < allowed) bad.push(`${f}: ${n} process starts, the list still allows ${allowed}. Lower its line here.`);
  }
  for (const f of Object.keys(ALLOWED)) if (!found[f]) bad.push(`${f}: no process start left. Take its line out of the list.`);
  return bad;
}

describe("process starts in server/src", () => {
  test("only the listed places start a process themselves, each as many times as listed", () => {
    expect(offences(countStarts(sources()))).toEqual([]);
  });

  test("a new Bun.spawn in a background file goes red, and so does a new sync start", () => {
    const src = sources();
    const lantern = src["lantern.ts"]!;
    expect(offences(countStarts({ ...src, "lantern.ts": `${lantern}\nconst p = Bun.spawn(["git", "status"]);\n` })))
      .toEqual(["lantern.ts: 1 process starts, 0 allowed. Use runChild (broker/brokerRun.ts) or gitAsync; or list it here with why."]);
    expect(offences(countStarts({ ...src, "docker.ts": `${src["docker.ts"]!}\nspawnSyncAs("x", ["docker", "ps"]);\n` }))).toHaveLength(1);
    expect(offences(countStarts({ ...src, "docker.ts": `${src["docker.ts"]!}\nimport { spawn } from "node:child_process";\n` }))).toHaveLength(1);
  });

  test("spawn and spawnSync imported from \"bun\" count at each call, aliases too", () => {
    const src = sources();
    const with_ = (extra: string) => offences(countStarts({ ...src, "lantern.ts": `${extra}\n${src["lantern.ts"]!}` }));
    expect(with_(`import { spawn } from "bun";\nconst p = spawn(["git", "status"]);\nspawn({ cmd: ["ls"] });`))
      .toEqual(["lantern.ts: 2 process starts, 0 allowed. Use runChild (broker/brokerRun.ts) or gitAsync; or list it here with why."]);
    expect(with_(`import { type Subprocess, spawnSync as run } from 'bun';\nrun(["git"]);`)).toHaveLength(1);
    expect(countStarts({ "x.ts": `import { spawn } from "bun";\nlet p: ReturnType<typeof spawn>;\nfoo.spawn(1);\n// spawn(["git"])\n` })).toEqual({});
  });

  test("a type, a comment and the broker's own calls are not starts", () => {
    expect(countStarts({ "x.ts": "let p: ReturnType<typeof Bun.spawn>;\n// Bun.spawn([\"git\"])\n * Bun.spawnSync(x)\nawait runChild([\"git\"], { timeoutMs: 1 });\n" })).toEqual({});
  });
});
