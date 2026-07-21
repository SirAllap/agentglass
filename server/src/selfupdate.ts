import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";
import type { UpdateStatus } from "../../shared/types.ts";

/**
 * Updating the app to the newest released tag.
 *
 * Two decisions shape everything here, and both were mistakes first.
 *
 * It tracks TAGS, not a branch. A branch tip is wherever development happened
 * to stop — half a feature, a debugging commit, whatever got pushed at six in
 * the evening. Tagging is the act of saying "I tested this", and an update
 * button that ignores it ships untested code to the one machine that matters.
 * Tags also make rollback trivial and match how a real release feed works, so
 * moving to one later changes the transport and nothing else.
 *
 * It builds from ITS OWN CLONE, never the developer's checkout. The first
 * version pulled in the working directory, which meant a convenience button
 * could move somebody's HEAD, and needed a thicket of guards — clean tree,
 * right branch, fast-forward — to be merely survivable. A private clone under
 * the cache needs none of them: nothing there is ever edited, so checking out a
 * tag is always safe, and the developer's repository is never touched at all.
 *
 * It is still not an auto-updater — it compiles on the machine, which is only
 * reasonable because that machine already has the toolchain. And it remains the
 * most dangerous route in the server, since it runs whatever the tag contains,
 * so it is reachable from the desktop shell alone.
 */

export type BuildInfo = {
  version: string;
  /** Commit the installed app was built from. */
  commit: string;
  builtAt: string;
  /** Where it was built from. Shown, never written to. */
  source: string;
  /** The remote the updater clones from. */
  origin: string;
  /** Nearest release this build descends from, and how far past it. */
  baseTag: string;
  distance: number;
};

/** A release looks like this. Anything else is somebody's private tag. */
const TAG_RE = /^v\d+\.\d+\.\d+$/;
const SRC = join(homedir(), ".cache", "agentglass", "source");
const LOG = join(tmpdir(), "agentglass-update.log");
const STAMP = join(homedir(), ".cache", "agentglass", "last-update.json");

function git(cwd: string, args: string[], timeout = 30_000) {
  return spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", timeout });
}

export function buildInfo(): BuildInfo {
  const beside = join(dirname(process.execPath), "build-info.json");
  for (const p of [beside, resolve(process.cwd(), "electron/staging/build-info.json")]) {
    try {
      if (!existsSync(p)) continue;
      const j = JSON.parse(readFileSync(p, "utf8"));
      if (j && typeof j.commit === "string") return {
        version: String(j.version ?? "0.0.0"),
        commit: String(j.commit),
        builtAt: String(j.builtAt ?? ""),
        source: String(j.source ?? ""),
        origin: String(j.origin ?? ""),
        baseTag: String(j.baseTag ?? ""),
        distance: Number(j.distance ?? 0),
      };
    } catch { /* unreadable or malformed — fall through to the dev case */ }
  }
  const cwd = process.cwd();
  const head = git(cwd, ["rev-parse", "HEAD"]).stdout?.trim() ?? "";
  const origin = git(cwd, ["remote", "get-url", "origin"]).stdout?.trim() ?? "";
  return { version: "dev", commit: head, builtAt: "", source: head ? cwd : "", origin, baseTag: "", distance: 0 };
}

function readStamp(): UpdateStatus["last"] {
  try {
    const j = JSON.parse(readFileSync(STAMP, "utf8"));
    if (j && typeof j.at === "string") return { at: j.at, ok: !!j.ok, tail: String(j.tail ?? "") };
  } catch { /* never run, or cleared */ }
  return undefined;
}

/** Compared as numbers, so v0.10.0 beats v0.9.0 — lexical order has that
 *  backwards and would offer a downgrade as an update. */
export function cmpTag(a: string, b: string): number {
  const pa = a.replace(/^v/, "").split(".").map(Number);
  const pb = b.replace(/^v/, "").split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
}

/**
 * Release tags on the remote, newest first.
 *
 * `ls-remote` rather than a fetch: checking for an update must not need a clone
 * on disk and must not touch anything, so it stays safe to call whenever the
 * About pane is opened.
 */
export function remoteTags(originUrl: string): string[] {
  if (!originUrl) return [];
  const r = spawnSync("git", ["ls-remote", "--tags", "--refs", originUrl], {
    encoding: "utf8", timeout: 45_000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "", SSH_ASKPASS_REQUIRE: "never" },
  });
  if (r.status !== 0) return [];
  return (r.stdout ?? "").split("\n")
    .map((l) => l.split("refs/tags/")[1]?.trim() ?? "")
    .filter((t) => TAG_RE.test(t))
    .sort((a, b) => cmpTag(b, a));
}

export function updateStatus(): UpdateStatus {
  const info = buildInfo();
  const base: UpdateStatus = {
    ok: true, available: false, info, branch: "", behind: 0, ahead: 0, incoming: [], last: readStamp(),
  };
  if (!info.origin) {
    return { ...base, blocked: "this build records no origin — reinstall from source once to enable updates" };
  }

  const tags = remoteTags(info.origin);
  if (!tags.length) {
    return { ...base, available: true, blocked: "no releases published yet — tag one with `git tag v0.3.0 && git push --tags`" };
  }

  const latest = tags[0]!;
  const out: UpdateStatus = { ...base, available: true, branch: latest };

  // What this build already contains, straight from git rather than from a
  // version field. Bumping package.json at release time is a convention, and a
  // convention someone forgets is not something an installer may rely on: with
  // 0.2.0 written at both v0.2.1 and 48 commits past it, comparing versions
  // offered the tag as an upgrade when it was in fact a 48-commit downgrade.
  const current = info.baseTag || (TAG_RE.test(`v${info.version}`) ? `v${info.version}` : "");
  if (!current) return out; // provenance too old to judge — never offer a move

  // Equal means this build is at that release or somewhere past it. Either way
  // there is nothing published that it does not already have.
  if (cmpTag(latest, current) <= 0) return out;

  const newer = tags.filter((t) => cmpTag(t, current) > 0);
  out.behind = newer.length;
  out.incoming = newer.map((t) => ({ sha: t, subject: "" }));
  return out;
}

let running = false;

export function startUpdate(): { ok: boolean; error?: string; log?: string } {
  if (running) return { ok: false, error: "an update is already running" };
  const st = updateStatus();
  if (st.blocked) return { ok: false, error: st.blocked };
  if (!st.available || st.behind === 0) return { ok: false, error: "already on the newest release" };

  // Shipped inside the installed app rather than read from the developer's
  // checkout: that checkout may be elsewhere, or gone, and this must not depend
  // on it existing.
  const packaged = join(dirname(process.execPath), "self-update.sh");
  const dev = resolve(process.cwd(), "electron/self-update.sh");
  const script = existsSync(packaged) ? packaged : existsSync(dev) ? dev : "";
  if (!script) return { ok: false, error: "this build has no update script" };

  try { mkdirSync(dirname(STAMP), { recursive: true }); } catch { /* non-fatal */ }
  try { writeFileSync(LOG, `updating to ${st.branch} from ${st.info.origin}\n`); } catch { /* non-fatal */ }

  running = true;
  const child = spawn("bash", [script], {
    // Started from home, not from any repository: this must not inherit a
    // working directory that git could mistake for the thing to update.
    cwd: homedir(),
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      AGENTGLASS_UPDATE_LOG: LOG,
      AGENTGLASS_UPDATE_STAMP: STAMP,
      AGENTGLASS_UPDATE_TAG: st.branch,
      AGENTGLASS_UPDATE_ORIGIN: st.info.origin,
      AGENTGLASS_UPDATE_SRC: SRC,
    },
  });
  child.unref();
  return { ok: true, log: LOG };
}

export function updateLog(): { ok: boolean; text: string } {
  try { return { ok: true, text: readFileSync(LOG, "utf8").slice(-8000) }; }
  catch { return { ok: true, text: "" }; }
}
