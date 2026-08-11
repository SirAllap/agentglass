// FIRST, and it must stay first: `agentglass-server cookies …` is answered
// here, before the imports below open the database and start their timers.
import "./cookieentry.ts";
import type { ServerWebSocket } from "bun";
import type { IngestBody, WsFrame, WorkingTree, PanesResponse } from "../../shared/types.ts";
import { normalize, detectError, clampIngestTimestamp, externalIngestError } from "./ingest.ts";
import { db } from "./db.ts";
import {
  insertEvent,
  getRecent,
  openToolCalls,
  getFilterOptions,
  getSessions,
  statsSummary,
  exportRows,
  pruneOldRows,
  RETENTION_DAYS,
  dbPath,
  getChanges,
  getSession,
  searchEvents,
  ftsText,
  providerOf,
  gateHistory,
  dailyUsage,
  costedModels,
  rollupEarliestDay,
  retentionSeamDay,
  getGate,
  actionLog,
  claimDatabase,
  releaseDatabaseClaim,
} from "./db.ts";
import { maybeAlert, setAlertSink } from "./alerts.ts";
import { noteAction, actorOf } from "./actions.ts";
import { getSkills, catalogMarkdown, catalogCsv, usageSince } from "./skills.ts";
import { getInsights } from "./insights.ts";
import { getUsage, ingestStatusline } from "./usage.ts";
import { allProviderUsage } from "./providerusage.ts";
import { refreshCodexUsage } from "./codexusage.ts";
import { submitGate, decideGate, pendingGates, awaitGate, restoreGates, typedReason, GATE_MAX_MS } from "./gate.ts";
import { parseControlCmd } from "./control.ts";
import { askBrowser, browserReadyCount, noteBrowserReady, parseAsk, setBrowserSink, settleBrowser, type BrowserOp } from "./browserdrive.ts";
import { browserUseStatus, installSkill } from "./browseruse.ts";
import { otlpTracesToEvents, otlpLogsToEvents } from "./otlp.ts";
import { decodeOtlpTraces, decodeOtlpLogs } from "./otlp_pb.ts";
import { statusForPaths, commit as gitCommit, COMMIT_ENABLED, gitAsync, gitCapability, safeAbs as gitSafeAbs } from "./git.ts";
import { dependencyReport } from "./deps.ts";
import {
  workingTree, lastCommitChanges, discoverRepos, stage, unstage, stageAll, unstageAll, discard,
  commitStaged, push as gitPush, pull as gitPull, fetch as gitFetch,
  branches as gitBranches, checkout as gitCheckout, createBranch, deleteBranch,
  log as gitLog, commitDiff, stashList, stashPush, stashApply, stashPop, stashDrop,
  applyHunk, logGraph, mergeBranch, rebaseBranch, renameBranch, resetTo,
  worktreesWithState as gitWorktrees, addWorktree, removeWorktree, worktreeLeftovers, rescueLeftovers, fixWorktreeOwnership, startAutoFetch, syncFromBase, setBase, setGitChangeHook, setMergedVerdictHook, setPrBaseHook,
  conflicts as gitConflicts, resolveWith, conflictBlocks, conflictFile, resolveBlocks, mergeSession, reopenConflict, stoppedRefusal, conflictPreview, mergeAbort, mergeContinue, baseCandidates, undoMerge, mergeInfo,
  remotes as gitRemotes, remoteBranches as gitRemoteBranches, trackRemoteBranch, tags as gitTags, reflog as gitReflog,
  prepareConflictMerge,
} from "./gitwork.ts";
import { saveShot } from "./shots.ts";
import { allPlaces, forgetPlaces, placeCount, recordVisit, saveFrom } from "./placestore.ts";
import { recent as gitCommandLog } from "./gitlog.ts";
import { worktreeParent } from "./worktree.ts";
import { watchLoop, entered, stalls, backoff } from "./loopwatch.ts";
import { spawnPoolStats } from "./spawnpool.ts";
import { singleFlight, inflightCount } from "./singleflight.ts";
import { openInEditor, editorTarget, editorCapability, HAS_NVIM } from "./editor.ts";
import { syncTheme, snippetStatus, SNIPPETS, tmuxThemePath, repairTmuxTheme, currentTheme } from "./themesync.ts";
import { existsSync as fsExists, readFileSync as fsRead, writeFileSync as fsWrite } from "node:fs";
import { completePath, FS_BROWSE_ENABLED } from "./fsbrowse.ts";
import { listPorts, listResources, spaceFor, killPort } from "./machine.ts";
import { gitLocks, removeStaleLock } from "./gitlocks.ts";
import { procDetail, revealEnv } from "./procdetail.ts";
import {
  listIssues, issueDetail, issuePullRequests, startIssue, finishIssue, claimIssue, commentIssue, setIssueState, currentWork,
} from "./issues.ts";
import { providerStatuses, connectProvider, disconnectProvider, providerWorkspaces, chooseWorkspace, addViewByUrl, replaceViewUrl, readView } from "./providers.ts";
import { savedViews, currentView, setCurrent, removeView, knownCardPrefix, boardHolding, setWritesAllowed } from "./clickupviews.ts";
import { assignSelf, setAssignee, setCard, listMembers, setStatus, setField, taskDetail, findCard, cardPullRequests, clickupWriteEnabled } from "./clickup.ts";
import { clickupTasks } from "./clickup.ts";
import type { ProviderId } from "../../shared/providers.ts";
import { listTasks, taskCapability, setTaskChangeHook, startTaskSweep, addTask, completeTask, reopenTask, deleteTask, cyclePriority, editTask, addTags, replaceNote, bulkApply, TASK_WRITE_ENABLED, type BulkAction } from "./tasks.ts";
import {
  addReminder, ackReminder, cancelReminder, snoozeReminder, listReminders,
  remindersFor, firedUnacked, setReminderHook, startReminderTick, localZone,
} from "./reminders.ts";
import { fileText, fileToTemp, fileTree, findFiles, grepFiles, listRefs, filesExist } from "./files.ts";
import {
  overview as dockerOverview, stats as dockerStats, logs as dockerLogs, inspect as dockerInspect, top as dockerTop,
  startContainer, stopContainer, restartContainer, removeContainer, dockerCapability,
} from "./docker.ts";
import {
  listPrs, prDetail, prDiff, prAsset, ghCapability, submitReview, addComment, replyToThread,
  editComment, deleteComment, setFileViewed, setAssignees, setMilestone, viewCounts, jobLog, checkJobs, rerunJobs, addLineComment, mentionables, facetOptions, applySuggestion, fileSlice,
  setThreadResolved, react, editPr, setLabels, setReviewers, setDraft, updateBranch,
  rerunFailedChecks, mergePr, closePr, prepareReviewPrompt, branchUrl, subscribeCi, commitDiff as prCommitDiff, submitReviewWith, prFileToTemp,
  prBaseOf,
  ghRateLimit,
  branchBehind, localHead, prRollup,
  prBranches, prsForBranch } from "./prs.ts";
import { generateWalkthrough, WALKTHROUGH_ENABLED } from "./walkthrough.ts";
import { ptyOpen, ptyMessage, ptyClose, projectCommands, shutdownTerminals, lastTmuxTarget, sessionTitle, TERMINAL_ENABLED, PTY_BACKEND, type PtyWsData } from "./terminal.ts";
import { mintAgentTicket } from "./agentticket.ts";
import { listPanes, focusPaneAnywhere, activePane, sweepPinnedWindows, pinnedSockets } from "./tmuxctl.ts";
import { repairLast, snapshot } from "./tmuxsnapshot.ts";
import { withAgentSessions } from "./paneloc.ts";
import { notePaneFromHook, paneDirs, paneAgentNote } from "./panewt.ts";
import { chatSend, activeTurns, CHAT_ENABLED, CHAT_BYPASS_ALLOWED, CHAT_ENGINE_DEFAULT } from "./chat.ts";
import { paneEngineCapability, attachCommand, validPaneName } from "./chatpane.ts";
import { tmuxBinStatus } from "./tmuxbin.ts";
import { applyTmuxConf, resetTmuxConf, confHealth, ensureConf } from "./tmuxconf.ts";
import { captureLayout, restoreLayout, clearRestoreState, lastCaptureAt, startRestoreSweeper } from "./tmuxrestore.ts";
import {
  windowTree, newWindow, splitPane, killWindow, killPane as killLayoutPane, selectWindow, selectPane,
  renameWindow, resizePane,
} from "./tmuxlayout.ts";
import { tmuxConfMode, tmuxOverride, tmuxRestoreEnabled, tmuxResume, tmuxSource, tmuxPrefix, validTmuxPrefix, writeTmuxSettings } from "./config.ts";
import { claudeModels } from "./claudemodels.ts";
import { codexStream, codexModels, codexTranscript, codexCwd, CODEX_ENABLED, CODEX_BYPASS_ALLOWED } from "./codex.ts";
import { antigravityStream, antigravityModels, ANTIGRAVITY_ENABLED, ANTIGRAVITY_BYPASS_ALLOWED } from "./antigravity.ts";
import { paneAlive, killPane, forgetPane, startPaneSweeper, sendKey, sendableKey, capture as capturePane, pinPane, panes, classifyPanes, idleEvictMs } from "./tmuxpane.ts";
import { startScanner, ownsSession, knownProjects, resyncScope, scanningEnabled } from "./transcripts.ts";
import { workspaceRoot, setWorkspaceRoot, inScope, sessionInScope, chatBypassAllowed, readBudgets, writeBudgets, hiddenProjects, setProjectHidden, configPath } from "./config.ts";
import { cloneProject, createProject } from "./projectadd.ts";
import { budgetStatus } from "./budget.ts";
import type { Budget } from "../../shared/types.ts";
import { hookStatus, applyHooks, hooksDir, hookPython } from "./hooksetup.ts";
import { probeAgents, ROSTER } from "./agentprobe.ts";
import { join as joinPath, basename } from "node:path";
import { privateHost, resolvePeer, originOf } from "./net.ts";
import { resolveToken, tokenOk, isIntake, isAuthExempt, callerFor, allowed, scopeNeeded, type Caller, type Origin } from "./auth.ts";
import { activeDevices, markSeen, revokeDevice, devices, publicDevice, type Scope } from "./devices.ts";
import { credentialsPath, hasCredential } from "./credentials.ts";
import { startCardWatch } from "./clickupwatch.ts";
import { mintTicket, claimTicket, pending as pendingPairings, acceptTicket, rejectTicket, collect as collectPairing, dropTicket, getTicket, MAX_ATTEMPTS } from "./pairing.ts";
import { updateStatus, viewerStatus, startUpdate, updateLog, releaseNotes } from "./selfupdate.ts";
import { rateOk } from "./ratelimit.ts";
import { noteClient, noteSocket, isLoopback, isSelf, isBlocked, blockDevice, remoteStatus, tailnetNames, refreshTailscale, TAILNET_OK_MS, proxiedByTailscaled } from "./remote.ts";
import { parseWindowMs } from "./params.ts";
import { serveWeb, serveIndex, WEB_UI_ENABLED, distPath } from "./webui.ts";
import { notifyCapability, subscribeNotifications, notifyWatching, openNote } from "./notifications.ts";
import { markIgnored } from "./ignored.ts";
import { withEvidence } from "./evidence.ts";

import { tidyReport } from "./tidy.ts";
const PORT = Number(process.env.AGENTGLASS_PORT || 4000);
/** When this process came up. /stats ships it so the dashboard's uptime is
 *  the server's, not the age of the oldest event in the database. */
const STARTED_AT = Date.now() - Math.round(process.uptime() * 1000);
/**
 * Loopback unless told otherwise.
 *
 * This server hands out a shell, git write access and docker control, with no
 * authentication of any kind — binding every interface put all of that in
 * reach of anyone sharing a café or office network. Exposing it is now a
 * deliberate act: set AGENTGLASS_BIND=0.0.0.0 (and understand what that means).
 */
const BIND = process.env.AGENTGLASS_BIND || "127.0.0.1";
const LOOPBACK_ONLY = BIND === "127.0.0.1" || BIND === "::1" || BIND === "localhost";
// RFC1918 addresses are trusted as origins/hosts only when this is set. Off by
// default: a shell-granting server should trust loopback alone unless exposing
// it to a LAN is a deliberate choice (paired with a token — see below).
const TRUST_LAN = process.env.AGENTGLASS_TRUST_LAN === "1";
// Optional shared-secret auth. Null on a loopback-only box with no token set
// (unchanged zero-config UX); required otherwise. Exposing without a token
// mints and prints one rather than running unauthenticated.
// TRUST_LAN widens the CSRF origin gate to trust any private-IP page, so it must
// bring a token with it — otherwise a loopback instance (token skipped because
// the bind is local) would let a LAN-origin page drive token-less destructive
// writes through the victim's own loopback. Treating TRUST_LAN as "not loopback
// only" for the token decision forces a token exactly when one is needed; net.ts
// already documents TRUST_LAN as something used on top of a token.
/** So a misconfigured exporter explains itself once rather than every batch. */
let warnedNoMetrics = false;

const AUTH = resolveToken(LOOPBACK_ONLY && !TRUST_LAN);
const AUTH_TOKEN = AUTH.token;
/** One socket, three roles: the live event stream, PTY terminal shells, and
 *  the desktop-notification mirror. */
/** Every socket carries the address that opened it, so "who is connected right
 *  now" is answerable, and so a device can be cut off while it is holding one. */
// `deviceId` is how a socket remembers which paired device opened it. Without
// it, forgetting a device revokes its credential and leaves whatever it is
// already holding — an event stream, a terminal — running until it disconnects
// on its own, which is a revoke in the list and not on the wire.
type WsData = ({ kind: "events" } | { kind: "notify" } | PtyWsData) & { ip?: string | null; deviceId?: string | null };
const clients = new Set<ServerWebSocket<WsData>>();
/**
 * When each event-stream socket last PROVED its peer is still running.
 *
 * Membership of `clients` is not evidence of anything. It is pruned in the
 * `close` handler, and a peer that has been frozen — which is what Android
 * does to a backgrounded app — never closes: measured on this exact serve
 * config, a SIGSTOPped client left `clients.size === 1`, `ws.send()` returning
 * bytes written and never throwing, for 120.1 seconds. Every alert in that
 * window was "delivered to a client" and the notify-send fallback in alerts.ts
 * was skipped. See the sweep below for what refreshes this.
 */
const alive = new Map<ServerWebSocket<WsData>, number>();
/** Every open socket of every kind, which `clients` is not: it holds the event
 *  streams only, and a device cut off mid-session may be holding a terminal. */
const sockets = new Set<ServerWebSocket<WsData>>();
/** Notification sockets, each holding the unsubscribe that keeps the D-Bus
 *  monitor alive. Empty map => no monitor process. */
const notifySubs = new Map<ServerWebSocket<WsData>, () => void>();

// Reflect the caller's Origin instead of a blanket `*`. Foreign origins are
// already turned away by localOrigin() before any body is served, so the old
// wildcard leaked nothing — but reflecting is honest, pairs with `Vary: Origin`,
// and permits the Authorization header the token flow now sends.
function corsFor(req: Request): Record<string, string> {
  const origin = req.headers.get("origin");
  return {
    "Access-Control-Allow-Origin": origin || "*",
    Vary: "Origin",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "content-type, authorization",
  };
}

/**
 * Is this request's Origin a machine we're willing to be driven by?
 *
 * The host is parsed as an IP address rather than pattern-matched. Matching the
 * hostname string against `/^10\./` also matches `10.evil.com` — a domain
 * anyone can register and point at 127.0.0.1, turning "private network" into
 * "any website", with a shell on the other end. A name is only ever accepted
 * when it is literally localhost; everything else has to *be* an address in a
 * private range, not merely look like one.
 */
const isPrivate = (h: string): boolean => privateHost(h, TRUST_LAN);
// This machine's OWN Tailscale name, trusted on the same opt-in as its tailnet
// IP (100.64/10 already rides TRUST_LAN in privateHost): both are reachable only
// through the authenticated, encrypted mesh, and the name is the origin a phone
// presents once it pairs over `tailscale serve`. Detected from `tailscale
// status`, never a wildcard — only the exact name(s) this node answers to.
const trustedName = (h: string): boolean => TRUST_LAN && tailnetNames().has(h.toLowerCase());
const trusted = (h: string): boolean => isPrivate(h) || trustedName(h);

// Block drive-by cross-site writes: a request carrying an Origin from a real
// website is rejected. A request with NO Origin is not a browser, so it can't
// be a drive-by — but it also can't be vouched for, which is why the routes
// that hand out real capability check ORIGIN_REQUIRED instead.
/**
 * The desktop shell serves its renderer from its own scheme, not a loopback
 * port — a port is assigned fresh on every launch, and localStorage is keyed
 * by origin, so the app used to lose every preference each time it started.
 *
 * Trusting this origin is no weaker than trusting 127.0.0.1: nothing on the
 * web can be served under a scheme that only exists inside the packaged app,
 * and a page cannot forge an Origin header. Both origin gates below defer to
 * it, so the two can never drift apart — which they did once already, and the
 * app came up unable to reach its own API.
 */
const DESKTOP_ORIGIN_SCHEME = "agentglass:";
function fromDesktopShell(origin: string): boolean {
  try { return new URL(origin).protocol === DESKTOP_ORIGIN_SCHEME; } catch { return false; }
}

function localOrigin(req: Request): boolean {
  const o = req.headers.get("origin");
  if (!o) return true;
  if (fromDesktopShell(o)) return true;
  try {
    return trusted(new URL(o).hostname);
  } catch { return false; }
}

/**
 * A stricter gate for the routes that grant execution: a shell, an agent, or
 * anything that can change the machine.
 *
 * Here a missing Origin is refused rather than trusted. Nothing but a browser
 * omits it, and every browser client of this server is same-origin, so the only
 * callers it turns away are the non-browser ones — which is exactly the
 * `websocat ws://host:4000/terminal/pty` case that otherwise hands a login
 * shell to anyone who can reach the port.
 *
 * Every route that EXECUTES or MUTATES is on this gate, and the split used to
 * be an accident of where the code landed: 22 mutating routes on `localOrigin`
 * against 5 here (#469). `localOrigin` waves a missing Origin straight through,
 * which is right for reads — the hooks and the OTLP exporters cannot send one,
 * and turning them away breaks the product — and wrong for anything that
 * commits, pushes, starts a container, kills a process, spawns an agent or
 * rewrites the workspace scope every other capability checks itself against.
 *
 * On the default loopback bind nothing changes: `from === "loopback"` is true
 * and an Origin-less caller is still allowed. The case this closes is the one
 * the README documents as supported — `AGENTGLASS_BIND=0.0.0.0` without a
 * token — where a remote `curl` with no Origin header could drive git, Docker,
 * the chat and the process killer.
 *
 * Two deliberate exceptions, both reads that happen to be POSTs or to have no
 * browser at the other end: `/git/status`, which takes a body only because it
 * is a query, and `/ingest`, the OTLP receivers and `/pair/*`, which are
 * Origin-less by design and must stay that way.
 */
/**
 * The strictest gate in the server: the desktop shell and nothing else.
 *
 * `trustedCaller` admits any private-network origin, which is right for a
 * dashboard you might open from a laptop on the same wifi and wrong for a route
 * that builds and runs code. This one requires the custom scheme, which only
 * the packaged shell can present — a browser cannot forge it, because browsers
 * cannot be served from it.
 */
function desktopOnly(req: Request): boolean {
  const o = req.headers.get("origin");
  return !!o && fromDesktopShell(o);
}

/** Sessions seen running only inside another tmux — a floating window. */
const seenPopups = new Set<string>();

function trustedCaller(req: Request, from: Origin): boolean {
  const o = req.headers.get("origin");
  // No Origin means a non-browser caller, which is only safe when this caller
  // cannot be remote. That used to be `LOOPBACK_ONLY` — a property of the
  // *bind*, decided once at startup — and `tailscale serve` falsifies it: it
  // publishes a 127.0.0.1 bind to the tailnet, so LOOPBACK_ONLY stayed true
  // while `websocat wss://<name>/terminal/pty` became reachable. Asking this
  // request where it came from is the same test, applied to the thing it was
  // always about.
  if (!o) return from === "loopback";
  if (fromDesktopShell(o)) return true;
  try {
    return trusted(new URL(o).hostname);
  } catch { return false; }
}

/**
 * DNS-rebinding guard: the Host header must name an address that is plausibly
 * this machine.
 *
 * The Origin gate above can't see one attack: a site the user visits points
 * its *own* domain's DNS at 127.0.0.1, and from then on the browser talks to
 * this server as if it were that site — same-origin, so plain GETs carry no
 * Origin header at all and would sail through as "non-browser callers". What
 * that page CAN'T forge is the Host header, which still names the attacker's
 * domain. Refusing any Host that isn't localhost or a private address closes
 * the door; a reverse-proxy name can be allowed explicitly.
 */
const ALLOWED_HOSTS = new Set(
  (process.env.AGENTGLASS_ALLOWED_HOSTS || "").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean)
);
const trustedHost = (url: URL) => trusted(url.hostname) || ALLOWED_HOSTS.has(url.hostname.toLowerCase());

// Every git mutation nudges the clients that are showing git state. Registered
// here rather than in gitwork so that module stays unaware of the socket.
/**
 * The working tree, held for a moment — a property of this endpoint, not of
 * `workingTree()`, which stays truthful for every other caller.
 *
 * Measured by the loop watchdog with the git panel open and someone typing:
 * 618ms per call, eight calls in two minutes, the largest single source of
 * blocked event loop in the app. It is four synchronous git invocations (two
 * diffs, a status, the branch state) on a 2.5s client poll, and the terminal
 * rides the same thread.
 *
 * Making those four async is the real fix, is a deep change through parseDiff,
 * treeState and branchInfo, and is not worth doing badly. Meanwhile: one second,
 * scaled by `backoff()` so it holds longer while a shell is in use, and dropped
 * the instant anything mutates a repository — which is what keeps staging a
 * file from reading back the state before it.
 */
/**
 * Expensive git reads, held until the repository actually moves.
 *
 * `/git/branches` is ~1042ms on a real repo and `/git/graph` ~934ms, and both
 * are on 10s polls while their tab is open — so a TTL cache is no use, the poll
 * outlives any sane one. But asking "has anything moved?" costs 2ms: one
 * `for-each-ref` over every local and remote ref. If not one hash has changed,
 * last time's answer is not stale, it is *identical*, and recomputing it is
 * ~800ms of a thread the terminal is trying to use.
 *
 * Better than a TTL in the way that matters: there is no staleness window at
 * all. A commit made in the app, in the terminal, or by an agent moves a ref,
 * the fingerprint changes, and the next poll recomputes. Nothing has to know to
 * invalidate anything.
 *
 * Measured on the repo this was built against: 761ms for the graph, 644ms for
 * `branch --merged` alone, against 2ms for the fingerprint.
 */
// The *serialised* answer, not the object. A cache hit on the graph would
// otherwise re-stringify 164KB of it on every poll, which is most of what was
// left of the cost once the git call was skipped.
const refsCache = new Map<string, { refs: number; body: string }>();

// Awaited: even at ~2ms this is one for-each-ref on the loop for every poll of
// /git/branches, /git/graph and /git/tags — three endpoints, several tabs — and
// the whole point is that the terminal's thread runs none of them. It queues
// behind the shared pool now; the answer it gates is cached, so a slightly later
// fingerprint only defers a recompute, never a keystroke.
//
// Keyed off the family, and cached for a beat. `refs/heads` and `refs/remotes`
// live in the shared object store, so every worktree of a repo has the identical
// fingerprint — yet `/git/branches`, `/git/graph` and `/git/tags` each read it
// per QUERY ROOT on every poll, which on a repo with fourteen worktrees is
// dozens of identical for-each-refs a second the moment you start switching
// between checkouts. `worktreeParent` finds the family's main checkout with a
// file read and no subprocess; a 250ms hold then collapses that storm to one
// read per family. Short by design: it only gates recomputes that are themselves
// cached far longer (whileRefsHoldAsync), so a fingerprint 250ms late defers a
// panel refresh by a frame, never a keystroke — and every write clears the caches
// behind it directly anyway.
const REFS_FP_TTL_MS = 250;
const refsFpCache = new Map<string, { at: number; fp: number }>();
async function refsFingerprint(root: string): Promise<number> {
  const famRoot = worktreeParent(root) ?? root;
  const hit = refsFpCache.get(famRoot);
  if (hit && Date.now() - hit.at < REFS_FP_TTL_MS) return hit.fp;
  const r = await gitAsync(famRoot, ["for-each-ref", "--format=%(objectname)", "refs/heads", "refs/remotes"]);
  // A failure fingerprints as "different every time", so a broken repo falls
  // back to recomputing rather than serving one wrong answer forever.
  const fp = r.code === 0 ? Number(Bun.hash(r.stdout + ":" + r.stdout.length)) : Math.random();
  if (refsFpCache.size > 200) refsFpCache.clear();
  refsFpCache.set(famRoot, { at: Date.now(), fp });
  return fp;
}

/** Recompute only when a ref moved, off the loop. `key` separates answers that
 *  come from the same repo but different questions (the log's scope, a limit). */
async function whileRefsHoldAsync(key: string, root: string, compute: () => Promise<unknown>): Promise<string> {
  if (!root) return JSON.stringify(await compute());
  const refs = await refsFingerprint(root);
  const hit = refsCache.get(key);
  if (hit && hit.refs === refs) return hit.body;
  const body = JSON.stringify(await compute());
  if (refsCache.size > 40) refsCache.clear();
  refsCache.set(key, { refs, body });
  return body;
}

const TREE_TTL_MS = 1_000;
const treeCache = new Map<string, { at: number; data: WorkingTree }>();
// The worktree panel is the heaviest git poll (a list plus base/behind/dirty per
// checkout). Its inner reads are cached and family-shared now, but the assembled
// answer had no cache of its own — so every poll of every open tab still rebuilt
// it. A short TTL (scaled by backoff while a shell is hot) holds it across the
// 10s panel poll and the burst a scope switch fires, and every write clears it
// through the same git-change hook the tree cache uses.
const WORKTREES_TTL_MS = 2_500;
const worktreesCache = new Map<string, { at: number; body: string }>();
// The all-worktrees change list behind File changes, so it shows what each
// checkout has actually changed (git), not only what an agent recorded. Keyed by
// mode — "working" (the working tree) vs "committed" (each checkout's last
// commit) — with a short TTL, cleared the instant git changes.
const changesAllCache = new Map<string, { at: number; body: string }>();
// Held a touch longer than the 4s File-changes poll so a poll reuses the last
// answer instead of re-fanning git across every in-scope worktree each time —
// which, at the old 2.5s, missed on every single poll. Safe to hold longer: the
// git-change hook below clears it the instant anything is staged/committed/
// discarded through the app, so this TTL only bounds how fast a change made
// *outside* the app (an editor save, a raw `git` in the terminal) surfaces, and
// a few seconds in a review panel is fine. backoff() stretches it while hot.
const CHANGES_ALL_TTL_MS = 6_000;
// Per-worktree cache of each checkout's last-commit diff — the committed-mode
// analogue of treeCache. Without it, every committed-mode miss re-ran rev-list +
// diff for every repo. Same short TTL, same hook clears it.
const commitCache = new Map<string, { at: number; data: Awaited<ReturnType<typeof lastCommitChanges>> }>();
// A hard ceiling on how many git rows File changes will take at once: a runaway
// worktree (a giant last commit that slipped the no-merge filter, thousands of
// uncommitted files) must never be able to freeze the view again.
const CHANGES_ALL_MAX = 400;
setGitChangeHook(() => { treeCache.clear(); worktreesCache.clear(); changesAllCache.clear(); commitCache.clear(); broadcast({ type: "git" }); });

/**
 * The one thing the merged-branch sweep cannot do for itself.
 *
 * `whileRefsHoldAsync` above is right about almost everything it caches: if not
 * one ref has moved, last time's answer is identical, not stale. The sweep that
 * recognises squash- and rebase-merged branches is the exception, because it
 * changes the ANSWER without touching a ref, and on the repository you are
 * actually tidying, nothing else moves a ref either. So the pre-sweep body was
 * served indefinitely and a branch merged yesterday read "not merged, kept"
 * until an unrelated commit happened to invalidate the fingerprint.
 *
 * Every `branches:` body goes, not just this root's: the cache is keyed by the
 * QUERY root, which is any worktree of the repo, while the sweep knows only the
 * repo root. There are at most forty entries and rebuilding one costs a cached
 * read, so dropping them all is cheaper than being subtly wrong about which
 * checkout the panel is looking at.
 */
setMergedVerdictHook(() => {
  for (const k of refsCache.keys()) if (k.startsWith("branches:")) refsCache.delete(k);
  broadcast({ type: "git" });
});
/**
 * Prove the peers are there, and cut loose the ones that are not.
 *
 * A ping is answered by the peer's own websocket stack, so a pong is evidence
 * that its process is being scheduled — which is exactly the thing a frozen
 * phone stops doing while its TCP connection carries on accepting bytes.
 *
 * The CLOSE is not optional, and that is the part reading the code would not
 * have found. Bun's own reaper does close a silent socket — measured at 120.1s
 * with this serve config — but it counts a ping as traffic: with a 10s ping and
 * no close of our own, the SIGSTOPped peer was still attached at 200s and
 * climbing, so adding liveness detection without acting on it turns a
 * two-minute leak into a permanent one. Closing on the deadline is what makes
 * the ping safe to send at all.
 *
 * 10s and 30s: three missed pongs before a socket stops counting. The cost of
 * being too eager is one duplicate notification (broadcast AND notify-send)
 * for a client that was merely slow; the cost of being too slow is an alert
 * nobody hears. Freshly opened sockets start alive, so the first alert after a
 * connect is never a false negative.
 */
const LIVE_PING_MS = 10_000;
const LIVE_DEADLINE_MS = 30_000;
setInterval(() => {
  const now = Date.now();
  for (const ws of [...clients]) {
    const at = alive.get(ws) ?? 0;
    if (now - at > LIVE_DEADLINE_MS) {
      // Deliberately not silent bookkeeping: the socket goes, so the peer's own
      // reconnect fires and comes back with a socket that works. live.ts on the
      // phone already measures that path at 62-76ms.
      try { ws.close(1001, "no answer to a ping in 30s"); } catch { /* already gone */ }
      clients.delete(ws);
      alive.delete(ws);
      continue;
    }
    try { ws.ping(); } catch { /* going away; close() will tidy up */ }
  }
  // Never a reason to hold the process open on its own.
}, LIVE_PING_MS).unref?.();

// Let the alert path reach a connected client, which raises a native OS
// notification (cross-platform) instead of the Linux-only notify-send.
setAlertSink({
  broadcast: (a) => broadcast({ type: "alert", data: a }),
  census: () => {
    const now = Date.now();
    let live = 0;
    for (const ws of clients) if (now - (alive.get(ws) ?? 0) <= LIVE_DEADLINE_MS) live++;
    return { attached: clients.size, live };
  },
});
// The browser relay speaks through the same socket, and counts the same
// clients: "is there a window to ask" is exactly "is anybody listening".
setBrowserSink({ send: (ask) => broadcast({ type: "browser", data: ask }), listeners: () => clients.size });
// The task store has a second writer — the user's editor — so a change there
// reaches the panel through a sweep rather than through anything we did.
setTaskChangeHook(() => broadcast({ type: "tasks" }));
// A reminder that fired changes what the panel and the rail should show, and
// the panel is not necessarily open — so it is pushed, like everything else
// that happens without the user asking.
setReminderHook(() => broadcast({ type: "tasks" }));
// Let the git layer ask what a branch's pull request says its base is. Wired
// here rather than imported there, because gitwork must not depend on the
// pull-request layer — same reason as the two hooks above. Reads the PR list
// cache; answers null when there is nothing cached, and the git layer falls
// back to inferring the base from history.
setPrBaseHook((root, branch) => prBaseOf(root, branch));

/**
 * Session detail, held briefly, and invalidated when the session gets an event.
 *
 * `getSession` is a synchronous SQLite scan of the whole session, and a big one
 * (8000+ events) measured ~50ms warm and several times that under load — 50ms+
 * of the loop the PTY rides, per call. The detail modal polls it, and the
 * interaction load hammered it: the watchdog showed GET /session as the single
 * worst loop-blocker, six recomputations of the same static session queued back
 * to back. The body is cached per id so a re-open or a poll is free, and cleared
 * the instant an event lands for that session (ingestBody) so a LIVE session
 * still updates at once — a historical one, which is what you actually sit and
 * read, never recomputes. Combined with the single-flight on the endpoint, N
 * concurrent opens of the same session cost one scan, not N.
 *
 * The TTL is only a backstop: correctness comes from the two invalidation points
 * (HTTP ingest and the scanner tail), which fire on the exact events that change
 * the answer. So it is long — a short one would just spend ~50ms of the PTY's
 * thread re-deriving output that has not changed, which is the very spike this
 * removes — and scaled by backoff() so it holds even longer while a shell is hot.
 */
const SESSION_TTL_MS = 15_000;
const sessionCache = new Map<string, { at: number; body: string | null }>();

function broadcast(frame: WsFrame) {
  // Serialising an event and writing it to every open client. Small per client,
  // but it is a fan-out on the hot path of ingest and it was one of the things
  // hiding inside "(background)".
  entered("broadcast to clients");
  const msg = JSON.stringify(frame);
  for (const ws of clients) {
    try {
      ws.send(msg);
    } catch {
      // Rare and not to be relied on: `ws.send()` into a peer that has been
      // frozen returns the byte count and does not throw (measured, 68 bytes,
      // buffered 0, for the full two minutes it stayed attached). The sweep
      // above is what actually finds those.
      clients.delete(ws);
      alive.delete(ws);
    }
  }
}

/**
 * Push the open-tool list, with evidence read at this moment.
 *
 * Evidence is a claim about *now* — "the file it promised to touch has not
 * changed since the call opened" — and one taken when a client connected is
 * worth nothing a minute later. It used to be sent only in the `initial` frame,
 * which was fine while nothing depended on it and is not fine now that it
 * decides whether a session is reported as stuck.
 *
 * Silent when nothing is open and when nobody is listening, so an idle machine
 * pays for one SQL query on a four-second tick and no filesystem work at all.
 */
function pushOpenTools() {
  if (!clients.size) return;
  const open = openToolCalls();
  if (!open.length && !lastOpenCount) return;
  lastOpenCount = open.length;
  broadcast({ type: "openTools", data: withEvidence(open) });
}
let lastOpenCount = 0;
/**
 * How often the verdict is re-read.
 *
 * Fast enough that "stuck" appears while the user is still looking at the
 * session, slow enough that the filesystem work — one stat per session, one
 * shallow directory scan per working directory — is nothing. The classifier's
 * own thresholds are in minutes, so a tighter tick would buy no accuracy.
 */
const OPEN_TOOL_TICK_MS = 4000;
setInterval(pushOpenTools, OPEN_TOOL_TICK_MS).unref?.();

/** Normalize → persist → broadcast → alert. Shared by /ingest and /v1/traces. */
function ingestBody(body: IngestBody) {
  // Codex's OTel records say everything about a turn except where it ran, so a
  // cockpit scoped to a project — the default — filtered every one of them out
  // and OpenAI never appeared in the provider list. The panel knows the
  // directory because it launched the turn; this is where that is handed back.
  //
  // Only fills a gap, never overwrites: an agent that reports its own location
  // is the better source, and this must not relabel it.
  const payload = (body.payload ?? {}) as Record<string, unknown>;
  if (!payload.cwd && !payload.project_path && body.session_id) {
    const known = codexCwd(String(body.session_id));
    if (known) body = { ...body, payload: { ...payload, cwd: known.cwd, project_path: known.root } };
  }
  const n = normalize(body);
  // Live seam only: a skewed sender's clock must not decide which time window
  // its events land in. Backfill inserts elsewhere and keeps its real times.
  n.timestamp = clampIngestTimestamp(n.timestamp, Date.now());
  const result = insertEvent(n);
  // A retry returns the first event. Nothing downstream should run twice:
  // no cache invalidation, WebSocket frame, open-tool push, or alert.
  if (!result.inserted) return result;
  const { event, session } = result;
  // The session just grew, so its cached detail is stale — drop it so a live
  // session refreshes on the next open, while static sessions keep serving from
  // cache. Cheap: one Map delete on a path already doing a DB write.
  sessionCache.delete(event.session_id);
  // Stored either way — a cockpit scoped today may be unscoped tomorrow, and the
  // history has to be there when it is. Only the live push is filtered, so that
  // what arrives while you watch agrees with what a reload would show.
  if (sessionInScope(session)) {
    broadcast({ type: "event", data: event });
    broadcast({ type: "session", data: session });
  }
  // A Pre opens a call and a Post closes one, so the list the fleet is drawing
  // from just changed. Pushed now rather than up to a tick later, because the
  // moment a tool starts is exactly when the card should say so.
  if (event.hook_event_type === "PreToolUse" || event.hook_event_type.startsWith("PostToolUse")) pushOpenTools();
  maybeAlert(event);
  return result;
}

function csvEscape(v: unknown): string {
  const s = v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const server = Bun.serve<WsData>({
  port: PORT,
  hostname: BIND,
  // A frame is a control message or a keystroke; nothing legitimate is large.
  // Unset, Bun allows 16MB per frame, which is a cheap way to exhaust memory.
  maxRequestBodySize: 32 * 1024 * 1024,
  // Bun closes a connection that has been quiet for `idleTimeout` seconds, and
  // the default is 10 — which counts the gaps *inside* a streaming response, not
  // just an idle socket. A chat turn is silent for as long as the model thinks
  // or a tool runs, so the default cut `/chat/send` off mid-turn and the browser
  // reported only a generic fetch failure. 255 is the maximum Bun accepts; it is
  // still not long enough on its own for a slow turn, so `chat.ts` also sends a
  // periodic keepalive to keep the gaps under it.
  idleTimeout: 255,
  async fetch(req, srv) {
    const url = new URL(req.url);
    const { pathname } = url;
    // Name this request for the loop watchdog: if the loop stalls in the next
    // moment, the stall is reported against this path instead of being one more
    // anonymous freeze in a terminal. See loopwatch.ts.
    entered(`${req.method} ${pathname}`);

    // Who is actually on the other end.
    //
    // Not `srv.requestIP()` any more, and that one line was three bugs. Under
    // `tailscale serve` tailscaled terminates TLS and re-dials our port from
    // 127.0.0.1, so the socket said "loopback" for every phone on the tailnet:
    // the tokenless intake sinks were open to all of them (measured — `POST
    // https://<name>/ingest` reached the handler and answered 400, while
    // `/sessions` from the raw tailnet IP correctly answered 401), the device
    // list came back empty because noteClient drops loopback on purpose, and
    // Block was dead because isSelf() said every one of them was this machine.
    //
    // resolvePeer only believes a forwarding header when proxiedByTailscaled
    // has verified the *uid owning the connecting socket*, which no non-root
    // local process can choose. See net.ts for the rules and remote.ts for the
    // measurement.
    const peerSock = srv.requestIP(req);
    const peer = resolvePeer({
      socketAddress: peerSock?.address,
      headers: req.headers,
      proxied: proxiedByTailscaled(peerSock, srv.port ?? PORT, req.headers),
    });
    const clientIp = peer.address;
    // Proof of reachability for the remote-access panel: which off-box devices
    // have actually arrived. Loopback is ignored — it is every call the app
    // makes of itself and says nothing about whether a phone can get in.
    noteClient(clientIp, { agent: req.headers.get("user-agent") });
    // Cut off on sight. A device the user turned away in the panel is refused
    // before the token is even considered, because the case this exists for is
    // "something I do not recognise is holding a terminal on my machine" and
    // the answer to that has to arrive on the next packet, not the next
    // restart. It is deliberately above the auth gate: the device already has
    // the code, which is exactly why it needs to be stopped by address.
    if (isBlocked(clientIp)) return new Response(JSON.stringify({ ok: false, error: "this device was disconnected from this machine" }), {
      status: 403, headers: { "content-type": "application/json" },
    });
    // Per-request response helpers: `cors` reflects this caller's Origin, so it
    // has to be built here rather than shared as a module constant.
    const cors = corsFor(req);
    const json = (data: unknown, status = 200) =>
      new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", ...cors } });
    /** Already-serialised JSON — see whileRefsHold. */
    const body = (s: string, status = 200) =>
      new Response(s, { status, headers: { "content-type": "application/json", ...cors } });
    const csrfBlocked = () => json({ ok: false, error: "cross-origin write blocked" }, 403);
    const rebindBlocked = () =>
      json({ ok: false, error: "request Host is not a local or private address (DNS-rebinding guard — set AGENTGLASS_ALLOWED_HOSTS for a reverse-proxy name)" }, 403);

    // Before anything else — including OPTIONS and WS upgrades: a request that
    // arrived under a foreign Host is a rebinding attempt, whatever it asks.
    if (!trustedHost(url)) return rebindBlocked();

    if (req.method === "OPTIONS") return new Response(null, { headers: cors });

    // One gate for the whole surface — reads included. Without it, CORS let any
    // site the user visited read /export, /search and the rest from loopback. A
    // missing Origin is a non-browser caller (curl, the hooks), not a drive-by,
    // so it's allowed; a foreign website is turned away here.
    if (!localOrigin(req)) return csrfBlocked();

    // --- built web UI (single-port mode) ---
    // Exact files only, GET/HEAD only, and ahead of the token gate: the bundle
    // is the same public code that ships in the repo, and the ?token= flow
    // needs index.html and its assets to load before the app can pick the
    // token up and attach it — every data route below stays gated. API paths
    // never collide here: none of them maps to a real file under web/dist, so
    // for them this falls straight through to the routes.
    if (req.method === "GET" || req.method === "HEAD") {
      const asset = serveWeb(pathname, cors);
      if (asset) return asset;
    }

    // Shared-secret gate. When a token is configured, every route but the
    // append-only intake sinks needs it — this is what closes the door on other
    // local processes and makes a non-loopback bind safe. WS upgrades carry it
    // as ?token= (a browser can't set a header on them); fetch uses Bearer.
    // /gate is NOT exempt here: it's the control plane, and its hook carries the
    // token when one is set (see auth.ts / gate_event.py).
    //
    // A paired phone carries its own credential rather than this one (see
    // devices.ts), so the answer is no longer yes-or-no: it is *who*, and then
    // whether that caller's scope covers what the request is asking for. The
    // machine's token is still the machine, and everything below is unchanged
    // for it.
    // Held for the WebSocket upgrades below: a socket has to remember which
    // device opened it, or forgetting that device cannot close what it holds.
    //
    // The append-only sinks are tokenless only from this machine (see
    // LOCAL_SINKS in auth.ts), so the gate needs the source address, not just
    // the path. An address we could not read counts as remote — the same call
    // `atMachine()` makes below, and the only safe direction for a guard whose
    // other side is "no credential at all".
    //
    // This used to end "resolveToken refuses to run unauthenticated on a
    // non-loopback bind, so AUTH_TOKEN unset already means loopback only". That
    // was the bug, written down as a reassurance. `tailscale serve` publishes a
    // 127.0.0.1 bind to the whole tailnet, so "loopback bind" and "only local
    // callers" are different statements — and the gate below no longer assumes
    // one from the other.
    const from: Origin = originOf(peer);
    let caller: Caller | null = null;
    // A remote caller is never tokenless, even on a box that decided it did not
    // need a token.
    //
    // LOOPBACK_ONLY is what makes AUTH_TOKEN null (resolveToken's zero-config
    // path), and it was read as "nobody off-box can reach us". `tailscale
    // serve` makes that false: it fronts a 127.0.0.1 bind and publishes it to
    // the tailnet, which is the *recommended* way to run this — so the safest
    // looking configuration was the one that skipped the auth gate entirely for
    // the whole tailnet. This refuses instead. Loopback is untouched, so his
    // hooks and the desk keep their zero-config UX; /health and the pairing
    // handshake stay exempt so the phone still gets an answer it can act on.
    if (!AUTH_TOKEN && from === "remote" && !isAuthExempt(pathname, from)) {
      return json({ ok: false, error: "unauthorized — this server has no token configured and only answers local callers" }, 401);
    }
    if (AUTH_TOKEN && !isAuthExempt(pathname, from)) {
      caller = callerFor(req, url, AUTH_TOKEN);
      if (!caller) return json({ ok: false, error: "unauthorized — pass ?token= or Authorization: Bearer" }, 401);
      if (!allowed(caller, req.method, pathname)) {
        // 403 rather than 401: the credential is real and was accepted. Saying
        // "unauthorized" to a device that is correctly paired sends people to
        // re-scan a QR, which fixes nothing and is the wrong thing to learn.
        return json({
          ok: false,
          error: `this device is paired for "${caller.scope}" access, and ${pathname} needs "${scopeNeeded(req.method, pathname)}"`,
          scope: caller.scope,
          needs: scopeNeeded(req.method, pathname),
        }, 403);
      }
      // Cheap enough to do on every request because it is throttled to once a
      // minute per device — it is what lets the pane say when a phone was last
      // heard from, which is the difference between a device list and a guess.
      if (caller.device) markSeen(caller.device.id);
    }

    // Throttle the unauthenticated intake sinks so a runaway client can't flood
    // the DB and the broadcast fan-out. Keyed by source address + route.
    if (req.method === "POST" && isIntake(pathname)) {
      const ip = clientIp || "local";
      if (!rateOk(`${ip} ${pathname}`)) return json({ ok: false, error: "rate limited" }, 429);
    }

    // --- WebSocket upgrade ---
    // Origin-checked like the mutating routes. WebSockets are exempt from CORS,
    // so without this any page in the user's browser could open a socket to
    // localhost and read the whole fleet's prompts, paths and errors as they
    // stream — a read this feed is not meant to give to the open web.
    if (pathname === "/stream") {
      if (!trustedCaller(req, from)) return csrfBlocked();
      if (srv.upgrade(req, { data: { kind: "events", ip: clientIp ?? null, deviceId: caller?.device?.id ?? null } })) return undefined as unknown as Response;
      return new Response("upgrade failed", { status: 426 });
    }

    // --- in-browser terminal: a real PTY shell over a WebSocket ---
    if (pathname === "/terminal/pty") {
      if (!trustedCaller(req, from)) return csrfBlocked();
      if (!TERMINAL_ENABLED) return json({ error: "terminal is disabled" }, 403);
      const data: PtyWsData & { ip?: string | null; deviceId?: string | null } = {
        kind: "pty",
        deviceId: caller?.device?.id ?? null,
        root: url.searchParams.get("root") || "",
        // A path to open, not a command to run. Validated in ptyOpen against
        // the same scope rule the directory gets.
        view: url.searchParams.get("view") || undefined,
        // Editing is asked for explicitly. Absent, the file opens read-only —
        // see PtyWsData.edit for why that default is the whole point.
        edit: url.searchParams.get("edit") === "1",
        // A live tmux pane to show instead of a new shell. Tmux's own id and
        // nothing else — the server looks it up and builds the command, so a
        // socket path can never arrive from a client. See PtyWsData.pane.
        pane: url.searchParams.get("pane") || undefined,
        // A single-use ticket for an agent to start in this pane, minted at
        // POST /terminal/agent. An opaque id, never a prompt and never a
        // command — see PtyWsData.agent.
        agent: url.searchParams.get("agent") || undefined,
        // Reflow the tmux window to this client instead of keeping the desk's
        // size. A choice the phone makes per connection — see attachArgvFor.
        fit: url.searchParams.get("fit") === "1",
        // A shell in a directory, rather than the tmux session the desk was
        // last in. Sent by the consoles docked inside other views — see
        // PtyWsData.fresh for the three clients this was measured on.
        fresh: url.searchParams.get("fresh") === "1",
        cols: Number(url.searchParams.get("cols") || 80),
        rows: Number(url.searchParams.get("rows") || 24),
        ip: clientIp ?? null,
      };
      if (srv.upgrade(req, { data })) return undefined as unknown as Response;
      return new Response("upgrade failed", { status: 426 });
    }

    // --- desktop notifications mirrored onto the notch ---
    //
    // The monitor runs only while a socket is open here, and the UI only opens
    // one when the user has switched the feature on. Off means nothing is
    // spawned and nothing is read — not "read it and don't show it".
    if (pathname === "/notifications/capability") return json(notifyCapability());
    if (pathname === "/notifications/open" && req.method === "POST") {
      if (!trustedCaller(req, from)) return csrfBlocked();
      let body: { id?: unknown };
      try { body = (await req.json()) as { id?: unknown }; } catch { return json({ ok: false, error: "invalid json" }, 400); }
      const r = openNote(body?.id);
      return json(r, r.ok ? 200 : 404);
    }
    if (pathname === "/notifications") {
      if (!trustedCaller(req, from)) return csrfBlocked();
      const cap = notifyCapability();
      if (!cap.supported) return json({ error: cap.reason ?? "unsupported" }, 501);
      if (srv.upgrade(req, { data: { kind: "notify", ip: clientIp ?? null, deviceId: caller?.device?.id ?? null } })) return undefined as unknown as Response;
      return new Response("upgrade failed", { status: 426 });
    }

    // --- health ---
    // `service` is the identity marker: the desktop shell probes :4000 before
    // spawning its sidecar, and "answers 200" is not the same as "is us". Any
    // other local dev server squatting the port answers 200 too, and adopting
    // it pointed the whole cockpit at a stranger's API. See electron/main.js.
    if (pathname === "/health") return json({ ok: true, service: "agentglass", clients: clients.size, notifyWatching: notifyWatching() });

    // --- ingest ---
    if (pathname === "/ingest" && req.method === "POST") {
      let body: IngestBody;
      try {
        body = (await req.json()) as IngestBody;
      } catch {
        return json({ error: "invalid json" }, 400);
      }
      const ingestError = externalIngestError(body);
      if (ingestError) return json({ error: ingestError }, 400);
      // Which pane this agent is sitting in — the one fact only the hook can
      // tell us, because it runs as a child of the agent and inherits the
      // pane's TMUX_PANE. Noted before the ownership check below: a session the
      // scanner owns still has a pane, and "where is this agent working" is a
      // question about the pane, not about who counts its tokens.
      notePaneFromHook(body);
      // A Claude Code session with a transcript on disk is already covered by
      // the scanner, which reads the same turns in richer form. Taking the hook
      // copy too would count every tool call and every token twice.
      if (ownsSession(body.session_id)) return json({ ok: true, skipped: "scanner owns this session" });
      const result = ingestBody(body);
      return json({
        ok: true,
        id: result.event.id,
        ...(!result.inserted ? { duplicate: true } : {}),
      });
    }

    // --- OpenTelemetry OTLP/HTTP (JSON) trace receiver ---
    // Maps GenAI (`gen_ai.*`) spans → events, so ANY OTel-instrumented provider
    // feeds the dashboard. OTel HTTP exporters POST the traces signal here.
    if ((pathname === "/v1/traces" || pathname === "/otlp/v1/traces") && req.method === "POST") {
      // Accept both OTLP/HTTP encodings: JSON and protobuf (the SDK default). No
      // Collector needed — point any exporter's http endpoint straight here.
      const ct = req.headers.get("content-type") || "";
      let body: unknown;
      try {
        body = ct.includes("protobuf") ? decodeOtlpTraces(await req.arrayBuffer()) : await req.json();
      } catch {
        return json({ error: "could not parse OTLP body (send application/json or application/x-protobuf)" }, 400);
      }
      let accepted = 0;
      let rejected = 0;
      for (const b of otlpTracesToEvents(body)) {
        if (!b.source_app || !b.session_id || !b.hook_event_type) { rejected++; continue; }
        ingestBody(b);
        accepted++;
      }
      // OTLP ExportTraceServiceResponse: empty {} = full success.
      return json(rejected ? { partialSuccess: { rejectedSpans: rejected, errorMessage: "spans without gen_ai.* were ignored" } } : {});
    }

    // --- OTLP/HTTP (JSON or protobuf) LOG receiver ---
    // For agents that export OpenTelemetry *logs* instead of traces (OpenAI
    // Codex CLI). Each GenAI-ish log record → an event.
    if ((pathname === "/v1/logs" || pathname === "/otlp/v1/logs") && req.method === "POST") {
      const ct = req.headers.get("content-type") || "";
      let body: unknown;
      try {
        body = ct.includes("protobuf") ? decodeOtlpLogs(await req.arrayBuffer()) : await req.json();
      } catch {
        return json({ error: "could not parse OTLP body (send application/json or application/x-protobuf)" }, 400);
      }
      for (const b of otlpLogsToEvents(body)) {
        if (b.source_app && b.session_id && b.hook_event_type) ingestBody(b);
      }
      return json({}); // ExportLogsServiceResponse: {} = success
    }

    /**
     * --- OTLP metrics: refused out loud, rather than 404 ---
     *
     * There is no metrics receiver here, on purpose — otlp.ts says why. What
     * this route fixes is not the absence but the silence: point
     * `OTEL_EXPORTER_OTLP_ENDPOINT` at agentglass from Claude Code and its
     * metrics went to a 404, which an exporter swallows into a log nobody is
     * reading. The person is left watching a dashboard that never fills, with
     * nothing anywhere saying the endpoint they configured does not exist.
     *
     * 501 rather than 404 or 429: it is honest about what happened, and it is
     * in the class OTel exporters do not retry — so a misconfigured agent says
     * this once per batch rather than hammering the port forever.
     *
     * Registered for GET as well as POST. An exporter only ever POSTs, but the
     * first thing anybody does when telemetry does not arrive is open the URL
     * in a browser, and a 404 there is the same dead end by hand.
     */
    if (pathname === "/v1/metrics" || pathname === "/otlp/v1/metrics") {
      // Said once, on the console the operator is actually looking at. The
      // exporter's own log is the other place this could land, and it is on
      // the wrong machine's terminal about as often as not.
      if (!warnedNoMetrics) {
        warnedNoMetrics = true;
        console.warn(
          "[otlp] something POSTed metrics to " + pathname + ". This server receives OpenTelemetry " +
          "traces (/v1/traces) and logs (/v1/logs), not metrics — see README ▸ OpenTelemetry. " +
          "If this is Claude Code, it is already covered in full by the hooks (bun run setup) and its " +
          "OTel export can be left pointed elsewhere.",
        );
      }
      return json({
        error: "this server has no OpenTelemetry metrics receiver",
        accepts: ["/v1/traces", "/v1/logs"],
        why: "agentglass maps GenAI spans and log records into per-call events. Metrics carry totals, which it already computes from those events.",
        claudeCode: "Claude Code's OTel export is metrics, and it is already covered at higher fidelity by the hooks — run `bun run setup`.",
      }, 501);
    }

    // --- reads ---
    if (pathname === "/events/recent") {
      const limit = Math.min(2000, Number(url.searchParams.get("limit") || 300));
      return json(getRecent(limit, url.searchParams.get("provider") || undefined));
    }
    if (pathname === "/events/filter-options") return json(getFilterOptions());
    // Every project the scanner has seen, with the real folder it lives in —
    // this is what the folder filter lists.
    if (pathname === "/projects") {
      // Scoped instance → scoped project list. The DB may hold other projects
      // from an earlier machine-wide run; they're not this cockpit's business.
      // inScope rather than a prefix test, so a cockpit opened *on* a linked
      // worktree still lists the project its sessions roll up to.
      const ws = workspaceRoot();
      const projects = knownProjects().filter((p) => inScope(p.path, ws));
      // `scanning` is what this process is actually doing, not what it was
      // configured to do: it is also false when another live server holds the
      // database file and this one stood its scanner down.
      return json({ projects, scanning: scanningEnabled(), workspace: ws });
    }
    // Pick the project this cockpit is about (or null → the whole machine).
    // Applied live and persisted for the next launch.
    if (pathname === "/workspace" && req.method === "POST") {
      if (!trustedCaller(req, from)) return csrfBlocked();
      let b: any = {};
      try { b = await req.json(); } catch { return json({ ok: false, error: "invalid json" }, 400); }
      const res = setWorkspaceRoot(b.root == null ? null : String(b.root));
      // Catch the scanner up under the new scope BEFORE answering — silently,
      // so widening doesn't replay months of backfill as live events. The
      // client reloads on this response; answering earlier would show it a
      // dashboard the backfill hasn't reached yet.
      if (res.ok) await resyncScope();
      return json(res, res.ok ? 200 : 400);
    }
    /**
     * Add a project that is not on this machine yet — clone one, or start an
     * empty one. Both answer with the folder they made, which the picker then
     * opens exactly as if you had browsed to it.
     *
     * Same-origin only, like every other write: these create directories and
     * run git, and the browser is the only thing that should be asking. The
     * arguments are checked in projectadd.ts, where the reasoning lives.
     */
    if (pathname === "/projects/clone" && req.method === "POST") {
      if (!trustedCaller(req, from)) return csrfBlocked();
      let b: any = {};
      try { b = await req.json(); } catch { return json({ ok: false, error: "invalid json" }, 400); }
      const res = await cloneProject(b.url, b.parent);
      return json(res, res.ok ? 200 : 400);
    }
    /**
     * Stop offering a project — or offer it again.
     *
     * Only the picker's list: nothing is deleted, moved or forgotten anywhere
     * else, and the sweep goes on finding it. A path is remembered rather than
     * an entry removed, because an entry removed comes straight back on the
     * next sweep.
     */
    if (pathname === "/projects/hidden" && req.method === "POST") {
      if (!trustedCaller(req, from)) return csrfBlocked();
      let b: any = {};
      try { b = await req.json(); } catch { return json({ ok: false, error: "invalid json" }, 400); }
      const res = setProjectHidden(b.path, b.hidden !== false);
      return json(res, res.ok ? 200 : 400);
    }
    if (pathname === "/projects/new" && req.method === "POST") {
      if (!trustedCaller(req, from)) return csrfBlocked();
      let b: any = {};
      try { b = await req.json(); } catch { return json({ ok: false, error: "invalid json" }, 400); }
      const res = await createProject(b.name, b.parent);
      return json(res, res.ok ? 200 : 400);
    }
    // Claude Code hook wiring (#187): a packaged install can turn on live
    // streaming + gating from Settings instead of cloning the repo to run a
    // Python script. GET reports state; POST writes ~/.claude/settings.json with
    // the same idempotent, backup-first merge the CLI installer uses.
    /**
     * Which agents are on this machine, and whether any of them is talking.
     *
     * Connecting a second agent is where people stop — three questions (which
     * harness, which file, what to put in it) that the cockpit can answer by
     * looking. Everything not installed is listed too, because "what is
     * supported" is the question somebody has before they try.
     */
    if (pathname === "/agents") return json({ agents: probeAgents() });

    /**
     * Wire one, and only the one asked for.
     *
     * Claude Code goes through the same hook installer the Hooks pane uses; the
     * OTel agents go through connect_otel.py, which backs the file up, refuses
     * to touch a config it cannot parse, and leaves a hand-written `[otel]`
     * block alone. This route chooses which, and reports what the machine
     * looks like afterwards — including whether anything has actually arrived,
     * which a freshly written file never has.
     */
    if (pathname === "/agents/connect" && req.method === "POST") {
      if (!trustedCaller(req, from)) return csrfBlocked();
      let b: { id?: unknown; undo?: unknown };
      try { b = (await req.json()) as { id?: unknown; undo?: unknown }; } catch { return json({ ok: false, error: "invalid json" }, 400); }
      const id = typeof b.id === "string" ? b.id : "";
      const agent = ROSTER.find((a) => a.id === id);
      if (!agent) return json({ ok: false, error: "no such agent" }, 400);
      const undo = b.undo === true;

      if (agent.via === "hooks") {
        const r = applyHooks(undo ? "uninstall" : "install");
        return json({ ...r, agents: probeAgents() });
      }
      // A `chat` agent has no wiring to apply: it reports because this server
      // runs it. Refusing plainly beats spawning connect_otel.py with an id it
      // has never heard of and returning whatever that prints.
      if (agent.via === "chat") {
        return json({ ok: false, error: `${agent.label} needs no connecting — it reports through the chat panel that runs it`, agents: probeAgents() }, 400);
      }

      const dir = hooksDir();
      if (!dir) return json({ ok: false, error: "the connect script is not bundled with this build" }, 400);
      const args = [joinPath(dir, "connect_otel.py"), "--only", id, ...(undo ? ["--undo"] : [])];
      const p = Bun.spawnSync([hookPython(), ...args], {
        // A named environment. The script refuses any server but this machine
        // unless told otherwise, and inheriting an AGENTGLASS_ALLOW_REMOTE from
        // whatever launched the app would quietly widen that.
        env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
      });
      const out = (p.stdout?.toString() ?? "") + (p.stderr?.toString() ?? "");
      return json({
        ok: p.exitCode === 0,
        // The script's own words. It knows things this route does not — that a
        // config was already pointing here, or that the user has an `[otel]`
        // block of their own that it will not touch.
        detail: out.trim().split("\n").filter(Boolean).slice(-4).join("\n"),
        agents: probeAgents(),
      }, p.exitCode === 0 ? 200 : 400);
    }

    if (pathname === "/hooks/status") return json(hookStatus());
    if ((pathname === "/hooks/install" || pathname === "/hooks/uninstall") && req.method === "POST") {
      if (!trustedCaller(req, from)) return csrfBlocked();
      return json(applyHooks(pathname === "/hooks/install" ? "install" : "uninstall"));
    }

    /**
     * Budgets: what is set, and where each stands right now.
     *
     * Reading is like reading the cost chart beside it — a limit and what has
     * been spent against it is the same class of fact. Writing is a local
     * decision like every other setting, so it goes through the origin gate.
     */
    if (pathname === "/budgets" && req.method === "GET") {
      return json({ budgets: readBudgets(), status: budgetStatus(), models: costedModels() });
    }
    if (pathname === "/budgets/set" && req.method === "POST") {
      if (!trustedCaller(req, from)) return csrfBlocked();
      let b: { budgets?: unknown };
      try { b = (await req.json()) as { budgets?: unknown }; } catch { return json({ ok: false, error: "invalid json" }, 400); }
      if (!Array.isArray(b.budgets)) return json({ ok: false, error: "expected a list of budgets" }, 400);
      // Refused on the way in, not silently dropped. readBudgets() skips what it
      // cannot use, so a bad row accepted here would vanish on the next read and
      // look exactly like a save that did nothing.
      const clean: Budget[] = [];
      for (const raw of b.budgets as Partial<Budget>[]) {
        if (!raw || typeof raw !== "object") return json({ ok: false, error: "that is not a budget" }, 400);
        // A *number*, not something Number() can be talked into. `"40"`
        // coerces to forty and readBudgets() then refuses it on the next read,
        // so the save would appear to work and silently do nothing — which is
        // the exact failure the validation on both sides exists to prevent.
        const limit = raw.limit;
        if (typeof limit !== "number" || !Number.isFinite(limit) || limit <= 0) {
          return json({ ok: false, error: "a budget needs a limit above zero" }, 400);
        }
        if (raw.period !== "day" && raw.period !== "week" && raw.period !== "month") {
          return json({ ok: false, error: "a budget needs a period of day, week or month" }, 400);
        }
        clean.push({
          root: typeof raw.root === "string" ? raw.root : "",
          model: typeof raw.model === "string" ? raw.model : "",
          limit, period: raw.period,
        });
      }
      const r = writeBudgets(clean);
      if (!r.ok) return json(r, 400);
      return json({ ...r, budgets: readBudgets(), status: budgetStatus() });
    }

    if (pathname === "/insights") return json({ insights: getInsights() });
    if (pathname === "/usage") return json(await getUsage()); // Anthropic plan-limit windows (only meaningful for Claude)
    // Every provider's plan quota in one shape — the dashboard box, the Stats
    // section and the notch all read this one answer. No desktop-only gate:
    // there is no path on disk in the payload and nothing here can act.
    if (pathname === "/usage/providers") return json(await allProviderUsage());

    /*
     * A live Claude Code session handing over the plan windows it got for free
     * with its last API response — see hooks/statusline.sh and usage.ts.
     *
     * Authenticated like everything else rather than joining the tokenless
     * intake sinks. Those are append-only telemetry from a process that has no
     * way to carry a secret; this one does — it runs as the user and reads the
     * same token file the server does. And unlike an event, what arrives here
     * *replaces* what the meters say, so on a server bound to anything but
     * loopback a tokenless version would let anyone on the network decide what
     * this machine believes about its own plan.
     */
    if (pathname === "/statusline" && req.method === "POST") {
      let body: unknown;
      try {
        body = await req.json();
      } catch {
        return json({ error: "invalid json" }, 400);
      }
      // `used: false` is a real answer, not a failure: most payloads carry no
      // rate_limits at all (the CLI only sends them for subscriber sessions,
      // and only after the first response of the session).
      return json({ ok: true, used: ingestStatusline(body) });
    }

    // --- control plane: gate ---
    if (pathname === "/gate" && req.method === "POST") {
      let b: any = {};
      try { b = await req.json(); } catch { return json({ decision: "allow", reason: "bad request" }); }
      const ti = b.tool_input ?? {};
      const summary = String(ti.command || ti.file_path || ti.path || ti.pattern || ti.query || ti.description || b.tool_name || "").slice(0, 300);
      const decision = await submitGate(
        // The hook picks the id so it can re-attach to this exact request after
        // a dropped connection (see /gate/status). Shape-checked in gate.ts;
        // anything else falls back to a server-generated one.
        { id: typeof b.id === "string" ? b.id : undefined, source_app: String(b.source_app || "unknown"), session_id: String(b.session_id || "unknown"), tool_name: String(b.tool_name || "?"), summary },
        Math.min(GATE_MAX_MS, Number(b.timeout_ms) || 60_000)
      );
      return json(decision);
    }
    // Re-attach to a request whose connection dropped — a server restart, a
    // proxy hanging up. Holds open like /gate does when it's still pending,
    // answers immediately when it's already decided, and 404s on an id it has
    // never heard of so the hook falls back to its own policy instead of
    // reading "no answer" as an approval.
    if (pathname === "/gate/status") {
      const out = await awaitGate(String(url.searchParams.get("id") || ""));
      return out ? json(out) : json({ decision: null, reason: "unknown gate" }, 404);
    }
    if (pathname === "/gate/pending") return json({ gates: pendingGates() });
    // What was decided while you weren't looking — including the requests a
    // timeout or a restart resolved for you.
    if (pathname === "/gate/history") {
      // `reason` is narrowed to what a person typed. The stored one is
      // backfilled with a paragraph written for the stopped model, and a
      // history quoting that back is boilerplate on every row — see
      // typedReason().
      return json({
        gates: gateHistory(Number(url.searchParams.get("limit") || 50))
          .map((g) => ({ ...g, reason: typedReason(g) || null })),
      });
    }
    if (pathname === "/gate/decide" && req.method === "POST") {
      if (!trustedCaller(req, from)) return csrfBlocked();
      let b: any = {};
      try { b = await req.json(); } catch { return json({ ok: false }); }
      const decision = b.decision === "deny" ? "deny" : "allow";
      // Read the row BEFORE deciding: afterwards it is resolved, and what makes
      // the line worth keeping is what was held, not the uuid it was held
      // under. "denied Bash · rm -rf build" is an audit line; a uuid is not.
      const held = getGate(String(b.id));
      // "Who approved that" is the question #299 opens with, and a gate is the
      // one write with a stopped agent on the other end of it. Resolved once
      // and handed to both writers, so the gate row and the log line cannot
      // name two different people for one press.
      const who = actorOf(clientIp, caller);
      const ok = decideGate(String(b.id), decision, String(b.reason || ""), who);
      /*
       * Why it did not take, in words.
       *
       * A press only fails for one interesting reason: something already
       * resolved the request — usually the clock, occasionally somebody else's
       * phone — and the agent has already been told the other answer. That is
       * the most confusing thing that can happen in this feature, and it left a
       * bare ✕ in the log next to a gate row saying the opposite. The line has
       * to explain itself, because the record of the press that lost is the
       * only place the two can be reconciled.
       */
      // `held` is enough, and re-reading here would be a guard nothing could
      // ever show working: it and `decideGate` are adjacent *synchronous*
      // statements, so the expiry timer cannot fire between them. If this ever
      // grows an `await` in the middle, that stops being true and the row has
      // to be read again.
      const error = ok ? undefined
        : !held?.decision ? "that request is not one this server is holding"
        : `already ${held.decision === "deny" ? "denied" : "allowed"} by ${
            held.resolution === "human" ? "somebody else" : "the timeout"} — this answer arrived too late`;
      noteAction(clientIp, `/gate/${decision}`,
        { tool: held?.tool_name, summary: held?.summary }, { ok, error }, caller);
      return json({ ok, ...(error ? { error } : {}) });
    }
    // Drive the dashboard's own UI from outside — a Stream Deck, a phone. Unlike
    // every other route this one changes only what is *shown*: it validates a
    // navigation command and rebroadcasts it to every client, which run it
    // through the same setters the keyboard uses. It grants no capability the
    // keyboard doesn't already, so it needs no gate beyond the localOrigin +
    // token checks the whole surface already carries.
    if (pathname === "/control" && req.method === "POST") {
      if (!trustedCaller(req, from)) return csrfBlocked();
      let b: unknown = {};
      try { b = await req.json(); } catch { return json({ ok: false, error: "invalid json" }, 400); }
      const cmd = parseControlCmd(b);
      if (!cmd) return json({ ok: false, error: "unknown control command" }, 400);
      broadcast({ type: "control", data: cmd });
      return json({ ok: true });
    }
    /**
     * Whether an agent could drive this browser at all, and what is missing.
     *
     * Under `/browser-use/` and not `/browser/` deliberately: the relay below
     * claims every POST under that prefix and hands the tail to parseAsk, so a
     * setup route parked there would come back "unknown browser operation" and
     * read as a broken panel.
     */
    if (pathname === "/browser-use/status") {
      return json(browserUseStatus(browserReadyCount(), true));
    }
    if (pathname === "/browser-use/install" && req.method === "POST") {
      if (!trustedCaller(req, from)) return csrfBlocked();
      const res = installSkill();
      return json(res, res.ok ? 200 : 400);
    }

    /**
     * Drive the built-in browser — the one with your logins in it.
     *
     * `/browser/<op>`, one closed verb each, relayed to the window and answered
     * with what actually happened (see browserdrive.ts). This is the surface an
     * agent reaches from its shell, so it carries the same origin + token gate
     * as everything else and offers no way to run script of its own choosing.
     *
     * The data routes under /browser/ — the history save, the visit record and
     * the forget — are NOT drive ops; they are handled further down. They must
     * be excluded here or this relay claims them first and answers "unknown
     * browser operation", which is the very trap the /browser-use/ comment above
     * warns about. Left in, it silently broke both history import and own-visit
     * recording: every POST /browser/places came back 400, places.db stayed
     * empty, and the address bar had nothing of yours to complete.
     */
    const browserDataPost = pathname === "/browser/places" || pathname === "/browser/places/forget" || pathname === "/browser/visit";
    if (pathname.startsWith("/browser/") && req.method === "POST" && !browserDataPost) {
      if (!trustedCaller(req, from)) return csrfBlocked();
      const op = pathname.slice("/browser/".length);
      if (op === "ready") {
        // A window saying it has a browser panel that can answer. Heartbeat, so
        // a window that dies without saying goodbye stops being counted.
        let b: any = {};
        try { b = await req.json(); } catch { return json({ ok: false, error: "invalid json" }, 400); }
        return json({ ok: noteBrowserReady(b.client, b.on !== false) });
      }
      if (op === "result") {
        // The window reporting back. Not an agent-facing route.
        let b: any = {};
        try { b = await req.json(); } catch { return json({ ok: false, error: "invalid json" }, 400); }
        const known = settleBrowser(b.id, { ok: b.ok === true, value: b.value, error: typeof b.error === "string" ? b.error : undefined });
        return json({ ok: true, known });
      }
      let b: unknown = {};
      try { b = await req.json(); } catch { b = {}; }
      const parsed = parseAsk(op as BrowserOp, b);
      if ("error" in parsed) return json({ ok: false, error: parsed.error }, 400);
      const reply = await askBrowser(parsed.ask);
      return json(reply, reply.ok ? 200 : 409);
    }

    /**
     * Where this server can be reached from another device, and whether one
     * ever has been.
     *
     * The token is handed out only to a caller on this machine. A page loaded
     * over the LAN has already proved it holds the token to get this far, so
     * withholding it is not a secret kept from a legitimate client — it is a
     * refusal to *re-serve* the credential to whatever else is on the wifi if
     * the token is ever set aside. The local UI is the only thing that needs it
     * anyway: it is what draws the QR code.
     */
    /**
     * Cut a device off, or let it back in.
     *
     * Only from this machine. A phone that already holds the code must not be
     * able to disconnect the laptop next to it, and an address-level block is
     * exactly the kind of control that has to stay on the side of the desk the
     * user is sitting at.
     *
     * Blocking closes what it is holding as well as refusing what it sends
     * next. Half of it — refusing new requests while an open terminal keeps
     * streaming — would be the worst of both: it looks disconnected in the
     * panel and is not disconnected on the wire.
     */
    if (pathname === "/remote/device" && req.method === "POST") {
      const ip = clientIp ?? null;
      if (!ip || !isLoopback(ip)) return json({ ok: false, error: "only this machine can disconnect a device" }, 403);
      let b: { address?: unknown; blocked?: unknown };
      try { b = (await req.json()) as { address?: unknown; blocked?: unknown }; } catch { return json({ ok: false, error: "invalid json" }, 400); }
      const address = typeof b.address === "string" ? b.address : "";
      const blocked = b.blocked !== false;
      if (!address) return json({ ok: false, error: "no address" }, 400);
      // Said before the store is asked, so the message names the real reason
      // rather than "no such device": blocking an address this machine answers
      // on would cut off the window the button was pressed in.
      if (blocked && isSelf(address)) return json({ ok: false, error: "that address is this machine" }, 400);
      if (!blockDevice(address, blocked)) return json({ ok: false, error: "no such device" }, 404);
      let closed = 0;
      if (blocked) {
        for (const ws of [...sockets]) {
          if (ws.data?.ip && ws.data.ip.replace(/^::ffff:/, "") === address) {
            try { ws.close(1008, "disconnected from the host machine"); closed++; } catch { /* already gone */ }
          }
        }
      }
      return json({ ok: true, address, blocked, closed });
    }
    if (pathname === "/remote/status") {
      return json(
        remoteStatus({
          bind: BIND,
          port: srv.port ?? PORT,
          trustLan: TRUST_LAN,
          token: AUTH_TOKEN,
          webUi: WEB_UI_ENABLED,
        })
      );
    }
    /**
     * --- pairing a device ---
     *
     * The protocol is in pairing.ts, including why it has the shape it does.
     * What lives here is the split it depends on: four routes that only this
     * machine may call, and three that must work with no credential at all,
     * because handing one out is the point.
     *
     * `atMachine` is the stronger of the two checks the codebase already uses.
     * Loopback alone would let any other local process start a pairing; the
     * token alone would let a phone that is already paired invite another one.
     * Minting an invitation, seeing the code, and accepting a request are the
     * three things that must happen where the user is sitting.
     */
    const atMachine = (): boolean => {
      const ip = clientIp ?? null;
      if (!ip || !isLoopback(ip)) return false;
      return !AUTH_TOKEN || tokenOk(req, url, AUTH_TOKEN);
    };
    const notHere = () => json({ ok: false, error: "only this machine can do that" }, 403);

    if (pathname === "/pair/ticket" && req.method === "POST") {
      if (!atMachine()) return notHere();
      const t = mintTicket();
      // Refused rather than queued: several unanswered invitations at once is
      // not a person adding a phone, and quietly making room by discarding one
      // somebody is looking at is worse than saying no.
      if (!t) return json({ ok: false, error: "too many pairings in progress — answer or wait for the ones open" }, 429);
      return json({ ok: true, id: t.id, code: t.code, expiresAt: t.expiresAt });
    }

    if (pathname === "/pair/cancel" && req.method === "POST") {
      if (!atMachine()) return notHere();
      let b: { ticket?: unknown };
      try { b = (await req.json()) as { ticket?: unknown }; } catch { return json({ ok: false, error: "invalid json" }, 400); }
      dropTicket(typeof b.ticket === "string" ? b.ticket : "");
      return json({ ok: true });
    }

    if (pathname === "/pair/state") {
      if (!atMachine()) return notHere();
      // The ticket the pane is showing is identified by the pane, not held as
      // "the current one": two windows open on the same machine each have
      // their own invitation, and a server-side notion of *the* ticket would
      // have one of them drawing a QR for the other one's code.
      const id = url.searchParams.get("ticket") || "";
      const t = id ? getTicket(id) : null;
      return json({
        ticket: t ? { id: t.id, code: t.code, expiresAt: t.expiresAt } : null,
        pending: pendingPairings(),
        // Without the credential hash: the pane draws a label, a scope and two
        // timestamps, and the hash is the one field on a device that is a
        // secret. See publicDevice.
        devices: activeDevices().map(publicDevice),
      });
    }

    if (pathname === "/pair/accept" && req.method === "POST") {
      if (!atMachine()) return notHere();
      let b: { ticket?: unknown; scope?: unknown };
      try { b = (await req.json()) as { ticket?: unknown; scope?: unknown }; } catch { return json({ ok: false, error: "invalid json" }, 400); }
      // Anything unrecognised lands on the narrow scope rather than the wide
      // one. A typo in a scope name must not be how a phone gets a terminal.
      const asked = b.scope;
      const scope: Scope = asked === "read" || asked === "full" ? asked : "answer";
      const r = acceptTicket(typeof b.ticket === "string" ? b.ticket : "", scope);
      if (!r.ok) return json({ ok: false, error: r.error === "unknown" ? "that request expired" : "that request is not waiting on you" }, 404);
      return json({ ok: true, device: publicDevice(r.device) });
    }

    if (pathname === "/pair/reject" && req.method === "POST") {
      if (!atMachine()) return notHere();
      let b: { ticket?: unknown };
      try { b = (await req.json()) as { ticket?: unknown }; } catch { return json({ ok: false, error: "invalid json" }, 400); }
      return json({ ok: rejectTicket(typeof b.ticket === "string" ? b.ticket : "") });
    }

    /**
     * Cut one device off, and only that one.
     *
     * The revoke that already existed rotates the machine's token, which kicks
     * every device including the desk — the right answer when you have lost
     * control of the code, and far too big a hammer for "that tablet is in a
     * drawer". This is the small one.
     */
    if (pathname === "/pair/forget" && req.method === "POST") {
      if (!atMachine()) return notHere();
      let b: { id?: unknown };
      try { b = (await req.json()) as { id?: unknown }; } catch { return json({ ok: false, error: "invalid json" }, 400); }
      const id = typeof b.id === "string" ? b.id : "";
      if (!revokeDevice(id)) return json({ ok: false, error: "no such device" }, 404);
      // Its open sockets go with it. Revoking a credential while the terminal
      // it opened keeps streaming is the worst of both: the list says gone and
      // the wire says otherwise.
      let closed = 0;
      for (const ws of [...sockets]) {
        if (ws.data?.deviceId === id) {
          try { ws.close(1008, "this device was disconnected from the host machine"); closed++; } catch { /* already gone */ }
        }
      }
      return json({ ok: true, closed });
    }

    // --- the three the phone calls, before it has anything to authenticate with ---

    /** Is this invitation still open? Lets the phone say "that code expired"
     *  instead of presenting a form that cannot succeed. */
    if (pathname === "/pair/info") {
      const t = getTicket(url.searchParams.get("ticket") || "");
      return json({ ok: !!t && t.state === "waiting", expiresAt: t?.expiresAt ?? null });
    }

    if (pathname === "/pair/claim" && req.method === "POST") {
      let b: { ticket?: unknown; code?: unknown; label?: unknown; pub?: unknown };
      try { b = (await req.json()) as typeof b; } catch { return json({ ok: false, error: "invalid json" }, 400); }
      const r = claimTicket(
        typeof b.ticket === "string" ? b.ticket : "",
        typeof b.code === "string" ? b.code : "",
        {
          label: typeof b.label === "string" ? b.label : "",
          pub: typeof b.pub === "string" ? b.pub : undefined,
          agent: req.headers.get("user-agent") ?? "",
          ip: clientIp ?? "",
        },
      );
      if (r.ok) return json({ ok: true, secret: r.secret });
      const said =
        r.error === "unknown" ? "that invitation has expired — start a new one on the computer"
        : r.error === "taken" ? "another device is already using that invitation"
        : r.error === "locked" ? `too many wrong codes — the invitation is closed, start a new one on the computer`
        : r.error === "shape" ? "this browser could not generate a key for the connection"
        : `that code is wrong — ${r.left} ${r.left === 1 ? "try" : "tries"} left of ${MAX_ATTEMPTS}`;
      return json({ ok: false, error: said, left: r.left, reason: r.error }, r.error === "code" ? 401 : 410);
    }

    /**
     * The phone picks up what it was given.
     *
     * Polled, because the thing it is waiting for is a person walking to a
     * computer. Answers `claimed` until they decide, and hands the sealed
     * credential over exactly once — see collect().
     */
    if (pathname === "/pair/collect") {
      const r = collectPairing(url.searchParams.get("ticket") || "", url.searchParams.get("secret") || "");
      return json(r, r.state === "unknown" ? 404 : 200);
    }

    /** What this device is, as this server sees it. The phone's Settings shows
     *  it, and a 401 here is how it learns it has been forgotten. */
    if (pathname === "/pair/whoami") {
      if (!AUTH_TOKEN) return json({ paired: false, scope: "full", machine: true });
      const caller = callerFor(req, url, AUTH_TOKEN);
      if (!caller) return json({ paired: false }, 401);
      return json({
        paired: caller.kind === "device",
        machine: caller.kind === "machine",
        scope: caller.scope,
        label: caller.device?.label ?? null,
        id: caller.device?.id ?? null,
      });
    }

    if (pathname === "/search") {
      const q = url.searchParams.get("q") || "";
      const limit = Math.min(200, Number(url.searchParams.get("limit") || 60));
      return json({ hits: q.trim() ? searchEvents(q, limit) : [] });
    }
    if (pathname === "/changes") {
      const limit = Math.min(500, Number(url.searchParams.get("limit") || 200));
      const changes = getChanges(limit);
      // One `git check-ignore` per repo, not per file, so the client can fold
      // away build output without having to guess at .gitignore semantics.
      const ignored = markIgnored(changes.map((c) => c.file_path));
      /**
       * Which of these edits are not this project's.
       *
       * A session is in scope because its cwd is, and it then writes wherever
       * it likes: a note under ~/Documents, a scratch script in /tmp. Those are
       * real edits by a real session of this project — so they are recorded —
       * but they are not the project, and in a list of 200 they push the code
       * you opened this view to review off the screen.
       *
       * Decided here rather than in the client because "part of the project"
       * means the repo AND its linked worktrees — orbit-WEB-1042 is orbit —
       * and only the server has git and the scope to answer that.
       *
       * `project` rides along so the chip can name what it filtered against.
       * The client has the workspace too, but a label from one source and a
       * filter from another is how a button ends up lying about what it did.
       */
      const scope = workspaceRoot();
      return json({
        project: scope ? basename(scope) : null,
        changes: changes.map((c) => ({
          ...c,
          ignored: ignored.get(c.file_path) === true,
          // Unscoped there is no project to be outside of, and the flag stays
          // off rather than becoming "everything" — absent means never hidden.
          outside: scope ? !inScope(c.file_path, scope) : false,
        })),
      });
    }

    // --- commit composer: live git working-tree status + commit ---
    if (pathname === "/git/status" && req.method === "POST") {
      if (!localOrigin(req)) return csrfBlocked();
      let b: any = {};
      try { b = await req.json(); } catch { return json({ error: "invalid json" }, 400); }
      const paths = Array.isArray(b.paths) ? b.paths.filter((p: unknown) => typeof p === "string").slice(0, 500) : [];
      return json({ repos: await statusForPaths(paths), commitEnabled: COMMIT_ENABLED });
    }
    if (pathname === "/git/commit" && req.method === "POST") {
      if (!trustedCaller(req, from)) return csrfBlocked();
      let b: any = {};
      try { b = await req.json(); } catch { return json({ ok: false, error: "invalid json" }, 400); }
      const res = gitCommit(String(b.root || ""), Array.isArray(b.files) ? b.files : [], String(b.title || ""), String(b.body || ""));
      return json(res, res.ok ? 200 : 400);
    }

    // --- live git panel (lazygit-style working tree) ---
    // Is git even installed? A plain read like the rest of /git/*, so the
    // surface-wide origin/rebinding gate is the whole authorisation story.
    if (pathname === "/git/capability") return json(gitCapability());
    // Every outside tool at once, for the Requirements pane. The per-panel
    // capability routes above stay: each panel needs its own answer to render,
    // and this one exists for the question none of them can answer alone.
    // `force=1` is the Recheck button, which is the only reason a caller would
    // want to pay for the probes again inside the cache window.
    if (pathname === "/dependencies") return json(await dependencyReport(url.searchParams.get("force") === "1"));
    if (pathname === "/git/repos") {
      // `all=1` is the project picker: it needs the whole machine even when the
      // cockpit is currently scoped to one project, or there'd be no way out.
      const ignoreScope = url.searchParams.get("all") === "1";
      // Single-flighted: this sweep is a `git status` per repo across every
      // checkout, and several open tabs asking at the same instant would each
      // launch the whole fan-out. They share one now. (The 15s repoCache behind
      // it still handles reuse across time; this handles reuse across callers.)
      return body(await singleFlight(`repos:${ignoreScope}`, async () => {
        const paths = getChanges(300).map((c) => c.file_path);
        // `hidden` rides along rather than being filtered out here: the picker
        // is the one surface that has to be able to show them again, and a list
        // it cannot see is a list it cannot restore from.
        return JSON.stringify({
          repos: await discoverRepos(paths, knownProjects().map((p) => p.path), { ignoreScope }),
          hidden: hiddenProjects(),
        });
      }));
    }
    // Directory completion for the project picker's free-text path input. A
    // plain read, so the surface-wide origin/rebinding/token gate above is the
    // whole authorisation story — same as /git/repos. See fsbrowse.ts for why
    // it isn't confined to the configured repoDirs.
    if (pathname === "/fs/complete") {
      // Its own switch, not the terminal's: an operator who disabled the shell
      // gave up filesystem reach on purpose, and this must not hand it back.
      if (!FS_BROWSE_ENABLED) return json({ error: "directory browsing is disabled (AGENTGLASS_FS_BROWSE_DISABLED=1)" }, 403);
      return json(completePath(url.searchParams.get("prefix") || ""));
    }
    if (pathname === "/git/tree") {
      const root = url.searchParams.get("root") || "";
      // The 1s cache handles the 2.5s re-poll; single-flight handles the tabs
      // that miss it together. workingTree is four git reads on the loop, so
      // one caller doing them for all is the difference under a fan-out.
      return body(await singleFlight(`tree:${root}`, async () => {
        const hit = treeCache.get(root);
        if (hit && Date.now() - hit.at < TREE_TTL_MS * backoff()) return JSON.stringify(hit.data);
        const data = await workingTree(root);
        if (treeCache.size > 40) treeCache.clear();
        treeCache.set(root, { at: Date.now(), data });
        return JSON.stringify(data);
      }));
    }
    if (pathname === "/git/changes-all") {
      // What each in-scope worktree has changed, in one list for File changes.
      // Two modes: "working" — the working tree (staged + unstaged + untracked),
      // what is uncommitted right now; and "committed" — each checkout's LAST
      // commit, so a change survives being committed instead of vanishing with
      // the working tree. Deliberately not the branch-vs-base diff either way: on
      // a branch that merged master that drags in every file the merge brought,
      // work that is not yours. Cached per mode, single-flighted.
      const mode = url.searchParams.get("mode") === "committed" ? "committed" : "working";
      return body(await singleFlight(`changes-all:${mode}`, async () => {
        const cached = changesAllCache.get(mode);
        if (cached && Date.now() - cached.at < CHANGES_ALL_TTL_MS * backoff()) return cached.body;
        const paths = getChanges(300).map((c) => c.file_path);
        // Only your branches: the trunk checkout (master/main) is the base you
        // cut from, not something you are working on, so it stays out of File
        // changes entirely — and out of the cap below.
        const repos = (await discoverRepos(paths, knownProjects().map((p) => p.path), {}))
          .filter((r) => r.branch !== "master" && r.branch !== "main");
        // A stable NEGATIVE id per (file, key): the recorded-edit list keys
        // selection, review and dedup off the positive DB event id, so a git row
        // must never collide with one — and must keep the same id across polls,
        // or the selected file jumps and a review tick is lost every few seconds.
        const sid = (s: string): number => {
          let h = 5381;
          for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
          return -Math.abs(h) - 1;
        };
        let changes: unknown[];
        if (mode === "committed") {
          // Same read-through-cache shape as working mode's treeCache below.
          const commitOf = async (root: string) => {
            const hit = commitCache.get(root);
            if (hit && Date.now() - hit.at < TREE_TTL_MS * backoff()) return hit.data;
            const data = await lastCommitChanges(root);
            if (commitCache.size > 40) commitCache.clear();
            commitCache.set(root, { at: Date.now(), data });
            return data;
          };
          const perRepo = await Promise.all(repos.map(async (r) => {
            try {
              const { subject, changes: cs } = await commitOf(r.root);
              // session_id carries the commit subject so a Session grouping heads
              // each worktree's rows with what the commit was.
              return cs.map((c) => ({ ...c, session_id: subject || "last commit" }));
            } catch { return []; }
          }));
          changes = perRepo.flat().map((c) => ({ ...c, id: sid(`${c.session_id}\0${c.file_path}`), ignored: false, outside: false }));
        } else {
          const trees = await Promise.all(repos.map(async (r) => {
            const hit = treeCache.get(r.root);
            if (hit && Date.now() - hit.at < TREE_TTL_MS * backoff()) return hit.data;
            try {
              const data = await workingTree(r.root);
              if (treeCache.size > 40) treeCache.clear();
              treeCache.set(r.root, { at: Date.now(), data });
              return data;
            } catch { return null; }
          }));
          changes = trees.flatMap((t) =>
            t && !t.error
              ? [...t.staged, ...t.unstaged].map((c) => ({ ...c, id: sid(`${c.session_id}\0${c.file_path}`), ignored: false, outside: false }))
              : []);
        }
        const out = JSON.stringify({ changes: changes.slice(0, CHANGES_ALL_MAX) });
        changesAllCache.set(mode, { at: Date.now(), body: out });
        return out;
      }));
    }
    if (pathname === "/git/branches") {
      const root = url.searchParams.get("root") || "";
      return body(await singleFlight(`branches:${root}`, () => whileRefsHoldAsync(`branches:${root}`, root, () => gitBranches(root))));
    }
    // `scope=all` is the whole graph; anything else is this checkout's own
    // history, which is what the pane defaults to.
    if (pathname === "/git/graph") {
      const root = url.searchParams.get("root") || "";
      const limit = Number(url.searchParams.get("limit") || 400);
      const scope = url.searchParams.get("scope") === "all" ? "all" : "head";
      const key = `graph:${root}:${limit}:${scope}`;
      return body(await singleFlight(key, () => whileRefsHoldAsync(key, root, () => logGraph(root, limit, scope))));
    }
    if (pathname === "/git/worktrees") {
      const root = url.searchParams.get("root") || "";
      // The heaviest git read the panel polls: a worktree list plus a status,
      // base and rev-list per checkout — a dozen-plus subprocesses on a
      // worktree-heavy repo. Concurrent identical polls collapse via single-flight;
      // a short TTL cache (× backoff) holds the assembled answer across the poll
      // and the burst a scope switch fires, cleared on any write by the git hook.
      return body(await singleFlight(`worktrees:${root}`, async () => {
        const hit = worktreesCache.get(root);
        if (hit && Date.now() - hit.at < WORKTREES_TTL_MS * backoff()) return hit.body;
        const b = JSON.stringify({ worktrees: await gitWorktrees(root) });
        if (worktreesCache.size > 40) worktreesCache.clear();
        worktreesCache.set(root, { at: Date.now(), body: b });
        return b;
      }));
    }
    // What a worktree removal would destroy, per path — asked before offering
    // the removal, never after. Repeatable `path=` so the bulk delete can price
    // every worktree it is about to touch in one round trip; concurrent because
    // each is a `git status --ignored` and a dozen sequential ones is a second.
    if (pathname === "/git/worktree-leftovers") {
      const root = url.searchParams.get("root") || "";
      const paths = url.searchParams.getAll("path").slice(0, 50);
      return json({ leftovers: await Promise.all(paths.map((p) => worktreeLeftovers(root, p))) });
    }
    // Update: the full status reveals the source path on disk, the remote it
    // pulls from and the last run's log tail, so it stays desktop-only. Refusing
    // everyone else outright was too blunt, though — the About pane reads this
    // for the version number and nothing else offers one, so every browser tab
    // showed a pane stuck on "Reading version…". A caller the origin gate above
    // already admitted gets the build's identity with the provenance stripped.
    if (pathname === "/update/status") {
      return json(desktopOnly(req) ? await updateStatus() : viewerStatus());
    }
    // What changed in the release this build came from. Open to whoever may
    // read the status above, for the same reason and as its other half: the
    // About pane offers these notes whenever the build descends from a tag, so
    // gating them left a browser with a button that could only ever fail. The
    // answer is a published release's text, its tag, and whether it came from
    // the clone or from github — the origin URL and the install path are not in
    // it, and `tag` is refused unless it looks like a release.
    if (pathname === "/update/notes") {
      return json(await releaseNotes(url.searchParams.get("tag") || undefined));
    }
    if (pathname === "/update/log") {
      if (!desktopOnly(req)) return csrfBlocked();
      return json(updateLog());
    }
    if (pathname === "/git/conflicts") return json(gitConflicts(url.searchParams.get("root") || ""));
    if (pathname === "/git/conflict-blocks") return json(conflictBlocks(url.searchParams.get("root") || "", url.searchParams.get("path") || ""));
    if (pathname === "/git/merge-session") return json(mergeSession(url.searchParams.get("root") || ""));
    if (pathname === "/git/conflict-file") return json(conflictFile(url.searchParams.get("root") || "", url.searchParams.get("path") || ""));
    if (pathname === "/git/merge-info") return json(mergeInfo(url.searchParams.get("root") || ""));
    if (pathname === "/git/base-candidates") return json(baseCandidates(url.searchParams.get("root") || ""));
    if (pathname === "/git/log") return json({ commits: gitLog(url.searchParams.get("root") || "", Number(url.searchParams.get("limit") || 100)) });
    if (pathname === "/git/commit-diff") return json({ changes: commitDiff(url.searchParams.get("root") || "", url.searchParams.get("hash") || "") });
    if (pathname === "/git/stashes") return json({ stashes: stashList(url.searchParams.get("root") || "") });
    // What has piled up in a checkout, and the command that would clear it.
    // Read-only by construction: the response carries commands as strings, and
    // there is deliberately no endpoint anywhere that runs one.
    if (pathname === "/git/tidy") return json(tidyReport(url.searchParams.get("root") || ""));
    // Every git command this server has run — the command log panel.
    if (pathname === "/git/commandlog") return json({ entries: gitCommandLog(Number(url.searchParams.get("since") || 0)) });
    // Every moment this process stopped answering, and what was running. The
    // terminal rides this loop, so these ARE the freezes the user feels.
    if (pathname === "/api/loopwatch") return json({ ...stalls(Number(url.searchParams.get("since") || 0)), spawns: spawnPoolStats(), coalescing: inflightCount() });
    // Open a file at a line in the editor the user already has running.
    if (pathname === "/editor/target") return json({ ...(await editorTarget(url.searchParams.get("path") || "")), hasNvim: HAS_NVIM });
    if (pathname === "/git/remotes") return json({ remotes: gitRemotes(url.searchParams.get("root") || "") });
    // Every branch on one remote, as the last fetch left them. Whole, not
    // paged — see remoteBranches() for why.
    if (pathname === "/git/remote-branches") return json(gitRemoteBranches(url.searchParams.get("root") || "", url.searchParams.get("remote") || ""));
    if (pathname === "/git/tags") {
      // 125 tags is one `for-each-ref` and cheap, but it is on the same 10s poll
      // and answers from the same refs — free to include. Awaited like the other
      // refs-held reads so its for-each-ref stays off the terminal's thread.
      const root = url.searchParams.get("root") || "";
      return body(await whileRefsHoldAsync(`tags:${root}`, root, async () => ({ tags: await gitTags(root) })));
    }
    if (pathname === "/git/reflog") return json({ entries: gitReflog(url.searchParams.get("root") || "", Number(url.searchParams.get("limit") || 200)) });
    // Carry the cockpit's palette out to tmux and nvim — see themesync.ts.
    if (pathname === "/editor/capability") return json(editorCapability());
    if (pathname === "/theme/status") return json({ ...snippetStatus(), snippets: SNIPPETS });
    /*
     * What this machine is wearing, so a paired phone can wear it too.
     *
     * A read, so any device scope reaches it — a phone that may only look at
     * things may certainly know what colour they are. `theme: null` means
     * nobody has picked one and the client should keep its own defaults, which
     * is a different answer from a palette and has to stay distinguishable.
     */
    if (pathname === "/theme/current") return json({ theme: currentTheme() });
    if (pathname === "/theme/sync" && req.method === "POST") {
      if (!trustedCaller(req, from)) return csrfBlocked();
      let b: any = {};
      try { b = await req.json(); } catch { return json({ ok: false, error: "invalid json" }, 400); }
      return json(await syncTheme(b.vars ?? {}, String(b.name ?? "custom")));
    }

    if (pathname === "/editor/open" && req.method === "POST") {
      if (!trustedCaller(req, from)) return csrfBlocked();
      let b: any = {};
      try { b = await req.json(); } catch { return json({ ok: false, error: "invalid json" }, 400); }
      return json(await openInEditor(b.path, b.line));
    }

    /* An image an agent can read. See shots.ts: a tmux window takes text, and a
       megabyte of base64 pasted into a shell is not text. */
    /* The pages brought over from another browser. The shell does the reading
       (see ag:browserPlaces); this only keeps them and hands them back to the
       address bar. */
    if (pathname === "/browser/places" && req.method === "POST") {
      if (!trustedCaller(req, from)) return csrfBlocked();
      const b = await req.json().catch(() => ({})) as Record<string, unknown>;
      const source = String(b.source ?? "");
      const rows = Array.isArray(b.places) ? b.places : [];
      if (!source) return json({ ok: false, error: "no source" });
      const clean = rows
        .filter((r): r is Record<string, unknown> => !!r && typeof r === "object")
        .filter((r) => typeof r.url === "string" && /^https?:\/\//i.test(r.url))
        .slice(0, 60_000)
        .map((r) => ({
          url: String(r.url), title: String(r.title ?? "").slice(0, 300),
          visits: Number(r.visits ?? 0) || 0, lastAt: Number(r.lastAt ?? 0) || 0,
          bookmarked: !!r.bookmarked,
        }));
      return json({ ok: true, saved: saveFrom(source, clean), ...placeCount() });
    }
    if (pathname === "/browser/places" && req.method === "GET") {
      return json({ ok: true, ...placeCount() });
    }
    if (pathname === "/browser/places/all") {
      return json({ ok: true, places: allPlaces() });
    }
    if (pathname === "/browser/places/forget" && req.method === "POST") {
      if (!trustedCaller(req, from)) return csrfBlocked();
      forgetPlaces();
      return json({ ok: true, ...placeCount() });
    }
    /* A page the built-in browser just visited. Its OWN history, kept under the
       'agentglass' source so a browser re-import (which DELETEs by source) never
       wipes it — see recordVisit(). */
    if (pathname === "/browser/visit" && req.method === "POST") {
      if (!trustedCaller(req, from)) return csrfBlocked();
      const b = await req.json().catch(() => ({})) as Record<string, unknown>;
      recordVisit(String(b.url ?? ""), String(b.title ?? ""));
      return json({ ok: true });
    }
    if (pathname === "/scratch/image" && req.method === "POST") {
      if (!trustedCaller(req, from)) return csrfBlocked();
      const b = await req.json().catch(() => ({})) as Record<string, unknown>;
      return json(saveShot(b.dataUrl, b.name));
    }
    if (pathname.startsWith("/git/") && req.method === "POST") {
      if (!trustedCaller(req, from)) return csrfBlocked();
      let b: any = {};
      try { b = await req.json(); } catch { return json({ ok: false, error: "invalid json" }, 400); }
      const root = String(b.root || "");
      const paths = Array.isArray(b.paths) ? b.paths : [];
      // Enforced here rather than by the screen not offering it: the routes are
      // still reachable from the Diff view, from another window, and from an
      // agent driving the app. See stoppedRefusal().
      const stopped = stoppedRefusal(root, pathname);
      if (stopped) { noteAction(clientIp, pathname, b, stopped, caller); return json(stopped, 400); }
      let res;
      switch (pathname) {
        case "/git/stage": res = stage(root, paths); break;
        case "/git/unstage": res = unstage(root, paths); break;
        case "/git/stage-all": res = stageAll(root); break;
        case "/git/unstage-all": res = unstageAll(root); break;
        case "/git/discard": res = discard(root, paths); break;
        case "/git/commit-staged": res = commitStaged(root, String(b.title || ""), String(b.body || "")); break;
        case "/git/push": res = gitPush(root); break;
        case "/git/pull": res = gitPull(root); break;
        case "/git/fetch": res = gitFetch(root); break;
        case "/git/checkout": res = gitCheckout(root, String(b.name || "")); break;
        case "/git/branch-create": res = createBranch(root, String(b.name || "")); break;
        case "/git/branch-delete": res = deleteBranch(root, String(b.name || ""), !!b.force); break;
        case "/git/stash-push": res = stashPush(root, String(b.message || "")); break;
        case "/git/stash-apply": res = stashApply(root, Number(b.index)); break;
        case "/git/stash-pop": res = stashPop(root, Number(b.index)); break;
        case "/git/stash-drop": res = stashDrop(root, Number(b.index)); break;
        case "/git/apply-hunk": res = applyHunk(root, b.path, !!b.staged, b.action, b.hunk); break;
        case "/git/merge": res = mergeBranch(root, String(b.name || "")); break;
        case "/git/rebase": res = rebaseBranch(root, String(b.name || "")); break;
        case "/git/branch-rename": res = renameBranch(root, String(b.name || ""), String(b.to || "")); break;
        case "/git/reset": res = resetTo(root, String(b.ref || ""), b.mode); break;
        case "/git/worktree-add": res = addWorktree(root, b.path, String(b.branch || ""), !!b.newBranch, b.startPoint); break;
        // Bring a remote branch local. `switch` moves this checkout onto it;
        // without it the branch is created and nothing else moves.
        case "/git/track-remote": res = trackRemoteBranch(root, String(b.ref || ""), { switch: !!b.switch }); break;
        case "/git/worktree-remove": res = removeWorktree(root, b.path, !!b.force); break;
        // Copy chosen leftovers into the main checkout before the worktree
        // holding them is removed. Never overwrites — see rescueLeftovers().
        case "/git/worktree-rescue": res = await rescueLeftovers(root, b.path, b.paths); break;
        // Elevates — the only route that does. chown only, never rm, and the
        // path must match a worktree git reports. See fixWorktreeOwnership().
        case "/git/worktree-chown": res = fixWorktreeOwnership(root, b.path); break;
        // `root` here is the checkout being updated — a worktree updates
        // itself, because the merge has to run where the branch is checked out.
        case "/git/sync-base": res = await syncFromBase(root, b.base); break;
        case "/git/set-base": res = setBase(root, b.branch, b.base ?? null); break;
        case "/git/resolve": res = resolveWith(root, b.paths ?? b.path, b.side); break;
        case "/git/resolve-blocks": res = resolveBlocks(root, b.path, b.choices, b.stamp); break;
        case "/git/merge-abort": res = mergeAbort(root); break;
        case "/git/merge-continue": res = mergeContinue(root, b.anyway); break;
        case "/git/reopen-conflict": res = reopenConflict(root, b.path, b.confirm); break;
        case "/git/undo-merge": res = await undoMerge(root); break;
        default: res = null;
      }
      // Every write through this switch is recorded — see actions.ts for why
      // it keeps the small ones too.
      if (res) { noteAction(clientIp, pathname, b, res, caller); return json(res, res.ok ? 200 : 400); }
    }

    // --- live docker panel (lazydocker-style) ---
    // Is docker even installed, as opposed to the daemon being down? A plain
    // read like the rest of /docker/*, so the surface-wide origin/rebinding gate
    // is the whole authorisation story. Lets the panel show install guidance for
    // a missing binary instead of the overview's daemon message. Mirrors
    // /git/capability.
    // --- what this machine is doing: ports, processes, disk ---
    // Plain reads behind the same origin/rebinding/token gate as everything
    // else. Each is a spawn or a /proc walk of a few milliseconds, so they are
    // answered live rather than cached — a stale port list is worse than a slow
    // one, because it sends you to a server that is not there.
    // --- github issues ---
    // The same `gh` plumbing the pull-request panel uses, one query along. A
    // list, a detail, and the work started from one — see issues.ts for why
    // starting and FINISHING are the same feature rather than two.
    if (pathname === "/issues/list") {
      return json(await listIssues(url.searchParams.get("root") || "", {
        state: url.searchParams.get("state") || "open",
        assignee: url.searchParams.get("assignee") || "",
        search: url.searchParams.get("q") || "",
        limit: Number(url.searchParams.get("limit") || 60),
      }));
    }
    if (pathname === "/issues/detail") {
      return json(await issueDetail(url.searchParams.get("root") || "", url.searchParams.get("number")));
    }
    /* The pull requests an issue produced — the other half of the link the
       pull-request panel already draws with `closingIssuesReferences`. Its own
       route rather than a field on the detail: it is a second round trip to
       GitHub, and the description should not wait on it. */
    if (pathname === "/issues/prs") {
      return json(await issuePullRequests(url.searchParams.get("root") || "", url.searchParams.get("number")));
    }
    if (pathname === "/issues/work") return json({ work: currentWork(url.searchParams.get("repo") || undefined) });

    // --- tasks (taskwarrior-backed, read-only) ---
    /*
     * The integrations pane, and the one route that receives a secret.
     *
     * `/providers/connect` is the only place in this server where a token
     * arrives from the browser, and it never goes back the other way: the
     * response carries a status — who you are, what workspace, how many tasks —
     * and no credential. See credentials.ts for why that is two functions
     * rather than a flag.
     */
    if (pathname === "/providers") {
      const providers = await providerStatuses();
      /*
       * Answer first, then go and find out.
       *
       * The statuses read ClickUp's cache and never fill it, because filling it
       * costs ten seconds of ClickUp's own latency and this page's question —
       * does the token work — does not need the task list. So the page is
       * instant, and this warms the cache for the next look; the 60s TTL and
       * the single-flight lock mean reopening Settings does not re-ask.
       * Deliberately not awaited, and its rejection swallowed: nobody is
       * waiting on it, and an unhandled rejection would go to the error log.
       */
      void clickupTasks().catch(() => { /* the next look finds out */ });
      return json({ providers });
    }
    if (pathname === "/providers/workspaces") {
      return json(await providerWorkspaces((url.searchParams.get("id") ?? "") as ProviderId));
    }
    if (pathname.startsWith("/providers/") && req.method === "POST") {
      // Connect, disconnect, choose a workspace: this route stores and deletes
      // the credentials every other integration reads. #469 swept the routes
      // that run code and missed the one that holds the keys to them.
      if (!trustedCaller(req, from)) return csrfBlocked();
      const b = await req.json().catch(() => ({})) as Record<string, unknown>;
      const id = String(b.id ?? "") as ProviderId;
      const r = pathname === "/providers/connect"
          ? await connectProvider(id, String(b.token ?? ""))
        : pathname === "/providers/disconnect" ? await disconnectProvider(id)
        : pathname === "/providers/workspace"
          ? await chooseWorkspace(id, String(b.workspaceId ?? ""), String(b.name ?? ""))
        : null;
      if (!r) return json({ ok: false, error: "not found" }, 404);
      return json(r, r.ok ? 200 : 400);
    }
    /* Boards, saved by pasting their address. Reads and one write path, and
       the write path refuses unless AGENTGLASS_CLICKUP_WRITE=1 — see
       clickup.ts for why this one defaults to off while the local list
       defaults to on. */
    /* Recipes — the commands somebody saved. Read is open; every write goes
       through `saveRecipe`, which is the only thing that decides what may end
       up in the file. Nothing here executes anything: running a recipe is the
       terminal's job, through the same path a typed command takes. */
    if (pathname === "/recipes") {
      const { recipes, recipesFor } = await import("./recipes.ts");
      const root = url.searchParams.get("root") ?? "";
      return json({ recipes: root ? recipesFor(root) : recipes() });
    }
    if (pathname === "/recipes/render") {
      // What WILL run, so it can be shown before it does. Never runs it.
      const { recipes, renderSteps } = await import("./recipes.ts");
      const id = url.searchParams.get("id") ?? "";
      const r = recipes().find((x) => x.id === id);
      if (!r) return json({ ok: false, error: "no such recipe" }, 404);
      let values: Record<string, string> = {};
      try { values = JSON.parse(url.searchParams.get("values") || "{}") as Record<string, string>; } catch { /* none */ }
      return json({ ok: true, ...renderSteps(r, values) });
    }
    if (pathname.startsWith("/recipes/") && req.method === "POST") {
      // A recipe is a saved command line the app will later run. Saving one is
      // therefore a write to the set of things this machine can be asked to
      // execute, which is the definition the sweep is sorting on.
      if (!trustedCaller(req, from)) return csrfBlocked();
      const { saveRecipe, removeRecipe } = await import("./recipes.ts");
      const b = await req.json().catch(() => ({})) as Record<string, unknown>;
      const r = pathname === "/recipes/save" ? saveRecipe(b as never)
        : pathname === "/recipes/remove" ? removeRecipe(String(b.id ?? ""))
        : null;
      if (!r) return json({ ok: false, error: "not found" }, 404);
      return json(r, r.ok ? 200 : 400);
    }
    if (pathname === "/clickup/views") {
      // `prefix` is what this workspace's ids look like, so a surface that has
      // only a string — the pull-request masthead reading a branch name — can
      // tell a card id of ours from another tracker's before it offers to open
      // one. Empty means nothing has been read yet, which is "unknown".
      //
      // `connected` is said out loud because `views` cannot say it: the
      // built-in board is always in that list, so its length answers "yes" on a
      // machine with no ClickUp at all. See ClickUpBoards.
      return json({ views: savedViews(), connected: hasCredential("clickup"), current: currentView(), prefix: knownCardPrefix(), writeEnabled: clickupWriteEnabled(), writeForced: process.env.AGENTGLASS_CLICKUP_WRITE === "1" });
    }
    if (pathname === "/clickup/view") {
      // Falls back to the first board rather than to nothing, and the first
      // board is the built-in one — so a fresh install opens on the tasks
      // assigned to you instead of on a form asking for an address.
      const id = url.searchParams.get("id") || currentView() || savedViews()[0]?.id || "";
      if (!id) return json({ tasks: [], statuses: [], fields: [], at: 0 });
      setCurrent(id);
      return json(await readView(id, url.searchParams.get("force") === "1"));
    }
    /* One list's own statuses and fields, for a card that is not from the board
       you are looking at — the built-in board's rows never are. Offering the
       board's statuses for such a card would offer a move that 400s, or worse,
       one that lands somewhere that means something else. */
    if (pathname === "/clickup/list") {
      const { secretFor } = await import("./credentials.ts");
      const { listMeta } = await import("./clickup.ts");
      const token = secretFor("clickup");
      const listId = url.searchParams.get("id") ?? "";
      if (!token) return json({ ok: false, error: "ClickUp is not connected" }, 400);
      if (!listId) return json({ ok: false, error: "no list asked for" }, 400);
      const r = await listMeta(token, listId);
      return json(r.ok ? { ok: true, ...r.data } : { ok: false, error: r.error }, r.ok ? 200 : 400);
    }
    if (pathname === "/clickup/prs") {
      // The checkout the search runs in, vetted the same way every other route
      // vets one: a path outside the configured scope is refused rather than
      // corrected, and `gh` then runs where the app already lives.
      const asked = url.searchParams.get("root") ?? "";
      const root = asked && inScope(asked) ? asked : (workspaceRoot() ?? process.cwd());
      const r = await cardPullRequests(
        url.searchParams.get("card") ?? "",
        url.searchParams.get("field") ?? undefined,
        root,
      );
      return json(r);
    }
    if (pathname === "/clickup/find") {
      // The prefix comes from what we have already read, so a bare number is
      // enough and nobody has to be asked what their ids look like.
      const r = await findCard(url.searchParams.get("q") ?? "", knownCardPrefix());
      return json(r.ok ? { ok: true, ...r.data } : { ok: false, error: r.error });
    }
    if (pathname === "/clickup/where") {
      // "Is this card already on a board I have?" — answered from the cache, so
      // it costs ClickUp nothing and can be asked before every lookup. A miss
      // is "not that we know of", not "nowhere": see boardHolding.
      const held = boardHolding(url.searchParams.get("id") ?? "");
      return json(held ? { ok: true, ...held } : { ok: false });
    }
    if (pathname === "/clickup/members") {
      // Who can be put on a card. Scoped to the LIST the card lives in: a
      // workspace here holds the whole company, and a picker offering all of
      // them to assign one backend card is a picker nobody uses twice.
      const r = await listMembers(url.searchParams.get("list") ?? "");
      return json(r.ok ? { ok: true, ...r.data } : { ok: false, error: r.error });
    }
    if (pathname === "/clickup/task") {
      const r = await taskDetail(url.searchParams.get("id") ?? "");
      return json(r.ok ? { ok: true, ...r.data } : { ok: false, error: r.error });
    }
    if (pathname.startsWith("/clickup/") && req.method === "POST") {
      // Assign somebody, move a card, set a field, add or drop a board, and
      // switch writing on. The change does not land on this machine, which is
      // exactly why it was easy to miss: it lands in a shared workspace where
      // colleagues can see it and where nothing here can take it back.
      if (!trustedCaller(req, from)) return csrfBlocked();
      const b = await req.json().catch(() => ({})) as Record<string, unknown>;
      const id = String(b.id ?? "");
      const seen = typeof b.updated === "number" ? b.updated : undefined;
      const r = pathname === "/clickup/views/add" ? await addViewByUrl(String(b.url ?? ""))
        : pathname === "/clickup/views/replace" ? await replaceViewUrl(id, String(b.url ?? ""))
        : pathname === "/clickup/views/remove" ? (removeView(id), { ok: true })
        // `user` names somebody other than you; without it this stays what it
        // has always been, the self-assign toggle.
        : pathname === "/clickup/assign"
          ? (b.user != null
            ? await setAssignee(id, Number(b.user), b.on !== false, seen)
            : await assignSelf(id, b.on !== false, seen))
        // Several changes to one card, as one write. Three writes each carrying
        // the stamp read when the menu opened meant only the first could land:
        // the first one moves the stamp the other two are checked against.
        : pathname === "/clickup/card"
          ? await setCard(id, {
            add: Array.isArray(b.add) ? (b.add as unknown[]).map(Number) : undefined,
            rem: Array.isArray(b.rem) ? (b.rem as unknown[]).map(Number) : undefined,
            status: b.status != null ? String(b.status) : undefined,
          }, seen)
        : pathname === "/clickup/status" ? await setStatus(id, String(b.status ?? ""), seen)
        : pathname === "/clickup/field" ? await setField(id, String(b.field ?? ""), String(b.value ?? ""))
        : pathname === "/clickup/writes" ? (setWritesAllowed(b.on === true), { ok: true })
        : null;
      if (!r) return json({ ok: false, error: "not found" }, 404);
      return json(r, r.ok ? 200 : ("conflict" in r && r.conflict) ? 409 : 400);
    }
    if (pathname === "/tasks/provider") {
      // One provider's list. `force` is what the Refresh button sends; the poll
      // never sets it, so a page left open cannot burn the rate budget.
      const snap = await clickupTasks(url.searchParams.get("force") === "1");
      return json({
        tasks: snap.tasks, more: snap.more, error: snap.error,
        unauthorised: snap.unauthorised, at: snap.at,
      });
    }
    if (pathname === "/tasks/list") {
      const snap = await listTasks(url.searchParams.get("force") === "1");
      const capability = await taskCapability();
      // The reminders ride along: a row that has one must be able to say so
      // without a request per row, and they are ours to read cheaply.
      return json({
        ok: !snap.error, tasks: snap.tasks, capability, error: snap.error,
        byTask: remindersFor(snap.tasks.map((t) => t.uuid)),
        fingerprint: snap.fingerprint,
        writeEnabled: TASK_WRITE_ENABLED,
      });
    }
    if (pathname === "/tasks/reminders") {
      const w = url.searchParams.get("window");
      const window = w === "upcoming" || w === "history" ? w : "live";
      return json({ ok: true, reminders: listReminders(window), zone: localZone() });
    }

    if (pathname === "/machine/ports") return json(listPorts());
    if (pathname === "/machine/resources") return json(listResources(Number(url.searchParams.get("limit") || 40)));
    // On demand only, and never on a poll: `du` over a checkout walks every
    // inode in it, which is seconds on a repository with a node_modules.
    if (pathname === "/machine/space") return json(spaceFor(url.searchParams.get("root") || ""));
    // The checkouts we already know about, which is the same list the project
    // picker is built from. No `git` is run — see gitlocks.ts for why a panel
    // must not shell out to git in a repository that is already stuck.
    if (pathname === "/machine/locks") return json(gitLocks(knownProjects().map((p) => p.path)));
    // Everything about one process that will not fit on a row. Secret-looking
    // values come back masked — see procdetail.ts for why that is not optional
    // on a surface a paired phone can reach.
    if (pathname === "/machine/process") return json(procDetail(url.searchParams.get("pid")));

    // --- browsing and searching a checkout ---
    // Their own switch, not the terminal's: an operator who turned the shell off
    // gave up filesystem reach deliberately, and this must not hand it back a
    // listing at a time. Same reasoning as /fs/complete — see fsbrowse.ts.
    if (pathname.startsWith("/files/")) {
      if (!FS_BROWSE_ENABLED) return json({ error: "directory browsing is disabled (AGENTGLASS_FS_BROWSE_DISABLED=1)" }, 403);
      const root = url.searchParams.get("root") || "";
      if (pathname === "/files/tree") return json(fileTree(root, url.searchParams.get("rel") || ""));
      /* One file's text, for the viewer that renders markdown rather than
         editing it. Same containment as the tree — see files.ts. */
      // `ref` is optional everywhere: absent means this working tree, which is
      // what every existing caller sends and must keep meaning.
      if (pathname === "/files/read") return json(fileText(root, url.searchParams.get("rel") || "", url.searchParams.get("ref") || undefined));
      // A ref's copy written out so the editor can open it — see fileToTemp.
      if (pathname === "/files/temp") return json(fileToTemp(root, url.searchParams.get("rel") || "", url.searchParams.get("ref") || ""));
      if (pathname === "/files/find") return json(findFiles(root, url.searchParams.get("q") || "", undefined, url.searchParams.get("ref") || undefined));
      if (pathname === "/files/grep") return json(grepFiles(root, url.searchParams.get("q") || "", undefined, url.searchParams.get("ref") || undefined));
      if (pathname === "/files/refs") return json(listRefs(root));
      if (pathname === "/files/exist") return json(filesExist(root, url.searchParams.getAll("rel")));
    }

    if (pathname === "/docker/capability") return json(await dockerCapability());
    // Single-flighted alongside the git reads: `docker ps`/`docker stats` are
    // slow spawns (seconds each) behind a short cache, and several tabs missing
    // that cache together would each launch one. One sample now serves them all.
    if (pathname === "/docker/overview") return body(await singleFlight("docker:overview", async () => JSON.stringify(await dockerOverview())));
    if (pathname === "/docker/stats") {
      // Sample what the panel is showing. The overview is cached and scoped, so
      // this costs nothing extra and keeps the two answers about the same set of
      // containers — a scoped panel asking the daemon about the whole host was
      // the inconsistency worth removing.
      // Running and paused: those are the states `docker stats` has numbers for.
      // A restarting container is deliberately left out — it is between processes
      // often enough that naming it can take the whole sample down with a "no such
      // container", and it has nothing to report either way.
      return body(await singleFlight("docker:stats", async () => {
        const shown = await dockerOverview();
        const sampleable = shown.containers.filter((c) => c.state === "running" || c.state === "paused").map((c) => c.id);
        return JSON.stringify({ stats: await dockerStats(shown.scope ? sampleable : undefined) });
      }));
    }
    if (pathname === "/docker/inspect") return json(await dockerInspect(url.searchParams.get("id") || ""));
    if (pathname === "/docker/top") return json(await dockerTop(url.searchParams.get("id") || ""));
    if (pathname === "/docker/logs") {
      const id = url.searchParams.get("id") || "";
      const tail = Number(url.searchParams.get("tail") || 400);
      return json(await dockerLogs(id, tail));
    }
    if (pathname === "/update/run" && req.method === "POST") {
      if (!desktopOnly(req)) return csrfBlocked();
      return json(await startUpdate());
    }
    // Spends a little quota to measure quota, so it is opt-in on the client and
    // gated here like the other routes that run a CLI.
    if (pathname === "/usage/codex/refresh" && req.method === "POST") {
      if (!trustedCaller(req, from)) return csrfBlocked();
      return json(await refreshCodexUsage());
    }
    if (pathname.startsWith("/docker/") && req.method === "POST") {
      if (!trustedCaller(req, from)) return csrfBlocked();
      let b: any = {};
      try { b = await req.json(); } catch { return json({ ok: false, error: "invalid json" }, 400); }
      const id = String(b.id || "");
      let res;
      switch (pathname) {
        case "/docker/start": res = await startContainer(id); break;
        case "/docker/stop": res = await stopContainer(id); break;
        case "/docker/restart": res = await restartContainer(id); break;
        case "/docker/rm": res = await removeContainer(id); break;
        default: res = null;
      }
      // Every write through this switch is recorded — see actions.ts for why
      // it keeps the small ones too.
      if (res) { noteAction(clientIp, pathname, b, res, caller); return json(res, res.ok ? 200 : 400); }
    }

    /*
     * The issue writes.
     *
     * Origin-checked and recorded like every other write here. `start` and
     * `finish` touch the filesystem (a worktree, a branch); `claim`, `comment`
     * and `state` touch GitHub. None of them takes a command from the client —
     * the server decides what runs, which is the same rule the review prompt
     * follows.
     */
    if (pathname.startsWith("/tasks/write/") && req.method === "POST") {
      // `/tasks/write/` — the path says it. Taskwarrior is the user's own
      // store and these verbs add, complete and delete rows in it.
      if (!trustedCaller(req, from)) return csrfBlocked();
      // Every verb carries the fingerprint the client was looking at. A write
      // whose precondition has moved answers 409 with the fresh list — it is
      // never retried here, because retrying against a store that moved is
      // exactly how the other writer's work gets reverted.
      const b = await req.json().catch(() => ({})) as Record<string, unknown>;
      const expect = typeof b.fingerprint === "string" ? b.fingerprint : undefined;
      const uuid = String(b.uuid ?? "");
      const strs = (v: unknown) => (Array.isArray(v) ? v.filter((x) => typeof x === "string") as string[] : []);
      const r = pathname === "/tasks/write/add" ? await addTask(String(b.input ?? ""), expect)
        : pathname === "/tasks/write/done" ? await completeTask(uuid, expect)
        : pathname === "/tasks/write/reopen" ? await reopenTask(uuid, expect)
        : pathname === "/tasks/write/delete" ? await deleteTask(uuid, expect)
        : pathname === "/tasks/write/priority" ? await cyclePriority(uuid, (b.current as "H" | "M" | "L" | null) ?? null, expect)
        : pathname === "/tasks/write/edit" ? await editTask(uuid, String(b.input ?? ""), strs(b.previousTags), expect)
        : pathname === "/tasks/write/tags" ? await addTags(uuid, strs(b.tags), expect)
        : pathname === "/tasks/write/note" ? await replaceNote(uuid, String(b.oldText ?? ""), String(b.newText ?? ""), expect)
        : pathname === "/tasks/write/bulk" ? await bulkApply(strs(b.uuids), b.action as BulkAction, typeof b.value === "string" ? b.value : null, expect)
        : null;
      if (!r) return json({ ok: false, error: "not found" }, 404);
      if (r.ok) broadcast({ type: "tasks" });
      return json(r, r.conflict ? 409 : r.ok ? 200 : 400);
    }
    if (pathname.startsWith("/tasks/remind") && req.method === "POST") {
      // Touching no Taskwarrior lock is not the same as changing nothing: a
      // reminder is stored here and later fires a desktop notification, so
      // this route writes state AND schedules something that interrupts.
      if (!trustedCaller(req, from)) return csrfBlocked();
      // None of these touch Taskwarrior or its lock. That is what keeps the
      // engine working when the task list cannot be read at all.
      const b = await req.json().catch(() => ({})) as Record<string, unknown>;
      if (pathname === "/tasks/remind") {
        return json(addReminder({
          taskUuid: typeof b.taskUuid === "string" ? b.taskUuid : null,
          title: String(b.title ?? ""),
          civil: String(b.civil ?? ""),
          zone: typeof b.zone === "string" ? b.zone : undefined,
          root: typeof b.root === "string" ? b.root : null,
        }));
      }
      const id = String(b.id ?? "");
      if (!id) return json({ ok: false, error: "which reminder?" }, 400);
      if (pathname === "/tasks/reminder/ack") return json(ackReminder(id));
      if (pathname === "/tasks/reminder/cancel") return json(cancelReminder(id));
      if (pathname === "/tasks/reminder/snooze") return json(snoozeReminder(id, Number(b.minutes ?? 60)));
      return json({ ok: false, error: "not found" }, 404);
    }
    if (pathname.startsWith("/issues/") && req.method === "POST") {
      if (!trustedCaller(req, from)) return csrfBlocked();
      let b: any = {};
      try { b = await req.json(); } catch { return json({ ok: false, error: "invalid json" }, 400); }
      const root = String(b.root || "");
      let res: { ok: boolean; error?: string; detail?: string } | null = null;
      switch (pathname) {
        case "/issues/start": res = await startIssue(root, b.number, b.mode); break;
        case "/issues/finish": res = await finishIssue(root, b.number, b.force === true); break;
        case "/issues/claim": res = await claimIssue(root, b.number, b.comment); break;
        case "/issues/comment": res = await commentIssue(root, b.number, b.body); break;
        case "/issues/state": res = await setIssueState(root, b.number, b.close === true); break;
        default: res = null;
      }
      if (res) { noteAction(clientIp, pathname, b, res, caller); return json(res, res.ok ? 200 : 400); }
    }

    // The one write in the machine panel, and it signals a process. Origin
    // checked like every other write, recorded like every other write, and
    // refused for any pid this user does not own — see killPort.
    /*
     * Delete a lock nothing is holding.
     *
     * A write, and the only destructive one this panel has beyond `kill`, so it
     * is gated the same way and then re-checks its own premise: the path has to
     * still be a stale lock in a checkout we know, decided server-side at the
     * moment of the call. The client's opinion is a request, not evidence — the
     * list it is looking at is up to 2.5 seconds old, and in that window a real
     * git can have picked the lock up.
     */
    /*
     * Unmask one environment variable.
     *
     * `desktopOnly`, not `localOrigin`, and that is the entire point of the
     * route existing separately. Everything else in this panel is safe to read
     * from a paired phone; a decrypted API key is not. The desktop shell serves
     * itself from a scheme nothing on the web can be served under and a page
     * cannot forge an Origin, so this is the one gate that cannot be reached
     * from a device that merely paired.
     */
    if (pathname === "/machine/env" && req.method === "POST") {
      if (!desktopOnly(req)) return csrfBlocked();
      let b: any = {};
      try { b = await req.json(); } catch { return json({ ok: false, error: "invalid json" }, 400); }
      const res = revealEnv(b.pid, b.key);
      // Deliberately NOT passed to noteAction: the action log is readable from
      // the panel, and writing the value there would undo the masking by a
      // different door. The fact that a reveal happened is worth recording; the
      // value is the thing being protected.
      noteAction(clientIp, pathname, { pid: b.pid, key: b.key }, { ok: res.ok, error: res.error }, caller);
      return json(res, res.ok ? 200 : 400);
    }

    if (pathname === "/machine/unlock" && req.method === "POST") {
      if (!trustedCaller(req, from)) return csrfBlocked();
      let b: any = {};
      try { b = await req.json(); } catch { return json({ ok: false, error: "invalid json" }, 400); }
      const res = removeStaleLock(b.path, knownProjects().map((p) => p.path));
      noteAction(clientIp, pathname, b, res, caller);
      return json(res, res.ok ? 200 : 400);
    }

    if (pathname === "/machine/kill" && req.method === "POST") {
      if (!trustedCaller(req, from)) return csrfBlocked();
      let b: any = {};
      try { b = await req.json(); } catch { return json({ ok: false, error: "invalid json" }, 400); }
      const res = killPort(b.pid);
      noteAction(clientIp, pathname, b, res, caller);
      return json(res, res.ok ? 200 : 400);
    }

    // --- pull requests (gh-backed) ---
    //
    // Reads answer from a cache that refreshes behind them, so none of these
    // waits on a subprocess. Writes are all POST and all origin-checked; the
    // irreversible ones additionally carry the head sha the UI showed.
    if (pathname === "/prs/capability") return json(await ghCapability(url.searchParams.get("force") === "1"));
    // What is left of GitHub's hourly budget. Asked by a settings page somebody
    // is looking at, so it is never served from a cache — see ghRateLimit.
    if (pathname === "/prs/rate-limit") return json(await ghRateLimit());
    // How far behind its base a branch is — asked apart from the detail because
    // it costs about 600ms, and the detail should not. See branchBehind.
    /*
     * Put a pull request's conflict in a worktree, so there is something to
     * resolve.
     *
     * A POST because it writes: it cuts a worktree and merges into it. Never
     * the checkout the user is standing in — see prepareConflictMerge.
     */
    if (pathname === "/prs/conflict" && req.method === "POST") {
      const b = await req.json().catch(() => ({})) as Record<string, unknown>;
      const asked = String(b.root ?? "");
      const root = asked && inScope(asked) ? asked : (workspaceRoot() ?? process.cwd());
      const number = Number(b.number ?? 0);
      const pr = await prBranches(root, number);
      if (!pr) return json({ ok: false, error: "could not read that pull request's branches" });
      return json(prepareConflictMerge(root, pr.head, pr.base));
    }
    /* Which files a pull request would conflict on, WITHOUT merging anything —
       see conflictPreview(). Read-only: the checkout somebody is working in is
       untouched. */
    if (pathname === "/prs/conflict-files") {
      const asked = url.searchParams.get("root") ?? "";
      const root = asked && inScope(asked) ? asked : (workspaceRoot() ?? process.cwd());
      const number = Number(url.searchParams.get("number") ?? 0);
      const pr = await prBranches(root, number);
      if (!pr) return json({ ok: false, conflicts: [], clean: false, error: "could not read that pull request's branches" });
      // The number goes through: a pull request from a fork has no branch on
      // origin, and refs/pull/<n>/head is the only ref that always exists.
      return json(await conflictPreview(root, pr.base, pr.head, number));
    }
    /* The pull requests on a branch — one out of it, any number into it. Asked
       of GitHub by name rather than filtered out of a scope, because a scope is
       about an AUTHOR and this question is about a branch. */
    if (pathname === "/prs/for-branch") {
      const asked = url.searchParams.get("root") ?? "";
      const root = asked && inScope(asked) ? asked : (workspaceRoot() ?? process.cwd());
      return json(await prsForBranch(root, url.searchParams.get("branch") ?? ""));
    }
    /*
     * The LOCAL half on its own, because it changes on a different clock.
     *
     * How far behind the base a branch is takes a comparison over the network
     * and is stable for minutes. Whether your checkout is dirty, or has a
     * commit GitHub does not, changes the moment you type — and the panel was
     * reading both together and holding the answer for as long as the slow one
     * was worth holding. Reported both ways round: it offered to fast-forward a
     * checkout that had just gone dirty, and went on refusing one that had just
     * been committed.
     *
     * This is git only, no network — a few milliseconds — so it can be asked
     * again while a pull request is open.
     */
    /* The truth about one pull request's checks — see prRollup. The list's own
       rollup counts a re-run's old attempt beside the new one, and a card
       cannot tell without asking. */
    if (pathname === "/prs/rollup") {
      return json(await prRollup(url.searchParams.get("root") || "", url.searchParams.get("number") || 0));
    }
    if (pathname === "/prs/local-head") {
      return json({ ok: true, local: await localHead(
        url.searchParams.get("root") || "",
        url.searchParams.get("branch") || "",
      ) });
    }
    if (pathname === "/prs/behind") {
      const asked = url.searchParams.get("root") ?? "";
      const root = asked && inScope(asked) ? asked : (workspaceRoot() ?? process.cwd());
      return json(await branchBehind(root, Number(url.searchParams.get("number") ?? 0)));
    }
    /* Where this app keeps things, and for how long — read by Settings →
       Privacy. Paths, not contents: the page says what is on disk so somebody
       can go and look, and nothing here reads a credential to display it. */
    if (pathname === "/privacy") {
      return json({
        db: dbPath(),
        config: configPath(),
        credentials: credentialsPath(),
        retentionDays: RETENTION_DAYS,
        pairedDevices: devices().length,
      });
    }
    if (pathname === "/prs/list") {
      return json(await listPrs(
        url.searchParams.get("root") || "",
        url.searchParams.get("filter") || "mine",
        url.searchParams.get("state") || "open",
        url.searchParams.get("force") === "1",
        url.searchParams.get("after") || undefined,
        url.searchParams.get("q") || undefined,
      ));
    }
    if (pathname === "/prs/file-slice") {
      return json(await fileSlice(url.searchParams.get("root") || "", url.searchParams.get("number") || "", {
        path: url.searchParams.get("path") || "",
        side: url.searchParams.get("side") || "RIGHT",
        from: url.searchParams.get("from") || undefined,
        to: url.searchParams.get("to") || undefined,
      }));
    }
    if (pathname === "/prs/facets") {
      return json(await facetOptions(url.searchParams.get("root") || ""));
    }
    if (pathname === "/prs/mentions") {
      return json(await mentionables(url.searchParams.get("root") || ""));
    }
    if (pathname === "/prs/job-log") {
      return json(await jobLog(url.searchParams.get("root") || "", url.searchParams.get("job") || ""));
    }
    if (pathname === "/prs/check-jobs") {
      return json(await checkJobs(url.searchParams.get("root") || "", url.searchParams.get("number") || ""));
    }
    if (pathname === "/prs/counts") {
      return json(await viewCounts(url.searchParams.get("root") || "", url.searchParams.get("state") || "open"));
    }
    if (pathname === "/prs/detail") {
      return json(await prDetail(
        url.searchParams.get("root") || "",
        url.searchParams.get("number") || "",
        url.searchParams.get("force") === "1",
      ));
    }
    if (pathname === "/prs/diff") {
      return json(await prDiff(url.searchParams.get("root") || "", url.searchParams.get("number") || ""));
    }
    // Images in a PR body. Not JSON — it streams the bytes back, because
    // GitHub's own attachment URLs 404 without the token this attaches.
    if (pathname === "/prs/asset") return prAsset(url.searchParams.get("url") || "");
    if (pathname === "/prs/commit-diff") {
      return json(await prCommitDiff(url.searchParams.get("root") || "", url.searchParams.get("sha") || ""));
    }
    if (pathname === "/prs/branch-url") {
      return json(await branchUrl(
        url.searchParams.get("root") || "",
        url.searchParams.get("branch") || "",
        url.searchParams.get("gone") || "",
      ));
    }
    if (pathname.startsWith("/prs/") && req.method === "POST") {
      if (!trustedCaller(req, from)) return csrfBlocked();
      let b: any = {};
      try { b = await req.json(); } catch { return json({ ok: false, error: "invalid json" }, 400); }
      const root = b.root ?? "";
      const n = b.number;
      let res;
      switch (pathname) {
        case "/prs/review": res = await submitReview(root, n, b.verb, b.body); break;
        case "/prs/review-with": res = await submitReviewWith(root, n, b.verb, b.body, b.comments); break;
        // A pull request's version of a file, on disk, so it can be opened. The
        // working tree cannot answer for a branch that is not checked out here.
        case "/prs/file-temp": res = await prFileToTemp(root, n, b.path); break;
        case "/prs/comment": res = await addComment(root, n, b.body); break;
        case "/prs/reply": res = await replyToThread(root, n, b.commentId, b.body); break;
        case "/prs/thread-resolved": res = await setThreadResolved(root, b.threadId, b.resolved); break;
        case "/prs/react": res = await react(root, b.nodeId ?? b.commentId, b.content, b.on); break;
        case "/prs/comment-edit": res = await editComment(root, b.nodeId, b.body, b.kind); break;
        case "/prs/comment-delete": res = await deleteComment(root, b.nodeId, b.kind); break;
        case "/prs/file-viewed": res = await setFileViewed(root, b.prNodeId, b.path, b.viewed); break;
        case "/prs/assignees": res = await setAssignees(root, n, b.add, b.remove); break;
        case "/prs/milestone": res = await setMilestone(root, n, b.title); break;
        case "/prs/edit": res = await editPr(root, n, { title: b.title, body: b.body, base: b.base }); break;
        case "/prs/labels": res = await setLabels(root, n, b.add, b.remove); break;
        case "/prs/reviewers": res = await setReviewers(root, n, b.add, b.remove); break;
        case "/prs/draft": res = await setDraft(root, n, b.draft); break;
        case "/prs/update-branch": res = await updateBranch(root, n, b.syncLocal); break;
        case "/prs/rerun": res = await rerunFailedChecks(root, n); break;
        case "/prs/rerun-jobs": res = await rerunJobs(root, b.what, b.id); break;
        case "/prs/line-comment": res = await addLineComment(root, n, b); break;
        case "/prs/apply-suggestion": res = await applySuggestion(root, n, b); break;
        case "/prs/merge": res = await mergePr(root, n, b.method, { deleteBranch: b.deleteBranch, auto: b.auto, headSha: b.headSha, subject: b.subject, body: b.body, disableAuto: b.disableAuto }); break;
        case "/prs/close": res = await closePr(root, n, b.reopen === true); break;
        case "/prs/review-prompt": res = await prepareReviewPrompt(root, n); break;
        default: res = null;
      }
      // Every write through this switch is recorded — see actions.ts for why
      // it keeps the small ones too.
      if (res) { noteAction(clientIp, pathname, b, res, caller); return json(res, res.ok ? 200 : 400); }
    }

    // --- in-browser terminal: ready-to-run project commands (make + scripts) ---
    // Async + cached in terminal.ts (the depth-3 Makefile/package.json walk used
    // to run synchronously on the loop the PTY rides — the watchdog named it at
    // 84s under load); single-flighted here so the several tabs / the
    // new-terminal + ⚙-menu that ask at the same instant share one walk rather
    // than each launching the whole thing.
    /**
     * Where the machine's agents are sitting, in tmux terms.
     *
     * Asked on demand — when the bar's panel opens — and never polled. This is
     * a `list-panes` plus a walk of /proc per pane, which is cheap once and
     * pointless on a timer: nobody is looking at the answer between the moment
     * they press the chip and the moment they click through it.
     *
     * Scoped like every other read. Without it, a cockpit opened for one
     * project would answer "here is where every agent on this machine is",
     * which is the same leak the live seam had.
     */
    if (pathname === "/terminal/panes") {
      // The socket a terminal was last attached to is a hint, not a
      // requirement: the servers are discovered from the socket directory, so
      // this answers whether or not a terminal has ever been opened here.
      /*
       * Every pane on the machine, and deliberately NOT filtered by workspace.
       *
       * It used to drop any pane whose agents were all out of scope, and the
       * result was a tab strip with holes in it: window 3 and window 5 simply
       * were not there. Reported from a phone, and it took a measurement to
       * see, because the rule produces an absurdity — a window running an idle
       * shell is listed, and the SAME window with an agent working in it
       * vanishes. The two most interesting tabs are exactly the ones it hid.
       *
       * It was not protecting anything either. `pane_current_path` is on every
       * row already, including for the panes the filter let through, so a
       * directory outside the workspace was on the wire regardless — the rule
       * cost a complete answer and bought nothing.
       *
       * This is the machine's tmux, which is what the caller asked for. What
       * belongs to a workspace is a session's transcripts, and that is a
       * different question asked at a different endpoint.
       */
      const live = listPanes(lastTmuxTarget()?.socket)
        // The socket is a filesystem path and stays on this side of the wire.
        .map(({ socket: _s, ...p }) => p);
      /*
       * A session seen as a floating window stays marked as one.
       *
       * The mark is only readable while the popup is OPEN — that is when its
       * client exists to be asked what terminal it is running under. Closed, it
       * looks like any other detached session. Without remembering, it would
       * appear and disappear from a phone depending on whether it happened to
       * be on screen, which is worse than either answer.
       *
       * Before `withAgentSessions`, which copies each row: setting the flag
       * afterwards would set it on the originals and answer with the copies.
       */
      for (const p of live) if (p.popup) seenPopups.add(p.session);
      for (const p of live) if (seenPopups.has(p.session)) p.popup = true;
      // Which session is in which pane, where a hook said so. The list is the
      // live one, so a note pointing at a pane that has since closed drops out
      // here rather than becoming a button that goes nowhere.
      const panes = withAgentSessions(live, (id) => {
        const n = paneAgentNote(id);
        return n ? { sessionId: n.session_id, at: n.at } : null;
      });
      /*
       * `canAttach` says this server understands `?pane=` on the terminal
       * socket.
       *
       * A build without it ignores the parameter and opens a plain shell, so a
       * phone tapping a tab gets an empty prompt where it expected the session
       * that is already running — and nothing anywhere says why. The flag
       * costs a boolean and turns that into a sentence.
       */
      // Annotated, not just handed to `json()`: this is the line that makes the
      // three ends one protocol. `json` takes anything, so without it the body
      // was whatever the expressions above happened to produce and `canAttach`
      // existed in no shared declaration at all.
      const body: PanesResponse = { ok: true, panes, canAttach: true };
      return json(body);
    }

    /**
     * Where the agent in the pane you are typing in has been working.
     *
     * Directories, newest first — not "the worktree". Which of them is a
     * worktree of the repo on screen is decided by the panel, which is already
     * holding that list and already filtering it to this project; answering it
     * here would be a second copy of that decision, kept in a different file.
     *
     * Asked by the worktree menu while it is open, at the same lazy cadence the
     * screen scrape it replaces used. Scoped like every other read: a cockpit
     * opened for one project does not get to enumerate directories from another.
     */
    if (pathname === "/terminal/pane-dirs") {
      const pane = activePane(lastTmuxTarget()?.socket, url.searchParams.get("window") || "");
      if (!pane) return json({ ok: true, pane: null, dirs: [] });
      const { dirs } = paneDirs(pane.paneId, pane.pid);
      return json({ ok: true, pane: pane.paneId, dirs: dirs.filter((d) => sessionInScope({ cwd_path: d })) });
    }

    /** Put one of them in front of whoever is attached. The ids are validated
     *  against tmux's own syntax in focusPane() before they reach a command. */
    if (pathname === "/terminal/panes/focus" && req.method === "POST") {
      if (!trustedCaller(req, from)) return csrfBlocked();
      let b: { sessionId?: unknown; windowId?: unknown; paneId?: unknown };
      try { b = (await req.json()) as typeof b; } catch { return json({ ok: false, error: "invalid json" }, 400); }
      const ok = focusPaneAnywhere(lastTmuxTarget()?.socket, String(b.sessionId ?? ""), String(b.windowId ?? ""), String(b.paneId ?? ""));
      return json(ok ? { ok } : { ok, error: "tmux would not go there — the pane may be gone" }, ok ? 200 : 409);
    }

    /*
     * A ticket for starting an agent in a pane, for a terminal with no tmux.
     *
     * POST rather than a query parameter on the socket because what it carries
     * is a prompt — a card's description, a review brief — which is kilobytes
     * and does not belong in a URL. The reply is an opaque id the client hands
     * back when it opens the pane, good once and for a minute.
     *
     * The directory is vetted HERE as well as at claim time. A ticket that
     * cannot be used is better refused at the press, where there is something
     * on screen to say so, than at the socket, where there is a blank pane.
     */
    if (pathname === "/terminal/agent" && req.method === "POST") {
      if (!trustedCaller(req, from)) return csrfBlocked();
      if (!TERMINAL_ENABLED) return json({ ok: false, error: "the terminal is disabled here" }, 403);
      let b: { cwd?: unknown; prompt?: unknown; yolo?: unknown; title?: unknown };
      try { b = (await req.json()) as typeof b; } catch { return json({ ok: false, error: "invalid json" }, 400); }
      const cwd = gitSafeAbs(b.cwd);
      if (!cwd || !inScope(cwd) || !fsExists(cwd)) {
        return json({ ok: false, error: "that directory is not in the open project" }, 400);
      }
      const prompt = typeof b.prompt === "string" ? b.prompt : "";
      // Bypass is a permission, not a parameter: the same gate the chat engines
      // go through, so a socket cannot buy the flag the config refuses.
      const yolo = b.yolo === true && chatBypassAllowed();
      const id = mintAgentTicket({ cwd, prompt, yolo, title: sessionTitle(b.title) });
      return json({ ok: true, ticket: id });
    }

    // --- the pane engine's tmux, exposed to the agentglass UI -------------
    // Everything tmux's own bar would have done — tabs, splits, focus, kill,
    // rename, resize — is served here, so the UI is the only surface the user
    // ever sees. Every target id is validated against tmux's own shapes before
    // it reaches a command (see tmuxlayout.ts), and every write goes through
    // the same trusted-caller gate as the rest of the app.
    if (pathname === "/terminal/tmux-status") {
      const bin = tmuxBinStatus();
      const health = confHealth();
      return json({
        ok: true,
        bin,
        capability: health.ok ? { available: bin.available, reason: bin.reason } : { available: false, reason: health.reason },
        confMode: tmuxConfMode(),
        override: tmuxOverride(),
        overrideActive: tmuxOverride().trim().length > 0,
        broken: !health.ok,
        brokenReason: health.ok ? "" : health.reason,
        restoreEnabled: tmuxRestoreEnabled(),
        resumeMode: tmuxResume(),
        // The engine's prefix key. Empty means tmux's own default (C-b).
        prefix: tmuxPrefix(),
        source: tmuxSource(),
        lastCaptureAt: lastCaptureAt(),
      });
    }

    if (pathname === "/terminal/tmux-conf" && req.method === "POST") {
      if (!trustedCaller(req, from)) return csrfBlocked();
      let b: any = {};
      try { b = await req.json(); } catch { return json({ ok: false, error: "invalid json" }, 400); }
      const mode = b.confMode === "replace" ? "replace" : "append";
      const override = typeof b.override === "string" ? b.override : tmuxOverride();
      const applied = applyTmuxConf(mode, override);
      return json(applied, applied.ok ? 200 : 400);
    }

    if (pathname === "/terminal/tmux-settings" && req.method === "POST") {
      if (!trustedCaller(req, from)) return csrfBlocked();
      let b: any = {};
      try { b = await req.json(); } catch { return json({ ok: false, error: "invalid json" }, 400); }
      const fields: Parameters<typeof writeTmuxSettings>[0] = {};
      if (b.source !== undefined) {
        if (!["auto", "bundled", "system", "custom"].includes(String(b.source))) return json({ ok: false, error: "unknown tmux source" }, 400);
        fields.tmuxSource = b.source;
      }
      if (b.path !== undefined) fields.tmuxPath = typeof b.path === "string" ? b.path.trim() : "";
      if (b.restore !== undefined) fields.tmuxRestore = b.restore === true;
      if (b.resume !== undefined) fields.tmuxResume = b.resume === "all" ? "all" : "lazy";
      // The prefix is a key name, and it is interpolated into a config file the
      // engine executes — so it is checked here rather than escaped later.
      if (b.prefix !== undefined) {
        const key = String(b.prefix).trim();
        if (key && !validTmuxPrefix(key)) {
          return json({ ok: false, error: "that is not a key tmux would take — try C-a, M-Space or F5" }, 400);
        }
        fields.tmuxPrefix = key;
      }
      const w = writeTmuxSettings(fields);
      // Regenerate, so the key applies at the next server start rather than
      // waiting for something else to touch the config.
      if (w.ok && b.prefix !== undefined) ensureConf();
      return json(w, w.ok ? 200 : 400);
    }

    if (pathname === "/terminal/tmux-reset" && req.method === "POST") {
      if (!trustedCaller(req, from)) return csrfBlocked();
      const r = await resetTmuxConf(async () => {
        const { tmux } = await import("./tmuxpane.ts");
        return tmux(["kill-server"]);
      });
      return json(r, r.ok ? 200 : 400);
    }

    if (pathname === "/terminal/tmux-restore" && req.method === "POST") {
      if (!trustedCaller(req, from)) return csrfBlocked();
      let b: any = {};
      try { b = await req.json(); } catch { return json({ ok: false, error: "invalid json" }, 400); }
      switch (b.action) {
        case "capture": {
          const state = await captureLayout();
          return json({ ok: true, capturedAt: state?.capturedAt ?? null });
        }
        case "restore": {
          const r = await restoreLayout(b.mode === "all" ? "all" : "lazy");
          return json(r, r.ok ? 200 : 400);
        }
        case "clear": {
          clearRestoreState();
          return json({ ok: true });
        }
        default:
          return json({ ok: false, error: "unknown action" }, 400);
      }
    }

    if (pathname === "/terminal/tmux/windows") {
      const name = String(url.searchParams.get("session") ?? "");
      if (!validPaneName(name)) return json({ ok: false, error: "invalid session" }, 400);
      return json({ ok: true, windows: await windowTree(name) });
    }

    if (pathname === "/terminal/tmux/windows" && req.method === "POST") {
      if (!trustedCaller(req, from)) return csrfBlocked();
      let b: any = {};
      try { b = await req.json(); } catch { return json({ ok: false, error: "invalid json" }, 400); }
      const name = String(b.session ?? "");
      if (!validPaneName(name)) return json({ ok: false, error: "invalid session" }, 400);
      const cwd = gitSafeAbs(b.cwd);
      if (!cwd || !fsExists(cwd)) return json({ ok: false, error: "that directory is not available" }, 400);
      let res: { ok: boolean; stdout: string; stderr: string };
      switch (b.op) {
        case "new":
          res = await newWindow(name, cwd, Array.isArray(b.argv) ? b.argv.map(String) : [], typeof b.title === "string" ? b.title : undefined);
          break;
        case "split":
          res = await splitPane(name, String(b.windowId ?? ""), b.direction === "horizontal" ? "horizontal" : "vertical", cwd, Array.isArray(b.argv) ? b.argv.map(String) : []);
          break;
        case "kill-window":
          res = await killWindow(name, String(b.windowId ?? ""));
          break;
        case "kill-pane":
          res = await killLayoutPane(name, String(b.windowId ?? ""), String(b.paneId ?? ""));
          break;
        case "select-window":
          res = await selectWindow(name, String(b.windowId ?? ""));
          break;
        case "select-pane":
          res = await selectPane(name, String(b.windowId ?? ""), String(b.paneId ?? ""));
          break;
        case "rename":
          res = await renameWindow(name, String(b.windowId ?? ""), String(b.title ?? ""));
          break;
        case "resize":
          res = await resizePane(name, String(b.windowId ?? ""), String(b.paneId ?? ""), Number(b.x ?? 0), Number(b.y ?? 0));
          break;
        default:
          return json({ ok: false, error: "unknown op" }, 400);
      }
      return json(res, res.ok ? 200 : 400);
    }

    if (pathname === "/terminal/commands") {
      const root = url.searchParams.get("root") || "";
      return body(await singleFlight(`cmds:${root}`, async () => JSON.stringify(await projectCommands(root))));
    }

    // --- multi-chat: drive claude sessions from the browser ---
    // `bypass` rides along so the mode picker can stop offering a mode the
    // server would silently downgrade — the downgrade itself stays server-side.
    // `tmuxEngine` tells the UI whether the pane engine can be offered at all,
    // and says why not in the same breath — "tmux is not installed" and "not on
    // Windows" need different words, and a toggle that silently does nothing is
    // worse than one that explains itself.
    if (pathname === "/chat/enabled") {
      const pane = paneEngineCapability();
      return json({
        enabled: CHAT_ENABLED,
        bypass: CHAT_BYPASS_ALLOWED,
        // Claude's list now arrives the same way Codex's and Antigravity's do,
        // so the panel has one path for all three instead of a table compiled
        // into the bundle for one of them. Read from shared/claude-models.json,
        // filtered to what has not reached its shutdown date.
        models: claudeModels(),
        tmuxEngine: { available: pane.available, reason: pane.reason, defaultOn: CHAT_ENGINE_DEFAULT === "tmux" },
      });
    }
    if (pathname === "/chat/send" && req.method === "POST") {
      if (!trustedCaller(req, from)) return csrfBlocked();
      let b: any = {};
      try { b = await req.json(); } catch { return json({ error: "invalid json" }, 400); }
      // The launch, not the turn. chatSend returns a stream rather than an
      // outcome, and the auditable fact is that somebody started an agent in a
      // checkout through this cockpit — what it then does is gated and lands in
      // the events table on its own.
      //
      // The prompt is deliberately not kept here. It is already in the
      // transcript and in `events`, and a second copy in an append-only table
      // that nothing prunes is a copy nobody asked for.
      noteAction(clientIp, "/chat/send",
        { root: b.cwd, name: b.model }, { ok: true }, caller);
      // What the turn may be is the caller's business, not the body's: a device
      // paired for "answer" gets the prompting default, no pre-approved tools,
      // and has to name a session that already exists — see scopedTurn in
      // chat.ts for the argv that came out of trusting the body instead.
      //
      // A null caller is the machine. The gate above only runs when a token is
      // configured, and with none configured this server refuses to bind
      // anything but loopback (resolveToken), so there is nobody else it could
      // be — and no device credentials exist in that world to be narrower than
      // it.
      return chatSend(b, caller?.scope ?? "full");
    }
    // The command that hands a chat to the user's own terminal. Server-side
    // because the socket name and flags are the engine's business, and a string
    // the UI assembled itself would drift the first time either changed.
    // Closing a chat gives its warm CLI back. Safe because it destroys nothing:
    // the conversation is on disk in the transcript, and resuming relaunches the
    // pane with `--resume`. Without this the ~380MB sits there until the idle
    // sweeper notices, half an hour after you said you were done with it.
    if (pathname === "/chat/pane/close" && req.method === "POST") {
      if (!trustedCaller(req, from)) return csrfBlocked();
      let b: any = {};
      try { b = await req.json(); } catch { return json({ error: "invalid json" }, 400); }
      const id = typeof b.session === "string" ? b.session : "";
      if (!validPaneName(id)) return json({ error: "invalid session id" }, 400);
      const was = await paneAlive(id);
      if (was) await killPane(id);
      forgetPane(id);
      return json({ killed: was });
    }
    /**
     * Keep this chat's pane, however long you are away.
     *
     * Eviction is right for the common case and wrong for the one conversation
     * you are living in — see `pinned` in tmuxpane.ts. Only about idleness:
     * closing the chat still releases the pane, because closing is an explicit
     * "done".
     */
    if (pathname === "/chat/pane/pin" && req.method === "POST") {
      if (!trustedCaller(req, from)) return csrfBlocked();
      let b: any = {};
      try { b = await req.json(); } catch { return json({ error: "invalid json" }, 400); }
      const id = typeof b.session === "string" ? b.session : "";
      if (!validPaneName(id)) return json({ error: "invalid session id" }, 400);
      const on = b.pinned !== false;
      pinPane(id, on);
      return json({ ok: true, session: id, pinned: on });
    }

    /**
     * What is actually running, and which of it belongs to nothing.
     *
     * Panes outlive the app: quit or crash and the sessions are still there,
     * each holding several hundred megabytes. The only way to see that was
     * `tmux -L agentglass ls` in a terminal, and the only way to clean up was
     * `kill-session` by hand.
     *
     * `orphan` is decided here rather than in tmuxpane.ts, because it is a
     * question about *chats* and that module knows only about panes: a pane is
     * an orphan when no chat this server is tracking points at it. `open` is
     * the set the caller says it has on screen — the client knows which chats
     * are open, and the server does not, so a pane belonging to a chat in
     * another window must not be reported as abandoned.
     */
    if (pathname === "/chat/panes") {
      const open = (url.searchParams.get("open") || "").split(",").map((s) => s.trim()).filter(Boolean);
      return json({
        // The judgement is in tmuxpane.ts and pure — see classifyPanes. It was
        // three lines here, which made it reachable only through a machine with
        // tmux genuinely running.
        panes: classifyPanes(await panes(), open, activeTurns()),
        // So the UI can say "reclaimed after 30 minutes" rather than guessing,
        // and can say "eviction is off" when somebody has turned it off.
        idleEvictMs: idleEvictMs(),
      });
    }

    // Answer an interactive prompt without leaving the chat. The pane already
    // takes Enter and Escape from us; arrows are the rest of what a picker
    // needs, and sending them here beats telling someone to open a terminal to
    // move a cursor one step.
    if (pathname === "/chat/pane/key" && req.method === "POST") {
      if (!trustedCaller(req, from)) return csrfBlocked();
      let b: any = {};
      try { b = await req.json(); } catch { return json({ error: "invalid json" }, 400); }
      const id = typeof b.session === "string" ? b.session : "";
      if (!validPaneName(id)) return json({ error: "invalid session id" }, 400);
      if (!sendableKey(b.key)) return json({ error: "key not allowed" }, 400);
      if (!(await paneAlive(id))) return json({ error: "that chat's pane is gone" }, 409);
      const r = await sendKey(id, b.key);
      if (!r.ok) return json({ error: r.stderr.trim() || "could not send the key" }, 500);
      // Hand back what the pane shows now, so the chat can redraw the prompt
      // the keystroke just moved rather than guessing at it.
      return json({ screen: await capturePane(id) });
    }
    if (pathname === "/chat/attach") {
      const id = url.searchParams.get("session") || "";
      const pane = paneEngineCapability();
      if (!pane.available) return json({ error: pane.reason }, 400);
      if (!validPaneName(id)) return json({ error: "invalid session id" }, 400);
      return json({ command: attachCommand(id), live: await paneAlive(id) });
    }

    // --- multi-chat: the same panel, driving codex instead ---
    // `models` comes back with `enabled` rather than from a route of its own:
    // the panel needs both to draw a single dropdown, and asking twice would
    // let it render a model picker for a CLI that turns out not to be there.
    if (pathname === "/codex/enabled") {
      return json({ enabled: CODEX_ENABLED(), bypass: CODEX_BYPASS_ALLOWED, models: CODEX_ENABLED() ? codexModels() : [] });
    }
    if (pathname === "/codex/send" && req.method === "POST") {
      if (!trustedCaller(req, from)) return csrfBlocked();
      let b: any = {};
      try { b = await req.json(); } catch { return json({ error: "invalid json" }, 400); }
      // Same reasoning as /chat/send: the launch is the auditable fact, not the
      // turn, and the prompt is already in Codex's own rollout.
      noteAction(clientIp, "/codex/send",
        { root: b.cwd, name: b.model }, { ok: true }, caller);
      return codexStream(b.cwd, b.message, b.model, b.resumeId, b.mode, b.images);
    }
    // What a Codex thread said, for a chat adopting it from the fleet. The
    // OTel stream carries tool calls but no prose, so this reads Codex's own
    // rollout — see codexTranscript(). Single-flighted like /session: several
    // panels opening the same thread should read the file once.
    if (pathname === "/codex/transcript") {
      const id = url.searchParams.get("id") || "";
      return body(await singleFlight(`codex:${id}`, async () => JSON.stringify({ timeline: codexTranscript(id) })));
    }

    // --- multi-chat: the same panel, driving google antigravity ---
    // No /antigravity/transcript to match the two above: Antigravity keeps each
    // conversation as a SQLite database of protobuf blobs on an undocumented
    // internal schema, so there is nothing here that could be read without
    // guessing at it — see server/src/antigravity.ts.
    if (pathname === "/antigravity/enabled") {
      return json({ enabled: ANTIGRAVITY_ENABLED(), bypass: ANTIGRAVITY_BYPASS_ALLOWED, models: ANTIGRAVITY_ENABLED() ? await antigravityModels() : [] });
    }
    if (pathname === "/antigravity/send" && req.method === "POST") {
      if (!trustedCaller(req, from)) return csrfBlocked();
      let b: any = {};
      try { b = await req.json(); } catch { return json({ error: "invalid json" }, 400); }
      noteAction(clientIp, "/antigravity/send",
        { root: b.cwd, name: b.model }, { ok: true }, caller);
      // `ingestBody` is handed in rather than imported by antigravity.ts, which
      // would be a cycle. It is also what puts an Antigravity chat on the radar
      // at all: unlike Claude (hooks) and Codex (OTel), this CLI reports to
      // nobody, so its own frames are the only source there is.
      return antigravityStream(b.cwd, b.message, b.model, b.resumeId, b.mode, b.images, ingestBody);
    }

    // --- LLM walkthrough: AI-authored review itinerary for the changes ---
    if (pathname === "/walkthrough" && req.method === "POST") {
      // Spawns the `claude` CLI, or spends an API key. It executes and it
      // costs money — the two properties the strict gate exists for.
      if (!trustedCaller(req, from)) return csrfBlocked();
      let b: any = {};
      try { b = await req.json(); } catch { return json({ error: "invalid json" }, 400); }
      if (!WALKTHROUGH_ENABLED) {
        return json({ available: false, reviewFocus: "", files: [], error: "no local `claude` CLI and no ANTHROPIC_API_KEY — install Claude Code or set a key" });
      }
      try {
        return json(await generateWalkthrough(Array.isArray(b.files) ? b.files : []));
      } catch (e: any) {
        return json({ available: true, reviewFocus: "", files: [], error: String(e?.message || e) });
      }
    }
    // Which sessions have a turn running right now. Read by any surface before
    // it sends: a message into a session that is mid-turn interrupts it and is
    // lost, and nothing else a client can poll answers this — the transcript
    // arrives late and "seen recently" is equally true of a session that
    // finished ten seconds ago. Deliberately outside the session cache: it
    // changes on process lifetimes, not on events.
    if (pathname === "/chat/active") return json({ ids: activeTurns() });
    if (pathname === "/session") {
      const id = url.searchParams.get("id") || "";
      if (!id) return json({ error: "not found" }, 404);
      // Cached per id (cleared on a new event for the session — see ingestBody)
      // and single-flighted, so a huge session's synchronous scan runs at most
      // once per change instead of once per poll per open tab.
      const out = await singleFlight(`session:${id}`, async () => {
        const hit = sessionCache.get(id);
        if (hit && Date.now() - hit.at < SESSION_TTL_MS * backoff()) return hit.body;
        const detail = getSession(id);
        const b = detail ? JSON.stringify(detail) : null;
        if (sessionCache.size > 40) sessionCache.clear();
        sessionCache.set(id, { at: Date.now(), body: b });
        return b;
      });
      return out ? body(out) : json({ error: "not found" }, 404);
    }
    if (pathname === "/skills") return json({ skills: await getSkills(), usage_since: usageSince(), generated_at: Date.now() });
    if (pathname === "/skills/export") {
      const fmt = url.searchParams.get("format") || "md";
      const dl = (body: string, type: string, name: string) =>
        new Response(body, {
          headers: { "content-type": type, "content-disposition": `attachment; filename="${name}"`, ...cors },
        });
      if (fmt === "json") return dl(JSON.stringify(await getSkills(), null, 2), "application/json", "skills-catalog.json");
      if (fmt === "csv") return dl(await catalogCsv(), "text/csv", "skills-catalog.csv");
      return dl(await catalogMarkdown(), "text/markdown", "skills-catalog.md");
    }
    if (pathname === "/sessions") {
      const limit = Math.min(1000, Number(url.searchParams.get("limit") || 100));
      return json(getSessions(limit, url.searchParams.get("provider") || undefined));
    }
    if (pathname === "/stats") {
      const windowMs = parseWindowMs(url.searchParams.get("window"));
      // tz is the viewer's IANA zone, which only the browser knows. The
      // heatmap is a weekday × hour grid and those are properties of a clock,
      // not of an epoch — without this it was drawn in the server's zone while
      // the timeline beside it was drawn in the viewer's.
      return json({
        ...statsSummary(
          windowMs,
          url.searchParams.get("provider") || undefined,
          url.searchParams.get("tz") || undefined,
        ),
        server_started_at: STARTED_AT,
        retention_days: RETENTION_DAYS,
      });
    }
    /*
     * The daily series, across the retention boundary.
     *
     * /stats reads the events table, which retention keeps at 8 days by
     * default — so its 30d and all-time windows were eight days of data
     * wearing a longer label. This one adds the folded days back, at the day
     * granularity they were folded to, and says where the seam is instead of
     * pretending there isn't one.
     */
    if (pathname === "/usage/daily") {
      const days = Math.max(1, Math.min(3650, Number(url.searchParams.get("days")) || 90));
      // Inclusive of today, so `days=1` means today rather than nothing.
      const from = new Date(Date.now() - (days - 1) * 86_400_000).toISOString().slice(0, 10);
      return json({
        days: dailyUsage(from),
        seam_day: retentionSeamDay(),
        retention_days: RETENTION_DAYS,
        rollup_from: rollupEarliestDay(),
      });
    }

    /*
     * What has been done through this cockpit.
     *
     * Unscoped on purpose. Every other metric narrows to the open project, but
     * the question this answers — "who merged that", "what happened while I was
     * at lunch" — is at its most useful precisely when the answer is somewhere
     * you were not looking.
     */
    if (pathname === "/actions") {
      const limit = Number(url.searchParams.get("limit") || 200);
      const before = Number(url.searchParams.get("before")) || undefined;
      return json({ actions: actionLog(limit, before).map((a) => ({ ...a, ok: !!a.ok })) });
    }

    // --- export ---
    /*
     * The daily series as a file.
     *
     * /export below hands out raw events, which retention deletes — so the
     * export inherited the same eight-day ceiling as the charts did, and the
     * one number people actually take out of here (what did this cost) could
     * not be exported for a month that had ended. This one reads the rollup
     * too, so what leaves the building goes back as far as the fold does.
     *
     * A separate `kind` rather than a new route, so a caller already pointed
     * at /export keeps working unchanged and switches grain with a parameter.
     */
    if (pathname === "/export" && url.searchParams.get("kind") === "daily") {
      const fmt = url.searchParams.get("format") || "json";
      const days = dailyUsage();
      if (fmt === "csv") {
        const cols = [
          "day", "events", "tool_calls", "tool_errors", "errors",
          "input_tokens", "output_tokens", "cache_creation_tokens", "cache_read_tokens",
          "cost_usd", "sessions", "avg_ms",
        ];
        const lines = [cols.join(",")];
        for (const d of days) lines.push(cols.map((c) => csvEscape((d as any)[c])).join(","));
        return new Response(lines.join("\n"), {
          headers: {
            "content-type": "text/csv",
            "content-disposition": 'attachment; filename="agentglass-daily.csv"',
            ...cors,
          },
        });
      }
      return new Response(
        JSON.stringify({ days, seam_day: retentionSeamDay(), retention_days: RETENTION_DAYS }, null, 2),
        {
          headers: {
            "content-type": "application/json",
            "content-disposition": 'attachment; filename="agentglass-daily.json"',
            ...cors,
          },
        },
      );
    }
    if (pathname === "/export") {
      const fmt = url.searchParams.get("format") || "json";
      const rows = exportRows();
      if (fmt === "csv") {
        const cols = [
          "id", "timestamp", "source_app", "session_id", "hook_event_type",
          "tool_name", "model_name", "is_error", "duration_ms",
          "input_tokens", "output_tokens", "cache_creation_tokens", "cache_read_tokens",
          "cost_usd", "error_text",
        ];
        const lines = [cols.join(",")];
        for (const r of rows) lines.push(cols.map((c) => csvEscape((r as any)[c])).join(","));
        return new Response(lines.join("\n"), {
          headers: {
            "content-type": "text/csv",
            "content-disposition": 'attachment; filename="agentglass-events.csv"',
            ...cors,
          },
        });
      }
      return new Response(JSON.stringify(rows, null, 2), {
        headers: {
          "content-type": "application/json",
          "content-disposition": 'attachment; filename="agentglass-events.json"',
          ...cors,
        },
      });
    }

    // --- SPA fallback ---
    // Every API route above has declined by now. A GET that asks for html is a
    // browser navigating to a UI deep-link (or a bookmark of one) — hand it
    // index.html and let the bundle take it from there. Anything else — curl,
    // fetch, an exporter probing a bad path — still gets the JSON 404.
    if (req.method === "GET" && (req.headers.get("accept") || "").includes("text/html")) {
      const page = serveIndex(cors);
      if (page) return page;
    }

    return json({ error: "not found" }, 404);
  },

  websocket: {
    open(ws: ServerWebSocket<WsData>) {
      // Before the per-kind branches: every socket counts towards "this device
      // is connected right now", and every socket has to be closable when the
      // user cuts that device off.
      sockets.add(ws);
      noteSocket(ws.data?.ip, 1);
      if (ws.data?.kind === "pty") { ptyOpen(ws); return; }
      if (ws.data?.kind === "notify") {
        notifySubs.set(ws, subscribeNotifications((n) => {
          try { ws.send(JSON.stringify(n)); } catch { /* closing */ }
        }));
        return;
      }
      clients.add(ws);
      // Alive from the moment it connects, so the first alert after a page load
      // is never mistaken for a frozen peer and answered with notify-send as
      // well. The sweep has 30 seconds to disagree.
      alive.set(ws, Date.now());
      // openTools seeds the client's "running" state for tools whose PreToolUse
      // predates the 300-event initial slice — otherwise a long job in flight
      // when the page loads shows as idle (or missing) until its Post arrives.
      // Each open call carries when its session last showed evidence of life —
      // read here rather than in db.ts, which has no business touching the
      // filesystem. See evidence.ts for why elapsed time alone cannot answer it.
      const frame: WsFrame = { type: "initial", data: getRecent(300), openTools: withEvidence(openToolCalls()) };
      ws.send(JSON.stringify(frame));
    },
    close(ws: ServerWebSocket<WsData>) {
      sockets.delete(ws);
      // With `sockets`, above the per-kind branches, because a pty or notify
      // socket answers a ping too — and those two branches return before the
      // bottom of this function, so anything tidied down there is tidied for
      // event streams only and leaks an entry per terminal.
      alive.delete(ws);
      noteSocket(ws.data?.ip, -1);
      if (ws.data?.kind === "pty") { ptyClose(ws); return; }
      if (ws.data?.kind === "notify") {
        // Unsubscribing is what stops the monitor process once the last
        // listener goes, so this must run on every close path.
        notifySubs.get(ws)?.();
        notifySubs.delete(ws);
        return;
      }
      clients.delete(ws);
    },
    message(ws: ServerWebSocket<WsData>, msg) {
      if (ws.data?.kind === "pty") ptyMessage(ws, msg as string | Buffer);
      /* event-stream clients are read-only */
      // ...but a frame that did arrive is still proof somebody is running.
      else alive.set(ws, Date.now());
    },
    /** The answer to the sweep's ping, and the only routine evidence an
     *  event-stream client ever sends: it is otherwise read-only. */
    pong(ws: ServerWebSocket<WsData>) {
      alive.set(ws, Date.now());
    },
  },
});

// One-shot backfill: earlier builds never detected tool_response errors, so
// historical rows are all is_error=0. Re-evaluate them once (guarded by the
// schema version) so analytics/health reflect real failures immediately.
function backfillErrors() {
  const VER = 2;
  const cur = (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
  if (cur >= VER) return;
  const rows = db
    .query<{ id: number; hook_event_type: string; payload: string }, []>(
      "SELECT id, hook_event_type, payload FROM events WHERE is_error = 0 AND payload LIKE '%tool_response%'"
    )
    .all();
  const upd = db.query("UPDATE events SET is_error = 1, error_text = COALESCE(error_text, $t) WHERE id = $id");
  let fixed = 0;
  const tx = db.transaction(() => {
    for (const r of rows) {
      let payload: Record<string, unknown> = {};
      try { payload = JSON.parse(r.payload); } catch { continue; }
      const { is_error, error_text } = detectError(r.hook_event_type, payload);
      if (is_error) { upd.run({ $id: r.id, $t: error_text }); fixed++; }
    }
  });
  tx();
  db.exec(`PRAGMA user_version = ${VER}`);
  if (fixed) console.log(`🔧 backfilled ${fixed} error events (of ${rows.length} scanned)`);
}
backfillErrors();

// Populate the full-text index from history once (guarded separately).
function backfillFts() {
  const VER = 3;
  const cur = (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
  if (cur >= VER) return;
  const rows = db.query<{ id: number; source_app: string; session_id: string; hook_event_type: string; tool_name: string | null; error_text: string | null; payload: string }, []>(
    "SELECT id, source_app, session_id, hook_event_type, tool_name, error_text, payload FROM events WHERE id NOT IN (SELECT rowid FROM events_fts)"
  ).all();
  const ins = db.query("INSERT INTO events_fts(rowid, text) VALUES ($id, $text)");
  const tx = db.transaction(() => {
    for (const r of rows) {
      let payload: Record<string, unknown> = {};
      try { payload = JSON.parse(r.payload); } catch { /* skip */ }
      ins.run({ $id: r.id, $text: ftsText({ ...r, payload }) });
    }
  });
  tx();
  db.exec(`PRAGMA user_version = ${VER}`);
  if (rows.length) console.log(`🔎 indexed ${rows.length} events for full-text search`);
}
backfillFts();

// Backfill the sessions.provider column (added for the provider filter) from
// each session's model_name — so the filter works over existing history too.
function backfillProvider() {
  const VER = 5; // 5: per-event events.provider (added alongside the multi-provider fix)
  const cur = (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
  if (cur >= VER) return;

  // sessions.provider — kept for the session badge (first-seen). No-op re-run
  // once a DB has already been tagged.
  const rows = db.query<{ session_id: string; model_name: string | null }, []>(
    "SELECT session_id, model_name FROM sessions WHERE provider IS NULL AND model_name IS NOT NULL"
  ).all();
  const upd = db.query("UPDATE sessions SET provider = $p WHERE session_id = $sid");
  // events.provider — one UPDATE per distinct model rather than per row: the
  // model set is tiny, the events table is not.
  const models = db.query<{ model_name: string | null }, []>(
    "SELECT DISTINCT model_name FROM events WHERE provider IS NULL AND model_name IS NOT NULL"
  ).all();
  const updEv = db.query("UPDATE events SET provider = $p WHERE model_name = $m AND provider IS NULL");
  let n = 0, ev = 0;
  const tx = db.transaction(() => {
    for (const r of rows) {
      const p = providerOf(r.model_name);
      if (p) { upd.run({ $p: p, $sid: r.session_id }); n++; }
    }
    for (const m of models) {
      const p = providerOf(m.model_name);
      if (p) ev += updEv.run({ $p: p, $m: m.model_name }).changes;
    }
  });
  tx();
  db.exec(`PRAGMA user_version = ${VER}`);
  if (n || ev) console.log(`🏷  tagged ${n} sessions and ${ev} events with a provider`);
}
backfillProvider();

/**
 * Repair a theme file written before #336.
 *
 * #336 stopped generating `set -g status-left "…"` / `set -g status-right
 * "…"`, which replaced whatever the user had in those segments — including,
 * in the case that found this, the `#(continuum_save.sh)` interpolation that
 * is tmux-continuum's entire save timer. But that only changed what is
 * *written*: the file is rewritten once per theme change, so anyone who ran
 * agentglass before the fix still has the old one on disk, sourced by every
 * tmux server that opts in. The bug came back on the next new server, and
 * the owner had no reason to suspect a file they have never opened.
 *
 * Fixed here rather than on the next theme change, because regenerating the
 * file needs the palette and the palette comes from the browser — so waiting
 * means the people happiest with their theme never get the fix.
 */
function repairThemeArtifacts() {
  const path = tmuxThemePath();
  try {
    if (!fsExists(path)) return;
    const repaired = repairTmuxTheme(fsRead(path, "utf8"));
    if (repaired === null) return;
    fsWrite(path, repaired);
    console.log(`🩹 removed the status-left/right lines from ${path} — those segments are yours (#339)`);
  } catch {
    // Unreadable or read-only: not worth failing a boot over. The generator
    // no longer writes those lines, so a fresh file is correct anyway.
  }
}
repairThemeArtifacts();

// Retention: prune at boot and hourly so the DB stays lean but the 7d window
// always has full history (see AGENTGLASS_RETENTION_DAYS in db.ts).
function prune() {
  const { events, sessions, rolled } = pruneOldRows();
  if (events || sessions) {
    // `rolled` counts day-rows written, not events summarised. The point it
    // makes is that the numbers outlived the rows they came from.
    const folded = rolled ? ` → folded into ${rolled} rollup days` : "";
    console.log(`🧹 pruned ${events} events / ${sessions} sessions older than ${RETENTION_DAYS}d${folded}`);
  }
}
prune();
setInterval(prune, 3_600_000);

// Reclaim chat panes nobody has spoken to in a while. A warm CLI is the whole
// point of the pane engine and also its whole cost (~380MB and climbing), so an
// abandoned chat gives its memory back and resumes transparently next time.
// A no-op when the engine is off, tmux is absent, or eviction is disabled.
startPaneSweeper();
startTaskSweep();
startReminderTick();

// Photograph the pane layout so a reboot can give it back. When the restore
// feature is on: capture immediately (a reboot in the next minute loses
// nothing), restore at boot — idempotent, since live sessions are skipped —
// and sweep on a timer. All no-ops when the feature is off or tmux is gone.
if (tmuxRestoreEnabled()) {
  void captureLayout();
  void restoreLayout();
}
startRestoreSweeper(tmuxRestoreEnabled);

/*
 * Take the database file for this process, before anything sweeps it.
 *
 * The transcript scanner is not idempotent — its events carry no event_id, so
 * the ingest idempotency index cannot dedupe them — and the default database
 * path is the shared one under $XDG_DATA_HOME. A second server pointed at the
 * same file (a test instance on another port, which the ":4000 attach" check
 * never sees) therefore doubles events, tokens and cost in silence. Measured on
 * this machine's real history: 22 duplicate groups out of 100,354 scanner
 * events. The loser of this claim still serves, still ingests hooks, still
 * shows the dashboard — it just does not sweep. See db.ts for how a claim left
 * behind by a SIGKILLed process is told apart from a live one.
 */
const dbClaim = claimDatabase(server.port ?? PORT);
if (!dbClaim.ok && dbClaim.holder) {
  console.warn(
    `🔒 ${dbPath()} is claimed by pid ${dbClaim.holder.pid} (port ${dbClaim.holder.port}) — this server will not scan transcripts.`
  );
  console.warn(`   Set AGENTGLASS_DB to a file of your own to run a second instance with its own history.`);
} else if (dbClaim.tookOver) {
  console.log(`🔒 took over the database claim from pid ${dbClaim.tookOver.pid} — it is no longer running`);
}

// Read every Claude Code session on this machine from ~/.claude/projects, then
// keep watching. This is what makes the dashboard cover all projects at once
// instead of only the directory agentglass happens to run from.
startScanner(({ event, session }) => {
  // Same as ingestBody: the scanner tails live transcripts straight through
  // insertEvent (not ingestBody), so this is the other path a session grows on
  // — drop its cached detail here too, or a session being watched live would
  // read stale until the TTL backstop.
  sessionCache.delete(event.session_id);
  // Stored either way — a cockpit scoped today may be unscoped tomorrow, and the
  // history has to be there when it is. Only the live push is filtered, so that
  // what arrives while you watch agrees with what a reload would show.
  if (sessionInScope(session)) {
    broadcast({ type: "event", data: event });
    broadcast({ type: "session", data: session });
  }
  // A Pre opens a call and a Post closes one, so the list the fleet is drawing
  // from just changed. Pushed now rather than up to a tick later, because the
  // moment a tool starts is exactly when the card should say so.
  if (event.hook_event_type === "PreToolUse" || event.hook_event_type.startsWith("PostToolUse")) pushOpenTools();
  maybeAlert(event);
});

// Bring back the gate requests that were in flight when this process last
// stopped. Anything still inside its window returns to "what needs you"; the
// rest is resolved by the configured policy and recorded, never dropped.
const gates = restoreGates();
if (gates.restored || gates.expired) {
  console.log(`✋ gate: ${gates.restored} pending restored, ${gates.expired} expired while down (${process.env.AGENTGLASS_GATE_FAILCLOSED === "1" ? "denied" : "allowed"})`);
}

// Hang up shells and clean temp dirs on the way out — a bare kill leaves them
// orphaned. Re-raise so the default disposition still terminates the process.
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => { shutdownTerminals(); releaseDatabaseClaim(); process.exit(0); });
}

/*
 * Give back every tmux window a previous run pinned and was killed before
 * releasing.
 *
 * The handler above covers SIGINT and SIGTERM. It does not cover SIGKILL, an
 * OOM kill, or the machine going down — and after a day of hard kills a user
 * was left with one window of a five-window session at 54 rows inside a 59-row
 * client, `window-size manual`, permanently, with nothing on screen to say
 * what had done it. A restore that only ever runs on the way out cannot fix
 * that; only the next way IN can. See `sweepPinnedWindows` for what proves a
 * window is ours to touch and for the one case where it would be wrong.
 *
 * Synchronous, and deliberately before the server starts answering: measured at
 * 2.4ms for a walk that finds nothing (one `list-windows` per tmux server —
 * every boot after a clean shutdown) and 28.3ms for the worst case measured,
 * eight marked windows with one really pinned. A window put back after the UI
 * is already showing a tab strip is a window the user watches jump.
 *
 * `pinnedSockets()` and NOT `tmuxSockets()`, which is what this line used to
 * say and is the whole of the bug it was changed for. `tmuxSockets()` lists
 * every socket in `$TMUX_TMPDIR/tmux-<uid>` — 25 of them here, and with
 * TMUX_TMPDIR unset that directory is the developer's own. This module runs at
 * import, so every process that starts this file ran that walk: the desktop
 * app, `make dev`, and the six scripts under `scripts/` that spawn this server
 * with no NODE_ENV and no TMUX_TMPDIR. `pinnedSockets()` answers the question
 * this line is actually asking — which servers has this installation pinned a
 * window on — and a boot that has pinned none now issues no tmux command at
 * all. See THE PIN LEDGER in tmuxctl.ts.
 */
const unpinned = sweepPinnedWindows(pinnedSockets());
if (unpinned) console.log(`🪟 tmux: ${unpinned} window(s) released — a previous run was killed before it could put window-size back`);

/*
 * Keep a copy of the user's last good resurrect save, and put `last` back if a
 * dying server's save has landed on top of it.
 *
 * Measured on a real machine, and it cost a working session: a save fired while
 * tmux was being killed, wrote a file with one pane in it, and `last` moved to
 * that — leaving a nine-pane save from ten minutes earlier on disk and
 * unreachable by anything that restores. resurrect has no notion of "poorer",
 * and racing continuum's timer would be two savers on one server, which is its
 * own way to lose sessions. So: copy, and repair the pointer THEIR restore
 * reads. See tmuxsnapshot.ts for what it will and will not touch.
 *
 * At boot and then every few minutes. A tick that finds the same save does
 * nothing at all, which is nearly every tick.
 */
const SNAPSHOT_TICK_MS = 4 * 60 * 1000;
function guardResurrect(): void {
  const put = repairLast();
  if (put) {
    console.log(`💾 tmux: restored resurrect's "last" to ${put.restored} — a save from a dying server had replaced it (the poor one is kept as last.clobbered)`);
  }
  const took = snapshot();
  if (took) console.log(`💾 tmux: kept a copy of ${took.split("/").pop()}`);
}
guardResurrect();
setInterval(guardResurrect, SNAPSHOT_TICK_MS).unref?.();

// Parent-death watchdog: a server must never outlive whoever launched it.
//
// The signal handlers above only cover a clean SIGINT/SIGTERM. They do nothing
// when the launcher is SIGKILLed or crashes, and there is no launcher-side
// cleanup at all for `make dev`, the perf/soak scripts, or a server an agent
// left running inside a worktree that was later deleted (cwd `(deleted)`). The
// only other thing that stops a sidecar is Electron's in-process stopSidecar
// handler, which likewise cannot survive its own SIGKILL. The observed result:
// a dozen servers reparented to init, each holding a port and a fistful of
// shells, still running ~18h later and saturating the box. This gives the
// server its own defence — it remembers the pid it was born under and, every
// few seconds, checks that pid is still both its parent and alive. Reparented
// to init (ppid 1), handed to a different parent, or the original gone → hang
// up the shells and exit under its own power, within ~3s of losing its parent.
//
// Gated behind a flag the launcher opts into, so a deliberately daemonized
// `make start` is never self-terminated. Every launcher that expects the
// server to die with it sets the flag (the electron spawn, the dev script, the
// perf/soak spawns); the 432-test suite never sets it, so the watchdog stays
// dormant under `make test` — which is why the interval is not even registered
// unless the flag is present. `process.ppid === 1` is the robust signal: a
// crash of an intermediate wrapper (`bun --watch`, `concurrently`) reparents
// the whole subtree to init, which a bare `!== bornUnder` on a still-live
// wrapper would miss; `!== bornUnder` in turn catches the immediate parent
// alone going away and the pid being recycled under a new owner.
if (process.env.AGENTGLASS_DIE_WITH_PARENT === "1") {
  const bornUnder = process.ppid;
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  setInterval(() => {
    if (process.ppid === 1 || process.ppid !== bornUnder || !alive(bornUnder)) {
      shutdownTerminals();
      // The orphan path is a normal exit, not a crash, so hand the database
      // claim back here too — a released claim saves the next boot a liveness
      // check, and this is the way the packaged app most often goes away.
      releaseDatabaseClaim();
      process.exit(0);
    }
  }, 3000).unref?.();
}

console.log(`🛰  agentglass server on http://${LOOPBACK_ONLY ? "localhost" : BIND}:${server.port}`);

/*
 * The origin gate trusts this machine's own Tailscale name, and the Remote pane
 * offers its HTTPS URL to pair over — both read a cache filled here. First read
 * at boot; refreshed to catch `tailscale serve` being turned on or off.
 *
 * Self-scheduling rather than a fixed 120s interval, and that is the T26 half
 * that lives outside remote.ts. A fixed interval was fine while every probe was
 * believed. It is wrong now that a probe can come back "could not ask": the
 * cache is then running on a HELD value with a deadline on it, and the failing
 * state is the one worth leaving fastest. `refreshTailscale` returns how long
 * to wait — short after a failure, TAILNET_OK_MS after an answer.
 *
 * The `.catch` is not decoration: `refreshTailscale` is written not to throw,
 * but if it ever did, an unguarded chain would stop here for good and the trust
 * cache would freeze at whatever it last held — silently, which is the exact
 * failure class this ticket is about.
 */
const watchTailnet = async (): Promise<void> => {
  const next = await refreshTailscale(server.port ?? PORT)
    .then((p) => p.nextMs)
    .catch((e) => { console.warn("[remote] tailnet refresh threw:", e); return TAILNET_OK_MS; });
  setTimeout(() => void watchTailnet(), next);
};
void watchTailnet();
if (!LOOPBACK_ONLY) {
  const posture = AUTH_TOKEN ? "token-protected" : "UNAUTHENTICATED";
  console.warn(`⚠  bound to ${BIND} — this exposes a shell, git write access and docker control to the network (${posture})`);
  if (!TRUST_LAN) console.warn(`⚠  AGENTGLASS_TRUST_LAN is not set — LAN browsers will be refused as cross-origin; set it to allow them`);
}
if (AUTH_TOKEN) {
  if (AUTH.source === "generated") {
    console.log(`🔑 auth token (generated, saved ${AUTH.path} — keep it):`);
    console.log(`     ${AUTH_TOKEN}`);
    console.log(`     open the dashboard as  <url>/?token=${AUTH_TOKEN}`);
  } else if (AUTH.source === "file") {
    console.log(`🔑 auth token loaded from ${AUTH.path} — clients must pass ?token= or Authorization: Bearer`);
  } else {
    console.log(`🔑 AGENTGLASS_TOKEN set — clients must pass ?token= or Authorization: Bearer`);
  }
}
if (WEB_UI_ENABLED) console.log(`   Web UI      → http://localhost:${server.port}/ (serving ${distPath()})`);
console.log(`   POST events → http://localhost:${server.port}/ingest`);
console.log(`   WebSocket   → ws://localhost:${server.port}/stream`);
console.log(`   Stats API   → http://localhost:${server.port}/stats`);
console.log(`   Retention   → ${RETENTION_DAYS ? `${RETENTION_DAYS} days` : "unlimited"}`);
const ws = workspaceRoot();
console.log(ws ? `   Project     → ${ws} (this project only)` : "   Project     → every project on this machine");
// Only meaningful once a project is open — see startAutoFetch().
startAutoFetch();
// A pull request's checks finished. The latch is on the server so the message
// arrives once per verdict no matter how many browser tabs are watching, and
// the frame carries the names of what failed rather than only a count.
subscribeCi((v) => broadcast({ type: "ci", data: v }));
/* A card of yours moved. Derived from a poll rather than received — ClickUp has
   no notifications API — and silent on the first run, so connecting an account
   does not announce a day of history. See clickupwatch.ts. */
startCardWatch((n) => broadcast({ type: "card", data: n }));
// Watch our own event loop. Cheap (one timer, one subtraction) and the only
// thing that turns "the terminal feels laggy" into a name and a number.
watchLoop();

// Say it once at boot if git is missing. Every git/diff/PR panel and the
// terminal need it, and without this the only symptom is empty panels that
// blame the repo — the log line is where an installer user finds the real
// cause without opening devtools.
{
  const gc = gitCapability();
  if (!gc.available) console.warn(`⚠  git not found on PATH — the git, diff, pull-request and terminal panels will not work. Install git to enable them.`);
  // Said for the same reason, and it is the quieter failure of the two: with no
  // python3 the hooks stay wired and fail on every event, so the dashboard is
  // simply empty and nothing anywhere names the cause. Settings ▸ Requirements
  // is the same list for anyone who never sees this log.
  if (PTY_BACKEND !== "pty" && !Bun.which("python3") && !Bun.which("python")) {
    console.warn(`⚠  python3 not found on PATH — the Claude Code hooks cannot forward events (nothing will stream live), and the terminal falls back to ${PTY_BACKEND} mode.`);
  }
}
