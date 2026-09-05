// FIRST, and it must stay first: `agentglass-server cookies …` is answered
// here, before the imports below open the database and start their timers.
import "./cookieentry.ts";
import type { ServerWebSocket } from "bun";
import type { IngestBody, WsFrame, WorkingTree, PanesResponse, AgentSessionRow } from "../../shared/types.ts";
import { slackReachable } from "./slackreach.ts";
import { normalize, detectError, clampIngestTimestamp, externalIngestError } from "./ingest.ts";
import { db } from "./db.ts";
import {
  insertEvent,
  getRecent,
  capPayloadStrings,
  openToolCalls,
  getFilterOptions,
  getSessions,
  statsSummary,
  exportRows,
  pruneOldRows,
  reclaimFreePages,
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
  noteWaitFromHook,
} from "./db.ts";
import { maybeAlert, setAlertSink } from "./alerts.ts";
import { noteAction, actorOf, type ActorSource } from "./actions.ts";
import { getSkills, catalogMarkdown, catalogCsv, usageSince } from "./skills.ts";
import { getInsights } from "./insights.ts";
import { getUsage, ingestStatusline } from "./usage.ts";
import { chooseModel, type UsageNow, type Choice } from "./understudy-model.ts";
import { allProviderUsage } from "./providerusage.ts";
import { refreshCodexUsage } from "./codexusage.ts";
import { submitGate, decideGate, pendingGates, awaitGate, restoreGates, typedReason, GATE_MAX_MS, gateFailClosed } from "./gate.ts";
import { budgetHoldFor } from "./budget.ts";
import { parseControlCmd } from "./control.ts";
import { askBrowser, browserReadyCount, exportAudit, noteBrowserReady, parseAsk, setBrowserSink, settleBrowser, type BrowserOp, runSteps, waitForEvents, recordFrames, traceRecording, auditAsScript, downloadFile, runLanes, withObservation} from "./browserdrive.ts";
import { browserUseStatus, installSkill } from "./browseruse.ts";
import { otlpTracesToEvents, otlpLogsToEvents } from "./otlp.ts";
import { decodeOtlpTraces, decodeOtlpLogs } from "./otlp_pb.ts";
import { statusForPaths, commit as gitCommit, amend as gitAmend, COMMIT_ENABLED, gitAsync, gitCapability, repoRootOf, safeAbs as gitSafeAbs } from "./git.ts";
import { dependencyReport } from "./deps.ts";
import {
  workingTree, lastCommitChanges, discoverRepos, stage, unstage, stageAll, unstageAll, discard,
  commitStaged, push as gitPush, pull as gitPull, fetch as gitFetch,
  protectedBranches, setProtectedBranches,
  branches as gitBranches, checkout as gitCheckout, createBranch, deleteBranch,
  log as gitLog, commitDiff, stashList, stashPush, stashApply, stashPop, stashDrop,
  stashRename, stashToBranch, stashPartial, stashApplyOverwrite,
  refs, listSnapshots, createSnapshot, restoreSnapshot, deleteSnapshot,
  applyHunk, logGraph, mergeBranch, rebaseBranch, renameBranch, resetTo,
  worktreesWithState as gitWorktrees, addWorktree, removeWorktree, worktreeLeftovers, rescueLeftovers, fixWorktreeOwnership, startAutoFetch, syncFromBase, setBase, setGitChangeHook, setMergedVerdictHook, setPrBaseHook,
  conflicts as gitConflicts, resolveWith, conflictBlocks, conflictFile, resolveBlocks, mergeSession, reopenConflict, stoppedRefusal, conflictPreview, mergeAbort, mergeContinue, baseCandidates, undoMerge, mergeInfo,
  cherryPick, cherryPickContinue, cherryPickAbort,
  revertCommit, amendCommit, squashCommits,
  rebaseSteps, runRebase, compareRefs,
  remotes as gitRemotes, remoteBranches as gitRemoteBranches, trackRemoteBranch, tags as gitTags, reflog as gitReflog,
  submodules as gitSubmodules, submoduleAdd, submoduleUpdate, submoduleSync, submoduleDeinit, submoduleRemove,
  blameFile, fileHistory,   bisectStatus, bisectStart, bisectMark, bisectReset,
  searchCommits, grepWorkingTree, searchHistory,
  createTag, deleteTag, pushTag, deleteRemoteTag,
  prepareConflictMerge,
  worktrees as repoWorktrees,
} from "./gitwork.ts";
import { sessionsForProject } from "./agentsessions.ts";
import { changeRows, fileDiff } from "./changerows.ts";
import { repoStats, generateChangelog } from "./gitinsights.ts";
import { saveShot } from "./shots.ts";
import { allPlaces, forgetPlaces, placeCount, recordVisit, saveFrom } from "./placestore.ts";
import { recent as gitCommandLog } from "./gitlog.ts";
import { worktreeParent } from "./worktree.ts";
import { watchLoop, entered, stalls, backoff } from "./loopwatch.ts";
import { spawnPoolStats } from "./spawnpool.ts";
import { singleFlight, inflightCount } from "./singleflight.ts";
import { openInEditor, editorTarget, editorCapability, HAS_NVIM } from "./editor.ts";
import { syncTheme, snippetStatus, SNIPPETS, tmuxThemePath, repairTmuxTheme, currentTheme } from "./themesync.ts";
import { existsSync as fsExists, readFileSync as fsRead, writeFileSync as fsWrite, mkdtempSync } from "node:fs";
import { completePath, FS_BROWSE_ENABLED } from "./fsbrowse.ts";
import { listPorts, listResources, spaceFor, killPort } from "./machine.ts";
import { gitLocks, removeStaleLock } from "./gitlocks.ts";
import { procDetail, revealEnv } from "./procdetail.ts";
import {
  listIssues, issueDetail, issuePullRequests, startIssue, finishIssue, claimIssue, commentIssue, setIssueState, currentWork,
} from "./issues.ts";
import { currentRuns, runById, runActivity, startRun, adoptPane, finishRun } from "./runs.ts";
import { providerStatuses, connectProvider, disconnectProvider, providerWorkspaces, chooseWorkspace, addViewByUrl, addClickupFolder, refreshFoldersIfStale, replaceViewUrl, readView } from "./providers.ts";
import { savedViews, savedFolders, currentView, setCurrent, removeView, removeFolder, knownCardPrefix, boardHolding, setWritesAllowed } from "./clickupviews.ts";
import { assignSelf, setAssignee, setCard, listMembers, setStatus, setPriority, setField, clearField, sprintLists, searchTasks, searchTasksStream, warmBodySweep, taskDetail, findCard, cardPullRequests, clickupWriteEnabled, commentOn, updateTask, setTag, moveToList, createTask, addChecklist, addChecklistItem, setChecklistItem, editComment as editClickupComment, replyToComment, resolveComment, deleteComment as deleteClickupComment } from "./clickup.ts";
import { clickupTasks } from "./clickup.ts";
import type { ProviderId } from "../../shared/providers.ts";
import { listTasks, taskCapability, setTaskChangeHook, startTaskSweep, addTask, completeTask, reopenTask, deleteTask, cyclePriority, editTask, addTags, replaceNote, bulkApply, TASK_WRITE_ENABLED, type BulkAction } from "./tasks.ts";
import {
  addReminder, ackReminder, cancelReminder, snoozeReminder, listReminders,
  remindersFor, firedUnacked, setReminderHook, startReminderTick, localZone,
} from "./reminders.ts";
import { fileText, fileToTemp, fileTree, findFiles, grepFiles, listRefs, filesExist } from "./files.ts";
import { diskFind, diskGrep, diskPlaces } from "./disk.ts";
import { browseDir, fileBytes, fileFacts, openInDesktop } from "./browse.ts";
import { benchEdit, benchEnd, benchLive, readNote, writeNote } from "./bench.ts";
import {
  overview as dockerOverview, stats as dockerStats, logs as dockerLogs, inspect as dockerInspect, top as dockerTop,
  disk as dockerDisk, volumeDetail as dockerVolumeDetail, volumePeek as dockerVolumePeek, DOCKER_WRITE_ENABLED,
  envCompare as dockerEnvCompare,
  startContainer, stopContainer, restartContainer, removeContainer, dockerCapability,
} from "./docker.ts";
import { streamLogs } from "./dockerlogs.ts";
import { capBuildCache, removeImages } from "./dockerprune.ts";
import { inbox, markRead, markRepoRead, unsubscribe } from "./ghinbox.ts";
import { measureFile } from "./filemeasure.ts";
import { editorCursor } from "./editorwhere.ts";
import {
  listPrs, prDetail, prDiff, prAsset, ghCapability, submitReview, addComment, replyToThread,
  editComment, deleteComment, hideComment, unhideComment, setFileViewed, setAssignees, setMilestone, viewCounts, jobLog, checkJobs, rerunJobs, addLineComment, mentionables, facetOptions, applySuggestion, fileSlice,
  setThreadResolved, react, editPr, setLabels, setReviewers, setDraft, updateBranch,
  rerunFailedChecks, mergePr, closePr, filesSince, codeowners, prepareReviewPrompt, pendingReviewFor, branchUrl, subscribeCi, subscribeTalk, commitDiff as prCommitDiff, submitReviewWith, prFileToTemp,
  prBaseOf,
  ghRateLimit,
  branchBehind, localHead, prRollup,
  prBranches, prsForBranch, nodeIdOk } from "./prs.ts";
import { repoSpend } from "./spend.ts";
import { generateWalkthrough, WALKTHROUGH_ENABLED } from "./walkthrough.ts";
import { ptyOpen, ptyMessage, ptyClose, projectCommands, shutdownTerminals, lastTmuxTarget, sessionTitle, TERMINAL_ENABLED, PTY_BACKEND, type PtyWsData } from "./terminal.ts";
import { agentBinFor, mintAgentTicket } from "./agentticket.ts";
import { makeViewTempDir } from "./viewtemp.ts";
import { transcribe, transcriberOn } from "./dictate.ts";
import { AGENT_KINDS, agentKind } from "../../shared/agentKinds.ts";
import { claudeCode } from "./agents/claudecode.ts";
/* Both sides' imports: main added five, this branch still uses `panesWithPids`
   and `reapMirrorSessions`. Neither list is a superset of the other. */
import { listPanes, focusPaneAnywhere, activePane, panesWithPids, sweepPinnedWindows, pinnedSockets, reapMirrorSessions, startMirrorSweeper, stopMirrorSweeper } from "./tmuxctl.ts";
import { repairLast, snapshot } from "./tmuxsnapshot.ts";
import { withAgentSessions } from "./paneloc.ts";
import { notePaneFromHook, paneDirs, paneAgentNote } from "./panewt.ts";
import { chatSend, activeTurns, CHAT_ENABLED, CHAT_BYPASS_ALLOWED, CHAT_ENGINE_DEFAULT } from "./chat.ts";
import { paneEngineCapability, attachCommand, validPaneName } from "./chatpane.ts";
import { tmuxBinStatus, tmuxSocket } from "./tmuxbin.ts";
import { applyTmuxConf, resetTmuxConf, confHealth, ensureConf, sweepStaleConfs } from "./tmuxconf.ts";
import { captureLayout, restoreLayout, clearRestoreState, lastCaptureAt, startRestoreSweeper, noteLaunch, forgetSession, noteCrashLoop, crashLoopWarning, captureLayoutSync } from "./tmuxrestore.ts";
import {
  windowTree, newWindow, splitPane, killWindow, killPane as killLayoutPane, selectWindow, selectPane,
  renameWindow, resizePane,
} from "./tmuxlayout.ts";
import { tmuxConfMode, tmuxOverride, tmuxRestoreEnabled, tmuxResume, tmuxSource, tmuxPrefix, tmuxTerminal, validTmuxPrefix, writeTmuxSettings, lanternNudge, lanternWatch, lanternWatchMinutes, cacheTtlMinutes, lanternNudgeMinutes, writeLanternSettings, LANTERN_NUDGE_MIN_MIN, LANTERN_NUDGE_MAX_MIN } from "./config.ts";
import { claudeModels } from "./claudemodels.ts";
import { codexStream, codexModels, codexTranscript, codexCwd, CODEX_ENABLED, CODEX_BYPASS_ALLOWED } from "./codex.ts";
import { antigravityStream, antigravityModels, ANTIGRAVITY_ENABLED, ANTIGRAVITY_BYPASS_ALLOWED } from "./antigravity.ts";
import { paneAlive, killPane, forgetPane, startPaneSweeper, sendKey, sendableKey, capture as capturePane, pinPane, panes, classifyPanes, idleEvictMs, reloadEngineConf, tmuxCapability, engineWindowRunning, tmux } from "./tmuxpane.ts";
import { takeLease, endLease, leaseHeld, reapLeases } from "./panelease.ts";
import { runAgentInteractivePane } from "./understudy-pane.ts";
import { startScanner, ownsSession, knownProjects, resyncScope, scanningEnabled } from "./transcripts.ts";
import { workspaceRoot, setWorkspaceRoot, inScope, sessionInScope, chatBypassAllowed, readBudgets, writeBudgets, hiddenProjects, setProjectHidden, configPath } from "./config.ts";
import { cloneProject, createProject } from "./projectadd.ts";
import { budgetStatus } from "./budget.ts";
import type { Budget } from "../../shared/types.ts";
import { hookStatus, applyHooks, hooksDir, hookPython } from "./hooksetup.ts";
import { probeAgents, ROSTER } from "./agentprobe.ts";
import { join as joinPath, basename } from "node:path";
import { tmpdir } from "node:os";
import { privateHost, resolvePeer, originOf, guardedFetch, hostsOnly } from "./net.ts";
import { resolveToken, tokenOk, isIntake, isAuthExempt, callerFor, allowed, scopeNeeded, answersFromADevice, understudyRequiresToken, UNDERSTUDY_NO_TOKEN_ERROR, mintUnderstudyToken, revokeUnderstudyToken, type Caller, type Origin } from "./auth.ts";
import {
  listPlugins, masterEnabled, setMaster, installPlugin, installFromCatalogue, updatePlugin, enablePlugin, disablePlugin, removePlugin,
  listCatalogues, addCatalogue, removeCatalogue,
} from "./plugins.ts";
import { fetchCatalogue } from "./plugin-catalogue.ts";
import {
  openStub, settleLedger, recordDecision, recordFence, scorecard,
  setMode, halt, setEnabled, enabled as understudyEnabled, sealSituation,
  consent, setAllowed, addExtraSource, removeExtraSource, setNever, termsStatus,
  precedentCount, precedentsByClass,
  proposeScope, setProposeScope, quarantinedEver, openProjectNameAllowed,
  judgeEnabled, setJudge, isOpenProjectPath, OPEN_PARTITION, openProjectName, setOpenProject,
  nowhereReason,
  bankByPartition,
} from "./understudy.ts";
import { listSources } from "./understudy-sources.ts";
/** The last ingest run, so the panel can say what it learned without re-reading
 *  a single file. Deliberately in memory and not on disk: it is a receipt for
 *  something that just happened, and a stale one after a restart would claim
 *  knowledge the bank may no longer match. */
let lastUnderstudyLearn: import("./understudy-ingest.ts").IngestResult | null = null;

/* ── what the work loop is allowed to do ────────────────────────────────────
 *
 * The three capabilities, defined here and handed down, so that
 * `understudy-loop.ts` can reach neither a shell nor a repository on its own.
 * Everything it does, it does through something this file decided to give it —
 * the same shape as the actuator's runner and for the same reason: a module
 * that can start a process is a module every fence has to be re-argued around.
 */

/** Checkouts the loop may work in. The open project, and today only that. */
async function openProjectRepos(): Promise<string[]> {
  const paths = getChanges(300).map((c) => c.file_path);
  const found = await discoverRepos(paths, knownProjects().map((p) => p.path), {});
  const roots = found.map((r) => r.root);

  /*
   * THE CHECKOUT THIS SERVER IS RUNNING FROM, which discovery never finds.
   *
   * `discoverRepos` works from telemetry — where work has recently happened
   * THROUGH the app — and from projects somebody has opened in it. On this
   * machine both are the employer's repositories: the open project gets worked
   * on from a terminal, so the app has never seen it, so the loop concluded it
   * had nowhere to work and declined every task it found.
   *
   * The app knows perfectly well where it lives. Leaving it out was the loop
   * being unable to find the ground under its own feet.
   *
   * Deduplicated, because a checkout arriving by both routes would be offered
   * twice and worked twice.
   */
  /*
   * DELIBERATELY NOT `workspaceRoot()`.
   *
   * It looks like the right answer — the root somebody launched the app with —
   * and on this machine it is the employer's repository, because that is what
   * the application is pointed at. Adding it here put thirty of their
   * checkouts one `isOpenProjectPath` call away from being worked in; the only
   * thing that stopped them was the fence name, which is the thing that had
   * just been wrong.
   *
   * "What the app is watching" and "where something may act for me" are
   * different questions. This one is answered by the open-project setting and
   * by discovery, and when neither finds anything the honest answer is none.
   */
  const here = repoRootOf(process.cwd());
  if (here && !roots.includes(here)) roots.push(here);

  /*
   * ITS OWN SIBLINGS, which discovery never finds either.
   *
   * `here` is one checkout; the fence (`isOpenProjectPath`) allows every
   * worktree of the same repository, because they are the same project on
   * other branches. Discovery is telemetry-driven and never sees a worktree
   * nobody has worked in through the app yet — so a task queued against one
   * was allowed by the fence and invisible to the loop, which is the queue
   * that stops moving with tasks still in it.
   *
   * `git worktree list` on `here`, not a filesystem sweep: it answers from
   * the repository itself, so it can only ever name checkouts that already
   * are this project — nothing the filter below wouldn't have kept anyway.
   */
  if (here) {
    for (const w of await repoWorktrees(here)) {
      if (w.path && !roots.includes(w.path)) roots.push(w.path);
    }
  }

  /*
   * AND THE WORKTREES OF THE PROJECT THE FENCE NAMES, or the fence cannot be
   * pointed at all.
   *
   * Everything above depends on two things that were both empty on a real
   * morning: telemetry — work done THROUGH the app, which does not happen when
   * somebody works in a terminal — and `here`, the checkout the server process
   * is running from. An installed app relaunched by its own installer starts
   * outside any checkout, so `here` is null.
   *
   * The result was a deputy that declined every task with "it has nowhere to
   * work", a `Pick a checkout` control whose list was built from the SAME empty
   * discovery, and therefore no way out from inside the application: measured
   * this morning, with the fence set to `agentglass-understudy` and the screen
   * reading "0 checkouts".
   *
   * So the projects this machine has actually worked in are consulted — and
   * ONLY the one the fence names. The name is matched before anything is
   * opened: a fence called `agentglass-understudy` looks inside `agentglass`
   * and nowhere else, so the employer's repository next to it is never so much
   * as listed. Everything found still has to pass `isOpenProjectPath` below,
   * exactly as before. This makes it possible for a name to match something;
   * it never makes a name unnecessary.
   */
  const wanted = openProjectName().trim();
  if (wanted) {
    for (const p of knownProjects()) {
      /* The candidate has to be the fence's OWN test (`isOpenProjectPath`), not
         a hand-rolled reading of it. The previous version matched only a leaf
         that STARTS WITH `<project>-`, which is the prefix case of what the
         fence actually allows: the fence is a segment test, so it also allows
         a worktree named `work-agentglass` (suffix) or `team-agentglass-2`
         (middle), and matches case-insensitively. Measured: of five leaf
         shapes the fence accepts for project `agentglass`, the prefix-only
         check passed 2 and silently dropped 3 — the same "allowed and never
         found" gap as the backwards comparison this replaced, just on the
         other side of the string. */
      if (!isOpenProjectPath(p.path)) continue;
      if (!roots.includes(p.path)) roots.push(p.path);
      for (const w of await repoWorktrees(p.path)) {
        if (w.path && !roots.includes(w.path)) roots.push(w.path);
      }
    }
  }

  /*
   * AND IT HAS TO EXIST. Discovery is telemetry-driven: a checkout that a
   * session once worked in stays in the changes table after the directory is
   * gone, and the fence kept listing it — measured on the installed app, a
   * `~/code/agentglass-dr` that had been deleted was one of four allowed
   * checkouts. A run cut from a path that is not there fails with the same
   * `ENOENT … posix_spawn` a missing binary produces, which is the diagnosis
   * that cost an afternoon once already.
   */
  return roots.filter((r) => isOpenProjectPath(r) && fsExists(r));
}

async function runGitIn(args: string[], cwd: string): Promise<{ ok: boolean; out: string }> {
  const p = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const out = await new Response(p.stdout).text();
  const errText = await new Response(p.stderr).text();
  return { ok: (await p.exited) === 0, out: (out + errText).slice(0, 4000) };
}

/*
 * His own agent, with his own tools, inside one worktree.
 *
 * No permission prompting, because there is no terminal to answer a prompt at
 * and a run that stalls waiting for one is a run that silently does nothing.
 * That is only defensible because of WHERE it runs: a worktree cut for this
 * task and thrown away if it goes wrong. Isolation is doing the work that a
 * permission dialogue would otherwise have to.
 */
/*
 * THE RUN, IN A PANE SOMEBODY CAN WATCH.
 *
 * A task is an agent with a shell for up to twenty-five minutes, and until now
 * it was a hidden `Bun.spawn`: the screen said "this takes as long as the task
 * does" and nothing else moved until it was over. You could not see which file
 * it was in, what it had tried, or whether it was stuck — the difference
 * between watching popcorn being made and being handed a bag.
 *
 * So the work happens in a tmux window in the project's own engine session,
 * which is the same machinery every other pane in this application already
 * uses: it can be watched, scrolled, interrupted, and typed into.
 *
 * THE PIECES THAT ARE NOT OBVIOUS.
 *
 * The prompt goes in a FILE. It is thousands of characters of rules and
 * precedents, and a command line has a length limit that varies by kernel; a
 * brief that grows past it would fail as something unrelated.
 *
 * `tee` rather than a redirect, because both things are wanted at once: the
 * pane is for the person and the file is for the outcome row.
 *
 * `PIPESTATUS[0]` rather than `$?`. Through a pipe, `$?` is tee's exit code,
 * which is zero whatever the agent did — the run would be recorded as finished
 * no matter how it ended. That is bash-only, hence bash rather than sh.
 *
 * The exit code lands in a FILE, and that file is the signal the run is over.
 * A window is gone the moment its command ends, so waiting on the window is a
 * race with reading it.
 *
 * Returns null when there is no tmux, or when the window could not be opened,
 * and the caller falls back to the hidden spawn. Watching is worth a lot and
 * it is not worth being the reason nothing runs.
 */
/*
 * The pane's formatter, carried with the run rather than found on disk.
 * Kept verbatim from scripts/understudy-watch.py, which is where it is read
 * and edited; a test holds the two in step.
 */
const WATCH_PY = `#!/usr/bin/env python3
"""
Turn the agent's event stream into something worth watching.

\`claude -p\` prints nothing at all until it is finished, so a pane running it is
a blank rectangle for the length of the task — which is the opposite of the
point. \`--output-format stream-json --verbose\` does emit as it goes, but it
emits JSON: measured at roughly two hundred characters a line, most of it
identifiers. Watching that tells you the process is alive and nothing else.

So the stream goes through here on its way to the pane. One short line per
event, in the order things happened: which tool, on which file, and the first
words of anything it says. The raw stream is teed to a file untouched, because
the run's recorded outcome has to be the agent's own words rather than this
summary of them.

Deliberately not pretty. It is a counter you glance at to see whether it is
reading, editing, or stuck on the same file for ten minutes.
"""
import json
import re
import sys


def tail(path: str, keep: int = 60) -> str:
    """The END of a path, which is the part that differs between two of them."""
    return path if len(path) <= keep else "…" + path[-(keep - 1):]


def head(cmd: str, keep: int = 110) -> str:
    """
    The START of a command, which is the opposite rule and the right one.

    A path is identified by its last segment; a command is identified by its
    first word. Cutting commands from the left produced fourteen rows reading
    \`Bash …ass-understudy-the-tracker-fence-does-no\`, which is the middle of a
    directory name and tells you nothing about what it ran.
    """
    return cmd if len(cmd) <= keep else cmd[:keep - 1] + "…"


# What a shell command is actually doing, in the order these are tried.
# Deliberately a short list: the point is to recognise the handful of things a
# coding agent does over and over, not to parse shell.
SHELL_MEANS = [
    (re.compile(r"\\b(bun|npm|yarn|pnpm)\\s+(run\\s+)?test\\b"), "running the tests"),
    (re.compile(r"\\btsc\\b|\\btypecheck\\b"), "checking the types"),
    (re.compile(r"\\bgit\\s+(commit)\\b"), "committing"),
    (re.compile(r"\\bgit\\s+(diff|show)\\b"), "reading its own changes"),
    (re.compile(r"\\bgit\\s+(status)\\b"), "checking what it has changed"),
    (re.compile(r"\\bgit\\s+(checkout|restore|reset)\\b"), "undoing something"),
    (re.compile(r"\\b(grep|rg|ag)\\b"), None),          # handled with its pattern
    (re.compile(r"\\b(cat|head|tail|sed -n|less)\\b"), None),
    (re.compile(r"\\b(find|ls)\\b"), "looking around the files"),
    (re.compile(r"\\b(mkdir|cp|mv|rm)\\b"), "moving files about"),
    (re.compile(r"\\bmake\\b"), "running make"),
]

QUOTED = re.compile(r"""["']([^"']{2,60})["']""")


def file_in(cmd: str) -> str:
    """The likeliest filename in a command, for the ones that read or search."""
    for word in reversed(cmd.split()):
        # No backtick in this set on purpose: this file is embedded verbatim
        # inside a TypeScript template literal, and a backtick followed by a
        # semicolon here ended that literal early when the copy was made.
        base = word.strip("\\"';|&()")
        if "/" in base or re.search(r"\\.[a-z]{2,4}$", base):
            return tail(base, 40)
    return ""


def shell_means(cmd: str) -> str:
    """A sentence for a command, or the command's first word if none fits."""
    for pattern, said in SHELL_MEANS:
        if not pattern.search(cmd):
            continue
        if said:
            return said
        if pattern.pattern.startswith(r"\\b(grep"):
            found = QUOTED.search(cmd)
            where = file_in(cmd)
            what = f'looking for "{found.group(1)}"' if found else "searching"
            return f"{what} in {where}" if where else what
        where = file_in(cmd)
        return f"reading {where}" if where else "reading a file"
    first = cmd.split()[0] if cmd.split() else "something"
    return f"running {tail(first, 20)}"


# The tools an agent uses most, said as a person would say them.
TOOL_MEANS = {
    "Read": "reading", "Write": "writing", "Edit": "editing",
    "NotebookEdit": "editing", "Glob": "finding", "Grep": "looking for",
    "TodoWrite": "planning", "Task": "asking another agent", "WebFetch": "fetching a page",
}


def describe(ev: dict) -> str | None:
    kind = ev.get("type")

    if kind == "assistant":
        out = []
        for block in ev.get("message", {}).get("content", []) or []:
            if block.get("type") == "text":
                said = " ".join((block.get("text") or "").split())
                # Its own words, marked and kept whole-ish: this is the line
                # that says WHY, and everything else is only what it touched.
                if said:
                    out.append("\\n▸ " + said[:220])
            elif block.get("type") == "tool_use":
                name = block.get("name", "?")
                arg = block.get("input", {}) or {}
                path = arg.get("file_path") or arg.get("path")
                cmd = arg.get("command")
                pattern = arg.get("pattern")
                if name == "Bash" and cmd:
                    out.append("   " + shell_means(" ".join(str(cmd).split())))
                elif path:
                    verb = TOOL_MEANS.get(name, name.lower())
                    out.append(f"   {verb} {tail(' '.join(str(path).split()), 50)}")
                elif pattern:
                    verb = TOOL_MEANS.get(name, name.lower())
                    out.append(f'   {verb} "{head(" ".join(str(pattern).split()), 50)}"')
                else:
                    out.append("   " + TOOL_MEANS.get(name, name.lower()))
        return "\\n".join(out) if out else None

    if kind == "user":
        # Tool results: only whether it worked, never the body. A file's
        # contents scrolling past hides the thing you were watching for.
        for block in ev.get("message", {}).get("content", []) or []:
            if block.get("type") == "tool_result" and block.get("is_error"):
                return "   ↳ that did not work"
        return None

    if kind == "rate_limit_event":
        """
        The one event that explains a run stopping for no visible reason.

        A run of the understudy died after thirty minutes with 782KB of work
        and nothing committed. Nothing on screen said why: the pane simply
        stopped. This was in the stream all along and the formatter dropped it,
        which is the worst thing a formatter can do with the only line that
        answers "what happened".
        """
        info = ev.get("rate_limit_info", {}) or {}
        why = info.get("overageDisabledReason") or info.get("overageStatus") or ""
        kind_of = info.get("rateLimitType") or "usage"
        when = info.get("resetsAt")
        at = ""
        if isinstance(when, (int, float)):
            import time as _t
            at = _t.strftime(" — resets %H:%M", _t.localtime(when))
        return f"\\n! {kind_of} limit reached ({why}){at}"

    if kind == "result":
        cost = ev.get("total_cost_usd")
        turns = ev.get("num_turns")
        bits = [b for b in (f"{turns} steps" if turns else "",
                            f"\${cost:.2f}" if isinstance(cost, (int, float)) else "") if b]
        return f"\\n— finished ({', '.join(bits)})" if bits else "\\n— finished"

    return None


def main() -> int:
    for raw in sys.stdin:
        raw = raw.strip()
        if not raw:
            continue
        try:
            ev = json.loads(raw)
        except json.JSONDecodeError:
            # Not everything on this stream is an event: hooks and the runtime
            # write plain lines too, and dropping them would hide a crash.
            print(raw[:160], flush=True)
            continue
        line = describe(ev)
        if line:
            print(line, flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
`;

/**
 * How often the run loop asks whether the agent's window is still there.
 *
 * Every ask is a tmux subprocess, and the thing it detects — an agent that
 * died — does not need one-second resolution. Five seconds turns a
 * forty-five-minute wait on a corpse into a five-second one, which is the whole
 * of the improvement; going finer buys nothing and costs a process per second
 * per concurrent run.
 */
const AGENT_LIVENESS_MS = 5_000;

/*
 * What was on screen when a run ended badly.
 *
 * Run 18 produced three transcript events in forty-five minutes and then timed
 * out, and the outcome could say nothing about why, because the transcript is
 * the only thing it read and the transcript was empty. Whatever the agent was
 * actually doing — sitting at a prompt, printing an error the event stream
 * never carries, waiting on something — was on the screen of its own window,
 * and nobody looked.
 *
 * Only on a bad ending. A run that finished has its answer, and the pane
 * underneath it is noise.
 */
async function paneTail(windowId: string): Promise<string> {
  const r = await tmux(["capture-pane", "-p", "-t", windowId]);
  const text = r.ok ? r.stdout.trimEnd() : "";
  return text ? `\n--- what its window had on screen ---\n${text.split("\n").slice(-40).join("\n")}` : "";
}

async function runAgentInPane(p: {
  cwd: string; root: string; label: string; argv: string[];
  prompt: string; env: Record<string, string>; timeoutMs: number;
  onPane?: (paneId: string) => void;
  /*
   * Told WHY there is no pane, rather than falling back in silence.
   *
   * Measured the first time this ran for real: an over-long TMUX_TMPDIR pushed
   * the socket path past the 108 bytes a unix socket allows, tmux refused with
   * "File name too long", and the run carried on perfectly well in a hidden
   * spawn. Which is the right behaviour — being watchable is not worth being
   * the reason nothing runs — but the screen simply showed no pane, and there
   * was nothing anywhere to say the difference between "no pane yet" and "no
   * pane ever". A silent fallback on the one feature whose entire point is
   * being able to watch is the wrong kind of quiet.
   */
  onNoPane?: (why: string) => void;
}): Promise<{ ok: boolean; out: string } | null> {
  const can = tmuxCapability();
  if (!can.available) { p.onNoPane?.(can.reason || "tmux is not available"); return null; }

  const box = mkdtempSync(joinPath(tmpdir(), "agx-understudy-"));
  const promptPath = joinPath(box, "brief.txt");
  const outPath = joinPath(box, "transcript.txt");
  const rcPath = joinPath(box, "exit-code");
  await Bun.write(promptPath, p.prompt);

  const q = (v: string) => `'${v.replaceAll("'", "'\\''")}'`;
  /*
   * THE PANE WAS EMPTY, and that was the whole feature not working.
   *
   * Measured: `claude -p` prints nothing at all until it finishes, so a pane
   * running it is a blank rectangle for the length of the task. Watching an
   * empty box is not better than watching a sentence that says "this takes as
   * long as it takes".
   *
   * `--output-format stream-json --verbose` does emit as it goes. It emits
   * JSON — around two hundred characters a line, mostly identifiers — so it
   * goes through a formatter on the way to the screen: one short line per
   * event, which tool and which file.
   *
   * The RAW stream is teed out first, untouched. The recorded outcome has to
   * be the agent's own words, not this summary of them; the formatter is for
   * the person standing at the counter.
   */
  const watchArgv = [...p.argv, "--output-format", "stream-json", "--verbose"];
  /*
   * THE FORMATTER IS WRITTEN OUT, not pointed at.
   *
   * It was resolved with `import.meta.url` against `../../scripts/`, which is
   * right in a checkout and wrong everywhere else: from the installed bundle
   * that path resolves to `/scripts/understudy-watch.py`, and the pane's first
   * and only line was
   *
   *     python3: can't open file '/scripts/understudy-watch.py'
   *
   * Found by installing the app and watching a run — it worked in the tree it
   * was written in, which is the class of bug a test in that same tree cannot
   * see. A file the run carries with it has no opinion about how the server
   * was installed.
   */
  const fmt = joinPath(box, "watch.py");
  await Bun.write(fmt, WATCH_PY);
  const line =
    `${watchArgv.map(q).join(" ")} < ${q(promptPath)} 2>&1 | tee ${q(outPath)} | python3 ${q(fmt)}; ` +
    `echo \${PIPESTATUS[0]} > ${q(rcPath)}`;

  /*
   * THE MACHINE TOKEN OUT OF THE ENGINE'S ENVIRONMENT, before the agent runs.
   *
   * The agent is handed a minted READ-ONLY credential through `-e`, and that
   * override works: measured, the variable inside its window is the minted
   * one. But the tmux SERVER carries the environment it was started with, and
   * on this machine that includes `AGENTGLASS_TOKEN` — the machine token, with
   * every write route open to it.
   *
   * The agent has bash. `tmux -L agentglass show-environment -g
   * AGENTGLASS_TOKEN` returns it, verified against the real socket. So the
   * fence around what the understudy may do was one command away from being
   * irrelevant, and the careful `-e` was protecting a window while the door
   * beside it stood open.
   *
   * Unset globally rather than trusted not to be asked. It is only read when a
   * new pane inherits it, and every pane this application opens is given what
   * it needs explicitly — the panes a person opens get their environment from
   * their own shell.
   */
  await tmux(["set-environment", "-g", "-u", "AGENTGLASS_TOKEN"]);

  const win = await engineWindowRunning(
    p.root, `understudy: ${p.label}`.slice(0, 60), ["bash", "-c", line], p.cwd, p.env,
  );
  if (!win) {
    // The engine session could not be opened or the window refused. The socket
    // path being too long lands here rather than in the capability check.
    p.onNoPane?.("tmux would not open a window for it");
    return null;
  }

  /*
   * WIDE, BECAUSE 80 COLUMNS IS WHERE EVERY LINE WAS BEING CUT.
   *
   * A window opened with no client attached is 80x24, and the panel showed
   * fourteen rows of `Bash …ass-understudy-the-tracker-fence-does-no` — the
   * tool's name, then the middle of a command. Reported as "tiny, and none of it
   * can be made out", and the font size was the smaller half of it.
   *
   * Set on THIS WINDOW rather than on the session: `window-size` is a window
   * option, and putting `manual` on a session pins every window in it — which
   * has already once shrunk seven of somebody's real ones. Failures are
   * ignored on purpose; a narrow pane is worse than a wide one and better than
   * no run.
   */
  await tmux(["set-window-option", "-t", win.windowId, "window-size", "manual"]);
  await tmux(["resize-window", "-t", win.windowId, "-x", "200", "-y", "50"]);

  /*
   * THE WINDOW IS LEASED, and that is what closes it.
   *
   * A `-p` run ends by itself: the command exits and tmux takes the window with
   * it, so the only path that had to kill anything was the timeout below. That
   * stops being true the moment the pane holds an interactive CLI, which is the
   * next thing to go in here — an agent that stays at its prompt is a window
   * nothing ends, and nothing sweeps it either, because `evictIdlePanes`
   * enumerates sessions and this is a window inside one.
   *
   * Leasing it now rather than with that change, because the rule the lease
   * exists for is the same either way and it is easier to trust when it is not
   * also new: the only window this can ever close is one it stamped itself.
   * See panelease.ts for why a name or an age would not do.
   */
  await takeLease(win.windowId, `understudy: ${p.label}`);

  p.onPane?.(win.paneId);

  try {
    /*
     * WAITING FOR AN AGENT THAT IS STILL THERE.
     *
     * This used to poll for the exit-code file and nothing else, so the only
     * thing that could end a wait early was the agent finishing. An agent that
     * DIED — window killed, tmux restarted, the shell inside it gone — wrote no
     * rc file, and the loop sat on it for the whole forty-five minute budget
     * before recording a timeout. Measured: a run spent thirty-five minutes
     * "running" with no process anywhere on the machine, no file touched in its
     * worktree, and nothing to tell anyone until the clock ran out.
     *
     * The window is the signal, and the lease already knows how to ask: the
     * stamp we wrote is on that window or it is not. Asking every five seconds
     * rather than every second because it is a subprocess per ask and the thing
     * being detected does not need one-second resolution.
     *
     * The rc file is re-checked AFTER the window comes back gone, never before:
     * an agent that finishes writes rc and then its window closes, and those two
     * are not simultaneous. Checking in that order is what stops a normal ending
     * being reported as a death.
     */
    const started = Date.now();
    const deadline = started + p.timeoutMs;
    let died = false;
    let nextLivenessCheck = Date.now() + AGENT_LIVENESS_MS;
    /*
     * How long the transcript has been silent, carried into whatever ending
     * this run gets. It does not decide anything — an agent thinking hard
     * between tool calls writes nothing for minutes and is working perfectly —
     * but "it ran out of time" and "it ran out of time and had written nothing
     * for forty of those minutes" are different reports, and only the second
     * one is diagnosable.
     */
    let lastSize = -1;
    let lastGrew = started;
    while (Date.now() < deadline) {
      if (fsExists(rcPath)) break;
      await new Promise((r) => setTimeout(r, 1000));
      if (Date.now() < nextLivenessCheck) continue;
      nextLivenessCheck = Date.now() + AGENT_LIVENESS_MS;
      const size = fsExists(outPath) ? Bun.file(outPath).size : 0;
      if (size !== lastSize) { lastSize = size; lastGrew = Date.now(); }
      if (await leaseHeld(win.windowId)) continue;
      if (fsExists(rcPath)) break;
      died = true;
      break;
    }
    const silentFor = Math.round((Date.now() - lastGrew) / 1000);
    const silence = silentFor >= 60 ? `, after ${Math.round(silentFor / 60)}min with nothing written to its transcript` : "";

    const out = fsExists(outPath) ? await Bun.file(outPath).text() : "";
    if (died) {
      /* The transcript is worth more than the sentence: whatever the agent got
         through before it went is in there, and a run that died at minute two
         with an empty one is a different problem from a run that died at minute
         thirty with 400KB. */
      const ran = Math.round((Date.now() - started) / 1000);
      return { ok: false, out: `${out}\n--- its window is gone: the agent died after ${ran}s${silence}, and nothing was left running ---${await paneTail(win.windowId)}`.trim().slice(-8000) };
    }
    if (!fsExists(rcPath)) {
      // Out of time. The window goes rather than being left, because an agent
      // still typing into a worktree nobody is waiting for is worse than no
      // transcript — the run is already recorded as failed either way. The
      // `finally` does it, so the path that throws on the way here ends the
      // same way this one does.
      /* Captured BEFORE the `finally` closes the window — on a timeout it is
         still there, and it is the only place the reason can be. */
      const screen = await paneTail(win.windowId);
      return { ok: false, out: `${out}\n--- it ran out of time and was stopped${silence} ---${screen}`.trim().slice(-8000) };
    }
    const code = Number.parseInt((await Bun.file(rcPath).text()).trim(), 10);
    return { ok: code === 0 && out.trim().length > 0, out: finalWords(out) };
  } finally {
    // Every ending, including the ones nobody wrote a branch for. A window that
    // already closed itself is the common case and costs one refused lookup.
    await endLease(win.windowId);
  }
}

/**
 * The agent's answer, pulled back out of its event stream.
 *
 * The transcript on disk is now one JSON object per line, and the outcome a
 * person reads has to be the words rather than the envelope. The last `result`
 * event carries them; anything else means the stream did not get that far, and
 * then the raw tail is more use than an empty string — it is where a crash is.
 */
function finalWords(stream: string): string {
  const lines = stream.trim().split("\n");

  /*
   * A RUN CUT OFF BY A USAGE LIMIT, which otherwise records as a blank
   * failure.
   *
   * Measured: a run worked for thirty minutes, produced 782KB of transcript,
   * and stopped mid-sentence. The reason was in the stream — a
   * `rate_limit_event` saying the five-hour window had no credit left — and
   * the outcome said nothing at all, because there was no `result` event to
   * find. Half an hour of work, and the row could not say why it ended.
   *
   * Read before the result, and separately: a limit reached part-way through
   * is the thing worth reporting even when the run went on to finish.
   */
  let limited = "";
  for (const line of lines) {
    if (!line.includes("rate_limit_event")) continue;
    try {
      const ev = JSON.parse(line) as {
        type?: string;
        rate_limit_info?: { rateLimitType?: string; overageDisabledReason?: string; resetsAt?: number };
      };
      if (ev.type !== "rate_limit_event") continue;
      const i = ev.rate_limit_info ?? {};
      const when = typeof i.resetsAt === "number"
        ? new Date(i.resetsAt * 1000).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
        : "";
      limited = `--- stopped by the ${i.rateLimitType ?? "usage"} limit`
        + `${i.overageDisabledReason ? ` (${i.overageDisabledReason})` : ""}`
        + `${when ? `, resets ${when}` : ""} ---`;
    } catch { /* a line that mentions it without being one */ }
  }

  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const ev = JSON.parse(lines[i]!) as { type?: string; result?: string };
      if (ev.type === "result" && typeof ev.result === "string") {
        return `${limited ? `${limited}\n` : ""}${ev.result}`.slice(-8000);
      }
    } catch { /* not every line on that stream is an event */ }
  }
  // No result event at all: it did not get to the end. Say so, and say why if
  // the stream knows — a tail of raw JSON answers nothing.
  const why = limited || "--- it stopped before finishing, and left no closing message ---";
  return `${why}\n${stream.slice(-4000)}`.slice(-8000);
}

/**
 * The plan limits as percentages left, or null when they cannot be read.
 *
 * `getUsage` reports utilisation; what a decision needs is what is LEFT, and
 * the seven-day window is the one that runs out — the five-hour one refills
 * while you sleep. Failure is null rather than an optimistic 100: a chooser
 * that cannot see the meter must not spend as though it were full.
 */
async function usageNow(): Promise<UsageNow | null> {
  try {
    const u = await getUsage();
    if (!u?.available) return null;
    const week = u.seven_day?.remaining;
    const hour = u.five_hour?.remaining;
    if (typeof week !== "number") return null;
    return { weekRemaining: week, hourRemaining: typeof hour === "number" ? hour : 100 };
  } catch {
    return null;
  }
}

/*
 * Which run is in which pane, right now.
 *
 * In memory rather than in the row, on purpose. A live pane exists only while
 * this process does — a server that restarts leaves no pane behind it to point
 * at — so a column would be a value that is wrong more often than right, and it
 * would need a migration to say so.
 *
 * Cleared when the run ends, so the tab offers to show you something that is
 * still there.
 */
const watching = new Map<number, { paneId?: string; why?: string }>();
/**
 * The window a run is in, asked of tmux rather than remembered.
 *
 * The map is in this process, and this process restarts — every reinstall, and
 * any crash. The RUN does not: it is an agent in a tmux window that outlives
 * the server entirely, so a restart left a task visibly `running` with no way
 * to watch it, which is exactly when somebody wants to look.
 *
 * Matched on the window name, which is `understudy: <title>` truncated to
 * sixty characters — set when the window was opened, by this same code. Not a
 * guess: nothing else on that socket is named that way.
 */
async function paneOfRun(title: string): Promise<string> {
  const want = `understudy: ${title}`.slice(0, 60);
  const r = await tmux(["list-windows", "-a", "-F", "#{pane_id}\t#{window_name}"]);
  if (!r.ok) return "";
  for (const line of r.stdout.split("\n")) {
    const [paneId = "", name = ""] = line.split("\t");
    if (name && paneId.startsWith("%") && name === want) return paneId;
  }
  return "";
}

export function watchingPanes(): { runId: number; paneId?: string; why?: string }[] {
  /*
   * Filtered by the ROW, not by a delete somewhere else.
   *
   * A pane is worth offering only while its run is still going, and the row
   * already knows that — `finishRun` writes the state whichever way the run
   * ended, including the paths that throw. Clearing the map by hand at each of
   * those exits is the kind of bookkeeping that is right until somebody adds a
   * fourth way to finish, and then silently points at a pane that closed an
   * hour ago.
   */
  const live = new Set(Work.runs(50).filter((r) => r.state === "running").map((r) => r.id));
  for (const id of [...watching.keys()]) if (!live.has(id)) watching.delete(id);
  return [...watching].map(([runId, v]) => ({ runId, ...v }));
}
const nowWatching = (runId: number | null, paneId: string) => {
  if (!runId) return;
  watching.set(runId, { paneId });
  /* And on the row, because this map dies with the process while the run does
     not — and because a pane id is the only handle on that window that a
     rename cannot break. */
  Work.rememberPane(runId, paneId);
};

/**
 * What is watchable right now, memory first and tmux for the rest.
 *
 * A server that has just restarted remembers nothing, and the answer is on the
 * tmux socket. Recovered entries are put back in the map so the next call is
 * the cheap one.
 */
async function watchedNow(): Promise<{ runId: number; paneId?: string; why?: string }[]> {
  const known = watchingPanes();
  const seen = new Set(known.map((w) => w.runId));
  const out = [...known];
  for (const r of Work.runs(50)) {
    if (r.state !== "running" || seen.has(r.id)) continue;
    const paneId = await paneOfRun(r.title);
    if (!paneId) continue;
    watching.set(r.id, { paneId });
    out.push({ runId: r.id, paneId });
  }
  return out;
}
/** No pane, and the sentence saying why — so the screen can tell you. */
const noPane = (runId: number | null, why: string) => { if (runId) watching.set(runId, { why }); };

async function runAgentIn(
  cwd: string, prompt: string, timeoutMs: number,
  show?: {
    root: string; label: string;
    /*
     * The body of the card, for the thing choosing the model.
     *
     * `label` is the title and the title alone. His cards are a short title
     * with the substance underneath it — the part that says whether this is a
     * rename or an audit — and until this existed that part went to the brief
     * and was withheld from `chooseModel`.
     */
    detail?: string;
    onPane?: (paneId: string) => void;
    onNoPane?: (why: string) => void;
    /** Which model and effort this run got, and why — recorded on the row. */
    onModel?: (c: Choice) => void;
  },
): Promise<{ ok: boolean; out: string }> {
  const bin = Bun.which("claude");
  if (!bin) return { ok: false, out: "no local claude CLI" };

  /*
   * THE MODEL AND THE EFFORT, chosen instead of defaulted.
   *
   * Every run before this launched with no `--model`, so a two-line rename and
   * a whole-feature audit both went to the account's default — the most
   * expensive model there is, out of a weekly allowance shared with the person
   * whose account it is.
   *
   * The task asks for a tier and the REMAINING BUDGET can only lower it. That
   * asymmetry is the design: a mechanical edit is never promoted because the
   * week is young, and a hard one is demoted when it is nearly over. Fable is
   * never launched at all — not a quality judgement, it is the allowance he
   * needs for his own work.
   *
   * A usage reading that fails is not a reason to spend as if the week were
   * full: `chooseModel` caps at sonnet when it cannot see the meter.
   */
  const usage = show ? await usageNow() : null;
  const pick = chooseModel({ title: show?.label ?? "", detail: show?.detail ?? "", usage });
  show?.onModel?.(pick);

  /*
   * `Monitor` IS REMOVED, not merely discouraged. This is a one-shot `-p`
   * process: the turn that runs is the only turn there is, nothing survives
   * it, and no notification a background job fires later has anywhere to
   * land. Six runs on this machine reached for it anyway — "waiting for the
   * Monitor notification", "I'll pick back up when the monitor fires" — and
   * spent their entire turn on a promise the harness could never keep. The
   * character check below now catches the run that happens regardless, but
   * catching it after the fact is the second line, not the first: taking the
   * tool away is cheaper than detecting what it was used for, the same
   * reasoning that keeps this agent from committing on his behalf. `Bash`
   * stays — git and the test suite need it — so `run_in_background` is still
   * technically reachable, but with no `Monitor` to report back to it a run
   * that backgrounds something has no honest story left to tell about it.
   */
  const argv = [bin, "-p", "--dangerously-skip-permissions",
    "--disallowedTools", "Monitor",
    "--model", pick.model, "--effort", pick.effort];

  /*
   * A READ-ONLY CREDENTIAL, and swapping it in is a fence rather than a
   * feature.
   *
   * The environment it inherits carries `AGENTGLASS_TOKEN` — the machine token,
   * `full` scope, every write route in the application open to it. So until
   * this line, an agent that thought to curl its own server could push a
   * branch, merge a pull request or write to the task tracker, and the careful
   * wording in its brief was the only thing standing in the way.
   *
   * It gets a minted one instead: the understudy's principal, every GET
   * answered and every write refused by `understudyAllows`. That is also what
   * gives it the views he asked for — the panel, the diff, the branch list —
   * because a view is a route once you have no screen to look at.
   *
   * Minted per run and revoked in `finally`, so a credential never outlives the
   * work it was made for.
   */
  const readToken = mintUnderstudyToken();

  try {
    if (show) {
      /*
       * Only the two variables that differ from what the window would inherit
       * anyway. Handing the whole environment to `-e` would put every variable
       * this server holds onto a tmux command line, which is the opposite of
       * why the credential is passed this way at all.
       */
      /*
       * THE INTERACTIVE PANE FIRST, and it is a rung above `runAgentInPane`
       * rather than a replacement for it.
       *
       * `runAgentInPane` still launches `-p` — one shot, model fixed at
       * launch. This opens the same shape of window and runs the real CLI in
       * it, so a run can be told mid-task to change model or effort the way
       * he does, and drop back to `-p` only where the interactive pane itself
       * could not be opened at all — no tmux, no window. Once a window opens
       * it commits to it: `runAgentInteractivePane` returns null only in
       * that one case, never after it has leased a pane and started typing
       * into it, so this never opens two windows for one run.
       */
      /* The same fence on all three ladders. It is built once per run so the
         empty `gh` config is the same directory whichever one starts. */
      const fenced = understudyRunEnv(cwd);

      const interactive = await runAgentInteractivePane({
        cwd, root: show.root, label: show.label, model: pick.model, effort: pick.effort,
        prompt, timeoutMs,
        env: { ...fenced, AGENTGLASS_TOKEN: readToken, AGENTGLASS_READ_TOKEN: readToken },
        onPane: show.onPane,
      });
      if (interactive) return interactive;

      const watched = await runAgentInPane({
        cwd, root: show.root, label: show.label, argv, prompt, timeoutMs,
        env: { ...fenced, AGENTGLASS_TOKEN: readToken, AGENTGLASS_READ_TOKEN: readToken },
        onPane: show.onPane,
        onNoPane: show.onNoPane,
      });
      // Null means no tmux, or a window that would not open. Fall through to
      // the hidden run: being watchable is worth a great deal and it is not
      // worth being the reason nothing runs at all.
      if (watched) return watched;
    }

    /* The hidden ladder inherits the server's whole environment, which is the
       one that carries the user's `gh` and ssh: the fence goes on last so it
       wins over what it is overriding. */
    const env = { ...process.env, ...understudyRunEnv(cwd), AGENTGLASS_TOKEN: readToken, AGENTGLASS_READ_TOKEN: readToken };
    const p = Bun.spawn(argv, {
      cwd,
      stdin: new TextEncoder().encode(prompt),
      stdout: "pipe",
      // Captured rather than discarded: a run that dies — a missing credential,
      // a crash, a CLI that refuses — says so HERE and writes nothing to
      // stdout. Thrown away, those runs recorded a failure with an empty
      // reason, which is the one row somebody actually wants to read.
      stderr: "pipe",
      env,
    });
    /*
     * MEASURED ON THE FIRST REAL CHAINED RUN, which came back as a failure
     * with an empty reason after exactly 25.0 minutes.
     *
     * The agent had done the work — the right two files, staged, with comments
     * in his own idiom — and the timeout killed it before it committed. What
     * was recorded was `failed` and a blank outcome, so from the screen it was
     * indistinguishable from an agent that sat there doing nothing.
     *
     * `claude -p` writes to a PIPE, and a pipe buffers: nothing is flushed
     * until it finishes, so killing it loses the entire transcript. In a pane
     * it writes to a tty and prints as it goes, which is one more reason the
     * watched path is the better one — but this path has to be honest about
     * what happened rather than silent.
     */
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { p.kill(); } catch { /* already gone */ }
    }, timeoutMs);
    try {
      // Concurrently, for the same reason as the test runner: whichever pipe is
      // not being read is the one that fills and stops the process.
      const [out, err] = await Promise.all([
        new Response(p.stdout).text(),
        new Response(p.stderr).text(),
      ]);
      const code = await p.exited;
      if (timedOut) {
        const mins = Math.round(timeoutMs / 60_000);
        return {
          ok: false,
          out: [
            out.trim(),
            err.trim(),
            `--- it was still going after ${mins} minutes and was stopped ---`,
            "Anything it had written is in the worktree; a pipe holds its output",
            "until the process ends, so there may be no transcript above this line.",
          ].filter(Boolean).join("\n").slice(-8000),
        };
      }
      const ok = code === 0 && out.trim().length > 0;
      // Only on failure. A successful run's stderr is progress chatter, and
      // appending it would bury the transcript the outcome is there to hold.
      const said = ok || !err.trim() ? out : `${out}\n--- it also said ---\n${err}`.trim();
      return { ok, out: said.slice(0, 8000) };
    } finally {
      clearTimeout(timer);
    }
  } finally {
    // In `finally` rather than after the return, so a run that throws or times
    // out does not leave a live credential behind. That is the whole reason it
    // is minted per run instead of once at boot.
    revokeUnderstudyToken(readToken);
  }
}

/*
 * The verdict, and it is his test command rather than a guess at one.
 *
 * "Compiling is not evidence" is his sentence, said after a session reported
 * success on a build nobody had run. So the suite decides, and the agent's own
 * confidence counts for nothing against it.
 */
/**
 * The names of the tests that failed, pulled out before the tail throws them away.
 *
 * `bun test` prints its failures as it goes and its summary at the end, and the
 * report kept only the last 4000 characters — which is the per-file listing and
 * the counts. So a run came back saying "1 fail" and nothing whatever about
 * WHICH, and finding out meant re-running the whole suite by hand. Twice in one
 * afternoon.
 */
function failedTestNames(output: string): string[] {
  return [...output.matchAll(/^\(fail\) .*$/gm)].map((m) => m[0]!.trim());
}

/**
 * One suite run, both streams, both at once.
 *
 * `bun test` writes its verdict to STDERR — its stdout carries the version
 * banner and nothing else, so reading stdout alone recorded that banner as what
 * the tests said, for every run, under the words "what the TESTS said, not what
 * the agent claimed".
 *
 * And reading them in sequence can HANG. An unread pipe fills, a process
 * blocking on a full stderr never exits, and `p.exited` waits for a program
 * that is waiting for us — until the timeout kills a run that had already
 * finished. A suite this size writes far more than a pipe buffer holds.
 */
/**
 * The suites the verdict runs, in CI's order and with CI's arguments.
 *
 * It ran ONE of them, without its argument, and both halves of that cost a run.
 *
 *   - `web` was missing. Measured on the deliveries since 2026-08-20, 30 of 63
 *     touched `web/`: a task that broke the dashboard could come back `done`
 *     because nothing the verdict ran could see it. web is already a bun
 *     workspace and costs about 32 seconds.
 *   - `--timeout 20000` was missing, and CI's own comment says why it is there:
 *     several tests here brush the 5 s default. Without it the verdict
 *     manufactures reds, and the retry below then files them as flakes — a
 *     configuration mistake wearing the costume of a flaky suite.
 *
 * `mobile` stays out on purpose: it needs `npm ci` and generated artifacts a
 * fresh worktree does not have, and its own tests skip with a reason there.
 */
const VERDICT_SUITES: readonly { dir: string; args: readonly string[] }[] = [
  { dir: "server", args: ["--timeout", "20000"] },
  { dir: "web", args: [] },
];

async function runSuiteOnce(cwd: string, timeoutMs: number, suite: { dir: string; args: readonly string[] } = VERDICT_SUITES[0]!): Promise<{ ok: boolean; out: string }> {
  /* An absolute path, not the bare word: the packaged app's PATH is whatever
     the launcher handed it, and a missing `bun` arrived as an ENOENT from
     inside a run that then read as a failed task. See bunbin.ts. */
  const bun = bunBin();
  if (!bun) return { ok: false, out: NO_BUN() };
  const p = Bun.spawn([bun, "test", ...suite.args], { cwd: `${cwd}/${suite.dir}`, stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => { try { p.kill(); } catch { /* already gone */ } }, timeoutMs);
  /*
   * BOTH STREAMS, AND BOTH AT ONCE. Two separate bugs met here.
   *
   * `bun test` writes its verdict to STDERR. Its stdout carries the version
   * banner and nothing else, so reading stdout alone recorded this as what the
   * tests said, for every run:
   *
   *     bun test v1.3.9 (…)
   *
   * The tab prints that under the words "what the TESTS said, not what the
   * agent claimed", which is the promise the whole loop rests on.
   *
   * And reading them in sequence can HANG. An unread pipe fills, a process
   * blocking on a full stderr never exits, and `p.exited` waits for a program
   * that is waiting for us — until the timeout kills a run that had already
   * finished. A suite this size writes far more than a pipe buffer holds.
   */
  const [outText, errText] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
  ]);
  const code = await p.exited;
  clearTimeout(timer);
  // The verdict first, because it is the last thing bun writes and the first
  // thing a person looks for.
  const both = `${errText.trim()}\n${outText.trim()}`.trim();
  return { ok: code === 0, out: both };
}

/**
 * ONE RED DOES NOT STOP THE QUEUE UNTIL IT HAS BEEN ASKED TWICE.
 *
 * The tmux tests share one socket and the server behind it is single-threaded,
 * so under load a couple of them lose a race that has nothing to do with the
 * change under test. A shift stops on ONE failure — deliberately, and it is the
 * right rule — which means a flake does not cost a run, it costs the whole
 * queue until a person comes back and looks.
 *
 * Measured on three separate runs in one afternoon: each reported a red, and
 * each was green on a second pass in the same worktree with nothing changed.
 * Every one of those cost the queue the rest of the hour.
 *
 * So a red is asked again, once, and only a red twice is a failure. The retry
 * is never silent: a run that went green the second time says so and names
 * what failed the first time, because "this suite has a flake in it" is
 * something worth seeing, and a retry nobody is told about is how a real
 * intermittent bug gets to hide for months.
 *
 * The cost is bounded and paid only when something is already wrong: a red run
 * can now take two budgets instead of one. The suite is about four minutes and
 * the budget is ten, so a genuine failure is reported in roughly eight rather
 * than four — against a flake costing the rest of the shift, that is cheap.
 */
/**
 * Dependencies into a freshly cut worktree, before the agent is asked to work.
 *
 * `git worktree add` links no `node_modules`, and everything a verdict depends
 * on — `bun test`, `tsc` — needs them. About 70ms off the shared cache.
 */
async function runInstallIn(cwd: string, timeoutMs: number): Promise<{ ok: boolean; out: string }> {
  const bun = bunBin();
  if (!bun) return { ok: false, out: NO_BUN() };
  const p = Bun.spawn([bun, "install"], { cwd, stdout: "pipe", stderr: "pipe" });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; try { p.kill(); } catch { /* already gone */ } }, timeoutMs);
  const [out, err] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
  ]);
  const code = await p.exited;
  clearTimeout(timer);
  if (timedOut) {
    const mins = Math.round(timeoutMs / 60_000);
    return {
      ok: false,
      out: [err.trim(), out.trim(), `--- it was still going after ${mins} minutes and was stopped ---`]
        .filter(Boolean).join("\n").slice(-2000),
    };
  }
  return { ok: code === 0, out: `${err.trim()}\n${out.trim()}`.trim().slice(-2000) };
}

/**
 * Every suite in `VERDICT_SUITES`, stopping at the first that stays red.
 *
 * Stopping early is deliberate: a red server suite tells the agent what to fix,
 * and running web afterwards only buys a second wall of output underneath the
 * answer. `timeoutMs` bounds ONE spawn, not the sequence, so adding a suite
 * does not shorten the time any of them get.
 */
async function runTestsIn(cwd: string, timeoutMs: number): Promise<{ ok: boolean; out: string }> {
  const parts: string[] = [];
  for (const suite of VERDICT_SUITES) {
    const r = await runOneSuiteWithRetry(cwd, timeoutMs, suite);
    parts.push(`--- ${suite.dir} ---\n${r.out}`);
    if (!r.ok) return { ok: false, out: parts.join("\n\n") };
  }
  return { ok: true, out: parts.join("\n\n") };
}

async function runOneSuiteWithRetry(cwd: string, timeoutMs: number, suite: { dir: string; args: readonly string[] }): Promise<{ ok: boolean; out: string }> {
  const first = await runSuiteOnce(cwd, timeoutMs, suite);
  const names = failedTestNames(first.out);
  const named = names.length ? `\n\nwhat failed:\n${names.slice(0, 20).join("\n")}` : "";
  if (first.ok) return { ok: true, out: first.out.slice(-4000) };

  const second = await runSuiteOnce(cwd, timeoutMs, suite);
  if (!second.ok) {
    /* Red twice. Whichever names the second run produced are the ones that
       reproduce, so those are the ones worth carrying. */
    const twice = failedTestNames(second.out);
    const stuck = twice.length ? `\n\nwhat failed (and failed again):\n${twice.slice(0, 20).join("\n")}` : named;
    return { ok: false, out: `${second.out.slice(-4000)}${stuck}` };
  }
  return {
    ok: true,
    out: `${second.out.slice(-4000)}\n\n--- the first run of this suite was red and the second was green, unchanged. Treated as a flake, and the queue kept going. ---${named}`,
  };
}
import { ingest, policySummary } from "./understudy-ingest.ts";
import { predictSealed } from "./understudy-predict.ts";
import { ask, compiledRules } from "./understudy-ask.ts";
import * as Shift from "./understudy-shift.ts";
import { judge, JUDGE_AVAILABLE } from "./understudy-judge.ts";
import * as Work from "./understudy-work.ts";
import { agentIsWorking } from "./agentworking.ts";
import * as Loop from "./understudy-loop.ts";
// Registers the readers. Imported for the side effect, which is the whole
// point of a source: it announces itself rather than being wired in by hand.
import * as Sources from "./understudy-sources-work.ts";
import { bunBin, NO_BUN } from "./bunbin.ts";
import { understudyRunEnv } from "./understudy-runenv.ts";
import { recoverAfterRestart, startUnderstudyWatchdog, stopUnderstudyWatchdog, setResumeHook, setGitHook, setFenceHook, setAliveHook, setBunHook, setBusyHook } from "./understudy-watchdog.ts";
import { openRequests, helpHistory, markAnswered } from "./understudy-help.ts";
import { activeDevices, markSeen, revokeDevice, devices, publicDevice, type Scope } from "./devices.ts";
import { credentialsPath, hasCredential } from "./credentials.ts";
import { startCardWatch, cardForTitle } from "./clickupwatch.ts";
import * as CardIndex from "./clickupindex.ts";
import * as AgentBoard from "./agentboard.ts";
import { boardNow, lanternChat, noteLanternSession, hookSaysLantern, isLanternSession } from "./lantern.ts";
import * as AgentOps from "./agentops.ts";
import { nudgeText, nudgeChannel, sendNudge } from "./prnudge.ts";
import * as Schedule from "./agentschedule.ts";
import { handoffBrief } from "./handoff.ts";
import { startLanternWatch, restartLanternWatch, lastLook } from "./lanternwatch.ts";
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
/**
 * The off switch for `/budgets/set`, which every other write family already had.
 *
 * Git write, Docker write, task write and ClickUp write can each be turned off
 * with one variable, so an instance can be run with a capability it simply does
 * not have. Budgets had no such switch, and of all the routes to be missing one
 * this is the odd choice: a budget is not a preference, it is the brake. When a
 * session is over its limit, `budgetHoldFor` puts a reason on the hold and, with
 * `AGENTGLASS_GATE_FAILCLOSED`, is what makes an unanswered call DENY. Raising
 * the limit is therefore a way to stop being gated, and it was reachable by
 * anything holding the token.
 *
 * It lives beside the route rather than in config.ts because the route is the
 * whole write surface: `writeBudgets` has exactly one caller, and a flag in the
 * module it lives in would suggest there are others to protect.
 */
const BUDGET_WRITE_ENABLED = process.env.AGENTGLASS_BUDGET_WRITE_DISABLED !== "1";
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

/**
 * The half of every Origin gate that is about the header's CONTENTS.
 *
 * The three gates below differ only in what they do when the header is absent:
 * `localOrigin` waves it through, `trustedCaller` asks where the request came
 * from, `mayReleaseAHold` refuses. What they do when it is present must be one
 * test forever — two of them drifted apart once over the desktop scheme and the
 * app came up unable to reach its own API.
 */
function vouchedOrigin(o: string): boolean {
  if (fromDesktopShell(o)) return true;
  try {
    return trusted(new URL(o).hostname);
  } catch { return false; }
}

function localOrigin(req: Request): boolean {
  const o = req.headers.get("origin");
  if (!o) return true;
  return vouchedOrigin(o);
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
  return vouchedOrigin(o);
}

/**
 * The hosts an attachment may be streamed from — the tracker's own and its
 * attachment CDN, the two shared/csp.ts already trusts for pictures. Applied to
 * every redirect hop by guardedFetch, not only to the first URL.
 */
const attachmentHostError = hostsOnly(["clickup.com", "clickup-attachments.com"]);

/**
 * Who may let a held tool call go — the one gate the held party must not open.
 *
 * A gate is worth exactly one thing: an agent is stopped, and it stays stopped
 * until a person says otherwise. `trustedCaller` cannot express that, and not
 * by accident — it admits an Origin-less caller on loopback because that is
 * precisely who the hooks are, and the hook POSTing `/gate` (asking to be held)
 * is the thing working correctly. The same shape arriving at `/gate/decide` is
 * the agent answering its own question: it runs as this user, so it can read
 * `~/.config/agentglass/token`, or find `AGENTGLASS_TOKEN` in the environment
 * it was launched with, and one `curl` later `actorOf` writes `local` into the
 * audit row — byte for byte what the desk's own button writes — and gate.ts
 * tells the model a human reviewed the call.
 *
 * So this asks for something the held party has no way to produce:
 *
 *   * a **paired device** with the `answer` grant. Its credential was minted at
 *     the desk, lives on that phone, is stored here only as a hash and is never
 *     in any environment an agent inherits (auth.ts, devices.ts).
 *   * or an **Origin**. The desktop shell serves its renderer from a scheme no
 *     browser can be served from, and a browser attaches `Origin` to every POST
 *     it makes, same-origin ones included — so the web UI on this machine and
 *     the companion over the tailnet keep working untouched, while `curl`,
 *     `urllib` and every other library that sends no such header do not.
 *
 * The honest limit, because it belongs next to the code and not in a commit
 * message: a header is a string, and a local process determined to forge one
 * can. This does not make the gate a security boundary — SECURITY.md is right
 * that nothing here can be, against code running as you. What it does is make
 * self-release deliberate rather than incidental: the helpful agent reaching
 * for the obvious `curl`, and the injected instruction that says "approve it",
 * both now get a refusal that explains itself instead of an approval the log
 * records as a person. Closing it properly needs a credential the agent cannot
 * read, which means one the desk holds and the token file does not.
 *
 * And the case that is easy to read past: with no token configured at all,
 * `caller` is always null — `resolveToken` returns none on a loopback-only box
 * and index.ts never runs the block that identifies anybody — so the device
 * branch does not exist there and the Origin branch is the whole of this check.
 * It still turns away the Origin-less `curl`, which is the shape this is about,
 * but on such a box nothing else is authenticated either: any local process can
 * post a gate and read the queue. That is `bun run dev` and any hand-started
 * server, never the packaged app, which mints a secret for its own sidecar. If
 * it is you, set `AGENTGLASS_TOKEN` — see resolveToken in auth.ts.
 */
/**
 * A caller as the action log wants it. `Caller.kind` grew a third value —
 * `plugin`, see auth.ts — and ActorSource has two. A plugin's token was logged
 * as an unnamed device before, which came out as the address it arrived from;
 * it still does, because a plugin has no `device` to name, and the log line is
 * about WHERE a write came from when nobody can be named. What changed is the
 * gate (answersFromADevice), not the log.
 */
function asActor(c: Caller | null | undefined): ActorSource | null {
  if (!c) return null;
  return c.kind === "plugin" ? { kind: "device" } : { kind: c.kind, device: c.device };
}

function mayReleaseAHold(req: Request, caller: Caller | null): boolean {
  if (answersFromADevice(caller)) return true;
  const o = req.headers.get("origin");
  return !!o && vouchedOrigin(o);
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
// The rebuilt list (/git/changes-v2). Same shape of cache, one crucial
// difference in what it holds: rows without diff text, so a hit is a few
// kilobytes rather than the megabyte the old one served every four seconds.
const rowsCache = new Map<string, { at: number; body: string }>();
// Shorter than CHANGES_ALL_TTL_MS and NOT stretched by backoff. The old TTL
// reached 24s under load, which is a review panel silently showing the state of
// the repo before your last commit; this list is cheap enough to hold for two.
const ROWS_TTL_MS = 2_000;
// Only a ceiling against a runaway checkout — and, unlike the old one, the
// answer says how many rows it left out instead of ending a worktree short in
// silence.
const ROWS_MAX = 2_000;
setGitChangeHook(() => { treeCache.clear(); worktreesCache.clear(); rowsCache.clear(); broadcast({ type: "git" }); });

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
 *
 * A `pty` socket was exempt from all of this, and that is what let a phone's
 * mirror outlive the phone: `new-session ... destroy-unattached on` only ever
 * fires on OUR side once the pty this socket feeds is hung up (`ptyClose` ->
 * `killGroup` -> the child that was running `tmux attach` dies -> tmux sees
 * the detach). A phone that goes dark — backgrounded, out of signal — never
 * sends a close frame, so that chain never starts, and the grouped session
 * with it sits on the socket for as long as the TCP connection is willing to
 * pretend it is still open. Same ping, same deadline, same `alive` map a pty
 * socket already gets entries in (the `pong` handler below sets one for every
 * kind) — it was just never read for anything.
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
  for (const ws of sockets) {
    if (ws.data?.kind !== "pty") continue;
    const at = alive.get(ws) ?? 0;
    if (now - at > LIVE_DEADLINE_MS) {
      // `close()` runs the same `ptyClose` a real client disconnecting would:
      // hang up the pty group, which is what lets `destroy-unattached` do its
      // job on the mirror session underneath, if there is one.
      try { ws.close(1001, "no answer to a ping in 30s"); } catch { /* already gone */ }
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

/*
 * The understudy's seams, as index.ts needs them.
 *
 * Three small things live here rather than in understudy.ts, and the split is
 * deliberate: understudy.ts owns what a row MEANS and this file owns what a
 * ROUTE was. The moment the scoring module starts knowing that
 * `/prs/update-branch` is C8, every future route has two homes and one of them
 * is always the one nobody edited.
 */

/**
 * Routes the universal net does not open a row for, because their body is a
 * credential.
 *
 * A denylist rather than the usual allowlist, and this is the one place in the
 * server where that is the right shape: the net's whole job is to catch the
 * route somebody added without telling anybody, so it has to default to
 * recording. What it must never do is grow, one careless edit later, into the
 * place a token was copied to — and the row it writes today carries no body at
 * all, so the guard exists for the edit that has not happened yet rather than
 * for the code as written.
 *
 * `/pair/*` carries the pairing code, `/providers/*` reaches one shared handler
 * that takes `b.token`, `/auth/*` is reserved for the same reason and has no
 * route today, and `/control` is navigation — logging it would bury the writes
 * under UI focus changes, which is the same argument action-log.test.ts makes
 * for keeping it out of the audit log.
 *
 * `/machine/env` is deliberately NOT here. `noteAction` already records that
 * route while withholding the value, and copying that is the pattern; adding it
 * to a blind list would be a second, quieter rule about the same call.
 */
const UNDERSTUDY_BLIND_PREFIXES = ["/pair/", "/providers/", "/auth/"];

/**
 * And the machine talking to itself, which is a different argument.
 *
 * Measured on a real install four hours after this shipped: 213 stub rows, of
 * which 102 were `/ingest`, 79 `/browser/ready` and 30 `/statusline`. Two rows
 * out of 213 were a person doing something. None of it is dangerous — a stub
 * holds no body, and the scorecard never counts one — but the stub table exists
 * to answer ONE question, "what fraction of his real writes do the classed
 * seams actually see", and a denominator that is 99% telemetry cannot answer
 * it. Worse, it answers it wrongly and confidently: coverage looks like 1%.
 *
 * These are the routes an agent, a hook or the app's own chrome calls without a
 * human deciding anything. `/ingest` is the hook intake and fires on every tool
 * call; `/browser/ready` and `/statusline` are the renderer reporting in.
 */
const UNDERSTUDY_MACHINE = new Set([
  "/ingest", "/browser/ready", "/statusline", "/v1/traces", "/otlp/v1/traces", "/v1/logs", "/otlp/v1/logs",
]);
const UNDERSTUDY_BLIND = new Set(["/control", "/providers", "/pair", ...UNDERSTUDY_MACHINE]);
function understudyBlind(pathname: string): boolean {
  return UNDERSTUDY_BLIND.has(pathname) || UNDERSTUDY_BLIND_PREFIXES.some((p) => pathname.startsWith(p));
}

/**
 * Which class a write on the git and pull-request chokepoints belongs to.
 *
 * Local to this file and NOT a `classFor(route)` in understudy.ts, for the
 * reason written on `UnderstudyClass.routes`: `/chat/send` is both C5 and C7,
 * so a general route-to-class map has to guess at exactly the route that
 * matters most. Every name below is unambiguous — a merge is a merge — which is
 * why a map is honest here and dishonest there.
 */
const UNDERSTUDY_CLASS_OF: Record<string, string> = {
  "/git/worktree-add": "C1",
  "/git/branch-create": "C1",
  "/git/commit": "C2",
  "/git/commit-staged": "C2",
  "/git/merge": "C3",
  "/git/branch-delete": "C3",
  "/git/worktree-remove": "C3",
  "/prs/reply": "C4",
  "/prs/thread-resolved": "C4",
  "/prs/update-branch": "C8",
  "/prs/rerun": "C8",
  "/prs/merge": "C9",
  "/prs/review-with": "C10",
  "/prs/pending-review": "C10",
  "/prs/edit": "C11",
};

/** Branch prefixes this machine actually uses, plus the trunk names. Anything
 *  else is `other`, which is the point: the class is being scored on "does it
 *  guess the SHAPE he reaches for", and a set that grows a member per branch
 *  would be scoring it on remembering names. */
const BRANCH_SHAPES = new Set([
  "feat", "feature", "fix", "hotfix", "chore", "docs", "refactor",
  "test", "perf", "build", "ci", "style", "revert", "release",
  "main", "master", "develop",
]);

/**
 * A branch name reduced to the only part of it that is categorical.
 *
 * A branch name is free text with a ticket id in it more often than not, so it
 * cannot be stored — but the decision worth scoring was never the words after
 * the slash. It was `feat/` rather than `fix/`, and whether he cut a namespaced
 * branch at all.
 */
function branchShape(name: unknown): string {
  const s = String(name ?? "");
  if (!s) return "none";
  const slash = s.indexOf("/");
  const head = (slash === -1 ? s : s.slice(0, slash)).toLowerCase();
  if (BRANCH_SHAPES.has(head)) return head;
  return slash === -1 ? "bare" : "other";
}

/** A count, as a bucket. The number of files in a commit is a fact about the
 *  work; the bucket is a fact about the habit, and only the second one is
 *  something a prediction can be right or wrong about. */
function countShape(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n === 1) return "1";
  if (n <= 5) return "2-5";
  if (n <= 20) return "6-20";
  return "20+";
}

/** One of a fixed set, or `other`. Used for anything a client sends as a word
 *  — a merge method, a review verb — so an unexpected spelling widens no
 *  column. */
function oneOf(value: unknown, allowed: readonly string[]): string {
  const s = String(value ?? "").toLowerCase();
  return allowed.includes(s) ? s : s ? "other" : "none";
}

/**
 * The categorical shape of a write, built from its request body and answer.
 *
 * Read the returns rather than the parameter list: `b` is the request body and
 * not one field of it survives as itself. Titles and commit messages become
 * booleans, branches become shapes, counts become buckets, and the review body
 * becomes "there was one". That is what makes this safe to call with the whole
 * body in hand — the function is the filter, so a future case that wants to
 * keep a string has to be written here, in front of the comment saying not to.
 */
function understudyShape(route: string, b: any, ok: boolean): {
  subject: string;
  repo: string;
  actual: Record<string, unknown>;
} | null {
  const repo = basename(String(b?.root ?? "")) || "";
  const pr = b?.number === undefined || b?.number === null ? "" : `#${String(b.number).slice(0, 12)}`;
  const files = Array.isArray(b?.paths) ? b.paths.length : Array.isArray(b?.files) ? b.files.length : 0;
  switch (route) {
    case "/git/worktree-add":
      return { subject: repo, repo, actual: { branch: branchShape(b?.branch), fresh: b?.newBranch === true, from: b?.startPoint ? "start-point" : "head", ok } };
    case "/git/branch-create":
      return { subject: repo, repo, actual: { branch: branchShape(b?.name), ok } };
    case "/git/commit":
      return { subject: repo, repo, actual: { staged: false, files: countShape(files), titled: !!String(b?.title ?? ""), described: !!String(b?.body ?? ""), ok } };
    case "/git/commit-staged":
      return { subject: repo, repo, actual: { staged: true, files: "staged", titled: !!String(b?.title ?? ""), described: !!String(b?.body ?? ""), ok } };
    case "/git/merge":
      return { subject: repo, repo, actual: { from: branchShape(b?.name), ok } };
    case "/git/branch-delete":
      return { subject: repo, repo, actual: { branch: branchShape(b?.name), force: b?.force === true, ok } };
    case "/git/worktree-remove":
      return { subject: repo, repo, actual: { force: b?.force === true, ok } };
    case "/prs/reply":
      return { subject: pr, repo, actual: { replied: true, ok } };
    case "/prs/thread-resolved":
      return { subject: pr, repo, actual: { resolved: b?.resolved !== false, ok } };
    case "/prs/update-branch":
      return { subject: pr, repo, actual: { syncLocal: b?.syncLocal === true, ok } };
    case "/prs/rerun":
      return { subject: pr, repo, actual: { what: "failed-checks", ok } };
    case "/prs/merge":
      return { subject: pr, repo, actual: { method: oneOf(b?.method, ["merge", "squash", "rebase"]), deleteBranch: b?.deleteBranch === true, auto: b?.auto === true, ok } };
    case "/prs/review-with":
      return { subject: pr, repo, actual: { verb: oneOf(b?.verb, ["approve", "comment", "request_changes"]), comments: countShape(Array.isArray(b?.comments) ? b.comments.length : 0), wrote: !!String(b?.body ?? ""), ok } };
    case "/prs/pending-review":
      return { subject: pr, repo, actual: { read: true, ok } };
    case "/prs/edit":
      return { subject: pr, repo, actual: { title: b?.title !== undefined, body: b?.body !== undefined, base: b?.base !== undefined, ok } };
    default:
      return null;
  }
}

/**
 * Tell the view the score moved, at most once a second.
 *
 * `broadcast` says of itself that it is a fan-out on the hot path of ingest,
 * and `scorecard()` is thirteen rows of aggregate over the whole ledger. A
 * merge that lands four writes in the same tick should cost one frame, not
 * four, and the panel is watching a number that changes at the speed a person
 * presses buttons — so a one-second trailing coalesce is invisible to it and is
 * the difference between "the panel is live" and "the panel is a load".
 *
 * Nothing at all happens while the understudy is off, which is the property
 * that has to hold: off means no rows, no reads and no frames.
 */
let scoreTimer: ReturnType<typeof setTimeout> | null = null;
function understudyChanged(): void {
  if (!understudyEnabled() || scoreTimer) return;
  scoreTimer = setTimeout(() => {
    scoreTimer = null;
    try { broadcast({ type: "understudy", data: scorecard() }); } catch { /* a frame nobody got */ }
  }, 1000);
  // Never a reason to hold the process open: a scoreboard update is worth
  // exactly nothing to a server that is shutting down.
  (scoreTimer as any).unref?.();
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

/**
 * The commit this build was made from, read once off `build-info.json`.
 *
 * Empty in a dev tree, which is right: there is no installed build to be behind.
 */
let stampCache: string | null = null;
function buildStamp(): string {
  if (stampCache !== null) return stampCache;
  try {
    const here = new URL("../../build-info.json", import.meta.url).pathname;
    stampCache = String(JSON.parse(fsRead(here, "utf8")).commit || "");
  } catch { stampCache = ""; }
  return stampCache;
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
    /*
     * The understudy's row for this request.
     *
     * Opened below, once the caller is resolved and before any route can
     * answer, and settled here — because the status this request ended up
     * giving is the one thing about a write that no call site knows at the
     * moment it happens. `settleLedger(0, …)` is a no-op, so every `json()`
     * above the seam (the rebinding refusal, the CSRF refusal, the 401) costs
     * nothing and leaves no row: a request the fences turned away is not a
     * write, and the ledger is a record of writes.
     *
     * `body()` below and the handlers that build their own `new Response` do
     * NOT settle, on purpose. Those rows keep `status = NULL`, and NULL here
     * means "answered outside the json helper" rather than "we lost it" —
     * understudy-net.test.ts asserts one of them, so the meaning stays a fact
     * about the code instead of a claim in a comment.
     */
    let stub = 0;
    const json = (data: unknown, status = 200) => {
      settleLedger(stub, status);
      return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", ...cors } });
    };
    /** Already-serialised JSON — see whileRefsHold. */
    const body = (s: string, status = 200) =>
      new Response(s, { status, headers: { "content-type": "application/json", ...cors } });
    const csrfBlocked = () => json({ ok: false, error: "cross-origin write blocked" }, 403);
    /**
     * A bare 403 here is the worst possible answer.
     *
     * Whoever reads it is one of two people. If it is the agent that was held,
     * the sentence has to say that answering its own gate is not a thing it can
     * do, or it will read "403" as a bug and try the call again with a
     * different spelling. If it is a person whose client genuinely sends no
     * Origin — a script somebody wrote against this API — they need to be told
     * which clients do work, because nothing about "forbidden" points at the
     * app they already have open.
     */
    const heldPartyBlocked = () => json({
      ok: false,
      error: "a held call is released by a person, not by the process being held — "
        + "this request carried no Origin and no paired-device credential, which is "
        + "what an agent's own shell looks like. Answer it in the desktop app, in the "
        + "web UI, or on a paired phone.",
    }, 403);
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
        /*
         * The understudy answers differently, and the wording is the point.
         *
         * A refusal here is not a scope problem — the understudy has no scope,
         * it has an allowlist (see `understudyAllows` in auth.ts) — so the
         * device sentence below would tell whoever reads it two false things:
         * that this is a paired device, and that a wider scope would fix it.
         * Nothing widens it. The row is kept for ever as `kind = 'fence'`,
         * because a 403 for a principal that is supposed to only ever watch is
         * the single most interesting line this feature can produce.
         */
        if (caller.principal === "understudy") {
          recordFence(pathname, req.method);
          return json({
            ok: false,
            error: `the clone may not ${req.method} ${pathname} — it watches and never acts`,
          }, 403);
        }
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

    /*
     * THE UNIVERSAL NET.
     *
     * Here and not one line earlier or later. Earlier and `caller` is not
     * resolved, so the row would say a write happened without being able to say
     * whose; later and a route has already answered, so the write the net exists
     * to notice is the one write it misses. This is also the last point at which
     * `req.json()` has certainly not been consumed — every handler below reads
     * the body itself and a body can only be read once — which is what makes
     * "the net cannot see the body" a property of where it sits rather than a
     * promise about how it behaves.
     *
     * POSTs only. A GET is a read, and a ledger with the dashboard's own polling
     * in it is a ledger nobody scrolls to the bottom of.
     *
     * What this answers that the per-class seams cannot: "did a write happen
     * that no class was watching". A seam knows about itself; only the net knows
     * about the route somebody added last week.
     */
    if (req.method === "POST" && !understudyBlind(pathname)) {
      stub = openStub({ route: pathname, method: req.method, actor: actorOf(clientIp, asActor(caller)) });
    }

    /**
     * Was there a person behind this request.
     *
     * The same test `/gate/decide` uses to decide whether a machine-token caller
     * was the app's renderer or an agent's shell: browsers attach an Origin to a
     * POST and cannot be talked out of it, and a shell sends none unless it was
     * told to. It matters far more here than it does in the log, because only
     * `typed` and `clicked` count toward a class's denominator — an agent
     * driving the API is not him agreeing with anything, and counting it would
     * let the understudy score itself.
     */
    const pressed = (): string => {
      const o = req.headers.get("origin");
      return o && vouchedOrigin(o) ? "clicked" : "agent-tolerated";
    };

    /*
     * SEAL AND GUESS, BEFORE THE ROUTE RUNS.
     *
     * A prediction is worth nothing unless it was written down before the
     * answer, so it happens here — after the caller is known, before any
     * handler has done a thing — and never beside the line that records what
     * he actually did. A predictor called from the same place as the actual
     * would score beautifully and mean nothing.
     *
     * The body is read off a CLONE. `req.json()` consumes the stream and the
     * handler downstream still needs it; a clone costs one copy of a small
     * JSON body and keeps this seam invisible to everything after it.
     */
    if (req.method === "POST" && UNDERSTUDY_CLASS_OF[pathname] && understudyEnabled()) {
      const cls = UNDERSTUDY_CLASS_OF[pathname]!;
      try {
        const peek = await req.clone().json() as Record<string, unknown>;
        const shape = understudyShape(pathname, peek, true);
        if (shape) {
          const id = sealSituation(cls, {
            subject: shape.subject,
            repo: shape.repo,
            partition: isOpenProjectPath(shape.repo) ? OPEN_PARTITION : "closed",
            /* The situation, as text, and deliberately thin: the route and the
               identifier are enough to hash a case and carry nothing a body could
               have leaked into. */
            body: `${pathname} ${shape.subject}`,
          });
          if (id) {
            const pred = predictSealed(id, cls, shape.subject);
            /*
             * And, when the stance allows it, write down what it would have
             * done — not as a shape, as a request somebody could press.
             *
             * At `queued` nothing runs; the proposal waits. The seam is the only
             * place proposals are made, deliberately: a route that produced them
             * on request would let a caller aim the understudy at a repository
             * of their choosing, and `propose` refuses anything outside the open
             * project for the same reason.
             */
            /*
             * NO DRAFT IS MADE HERE, and a version of this file made one.
             *
             * Drafting hung off this seam for a day: it seals when the person
             * CLICKS something, so a proposal made here is a proposal to do the
             * thing they are already doing. It also could not have worked — the
             * predicted shape is `{branch, fresh, from, ok}` and the bridge
             * wanted `{base, pattern}`, and the `repo` in that shape is a name
             * rather than a path, so there was no root to send. Prediction is
             * deliberately thin; an action cannot be built from thin.
             *
             * Proposals come from `understudy-scan.ts`, which reads the state of
             * the repositories instead. This seam goes back to what it is good
             * at: sealing, predicting, and being scored.
             */
          }
        }
      } catch { /* an unreadable body is simply a decision we did not foresee */ }
    }

    /**
     * The per-class seam for the two write families.
     *
     * Called on the same `res` the audit log is called on, one statement above
     * it, and deliberately not folded into that line: action-log.test.ts counts
     * those one-liners as a tripwire for "a write family was restructured", and
     * a class seam is not a reason to make that count lie.
     */
    const noteClass = (route: string, b: unknown, ok: boolean): void => {
      const cls = UNDERSTUDY_CLASS_OF[route];
      if (!cls) return;
      const shape = understudyShape(route, b, ok);
      if (!shape) return;
      recordDecision(cls, { subject: shape.subject, repo: shape.repo, actual: shape.actual, provenance: pressed() });
      understudyChanged();
    };

    /** C6 has no family switch to hang off — a gate is answered by one handler
     *  — so it gets its own two lines rather than an entry in the route map. */
    const noteClass6 = (gateId: string, actual: Record<string, unknown>): void => {
      recordDecision("C6", { subject: gateId, actual, provenance: pressed() });
      understudyChanged();
    };

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
        // Where to put the cursor in that file. A number, bounded here so a
        // URL cannot ask for a line that is not one.
        line: Math.min(Math.max(Number(url.searchParams.get("line")) || 0, 0), 10_000_000),
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
        console: url.searchParams.get("console") === "1",
        // Which tab of the floating bench this is. A small number the client
        // keeps; the server turns it into a session name, so no client ever
        // names a session on this engine. See engineBenchArgv.
        bench: Math.min(Math.max(Number(url.searchParams.get("bench")) || 0, 0), 99) || undefined,
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
    if (pathname === "/health") {
      /*
       * THE BUILD, so a window can tell it has been left behind.
       *
       * Installing replaces the server and the bundle on disk and relaunches —
       * but a window that was already open keeps the JavaScript it loaded. The
       * data then arrives in the new shape and is drawn by the old code, which
       * looks exactly like data that never arrived: a board whose verdict
       * headers and tracker lines simply never appear, and a Refresh button
       * that cannot fix it because it refreshes DATA, not code.
       *
       * That cost an afternoon of looking for a bug in the wrong half. The
       * window compares this against what it saw when it loaded.
       */
      return json({
        ok: true, service: "agentglass", clients: clients.size,
        notifyWatching: notifyWatching(), build: buildStamp(),
      });
    }

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
      // Whether this session is now stopped on a person — set by a wait-shaped
      // Notification, cleared by anything it does after. Here, before the
      // scanner check: an owned session's hook events never get past it, and
      // its notifications are hook-only, so this is the one place they exist.
      noteWaitFromHook(body);
      /* The Lantern's own chat is an observer: its "waiting for your input"
         is you having asked it something, not an agent stopped on you, and
         the reminder to say what it is on would be the watcher watching
         itself. The pane says so in its environment; the hook passes it on. */
      const lanternItself = hookSaysLantern(body) || isLanternSession(String(body.session_id ?? ""));
      if (lanternItself) noteLanternSession(String(body.session_id ?? ""));
      /*
       * THE LANTERN REMINDER RIDES THE ANSWER.
       *
       * On a prompt, and only then, the hook may be handed one line to print
       * — which Claude Code shows the session as context for that turn, the
       * same way it shows the memory-save reminder. Decided here rather than
       * in the hook because this is where the two clocks live: whether this
       * session has already said what it is doing (agent_status), and when
       * it was last asked. Computed BEFORE the scanner check below: a session
       * the scanner owns is exactly the kind that runs in a pane and shows on
       * the board, and it was returning before this line could be added.
       */
      const remind = body.hook_event_type === "UserPromptSubmit" && lanternNudge() && !lanternItself
        && AgentBoard.nudgeDue(String(body.session_id ?? ""), lanternNudgeMinutes() * 60_000)
        ? { remind: AgentBoard.lanternReminder({ session: String(body.session_id), server: `http://127.0.0.1:${PORT}` }) }
        : null;
      // A Claude Code session with a transcript on disk is already covered by
      // the scanner, which reads the same turns in richer form. Taking the hook
      // copy too would count every tool call and every token twice.
      if (ownsSession(body.session_id)) return json({ ok: true, skipped: "scanner owns this session", ...remind });
      const result = ingestBody(body);
      return json({
        ok: true,
        id: result.event.id,
        ...(!result.inserted ? { duplicate: true } : {}),
        ...remind,
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

    /*
     * WHO IS WORKING ON WHAT.
     *
     * The deputy has a screen and the agents in the terminals do not, which is
     * how "suddenly they are doing lots of tasks and I don't even know which" happens.
     * Most of that list this app can already assemble — panes, sessions,
     * worktrees, the transcript clock — but what an agent is working ON is the
     * one thing only the agent knows, so it says so here.
     *
     * A status, not a log: one row per agent, replaced. Stale rows are kept
     * and dated rather than hidden, because "nobody has touched this in an
     * hour" is the answer somebody is usually looking for.
     */
    /*
     * WHAT THE TAB IS FOR, IN THREE WORDS.
     *
     * The strip's names are stable (`AI01`, `AI02`) and stability is exactly
     * what makes them say nothing: "I want them to always be AI0X... or for it
     * to match the task being worked on", and the answer to that
     * `or` is both. The number is the address; this is the label under it.
     *
     * Its own route rather than a field on the terminal frame, which is swept
     * twice a second per attached client: a sentence an agent publishes every
     * few minutes does not belong in a poll that fast, and the frame's pane
     * format is read positionally by three parsers.
     */
    if (pathname === "/terminal/tab-hints") {
      const board = AgentBoard.merged({ runs: Work.runningRuns().map((r) => ({
        title: r.title, worktree: r.worktree, branch: r.branch, startedAt: r.startedAt,
      })) }).filter((a) => a.doing && a.worktree);
      const hints: Record<string, string> = {};
      if (board.length) {
        const r = await tmux(["list-panes", "-a", "-F", "#{window_id}\t#{pane_current_path}"]);
        for (const line of (r.ok ? r.stdout : "").split("\n")) {
          const [win = "", cwd = ""] = line.split("\t");
          if (!win.startsWith("@") || !cwd || hints[win]) continue;
          /* Longest worktree first, so a checkout inside another checkout is
             answered by the inner one. */
          const owner = board
            .filter((a) => cwd.startsWith(a.worktree!))
            .sort((a, b) => b.worktree!.length - a.worktree!.length)[0];
          if (owner?.doing) hints[win] = owner.doing.slice(0, 120);
        }
      }
      return json({ ok: true, hints });
    }
    if (pathname === "/agents/board") {
      /* Every source at once — see lantern.ts, which the terminal's "Ask
         about the field" reads too, so the view and the chat cannot disagree. */
      return json({ ok: true, agents: await boardNow(), watch: lastLook(), cacheTtlMinutes: cacheTtlMinutes() });
    }
    if (pathname === "/agents/status" && req.method === "POST") {
      if (!trustedCaller(req, from)) return csrfBlocked();
      const b = await req.json().catch(() => ({})) as Record<string, unknown>;
      /* Cut here as well as in agentboard.ts. This route is tokenless on
         loopback under the 32 MB body limit, so the cap is the only thing
         between a local process and a row of that size; and a cap applied in
         one place is a cap the next caller of saidBy forgets. Names and refs
         at 512, prose at 4096 — both far above anything real. */
      const text = (v: unknown, cap: number) => String(v ?? "").slice(0, cap);
      const name = text(b.name, 512).trim();
      if (!name) return json({ ok: false, error: "which agent?" }, 400);
      const session = typeof b.session === "string" ? b.session.slice(0, 512) : "";
      /* An agent that has finished says so by clearing its line, rather than
         leaving a claim behind for the next person to disbelieve — and only
         the session that wrote the line may clear it; see forgetAgent. */
      if (b.done === true) {
        if (!session) return json({ ok: false, error: "done needs the session that posted the line" }, 400);
        const cleared = AgentBoard.forgetAgent(name, session);
        return json(cleared ? { ok: true, cleared: true } : { ok: false, error: "no line by that name from this session" }, cleared ? 200 : 403);
      }
      /* The observer does not post: a status from the Lantern's own chat is
         the watcher listing itself, and it is answered kindly and dropped. */
      if (session && isLanternSession(session)) return json({ ok: true, ignored: "the Lantern does not post status" });
      const ok = AgentBoard.saidBy({
        name,
        doing: text(b.doing, 4096), worktree: text(b.worktree, 512),
        branch: text(b.branch, 512), left: text(b.left, 4096),
        // The hooked session behind the claim, when the reminder that asked
        // for it baked one in. What lets the reminder stop asking.
        session,
      });
      return json(ok ? { ok: true } : { ok: false, error: "could not write that down" }, ok ? 200 : 500);
    }

    /*
     * THE LANTERN'S OWN SETTINGS — whether hooked sessions get asked what they
     * are doing, and how often. Read by the Agents pane in Settings; written
     * by it too. Nothing else here is configurable on purpose: the view is a
     * screen you read, and this is the one thing about it that costs a session
     * something (one line of attention every interval).
     */
    if (pathname === "/lantern/settings" && req.method === "GET") {
      return json({ ok: true, nudge: lanternNudge(), minutes: lanternNudgeMinutes(), watch: lanternWatch(), watchMinutes: lanternWatchMinutes(), cacheTtlMinutes: cacheTtlMinutes(), min: LANTERN_NUDGE_MIN_MIN, max: LANTERN_NUDGE_MAX_MIN });
    }
    if (pathname === "/lantern/settings" && req.method === "POST") {
      if (!trustedCaller(req, from)) return csrfBlocked();
      let b: any = {};
      try { b = await req.json(); } catch { return json({ ok: false, error: "invalid json" }, 400); }
      const fields: Parameters<typeof writeLanternSettings>[0] = {};
      if (b.nudge !== undefined) fields.lanternNudge = b.nudge === true;
      if (b.watch !== undefined) fields.lanternWatch = b.watch === true;
      if (b.cacheTtlMinutes !== undefined) fields.cacheTtlMinutes = Number(b.cacheTtlMinutes);
      for (const [key, field] of [["minutes", "lanternNudgeMinutes"], ["watchMinutes", "lanternWatchMinutes"]] as const) {
        if (b[key] === undefined) continue;
        const n = Number(b[key]);
        if (!Number.isFinite(n)) return json({ ok: false, error: "the interval has to be a number of minutes" }, 400);
        fields[field] = n;
      }
      const w = writeLanternSettings(fields);
      /* The clock reads its interval when it arms, so a change takes effect at
         the next arming — which is now, or the old interval lingers once. */
      if (w.ok) restartLanternWatch();
      return json({ ...w, nudge: lanternNudge(), minutes: lanternNudgeMinutes(), watch: lanternWatch(), watchMinutes: lanternWatchMinutes(), cacheTtlMinutes: cacheTtlMinutes() }, w.ok ? 200 : 400);
    }

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
      if (!BUDGET_WRITE_ENABLED) return json({ ok: false, error: "budget writes are disabled (AGENTGLASS_BUDGET_WRITE_DISABLED=1)" }, 403);
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
        Math.min(GATE_MAX_MS, Number(b.timeout_ms) || 60_000),
        budgetHoldFor(String(b.session_id || "unknown"), gateFailClosed())
      );
      return json(decision);
    }
    /**
     * The three reads, and why they do NOT get the gate `/gate/decide` just got.
     *
     * The case for giving it to them is real. `/gate/pending` hands back the
     * command an agent is stopped on, and `/gate/history` hands back every
     * command it was stopped on this month plus who decided each one. That is a
     * description of what this user does with their machine, and today it is
     * readable by anything on the box holding the token — the same shell that
     * was just refused the button next to it. Locking a decision while leaving
     * the queue open is half a door.
     *
     * It is still the wrong trade, for a reason that is specific rather than
     * philosophical: `hooks/gate_event.py` polls `/gate/status` to re-attach
     * after a dropped connection, and it is Python `urllib` — it sends no
     * Origin and there is no sensible way to make it send one. A 403 there is
     * not caught as a refusal; the retry loop treats a non-404 error as "the
     * connection went away, keep trying" until its own deadline passes, and
     * then falls into fail-open. Every held call on the box would auto-allow,
     * silently, with the hold looking healthy on screen. That is strictly worse
     * than the bug being fixed here — it converts the gate from "an agent can
     * release itself if it tries" into "no agent is ever held".
     *
     * And the disclosure the other two carry is bounded in a way the release is
     * not. A process that can read `/gate/pending` runs as this user, which
     * means it can already read the transcripts, the events database and the
     * repositories those commands are about. Reading the queue tells it what it
     * could have learned anyway; answering the queue lets it do something it
     * could not. So: reads stay on the surface-wide origin gate plus the token,
     * writes carry the stricter one. If `/gate/pending` and `/gate/history` are
     * ever tightened, `/gate/status` must be left exactly as it is, and the
     * reason is this paragraph rather than an oversight.
     */
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
      // Both gates, and neither is redundant. `trustedCaller` is the CSRF
      // question — is this browser one we are willing to be driven by — and
      // `mayReleaseAHold` is the one this route exists for: the party being
      // held may not let itself go. See the function; the difference between
      // them is exactly the Origin-less loopback caller, which is a hook, an
      // agent's shell, or a script, and is never a person pressing a button.
      if (!mayReleaseAHold(req, caller)) return heldPartyBlocked();
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
      /*
       * `fromPage` is what turns actorOf's three answers from a type into a
       * fact. Without it every machine-token caller — the app's own renderer
       * and a curl from an agent's shell alike — was written as "local", which
       * is the string a person pressing the button produces.
       *
       * A present, vouched Origin is the signal: browsers attach one to a POST
       * and cannot be talked out of it, and the desktop renderer sends the
       * app's own scheme. A shell sends none unless it is told to, and a shell
       * that IS told to is a different sentence in the log than a shell that
       * was not.
       */
      const pageOrigin = req.headers.get("origin");
      const who = actorOf(clientIp, caller ? { ...asActor(caller)!, fromPage: !!pageOrigin && vouchedOrigin(pageOrigin) } : caller);
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
        { tool: held?.tool_name, summary: held?.summary }, { ok, error }, asActor(caller));
      /*
       * C6, beside the audit line and built from the same held row.
       *
       * `summary` goes to `noteAction` and NOT here, and that asymmetry is the
       * whole of the difference between the two records. The audit log answers
       * "who allowed WHAT", so it needs `rm -rf build`; the understudy answers
       * "would it have said allow", which the tool name settles and the command
       * line only endangers — a summary is a command line, and a command line is
       * a path, a hostname and sometimes a token.
       *
       * `reasoned` for the same reason: whether he bothered to type a reason is
       * a habit worth predicting, and the reason itself is prose.
       */
      noteClass6(String(b.id), {
        decision,
        tool: String(held?.tool_name ?? "") || "unknown",
        reasoned: !!String(b.reason ?? ""),
        took: ok,
      });
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

    /*
     * The understudy's own surface: read the score, read one row, turn a class
     * down, stop, and switch the whole thing on.
     *
     * Every one of them is a line and a half, because there is nothing to any
     * of them but a call into understudy.ts. The interesting decisions — what
     * counts, what may be promoted, what is refused — all live there, and a
     * route that re-decided any of them would be a second opinion nobody could
     * tell apart from the first.
     */
    if (pathname === "/understudy/scorecard") {
      /* The panel's 7d / 30d / All control. Anything unparseable is "all",
         because a filter that silently narrows the numbers is worse than one
         that silently widens them. */
      const w = url.searchParams.get("window");
      const days = w === "7" ? 7 : w === "30" ? 30 : null;
      return json(scorecard(days));
    }
    /*
     * The Ledger tab: the last few decisions, newest first.
     *
     * This is the feature's most convincing screen and the reason the route
     * exists — a scorecard is an assertion, whereas a list of "here is what I
     * saw, here is what I said you would do, here is what you did" is the
     * evidence for it. Same safety property as /why: the columns it returns
     * are categorical by construction and there is no body column to leak.
     */
    /*
     * ── teaching it ──────────────────────────────────────────────────────
     *
     * Everything under here is local file reading driven by the panel. The
     * shape is deliberate: /sources describes what is on the machine and reads
     * nothing, /allow records a yes or a no one source at a time, and /learn is
     * the only thing that opens a file. A person can look at the first, change
     * their mind on the second, and never press the third.
     */
    if (pathname === "/understudy/sources") {
      const { allow, extra, never } = consent();
      return json({
        ok: true,
        sources: listSources(allow, extra),
        never,
        terms: termsStatus(),
        policy: policySummary(),
        learned: lastUnderstudyLearn,
        /*
         * Everything ever refused, not just what the last read refused.
         * `learned.quarantined` is counted in memory during one pass and gone
         * afterwards, so a machine with refusals on record showed zero.
         */
        refusedEver: quarantinedEver(),
        banked: precedentCount(),
        byClass: precedentsByClass(),
      });
    }
    if (pathname === "/understudy/allow" && req.method === "POST") {
      if (!trustedCaller(req, from)) return csrfBlocked();
      const b = await req.json().catch(() => null) as { id?: string; allowed?: boolean } | null;
      if (!b?.id) return json({ ok: false, error: "which source" }, 400);
      setAllowed(String(b.id), b.allowed === true);
      const { allow, extra } = consent();
      return json({ ok: true, sources: listSources(allow, extra) });
    }
    if (pathname === "/understudy/source/add" && req.method === "POST") {
      if (!trustedCaller(req, from)) return csrfBlocked();
      const b = await req.json().catch(() => null) as { path?: string; label?: string; kind?: "rules" | "precedents" } | null;
      const p = gitSafeAbs(String(b?.path || ""));
      if (!p) return json({ ok: false, error: "not a path we can read" }, 400);
      let id: string;
      try { id = addExtraSource(p, b?.label, b?.kind); }
      catch (e) { return json({ ok: false, error: String((e as Error)?.message ?? e) }, 400); }
      setAllowed(id, true);
      const { allow, extra } = consent();
      return json({ ok: true, id, sources: listSources(allow, extra) });
    }
    if (pathname === "/understudy/source/remove" && req.method === "POST") {
      if (!trustedCaller(req, from)) return csrfBlocked();
      const b = await req.json().catch(() => null) as { id?: string } | null;
      if (b?.id) removeExtraSource(String(b.id));
      const { allow, extra } = consent();
      return json({ ok: true, sources: listSources(allow, extra) });
    }
    /*
     * The recommended set, applied in one press.
     *
     * The screen was reported as confusing and it was: twenty rows of equal
     * weight, one holding eight kilobytes of somebody's own conventions and
     * another four hundred megabytes of their employer's work, and a request to
     * choose. This is the answer to "where do I start" — everything the person
     * wrote deliberately about how they work, plus their own project's record,
     * and no raw transcript of anybody else's.
     *
     * It also seeds the exclusion list if it is empty, because an empty list is
     * the one state on that screen where nothing is being protected and the
     * person cannot tell.
     */
    if (pathname === "/understudy/recommend" && req.method === "POST") {
      if (!trustedCaller(req, from)) return csrfBlocked();
      const b = await req.json().catch(() => null) as { everything?: boolean } | null;
      const { allow, extra, never } = consent();
      /*
       * `everything` is a real and reasonable thing to want: a person learning
       * from their own history wants the bad days in it as much as the good
       * ones, and a set that only reads their tidy public project learns a
       * tidier person than exists.
       *
       * It is a separate button rather than a wider default because the two
       * choices carry different risks, and the difference belongs in front of
       * somebody rather than inside a heuristic. Reading is not the risk — the
       * partition keeps closed material out of anything open-bound — but the
       * terms list only knows the names already in it, and only the person
       * knows this quarter's.
       */
      const all = b?.everything === true;
      for (const s of listSources(allow, extra)) {
        if (s.found && (all || s.recommended)) setAllowed(s.id, true);
      }
      /*
       * The seed list, and it is not decoration.
       *
       * A survey of this machine found ~/Documents/secrets holding a 1Password
       * emergency kit, a CSV of cloud access keys and a file of GitHub recovery
       * codes. Those directories exist on most working machines under some
       * name, and an exclusion list that does not name them on the first run is
       * an exclusion list that protects nothing on the first run.
       */
      if (!never.length) {
        setNever([
          "Documents/secrets", ".ssh", ".gnupg", ".env", "credentials",
          "accessKeys", "recovery-code", "1Password", "id_rsa", "id_ed25519",
        ]);
      }
      const after = consent();
      return json({ ok: true, sources: listSources(after.allow, after.extra), never: after.never });
    }
    if (pathname === "/understudy/never" && req.method === "POST") {
      if (!trustedCaller(req, from)) return csrfBlocked();
      const b = await req.json().catch(() => null) as { never?: unknown } | null;
      const list = Array.isArray(b?.never) ? (b!.never as unknown[]).map(String) : [];
      return json({ ok: true, never: setNever(list) });
    }
    /*
     * The only route that opens a file.
     *
     * It refuses without a private-terms list rather than reading anything —
     * see the note on ingest(). The refusal is a 409 and not a 500: nothing
     * went wrong, the machine is simply not in a state where reading a corpus
     * is a safe thing to do.
     */
    if (pathname === "/understudy/learn" && req.method === "POST") {
      if (!trustedCaller(req, from)) return csrfBlocked();
      try {
        // The one way past the gate: the body says, in so many words, that
        // this machine has nothing to protect. Desktop only — a page on the
        // wifi does not get to make that call.
        const b = (await req.json().catch(() => ({}))) as { iAcceptNoTermsList?: unknown } | null;
        const accept = b?.iAcceptNoTermsList === true && desktopOnly(req);
        const r = ingest({ iAcceptNoTermsList: accept });
        lastUnderstudyLearn = r;
        broadcast({ type: "understudy", data: scorecard() });
        return json({ ok: true, learned: r });
      } catch (e) {
        return json({ ok: false, error: String(e instanceof Error ? e.message : e) }, 409);
      }
    }

    /*
     * "What would he do here?" — a read across everything it has learned.
     *
     * GET, because it changes nothing, and the partition is REQUIRED rather
     * than defaulted. This route reaches into somebody's private material and
     * the argument that decides WHICH material is not something to guess at:
     * `retrieve` throws without one, and that throw is the fence.
     */
    if (pathname === "/understudy/ask" && req.method === "GET") {
      const text = (url.searchParams.get("q") || "").trim();
      if (!text) return json({ ok: false, error: "ask what?" }, 400);
      if (text.length > 400) return json({ ok: false, error: "too long to be a question" }, 400);
      const partition = (url.searchParams.get("partition") || "").trim();
      if (!partition) return json({ ok: false, error: "which partition — open work or kept private?" }, 400);
      const cls = url.searchParams.get("cls") || undefined;
      try {
        // The counts travel with the answer so a thin result can say where the
        // rest of the material is instead of just looking empty.
        const answer = ask({ text, cls, partition });
        /*
         * The judge runs only where counting failed, and only if he switched it
         * on. Asking it when the bank already answered would spend a network
         * round trip to paraphrase evidence that is sitting right there — and
         * paraphrase is the one thing this feature must not do.
         */
        const verdict = answer.thin && judgeEnabled()
          ? await judge({ situation: text, cls: answer.cls, partition })
          : null;
        return json({
          ok: true,
          answer,
          verdict,
          judge: { enabled: judgeEnabled(), available: JUDGE_AVAILABLE() },
          banked: bankByPartition(),
        });
      } catch (e) {
        return json({ ok: false, error: String(e instanceof Error ? e.message : e) }, 400);
      }
    }
    /*
     * Where it may draft actions. Narrow by default, and his to widen.
     *
     * Deliberately its own route rather than a field on some larger settings
     * body: this is the switch that decides whether the understudy may draft a
     * request against his employer's repository, and a setting like that should
     * be a thing somebody did, not a field that rode along with something else.
     */
    /*
     * The shift: handing over for a stated while.
     *
     * GET reports what is running and what has run; POST opens or ends one.
     * There is no route that EXTENDS a shift, on purpose — a stand-in that can
     * lengthen its own shift is not standing in, and adding one later should
     * feel like the change that it is.
     */
    if (pathname === "/understudy/shift" && req.method === "GET") {
      const live = Shift.current();
      return json({
        ok: true,
        current: live,
        recent: Shift.recent(8),
        maxMs: Shift.MAX_SHIFT_MS,
        maxActions: Shift.MAX_SHIFT_ACTIONS,
        /* Asleep until the agent's session comes back, when it is. */
        hold: Work.heldUntil(),
      });
    }
    if (pathname === "/understudy/shift/start" && req.method === "POST") {
      if (!trustedCaller(req, from)) return csrfBlocked();
      let b: { goal?: string; minutes?: number; maxActions?: number } = {};
      try { b = await req.json() as typeof b; } catch { return json({ ok: false, error: "invalid json" }, 400); }
      const r = Shift.start(String(b.goal ?? ""), Number(b.minutes ?? 30), Number(b.maxActions ?? 5));
      if (!r.ok) return json({ ok: false, error: r.error }, 409);
      /*
       * NO SCAN ON THE WAY IN, and removing it is the point rather than a
       * simplification.
       *
       * Opening a shift used to walk every checkout looking for work and draft
       * proposals from it. That queue has never held a single row — so the
       * scan filled nothing, and the repository's own measurement puts it at
       * 18.2 SECONDS across twelve checkouts. Handing over to the clone paid
       * that, every time, for a screen nobody could see.
       *
       * The work loop finds its own work, through `nextTask`, at the moment it
       * is about to do some.
       */
      return json({ ok: true, shift: Shift.current() ?? r.shift });
    }
    /*
     * What it did on its own, and the button that takes it back.
     *
     * This is the first screen anybody opens after leaving it running, so the
     * list and the undo are one route apart deliberately: seeing what happened
     * and being able to reverse it should never be two separate journeys.
     */
    /*
     * What HEAD points at, and it exists for exactly one caller.
     *
     * The commit undo is a soft reset to the parent the clone committed on top
     * of. That is exact only while the clone's commit is still the top one:
     * once somebody has committed after it, resetting to that parent takes the
     * newer work with it — a reversal eating the thing it was meant to protect.
     *
     * So the undo checks first, and checking needs a way to ask. A read-only
     * route rather than a git call inside `understudy-act.ts`, because that file
     * deliberately runs nothing: every fence it lives behind depends on it
     * reaching git only through a request somebody authorised.
     */
    if (pathname === "/git/head" && req.method === "GET") {
      const root = url.searchParams.get("root") || "";
      // From the worktree list, which is where the short sha of a checkout
      // already lives — rather than adding a second way to ask git the same
      // question and a second thing to keep in step.
      const wts = await gitWorktrees(root);
      const here = wts.find((w) => w.path === root) ?? wts.find((w) => w.current) ?? null;
      return json({ ok: !!here, head: here?.head ?? "", branch: here?.branch ?? "" });
    }
    /*
     * THE WORK LOOP — take a task, cut a worktree, put an agent in it.
     *
     * Everything else in this feature measures. This is the part he actually
     * asked for: leave it working on the issues for a while. The isolation is
     * the worktree, which is what makes it defensible to hand the agent every
     * tool he has — a run that goes wrong costs a directory.
     *
     * The repositories are the ones already discovered and then filtered to the
     * open project. His decision, taken on a Saturday and for a good reason:
     * prove it where a mistake costs a worktree rather than his job.
     */
    if (pathname === "/understudy/work/next" && req.method === "GET") {
      const repos = await openProjectRepos();
      const item = await Work.nextTask({ repos });
      // The list is capped at twenty; the tally is not, because "how much has it
      // finished" is a question about the shift and not about the last screenful.
      return json({
        ok: true, item, repos, sources: Work.sources(),
        runs: Work.runs(20), tally: Work.runsSoFar(),
        // The panes worth walking over to, if any run is still going. Asked
        // of tmux for anything this process does not remember — it restarts,
        // the runs do not.
        watching: await watchedNow(),
      });
    }

    /*
     * What it knows, and what it has done. Two counts and nothing else.
     *
     * The header used to carry the agreement percentage, the countdown to the
     * next rung and the trust rail — all of which ranked the thirteen decision
     * classes, of which twelve had never held a sample. These are the two
     * questions the loop can actually answer: how much of him it has to work
     * from, and how much it has finished.
     *
     * Four COUNTs against tables already indexed, so it is cheap enough for a
     * header that redraws whenever the panel does. Deliberately NOT part of
     * /understudy/work/next, which asks every source what it is holding — that
     * one reaches the network, and a header must not.
     */
    /*
     * What it is stuck on, and what it needs from you.
     *
     * A loop that stops quietly is worse than one that stops loudly, and until
     * this endpoint existed there was no way to see the difference from
     * outside: 26 of 108 runs ended having delivered nothing, and not one of
     * them said what it needed. An open row here is a question waiting on a
     * person, oldest work first in the queue and newest question first here.
     */
    if (pathname === "/understudy/help" && req.method === "GET") {
      return json({ ok: true, open: openRequests(), history: helpHistory(30) });
    }

    /* A person has dealt with one. The row stays as history — what it asked for
       and how long it waited is the record of where the loop needs a hand. */
    if (pathname === "/understudy/help/answered" && req.method === "POST") {
      if (!trustedCaller(req, from)) return csrfBlocked();
      const body = await req.json().catch(() => ({})) as { id?: number };
      const id = Number(body?.id);
      if (!Number.isFinite(id) || id <= 0) return json({ ok: false, error: "which question?" }, 400);
      markAnswered(id);
      return json({ ok: true });
    }

    if (pathname === "/understudy/standing" && req.method === "GET") {
      const tally = Work.runsSoFar();
      return json({
        ok: true,
        precedents: precedentCount(),
        rules: compiledRules().length,
        done: tally.done,
        failed: tally.failed,
        /* How many questions are waiting on a person. Carried here rather than
           on a route of its own because the header already asks for this one on
           every open, and a count nobody fetches is a raised hand nobody sees. */
        stuck: openRequests().length,
      });
    }

    /*
     * The counter you watch the popcorn over.
     *
     * A run is up to twenty-five minutes of an agent with a shell, and the tab
     * used to show one fixed sentence for all of it. This returns what is on
     * the pane right now, so the panel can draw the work as it happens instead
     * of describing it afterwards.
     *
     * Only a pane this server opened for a run that is still going. The id is
     * pinned to tmux's own shape rather than escaped — it goes on a command
     * line, and `-t` accepts far more than pane ids, so anything else here
     * would be choosing a target somebody else named.
     */
    if (pathname === "/understudy/work/watch" && req.method === "GET") {
      const pane = url.searchParams.get("pane") ?? "";
      if (!/^%\d{1,9}$/.test(pane)) return json({ ok: false, error: "not a pane id" }, 400);
      // Recovered too, not just remembered: the guard and the list have to
      // agree, or a pane the panel was just handed is refused when it asks.
      if (!(await watchedNow()).some((w) => w.paneId === pane)) {
        return json({ ok: false, error: "not a pane this is working in" }, 404);
      }
      const r = await tmux(["capture-pane", "-p", "-t", pane]);
      /*
       * Trailing blank lines trimmed. `capture-pane` returns the whole pane —
       * fifty rows now that the window is resized — so a run that has printed
       * eight lines comes back as eight lines and forty-two empty ones. On
       * screen that is a box mostly full of nothing with a scrollbar sitting
       * in the middle of it, which is what "it has a weird scroll" was.
       */
      const text = r.ok ? r.stdout.replace(/\s+$/, "").slice(-6000) : "";
      return json({ ok: r.ok, text, error: r.ok ? undefined : "the pane has gone" });
    }

    if (pathname === "/understudy/work/run" && req.method === "POST") {
      if (!trustedCaller(req, from)) return csrfBlocked();
      const repos = await openProjectRepos();
      if (!repos.length) return json({ ok: false, error: "no open-project checkout to work in" }, 409);
      const item = await Work.nextTask({ repos });
      if (!item) return json({ ok: false, error: "nothing to work on right now" }, 404);

      /*
       * A TASK WITHOUT A REPOSITORY IS NOT WORK THIS CAN DO, and the first
       * version of this line said `item.repo || repos[0]` — take whatever is
       * first if the task does not say.
       *
       * Found by running it: the top task on a real machine was a card from his
       * EMPLOYER'S tracker, and a card carries no checkout. With one open-project
       * repository present that fallback would have cut a worktree in agentglass
       * and set an agent to work on somebody else's ticket inside it. Not a
       * leak — nothing would have reached the employer's repository — but a
       * confident, wrong, and completely wasted run, and the kind that erodes
       * trust faster than a failure does.
       *
       * A card can only say WHAT to do. Which checkout it belongs in is a fact
       * nobody has told this yet, so it declines and says so.
       */
      if (!item.repo) {
        return json({
          ok: false,
          error: `"${item.title}" does not say which checkout it belongs in, and guessing would be worse than waiting`,
          item,
        }, 409);
      }
      if (!repos.includes(item.repo)) {
        return json({ ok: false, error: `${item.repo} is outside what it may work in today`, item }, 403);
      }

      /*
       * A SHIFT IS REQUIRED HERE TOO, and the asymmetry it replaces was real.
       *
       * The chained loop demanded one and this route did not, so a single task
       * ran with no wall, no budget and no stop rules — and it did, on the first
       * live task: the shift failed to open because one was already running,
       * and the work went ahead regardless. It happened to be fine. It was
       * still an unbounded run, and "one task" is not a limit when the task is
       * an agent with a shell and twenty-five minutes.
       *
       * The budget is charged before the work rather than after, so a run that
       * never returns has still been paid for. Charging on completion means a
       * hung agent costs nothing and the next request starts another.
       */
      const shift = Shift.current();
      if (!shift || shift.state !== "running") {
        return json({ ok: false, error: "hand over first — a run with no shift has no limit on it" }, 409);
      }
      if (shift.actionsLeft <= 0) {
        return json({ ok: false, error: "it used everything it was given" }, 409);
      }
      Shift.countAction(shift.id);

      const res = await Loop.workOne({
        item,
        repo: item.repo,
        shiftId: shift.id,
        agent: runAgentIn,
        install: runInstallIn,
        usage: await usageNow(),
        onPane: nowWatching,
        onNoPane: noPane,
        git: runGitIn,
        verify: runTestsIn,
        // So the agent can read the same views he does — see the brief.
        api: { url: `http://127.0.0.1:${PORT}` },
      });
      return json({ ok: res.ok, run: res });
    }

    /*
     * Handing it a task directly.
     *
     * The other two sources cannot say WHICH CHECKOUT — a card never carries
     * one — so on a quiet day the loop correctly declines everything. This is
     * the queue he fills himself, and it is also the honest way to watch the
     * thing work for the first time: give it something small, read what came
     * back, decide whether to give it something bigger.
     */
    if (pathname === "/understudy/work/ask" && req.method === "POST") {
      if (!trustedCaller(req, from)) return csrfBlocked();
      let ab: { title?: string; detail?: string; repo?: string } = {};
      try { ab = await req.json() as typeof ab; } catch { return json({ ok: false, error: "invalid json" }, 400); }
      const title = String(ab.title ?? "").trim();
      const repo = String(ab.repo ?? "").trim();
      if (!title) return json({ ok: false, error: "what should it do?" }, 400);
      // The checkout is checked HERE rather than when the task is picked up: a
      // row naming somewhere out of scope is a disappointment scheduled for
      // later, and saying so now costs nothing.
      const allowed = await openProjectRepos();
      if (!allowed.includes(repo)) {
        return json({ ok: false, error: `it may only work in: ${allowed.join(", ") || "(nothing today)"}`, allowed }, 403);
      }
      // A second row with the same title in the same checkout is duplicate
      // work waiting to be worked twice, not a second instruction — refuse it
      // and say which row it already has, rather than writing another.
      const dupe = Sources.pendingDuplicate(title, repo);
      if (dupe) {
        return json({
          ok: false,
          error: `already queued as #${dupe} — same title, same checkout`,
          id: dupe,
        }, 409);
      }
      const id = Sources.ask({ title, detail: String(ab.detail ?? ""), repo });
      return id ? json({ ok: true, id, queued: Sources.asked() }) : json({ ok: false, error: "could not queue it" }, 500);
    }

    /*
     * Which project is the open one.
     *
     * It was a constant naming this application, which put one person's project
     * name into logic in a public repository and defined everything else as
     * "not that". Both halves are facts about one machine, not about the
     * software. The default is the checkout this server runs from, so nobody
     * has to set it — and pointing the loop elsewhere is now something somebody
     * does here rather than in a diff.
     */
    if (pathname === "/understudy/open-project" && req.method === "POST") {
      if (!trustedCaller(req, from)) return csrfBlocked();
      let ob: { name?: string } = {};
      try { ob = await req.json() as typeof ob; } catch { return json({ ok: false, error: "invalid json" }, 400); }
      /*
       * Refused with a reason rather than silently ignored. `you`, `code`
       * or `home` are segments of the path every repository on this machine
       * lives under, and the matcher is a segment test — so any of them puts
       * the whole disk inside the fence.
       */
      const asked = String(ob.name ?? "");
      // The known checkouts, so "the folder projects live in" is answered from
      // this machine rather than assumed to be $HOME.
      const known = knownProjects().map((p) => p.path);
      if (!openProjectNameAllowed(asked, known)) {
        return json({
          ok: false,
          error: `"${asked.slice(0, 40)}" would match every repository on this machine — name the project, not a folder above it`,
          openProject: openProjectName(),
        }, 400);
      }
      const name = setOpenProject(asked, known);
      return json({ ok: true, openProject: name, repos: await openProjectRepos() });
    }

    if (pathname === "/understudy/work/ask" && req.method === "GET") {
      /* Resolved once: the fence, the project list and the checkout list are
         three readings of the same discovery, and calling it three times is
         three filesystem walks for one answer. */
      const roots = await openProjectRepos();
      return json({
        ok: true,
        queued: Sources.asked(),
        allowed: roots,
        openProject: openProjectName(),
        /*
         * WHY THE LIST ABOVE IS EMPTY, when it is.
         *
         * The panel printed "It has nowhere to work, so it will decline every
         * task" and never said why — and this morning the why was that the app
         * had been relaunched by its own installer, so the server started
         * outside any checkout and discovery found nothing. The reply already
         * knew that; it just kept it to itself. Only asked when there is
         * nothing allowed: a reason for a working setup is noise.
         */
        reason: roots.length === 0
          ? nowhereReason({
              project: openProjectName(),
              here: repoRootOf(process.cwd()),
              known: knownProjects().map((p) => p.path),
            })
          : null,
        /*
         * THE PROJECTS THIS MACHINE HAS ACTUALLY SEEN, so the fence stops being
         * a bare text field.
         *
         * Asked, meeting that field: "what a crap way to pick another
         * project" — you typed a name with no list of what was valid, no
         * sense of what existed, and a name matching everything was refused by
         * a rule you could not see.
         *
         * Derived from the checkouts discovery already found: the last path
         * segment of each root, minus its worktree suffixes, deduplicated. Not
         * a filesystem scan — the same source the fence itself resolves
         * against, so nothing appears here that could not be chosen.
         */
        projects: (() => {
          const seen = new Map<string, number>();
          for (const root of roots) {
            const leaf = root.split("/").filter(Boolean).pop() ?? "";
            /* `agentglass-understudy` and `agentglass-unread` are checkouts OF
               `agentglass`; the fence names the project, not the worktree. */
            const name = leaf.split("-")[0] || leaf;
            if (name) seen.set(name, (seen.get(name) ?? 0) + 1);
          }
          return [...seen].map(([name, checkouts]) => ({ name, checkouts }));
        })(),
        /*
         * THE OTHER HALF OF THE FENCE, and it had no way of being read.
         *
         * `open-only` keeps the task-tracker sources silent; `everywhere` lets
         * them offer work. There was a route to SET it and none to ask, so the
         * switch that decides whether the clone reaches somebody's employer
         * could not be seen in the application at all — only changed with curl.
         * A fence whose position is invisible is one nobody can trust, and this
         * is the position people most want to check before walking away.
         */
        scope: proposeScope(),
      });
    }

    if (pathname === "/understudy/work/unask" && req.method === "POST") {
      if (!trustedCaller(req, from)) return csrfBlocked();
      let ub: { id?: number } = {};
      try { ub = await req.json() as typeof ub; } catch { return json({ ok: false, error: "invalid json" }, 400); }
      Sources.unask(Number(ub.id || 0));
      return json({ ok: true, queued: Sources.asked() });
    }

    /*
     * Keep working until there is nothing left.
     *
     * His actual sentence: "if we run out of work, look for more where we
     * usually look for it". The single-task route above is one step of this;
     * this is the loop, and it requires a running shift because a shift is the
     * thing that bounds how long and how much.
     *
     * `keepGoing` is asked FRESH each round rather than captured once — a shift
     * can be halted between two tasks and the loop has to find that out, which
     * is the difference between a stop button and a decoration.
     */
    if (pathname === "/understudy/work/loop" && req.method === "POST") {
      if (!trustedCaller(req, from)) return csrfBlocked();
      const started = await startWorkLoop();
      if (!started.ok) return json(started, 409);
      return json(started);
    }

    if (pathname === "/understudy/work/discard" && req.method === "POST") {
      if (!trustedCaller(req, from)) return csrfBlocked();
      let wb: { worktree?: string; repo?: string } = {};
      try { wb = await req.json() as typeof wb; } catch { return json({ ok: false, error: "invalid json" }, 400); }
      /*
       * ONLY A WORKTREE THIS SERVER CUT, and the path is checked against the
       * runs table rather than trusted.
       *
       * `discardRun` finishes with `rm(path, { recursive: true, force: true })`
       * and the path arrived in the request body. Nothing looked at it — so
       * any directory on the machine was a valid argument to a route whose
       * job is deleting one, and being same-origin was the only thing in the
       * way.
       *
       * The run also has to be finished. Deleting the worktree of a run still
       * in flight pulls the ground out from under an agent mid-edit, and the
       * row would go on claiming to be working in a directory that is gone.
       */
      const asked = String(wb.worktree ?? "");
      const owner = Work.runOwning(asked);
      if (!owner) return json({ ok: false, error: "not a worktree this made" }, 404);
      if (owner.state === "running") {
        return json({ ok: false, error: "that run is still going — stop it first" }, 409);
      }
      // Its own recorded repository, not one the caller supplies: the pair has
      // to be the pair this server wrote, or the check above proves nothing.
      /* Its branch goes with it, or the same task can never be cut again: the
         branch name is a hash of the item, so an orphan makes every future
         attempt fail with "already exists". `-d` inside refuses to delete work
         nobody merged. */
      const gone = await Loop.discardRun(owner.worktree, owner.repo, runGitIn, owner.branch);
      return json({ ok: gone });
    }

    if (pathname === "/understudy/shift/stop" && req.method === "POST") {
      if (!trustedCaller(req, from)) return csrfBlocked();
      const cur = Shift.current();
      if (!cur) return json({ ok: false, error: "nothing is running" }, 404);
      Shift.stop(cur.id, "you ended it", "done");
      return json({ ok: true, shift: Shift.recent(1)[0] ?? null });
    }
    /*
     * The judge's switch, on its own route like the propose scope — because
     * this one decides whether his material is sent to a model while he is not
     * watching, and that should be an act rather than a field riding along in
     * some larger body.
     */
    if (pathname === "/understudy/judge" && req.method === "POST") {
      if (!trustedCaller(req, from)) return csrfBlocked();
      let jb: { on?: boolean } = {};
      try { jb = await req.json() as typeof jb; } catch { return json({ ok: false, error: "invalid json" }, 400); }
      return json({ ok: true, enabled: setJudge(jb.on === true), available: JUDGE_AVAILABLE() });
    }
    if (pathname === "/understudy/propose-scope" && req.method === "POST") {
      if (!trustedCaller(req, from)) return csrfBlocked();
      let b: { scope?: string } = {};
      try { b = await req.json() as typeof b; } catch { return json({ ok: false, error: "invalid json" }, 400); }
      if (b.scope !== "open-only" && b.scope !== "everywhere") {
        return json({ ok: false, error: "open-only or everywhere" }, 400);
      }
      return json({ ok: true, scope: setProposeScope(b.scope) });
    }
    if (pathname === "/understudy/mode" && req.method === "POST") {
      if (!trustedCaller(req, from)) return csrfBlocked();
      let b: any = {};
      try { b = await req.json(); } catch { return json({ ok: false, error: "invalid json" }, 400); }
      // `setMode` refuses an unknown class, an unknown mode, and anything above
      // the v1 ceiling — including for a class whose lock says never. The route
      // reports the refusal and does not argue with it: in v1 the only mode it
      // can accept is `shadow`, and that is deliberate, not a gap.
      const ok = setMode(String(b.class || ""), b.mode);
      if (ok) broadcast({ type: "understudy", data: scorecard() });
      return json({ ok, ...(ok ? {} : { error: "the clone refused that mode — see UNDERSTUDY_CEILING" }) }, ok ? 200 : 400);
    }
    if (pathname === "/understudy/halt" && req.method === "POST") {
      if (!trustedCaller(req, from)) return csrfBlocked();
      // No body, no arguments, no confirmation. A stop that needs a well-formed
      // request is a stop that can fail to arrive.
      const dropped = halt();

      /*
       * HALT STOPS IT. What it already did is a worktree, not an act to undo.
       *
       * This used to unwind a table of reversible acts, and the safety seal it
       * answered read "halt mid-sequence puts everything back". That table has
       * never held a row, so the unwinding never ran — but the promise is not
       * missing, it moved: the work happens in a DISPOSABLE WORKTREE, and
       * putting everything back is removing a directory. That is why the agent
       * can be handed every tool in the first place.
       *
       * Which is also why halting does not delete anything here. A stopped run
       * leaves its worktree exactly where it is, because that directory is the
       * only copy of whatever it had done, and throwing it away is a decision
       * somebody makes after reading it — `/understudy/work/discard`.
       */
      const running = Shift.current();
      if (running) Shift.stop(running.id, "you halted it");

      broadcast({ type: "understudy", data: scorecard() });
      return json({ ok: true, dropped });
    }
    /*
     * Switching it on, and the one refusal that matters.
     *
     * Desktop-only, because turning on a thing that watches everything he does
     * is not a decision a page on the wifi gets to make for him.
     *
     * And a 409 when the server has no auth token, which reads like paranoia
     * and is not. `resolveToken` returns null on the zero-config loopback path;
     * with AUTH_TOKEN null the whole `if (AUTH_TOKEN && …)` block above never
     * runs, so `callerFor` is never called, no principal is ever resolved, and
     * `understudyAllows` — the entire fence around what the understudy may do —
     * is never consulted. Enabling it there would give it a limit that exists
     * only in a comment. Refusing is the only honest answer, and it is a 409
     * rather than a 403 because nothing about the request is wrong: the server
     * is in a state that cannot hold the promise.
     */
    if (pathname === "/understudy/enable" && req.method === "POST") {
      if (!desktopOnly(req)) return csrfBlocked();
      if (understudyRequiresToken(AUTH_TOKEN)) return json({ ok: false, error: UNDERSTUDY_NO_TOKEN_ERROR }, 409);
      let b: any = {};
      try { b = await req.json(); } catch { return json({ ok: false, error: "invalid json" }, 400); }
      setEnabled(b.on !== false);
      broadcast({ type: "understudy", data: scorecard() });
      return json({ ok: true, enabled: understudyEnabled() });
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
    /**
     * §16: "I only touched the local one", checkable rather than promised.
     * Every op that reached the relay in browserdrive.ts — refused by the
     * origin fence or read-only mode, or carried out and answered — with
     * secrets already taken out (see redactAsk/redactValue there).
     */
    if (pathname === "/browser/audit" && req.method === "GET") {
      if (!trustedCaller(req, from)) return csrfBlocked();
      return json({ ok: true, entries: exportAudit() });
    }
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
        const known = settleBrowser(b.id, {
          ok: b.ok === true, value: b.value, error: typeof b.error === "string" ? b.error : undefined,
          diagnosis: b.diagnosis,
        });
        return json({ ok: true, known });
      }
      if (op === "audit") {
        /* §16 built this list to prove what an agent touched; §12 wants the
           same list as a script somebody can run again. One read, two shapes. */
        let b: any = {};
        try { b = await req.json(); } catch { b = {}; }
        const parsed = parseAsk("audit", b);
        if ("error" in parsed) return json({ ok: false, error: parsed.error }, 400);
        /* §9's filters. `by` narrows to one caller and `tab` to one tab from
           EVERY caller, which is the question a cross-container mix-up
           actually needs answered. `as` is who is ASKING and filters nothing:
           the CLI stamps it on every request, so the day it doubled as the
           filter every `audit` came back scoped to its own caller. */
        const f = parsed.ask.args as { script?: boolean; by?: string; tab?: string };
        const entries = exportAudit({ as: f.by, tab: f.tab });
        return json(f.script
          ? { ok: true, value: { script: auditAsScript(entries), steps: entries.length } }
          : {
            ok: true,
            value: {
              entries,
              /* Said in the answer, not only in the docs: `as` is asserted by a
                 local CLI over a loopback endpoint whose only credential is one
                 machine-wide token every agent shell holds. Forensics between
                 cooperating agents, which is the real threat model — not
                 authentication, and never to be described as one. */
              note: "`as` is self-asserted by the caller over a loopback endpoint with one "
                + "machine-wide token: this is forensics between cooperating agents, not authentication.",
            },
          });
      }
      if (op === "record") {
        /* Answered here for the same reason as `events`: the loop belongs on
           the side that already holds the connection, and the frames belong on
           disk rather than in the reply. */
        let b: any = {};
        try { b = await req.json(); } catch { b = {}; }
        const parsed = parseAsk("record", b);
        if ("error" in parsed) return json({ ok: false, error: parsed.error }, 400);
        const a = parsed.ask.args as Record<string, unknown>;
        const shotArgs: Record<string, unknown> = {};
        /*
         * `page` TOO, and leaving it out is how a recording came back of a
         * different tab.
         *
         * Every frame is a `shot`, and this list is what a frame inherits. It
         * held the three that frame the picture and not the one that says WHICH
         * PAGE, so `record --page t12` parsed the id, dropped it here, and
         * photographed whatever the window had in front — for every frame.
         *
         * Measured by somebody using it: a recording asked for on a login page
         * came back as the app's own git view, and the md5 of the frame was
         * byte-identical to a capture of the ACTIVE tab. It is the worst shape
         * of failure this tool has, because the answer is indistinguishable
         * from a good one: "I recorded a navigation three times pinning --page to
         * an id I had just read, and the starting page came out every time".
         */
        for (const k of ["selector", "fullPage", "clip", "page", "as", "how", "pageExplicit"]) if (a[k] !== undefined) shotArgs[k] = a[k];
        const r = await recordFrames({
          frames: a.frames as number, everyMs: a.every as number,
          dir: a.dir as string, gif: a.gif as string | undefined, shotArgs,
        });
        return json(r);
      }
      if (op === "download") {
        /* §11: click something that starts a download and wait for the file —
           answered here for the same reason as `record`: the polling loop and
           the filesystem belong on the side that has both, not on the panel. */
        let b: any = {};
        try { b = await req.json(); } catch { b = {}; }
        const parsed = parseAsk("download", b);
        if ("error" in parsed) return json({ ok: false, error: parsed.error }, 400);
        const a = parsed.ask.args as { selector: string; dir: string; timeoutMs?: number };
        const r = await downloadFile({ selector: a.selector, dir: a.dir, timeoutMs: a.timeoutMs });
        return json(r);
      }
      if (op === "events") {
        /* Answered HERE, not by the panel: the whole point is a wait, and the
           server is the side already holding the connection — so the polling
           costs a loop here instead of a process start and a context entry per
           turn on the agent's side. */
        let b: any = {};
        try { b = await req.json(); } catch { b = {}; }
        const parsed = parseAsk("events", b);
        if ("error" in parsed) return json({ ok: false, error: parsed.error }, 400);
        const a = parsed.ask.args as { since?: number; wait?: number; kinds?: string[]; page?: string };
        const r = await waitForEvents({
          since: a.since ?? Date.now(),
          waitMs: (a.wait ?? 30) * 1000,
          kinds: a.kinds ?? [],
          /* THE CALLER'S TAB. `events` is not a tab op, so the CLI attaches
             the caller's page like every other verb — and this route dropped
             it, so all three kinds read whatever was in front. The `cdp` kind
             DRAINS what it reads, so an agent waiting on its own tab was
             emptying another agent's event buffer. */
          page: a.page,
        });
        return json(r);
      }
      if (op === "trace") {
        /* Trace recording: start/stop DevTools trace collection.
           For "stop", the trace path must be provided and the window
           will have already collected and saved the trace data. */
        let b: any = {};
        try { b = await req.json(); } catch { b = {}; }
        const parsed = parseAsk("trace", b);
        if ("error" in parsed) return json({ ok: false, error: parsed.error }, 400);
        const a = parsed.ask.args as { action: string; path?: string };
        if (a.action === "stop" && a.path) {
          const r = await traceRecording({ path: a.path });
          return json(r);
        }
        /* For "start", delegate to the window via askBrowser. */
        const reply = await askBrowser(parsed.ask);
        return json(reply, reply.ok ? 200 : 409);
      }
      if (op === "do") {
        /* Several verbs in one request — §1. The whole point is the round trip
           it does NOT make, so validation, guardrails and the §15 diagnosis of
           a failed step all happen inside `runSteps` rather than out here. */
        let b: any = {};
        try { b = await req.json(); } catch { return json({ ok: false, error: "invalid json" }, 400); }
        /* Several pages at once — §9. `lanes` instead of `steps`, and each
           lane names its page. Concurrent on purpose: sequencing them would
           make the watching page see the change already made, which is the
           thing being tested. */
        /* WHO IS ASKING RIDES ON THE OUTER BODY. The CLI stamps `as`, `how`
           and `pageExplicit` on the batch once, not on each step, and this
           route used to hand only the steps on — so every step reached the
           panel with a page and no name. The panel reads a missing `as` as
           "cannot tell" and allows (it has to: the MCP surface sends none),
           which made `do` the one verb the ownership check never saw. */
        const caller: Record<string, unknown> = {};
        for (const k of ["as", "how", "pageExplicit"]) if (b[k] !== undefined) caller[k] = b[k];
        if (Array.isArray(b.lanes)) {
          if (b.lanes.length === 0 || b.lanes.length > 8) {
            return json({ ok: false, error: "lanes takes 1 to 8 pages" }, 400);
          }
          for (const lane of b.lanes) {
            if (!lane || !Array.isArray(lane.steps) || lane.steps.length === 0) {
              return json({ ok: false, error: "every lane needs steps: [{op, args}, ...]" }, 400);
            }
          }
          const r = await runLanes(b.lanes, { observe: b.observe === true, caller });
          return json(r);
        }
        if (!Array.isArray(b.steps) || b.steps.length === 0) {
          return json({ ok: false, error: "do needs steps: [{op, args}, ...]" }, 400);
        }
        if (b.steps.length > 64) {
          return json({ ok: false, error: `do takes at most 64 steps, got ${b.steps.length}` }, 400);
        }
        const r = await runSteps(b.steps, {
          observe: b.observe === true,
          page: typeof b.page === "string" ? b.page : undefined,
          caller,
        });
        return json(r, r.ok ? 200 : 200);
      }
      let b: unknown = {};
      try { b = await req.json(); } catch { b = {}; }
      const parsed = parseAsk(op as BrowserOp, b);
      if ("error" in parsed) return json({ ok: false, error: parsed.error }, 400);
      const reply = await askBrowser(parsed.ask);
      /* §3: an action can hand back the page it left behind, under `after`.
         Opt-in, because an observation is the tree, the console and the
         network — attaching one to every click would put six in an agent's
         context for a five-step sequence where it wanted the last. */
      const answered = (b as { observe?: boolean })?.observe === true
        ? await withObservation(parsed.ask, reply)
        : reply;
      return json(answered, answered.ok ? 200 : 409);
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
      /*
       * And accepting is the HUMAN half of pairing, so a bare machine token is
       * not enough to complete it.
       *
       * This is the door that made the gate fix worse than the bug it fixed.
       * An agent holding the machine token — which it does, the file is
       * readable by anything running as the user — could drive the whole
       * ceremony itself: ask for a ticket, accept its own ticket, and mint a
       * device with any label it liked. It then released its own held call
       * through the device branch, needing no Origin at all, and the audit line
       * read as a named phone somebody had once approved. A log that invents a
       * human is worse than one that cannot tell you which machine it was.
       *
       * `mayReleaseAHold` is deliberately the same test: consenting to a new
       * device on your account and consenting to a held command are the same
       * kind of act, and neither is something the held party gets to do.
       */
      if (!mayReleaseAHold(req, caller)) return heldPartyBlocked();
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

    /**
     * --- plugins: install / manifest / review / enable ---
     *
     * docs/PLUGINS.md. No plugin code runs from install; a plugin
     * only starts as its own process, holding a token scoped to what its
     * manifest declared and a human then approved. GET is a read (the
     * global gate already requires `read`); every write below is unlisted
     * in ANSWER_POST/READ_POST so the same gate already requires `full` —
     * installing, enabling, disabling and removing a plugin is exactly as
     * privileged as git write or docker control, which is what it is.
     */
    if (pathname === "/plugins" && req.method === "GET") {
      return json({ master: masterEnabled(), plugins: listPlugins() });
    }

    if (pathname === "/plugins/master" && req.method === "POST") {
      if (!trustedCaller(req, from)) return csrfBlocked();
      let b: { enabled?: unknown };
      try { b = (await req.json()) as { enabled?: unknown }; } catch { return json({ ok: false, error: "invalid json" }, 400); }
      if (typeof b.enabled !== "boolean") return json({ ok: false, error: "enabled must be a boolean" }, 400);
      await setMaster(b.enabled);
      return json({ ok: true, master: b.enabled });
    }

    if (pathname === "/plugins/install" && req.method === "POST") {
      if (!trustedCaller(req, from)) return csrfBlocked();
      let b: { source?: unknown; kind?: unknown; url?: unknown; path?: unknown; ref?: unknown };
      try { b = (await req.json()) as typeof b; } catch { return json({ ok: false, error: "invalid json" }, 400); }
      // Either the back-compat bare string, or a typed request naming its
      // own kind explicitly (a git install with a ref pinned, in practice).
      const input = b.kind === "git" || b.kind === "local-path"
        ? (b as { kind: "git" | "local-path"; url?: unknown; path?: unknown; ref?: unknown })
        : b.source;
      const r = await installPlugin(input as never);
      return json(r, r.ok ? 200 : 400);
    }

    if (pathname === "/plugins/catalogue" && req.method === "GET") {
      const catalogueUrl = url.searchParams.get("url");
      if (!catalogueUrl) return json({ ok: false, error: "url is required" }, 400);
      const r = await fetchCatalogue(catalogueUrl);
      return json(r, r.ok ? 200 : 400);
    }

    /**
     * The catalogues he has added, kept as a plain list of URLs — GET is a
     * read; adding and removing one are writes at the same level as
     * installing a plugin, so they go through the same trusted-caller check.
     * Browsing a catalogue (above) never adds it: that stays a separate,
     * explicit step, the same distinction viewing a repo has from starring it.
     */
    if (pathname === "/plugins/catalogues" && req.method === "GET") {
      return json({ catalogues: listCatalogues() });
    }
    if (pathname === "/plugins/catalogues/add" && req.method === "POST") {
      if (!trustedCaller(req, from)) return csrfBlocked();
      let b: { url?: unknown };
      try { b = (await req.json()) as { url?: unknown }; } catch { return json({ ok: false, error: "invalid json" }, 400); }
      if (typeof b.url !== "string" || !b.url.trim()) return json({ ok: false, error: "url is required" }, 400);
      const r = addCatalogue(b.url);
      return json(r, r.ok ? 200 : 400);
    }
    if (pathname === "/plugins/catalogues/remove" && req.method === "POST") {
      if (!trustedCaller(req, from)) return csrfBlocked();
      let b: { url?: unknown };
      try { b = (await req.json()) as { url?: unknown }; } catch { return json({ ok: false, error: "invalid json" }, 400); }
      if (typeof b.url !== "string" || !b.url.trim()) return json({ ok: false, error: "url is required" }, 400);
      return json({ ok: removeCatalogue(b.url) });
    }

    if (pathname === "/plugins/install-from-catalogue" && req.method === "POST") {
      if (!trustedCaller(req, from)) return csrfBlocked();
      let b: { catalogueUrl?: unknown; pluginId?: unknown };
      try { b = (await req.json()) as typeof b; } catch { return json({ ok: false, error: "invalid json" }, 400); }
      if (typeof b.catalogueUrl !== "string" || !b.catalogueUrl.trim()) return json({ ok: false, error: "catalogueUrl is required" }, 400);
      if (typeof b.pluginId !== "string" || !b.pluginId.trim()) return json({ ok: false, error: "pluginId is required" }, 400);
      const r = await installFromCatalogue(b.catalogueUrl, b.pluginId);
      return json(r, r.ok ? 200 : 400);
    }

    if (pathname === "/plugins/update" && req.method === "POST") {
      if (!trustedCaller(req, from)) return csrfBlocked();
      let b: { name?: unknown };
      try { b = (await req.json()) as { name?: unknown }; } catch { return json({ ok: false, error: "invalid json" }, 400); }
      if (typeof b.name !== "string" || !b.name) return json({ ok: false, error: "name is required" }, 400);
      const r = await updatePlugin(b.name);
      return json(r, r.ok ? 200 : 400);
    }

    if (pathname === "/plugins/enable" && req.method === "POST") {
      if (!trustedCaller(req, from)) return csrfBlocked();
      let b: { name?: unknown };
      try { b = (await req.json()) as { name?: unknown }; } catch { return json({ ok: false, error: "invalid json" }, 400); }
      if (typeof b.name !== "string" || !b.name) return json({ ok: false, error: "name is required" }, 400);
      const r = await enablePlugin(b.name);
      return json(r, r.ok ? 200 : 400);
    }

    if (pathname === "/plugins/disable" && req.method === "POST") {
      if (!trustedCaller(req, from)) return csrfBlocked();
      let b: { name?: unknown };
      try { b = (await req.json()) as { name?: unknown }; } catch { return json({ ok: false, error: "invalid json" }, 400); }
      if (typeof b.name !== "string" || !b.name) return json({ ok: false, error: "name is required" }, 400);
      const ok = await disablePlugin(b.name);
      return json({ ok }, ok ? 200 : 404);
    }

    if (pathname === "/plugins/remove" && req.method === "POST") {
      if (!trustedCaller(req, from)) return csrfBlocked();
      let b: { name?: unknown };
      try { b = (await req.json()) as { name?: unknown }; } catch { return json({ ok: false, error: "invalid json" }, 400); }
      if (typeof b.name !== "string" || !b.name) return json({ ok: false, error: "name is required" }, 400);
      const ok = await removePlugin(b.name);
      return json({ ok }, ok ? 200 : 404);
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
      /*
       * C2 is seamed HERE as well as on the family chokepoint, and that is not
       * a duplicate.
       *
       * `/git/commit` is not inside the `/git/*` switch — it is its own handler
       * several hundred lines above it, and it carries no `noteAction` either.
       * It is also the route the commit box in the Diff view actually calls, so
       * a class hung only on the chokepoint would have recorded nothing at all
       * for the commits he makes, while looking fully instrumented.
       */
      noteClass(pathname, b, res.ok !== false);
      return json(res, res.ok ? 200 : 400);
    }
    if (pathname === "/git/amend" && req.method === "POST") {
      if (!trustedCaller(req, from)) return csrfBlocked();
      let b: any = {};
      try { b = await req.json(); } catch { return json({ ok: false, error: "invalid json" }, 400); }
      const res = gitAmend(String(b.root || ""), Array.isArray(b.files) ? b.files : [], String(b.title || ""), String(b.body || ""));
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
    /*
     * The rebuilt Diff view, in two halves.
     *
     * `/git/changes-v2` is the LIST: one row per changed file, with no diff text
     * in it. That is the whole design — measured on this machine, the endpoint it
     * replaces sent 1.1 MB every four seconds and 89% of it was the diff of files
     * nobody had opened. Rows carry a stable key, the real time the file changed,
     * and computed `ignored`/`outside` flags rather than asserted ones.
     *
     * `/git/file-diff` is the BODY: the diff of the one file the reader opened.
     */
    if (pathname === "/git/changes-v2") {
      const mode = url.searchParams.get("mode") === "committed" ? "committed" : "working";
      return body(await singleFlight(`rows:${mode}`, async () => {
        const cached = rowsCache.get(mode);
        if (cached && Date.now() - cached.at < ROWS_TTL_MS) return cached.body;
        const paths = getChanges(300).map((c) => c.file_path);
        /* Every in-scope checkout, INCLUDING one on main or master. The old
           endpoint dropped those on the grounds that trunk is the base you cut
           from — true of a branch-vs-base diff, false of "what have I changed
           and not committed", and it left anyone whose project has a single
           trunk checkout looking at a permanently empty view. */
        const repos = await discoverRepos(paths, knownProjects().map((p) => p.path), {});
        const scope = workspaceRoot();
        const out = JSON.stringify(await changeRows(repos, mode, scope, ROWS_MAX));
        rowsCache.set(mode, { at: Date.now(), body: out });
        return out;
      }));
    }
    if (pathname === "/git/file-diff") {
      const root = url.searchParams.get("root") || "";
      const path = url.searchParams.get("path") || "";
      const mode = url.searchParams.get("mode") === "committed" ? "committed" : "working";
      if (!root || !path) return json({ error: "root and path are required" }, 400);
      // The same scope gate every other git route uses: a root off the wire is
      // not a licence to read any repo on the disk.
      if (!inScope(root)) return json({ error: "out of scope" }, 403);
      const d = await fileDiff(root, path, mode);
      /* Keyed on content, so re-selecting a file the reader has already opened
         costs a 304 rather than another diff. `sig` is mtime+size while
         uncommitted and the commit hash once committed — never a timestamp of
         the request, which is what made the old view's caching a coin toss. */
      const tag = `"${d.sig}"`;
      if (d.sig && req.headers.get("if-none-match") === tag) {
        return new Response(null, { status: 304, headers: { ETag: tag, ...cors } });
      }
      return new Response(JSON.stringify(d), {
        headers: { "content-type": "application/json", ...cors, ...(d.sig ? { ETag: tag, "Cache-Control": "no-cache" } : {}) },
      });
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
    /*
     * The agent sessions this project has, whichever checkout they ran in.
     *
     * What the terminal's resume picker draws. Read from disk — the same files
     * `/resume` reads — so the two lists cannot disagree; see agentsessions.ts
     * for why that matters more than reading this app's own database.
     */
    if (pathname === "/agent/sessions") {
      // Folded to the repository the path belongs to, so asking from a worktree
      // returns the whole family rather than that one checkout — which is the
      // point of the picker.
      const asked = url.searchParams.get("root") || "";
      const root = repoRootOf(asked) ?? asked;
      const rows = await sessionsForProject(root);
      /*
       * And which of them are already running, and where.
       *
       * A session open in a pane is not one to resume — resuming it twice is
       * two agents appending to one transcript. The picker needs to say so and
       * offer the trip instead, so the same join the phone's pane list uses is
       * applied here: the live pane list, plus the note a hook wrote when the
       * agent last ran. A note pointing at a pane that has since closed drops
       * out with the list rather than becoming a button that goes nowhere.
       */
      const live = listPanes(lastTmuxTarget()?.socket).map(({ socket: _s, ...p }) => p);
      /*
       * A note is only believed while the agent it was written for is STILL the
       * one in that pane — `paneDirs` has applied this rule for a while and this
       * route skipped it, at a cost: tmux reuses pane ids, so a note from a
       * session that ended yesterday named a pane holding somebody's shell
       * today. Pressed, it took the desk to a `fish` prompt in another session
       * and the tab strip came back showing that session's windows, which reads
       * exactly like the two tabs you had open having vanished.
       *
       * The test is the directory: the pane has to have an agent running in the
       * one the note recorded.
       */
      const agentsAt = new Map(live.map((p) => [p.paneId, p.agentCwds ?? []]));
      const where = new Map<string, (typeof live)[number] & { agentSession: string | null }>();
      for (const p of withAgentSessions(live, (id) => {
        const n = paneAgentNote(id);
        if (!n || !(agentsAt.get(id) ?? []).includes(n.cwd)) return null;
        return { sessionId: n.session_id, at: n.at };
      })) if (p.agentSession) where.set(p.agentSession, p);
      const sessions: AgentSessionRow[] = rows.map((r) => {
        const p = where.get(r.id);
        // And the pane and the session have to agree about where they are. Two
        // cheap facts pointing the same way is what makes this a place to send
        // somebody rather than a guess.
        const sure = p && (agentsAt.get(p.paneId) ?? []).includes(r.cwd);
        return sure && p
          ? { ...r, openIn: { session: p.session, sessionId: p.sessionId, windowId: p.windowId, windowIndex: p.windowIndex, windowName: p.windowName, paneId: p.paneId } }
          : r;
      });
      return json({ ok: true, sessions });
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
    if (pathname === "/git/refs") return json(refs(url.searchParams.get("root") || ""));
    if (pathname === "/git/snapshots") return json(listSnapshots(url.searchParams.get("root") || ""));
    if (pathname === "/git/stashes") return json({ stashes: stashList(url.searchParams.get("root") || "") });
    if (pathname === "/git/submodules") return json({ submodules: gitSubmodules(url.searchParams.get("root") || "") });
    if (pathname === "/git/blame") return json(blameFile(url.searchParams.get("root") || "", url.searchParams.get("path") || "", url.searchParams.get("ref") || ""));
    if (pathname === "/git/file-history") return json(fileHistory(url.searchParams.get("root") || "", url.searchParams.get("path") || ""));
    if (pathname === "/git/bisect-status") return json(bisectStatus(url.searchParams.get("root") || ""));
    if (pathname === "/git/search-commits") return json(searchCommits(url.searchParams.get("root") || "", url.searchParams.get("q") || "", url.searchParams.get("author") || undefined, url.searchParams.get("since") || undefined));
    if (pathname === "/git/grep") {
      const p = url.searchParams;
      return json(grepWorkingTree(p.get("root") || "", p.get("q") || "", {
        caseSensitive: p.get("caseSensitive") === "1",
        wholeWord: p.get("wholeWord") === "1",
        regex: p.get("regex") === "1",
      }));
    }
    if (pathname === "/git/pickaxe") return json(searchHistory(url.searchParams.get("root") || "", url.searchParams.get("q") || "", url.searchParams.get("type") || "S"));
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
    // Repo analytics and the changelog — async log walks, never on the loop.
    if (pathname === "/git/stats") return json(await repoStats(url.searchParams.get("root") || "", Number(url.searchParams.get("days") || 30)));
    if (pathname === "/git/changelog") return json(await generateChangelog(url.searchParams.get("root") || "", url.searchParams.get("from") || "", url.searchParams.get("to") || ""));
    // Carry the cockpit's palette out to tmux and nvim — see themesync.ts.
    if (pathname === "/editor/capability") return json(editorCapability());
    /* Where the cursor is, in an editor this server started.
       The id is opaque and ours — a socket path from a client would be a way to
       talk to any nvim on the machine. Every failure is "no idea", which is
       what the rail behaves like when nothing can be asked. */
    if (pathname === "/editor/where") {
      const r = await editorCursor(url.searchParams.get("id") || "");
      return json(r);
    }
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
      if (stopped) { noteAction(clientIp, pathname, b, stopped, asActor(caller)); return json(stopped, 400); }
      let res;
      switch (pathname) {
        case "/git/stage": res = stage(root, paths); break;
        case "/git/unstage": res = unstage(root, paths); break;
        case "/git/stage-all": res = stageAll(root); break;
        case "/git/unstage-all": res = unstageAll(root); break;
        case "/git/discard": res = discard(root, paths); break;
        case "/git/commit-staged": res = commitStaged(root, String(b.title || ""), String(b.body || "")); break;
        case "/git/push": res = gitPush(root, { force: b.force === true }); break;
        case "/git/pull": res = gitPull(root); break;
        case "/git/fetch": res = gitFetch(root); break;
        case "/git/checkout": res = gitCheckout(root, String(b.name || "")); break;
        case "/git/branch-create": res = createBranch(root, String(b.name || "")); break;
        case "/git/branch-delete": res = deleteBranch(root, String(b.name || ""), !!b.force); break;
        case "/git/stash-push": res = stashPush(root, String(b.message || "")); break;
        case "/git/stash-apply": res = stashApply(root, Number(b.index)); break;
        case "/git/stash-pop": res = stashPop(root, Number(b.index)); break;
        case "/git/stash-drop": res = stashDrop(root, Number(b.index)); break;
        case "/git/stash-rename": res = stashRename(root, b.index, b.message); break;
        case "/git/stash-to-branch": res = stashToBranch(root, b.index, b.branch); break;
        case "/git/stash-partial": res = stashPartial(root, b.paths, b.keepIndex === true); break;
        case "/git/stash-apply-overwrite": res = stashApplyOverwrite(root, Number(b.index)); break;
        case "/git/apply-hunk": res = applyHunk(root, b.path, !!b.staged, b.action, b.hunk); break;
        case "/git/merge": res = mergeBranch(root, String(b.name || "")); break;
        case "/git/rebase": res = rebaseBranch(root, String(b.name || "")); break;
        case "/git/branch-rename": res = renameBranch(root, String(b.name || ""), String(b.to || "")); break;
        case "/git/reset": res = resetTo(root, String(b.ref || ""), b.mode, b.force === true); break;
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
        case "/git/cherry-pick": res = cherryPick(root, b.hashes, b.noCommit); break;
        case "/git/cherry-pick-continue": res = cherryPickContinue(root); break;
        case "/git/cherry-pick-abort": res = cherryPickAbort(root); break;
        case "/git/revert": res = revertCommit(root, b.hash); break;
        case "/git/amend-staged": res = amendCommit(root, b.title, b.body); break;
        case "/git/squash": res = squashCommits(root, b.oldest, b.newest); break;
        case "/git/rebase-steps": res = rebaseSteps(root, b.base); break;
        case "/git/rebase-run": res = runRebase(root, b.base, b.steps); break;
        case "/git/compare": res = compareRefs(root, b.base, b.other); break;
        case "/git/snapshot-create": res = createSnapshot(root, b.label); break;
        case "/git/snapshot-restore": res = restoreSnapshot(root, b.sha); break;
        case "/git/snapshot-delete": res = deleteSnapshot(root, b.sha); break;
        case "/git/protected-branches": res = protectedBranches(root); break;
        case "/git/protected-branches-set": res = setProtectedBranches(root, b.names); break;
        case "/git/submodule-add": res = submoduleAdd(root, b.url, b.path); break;
        case "/git/submodule-update": res = await submoduleUpdate(root, b.path); break;
        case "/git/submodule-sync": res = submoduleSync(root, b.path); break;
        case "/git/submodule-deinit": res = submoduleDeinit(root, b.path); break;
        case "/git/submodule-remove": res = submoduleRemove(root, b.path); break;
        case "/git/bisect-start": res = bisectStart(root, b.bad, b.good); break;
        case "/git/bisect-mark": res = bisectMark(root, b.mark); break;
        case "/git/bisect-reset": res = bisectReset(root); break;
        case "/git/tag-create": res = createTag(root, b.name, { annotated: b.annotated === true, message: b.message, signed: b.signed === true, target: b.target }); break;
        case "/git/tag-delete": res = deleteTag(root, b.name); break;
        case "/git/tag-push": res = pushTag(root, b.name, b.remote); break;
        case "/git/tag-delete-remote": res = deleteRemoteTag(root, b.name, b.remote); break;
        default: res = null;
      }
      // Every write through this switch is recorded — see actions.ts for why
      // it keeps the small ones too.
      // The understudy's seam sits on its own line above the audit line rather
      // than inside it: action-log.test.ts counts those one-liners.
      if (res) noteClass(pathname, b, res.ok !== false);
      if (res) { noteAction(clientIp, pathname, b, res, asActor(caller)); return json(res, res.ok ? 200 : 400); }
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

    // --- runs ---
    /* One prompt, several checkouts, tracked as one thing — including the legs
       this app never started. See runs.ts for why adoption is the half worth
       building and fan-out is not. */
    if (pathname === "/runs") return json({ runs: currentRuns(url.searchParams.get("root") || undefined) });
    /* What each leg has produced, grouped by the directories the legs ran in.
       Its own route rather than a field on the list: it is a database query per
       run, and the list is what a panel paints first. */
    if (pathname === "/run/activity") {
      const run = runById(url.searchParams.get("id"));
      if (!run) return json({ ok: false, error: "no such run" }, 404);
      return json({ ok: true, run, legs: runActivity(run) });
    }

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
    /* The "Review with Claude" menu. Read is open — it is a list of titles and
       prose. Writes go through `saveReviewRecipe`, which is where a title, a
       body and a skill line are checked; nothing here runs anything, the same
       way /recipes does not run a recipe. */
    /* The sentences somebody writes over and over on other people's pull requests —
       see savedReplies.ts. Same shape as the prompt catalogue above it, and stored the
       same way, because it is the same kind of thing. */
    if (pathname === "/saved-replies") {
      const { savedReplies } = await import("./savedReplies.ts");
      return json({ ok: true, replies: savedReplies() });
    }
    if (pathname.startsWith("/saved-replies/") && req.method === "POST") {
      if (!trustedCaller(req, from)) return csrfBlocked();
      const { putSavedReply, removeSavedReply } = await import("./savedReplies.ts");
      const b = await req.json().catch(() => ({})) as Record<string, unknown>;
      const r = pathname === "/saved-replies/save" ? putSavedReply(b)
        : pathname === "/saved-replies/remove" ? removeSavedReply(b.id)
        : null;
      if (!r) return json({ ok: false, error: "not found" }, 404);
      return json(r, r.ok ? 200 : 400);
    }
    if (pathname === "/pr-prompts") {
      const { reviewRecipes } = await import("./reviewPrompts.ts");
      return json({ ok: true, recipes: reviewRecipes() });
    }
    if (pathname.startsWith("/pr-prompts/") && req.method === "POST") {
      if (!trustedCaller(req, from)) return csrfBlocked();
      const { saveReviewRecipe, removeReviewRecipe, resetReviewRecipe } = await import("./reviewPrompts.ts");
      const b = await req.json().catch(() => ({})) as Record<string, unknown>;
      const r = pathname === "/pr-prompts/save" ? saveReviewRecipe(b as never)
        : pathname === "/pr-prompts/remove" ? removeReviewRecipe(String(b.id ?? ""))
        : pathname === "/pr-prompts/reset" ? resetReviewRecipe(String(b.id ?? ""))
        : null;
      if (!r) return json({ ok: false, error: "not found" }, 404);
      return json(r, r.ok ? 200 : 400);
    }
    /*
     * Which card a mirrored ClickUp notification is about.
     *
     * ClickUp's desktop app posts the task's title and the sentence that
     * happened to it — no id, no url — and a D-Bus monitor cannot invoke the
     * notification's own action to ask. So the row behind the bell could only
     * ever offer ClickUp's website, and the board this app already has was one
     * click further away than the browser.
     *
     * Answered from the watcher's own file, so this costs no ClickUp call and
     * cannot fail with a rate limit.
     */
    /*
     * File a mirrored notification against its card, from the window that has
     * it on screen.
     *
     * The server subscribes to the mirror itself, so this is not the usual
     * path — it is the catch-up for notifications that arrived BEFORE this
     * existed and are still in the panel's own list, and for a window that saw
     * one while the server was restarting. Same id, same row: filing one twice
     * changes nothing.
     */
    if (pathname === "/clickup/card-note" && req.method === "POST") {
      if (!trustedCaller(req, from)) return csrfBlocked();
      const b = await req.json().catch(() => ({})) as Record<string, unknown>;
      /* Capped here and again in rememberNote: same reasoning as /agents/status
         above — a free-text field with no cap under a 32 MB body limit is a
         row of that size, written by any local page that can reach this. */
      const text = (v: unknown, cap: number) => String(v ?? "").slice(0, cap);
      CardIndex.rememberNote({
        id: text(b.id, 200), cardId: text(b.cardId, 64), label: text(b.label, 512),
        text: text(b.text, 4096), at: Number(b.at) || Date.now(),
      });
      return json({ ok: true });
    }
    if (pathname === "/clickup/card-for-note") {
      return json({ card: cardForTitle(url.searchParams.get("title") || "") });
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
      /* A folder is stored, its contents are not — so this is where they get
         re-read. In the background and on a long fuse: the answer on screen is
         the last one ClickUp agreed to, a list appearing a few minutes late is
         nobody's problem, and the sidebar must not wait on a request to draw
         the tree it already has. */
      void refreshFoldersIfStale();
      return json({ views: savedViews(), folders: savedFolders(), connected: hasCredential("clickup"), current: currentView(), prefix: knownCardPrefix(), writeEnabled: clickupWriteEnabled(), writeForced: process.env.AGENTGLASS_CLICKUP_WRITE === "1" });
    }
    /* The folder picker's two reads. Spaces first, then one call per space that
       answers with its folders AND the lists inside each of them — which is why
       adding a folder costs nothing beyond what the picker already spent. */
    if (pathname === "/clickup/spaces") {
      const { clickupSpaces } = await import("./clickup.ts");
      const r = await clickupSpaces();
      return json(r.ok ? { ok: true, spaces: r.data?.spaces ?? [] } : { ok: false, error: r.error });
    }
    /* The tabs a list has in ClickUp, for the sidebar to hang under it. Read on
       demand — one call, and only for a list somebody actually opened. */
    /*
     * A VIDEO ATTACHMENT, served so a browser will actually play it.
     *
     * The tracker's own host sends `content-disposition: attachment` on every
     * file it hands out. That header means "this is a download" — so a <video>
     * pointed at it fails before it ever looks at the bytes, whatever they
     * are. Measured, after two wrong guesses: the host DOES answer range
     * requests (206), and the file IS avc1/H.264, which this browser plays
     * without complaint. It was the header the whole time.
     *
     * So this passes the bytes through with that header removed, `video/mp4`
     * in its place — Chromium refuses `video/quicktime` even when the stream
     * inside it is one it can decode — and the Range header forwarded, so
     * seeking still works and nothing has to be downloaded whole.
     *
     * ONLY urls this server has already handed out. The id is looked up in the
     * attachments we cached for a card; a caller cannot name an address of its
     * own. Otherwise this is a hole that fetches any URL on the internet with
     * the app's own network position.
     *
     * AND ONLY THE TRACKER'S OWN HOSTS, checked at every hop. The url in that
     * table is whatever the tracker's API returned for the attachment — a
     * remote system's word, not this server's — and it was fetched with no
     * host check, no redirect check and no timeout. A poisoned attachment
     * record pointing at a LAN address, or a redirect to one, was proxied as
     * "the video". The hosts named here are the two the CSP already trusts for
     * pictures (shared/csp.ts): `*.clickup.com` and the attachment CDN
     * `*.clickup-attachments.com`. Ten seconds to first byte, then the stream
     * is the browser's to abandon.
     */
    if (pathname === "/clickup/file") {
      const { attachmentUrl } = await import("./providers.ts");
      const src = attachmentUrl(url.searchParams.get("id") || "");
      if (!src) return json({ ok: false, error: "not a file this app has offered" }, 404);
      const range = req.headers.get("range");
      const got = await guardedFetch(src, { headers: range ? { Range: range } : {}, signal: AbortSignal.timeout(10_000) }, attachmentHostError);
      if (!got.res) return json({ ok: false, error: `attachment refused: ${got.error}` }, 502);
      const upstream = got.res;
      const head = new Headers();
      /* `video/mp4` rather than what the origin said: the container is
         QuickTime and the stream inside it is H.264, and Chromium decides on
         the label rather than on the stream. */
      head.set("content-type", "video/mp4");
      head.set("accept-ranges", "bytes");
      for (const k of ["content-length", "content-range", "etag", "last-modified"]) {
        const v = upstream.headers.get(k);
        if (v) head.set(k, v);
      }
      /* Deliberately NOT content-disposition. That is the whole fix. */
      return new Response(upstream.body, { status: upstream.status, headers: head });
    }

    if (pathname === "/clickup/list-views") {
      const { listViews } = await import("./clickup.ts");
      const { secretFor } = await import("./credentials.ts");
      const token = secretFor("clickup");
      if (!token) return json({ ok: false, error: "ClickUp is not connected" });
      const listId = url.searchParams.get("list") || "";
      const r = await listViews(token, listId);
      /* Remembered here rather than trusted from the client later: opening one
         of these views is a read of a board, and the id has to be one WE
         offered rather than any string a caller sends. */
      if (r.ok) (await import("./providers.ts")).rememberListViews(listId, r.data?.views ?? []);
      return json(r.ok ? { ok: true, views: r.data?.views ?? [], links: r.data?.links ?? [] } : { ok: false, error: r.error });
    }
    if (pathname === "/clickup/folders") {
      const { clickupFolders } = await import("./clickup.ts");
      const r = await clickupFolders(url.searchParams.get("space") || "");
      return json(r.ok ? { ok: true, folders: r.data?.folders ?? [] } : { ok: false, error: r.error });
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
    /* Whether the agent here can post to Slack. A route rather than a build-time
       constant: somebody connects the integration without restarting agentglass,
       and a button that stays hidden until the next launch reads as broken. */
    if (pathname === "/notify/reach") {
      return json({ ok: true, slack: slackReachable() });
    }
    /*
     * Text search, which ClickUp's API does not have.
     *
     * A GET with the query in it, and slow on purpose the first time: see
     * searchTasks for the measurement that shapes it. The panel warns before it
     * fires this, because sixteen seconds without a word is a broken search box.
     */
    /*
     * The same search, streamed as it goes.
     *
     * "at least show me what it finds as it goes, no?" — the sweep is
     * three sequential pages of a workspace with thousands of cards, and
     * answering only at the end is a spinner where a filling list should be.
     * One JSON object per line: the rows found so far, then a last line with
     * what was scanned. A reader that cannot parse a line ignores it; a client
     * that goes away aborts the request and the sweep's own cache keeps
     * whatever it had read.
     */
    /* Start reading the expensive half of the search now, so the first one is
       not the one that pays for it. Answers immediately; the work is not
       awaited and a failure is not reported — see warmBodySweep. */
    if (pathname === "/clickup/warm") {
      warmBodySweep();
      return json({ ok: true });
    }
    if (pathname === "/clickup/search/stream") {
      const q = url.searchParams.get("q") ?? "";
      const force = url.searchParams.get("force") === "1";
      const stream = new ReadableStream<Uint8Array>({
        async start(ctrl) {
          const enc = new TextEncoder();
          const line = (o: unknown) => { try { ctrl.enqueue(enc.encode(`${JSON.stringify(o)}\n`)); } catch { /* gone */ } };
          const r = await searchTasksStream(q, force, (tasks) => line({ tasks }));
          line(r.ok
            /* `partial` on the closing line: a sweep that lost a page answers
               with fewer cards and no other sign of it, and the panel has to
               be able to say "this is not all of them". */
            ? {
              done: true, scanned: r.data?.scanned ?? 0, refs: r.data?.refs ?? 0,
              partial: r.data?.partial === true,
              /* The window in TIME, and whether the sweep stopped at its cap.
                 A card count cannot answer "did it look at last week". */
              since: r.data?.since, capped: r.data?.capped === true,
            }
            : { done: true, error: r.error });
          try { ctrl.close(); } catch { /* already closed */ }
        },
      });
      return new Response(stream, { headers: { "content-type": "application/x-ndjson", "cache-control": "no-store" } });
    }
    if (pathname === "/clickup/search") {
      const q = url.searchParams.get("q") ?? "";
      const force = url.searchParams.get("force") === "1";
      const r = await searchTasks(q, force);
      return json(r.ok ? { ok: true, ...r.data } : { ok: false, error: r.error }, r.ok ? 200 : 400);
    }
    // The sprints this card could move to. A GET because it reads, and behind
    // the card's own id because a sprint is a list in the CARD's space — there
    // is no workspace-wide answer to ask for.
    if (pathname === "/clickup/sprints") {
      const r = await sprintLists(url.searchParams.get("id") ?? "");
      return json(r.ok ? { ok: true, ...r.data } : { ok: false, error: r.error, unauthorised: r.unauthorised }, r.ok ? 200 : 400);
    }
    if (pathname === "/clickup/task") {
      const r = await taskDetail(url.searchParams.get("id") ?? "");
      /* Remembered so `/clickup/file` can serve one back. A proxy that fetches
         whatever a caller names is a hole; this can only fetch what it has
         already offered. */
      if (r.ok && r.data?.attachments?.length) {
        (await import("./providers.ts")).rememberFiles(r.data.attachments);
      }
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
      const r = pathname === "/clickup/folders/add" ? await addClickupFolder(String(b.id ?? ""), String(b.spaceName ?? ""))
        : pathname === "/clickup/folders/remove" ? (removeFolder(String(b.id ?? "")), { ok: true })
        : pathname === "/clickup/views/add" ? await addViewByUrl(String(b.url ?? ""))
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
        // The flag, ClickUp's own field. `null` clears it, which is why the
        // body is read as "absent means none" rather than defaulted to a name.
        : pathname === "/clickup/priority" ? await setPriority(id, b.priority == null ? null : String(b.priority), seen)
        : pathname === "/clickup/field" ? await setField(id, String(b.field ?? ""), String(b.value ?? ""), String(b.kind ?? "drop_down"))
        // A note on the card's activity. No `updated` guard: a comment adds to
        // the history rather than overwriting anybody's field, so a card that
        // moved underneath is not a reason to refuse this one.
        : pathname === "/clickup/comment"
          ? await commentOn(id, String(b.text ?? ""), b.assignee != null ? Number(b.assignee) : undefined)
        // The card's own fields, all in one write. Absent means "leave it";
        // `null` means "clear it" — and the difference matters, because a due
        // date somebody set by mistake has to be removable.
        : pathname === "/clickup/task"
          ? await updateTask(id, {
            name: b.name != null ? String(b.name) : undefined,
            description: b.description != null ? String(b.description) : undefined,
            due: "due" in b ? (b.due == null ? null : Number(b.due)) : undefined,
            start: "start" in b ? (b.start == null ? null : Number(b.start)) : undefined,
            points: "points" in b ? (b.points == null ? null : Number(b.points)) : undefined,
            estimate: "estimate" in b ? (b.estimate == null ? null : Number(b.estimate)) : undefined,
            archived: typeof b.archived === "boolean" ? b.archived : undefined,
          }, seen)
        : pathname === "/clickup/tag" ? await setTag(id, String(b.tag ?? ""), b.on !== false)
        : pathname === "/clickup/field/clear" ? await clearField(id, String(b.field ?? ""))
        // Sprints are lists, so changing one is a move. `from` is the list it
        // is leaving; without it the card ends up in both.
        : pathname === "/clickup/move" ? await moveToList(id, String(b.list ?? ""), b.from != null ? String(b.from) : undefined)
        : pathname === "/clickup/create"
          ? await createTask(String(b.list ?? ""), {
            name: String(b.name ?? ""),
            description: b.description != null ? String(b.description) : undefined,
            assignees: Array.isArray(b.assignees) ? (b.assignees as unknown[]).map(Number) : undefined,
            priority: b.priority != null ? String(b.priority) : undefined,
            points: b.points != null ? Number(b.points) : undefined,
            due: b.due != null ? Number(b.due) : undefined,
            status: b.status != null ? String(b.status) : undefined,
          })
        : pathname === "/clickup/checklist" ? await addChecklist(id, String(b.name ?? ""))
        : pathname === "/clickup/checklist/item" ? await addChecklistItem(String(b.checklist ?? ""), String(b.name ?? ""))
        : pathname === "/clickup/checklist/check" ? await setChecklistItem(String(b.checklist ?? ""), String(b.item ?? ""), b.done === true)
        // A comment already written: edited, answered, ticked off or removed.
        // `id` here is the COMMENT's, not the card's.
        : pathname === "/clickup/comment/edit" ? await editClickupComment(id, String(b.text ?? ""))
        : pathname === "/clickup/comment/reply" ? await replyToComment(id, String(b.text ?? ""))
        : pathname === "/clickup/comment/resolve" ? await resolveComment(id, b.on !== false)
        : pathname === "/clickup/comment/delete" ? await deleteClickupComment(id)
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
      /* How long a file is, and nothing else.
         The editor pane draws a strip of the WHOLE file with a band per change,
         and a strip drawn to a length nobody measured is a picture that lies.
         Counting newlines is cheap and the answer is one number, so this is not
         `/files/read` with the body thrown away. Absolute paths are allowed
         because the pull request's copy lives in a temp directory this server
         wrote — the same rule the viewer itself follows. */
      if (pathname === "/files/measure") {
        const want = url.searchParams.get("path") || "";
        return json(await measureFile(want));
      }
      // A ref's copy written out so the editor can open it — see fileToTemp.
      if (pathname === "/files/temp") return json(fileToTemp(root, url.searchParams.get("rel") || "", url.searchParams.get("ref") || ""));
      if (pathname === "/files/find") return json(findFiles(root, url.searchParams.get("q") || "", undefined, url.searchParams.get("ref") || undefined));
      if (pathname === "/files/grep") return json(grepFiles(root, url.searchParams.get("q") || "", undefined, url.searchParams.get("ref") || undefined));
      if (pathname === "/files/refs") return json(listRefs(root));
      if (pathname === "/files/exist") return json(filesExist(root, url.searchParams.getAll("rel")));
    }

    /* --- and searching the machine, which is a different question ---
     *
     * Its own prefix rather than a flag on /files/find, because it is its own
     * boundary: /files/ is bounded by the open project and this one is bounded
     * by your home directory with the dotted paths taken out (disk.ts). Behind
     * the file browser's switch as well as its own — turning directory browsing
     * off must not leave a second door standing. */
    /* --- the floating bench ---
     *
     * Only the two things a tmux session cannot hold: the checkout's note, and
     * which of its tabs are still running. The tabs themselves need no route —
     * they are sessions on the engine and the pty socket reaches them. */
    if (pathname === "/bench/note" && req.method === "GET") {
      return json(readNote(url.searchParams.get("root") || ""));
    }
    if (pathname === "/bench/live") return json(await benchLive(url.searchParams.get("root") || ""));
    if (pathname === "/bench/end" && req.method === "POST") {
      if (!trustedCaller(req, from)) return csrfBlocked();
      let b: { root?: unknown; slot?: unknown };
      try { b = (await req.json()) as typeof b; } catch { return json({ ok: false, error: "invalid json" }, 400); }
      const r = await benchEnd(b.root, b.slot);
      return json(r, r.ok ? 200 : 400);
    }
    if (pathname === "/bench/edit" && req.method === "POST") {
      /* Puts a file in front of you in the checkout's own editor, which is a
         thing this server does to a process it started — so it takes the same
         gate every other write does. */
      if (!trustedCaller(req, from)) return csrfBlocked();
      if (!TERMINAL_ENABLED) return json({ ok: false, live: false, error: "terminal is disabled" }, 403);
      let body: { root?: unknown; path?: unknown; line?: unknown; readonly?: unknown };
      try { body = (await req.json()) as typeof body; }
      catch { return json({ ok: false, live: false, error: "invalid json" }, 400); }
      const r = await benchEdit(body?.root, body?.path, body?.line, body?.readonly);
      return json(r, r.ok ? 200 : 400);
    }
    if (pathname === "/bench/note" && req.method === "POST") {
      // A write, so it takes the same gate every other write here does.
      if (!trustedCaller(req, from)) return csrfBlocked();
      let body: { root?: unknown; text?: unknown };
      try { body = (await req.json()) as { root?: unknown; text?: unknown }; }
      catch { return json({ ok: false, text: "", error: "invalid json" }, 400); }
      const r = writeNote(body?.root, body?.text);
      return json(r, r.ok ? 200 : 400);
    }

    if (pathname.startsWith("/disk/")) {
      if (!FS_BROWSE_ENABLED) return json({ error: "directory browsing is disabled (AGENTGLASS_FS_BROWSE_DISABLED=1)" }, 403);
      if (pathname === "/disk/places") return json(diskPlaces());
      if (pathname === "/disk/find") return json(diskFind(url.searchParams.get("root") || "", url.searchParams.get("q") || ""));
      // What documents SAY, not just what they are called — the question the
      // Contents tab could only ask inside the open checkout.
      if (pathname === "/disk/grep") return json(diskGrep(url.searchParams.get("root") || "", url.searchParams.get("q") || ""));
    }

    /* --- looking at a place, and looking at a file ------------------------
     *
     * One pair of routes for BOTH worlds the finder can see, because the split
     * between them was invisible to whoever was using it and was why the tabs
     * behaved differently. The boundary is the union of the two that already
     * exist and nothing more — see browse.ts, and the test that caught it
     * listing /etc when no project was open.
     *
     * Behind the same switch as directory browsing: turning that off must not
     * leave a second door standing. */
    if (pathname === "/browse" || pathname.startsWith("/preview/")) {
      if (!FS_BROWSE_ENABLED) return json({ error: "directory browsing is disabled (AGENTGLASS_FS_BROWSE_DISABLED=1)" }, 403);
      /* Handing a file to the desktop starts a process, so it takes the same
         gate every other write on this surface takes. */
      if (pathname === "/preview/open" && req.method === "POST") {
        if (!trustedCaller(req, from)) return csrfBlocked();
        let b: { path?: unknown } = {};
        try { b = (await req.json()) as { path?: unknown }; } catch { return json({ ok: false, error: "invalid json" }, 400); }
        const r = openInDesktop(b?.path);
        return json(r, r.ok ? 200 : 400);
      }
      if (pathname === "/browse") return json(browseDir(url.searchParams.get("path") || ""));
      if (pathname === "/preview/facts") return json(fileFacts(url.searchParams.get("path") || ""));
      if (pathname === "/preview/raw") {
        const r = await fileBytes(url.searchParams.get("path") || "");
        if (!r.ok) return json({ error: r.error }, 404);
        return new Response(r.body, {
          headers: {
            /*
             * `cors`, and it is the whole bug.
             *
             * Every JSON answer here goes through the `json()` helper, which
             * adds them; this route built its own Response and did not. The
             * renderer is a different origin from the engine, so the facts call
             * (JSON, helper, headers) worked and the bytes call failed with a
             * bare "TypeError: Failed to fetch" — a browser refusing a
             * cross-origin response, reported to the page as nothing at all.
             */
            ...cors,
            "content-type": r.mime,
            // A preview is a picture of a file on this machine at this moment;
            // caching it is how a screenshot you just retook shows the old one.
            "cache-control": "no-store",
            // It is a file the user pointed at, and it is served as bytes to be
            // drawn — never as a document with a script in it.
            "content-security-policy": "default-src 'none'; img-src 'self' data: blob:; style-src 'unsafe-inline'",
            "x-content-type-options": "nosniff",
          },
        });
      }
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
    // --- the slow lane -------------------------------------------------
    // Everything here makes the daemon do real work, so none of it is on a
    // timer: it is asked for when somebody opens the section that needs it.
    if (pathname === "/docker/disk") {
      const d = await dockerDisk(url.searchParams.get("force") === "1");
      return json(d ?? { error: "docker could not report disk usage" }, d ? 200 : 503);
    }
    if (pathname === "/docker/volume") return json(await dockerVolumeDetail(url.searchParams.get("name") || ""));
    if (pathname === "/docker/volume/peek") {
      return json(await dockerVolumePeek(url.searchParams.get("name") || "", url.searchParams.get("path") || ""));
    }
    // Two environments, compared on this side of the wire — see dockerenv.ts
    // for why the values of anything credential-shaped never cross it.
    if (pathname === "/docker/env-diff") {
      return json(await dockerEnvCompare(url.searchParams.get("a") || "", url.searchParams.get("b") || ""));
    }
    if (pathname === "/docker/inspect") return json(await dockerInspect(url.searchParams.get("id") || ""));
    if (pathname === "/docker/top") return json(await dockerTop(url.searchParams.get("id") || ""));
    if (pathname === "/docker/logs") {
      const id = url.searchParams.get("id") || "";
      const tail = Number(url.searchParams.get("tail") || 400);
      return json(await dockerLogs(id, tail));
    }
    // The same log, followed instead of re-asked every three seconds. Kept
    // beside the one-shot rather than replacing it: the phone and the demo
    // adapter still want a snapshot, and a snapshot is also the honest fallback
    // when the browser cannot hold a stream open.
    if (pathname === "/docker/logs/stream") {
      const r = streamLogs(url.searchParams.get("id") || "", Number(url.searchParams.get("tail") || 200), req.signal);
      if (!r.ok || !r.stream) return json({ ok: false, error: r.error ?? "could not follow" }, 409);
      return new Response(r.stream, {
        headers: {
          "content-type": "text/plain; charset=utf-8",
          "cache-control": "no-store",
          // Without this a proxy in front of the engine can hold the whole
          // stream until the container stops, which is the same as not
          // streaming at all — and much harder to notice.
          "x-accel-buffering": "no",
        },
      });
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
        // Reclaiming disk. Gated exactly like the container actions — write
        // mode, trusted caller, and recorded — because these are deletes, and
        // the panel only offers the two whose consequence is "a slower build"
        // rather than "every worktree reinstalls".
        case "/docker/prune/cache": {
          if (!DOCKER_WRITE_ENABLED) { res = { ok: false, error: "this instance is read-only" }; break; }
          const r = await capBuildCache(Number(b.bytes) || 60_000_000_000);
          res = { ok: r.ok, ...(r.error ? { error: r.error } : {}), output: r.freed != null ? `reclaimed ${r.freed} bytes` : r.removed.join(", ") };
          break;
        }
        case "/docker/images/rm": {
          if (!DOCKER_WRITE_ENABLED) { res = { ok: false, error: "this instance is read-only" }; break; }
          const refs = Array.isArray(b.refs) ? b.refs.map((x: unknown) => String(x)) : [];
          const r = await removeImages(refs);
          res = { ok: r.ok, ...(r.error ? { error: r.error } : {}), output: `removed ${r.removed.length} image${r.removed.length === 1 ? "" : "s"}` };
          break;
        }
        default: res = null;
      }
      // Every write through this switch is recorded — see actions.ts for why
      // it keeps the small ones too.
      if (res) { noteAction(clientIp, pathname, b, res, asActor(caller)); return json(res, res.ok ? 200 : 400); }
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
      if (res) { noteAction(clientIp, pathname, b, res, asActor(caller)); return json(res, res.ok ? 200 : 400); }
    }

    /*
     * The three writes a run has.
     *
     * Gated and recorded like every other write on this surface, and behind
     * TERMINAL_ENABLED on top — `/run/start` opens tmux windows running an
     * agent, which is the same capability `/terminal/agent` guards that way. A
     * server with the terminal turned off must not have a second door to it.
     *
     * `yolo` goes through the same permission the chat engines do rather than
     * arriving as a parameter, so a socket cannot buy a flag the config
     * refuses — and it is folded in per leg here, because that is where a run
     * would otherwise smuggle it past the check.
     */
    if (pathname.startsWith("/run/") && req.method === "POST") {
      if (!trustedCaller(req, from)) return csrfBlocked();
      if (!TERMINAL_ENABLED) return json({ ok: false, error: "the terminal is disabled here" }, 403);
      let b: any = {};
      try { b = await req.json(); } catch { return json({ ok: false, error: "invalid json" }, 400); }
      let res: { ok: boolean; error?: string; detail?: string } | null = null;
      switch (pathname) {
        case "/run/start": {
          const bypass = chatBypassAllowed();
          const legs = Array.isArray(b.legs)
            ? b.legs.map((l: any) => ({ agent: l?.agent, from: l?.from, yolo: l?.yolo === true && bypass }))
            : b.legs;
          res = await startRun(b.root, b.prompt, legs);
          break;
        }
        case "/run/adopt": res = await adoptPane(b.id, b.pane, b.agent); break;
        case "/run/finish": res = await finishRun(b.id, b.winner, b.force === true); break;
        default: res = null;
      }
      if (res) { noteAction(clientIp, pathname, b, res, asActor(caller)); return json(res, res.ok ? 200 : 400); }
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
      noteAction(clientIp, pathname, { pid: b.pid, key: b.key }, { ok: res.ok, error: res.error }, asActor(caller));
      return json(res, res.ok ? 200 : 400);
    }

    if (pathname === "/machine/unlock" && req.method === "POST") {
      if (!trustedCaller(req, from)) return csrfBlocked();
      let b: any = {};
      try { b = await req.json(); } catch { return json({ ok: false, error: "invalid json" }, 400); }
      const res = removeStaleLock(b.path, knownProjects().map((p) => p.path));
      noteAction(clientIp, pathname, b, res, asActor(caller));
      return json(res, res.ok ? 200 : 400);
    }

    if (pathname === "/machine/kill" && req.method === "POST") {
      if (!trustedCaller(req, from)) return csrfBlocked();
      let b: any = {};
      try { b = await req.json(); } catch { return json({ ok: false, error: "invalid json" }, 400); }
      const res = killPort(b.pid);
      noteAction(clientIp, pathname, b, res, asActor(caller));
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
    /*
     * GitHub's notification inbox.
     *
     * A different question from the board's: that one is about STATE — who is
     * blocked, what is green — and this is about what happened while you were
     * away, including the two things the board cannot see at all, a mention in
     * a comment and an issue that is not a pull request.
     */
    if (pathname === "/prs/inbox") {
      return json(await inbox(url.searchParams.get("unread") !== "1", url.searchParams.get("force") === "1"));
    }
    if (pathname === "/prs/inbox/act" && req.method === "POST") {
      if (!trustedCaller(req, from)) return csrfBlocked();
      const b = await req.json().catch(() => ({})) as Record<string, unknown>;
      const id = String(b.id ?? "");
      const r = b.act === "unsubscribe" ? await unsubscribe(id)
        : b.act === "repo-read" ? await markRepoRead(String(b.repo ?? ""))
        : await markRead(id);
      return json(r, r.ok ? 200 : 400);
    }
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
      if (!trustedCaller(req, from)) return csrfBlocked();
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
    /* What this project's agents have spent, by branch and by checkout — the
       whole repository in one answer, because the board looks its rows up in it
       rather than asking per pull request. Scoped like every other read here:
       an out-of-scope root falls back to the open project instead of reporting
       on a repository the cockpit is not showing. See spend.ts. */
    if (pathname === "/prs/spend") {
      const asked = url.searchParams.get("root") ?? "";
      const root = asked && inScope(asked) ? asked : (workspaceRoot() ?? process.cwd());
      return json(await repoSpend(root));
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
    /* Which files moved between two commits of this pull request — see filesSince.
       A GET because it reads, and cached by the client against the pair of shas: the
       answer cannot change while both ends are fixed. */
    if (pathname === "/prs/files-since") {
      return json(await filesSince(
        url.searchParams.get("root") || "",
        url.searchParams.get("from") || "",
        url.searchParams.get("to") || "",
      ));
    }
    /* The repository's own CODEOWNERS, read from the checkout — see codeowners. */
    if (pathname === "/prs/codeowners") {
      return json(await codeowners(url.searchParams.get("root") || ""));
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
    /* The nudge: the line for a pull request waiting on somebody, sent down
       the alerts' webhook when there is one. The text always comes back so
       the client can put it on the clipboard either way. */
    if (pathname === "/prs/nudge" && req.method === "POST") {
      if (!trustedCaller(req, from)) return csrfBlocked();
      let b: { root?: unknown; number?: unknown; send?: unknown };
      try { b = (await req.json()) as typeof b; } catch { return json({ ok: false, error: "invalid json" }, 400); }
      const got = await prDetail(b.root, b.number);
      if (!got.ok || !got.detail) return json({ ok: false, error: got.error ?? "no such pull request" }, 400);
      const text = nudgeText(got.detail);
      const channel = nudgeChannel();
      const sent = b.send === true && channel.configured ? await sendNudge(text) : null;
      return json({ ok: true, text, channel: channel.configured, sent: sent?.sent ?? false, ...(sent?.error ? { error: sent.error } : {}) });
    }
    if (pathname === "/prs/detail") {
      return json(await prDetail(
        url.searchParams.get("root") || "",
        url.searchParams.get("number") || "",
        url.searchParams.get("force") === "1",
      ));
    }
    if (pathname === "/prs/diff") {
      return json(await prDiff(url.searchParams.get("root") || "", url.searchParams.get("number") || "", url.searchParams.get("force") === "1"));
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
      /* A node id is checked at the door as well as in prs.ts — see nodeIdOk
         for what `-F id=@/path` used to do with an unchecked one. Refusing
         here makes it a 400 with a sentence rather than gh's usage text. */
      const NODE_ID_ROUTES: Record<string, string> = {
        "/prs/thread-resolved": "threadId", "/prs/react": "nodeId", "/prs/comment-edit": "nodeId",
        "/prs/comment-delete": "nodeId", "/prs/comment-hide": "nodeId", "/prs/file-viewed": "prNodeId",
      };
      const idField = NODE_ID_ROUTES[pathname];
      if (idField && !nodeIdOk(pathname === "/prs/react" ? (b.nodeId ?? b.commentId) : b[idField])) {
        return json({ ok: false, error: `${idField} is not a GitHub node id` }, 400);
      }
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
        /* Folded away rather than deleted, with the reason GitHub records — see
           hideComment. One route for both directions: the caller says which. */
        case "/prs/comment-hide": res = b.on === false
          ? await unhideComment(root, b.nodeId)
          : await hideComment(root, b.nodeId, b.reason); break;
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
        case "/prs/review-prompt": res = await prepareReviewPrompt(root, n, b.recipe, b.card); break;
        case "/prs/pending-review": res = await pendingReviewFor(root, n); break;
        default: res = null;
      }
      // Every write through this switch is recorded — see actions.ts for why
      // it keeps the small ones too.
      // As in the git family: its own line, so the tripwire count stays true.
      if (res) noteClass(pathname, b, res.ok !== false);
      if (res) { noteAction(clientIp, pathname, b, res, asActor(caller)); return json(res, res.ok ? 200 : 400); }
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
      /*
       * Every pane of the window, not only the one tmux has selected.
       *
       * The desk used to ask this once per hover, about whichever pane it had
       * just selected — so the four buttons a pane draws could not appear until
       * a round trip had been made FOR that pane, and after a restart a
       * six-pane grid needed six of them, one at a time, as the pointer
       * wandered. Reported as "it takes ages… especially after a restart… it
       * just sits there saying Reading this pane".
       *
       * `all=1` answers for the lot off the same `list-panes` call, so the
       * panel can fill its memory for the whole window in one request while
       * nobody is waiting. The single-pane answer is unchanged, and is still
       * what a hover falls back to.
       */
      const win = url.searchParams.get("window") || "";
      if (url.searchParams.get("all") === "1") {
        const panes = panesWithPids(lastTmuxTarget()?.socket, win);
        return json({
          ok: true,
          panes: panes.map((p) => {
            const { dirs } = paneDirs(p.paneId, p.pid);
            const note = paneAgentNote(p.paneId);
            return {
              pane: p.paneId,
              active: p.active,
              dirs: dirs.filter((d) => sessionInScope({ cwd_path: d })),
              agent: note ? note.session_id : "",
            };
          }),
        });
      }
      const pane = activePane(lastTmuxTarget()?.socket, win);
      if (!pane) return json({ ok: true, pane: null, dirs: [] });
      const { dirs } = paneDirs(pane.paneId, pane.pid);
      /* WHOSE answer this is, alongside the answer.
         The panel keeps the last worktree a pane named — an agent between turns
         says nothing, and a chip that emptied itself every quiet minute would
         be useless. That memory has to end when the AGENT ends: `/clear` starts
         a new session with a new transcript, and without this the chip went on
         naming a branch from a conversation that no longer exists. */
      const note = paneAgentNote(pane.paneId);
      return json({
        ok: true,
        pane: pane.paneId,
        dirs: dirs.filter((d) => sessionInScope({ cwd_path: d })),
        agent: note ? note.session_id : "",
      });
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
    /*
     * A picture from a phone, put on disk so a pane can be pointed at it.
     *
     * The phone cannot hand a TUI an image. What every agent CLI does accept is
     * a PATH, which is what a desktop paste of an image actually delivers — the
     * file is written somewhere and its name goes into the prompt. So the phone
     * uploads the bytes here, gets a path back, and pastes that.
     *
     * Written under the same temp root as the other read-only copies, and never
     * inside a checkout: a stray file in a repository turns up in somebody's
     * `git status` an hour later, and this one arrives while they are looking
     * at something else entirely.
     *
     * A cap, because this is the one route on the server that takes a payload
     * whose size the client chooses. Eight megabytes is a phone photo at full
     * resolution with room over; past it the answer is a refusal rather than a
     * write, since the failure mode of no cap is a disk nobody is watching.
     */
    /*
     * Speech, turned into text where the computer is.
     *
     * The phone records and this transcribes, which is the same division as
     * every other heavy thing here: a phone is good at capturing and bad at
     * the rest, and Expo Go cannot carry a native recogniser at all.
     *
     * A refusal NAMES what is missing rather than failing vaguely — the whole
     * feature depends on a binary this app does not install, and "nothing
     * happened" would be indistinguishable from "you said nothing".
     */
    if (pathname === "/terminal/dictate" && req.method === "POST") {
      if (!trustedCaller(req, from)) return csrfBlocked();
      if (!TERMINAL_ENABLED) return json({ ok: false, error: "the terminal is disabled here" }, 403);
      let b: { data?: unknown; name?: unknown };
      try { b = (await req.json()) as typeof b; } catch { return json({ ok: false, error: "invalid json" }, 400); }
      const said = await transcribe(b.data, b.name);
      return json(said, said.ok ? 200 : 400);
    }

    if (pathname === "/terminal/image" && req.method === "POST") {
      if (!trustedCaller(req, from)) return csrfBlocked();
      if (!TERMINAL_ENABLED) return json({ ok: false, error: "the terminal is disabled here" }, 403);
      let b: { data?: unknown; name?: unknown };
      try { b = (await req.json()) as typeof b; } catch { return json({ ok: false, error: "invalid json" }, 400); }
      const data = typeof b.data === "string" ? b.data : "";
      if (!data) return json({ ok: false, error: "no image" }, 400);
      let bytes: Buffer;
      try { bytes = Buffer.from(data, "base64"); } catch { return json({ ok: false, error: "not base64" }, 400); }
      if (!bytes.length) return json({ ok: false, error: "empty image" }, 400);
      if (bytes.length > 8 * 1024 * 1024) return json({ ok: false, error: "that image is over 8MB" }, 413);
      /* The name is the CLIENT's and only its extension is kept, lowercased and
         from a fixed set. A filename off the wire reaches a path here, and the
         basename is the whole of what is worth carrying anyway — what the agent
         is told is a path this server chose. */
      const asked = typeof b.name === "string" ? b.name.toLowerCase() : "";
      const ext = /\.(png|jpe?g|gif|webp|heic)$/.exec(asked)?.[0] ?? ".png";
      const file = joinPath(makeViewTempDir("image"), `image${ext}`);
      try { fsWrite(file, bytes); } catch (e) {
        return json({ ok: false, error: `could not write it: ${String(e)}` }, 500);
      }
      return json({ ok: true, file });
    }

    if (pathname === "/terminal/agent" && req.method === "POST") {
      if (!trustedCaller(req, from)) return csrfBlocked();
      if (!TERMINAL_ENABLED) return json({ ok: false, error: "the terminal is disabled here" }, 403);
      let b: { cwd?: unknown; prompt?: unknown; yolo?: unknown; title?: unknown; kind?: unknown };
      try { b = (await req.json()) as typeof b; } catch { return json({ ok: false, error: "invalid json" }, 400); }
      const cwd = gitSafeAbs(b.cwd);
      if (!cwd || !inScope(cwd) || !fsExists(cwd)) {
        return json({ ok: false, error: "that directory is not in the open project" }, 400);
      }
      const prompt = typeof b.prompt === "string" ? b.prompt : "";
      // Bypass is a permission, not a parameter: the same gate the chat engines
      // go through, so a socket cannot buy the flag the config refuses.
      const yolo = b.yolo === true && chatBypassAllowed();
      /* Validated against the table rather than passed through. `kind` decides
         which executable runs, so an unrecognised one must not reach a lookup:
         it is an id from shared/agentKinds.ts or it is Claude, never a string
         off the wire. */
      const wanted = typeof b.kind === "string" ? b.kind : "claude";
      if (!agentKind(wanted)) return json({ ok: false, error: "no such agent" }, 400);
      const id = mintAgentTicket({ cwd, prompt, yolo, title: sessionTitle(b.title), kind: wanted });
      return json({ ok: true, ticket: id });
    }

    /*
     * THE LANTERN'S CHAT — a ticket whose prompt is the field, composed here.
     *
     * Herdr's Lantern is a chat in a pane; here it is an agent tab on the
     * floating bench, reachable from any view and floating over the Lantern
     * itself, so the board and the conversation are on screen together.
     * "Don't you think that terminal with the ASK should live in the lantern,
     * since it will be something general?" — the bench is the app's one answer to "a shell or an
     * agent without leaving where you are", and it is general by construction.
     *
     * The client sends nothing: the readout is assembled from the same board
     * `/agents/board` serves (lantern.ts), at this moment, so the chat opens
     * on what is true now. The checkout is the most pressing agent's, or the
     * workspace root, or the caller's — a bench tab hangs off a checkout even
     * when the conversation is about all of them.
     */
    if (pathname === "/lantern/ticket" && req.method === "POST") {
      if (!trustedCaller(req, from)) return csrfBlocked();
      if (!TERMINAL_ENABLED) return json({ ok: false, error: "the terminal is disabled here" }, 403);
      let b: { cwd?: unknown };
      try { b = (await req.json()) as typeof b; } catch { b = {}; }
      const offered = gitSafeAbs(b.cwd) || workspaceRoot() || "";
      const plan = await lanternChat(offered);
      const cwd = plan.cwd && inScope(plan.cwd) && fsExists(plan.cwd) ? plan.cwd
        : offered && inScope(offered) && fsExists(offered) ? offered : "";
      if (!cwd) return json({ ok: false, error: "no checkout in the open project to run the Lantern's chat in" }, 400);
      const id = mintAgentTicket({ cwd, prompt: plan.prompt, yolo: false, title: "Lantern", kind: "claude", role: "lantern" });
      return json({ ok: true, ticket: id, cwd, needs: plan.rows.filter((r) => r.needsYou).length });
    }

    /*
     * NAMED AGENTS — the launcher and the liveness a script needs, by name.
     *
     * An unattended worker script — one that picks a task on a clock, cuts a
     * worktree and seats an agent in it — leans on an orchestrator like Herdr
     * for six verbs and nothing else: start an agent in a checkout, prompt it,
     * wait until it is working, read its screen, press a key, list who is
     * still alive. These are those six, over the engine this app already
     * owns, served in Herdr's answer shape (`result.agents[].name`) so such a
     * script reads them unchanged. `bin/agentglass-agent` is the CLI in front
     * of them. See agentops.ts for what this is not.
     *
     * Token-gated like `/terminal/agent` — these open sessions that can run
     * with permissions skipped — and the bypass itself is Settings' to grant.
     */
    /*
     * HANDOFF — a session's conversation, summarised into a brief and seated
     * as another agent's first message on the bench. The brief is composed
     * here from the record (see handoff.ts); the client gets a ticket and
     * never sends a prompt.
     */
    if (pathname === "/agents/handoff" && req.method === "POST") {
      if (!trustedCaller(req, from)) return csrfBlocked();
      if (!TERMINAL_ENABLED) return json({ ok: false, error: "the terminal is disabled here" }, 403);
      let b: { session?: unknown; kind?: unknown; cwd?: unknown };
      try { b = (await req.json()) as typeof b; } catch { return json({ ok: false, error: "invalid json" }, 400); }
      const session = typeof b.session === "string" ? b.session : "";
      const d = session ? getSession(session) : null;
      if (!d) return json({ ok: false, error: "no such session" }, 404);
      const wanted = typeof b.kind === "string" ? b.kind : "claude";
      if (!agentKind(wanted)) return json({ ok: false, error: "no such agent" }, 400);
      const cwd = gitSafeAbs(b.cwd) || gitSafeAbs(d.cwd_path) || workspaceRoot() || "";
      if (!cwd || !inScope(cwd) || !fsExists(cwd)) return json({ ok: false, error: "that directory is not in the open project" }, 400);
      const prompt = handoffBrief(d);
      const title = `handoff: ${(d.custom_title || d.ai_title || session.slice(0, 8)).slice(0, 40)}`;
      const id = mintAgentTicket({ cwd, prompt, yolo: false, title: sessionTitle(title), kind: wanted });
      return json({ ok: true, ticket: id, cwd, kind: wanted, title });
    }
    /* Scheduled starts: a reminder whose firing seats a named agent. */
    if (pathname === "/agents/schedule" && req.method === "GET") {
      return json({ ok: true, result: { schedules: Schedule.listSchedules() } });
    }
    if (pathname === "/agents/schedule" && req.method === "POST") {
      if (!trustedCaller(req, from)) return csrfBlocked();
      if (!TERMINAL_ENABLED) return json({ ok: false, error: "the terminal is disabled here" }, 403);
      let b: Record<string, unknown>;
      try { b = (await req.json()) as Record<string, unknown>; } catch { return json({ ok: false, error: "invalid json" }, 400); }
      const r = Schedule.addSchedule({ name: b.name, cwd: typeof b.cwd === "string" ? gitSafeAbs(b.cwd) : b.cwd, kind: b.kind, prompt: b.prompt, yolo: b.yolo, when: b.when });
      return json(r.ok ? { ok: true, result: { schedule: r.schedule } } : r, r.ok ? 200 : 400);
    }
    if (pathname === "/agents/schedule/cancel" && req.method === "POST") {
      if (!trustedCaller(req, from)) return csrfBlocked();
      let b: { id?: unknown };
      try { b = (await req.json()) as typeof b; } catch { return json({ ok: false, error: "invalid json" }, 400); }
      const ok = Schedule.cancelSchedule(String(b.id ?? ""));
      return json({ ok, ...(ok ? {} : { error: "no such schedule, or it already fired" }) }, ok ? 200 : 404);
    }
    if (pathname === "/agents/named" && req.method === "GET") {
      const all = url.searchParams.get("all") === "1";
      return json({ ok: true, result: { agents: await AgentOps.listAgents(all) } });
    }
    if (pathname.startsWith("/agents/named/") && req.method === "POST") {
      if (!trustedCaller(req, from)) return csrfBlocked();
      if (!TERMINAL_ENABLED) return json({ ok: false, error: "the terminal is disabled here" }, 403);
      const verb = pathname.slice("/agents/named/".length);
      let b: Record<string, unknown>;
      try { b = (await req.json()) as Record<string, unknown>; } catch { return json({ ok: false, error: "invalid json" }, 400); }
      if (!AgentOps.validName(b.name)) return json({ ok: false, error: "name: letters, digits, dot, dash or underscore, 64 at most" }, 400);
      const name = b.name;
      const timeoutMs = Math.min(600_000, Math.max(0, Number(b.timeout ?? 0) || 0));

      if (verb === "start") {
        const cwd = gitSafeAbs(b.cwd);
        if (!cwd || !inScope(cwd) || !fsExists(cwd)) {
          return json({ ok: false, error: "that directory is not in the open project" }, 400);
        }
        const wanted = typeof b.kind === "string" ? b.kind : "claude";
        if (!agentKind(wanted)) return json({ ok: false, error: "no such agent" }, 400);
        const args = Array.isArray(b.args) ? b.args.filter((a): a is string => typeof a === "string") : [];
        const r = await AgentOps.startAgent({
          root: workspaceRoot() || cwd, name, cwd, kind: wanted,
          prompt: typeof b.prompt === "string" ? b.prompt : "",
          yolo: b.yolo === true, yoloAllowed: chatBypassAllowed(), args,
          remoteControl: typeof b.remoteControl === "string" ? b.remoteControl : undefined,
        });
        if (!r.ok) {
          const why: Record<string, string> = {
            exists: "an agent by that name is still running",
            "no-cli": "that agent CLI is not installed here",
            "no-window": "tmux would not open a window for it",
            "bad-name": "bad name",
            "yolo-refused": "skipping permissions is off in Settings (chatBypass)",
            "bad-args": "args must be plain strings",
          };
          /* Named, so the caller learns which arg and why in one answer: what
             an agent is allowed to do is decided in Settings (yolo) or by this
             server, never by a flag riding in `args` — see refusedArg. */
          if (r.error === "arg-refused") {
            return json({ ok: false, error: `${r.flag} is not an arg a start may carry: it changes what the agent is allowed to do, and that is decided in Settings, not in args` }, 400);
          }
          return json({ ok: false, error: why[r.error], result: r.error === "exists" ? { agent: r.agent } : undefined }, r.error === "exists" ? 409 : 400);
        }
        /* `--timeout` on start is Herdr's "wait until the CLI is up": the
           worker's next verb is a prompt, and a paste into a pane whose CLI has
           not drawn its box yet is a paste into a shell. */
        const wait = timeoutMs > 0 ? await AgentOps.waitFor(r.agent.paneId, ["ready", "working", "needs-you"], timeoutMs) : null;
        return json({ ok: true, result: { agent: r.agent, state: wait?.state ?? "starting", ready: wait?.reached ?? false } });
      }

      const a = AgentOps.agentNamed(name);
      if (!a || a.endedAt !== null) return json({ ok: false, error: "no agent by that name" }, 404);

      if (verb === "prompt") {
        const text = typeof b.text === "string" ? b.text : "";
        if (!text.trim()) return json({ ok: false, error: "nothing to send" }, 400);
        const outcome = await AgentOps.promptAgent(a.paneId, text, timeoutMs || 10_000);
        return json({ ok: outcome === "sent" || outcome === "queued", result: { name, outcome } }, outcome === "gone" ? 410 : 200);
      }
      if (verb === "wait") {
        const raw = typeof b.until === "string" ? b.until.split(",") : [];
        const until = raw.map((s) => s.trim()).filter((s): s is AgentOps.AgentState => ["starting", "ready", "working", "needs-you", "gone"].includes(s));
        if (!until.length) return json({ ok: false, error: "until: ready, working, needs-you or gone" }, 400);
        const w = await AgentOps.waitFor(a.paneId, until, timeoutMs || 90_000);
        return json({ ok: w.reached, result: { name, state: w.state, reached: w.reached } });
      }
      if (verb === "read") {
        const lines = Math.min(2000, Math.max(0, Number(b.lines ?? 0) || 0));
        const screen = await AgentOps.screenOf(a.paneId, lines);
        if (screen === null) return json({ ok: false, error: "its window is gone" }, 410);
        /* The bottom of a pane is blank rows, not content: trimmed before the
           tail is cut, or "the last 3 lines" of a 50-row pane are three blanks. */
        const text = lines > 0 ? screen.trimEnd().split("\n").slice(-lines).join("\n") : screen;
        return json({ ok: true, result: { name, state: AgentOps.stateOfScreen(screen), text } });
      }
      if (verb === "keys") {
        const key = AgentOps.keyNamed(b.key);
        if (!key) return json({ ok: false, error: "key: enter, escape, up, down, left, right, tab, space, backspace or ctrl-c" }, 400);
        const ok = await AgentOps.pressKey(a.paneId, key);
        return json({ ok, result: { name, key } }, ok ? 200 : 410);
      }
      if (verb === "stop") {
        const ok = await AgentOps.stopAgent(a);
        return json({ ok: true, result: { name, killed: ok } });
      }
      return json({ ok: false, error: "no such verb" }, 404);
    }

    // --- the pane engine's tmux, exposed to the agentglass UI -------------
    // Everything tmux's own bar would have done — tabs, splits, focus, kill,
    // rename, resize — is served here, so the UI is the only surface the user
    // ever sees. Every target id is validated against tmux's own shapes before
    // it reaches a command (see tmuxlayout.ts), and every write goes through
    // the same trusted-caller gate as the rest of the app.
    /*
     * Which agent CLIs are on this machine.
     *
     * The phone's new-tab menu asks before it draws. A menu listing four names
     * where only two are installed fails AFTER the window has opened — a blank
     * pane on somebody's computer rather than a sentence on their screen — and
     * the phone has no other way to know.
     */
    if (pathname === "/terminal/agents") {
      return json({
        ok: true,
        agents: AGENT_KINDS.map((a) => ({
          id: a.id,
          title: a.title,
          what: a.what,
          /* Claude answers through its own resolver, which knows about a
             pinned version and a shim as well as PATH. */
          installed: a.id === "claude" ? !!claudeCode.bin() : !!agentBinFor(a.id),
          /* Whether "permissions off" is a thing this one HAS. A phone must
             not draw a switch that buys no flag. */
          canBypass: !!a.yoloFlag,
        })),
      });
    }

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
        // Which tmux the terminal VIEW opens on.
        terminal: tmuxTerminal(),
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
      // Same as the prefix: hand the live server its new config instead of
      // making somebody restart the engine — which would take every pane on it.
      const appliedNow = applied.ok ? await reloadEngineConf() : false;
      return json({ ...applied, appliedNow }, applied.ok ? 200 : 400);
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
      if (b.terminal !== undefined) {
        if (!["engine", "desk"].includes(String(b.terminal))) return json({ ok: false, error: "unknown terminal mode" }, 400);
        fields.tmuxTerminal = b.terminal;
      }
      if (b.prefix !== undefined) {
        const key = String(b.prefix).trim();
        if (key && !validTmuxPrefix(key)) {
          return json({ ok: false, error: "that is not a key tmux would take — try C-a, M-Space or F5" }, 400);
        }
        fields.tmuxPrefix = key;
      }
      const w = writeTmuxSettings(fields);
      // Regenerate AND hand it to the running server: tmux reads its config
      // when the server starts, so without this a saved prefix waited for a
      // restart — and restarting the engine takes every pane on it with it.
      let appliedNow = false;
      if (w.ok && b.prefix !== undefined) { ensureConf(); appliedNow = await reloadEngineConf(); }
      return json({ ...w, appliedNow }, w.ok ? 200 : 400);
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
        { root: b.cwd, name: b.model }, { ok: true }, asActor(caller));
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
        { root: b.cwd, name: b.model }, { ok: true }, asActor(caller));
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
        { root: b.cwd, name: b.model }, { ok: true }, asActor(caller));
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
    // Whether an agent is working right now, anywhere — what the desktop
    // shell's "keep the machine awake while an agent works" mode polls.
    if (pathname === "/agents/working") return json({ working: agentIsWorking() });
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
      if (ws.data?.kind === "pty") {
        // Alive from the moment it connects — see the note on the sweep above.
        alive.set(ws, Date.now());
        ptyOpen(ws);
        return;
      }
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
      // Every string in every payload capped — this frame is a batch of 300, not
      // the single event `broadcast()` sends after it, and a handful of full
      // file writes or long command outputs in that batch is what pushed a
      // routine reconnect to half a megabyte. See capPayloadStrings for the
      // measurement and why this caps rather than strips the field outright.
      const initialData = getRecent(300).map((e) => ({ ...e, payload: capPayloadStrings(e.payload) }));
      const frame: WsFrame = { type: "initial", data: initialData, openTools: withEvidence(openToolCalls()) };
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
      // A frame that did arrive is still proof somebody is running — for a
      // pty this is a keystroke or a resize, not just the event stream.
      alive.set(ws, Date.now());
      if (ws.data?.kind === "pty") ptyMessage(ws, msg as string | Buffer);
    },
    /** The answer to the sweep's ping, and — for an event-stream or notify
     *  socket — the only routine evidence its peer ever sends; a pty socket
     *  also gets this from every keystroke, above. */
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

/* And once, if what retention has already deleted is a third of the file. See
   reclaimFreePages: pruning frees pages, it does not give them back, and this
   database does not grow back into them. Before the first request, and silent
   when there is nothing worth doing. */
{
  const reclaimed = reclaimFreePages();
  if (reclaimed) console.log(`🗜  reclaimed ${(reclaimed.freed / 1e6).toFixed(0)} MB of free pages in ${reclaimed.ms}ms`);
}

// Reclaim chat panes nobody has spoken to in a while. A warm CLI is the whole
// point of the pane engine and also its whole cost (~380MB and climbing), so an
// abandoned chat gives its memory back and resumes transparently next time.
// A no-op when the engine is off, tmux is absent, or eviction is disabled.
/*
 * Hand the running engine its config at every boot.
 *
 * tmux reads a config when the SERVER starts, and the engine's server outlives
 * this process by design — so a conf change that ships in a release would
 * otherwise wait for somebody to kill every pane on it. `source-file` re-runs
 * the generated file in place: `set -g` and `bind` are idempotent, the sessions
 * are untouched, and a machine with nothing running answers false, which is not
 * a failure — the file is on disk and the next start reads it.
 */
ensureConf();
void reloadEngineConf();

startPaneSweeper();
/* Windows a previous life of this process opened and never got to close: the
   run died with the server, the agent in it did not. Only ever the ones in our
   own record, each still checked against the stamp we put on it — a record that
   outlived the tmux server closes nothing. */
void reapLeases();
/* Phone mirrors a previous life of this process made and never got to close:
   the same case as the windows above, one scope down. `destroy-unattached`
   only fires when OUR client detaches, and a phone that went dark without a
   close frame never triggered that — so a mirror it opened can still be
   sitting there, unattached, verified against its own stamp before anything
   here touches it. */
/**
 * The work loop, as something that can be started twice.
 *
 * It used to live only inside its route, which meant the ONLY way back to work
 * was a person pressing the button. Measured: a server restart killed two runs,
 * the tasks were correctly put back on the queue, and then the shift sat
 * `running` with three tasks waiting and nothing running for forty minutes,
 * saying nothing. The watchdog can call this now — see `setResumeHook`.
 */
/*
 * ONE LOOP AT A TIME.
 *
 * There was no guard, and the watchdog's only "already working" test is
 * `Work.runningRuns()` — which is empty for the whole window between cutting a
 * worktree and writing the run row, and `runInstallIn` sits inside that window
 * with no timeout at all. So a second loop could start, take the same untaken
 * item, be refused with "already exists", and hand its worktree to the barren
 * sweep — which is the directory the FIRST loop was about to run an agent in.
 *
 * A refusal rather than a queue: two loops is never the intent, and the caller
 * that gets this back (the watchdog) reads it as "busy", not as a try spent.
 */
let loopInFlight: Promise<{ ok: boolean; error?: string; [k: string]: unknown }> | null = null;

async function startWorkLoop(): Promise<{ ok: boolean; error?: string; [k: string]: unknown }> {
  if (loopInFlight) return { ok: false, error: "a loop is already running", busy: true };
  const started = runWorkLoop();
  loopInFlight = started;
  try { return await started; } finally { loopInFlight = null; }
}

async function runWorkLoop(): Promise<{ ok: boolean; error?: string; [k: string]: unknown }> {
  const loopRepos = await openProjectRepos();
  if (!loopRepos.length) return ({ ok: false, error: "no open-project checkout to work in" });
  const open = Shift.current();
  if (!open || open.state !== "running") {
    return ({ ok: false, error: "hand over first — a loop with no shift has no limit on it" });
  }
  const looped = await Loop.workUntilDone({
    repos: loopRepos,
    shiftId: open.id,
    keepGoing: (lastFailed) => {
      const live = Shift.current();
      if (!live || live.state !== "running") return { go: false, why: live?.stoppedReason || "the shift ended" };
      /*
       * THE SHIFT'S OWN RULES, rather than two of them copied here.
       *
       * This used to re-check "still running" and "actions left" by hand,
       * which are two of the five `shouldStop` knows — so the loop ran past
       * a shift that had timed out, past a failed round, and past a pile of
       * failed worktrees nobody had read. `shouldStop` was exported,
       * tested, and called by nothing but the scanner that has been
       * removed; a stop rule with no caller is a comment.
       */
      const s = Shift.shouldStop(live, { lastFailed });
      return s.stop ? { go: false, why: s.reason } : { go: true, why: "" };
    },
    next: async () => {
      /*
       * The action is charged where the run BEGINS, not here.
       *
       * This spent one of the shift's actions the moment a task was selected —
       * before the fence check, before the worktree was cut, before a row
       * existed. With the panel's default of four, four selections that never
       * became runs ended the shift reporting that it had used everything it
       * was given, having done nothing at all. `countAction` now sits beside
       * `beginRun` in the loop, so what is counted is work that started.
       */
      return await Work.nextTask({ repos: loopRepos });
    },
    countAction: () => Shift.countAction(open.id),
    agent: runAgentIn,
    install: runInstallIn,
    usage: await usageNow(),
    onPane: nowWatching,
    onNoPane: noPane,
    git: runGitIn,
    verify: runTestsIn,
    // So the agent can read the same views he does — see the brief.
    api: { url: `http://127.0.0.1:${PORT}` },
  });

  return { ok: true, ...looped };
}

reapMirrorSessions();
/* And the tmux confs an isolated instance used to leave behind — one per probe
   and per test run, in the shared state directory, since the day the hashed
   name was introduced. 136 of them by the time anybody looked. The placement is
   fixed (see `confPath`); this clears what the old one left. */
{
  const gone = sweepStaleConfs();
  if (gone) console.log(`[tmux] swept ${gone} conf${gone === 1 ? "" : "s"} left behind by isolated runs`);
}
/* And the two rules the startup call cannot cover on its own: a mirror whose
   record was lost is invisible to the sweep above, and a phone that walks away
   an hour from now is not this moment's problem. Measured: nine live mirrors
   against zero records, each one carrying its own copy of four windows with a
   `claude --resume` inside every one — 525 MCP processes and 13 GB. */
startMirrorSweeper(["-L", tmuxSocket()]);

/*
 * Runs left `running` by a server that is no longer here.
 *
 * Whatever was awaiting them lived in the previous process, so nothing will
 * ever write their result. Two of them sat at `running` for 75 and 41 minutes
 * with no agent alive — work in flight on the screen, and invisible to the
 * shift's stop rules, which count what finished and what broke.
 */
{
  /* Not just marked abandoned — PUT BACK. Six runs were lost this way, and each
     one was a task he had queued that nothing would ever pick up again, because
     the queue had already marked it taken. Installing a build cost a shift. */
  const recovered = await recoverAfterRestart();
  for (const r of recovered) {
    if (r.askedForHelp) {
      console.log(`   Understudy  → "${r.title}" has now died ${r.attempts} times — it is waiting on you, not being retried`);
    } else if (r.requeued) {
      console.log(`   Understudy  → "${r.title}" was interrupted by the restart; back on the queue (try ${r.attempts + 1})`);
    } else {
      console.log(`   Understudy  → "${r.title}" abandoned: the server it was running under is gone`);
    }
  }
}
/* How the watchdog gets work moving again without a person pressing anything.
   A slot rather than an import, because the loop closes over a dozen of this
   file's own helpers and reaching for it from the watchdog would be a module
   cycle — which this app has already paid for once, with a black window. */
setResumeHook(() => startWorkLoop());
/* And how it clears up after a run that ended with nothing in it — the same
   slot pattern, for the same reason: git runs where the server's own helpers
   are, and reaching for them from the watchdog would be a module cycle. */
setGitHook(runGitIn);
/* And whether `bun` is reachable, so a run abandoned before its first commit
   can be told apart from one whose branch was actually merged and deleted —
   see the note beside `setBunHook`. */
setBunHook(bunBin);
/* And where it may cut, so the watchdog can tell "nothing is picking this up"
   from "this was queued for somewhere I am not allowed to go" — two sentences
   with two different fixes, which used to be one sentence with neither. */
setFenceHook(() => openProjectRepos());
/* Whether a run's agent is still there, answered by the same window-name match
   the watch route uses. `paneOfRun` returns "" when tmux cannot be reached at
   all, which would read as "every agent is dead" — so an unreachable socket is
   reported as ALIVE and the rows are left alone. */
setBusyHook(Loop.busyWorktree);
setAliveHook(async (title, paneId) => {
  /*
   * THE PANE, AND THE NAME ONLY AS A FALLBACK.
   *
   * This asked tmux for a window called `understudy: <title>`, and a window
   * name is not an identity: tmux renames one when the program inside sets a
   * title. The moment that match failed, a working agent was read as gone, its
   * row was ended, and the empty-worktree sweep deleted the directory out from
   * under it — the run then died of `ENOENT … posix_spawn 'bun'` sixteen
   * minutes in, blaming a program that was there all along.
   *
   * A pane id is written down when the run starts and survives every rename.
   * The name match stays for rows from before this existed, and an unreadable
   * tmux still answers ALIVE: declaring a live agent dead is the expensive
   * mistake, not the other way round.
   */
  const r = await tmux(["list-panes", "-a", "-F", "#{pane_id}"]);
  if (!r.ok) return true;
  if (paneId) return r.stdout.split("\n").some((l) => l.trim() === paneId);
  return !!(await paneOfRun(title));
});
startUnderstudyWatchdog();
startTaskSweep();
startReminderTick();
/* Scheduled agent starts ride a clock of the same shape. See agentschedule.ts. */
Schedule.startScheduleTick();

/*
 * RESTORE FIRST, CAPTURE AFTER — and this order is the whole bug.
 *
 * It used to capture and then restore. On the morning of 2026-08-25 the
 * machine rebooted and this process crash-looped six times in twenty-three
 * minutes; each boot photographed the one session that happened to be alive,
 * wrote that over a file that listed six, and the next boot restored one. A
 * day of sessions went that way while the tmux daemon itself never died once.
 *
 * Capturing before restoring means photographing a desk that is, by
 * definition, not back yet. So: note the launch, decline to touch anything at
 * all if this looks like a loop, restore, and only then capture — against a
 * desk that has had its chance to come back.
 *
 * The merge in `writeMerged` means none of this can lose a session any more.
 * The order means it does not even try.
 */
if (tmuxRestoreEnabled()) {
  const launch = noteLaunch();
  if (launch.looping) {
    /* Six launches in twenty minutes is not somebody restarting the app. Leave
       the last known layout exactly as it is, and SAY SO — degrading quietly
       is what made this cost a day rather than a minute. */
    console.warn(`[tmux] ${launch.recent} launches in the last ten minutes — this looks like a crash loop.`);
    console.warn("[tmux] Not restoring or re-capturing: the saved session layout is left untouched.");
    console.warn(`[tmux] Restore it by hand when the app is stable, from Settings, or delete ${"~/.local/state/agentglass/tmux/restore/launches.json"} to clear this.`);
    /* And where a person can SEE it, not only in a log they are not reading:
       the restore status endpoint carries it, so Settings can say why the
       layout was left alone instead of the person discovering it by finding
       sessions missing. */
    noteCrashLoop(launch.recent);
  } else {
    void restoreLayout().then(() => captureLayout());
  }
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
  process.on(sig, () => {
    /* Photograph the desk before going, belt and braces. The merge means a
       missed capture can no longer lose anything — but a clean exit is the one
       moment the layout is certainly whole, and it costs a few milliseconds to
       write it down. Synchronous on purpose: `process.exit` does not wait for
       a promise, and a capture that loses the race is a capture that did not
       happen. */
    captureLayoutSync();
    /* Before the terminals: a sweep firing while the process is on its way out
       would put a task back on the queue that this shutdown is not going to
       work, and the next boot's own recovery covers exactly that case. */
    stopUnderstudyWatchdog();
    stopMirrorSweeper();
    shutdownTerminals();
    releaseDatabaseClaim();
    process.exit(0);
  });
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
  /*
   * `guarded`, not `posture`. The name was a collision, and it hid a dead
   * subsystem for weeks.
   *
   * `understudy.ts` exports a `posture()` that nothing calls. The orphan guard
   * counts occurrences of a name across the source, so this local — in the
   * network-bind warning, with no connection to the understudy at all — was
   * read as a caller and kept the guard green. Comments are stripped before
   * that count; a same-named local in another file is the harder case, because
   * stripping prose does not remove it.
   *
   * Found by the understudy auditing itself, after a human pass had looked at
   * the same grep and accepted "two uses elsewhere" without reading them.
   */
  const guarded = AUTH_TOKEN ? "token-protected" : "UNAUTHENTICATED";
  console.warn(`⚠  bound to ${BIND} — this exposes a shell, git write access and docker control to the network (${guarded})`);
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
/* And somebody speaking on one. Derived from the same poll — GitHub's
   notifications are an inbox rather than a feed a desktop app can subscribe to —
   with the latch on the server, so a review carrying nine line comments is one
   message and not nine. Never a bot. See noteTalk. */
subscribeTalk((n) => broadcast({ type: "talk", data: n }));
/* A card of yours moved. Derived from a poll rather than received — ClickUp has
   no notifications API — and silent on the first run, so connecting an account
   does not announce a day of history. See clickupwatch.ts. */
/*
 * WHAT A NOTIFICATION SAID ABOUT A CARD, KEPT.
 *
 * ClickUp's API has no history: who assigned a card, who moved it, who added a
 * follower are invisible to it — measured, /task/{id}/history is 404 on both
 * versions. Their own desktop notification says exactly that, with a name in
 * it, and this machine already mirrors those. So the ones that can be
 * attributed to a card are written down and shown on that card, marked as seen
 * here rather than read from the API.
 *
 * Subscribed once at startup rather than per window: a card's record must not
 * depend on somebody having the app open when the notification arrived.
 */
subscribeNotifications((n) => {
  try {
    const card = cardForTitle(n.summary);
    if (!card) return;
    const text = `${n.body || n.summary}`.trim();
    if (!text) return;
    CardIndex.rememberNote({ id: String(n.id), cardId: card.id, label: card.label, text, at: n.at });
  } catch { /* a note that cannot be filed is not worth an error */ }
});

startCardWatch((n) => broadcast({ type: "card", data: n }));
/* The Lantern's watch: the field re-read every N minutes, a loud word when
   something on it needs a person. See lanternwatch.ts. */
startLanternWatch();
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
