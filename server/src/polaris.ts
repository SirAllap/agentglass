/*
 * Polaris on the server: a verdict for each open pull request from data the board
 * already has, and the one function that may act.
 *
 * `executeAction` is the only way this module reaches outside the app or types into a
 * session. It refuses anything outside ACTION_TYPES, forces a dry run when the door says
 * dry, and writes every outcome to the actions audit log. There is no code path here for
 * a merge, a comment, a label, a review or a card move; a source test checks that.
 */
import { basename } from "node:path";
import { canRelaunch, classifyPr, droppedJob, type BaseRed, type ItemsAnswer, type PolarisCheck, type PolarisItem, type PolarisJob, type PrFacts, type RunRef } from "../../shared/polaris.ts";
export type { ItemsAnswer, PolarisItem, RunRef };
import { withDoor, type DoorValue } from "../../shared/polaris.ts";
import type { PrCheckRollup, PrSummary } from "../../shared/types.ts";
import { polarisRoots, readPolaris, readStoredPolaris, writePolaris } from "./config.ts";
import { recordAction } from "./db.ts";
import { __requiredCaches, fastForwardLocal, gh, listPrs, localHead, prBranches, prRollup, repoIdFor } from "./prs.ts";
import { listAgents, promptAgent, screenOf, stateOfScreen } from "./agentops.ts";

export const ACTION_TYPES = ["relaunch", "beacon-draft", "beacon-edit", "beacon-discard", "beacon-send-on-click", "dock", "ignore", "propose", "sync"] as const;
export type ActionType = (typeof ACTION_TYPES)[number];

export interface ActionArgs {
  root: string;
  number: number;
  /** The reason the action answers, so a draft is written once per reason. */
  reason?: string;
  run?: RunRef;
  text?: string;
  /** The session the person picked to receive a beacon. */
  paneId?: string;
  door?: "course" | "cleanup";
  /** For a sync: the head the person saw, and the base commit that fixed the red. */
  headSha?: string;
  baseSha?: string;
}
export interface ActionResult { ok: boolean; outcome?: "done" | "skipped-in-dry-run"; error?: string; note?: string }
/** One base branch's checks at a commit or at its tip, as the sweep reads them. */
export interface BaseChecks { sha: string; checks: { name: string; state: "success" | "failure" | "pending"; url?: string }[] }

/** Everything outside the app, behind one seam so a test can watch it. */
export interface PolarisIo {
  /** Ask GitHub Actions to run one job again. The only write to GitHub in this file. */
  rerunJob(root: string, jobId: number): Promise<{ ok: boolean; error?: string }>;
  readJobs(root: string, runId: number): Promise<(PolarisJob & { id: number; name: string; attempt: number })[] | null>;
  /** The pane of the one live session working on this pull request's branch, or null when there is none or more than one. */
  sessionFor?(root: string, number: number): Promise<string | null>;
  /** The named checks of a pull request whose list row says some are red: the list only counts them. Read only. */
  checksFor?(root: string, number: number): Promise<PrCheckRollup | null>;
  /** The base commit a run tested: the first parent of its merge commit. Null when the run's commit is not a merge commit. Read only. */
  testedBase?(root: string, runId: number): Promise<string | null>;
  /** The check runs at a commit, or at the tip of a branch. Read only. */
  baseChecks?(root: string, ref: string): Promise<BaseChecks | null>;
  /** Merge the base into the pull request's branch on GitHub. The second write to GitHub in this file, and only a click reaches it. */
  updateBranch?(root: string, number: number, expectedHeadSha: string): Promise<{ ok: boolean; status?: number; error?: string }>;
  /** After a sync, bring this machine's copy of the branch up to date, but only by a fast-forward of a clean one. Local git, no network write. */
  localAfter?(root: string, number: number): Promise<{ state: "absent" | "fast-forwarded" | "dirty" | "diverged" | "busy"; branch: string }>;
}

/** Match by branch: a session the board sees on the pull request's head. Two on one branch is no match, so the person picks. */
export async function sessionFor(root: string, number: number): Promise<string | null> {
  const b = await prBranches(root, number);
  if (!b) return null;
  const hits = (await listAgents()).filter((x) => x.endedAt === null && x.branch === b.head);
  return hits.length === 1 ? hits[0]!.paneId : null;
}

export async function rerunJob(root: string, jobId: number): Promise<{ ok: boolean; error?: string }> {
  const repo = await repoIdFor(root);
  if (!repo) return { ok: false, error: "no GitHub remote on this repository" };
  const r = await gh(["run", "rerun", "--job", String(jobId), "-R", repo.nameWithOwner], root);
  return r.code === 0 ? { ok: true } : { ok: false, error: r.stderr.trim().slice(0, 200) || "gh run rerun failed" };
}

export async function updateBranch(root: string, number: number, expectedHeadSha: string): Promise<{ ok: boolean; status?: number; error?: string }> {
  const repo = await repoIdFor(root);
  if (!repo) return { ok: false, error: "no GitHub remote on this repository" };
  const r = await gh(["api", "-X", "PUT", `repos/${repo.nameWithOwner}/pulls/${number}/update-branch`, "-f", `expected_head_sha=${expectedHeadSha}`], root);
  if (r.code === 0) return { ok: true };
  const status = Number(/HTTP (\d{3})/.exec(`${r.stderr}\n${r.stdout}`)?.[1]) || undefined;
  return { ok: false, ...(status ? { status } : {}), error: r.stderr.trim().slice(0, 200) || "update-branch failed" };
}

export async function localAfter(root: string, number: number): Promise<{ state: "absent" | "fast-forwarded" | "dirty" | "diverged" | "busy"; branch: string }> {
  const b = await prBranches(root, number);
  if (!b) return { state: "absent", branch: "" };
  const st = await localHead(root, b.head);
  if (st.sync === "absent" || st.sync === "busy" || st.sync === "diverged" || st.sync === "dirty") return { state: st.sync, branch: b.head };
  await fastForwardLocal(root, st);
  return { state: "fast-forwarded", branch: b.head };
}

async function testedBase(root: string, runId: number): Promise<string | null> {
  const repo = await repoIdFor(root);
  if (!repo) return null;
  const run = await gh(["api", `repos/${repo.nameWithOwner}/actions/runs/${runId}`, "--jq", ".head_sha"], root);
  const sha = run.stdout.trim();
  if (run.code !== 0 || !/^[0-9a-f]{40}$/.test(sha)) return null;
  const c = await gh(["api", `repos/${repo.nameWithOwner}/commits/${sha}`, "--jq", "[.parents[].sha]"], root);
  if (c.code !== 0) return null;
  try {
    const parents = JSON.parse(c.stdout) as string[];
    // A merge commit has two parents and the first is the base. Anything else says nothing about the base.
    return parents.length === 2 ? parents[0]! : null;
  } catch { return null; }
}

async function baseChecks(root: string, ref: string): Promise<BaseChecks | null> {
  const repo = await repoIdFor(root);
  if (!repo) return null;
  const r = await gh(["api", `repos/${repo.nameWithOwner}/commits/${encodeURIComponent(ref)}/check-runs?per_page=100`], root);
  if (r.code !== 0) return null;
  try {
    const j = JSON.parse(r.stdout) as { check_runs?: { name: string; status: string; conclusion: string | null; head_sha: string; html_url?: string }[] };
    const runs = j.check_runs ?? [];
    const sha = runs[0]?.head_sha;
    if (!sha) return null;
    return { sha, checks: runs.map((c) => ({ name: c.name, state: c.status !== "completed" ? "pending" : c.conclusion === "success" || c.conclusion === "skipped" || c.conclusion === "neutral" ? "success" : "failure", ...(c.html_url ? { url: c.html_url } : {}) })) };
  } catch { return null; }
}

async function readJobs(root: string, runId: number) {
  const repo = await repoIdFor(root);
  if (!repo) return null;
  const r = await gh(["api", `repos/${repo.nameWithOwner}/actions/runs/${runId}/jobs?per_page=100`], root);
  if (r.code !== 0) return null;
  try {
    const jobs = (JSON.parse(r.stdout) as { jobs?: { id: number; name: string; conclusion: string | null; run_attempt: number; steps?: { conclusion: string | null }[] }[] }).jobs ?? [];
    return jobs.map((j) => ({ id: j.id, name: j.name, attempt: j.run_attempt, conclusion: j.conclusion, stepConclusions: (j.steps ?? []).map((s) => s.conclusion) }));
  } catch { return null; }
}
/** One read of a pull request's checks by name (the board's own, kept for 30 s), only for rows the list says are red. */
async function checksFor(root: string, number: number): Promise<PrCheckRollup | null> {
  const r = await prRollup(root, number);
  return r.ok && r.checks ? r.checks : null;
}
const liveIo: PolarisIo = { rerunJob, readJobs, sessionFor, checksFor, testedBase, baseChecks, updateBranch, localAfter };

/** Drafts and the things said no to, kept in memory: a restart drops them, the safe way to lose one. */
const drafts = new Map<string, string>();
const sent = new Set<string>();
const ignored = new Set<string>();
/** A sync that came back 422 for this head: the branch conflicts with the base, so the person decides. A new head clears it. */
const syncConflict = new Set<string>();
/** One sync per pull request per base fix. */
const synced = new Set<string>();
/** A draft the person threw away: the same reason does not draft it again. */
const discarded = new Set<string>();
const proposals = new Map<string, string>();
const key = (a: ActionArgs) => `${a.root}\0${a.number}\0${a.reason ?? ""}`;
export const __draftOf = (root: string, number: number, reason: string): string | undefined => drafts.get(key({ root, number, reason }));
export const __syncConflicted = (root: string, number: number, headSha: string): boolean => syncConflict.has(`${root}\0${number}\0${headSha}`);
export const __resetPolaris = (): void => { drafts.clear(); sent.clear(); ignored.clear(); discarded.clear(); proposals.clear(); syncConflict.clear(); synced.clear(); signalled.clear(); testedCache.clear(); settledBase.clear(); baseSink = null; jobCache.clear(); tried.clear(); lastSweep.clear(); };

const refuse = (error: string): ActionResult => ({ ok: false, error });

/** Every outside effect of Polaris goes through here, and every outcome is logged. */
export async function executeAction(type: string, a: ActionArgs, io: PolarisIo = liveIo): Promise<ActionResult> {
  const res = await run(type, a, io);
  recordAction({
    actor: "polaris", action: `/polaris/${type}`, target: `${basename(a.root)} #${a.number}`, ok: res.ok,
    detail: res.outcome === "skipped-in-dry-run" ? "skipped-in-dry-run" : res.error ?? res.note ?? null,
  });
  return res;
}

async function run(type: string, a: ActionArgs, io: PolarisIo): Promise<ActionResult> {
  if (!(ACTION_TYPES as readonly string[]).includes(type)) return refuse(`${type} is not something Polaris does`);
  const { settings } = readPolaris(a.root);
  if (!settings.enabled) return refuse("Polaris is off for this project");
  const mode = (door: keyof typeof settings.doors) => settings.doors[door].mode;
  switch (type as ActionType) {
    case "relaunch": {
      if (mode("relaunch") === "off") return refuse("the relaunch door is off");
      if (!a.run) return refuse("relaunch: a run and its job are needed");
      if (!droppedJob(a.run.job)) return refuse("only a job the runner dropped is run again");
      if (!canRelaunch(a.run, Number(settings.doors.relaunch.cap))) return refuse("the cap is reached, or a check is still running");
      if (mode("relaunch") === "dry") return { ok: true, outcome: "skipped-in-dry-run" };
      const r = await io.rerunJob(a.root, a.run.job.id);
      return r.ok ? { ok: true, outcome: "done" } : refuse(r.error ?? "could not run the job again");
    }
    case "sync": {
      // A click only (the route asks for the person). The relaunch door is the switch for what Polaris writes to GitHub:
      // a dry run says what it would do, and a sync is not live until the person makes that door live.
      if (mode("relaunch") === "off") return refuse("the relaunch door is off, and a sync follows it");
      if (!a.headSha || !/^[0-9a-f]{40}$/.test(a.headSha)) return refuse("sync: the head commit the person saw is needed");
      const sk = `${a.root}\0${a.number}\0${a.baseSha ?? ""}`;
      if (synced.has(sk)) return refuse("this pull request was already synced for this base fix");
      if (mode("relaunch") === "dry") return { ok: true, outcome: "skipped-in-dry-run" };
      if (!io.updateBranch) return refuse("sync is not available here");
      const r = await io.updateBranch(a.root, a.number, a.headSha);
      if (r.ok) {
        synced.add(sk);
        // This machine's copy: a clean one is fast-forwarded, any other is left alone and its session gets a draft to send.
        const local = await io.localAfter?.(a.root, a.number);
        if (local && local.state !== "absent" && local.state !== "fast-forwarded") {
          drafts.set(key({ ...a, reason: "synced" }), `Your branch ${local.branch} was synced with its base branch on GitHub. Pull before you push.`);
        }
        return { ok: true, outcome: "done", note: `synced from ${a.headSha.slice(0, 7)} with base ${(a.baseSha ?? "").slice(0, 7)}, clicked${local ? `, local ${local.state}` : ""}` };
      }
      if (r.status === 422) {
        syncConflict.add(`${a.root}\0${a.number}\0${a.headSha}`);
        return refuse("conflict with base");
      }
      return refuse(r.error ?? "could not sync the branch");
    }
    case "beacon-draft": {
      if (mode("beacon") === "off") return refuse("the beacon door is off");
      if (!a.text?.trim()) return refuse("beacon-draft: a text is needed");
      if (drafts.has(key(a)) || sent.has(key(a)) || discarded.has(key(a))) return refuse("a beacon for this reason was already written");
      drafts.set(key(a), a.text.slice(0, 2000));
      return { ok: true, outcome: "done" };
    }
    case "beacon-send-on-click": {
      // Called by the person's click only. Typed into an idle session, once per reason.
      if (mode("beacon") === "off") return refuse("the beacon door is off");
      const text = drafts.get(key(a));
      if (!text) return refuse("there is no draft for this reason");
      // The person's pick wins; the match door only fills in when nothing was picked.
      const pane = a.paneId ?? (mode("match") === "use" ? (await io.sessionFor?.(a.root, a.number)) ?? undefined : undefined);
      if (!pane) return refuse(mode("match") === "use" ? "no single session works on this branch: pick the session" : "beacon-send-on-click: pick the session");
      if (stateOfScreen(await screenOf(pane)) !== "ready") return refuse("that session is not idle");
      const out = await promptAgent(pane, text);
      if (out !== "sent") return refuse(`the session did not take it (${out})`);
      drafts.delete(key(a));
      sent.add(key(a));
      return { ok: true, outcome: "done" };
    }
    case "dock": {
      if (mode("dock") === "off") return refuse("the dock door is off");
      const dock = settings.doors.dock;
      const excluded = Array.isArray(dock.excluded) ? (dock.excluded as number[]) : [];
      if (excluded.includes(a.number)) return { ok: true, outcome: "done" };
      const w = writePolaris(a.root, withDoor(readStoredPolaris(a.root), "dock", { ...dock, excluded: [...excluded, a.number] } as DoorValue));
      return w.ok ? { ok: true, outcome: "done" } : refuse(w.error ?? "could not save it");
    }
    case "ignore":
      ignored.add(key(a));
      return { ok: true, outcome: "done" };
    // The person's two ways to change a draft. Both stay inside the app: nothing is typed anywhere until Send.
    case "beacon-edit": {
      if (!drafts.has(key(a))) return refuse("there is no draft for this reason");
      if (!a.text?.trim()) return refuse("beacon-edit: a text is needed");
      drafts.set(key(a), a.text.slice(0, 2000));
      return { ok: true, outcome: "done" };
    }
    case "beacon-discard": {
      if (!drafts.delete(key(a))) return refuse("there is no draft for this reason");
      discarded.add(key(a));
      return { ok: true, outcome: "done" };
    }
    case "propose": {
      if (a.door !== "course" && a.door !== "cleanup") return refuse("propose: course or cleanup");
      if (mode(a.door) === "off") return refuse(`the ${a.door} door is off`);
      proposals.set(`${key(a)}\0${a.door}`, (a.text ?? "").slice(0, 500));
      return { ok: true, outcome: "done" };
    }
  }
}

// ── the sweep ──

/** One read of a failed run's jobs per run and finish time: a red that stays red costs no more calls. */
const jobCache = new Map<string, Awaited<ReturnType<PolarisIo["readJobs"]>>>();
const runIdOf = (url?: string): number | null => { const m = /\/runs\/(\d+)/.exec(url ?? ""); return m ? Number(m[1]) : null; };

/** Immutable: the base commit a run tested. And the settled check runs of a commit, which do not change once nothing is pending. */
const testedCache = new Map<string, string | null>();
const settledBase = new Map<string, BaseChecks>();
type BaseReader = (ref: string) => Promise<BaseChecks | null>;
/** A reader that asks GitHub once per ref in one pass; a settled commit is also kept across passes. */
export function baseReader(root: string, io: PolarisIo): BaseReader {
  const pass = new Map<string, Promise<BaseChecks | null>>();
  return (ref) => {
    const hit = settledBase.get(`${root}\0${ref}`);
    if (hit) return Promise.resolve(hit);
    if (!pass.has(ref)) {
      pass.set(ref, (io.baseChecks?.(root, ref) ?? Promise.resolve(null)).then((b) => {
        if (b && /^[0-9a-f]{40}$/.test(ref) && !b.checks.some((c) => c.state === "pending")) settledBase.set(`${root}\0${ref}`, b);
        return b;
      }));
    }
    return pass.get(ref)!;
  };
}

/** Marks the red checks the base had at the commit the run tested. A job the runner dropped is never inherited. */
export async function markInherited(root: string, facts: PrFacts, io: PolarisIo, read: BaseReader): Promise<{ checks: string[]; baseSha: string } | undefined> {
  if (!io.testedBase) return undefined;
  const checks: string[] = [];
  let baseSha = "";
  for (const fc of facts.checks) {
    if (fc.state !== "failure" || !fc.runId || (fc.job && droppedJob(fc.job))) continue;
    const ck = `${root}\0${fc.runId}`;
    if (!testedCache.has(ck)) testedCache.set(ck, await io.testedBase(root, fc.runId));
    const tested = testedCache.get(ck);
    if (!tested) continue;
    const base = await read(tested);
    if (!base?.checks.some((c) => c.name === fc.name && c.state === "failure")) continue;
    fc.inherited = true;
    checks.push(fc.name);
    baseSha ||= tested;
  }
  return checks.length ? { checks, baseSha } : undefined;
}

/** The list counts red checks without naming them: a row with a red count and no names has to be read once to be classed. */
export const needsNames = (p: PrSummary): boolean => (p.checks?.failure ?? 0) > 0 && !p.checks?.failing.length;

/** The facts of a row the list already has. Checks the list does not name are summarised, not invented. */
export function factsOf(p: PrSummary, doors: ReturnType<typeof readPolaris>["settings"]["doors"], requiredNames: string[] = []): PrFacts {
  const checks: PolarisCheck[] = (p.checks?.failing ?? []).map((c) => ({ name: c.name, state: "failure", ...(c.required !== undefined ? { required: c.required } : {}), runId: runIdOf(c.url) ?? undefined }));
  for (let i = 0; i < (p.checks?.pending ?? 0); i++) checks.push({ name: `running ${i + 1}`, state: "pending" });
  // Every red is marked optional and none is running: what GitHub requires then passed.
  if (checks.length && checks.every((c) => c.state === "failure" && c.required === false)) checks.push({ name: "required checks", state: "success", required: true });
  const human = p.humanReview?.kind === "approved" ? p.humanReview.who.length : 0;
  const approvals = Array.from({ length: human }, () => ({ isBot: false }));
  if (p.reviewDecision === "APPROVED" && human === 0) approvals.push({ isBot: true });
  const dockOn = doors.dock.mode === "on";
  return {
    state: p.state, draft: dockOn && p.isDraft, labels: p.labels.map((l) => l.name),
    excluded: dockOn && Array.isArray(doors.dock.excluded) && (doors.dock.excluded as number[]).includes(p.number),
    base: p.baseRefName,
    mergeable: p.checksLoaded === false ? "UNKNOWN" : p.mergeable,
    reviewDecision: p.reviewDecision, approvals, checks, requiredNames, changedFiles: [],
    labelRules: doors.labels.mode === "on" && Array.isArray(doors.labels.rules) ? (doors.labels.rules as never[]) : [],
  };
}

/** The bases some pull requests inherit a red from, each with the tip read once however many inherit. Sets canSync on the items. */
export async function basesOf(items: PolarisItem[], baseOf: Map<number, string>, pending: Map<number, number>, read: BaseReader): Promise<BaseRed[]> {
  const bases: BaseRed[] = [];
  for (const base of new Set(items.filter((i) => i.inherited).map((i) => baseOf.get(i.number)!))) {
    const mine = items.filter((i) => i.inherited && baseOf.get(i.number) === base);
    const checks = [...new Set(mine.flatMap((i) => i.inherited!.checks))];
    const sinceSha = mine[0]!.inherited!.baseSha;
    const tip = await read(base);
    const fixed = !!tip && tip.sha !== sinceSha && checks.every((n) => tip.checks.find((c) => c.name === n)?.state === "success");
    for (const i of mine) i.canSync = fixed && pending.get(i.number) === 0;
    const url = tip?.checks.find((c) => checks.includes(c.name) && c.url)?.url;
    bases.push({ base, checks, sinceSha, tipSha: tip?.sha ?? sinceSha, fixed, inheritors: mine.map((i) => i.number), canSync: mine.filter((i) => i.canSync).map((i) => i.number), ...(url ? { url } : {}) });
  }
  return bases;
}

/** A verdict for each open pull request, from the board's own list. gh missing or signed out reads as Uncharted, with the reason. */
export async function polarisItems(root: string, io: PolarisIo = liveIo): Promise<ItemsAnswer> {
  const { settings } = readPolaris(root);
  if (!settings.enabled || settings.doors.follow.mode === "off") return { ok: true, enabled: settings.enabled, items: [] };
  let list = await listPrs(root, "all", "open");
  // A cold cache answers "no rows" while the first read is still in flight, which the section drew as "No open pull requests".
  // shortcut: waits at most 8 s for that first read, then answers with what it has; a slower one fills in on the next re-read.
  for (let waited = 0; list.loading && !list.prs.length && !list.fetchedAt && waited < 8000; waited += 400) {
    await new Promise((r) => setTimeout(r, 400));
    list = await listPrs(root, "all", "open");
  }
  if (!list.repo || list.needsAuth) return { ok: true, enabled: true, items: [], uncharted: list.error ?? "GitHub is not reachable from here" };
  const d = settings.doors;
  const repo = await repoIdFor(root);
  const items: PolarisItem[] = [];
  const readBase = baseReader(root, io);
  const pending = new Map<number, number>();
  for (const row of list.prs) {
    // The list counts red checks but does not name them; a red one is named by one read of that pull request.
    const named = needsNames(row) ? await io.checksFor?.(root, row.number) : null;
    const p = named ? { ...row, checks: named } : row;
    // What the base requires, when the board has already asked: never a request of its own.
    const required = repo ? __requiredCaches.ctx.get(`${repo.key}\u0000${p.baseRefName}`)?.ctx ?? [] : [];
    const facts = factsOf(p, d, required);
    const dropped: RunRef[] = [];
    if (d.relaunch.mode !== "off") {
      for (const c of p.checks?.failing ?? []) {
        const runId = runIdOf(c.url);
        if (!runId) continue;
        const k = `${runId}:${c.completedAt ?? ""}`;
        if (!jobCache.has(k)) jobCache.set(k, await io.readJobs(root, runId));
        const job = jobCache.get(k)?.find((j) => j.name === c.name);
        const fc = facts.checks.find((x) => x.name === c.name);
        if (!job || !fc) continue;
        fc.job = job; fc.runAttempt = job.attempt;
        if (droppedJob(job)) dropped.push({ runId, attempt: job.attempt, pending: (p.checks?.pending ?? 0) > 0, job });
      }
    }
    const inherited = await markInherited(root, facts, io, readBase);
    let v = classifyPr(facts, { approvals: d.approvals.mode === "any" ? "any" : "people", redsNamed: d.redsNamed.mode === "name" ? "name" : "block", dockLabel: d.dock.mode === "on" ? String(d.dock.label) : "" });
    // A sync that hit a conflict on this head is the person's to settle.
    if (v.reason === "inherited" && syncConflict.has(`${root}\0${p.number}\0${p.headSha ?? ""}`)) {
      v = { cls: "Needs you", reason: "conflict", sentence: "It conflicts with the base branch: syncing could not merge it." };
    }
    const k = `${root}\0${p.number}\0${v.reason ?? ""}`;
    pending.set(p.number, p.checks?.pending ?? 0);
    const proposed = (["course", "cleanup"] as const).filter((door) => proposals.has(`${k}\0${door}`));
    items.push({ ...v, number: p.number, title: p.title, url: p.url, author: p.author, head: p.headRefName, ignored: ignored.has(k), draft: drafts.get(k) ?? null, dropped, proposed,
      headSha: p.headSha ?? "", canSync: false, syncDraft: drafts.get(`${root}\0${p.number}\0synced`) ?? null, ...(v.reason === "inherited" && inherited ? { inherited } : {}) });
  }
  const bases = await basesOf(items, new Map(list.prs.map((p) => [p.number, p.baseRefName])), pending, readBase);
  return { ok: true, enabled: true, items, ...(bases.length ? { bases } : {}) };
}

const signalled = new Set<string>();
export interface BaseFixed { root: string; base: string; tipSha: string; checks: string[]; canSync: number[] }
let baseSink: ((s: BaseFixed) => void) | null = null;
/** Where the signal for a fixed base goes (the server tells the windows and the orchestrator). */
export const onBaseFixed = (fn: ((s: BaseFixed) => void) | null): void => { baseSink = fn; };

/** At most one relaunch per run attempt, and no sooner than lookAgain.minutes after the last pass on a project. */
const tried = new Set<string>();
const lastSweep = new Map<string, number>();
export async function sweep(root: string, io: PolarisIo = liveIo, now = Date.now(), load: typeof polarisItems = polarisItems): Promise<number> {
  const { settings } = readPolaris(root);
  const gap = Number(settings.doors.lookAgain.minutes) * 60_000;
  if (!settings.enabled || settings.doors.lookAgain.mode === "off" || now - (lastSweep.get(root) ?? 0) < gap) return 0;
  lastSweep.set(root, now);
  const steps = Number(settings.doors.lookAgain.steps);
  let acted = 0;
  const { items, bases } = await load(root, io);
  // One signal per base fix, whatever the number of pull requests or passes.
  if (settings.doors.signals.mode === "on") {
    for (const b of bases ?? []) {
      const sk = `${root}\0${b.base}\0${b.tipSha}`;
      if (!b.fixed || signalled.has(sk)) continue;
      signalled.add(sk);
      baseSink?.({ root, base: b.base, tipSha: b.tipSha, checks: b.checks, canSync: b.canSync });
    }
  }
  for (const it of items) {
    if (it.reason !== "runner") continue;
    for (const r of it.dropped) {
      // steps: the most a pass does; what is left waits for the next pass, untried.
      if (acted >= steps) return acted;
      const k = `${root}\0${r.runId}\0${r.attempt}`;
      if (tried.has(k)) continue;
      tried.add(k);
      if ((await executeAction("relaunch", { root, number: it.number, run: r }, io)).ok) acted++;
    }
  }
  return acted;
}

/** A pull request event on a repository: sweep each project of it. The gap inside sweep drops the ones that come too soon. */
export async function wakeForRepo(
  nameWithOwner: string,
  d: { roots: () => string[]; repoOf: (root: string) => Promise<{ nameWithOwner: string } | null>; sweep: (root: string) => Promise<number> } = { roots: polarisRoots, repoOf: repoIdFor, sweep: (r) => sweep(r) },
): Promise<number> {
  let acted = 0;
  for (const root of d.roots()) if ((await d.repoOf(root))?.nameWithOwner === nameWithOwner) acted += await d.sweep(root);
  return acted;
}

/** The timer behind the events: a pass per project at most every lookAgain.minutes, and the shortest minutes is 5, so this wakes every 5. */
export function startPolaris(): void {
  setInterval(() => { for (const r of polarisRoots()) void sweep(r).catch(() => {}); }, 5 * 60_000).unref();
}
