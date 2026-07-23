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
// Overridable by the same env var the update script already reads, so a test
// can point the clone at a fixture instead of writing into the developer's
// real one — the mistake #144 fixed for the database.
const SRC = process.env.AGENTGLASS_UPDATE_SRC || join(homedir(), ".cache", "agentglass", "source");
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
/**
 * Published releases, from the remote, cached.
 *
 * This is a network round trip — `git ls-remote` against GitHub — and it ran
 * synchronously on the server's only thread, on an endpoint the UI polls. The
 * loop watchdog caught it at 492ms; the timeout below says it is allowed to
 * take forty-five seconds, and every one of those would be a terminal that had
 * stopped echoing. A tag list changes when someone cuts a release, so ten
 * minutes of staleness costs nothing and a failure is held briefly too — an
 * offline laptop must not re-dial the network on every poll.
 */
const TAGS_TTL_MS = 10 * 60_000;
const TAGS_FAIL_TTL_MS = 60_000;
let tagCache: { at: number; url: string; tags: string[] | null } | null = null;

export async function remoteTags(originUrl: string): Promise<string[] | null> {
  if (!originUrl) return [];
  const hit = tagCache;
  if (hit && hit.url === originUrl) {
    // A short TTL for both a fetch failure (null) and a reachable-but-tagless
    // remote ([]), so neither sticks: the connection or the first release could
    // arrive any moment. A real tag list is cached for longer.
    const ttl = hit.tags?.length ? TAGS_TTL_MS : TAGS_FAIL_TTL_MS;
    if (Date.now() - hit.at < ttl) return hit.tags;
  }
  const tags = await readRemoteTags(originUrl);
  tagCache = { at: Date.now(), url: originUrl, tags };
  return tags;
}

async function readRemoteTags(originUrl: string): Promise<string[] | null> {
  // Awaited: a network round trip on the thread that carries the terminal was
  // 469ms of the app's startup, and the timeout below allows forty-five
  // seconds of it on a bad connection.
  const proc = Bun.spawn(["git", "ls-remote", "--tags", "--refs", originUrl], {
    stdout: "pipe", stderr: "ignore", timeout: 45_000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "", SSH_ASKPASS_REQUIRE: "never" },
  });
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  // null, not []: a non-zero exit is a fetch failure (offline, auth, a bad
  // origin), which is a different thing from a reachable remote that simply has
  // no tags yet. Collapsing both to [] made updateStatus tell an offline user to
  // go push a tag — advice for a problem they do not have.
  if (code !== 0) return null;
  return (out ?? "").split("\n")
    .map((l) => l.split("refs/tags/")[1]?.trim() ?? "")
    .filter((t) => TAG_RE.test(t))
    .sort((a, b) => cmpTag(b, a));
}

export async function updateStatus(): Promise<UpdateStatus> {
  const info = buildInfo();
  const base: UpdateStatus = {
    ok: true, available: false, info, branch: "", behind: 0, ahead: 0, incoming: [], last: readStamp(),
  };
  if (!info.origin) {
    return { ...base, blocked: "this build records no origin — reinstall from source once to enable updates" };
  }

  const tags = await remoteTags(info.origin);
  if (tags === null) {
    // A fetch failure, not an empty remote: don't claim an update is available
    // and don't send them to publish a tag they may already have.
    return { ...base, available: false, blocked: "couldn't reach the remote to check for releases — check your connection and try again" };
  }
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

export async function startUpdate(): Promise<{ ok: boolean; error?: string; log?: string }> {
  if (running) return { ok: false, error: "an update is already running" };
  const st = await updateStatus();
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
  // The lock stops a second update racing the first. But the script is detached
  // and can fail — a compile error, a dropped network, a bad tag — without ever
  // replacing this process, and then `running` stayed true for the life of the
  // session and the update button was dead with nothing behind it. Clear it
  // whenever the child ends (on success the script has already relaunched us, so
  // this only matters when it didn't) or fails to start, with a timeout as a
  // backstop for the double-fork case where no exit event ever reaches us.
  const clearLock = () => { running = false; };
  // bun-types' node:child_process ChildProcess omits the EventEmitter surface,
  // but the runtime object has it (Bun emits 'exit'/'error' like Node) — reach
  // the listeners through a narrow cast rather than drop the recovery.
  const ev = child as unknown as { once(event: string, cb: () => void): void };
  ev.once("exit", clearLock);
  ev.once("error", clearLock);
  const backstop = setTimeout(clearLock, 15 * 60_000);
  backstop.unref?.();
  child.unref();
  return { ok: true, log: LOG };
}

export function updateLog(): { ok: boolean; text: string } {
  try { return { ok: true, text: readFileSync(LOG, "utf8").slice(-8000) }; }
  catch { return { ok: true, text: "" }; }
}

/**
 * The notes for a release, so the app can say what changed after it updates
 * itself.
 *
 * Two sources, in the order that keeps working when the network does not.
 *
 * The update clone under ~/.cache already has every tag, and the annotation IS
 * the release notes (release.yml creates the GitHub release from it), so a
 * machine that has updated once can answer this with no network at all. A
 * machine installed from a downloaded binary has no clone, and falls back to
 * the releases API.
 *
 * Cached for an hour: notes for a published tag do not change, and the only
 * caller is a modal that opens once per version.
 */
const notesCache = new Map<string, { at: number; notes: string; source: string }>();
const NOTES_TTL_MS = 60 * 60_000;

export async function releaseNotes(tagIn?: string): Promise<{ ok: boolean; tag: string; notes: string; source: string; error?: string }> {
  const tag = tagIn && TAG_RE.test(tagIn) ? tagIn : buildInfo().baseTag;
  if (!tag || !TAG_RE.test(tag)) return { ok: false, tag: "", notes: "", source: "", error: "this build descends from no release" };

  const hit = notesCache.get(tag);
  if (hit && Date.now() - hit.at < NOTES_TTL_MS) return { ok: true, tag, notes: hit.notes, source: hit.source };

  const keep = (notes: string, source: string) => {
    if (notesCache.size > 20) notesCache.clear();
    notesCache.set(tag, { at: Date.now(), notes, source });
    return { ok: true, tag, notes, source };
  };

  // The tag object may be there without its annotation if the clone fetched it
  // shallowly, hence the emptiness check rather than trusting exit status.
  //
  // `%(objecttype)` first, because a LIGHTWEIGHT tag has no annotation and
  // `%(contents)` silently answers with the *commit message* instead. It never
  // returns empty, so the check above cannot catch it and the fallback below
  // never runs. That is not hypothetical: v0.3.0 and v0.1.0 are lightweight —
  // publishing a release from the GitHub UI creates the tag that way — and this
  // function reported v0.3.0's release notes as "Merge pull request #123 from
  // SirAllap/docs/refresh-assets-and-docs", while the real, hand-written notes
  // sat on the release the fallback would have fetched.
  if (existsSync(join(SRC, ".git"))) {
    const r = git(SRC, ["for-each-ref", "--format=%(objecttype)%0a%(contents)", `refs/tags/${tag}`]);
    const [kind, ...rest] = (r.status === 0 ? r.stdout : "").split("\n");
    const local = kind?.trim() === "tag" ? rest.join("\n").trim() : "";
    if (local) return keep(local, "clone");
  }

  const repo = /github\.com[:/]+([^/]+)\/(.+?)(?:\.git)?$/.exec(buildInfo().origin);
  if (!repo) return { ok: false, tag, notes: "", source: "", error: "no release notes available offline for this origin" };
  try {
    const res = await fetch(`https://api.github.com/repos/${repo[1]}/${repo[2]}/releases/tags/${tag}`, {
      headers: { accept: "application/vnd.github+json", "user-agent": "agentglass" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return { ok: false, tag, notes: "", source: "", error: `github answered ${res.status}` };
    const body = String(((await res.json()) as { body?: unknown }).body ?? "").trim();
    return body ? keep(body, "github") : { ok: false, tag, notes: "", source: "", error: "that release has no notes" };
  } catch {
    return { ok: false, tag, notes: "", source: "", error: "could not reach github for the notes" };
  }
}
