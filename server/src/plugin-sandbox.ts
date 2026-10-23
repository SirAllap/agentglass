/*
 * Slice 2: the box itself. Slice 3 adds the network split — `sandboxArgv`'s
 * own comment on `network` has the detail. Slice 1 (shared/pluginSandbox.ts)
 * is the declaration and the approval; nothing here decides what a plugin
 * may ask for, it only decides how what was already approved gets mounted.
 *
 * Three pieces, kept separate on purpose:
 *  - `sandboxProbe` asks the HOST once whether bwrap can build a box at all.
 *  - `resolveGrants`/`resolvePrograms` turn a manifest's `~/…` spellings into
 *    real, re-checked paths — this is where a symlink pointed at a secret
 *    gets caught, because `validateSandbox` in shared/pluginSandbox.ts only
 *    ever saw the spelling, not the filesystem.
 *  - `sandboxArgv` is pure: given every fact already resolved, it is just
 *    argv, and a test can pin its exact shape without a working bwrap.
 */
import { closeSync, constants as fsConstants, lstatSync, mkdirSync, openSync, readFileSync, readlinkSync, realpathSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  NEVER_MOUNTABLE, NEVER_MOUNTABLE_ROOTS, PERSISTENCE_WRITE_DIRS, PERSISTENCE_WRITE_FILES, type PluginSandbox,
} from "../../shared/pluginSandbox.ts";

export type SandboxProbe =
  | { ok: true; bwrap: string }
  | { ok: false; reason: "missing" | "userns-blocked" | "failed"; detail: string };

const DEFAULT_USERNS_SYSCTL = "/proc/sys/kernel/apparmor_restrict_unprivileged_userns";

/** Whether the AppArmor knob that Ubuntu ships (and that blocks an
 *  unprivileged user namespace, which bwrap needs) reads "1". Its path is
 *  only ever overridden by a test — `AGENTGLASS_SANDBOX_USERNS_SYSCTL` names
 *  no real setting a person would want to move. */
function usernsBlocked(): boolean {
  const path = process.env.AGENTGLASS_SANDBOX_USERNS_SYSCTL || DEFAULT_USERNS_SYSCTL;
  try {
    return readFileSync(path, "utf8").trim() === "1";
  } catch {
    return false;
  }
}

/** Where a real bwrap lives on every distribution this app supports — never
 *  a directory under home. A plugin with `write: ["~/.local/bin"]` (refused
 *  outright now, see PERSISTENCE_WRITE_DIRS, but this is the check that
 *  matters if that one is ever loosened) could otherwise drop its own
 *  `bwrap` on the PATH the server's own `Bun.which` searches, have this probe
 *  find THAT one, exit 0 for it, and have every plugin after it spawn
 *  unboxed through an attacker's binary instead of the real one. */
const TRUSTED_BWRAP = ["/usr/bin/bwrap", "/bin/bwrap"];

/** `Bun.which("bwrap")`, but only trusted if it resolves to one of the fixed
 *  system paths above; `AGENTGLASS_BWRAP` — a test stub that fails on
 *  purpose — is honoured only under `bun test`, never in the app a person
 *  actually runs. */
function findBwrap(): { path: string } | { missing: string } {
  if (process.env.NODE_ENV === "test" && process.env.AGENTGLASS_BWRAP) return { path: process.env.AGENTGLASS_BWRAP };
  // Explicit `PATH`: `Bun.which` with none resolves against the PATH the
  // process started with, not `process.env.PATH` as it stands now — the same
  // trap `browse.ts`/`docker.ts` already work around, and the reason a test
  // can force "missing" by emptying `process.env.PATH` first.
  const found = Bun.which("bwrap", { PATH: process.env.PATH ?? "" });
  if (!found) return { missing: "bwrap is not on PATH" };
  let real = found;
  try {
    real = realpathSync(found);
  } catch {
    /* keep found: realpath only ever narrows */
  }
  if (!TRUSTED_BWRAP.includes(real)) return { missing: `found "${found}" on PATH, but it is not ${TRUSTED_BWRAP.join(" or ")} — refusing to trust it` };
  return { path: real };
}

function runProbe(): SandboxProbe {
  const found = findBwrap();
  if ("missing" in found) return { ok: false, reason: "missing", detail: found.missing };
  const bwrap = found.path;
  let result;
  try {
    result = Bun.spawnSync([bwrap, "--unshare-all", "--die-with-parent", "--ro-bind", "/", "/", "true"], {
      stdout: "ignore",
      stderr: "pipe",
      timeout: 3000,
    });
  } catch (e) {
    return { ok: false, reason: "failed", detail: e instanceof Error ? e.message : String(e) };
  }
  if (result.success) return { ok: true, bwrap };
  const stderrText = result.stderr ? result.stderr.toString("utf8") : "";
  const firstLine = stderrText.split("\n").find((l) => l.trim().length > 0)?.trim();
  const detail = result.exitedDueToTimeout ? "bwrap did not finish within 3s" : firstLine || `bwrap exited ${result.exitCode}`;
  return usernsBlocked() ? { ok: false, reason: "userns-blocked", detail } : { ok: false, reason: "failed", detail };
}

let cached: SandboxProbe | undefined;

/** Whether this host can build a box at all — cached for the process, since
 *  spawning bwrap on every plugin start would cost 3s of blocking work on
 *  the server's one thread the moment the host cannot do it. */
export function sandboxProbe(): SandboxProbe {
  if (cached === undefined) cached = runProbe();
  return cached;
}

/** Test seam: a probe taken before `AGENTGLASS_BWRAP` or the sysctl override
 *  was set would otherwise stick for the rest of the process. */
export function __resetSandboxProbe(): void {
  cached = undefined;
}

export interface ResolvedGrant {
  path: string;
}

function segs(p: string): string[] {
  return p.split("/").filter(Boolean);
}

function isAncestorOrSame(shorter: string[], longer: string[]): boolean {
  return shorter.length <= longer.length && shorter.every((s, i) => s === longer[i]);
}

function expandHome(p: string, home: string): string {
  return p.startsWith("~/") ? join(home, p.slice(2)) : p;
}

/** The same roots `plugins.ts` and the rest of the server keep this app's own
 *  state under, re-derived rather than imported: this module is imported BY
 *  plugins.ts, and reaching back for `pluginsConfigDir` would make a cycle.
 *  A grant that overlaps any of these would mount the app's own token or
 *  database into the very box that is supposed to be kept off them —
 *  realpath'd, because the guarded dir itself can be reached through a link
 *  (`XDG_DATA_HOME` pointed at one, say) just as easily as a grant can. */
function agentglassDirs(home: string): string[] {
  const cfg = join(process.env.XDG_CONFIG_HOME || join(home, ".config"), "agentglass");
  const data = join(process.env.XDG_DATA_HOME || join(home, ".local", "share"), "agentglass");
  const state = process.env.AGENTGLASS_STATE_DIR || join(process.env.XDG_STATE_HOME || join(home, ".local", "state"), "agentglass");
  const guarded = [cfg, data, state];
  if (process.env.AGENTGLASS_DB) guarded.push(dirname(process.env.AGENTGLASS_DB));
  return guarded.map((d) => {
    try {
      return realpathSync(d);
    } catch {
      return d; // does not exist yet: still guarded by its spelling
    }
  });
}

/** Live, per-run locations nothing declares in `NEVER_MOUNTABLE` because they
 *  move: this session's tmux socket directory and its runtime dir. A
 *  read-only bind of the directory holding one is still a `connect()` to
 *  whatever is listening inside it — see `NEVER_MOUNTABLE_ROOTS` in
 *  shared/pluginSandbox.ts, which this only adds the moving half of. */
function liveNeverPaths(): string[] {
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  return [process.env.TMUX_TMPDIR, process.env.XDG_RUNTIME_DIR, uid !== undefined ? `/tmp/tmux-${uid}` : undefined].filter(
    (p): p is string => typeof p === "string" && p.length > 0,
  );
}

/** Why `real` may not be mounted, or null. Re-checks what `validateSandbox`
 *  in shared/pluginSandbox.ts already checked, but against the RESOLVED
 *  path: a manifest can only spell `~/.config/orbit`, but a symlink at that
 *  spelling can point anywhere, and the spelling is not what gets mounted.
 *  `kind` repeats the write-only persistence check the validator already
 *  ran on the spelling, against the resolved path this time. */
function refusalReason(real: string, home: string, kind: "read" | "write" = "read"): string | null {
  if (real === "/") return "is the whole disk";
  if (real === home) return "is the whole home folder";
  const realSegs = segs(real);
  for (const never of NEVER_MOUNTABLE) {
    const n = segs(expandHome(never, home));
    if (isAncestorOrSame(realSegs, n) || isAncestorOrSame(n, realSegs)) return `resolves to ${never}, which no plugin can be given`;
  }
  const homeSegs = segs(home);
  const underHome = isAncestorOrSame(homeSegs, realSegs);
  for (const root of NEVER_MOUNTABLE_ROOTS) {
    const n = segs(root);
    if (!(isAncestorOrSame(realSegs, n) || isAncestorOrSame(n, realSegs))) continue;
    // `/tmp` and `/var/tmp` are the two of these a real HOME can legitimately
    // sit under — a test harness's own scratch home (this repo's does, see
    // server/test/isolation.ts) or some minimal container's. Refusing them
    // there would refuse the plugin's own folder along with everything under
    // it, so the exception is narrow: only for a path genuinely inside HOME's
    // own tree, and only for these two roots — `/proc`, `/sys`, `/dev`,
    // `/run`, `/var/run` can never plausibly be a real home and stay absolute.
    if ((root === "/tmp" || root === "/var/tmp") && underHome) continue;
    return `resolves to ${root}, which no plugin can be given`;
  }
  // Always absolute, home or not: a live socket directory is dangerous
  // wherever it sits, and the whole point of naming these live paths
  // separately from the roots above is that home being under `/tmp` must
  // not quietly exempt `$TMUX_TMPDIR` too.
  for (const root of liveNeverPaths()) {
    const n = segs(root);
    if (isAncestorOrSame(realSegs, n) || isAncestorOrSame(n, realSegs)) return `resolves to ${root}, which no plugin can be given`;
  }
  for (const guarded of agentglassDirs(home)) {
    const g = segs(guarded);
    if (isAncestorOrSame(realSegs, g) || isAncestorOrSame(g, realSegs)) return "is agentglass's own config, data or state folder, or an ancestor of it";
  }
  if (kind === "write") {
    for (const file of PERSISTENCE_WRITE_FILES) {
      if (segs(expandHome(file, home)).join("/") === realSegs.join("/")) return `resolves to ${file}, which no plugin can write to`;
    }
    for (const dir of PERSISTENCE_WRITE_DIRS) {
      const n = segs(expandHome(dir, home));
      if (isAncestorOrSame(realSegs, n) || isAncestorOrSame(n, realSegs)) return `resolves to ${dir}, which no plugin can be given write access to`;
    }
    // Not one of the named dirs above, but still on the PATH this server
    // itself would search — a write grant there plants a binary something
    // else on this machine already trusts by name.
    for (const entry of (process.env.PATH ?? "").split(":").filter(Boolean)) {
      if (segs(entry).join("/") === realSegs.join("/")) return "is on this machine's PATH — a plugin could plant a binary there for something else to run";
    }
  }
  return null;
}

/**
 * `sandbox.read`/`sandbox.write`, expanded and resolved against the real
 * filesystem. A grant that does not exist is dropped rather than refused —
 * plenty of plugins declare a data folder that only appears the first time
 * they run — but a grant that DOES resolve is re-checked exactly like
 * `validateSandbox` checked its spelling, because a symlink can turn an
 * innocent spelling into `~/.ssh` between review and enable.
 */
export function resolveGrants(
  sandbox: PluginSandbox,
  home: string,
): { read: ResolvedGrant[]; write: ResolvedGrant[]; refused: { path: string; why: string }[] } {
  const realHome = (() => {
    try {
      return realpathSync(home);
    } catch {
      return home;
    }
  })();
  const refused: { path: string; why: string }[] = [];
  const resolveOne = (raw: string, kind: "read" | "write"): ResolvedGrant | null => {
    const expanded = expandHome(raw, realHome);
    let real: string;
    try {
      real = realpathSync(expanded);
    } catch {
      refused.push({ path: raw, why: "does not exist" });
      return null;
    }
    const why = refusalReason(real, realHome, kind);
    if (why) {
      refused.push({ path: raw, why });
      return null;
    }
    return { path: real };
  };
  const read: ResolvedGrant[] = [];
  for (const r of sandbox.read) {
    const g = resolveOne(r, "read");
    if (g) read.push(g);
  }
  const write: ResolvedGrant[] = [];
  for (const w of sandbox.write) {
    const g = resolveOne(w, "write");
    if (g) write.push(g);
  }
  return { read, write, refused };
}

export interface OpenedGrant {
  dest: string;
  /** The fd number the CHILD sees, once `plugins.ts` lays `parentFds` onto
   *  `Bun.spawn`'s `stdio` array starting at index 3 — index `i` there becomes
   *  fd `3 + i` in the child, which is what `sandboxArgv` writes into
   *  `--ro-bind-fd`/`--bind-fd`. */
  childFd: number;
}

/** Linux's `O_PATH`: not in `node:fs`'s `constants` (non-portable), so it is
 *  the one raw octal value in this file. Opens a descriptor good enough to
 *  bind-mount or `readlink /proc/self/fd/N`, without the open itself
 *  triggering a FIFO's blocking read or a device's side effects — the class
 *  of thing a plugin-controlled `write` grant could otherwise leave behind
 *  a socket or a FIFO where a file was expected. */
const O_PATH = 0o10000000;

/**
 * `resolveGrants`' realpath and the mount bwrap performs at spawn are two
 * different moments, and a plugin sharing a folder with the one being
 * started can flip a symlink in the gap — every restart of the honest
 * plugin becomes a lottery that might mount `~/.ssh` instead of the folder
 * it was shown. Opening each grant here, right before `Bun.spawn`, with
 * `O_NOFOLLOW` and handing bwrap the DESCRIPTOR rather than the path closes
 * that gap: whatever the path is swapped to afterward, the fd still points
 * at the inode this function actually checked.
 *
 * Verified independently of `refusalReason`'s own correctness: `openSync`
 * with `O_NOFOLLOW` fails outright the instant the final component is a
 * symlink, and the `/proc/self/fd/N` readlink after a successful open is
 * re-checked against `refusalReason` as the last word before the fd is kept.
 *
 * Ceiling: only `sandbox.read`/`sandbox.write` are pinned this way.
 * `programDirs` (`resolvePrograms`) are still mounted by path — a narrower
 * race between two plugins that both write under home, and not what this
 * slice's finding was about.
 */
export function openGrantFds(
  grants: { read: ResolvedGrant[]; write: ResolvedGrant[] },
  home: string,
): { read: OpenedGrant[]; write: OpenedGrant[]; parentFds: number[]; refused: { path: string; why: string }[] } {
  const parentFds: number[] = [];
  const refused: { path: string; why: string }[] = [];
  let nextChildFd = 3;
  const openOne = (g: ResolvedGrant): OpenedGrant | null => {
    let fd: number;
    try {
      fd = openSync(g.path, O_PATH | fsConstants.O_NOFOLLOW);
    } catch (e) {
      refused.push({ path: g.path, why: `could not open for the box: ${e instanceof Error ? e.message : String(e)}` });
      return null;
    }
    let real: string;
    try {
      real = readlinkSync(`/proc/self/fd/${fd}`);
    } catch {
      closeSync(fd);
      refused.push({ path: g.path, why: "could not verify what this descriptor actually points at" });
      return null;
    }
    const why = real !== g.path ? "changed between review and start" : refusalReason(real, home);
    if (why) {
      closeSync(fd);
      refused.push({ path: g.path, why });
      return null;
    }
    const childFd = nextChildFd++;
    parentFds.push(fd);
    return { dest: g.path, childFd };
  };
  const read: OpenedGrant[] = [];
  for (const g of grants.read) {
    const o = openOne(g);
    if (o) read.push(o);
  }
  const write: OpenedGrant[] = [];
  for (const g of grants.write) {
    const o = openOne(g);
    if (o) write.push(o);
  }
  return { read, write, parentFds, refused };
}

function isUnder(candidate: string, home: string): boolean {
  return candidate === home || candidate.startsWith(home + "/");
}

/**
 * `sandbox.programs`: bare command names to put on the plugin's PATH.
 * Resolved against the HOST's PATH (the plugin's box has none of its own
 * yet), and kept only when the found binary lives under home — anything
 * under `/usr` or similar is already visible through the `--ro-bind /usr
 * /usr` every box gets, so granting it again would just be a second way to
 * refuse the same secret. Both the found file's directory and its symlink
 * target's directory are kept: a shim in `~/.local/bin` that is itself a
 * symlink into `~/.volta/bin` needs both mounted, or the box can see the
 * shim but not what it execs.
 *
 * Ceiling: a shim that execs a version manager (mise, asdf) needs the
 * manager's own tree declared in `read` — this only follows one hop of
 * symlink, not a manager's internal dispatch.
 */
export function resolvePrograms(
  programs: string[],
  hostPath: string,
  home: string,
): { dirs: string[]; refused: { path: string; why: string }[] } {
  const realHome = (() => {
    try {
      return realpathSync(home);
    } catch {
      return home;
    }
  })();
  const dirs = new Set<string>();
  const refused: { path: string; why: string }[] = [];
  for (const name of programs) {
    const found = Bun.which(name, { PATH: hostPath });
    if (!found) continue;
    let real = found;
    try {
      real = realpathSync(found);
    } catch {
      /* not a symlink, or already gone */
    }
    for (const raw of new Set([dirname(found), dirname(real)])) {
      // The directory a symlink points at, not the link: bwrap refuses to
      // mount onto a symlink destination (a manager's `latest`), which killed
      // the plugin in its first milliseconds with "Can't mount on symlink
      // destination". The binary is found there just the same.
      let candidate = raw;
      try { candidate = realpathSync(raw); } catch { /* gone: refused below or skipped */ }
      if (!isUnder(candidate, realHome)) continue;
      const why = refusalReason(candidate, realHome);
      if (why) {
        refused.push({ path: candidate, why });
        continue;
      }
      dirs.add(candidate);
    }
  }
  return { dirs: [...dirs].sort(), refused };
}

/**
 * No token here on purpose — see the comment on `--clearenv` below. It
 * reaches the box only through `Bun.spawn`'s own env in `plugins.ts`, which
 * is already exactly PATH/HOME/token/URL/DATA and nothing wider.
 */
export interface SandboxEnv {
  PATH: string;
  AGENTGLASS_URL: string;
}

/** Where the plugin socket (plugin-socket.ts) is bind-mounted inside every
 *  `network: "agentglass"` box — fixed, because the plugin never learns a
 *  path for it: `AGENTGLASS_URL` still reads `http://127.0.0.1:<port>`, and
 *  it is the bridge (plugin-bridge.ts), not the plugin, that dials this
 *  path. Nothing else is ever mounted under `/run` for a boxed plugin. */
export const PLUGIN_SOCKET_BOX_PATH = "/run/agentglass/plugin.sock";

/** What `sandboxArgv` needs to wire a `network: "agentglass"` box's loopback
 *  back to the app: the host side of the one shared plugin socket, and the
 *  argv that re-invokes this app as `plugin-bridge` (dev runs `bun
 *  server/src/index.ts plugin-bridge …`; a compiled build runs the sidecar
 *  itself with the same argument — see `bridgeExecCommand` in plugins.ts,
 *  which is the only caller and the only place that touches `Bun.main`).
 *  Absent for `network: "internet"`, which needs none of this. */
export interface SandboxNetworkAgentglass {
  socketHostPath: string;
  bridgeExec: string[];
  /** What `bridgeExec` needs read-only to exec. Bound AFTER the tmpfs over
   *  HOME and /tmp: this machine's installed sidecar lives under HOME and an
   *  AppImage runs from /tmp, and a bind laid before the tmpfs is hidden by it
   *  (measured: `execvp …/bun: No such file or directory`). */
  bridgeRo: string[];
}

export interface SandboxArgvInput {
  bwrap: string;
  installDir: string;
  dataDir: string;
  home: string;
  entrypoint: string;
  env: SandboxEnv;
  sandbox: PluginSandbox;
  grants: { read: OpenedGrant[]; write: OpenedGrant[] };
  programDirs: string[];
  systemLinks: { path: string; target: string }[];
  systemDirs: string[];
  extraRo: string[];
  /** Required exactly when `sandbox.network === "agentglass"` — the caller
   *  (`plugins.ts`'s `buildBoxArgv`) builds it right before the spawn that
   *  will use it, the same moment it opens the grant fds. */
  network?: SandboxNetworkAgentglass;
}

/** `path` entries that are — or are under — `home`, dropped: the box's PATH
 *  must not resolve into a tmpfs that starts empty. */
function hostPathOutsideHome(hostPath: string, home: string): string[] {
  return hostPath.split(":").filter((p) => p && !isUnder(p, home));
}

/**
 * The exact argv bwrap runs with. Pure: every path came in already resolved
 * by `resolveGrants`/`resolvePrograms`/the caller's own look at the host
 * filesystem, so this function never touches disk and a test can pin its
 * shape without a working bwrap on the machine that runs the test.
 *
 * Network: `network: "internet"` keeps slice 2's `--share-net` unconditionally
 * — the box gets the host's real network device, so it can reach the open
 * internet and, ceiling: every loopback service already listening on this
 * machine, exactly as an unboxed process could. `network: "agentglass"` gets
 * `--unshare-net` instead: no interface but its own loopback, which is not
 * this app until the plugin socket is bind-mounted onto it (below) and the
 * bridge (`plugin-bridge.ts`, wrapped around the entrypoint) proxies the
 * box's own `127.0.0.1:<port>` — the same `AGENTGLASS_URL` a plugin always
 * had — onto that socket. `--unshare-net` also closes the abstract-socket
 * namespace and every OTHER 127.0.0.1 listener `--share-net` would have
 * shared: the one thing `network: "agentglass"` could not otherwise promise.
 *
 * No `--clearenv`, and no `--setenv` of the token: `/proc/<pid>/cmdline` is
 * world-readable (no `hidepid`), by any unboxed process and by any box that
 * ever gets a `/proc` grant — env is owner-only. Without `--clearenv` bwrap
 * inherits whatever it was itself launched with, which `Bun.spawn` in
 * `plugins.ts` already builds as exactly PATH/HOME/token/URL/DATA (never
 * `process.env` spread — see `startProcess`'s own comment on that), so the
 * token still reaches the plugin, just never through argv. `PATH` and `HOME`
 * are still `--setenv` here because the box's PATH differs from the outer
 * one (program dirs, home entries dropped) and neither is a secret.
 */
export function sandboxArgv(input: SandboxArgvInput): string[] {
  const { bwrap, installDir, dataDir, home, entrypoint, env, sandbox, grants, programDirs, systemLinks, systemDirs, extraRo, network } = input;
  const agentglassNet = sandbox.network === "agentglass";
  const path = [...hostPathOutsideHome(env.PATH, home), ...programDirs].join(":");
  const argv: string[] = [
    bwrap,
    "--unshare-all", agentglassNet ? "--unshare-net" : "--share-net",
    "--die-with-parent", "--new-session", "--cap-drop", "ALL",
    "--setenv", "PATH", path,
    "--setenv", "HOME", home,
    "--setenv", "AGENTGLASS_URL", env.AGENTGLASS_URL,
    "--setenv", "AGENTGLASS_PLUGIN_DATA", dataDir,
    "--ro-bind", "/usr", "/usr",
  ];
  for (const d of systemDirs) argv.push("--ro-bind-try", d, d);
  for (const l of systemLinks) argv.push("--symlink", l.target, l.path);
  // Never anything under /run/user: the caller only ever puts a resolv.conf
  // target here (see `hostResolvConfExtraRo`), and this loop trusts it —
  // enforced by that function existing at all, not by a check repeated here.
  for (const p of extraRo) argv.push("--ro-bind-try", p, p);
  argv.push("--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp", "--tmpfs", home);
  argv.push("--ro-bind", installDir, installDir);
  argv.push("--bind", dataDir, dataDir);
  // Handed as open descriptors, not paths — see `openGrantFds` for why.
  for (const g of grants.read) argv.push("--ro-bind-fd", String(g.childFd), g.dest);
  for (const g of grants.write) argv.push("--bind-fd", String(g.childFd), g.dest);
  for (const d of programDirs) argv.push("--ro-bind", d, d);
  // Not `-try`: a bridge that is missing must fail the start loudly, not leave a box whose entrypoint can never run.
  for (const p of network?.bridgeRo ?? []) argv.push("--ro-bind", p, p);
  argv.push("--chdir", installDir);
  if (agentglassNet) {
    if (!network) throw new Error('sandboxArgv: network: "agentglass" needs its network input built first (buildBoxArgv\'s job)');
    // Nothing else under /run: this is the one path a boxed plugin's loopback
    // can reach, and the bridge is the only thing that ever dials it.
    // `--ro-bind`, not `--bind`: `connect()` works on a read-only bind, and a
    // writable one let the plugin `chmod` the host's own socket inode.
    argv.push("--ro-bind", network.socketHostPath, PLUGIN_SOCKET_BOX_PATH);
    const port = new URL(env.AGENTGLASS_URL).port || "80";
    argv.push(...network.bridgeExec, "plugin-bridge", "--listen", `127.0.0.1:${port}`, "--socket", PLUGIN_SOCKET_BOX_PATH, "--", "bash", "-c", entrypoint);
  } else {
    argv.push("bash", "-c", entrypoint);
  }
  return argv;
}

/** `/etc`, `/opt`, and the legacy split-usr directories, sorted into two
 *  buckets: a real directory is bound directly, a symlink (Debian/Ubuntu's
 *  merged-/usr layout, where `/bin` is `usr/bin`) is recreated as a symlink
 *  instead, since its target already comes in with the `--ro-bind /usr
 *  /usr` every box gets — binding it again as a directory would just mount
 *  `/usr` a second time under a different name. */
export function hostSystemPaths(): { systemDirs: string[]; systemLinks: { path: string; target: string }[] } {
  const systemDirs: string[] = [];
  const systemLinks: { path: string; target: string }[] = [];
  for (const p of ["/etc", "/opt", "/bin", "/sbin", "/lib", "/lib64", "/lib32"]) {
    let st;
    try {
      st = lstatSync(p);
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) systemLinks.push({ path: p, target: readlinkSync(p) });
    else if (st.isDirectory()) systemDirs.push(p);
  }
  return { systemDirs, systemLinks };
}

/**
 * `/etc/resolv.conf` is inside the `/etc` this box already gets read-only,
 * but on a systemd-resolved host it is a symlink to
 * `/run/systemd/resolve/stub-resolv.conf` — and nothing under `/run` is
 * mounted, so the symlink dangles and the plugin cannot resolve a hostname.
 * The fix is one directory, never the whole of `/run` and never
 * `/run/user`: `--share-net` already gives the plugin a network, and a box
 * that can reach the internet but not DNS is not a smaller box, just a more
 * confusing one.
 */
export function hostResolvConfExtraRo(): string[] {
  try {
    const real = realpathSync("/etc/resolv.conf");
    const dir = dirname(real);
    if (dir === "/run/systemd/resolve") return [dir];
  } catch {
    /* no resolv.conf, or not a link: nothing extra to mount */
  }
  return [];
}

/** Mirrors `pluginsConfigDir()` in plugins.ts. Re-derived rather than
 *  imported for the same reason `agentglassDirs` above is: plugins.ts
 *  imports this module, and importing back would make a cycle. */
function pluginsConfigDir(): string {
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "agentglass");
}

function pluginDataDirPath(name: string): string {
  return join(pluginsConfigDir(), "plugin-data", name);
}

/**
 * A plugin's own folder to read and write scratch state in, whether or not
 * it runs boxed — a sibling of the plugins install root, under the plugins
 * config dir, so it moves with the same `XDG_CONFIG_HOME`/`AGENTGLASS_STATE_DIR`
 * override a test or a second instance already gets everything else with.
 * Created here (mode 0700, its own) so every caller gets a directory that
 * exists rather than repeating the `mkdirSync`.
 */
export function pluginDataDir(name: string): string {
  const dir = pluginDataDirPath(name);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/** The other half of `pluginDataDir`: called from `removePlugin`, so a
 *  different author's plugin installed later under the same name does not
 *  inherit whatever the previous one cached there (a token, a clone). */
export function removePluginDataDir(name: string): void {
  try {
    rmSync(pluginDataDirPath(name), { recursive: true, force: true });
  } catch {
    /* already gone */
  }
}
