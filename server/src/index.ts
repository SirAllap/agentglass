// FIRST, and it must stay first: `agentglass-server cookies …` is answered
// here, before the imports below open the database and start their timers.
import "./cookieentry.ts";
// SECOND, for the same reason: it reads the desktop app's key off the pipe the
// app started this process with and closes it, before any import below can
// spawn a child that would inherit the descriptor (desk.ts).
import "./desk.ts";
import type { ServerWebSocket, Server } from "bun";
import type { ControlCmd, IngestBody, WsFrame, MarkKind, WorkingTree, PanesResponse, AgentSessionRow, GitRepoRef, TreeAuthorsInfo, ChangeRow } from "../../shared/types.ts";
import { slackReachable } from "./slackreach.ts";
import { normalize, detectError, clampIngestTimestamp, externalIngestError } from "./ingest.ts";
import { pricingProvenance, startPricingRefresh } from "./pricing.ts";
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
  eraseHistory,
  trimWal,
  RETENTION_DAYS,
  dbPath,
  dbNotice,
  getChanges,
  sessionNames,
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
import { maybeAlert, setAlertSink, pushDeviceStoreChanged, lanternSnapshot } from "./alerts.ts";
import { noteAction, actorOf, type ActorSource } from "./actions.ts";
import { getSkills, catalogMarkdown, catalogCsv, usageSince } from "./skills.ts";
import { getInsights } from "./insights.ts";
import { getCollisions } from "./collisions.ts";
import { getUsage, ingestStatusline, syncLogin } from "./usage.ts";
import { allProviderUsage } from "./providerusage.ts";
import { claimPaceAlerts, coerceAlertAt } from "./paceAlert.ts";
import { refreshCodexUsage } from "./codexusage.ts";
import { submitGate, decideGate, pendingGates, awaitGate, restoreGates, onGateChange, typedReason, GATE_MAX_MS, gateFailClosed, denyByRule, allowByRule, validGateId } from "./gate.ts";
import { budgetHoldFor } from "./budget.ts";
import { gateCwd, gateRuleFor } from "./gaterules.ts";
import { parseControlCmd, controlId, awaitControl, settleControl, parseReply, nextControlRid, callerRequestId, CONTROL_TIMEOUT_ERROR, changedSetting, makeWriteLimiter, makeRefusalThrottle, controlSwitch, controlRefusal } from "./control.ts";
import { isReadAction, isWriteKind, describeUiActions, presentOf, argsRefusal, entryOfBody, levelAllows, UI_ACTIONS, type UiKind } from "../../shared/uiActions.ts";
import { outwardAction, outwardLine } from "./outward.ts";
import { listLanes } from "./lanes.ts";
import { gateLane, dropBrowserTarget, askBrowser, browserReadyCount, exportAudit, noteBrowserManager, noteBrowserReady, parseAsk, setBrowserSink, settleBrowser, type BrowserOp, runSteps, waitForEvents, recordFrames, traceRecording, auditAsScript, downloadFile, runLanes, withObservation, parseScrape, runScrape } from "./browserdrive.ts";
import { browserUseStatus, installSkill, refreshSkill } from "./browseruse.ts";
import { otlpTracesToEvents, otlpLogsToEvents } from "./otlp.ts";
import { decodeOtlpTraces, decodeOtlpLogs } from "./otlp_pb.ts";
import { statusForPaths, commit as gitCommit, amend as gitAmend, COMMIT_ENABLED, gitAsync, gitCapability, repoRootOf, projectRootOf, safeAbs as gitSafeAbs } from "./git.ts";
import { dependencyReport } from "./deps.ts";
import {
  workingTree, lastCommitChanges, discoverRepos, knownProjectRoots, stage, unstage, stageAll, unstageAll, discard,
  commitStaged, push as gitPush, pull as gitPull, fetch as gitFetch,
  protectedBranches, setProtectedBranches,
  branches as gitBranches, checkout as gitCheckout, createBranch, deleteBranch,
  log as gitLog, commitDiff, stashList, stashPush, stashApply, stashPop, stashDrop,
  stashRename, stashToBranch, stashPartial, stashApplyOverwrite,
  refs, listSnapshots, createSnapshot, restoreSnapshot, deleteSnapshot,
  applyHunk, logGraph, mergeBranch, rebaseBranch, renameBranch, resetTo,
  worktreesWithState as gitWorktrees, addWorktree, removeWorktree, worktreeLeftovers, rescueLeftovers, fixWorktreeOwnership, startAutoFetch, setAutoFetchAudience, autoFetchWhenSomeoneComes, syncFromBase, setBase, setGitChangeHook, setMergedVerdictHook, setPrBaseHook,
  conflicts as gitConflicts, resolveWith, conflictBlocks, conflictFile, resolveBlocks, mergeSession, reopenConflict, stoppedRefusal, conflictPreview, conflictPreviewFile, mergeAbort, mergeContinue, baseCandidates, undoMerge, mergeInfo,
  cherryPick, cherryPickContinue, cherryPickAbort,
  revertCommit, amendCommit, squashCommits,
  rebaseSteps, runRebase, compareRefs,
  remotes as gitRemotes, remoteBranches as gitRemoteBranches, trackRemoteBranch, tags as gitTags, reflog as gitReflog,
  submodules as gitSubmodules, submoduleAdd, submoduleUpdate, submoduleSync, submoduleDeinit, submoduleRemove,
  blameFile, fileHistory,   bisectStatus, bisectStart, bisectMark, bisectReset,
  searchCommits, grepWorkingTree, searchHistory,
  createTag, deleteTag, pushTag, deleteRemoteTag,
  prepareConflictMerge,
  worktrees as repoWorktrees, repoNow,
} from "./gitwork.ts";
import { sessionsForProject } from "./agentsessions.ts";
import { changeRows, fileDiff } from "./changerows.ts";
import { repoStats, generateChangelog } from "./gitinsights.ts";
import { saveShot } from "./shots.ts";
import { allPlaces, forgetPlaces, placeCount, recordVisit, saveFrom } from "./placestore.ts";
import { recent as gitCommandLog } from "./gitlog.ts";
import { gitDir, worktreeParent } from "./worktree.ts";
/** What HEAD says, read from its file: a branch ref, or a hash when detached. */
function headOf(root: string): string {
  const dir = gitDir(root);
  try { return dir ? fsRead(joinPath(dir, "HEAD"), "utf8").trim() : ""; } catch { return ""; }
}
import { watchLoop, entered, finished, stalls, backoff } from "./loopwatch.ts";
import { spawnPoolStats } from "./spawnpool.ts";
import { singleFlight, inflightCount } from "./singleflight.ts";
import { openInEditor, editorTarget, editorCapability, HAS_NVIM } from "./editor.ts";
import { syncTheme, snippetStatus, SNIPPETS, tmuxThemePath, repairTmuxTheme, currentTheme, automatedThemeClient } from "./themesync.ts";
import { desktopPalette, desktopLogo, watchDesktopPalette } from "./desktopPalette.ts";
import { existsSync as fsExists, readFileSync as fsRead, writeFileSync as fsWrite, readdirSync, statSync as fsStat } from "node:fs";
import { RETENTION_FROM_ENV, setRetentionDays } from "./retention.ts";
import { keyringStatus, unlockFirst } from "./keyring.ts";
import { rehydrate, setKeyringEnabled } from "./keyringSwitch.ts";
import { completePath, FS_BROWSE_ENABLED } from "./fsbrowse.ts";
import { listPortsAsync, listResources, spaceFor, killPort } from "./machine.ts";
import { orphanReport, stopOrphan, startOrphanSampler } from "./orphans.ts";
import { diskCleanReport, runDiskClean, defaultDiskCtx } from "./diskclean.ts";
/** Where an orphan can say it came from: the checkouts this app already knows. */
const orphanCtx = () => ({ worktreeRoots: knownProjects().map((p) => p.path) });
/** What the disk scan needs from the app: the checkouts it knows, and the sessions it can see running. */
const diskCtx = () => defaultDiskCtx({
  repos: knownProjects().map((p) => p.path),
  tmuxSockets: () => tmuxSockets(),
  liveSessions: async () => {
    const held = paneHeldSessions(withTmuxServer(await singleFlight(`listPanes:${socketPath(lastTmuxTarget()?.socket ?? [])}`,
      () => listPanes(lastTmuxTarget()?.socket))));
    return liveSessions(recentSessions(), held);
  },
});
import { gitLocks, removeStaleLock } from "./gitlocks.ts";
import { procDetail, revealEnv } from "./procdetail.ts";
import {
  listIssues, issueCounts, issueDetail, issuePullRequests, startIssue, finishIssue, claimIssue, commentIssue, setIssueState, currentWork,
} from "./issues.ts";
import { failed } from "./refused.ts";
import { trackerProjects, setTrackerChoice } from "./trackerProjects.ts";
import { holdCard as holdJiraCard } from "./jiraprcards.ts";
import { ISSUE_KEY, JIRA_WRITE_KINDS, connectJira, jiraStatus, setJiraWrites, setJiraWriteKind, jiraWriteKinds, jiraWriteEnabled, type JiraWriteKind, readIssue, findIssue, mine as jiraMine, searchText as jiraSearchText, withStored as withJira } from "./jira.ts";
import { ACTIVITY_KINDS, activityStored as jiraActivity, type ActivityKind } from "./jiraActivity.ts";
import { devStored as jiraDev } from "./jiraDev.ts";
import { movesStored as jiraMoves, moveStored as jiraMove, remoteLinksStored as jiraLinks, remoteLinksAllStored as jiraLinksAll, linkPullRequestStored as jiraLink } from "./jira.ts";
import {
  assignableStored as jiraAssignable, setAssigneeStored as jiraSetAssignee, handOffStored as jiraHandOff,
  jiraSettings, setHandoffRule as jiraSetHandoff, projectStatusesStored as jiraProjectStatuses,
} from "./jira.ts";
import { jiraSteps, runStepBody, setJiraSteps } from "./jiraSteps.ts";
import { DOOR_VERBS, actingRefusal as doorActingRefusal, isActing as isDoorActing, runDoor } from "./jiraDoor.ts";
import { countedProjects, setCountedProjects, statusUnitsStored as jiraStatusUnitsStored } from "./jiraUnits.ts";
import {
  jiraViews, viewRead as jiraViewRead, viewChoices as jiraViewChoices, projectChoices as jiraProjectChoices,
  addViewByUrl as jiraAddViewByUrl, addViewByChoice as jiraAddViewByChoice, addFolderByKey as jiraAddFolder,
  removeViewById as jiraRemoveView, removeFolderById as jiraRemoveFolder, refreshJiraFoldersIfStale, readBoardAreas as jiraBoardAreas,
} from "./jiraboards.ts";
import { providerStatuses, connectProvider, disconnectProvider, providerWorkspaces, chooseWorkspace, addViewByUrl, addClickupFolder, refreshFoldersIfStale, replaceViewUrl, readView } from "./providers.ts";
import { clickupPrefs, setClickupPrefs, settleFirstRun } from "./clickupPrefs.ts";
import { savedViews, savedFolders, currentView, setCurrent, removeView, removeFolder, knownCardPrefix, knownNoCustomIds, boardHolding, setWritesAllowed, patchCachedTask } from "./clickupviews.ts";
import { assignSelf, setAssignee, setCard, listMembers, workspaceMembers, setStatus, setPriority, setField, clearField, sprintLists, searchTasks, searchTasksStream, warmBodySweep, taskDetail, tagsForTask, findCard, cardPullRequests, projectPullRequests, withStatedLinks, clickupWriteEnabled, commentOn, updateTask, setTag, moveToList, createTask, addChecklist, addChecklistItem, setChecklistItem, editComment as editClickupComment, replyToComment, resolveComment, deleteComment as deleteClickupComment } from "./clickup.ts";
import { clickupTasks, dropAssignedCache } from "./clickup.ts";
import type { ProviderId } from "../../shared/providers.ts";
import { listTasks, taskCapability, setTaskChangeHook, startTaskSweep, addTask, completeTask, reopenTask, deleteTask, cyclePriority, editTask, addTags, replaceNote, bulkApply, TASK_WRITE_ENABLED, type BulkAction } from "./tasks.ts";
import {
  addReminder, ackReminder, cancelReminder, snoozeReminder, listReminders,
  remindersFor, firedUnacked, setReminderHook, startReminderTick, localZone,
} from "./reminders.ts";
import { fileText, fileToTemp, fileTree, findFiles, grepFiles, listRefs, filesExist, heldBackFrom, heldBackTest, HELD_BACK, filesReach, gitReadRefusal, gitReadTest } from "./files.ts";
import { diskEnabled, diskFind, diskGrep, diskPlaces } from "./disk.ts";
import { homeIndex } from "./homeindex.ts";
import { browseBatch } from "./browselist.ts";
import { readBookmarks, removeBookmarkUri, toggleBookmark } from "./bookmarks.ts";
import { actOnDevice, devicePolicy, ensureDeviceWatch, listDevices, type DeviceAct } from "./volumes.ts";
import { Sessions, discoverNetwork, gvfsDir, remotePolicy, remotesFromMounts, sameRemote } from "./remotes.ts";
import { runTool } from "./volumes.ts";
import { appsForAll, launchApp, mimeOf, setDefaultApp } from "./openwith.ts";
import { actionsFor, deleteAction, listActions, readAction, runAction, saveAction } from "./finderactions.ts";
import { fsRun, fsReadOp, fsJobs, fsPathsOf, fsGate, fsWantsJson } from "./fsroute.ts";
import { mediaFacts, posterFrame } from "./mediafacts.ts";
import { previewReview, publishReview, headerRun, publishNotes, cleanPublishOptions, type PublishDeps, type PublishRequest } from "./review-publish.ts";
import { browseDir, browseReal, fileBytes, fileFacts, previewSlice, openInDesktop, pagePolicy, revealInFileManager } from "./browse.ts";
import { fileGitFacts } from "./fileGit.ts";
import { benchEdit, benchEnd, benchLive, finderEditEnd, finderEditSave, finderEditState, readNote, writeNote } from "./bench.ts";
import {
  overview as dockerOverview, stats as dockerStats, logs as dockerLogs, inspect as dockerInspect, top as dockerTop,
  disk as dockerDisk, volumeDetail as dockerVolumeDetail, volumePeek as dockerVolumePeek, DOCKER_WRITE_ENABLED,
  envCompare as dockerEnvCompare,
  startContainer, stopContainer, restartContainer, removeContainer, dockerCapability,
} from "./docker.ts";
import { streamLogs } from "./dockerlogs.ts";
import { capBuildCache, removeImages } from "./dockerprune.ts";
import { inbox, markRead, markRepoRead, unsubscribe } from "./ghinbox.ts";
import { applyMarks, listMarks, parseMarkOps, talkAlreadyRead, MARK_KINDS } from "./marks.ts";
import { noteAsk as noteWatchAsk, startPrWatch } from "./prWatch.ts";
import { onPrChanged, deliverPrChanged } from "./prChanged.ts";
import {
  listWatches, addWatch, removeWatch, setPreset, applyPreset, sawMine, onTalkSeen as watchOnTalkSeen, pendingFires, ackFire,
  subscribeWatchChange, subscribeWatchFire, subscribeWatchChecks, startPrNotifyWatch, noteSync, dropSync,
} from "./prNotifyWatch.ts";
import { subscribeAskedAlerts, handleAskedAlertRoute } from "./askedAlerts.ts";
import { measureFile } from "./filemeasure.ts";
import { editorCursor } from "./editorwhere.ts";
import {
  listPrs, prDetail, prDiff, prAsset, ghCapability, submitReview, addComment, replyToThread,
  editComment, deleteComment, hideComment, unhideComment, setFileViewed, setAssignees, setMilestone, viewCounts, jobLog, checkJobs, checkFailures, cachedCheckFailures, failingTestsFor, rerunJobs, addLineComment, mentionables, facetOptions, applySuggestion, fileSlice,
  setThreadResolved, react, editPr, setLabels, setReviewers, setDraft, updateBranch,
  rerunFailedChecks, mergePr, closePr, unstickLook, unstickClose, unstickReopen, filesSince, compareDiff, treeAtTarget, codeowners, prepareReviewPrompt, pendingReviewFor, branchUrl, subscribeCi, subscribeTalk, commitDiff as prCommitDiff, submitReviewWith, prFileToTemp,
  prBaseOf,
  ghRateLimit,
  branchBehind, localHead, prRollup, prRowDetails, personBoard, refBranchRows, repoIdFor as prRepoIdFor, subscribeTalkSeen,
  prBranches, githubStatusCached, prsForBranch, prForHead, nodeIdOk, locateRepo, isForeignRoot, headRead, freshHead } from "./prs.ts";
import type { HeadRead } from "../../shared/headCompare.ts";
import { treeAtTar } from "./treeAt.ts";
import { planCheckOnBase, startCheckOnBase, checkOnBaseStatus, cancelCheckOnBase } from "./checkOnBasePr.ts";
import { checkoutBranches, repoSpend, spendRows } from "./spend.ts";
import { repoMetrics } from "./checkRuns.ts";
import { generateWalkthrough, WALKTHROUGH_ENABLED } from "./walkthrough.ts";
import { ptyOpen, ptyMessage, ptyClose, projectCommands, shutdownTerminals, lastTmuxTarget, sessionTitle, TERMINAL_ENABLED, PTY_BACKEND, type PtyWsData } from "./terminal.ts";
import { agentBinFor, mintAgentTicket } from "./agentticket.ts";
import { makeViewTempDir } from "./viewtemp.ts";
import { decodeImage } from "./imageUpload.ts";
import { transcribe, transcriberOn } from "./dictate.ts";
import { AGENT_KINDS, AGENT_PROVIDERS, agentKind } from "../../shared/agentKinds.ts";
/* Both sides' imports: main added five, this branch still uses `panesWithPids`
   and `reapMirrorSessions`. Neither list is a superset of the other. */
import { listPanes, withTmuxServer, focusPaneAnywhere, activePane, panesWithPids, sweepPinnedWindows, pinnedSockets, reapMirrorSessions, startMirrorSweeper, stopMirrorSweeper, socketPath, tmuxSockets } from "./tmuxctl.ts";
import { repairLast, snapshot } from "./tmuxsnapshot.ts";
import { withAgentSessions } from "./paneloc.ts";
import { notePaneFromHook, paneDirs, paneAgentNote, paneHeldSessions } from "./panewt.ts";
import { treeAuthors, liveSessions, recentSessions, editsBy } from "./sharedtree.ts";
import { paneStatus } from "./agentdone.ts";
import { windowRepo } from "./windowrepo.ts";
import { takeSpawnSlot } from "./spawncap.ts";
import { tmuxBinStatus, tmuxSocket, engineSocketArgs } from "./tmuxbin.ts";
import { applyTmuxConf, resetTmuxConf, confHealth, ensureConf, sweepStaleConfs } from "./tmuxconf.ts";
import { captureLayout, restoreLayout, clearRestoreState, lastCaptureAt, startRestoreSweeper, noteLaunch, forgetSession, noteCrashLoop, crashLoopStatus, launchesPath, captureLayoutSync } from "./tmuxrestore.ts";
import {
  windowTree, newWindow, splitPane, killWindow, killPane as killLayoutPane, selectWindow, selectPane,
  renameWindow, resizePane,
} from "./tmuxlayout.ts";
import { answer as answerRule, check as rulesCheck, ruleRoot as rulesRoot, setRule, setRulesDoor, view as rulesView, writeLaunchBase } from "./agentRulesStore.ts";
import { tmuxConfMode, tmuxOverride, tmuxRestoreEnabled, tmuxResume, tmuxSource, tmuxPrefix, tmuxTerminal, validTmuxPrefix, writeTmuxSettings, lanternNudge, lanternWatch, lanternWatchMinutes, cacheTtlMinutes, lanternNudgeMinutes, writeLanternSettings, LANTERN_NUDGE_MIN_MIN, LANTERN_NUDGE_MAX_MIN, seatWakeHours, writeSeatSettings, launchMode, launchDeny, writeLaunchPermissions, launchFlagOverrides, writeLaunchFlagOverrides, workerRoles, writeWorkerRole, inScopeReal, agentsChangeWithoutAsking, gateAnswerer, gateOnTimeout } from "./config.ts";
import { tellChair } from "./gatechair.ts";
import { claudeModels } from "./claudemodels.ts";
import { readOpens, recordOpens } from "./usageopens.ts";
import { startPaneSweeper, reloadEngineConf, engineWindowRunning, engineSessionName, validSessionName } from "./tmuxpane.ts";
import { findLiveWindow } from "./livewindow.ts";
import { reapLeases } from "./panelease.ts";
import { startScanner, ownsSession, knownProjects, projectsKnownAtStart, resyncScope, scanningEnabled } from "./transcripts.ts";
import { conflictPrompt } from "./conflictPrompt.ts";
import { workspaceRoot, workspaceRoots, setWorkspaceRoot, setWorkspaceRoots, inScope, sessionInScope, chatBypassAllowed, readBudgets, writeBudgets, hiddenProjects, setProjectHidden, setRepoDir, configuredRepoDirs, panelRepoDirs, configPath, repoDirsUnstated, seedRepoDirs, fileRoots } from "./config.ts";
import { cloneProject, createProject } from "./projectadd.ts";
import { budgetStatus } from "./budget.ts";
import type { Budget } from "../../shared/types.ts";
import { hookStatus, applyHooks, applyGate, hooksDir, hookPython, healGateCommand, gateInstalled } from "./hooksetup.ts";
import { probeAgents, probeEngines, testEngine, ROSTER } from "./agentprobe.ts";
import { join as joinPath, resolve as resolvePath, basename } from "node:path";
import { hostname } from "node:os";
import { privateHost, resolvePeer, originOf, guardedFetch, hostsOnly } from "./net.ts";
import { DESK_HEADER, claimDesk, deskHeld } from "./desk.ts";
import { readPolicy, writePolicy } from "./orchestration.ts";
import { makeDoor, type DoorAnswer } from "./settingsDoor.ts";
import { serverSettingDefs, cleanBudgets } from "./serverSettings.ts";
import { agentVerdict, classOf, NEEDS_APPROVAL } from "../../shared/settingClass.ts";
import { policyEngaged, startThroughPolicy, promptHeadless, startedByOf, settled, seatMayUse, workersAfterRestart, chairsAgain } from "./agents/policystart.ts";
import { armedWakeups, evaluate as evaluatePolicy, ruleStates, startPolicyEvaluator } from "./orchpolicy.ts";
import { resolveToken, healthProof, tokenOk, isIntake, isAuthExempt, callerFor, allowed, mayReadForeignRoot, scopeNeeded, pluginOfRequest, answersFromADevice, deskKeyOk, understudyRequiresToken, UNDERSTUDY_NO_TOKEN_ERROR, tokenlessWarning, type Caller, type Origin } from "./auth.ts";
import {
  listPlugins, masterEnabled, setMaster, installPlugin, installFromCatalogue, updatePlugin, enablePlugin, disablePlugin, removePlugin, setPluginUnboxedConsent, envAllowsUnboxed,
  contributesOf, isRunning, pluginSettings, pluginOwnSettings, savePluginSettings, resumeEnabledPlugins, stopAllPluginsSync, pluginIcon,
} from "./plugins.ts";
import { setPluginSocketHandler, viaPluginSocket } from "./plugin-socket.ts";
import { CanvasHandle, handleCanvasOps, isCanvasPanel, readBoundedJson, setCanvasResolver } from "./plugin-canvas.ts";
import {
  setPluginUiHook, setPanel, panelState, setOptions, pushEvent, takeEvents, upsertRun, upsertNotes, notesFor, answerNote, replyAsPlugin, resolveOwnNote, costByDay, decideRun, pressNoteAction, flushPluginNotes, summaryFor, headsToRead, markRunPublished,
} from "./plugin-ui.ts";
import { PANEL_ID_RE, PLUGIN_CONTRACT, validPrRef } from "../../shared/pluginUi.ts";
import { readNotifyPrefs, writeNotifyPrefs } from "./notifyPrefs.ts";
import { answerSessions, coerceRepos, normalizeRepo, RATE_PER_HOUR, sessionFacts, sessionReadRepos, sessionsGate, setSessionReadRepos, takeSessionsSlot } from "./prsessions.ts";
import { fetchCatalogue } from "./plugin-catalogue.ts";
import { annotate, setAnnotations } from "./inbox-annotations.ts";
import { accountsFor, accountsList, holderOf, manageRefusal, personMayPress, setAccounts, switchRefusal } from "./accounts.ts";
import {
  openStub, settleLedger, recordDecision, recordFence, scorecard,
  setMode, halt, setEnabled, enabled as understudyEnabled, sealSituation,
  consent, setAllowed, addExtraSource, SourceRefused, removeExtraSource, setNever, termsStatus,
  precedentCount, precedentsByClass,
  setProposeScope, quarantinedEver,
  judgeEnabled, setJudge, isOpenProjectPath, OPEN_PARTITION, openProjectName,
  bankByPartition, refileBank,
} from "./understudy.ts";
import { listSources } from "./understudy-sources.ts";

// A head or label change seen by any read the app already makes reaches the
// running plugins that write notes, as `pr-open` does. See prChanged.ts.
onPrChanged((ev) => deliverPrChanged(ev, listPlugins().map((p) => ({ name: p.name, running: p.running, prNotes: !!p.contributes.prNotes })), pushEvent));
/** The last ingest run, so the panel can say what it learned without re-reading
 *  a single file. Deliberately in memory and not on disk: it is a receipt for
 *  something that just happened, and a stale one after a restart would claim
 *  knowledge the bank may no longer match. */
let lastUnderstudyLearn: import("./understudy-ingest.ts").IngestResult | null = null;


/**
 * Which checkout on this machine is owner/name. The open project first, then
 * the picker's sweep; see the `/prs/locate` route for why in that order.
 */
function locateCheckout(want: string): Promise<{ ok: true; root: string } | { ok: false; error: string }> {
  return singleFlight(`locate:${want}`, async () => {
    const paths = getChanges(300, undefined, false).map((c) => c.file_path);
    const known = knownProjects().map((p) => p.path);
    /*
     * The open project FIRST, and it is not an optimisation.
     *
     * `ignoreScope` is the picker's sweep, and it deliberately leaves out
     * the scoped project and folds linked worktrees into the project they
     * belong to. Both of those are right for a picker and wrong here: the
     * pull request being read is usually in the project that is open, or
     * in one of its worktrees, and asking the picker's sweep for it
     * answered "no checkout of it on this machine" while the app was
     * showing that very repository.
     */
    const scoped = await discoverRepos(paths, known, {});
    const root = await locateRepo(want, scoped.map((r) => r.root))
      ?? await locateRepo(want, (await discoverRepos(paths, known, { ignoreScope: true })).map((r) => r.root));
    return root ? { ok: true as const, root } : { ok: false as const, error: `no checkout of ${want} on this machine` };
  });
}

/** Checkouts the loop may work in. The open project, and today only that. */
/**
 * The root a pull request route reads or acts through.
 *
 * A root out of scope falls back to the open project — right for a stale path,
 * and a confident wrong answer for `gh:owner/name`, the checkout-less root a
 * repository with no local copy is read by (see prs.ts): it is not a path, so
 * it is never "in scope", and the six routes below answered with the OPEN
 * project's spend, behind-count and conflicts for a pull request of the same
 * number in another repository. It is passed through as it is; whatever needs a
 * working tree refuses it there, in a sentence.
 */
function prRouteRoot(asked: string): string {
  if (isForeignRoot(asked)) return asked;
  return asked && inScopeReal(asked) ? asked : (workspaceRoot() ?? process.cwd());
}

async function openProjectRepos(): Promise<string[]> {
  const paths = getChanges(300, undefined, false).map((c) => c.file_path);
  const found = await discoverRepos(paths, knownProjects().map((p) => p.path), {});
  const roots = found.map((r) => r.root);

  /*
   * THE CHECKOUT THIS SERVER IS RUNNING FROM, which discovery never finds.
   *
   * `discoverRepos` works from telemetry — where work has recently happened
   * THROUGH the app — and from projects somebody has opened in it. On a
   * work machine both are work repositories: the open project gets worked
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
   * and on a work machine it is a work repository outside the open project,
   * because that is what the application is pointed at. Adding it here put thirty of their
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
   * and nowhere else, so the repository next to it is never so much
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

/*
 * His own agent, with his own tools, inside one worktree.
 *
 * No permission prompting, because there is no terminal to answer a prompt at
 * and a run that stalls waiting for one is a run that silently does nothing.
 * That is only defensible because of WHERE it runs: a worktree cut for this
 * task and thrown away if it goes wrong. Isolation is doing the work that a
 * permission dialogue would otherwise have to.
 */
import { ingest, IngestRefused, policySummary } from "./understudy-ingest.ts";
import { predictSealed } from "./understudy-predict.ts";
import { ask } from "./understudy-ask.ts";
import { judge, JUDGE_AVAILABLE } from "./understudy-judge.ts";
import { anyWorking, workingWhy } from "./agentworking.ts";
import { scopeAllows, activeDevices, markSeen, revokeDevice, revokeAllDevices, devices, publicDevice, whenStoreTampered, type Scope } from "./devices.ts";
import { credentialsPath, hasCredential, hasStoredCredential, notConnected } from "./credentials.ts";
import { startCardWatch, cardForTitle } from "./clickupwatch.ts";
import * as CardIndex from "./clickupindex.ts";
import * as AgentBoard from "./agentboard.ts";
import { boardNow, fieldReadout, lanternChat, noteLanternSession, hookSaysLantern, isLanternSession } from "./lantern.ts";
import { hookSaysSeat, isSeatSession, noteSeatSession } from "./seatrole.ts";
import * as Seat from "./seat.ts";
import { readDoctrine, writeDoctrine } from "./seatdoctrine.ts";
import { readBrief, writeBrief } from "./seatbrief.ts";
import * as SeatQueue from "./seatqueue.ts";
import * as SeatInbox from "./seatreport.ts";
import * as SeatNeeds from "./seatneed.ts";
import * as SeatWake from "./seatwake.ts";
import { recall } from "./seatmemory.ts";
import * as AgentOps from "./agentops.ts";
import { nudgeText, nudgeChannel, sendNudge } from "./prnudge.ts";
import * as Schedule from "./agentschedule.ts";
import { handoffBrief } from "./handoff.ts";
import { startLanternWatch, restartLanternWatch, lastLook } from "./lanternwatch.ts";
import { installServerLog, readEntries } from "./serverlog.ts";
import { digest as logDigest } from "./logdigest.ts";
import { mintTicket, claimTicket, pending as pendingPairings, acceptTicket, rejectTicket, collect as collectPairing, dropTicket, getTicket, MAX_ATTEMPTS } from "./pairing.ts";
import { buildInfoPaths, updateStatus, viewerStatus, startUpdate, updateLog, releaseNotes } from "./selfupdate.ts";
import { rateOk } from "./ratelimit.ts";
import { noteClient, noteSocket, isLoopback, isSelf, isBlocked, blockDevice, remoteStatus, tailnetNames, refreshTailscale, refreshTailscaleIfStale, enableServe, TAILNET_OK_MS, proxiedByTailscaled, loopbackPeerIsOtherUser } from "./remote.ts";
import { parseWindowMs } from "./params.ts";
import { serveWeb, serveIndex, WEB_UI_ENABLED, distPath } from "./webui.ts";
import { notifyCapability, subscribeNotifications, notifyWatching, openNote } from "./notifications.ts";
import { markIgnored } from "./ignored.ts";
import { withEvidence } from "./evidence.ts";

import { tidyReport } from "./tidy.ts";
const PORT = Number(process.env.AGENTGLASS_PORT || 4000);
// Before anything can log: the errors this server recovers from are the ones
// nobody was watching stderr for.
const SERVER_LOG = installServerLog();
let logDigestCache: { at: number; value: ReturnType<typeof logDigest> } | null = null;
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
/** The upgrade's one seeding of the picker's folders, shared by every read that
 *  asks at once. See the /git/repos route. */
let pickerSeed: Promise<void> | null = null;

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
type WsData = ({ kind: "events" } | { kind: "notify" } | { kind: "canvas"; handle?: CanvasHandle } | PtyWsData) & { ip?: string | null; deviceId?: string | null };
/** The docker reads that start a process per request and have no cache or
 *  single-flight in front of them. See spawncap.ts. */
const DOCKER_SPAWNS = new Set([
  "/docker/disk", "/docker/volume", "/docker/volume/peek", "/docker/env-diff",
  "/docker/inspect", "/docker/top", "/docker/logs",
]);

const clients = new Set<ServerWebSocket<WsData>>();
/** Writes through /control (a settings change, a staged level 3 door), per caller (control.ts). */
const controlWriteLimit = makeWriteLimiter();
/**
 * How far /control may go, read ONCE here, when the process starts. Nothing
 * below re-reads the environment, and nothing in this file, the registry or a
 * settings def assigns to it, so a running server cannot be talked into a
 * higher level by anything that reaches it, an agent with the machine token
 * included. The owner changes it the only way it can change: by restarting the
 * server with another value (server/test/control-levels.test.ts pins this).
 */
const CONTROL = controlSwitch();
/** Connections to remotes in flight: see remotes.ts. After one mounts, its path is read back from what gio says is mounted. */
const remoteSessions = new Sessions(undefined, async (uri) => {
  const g = await runTool(["gio", "mount", "-l"]);
  let entries: string[] = [];
  try { entries = readdirSync(gvfsDir()); } catch { /* none */ }
  return remotesFromMounts(g.out, entries, gvfsDir()).find((r) => sameRemote(r.id, uri))?.mountPoint;
});
// A variable that was set to something unreadable has already failed closed
// (control.ts); the owner hears it once, here, with the value and what is held.
for (const w of CONTROL.warnings) console.warn(`agentglass: ${w}`);
/** Refusals of /control, one /actions row per caller per minute with a count of the rest. */
const controlRefusals = makeRefusalThrottle();
/**
 * The sockets a /control frame goes to: windows that said hello (web/src/lib/
 * useLive.ts does on every connect), not every /stream listener. A control frame
 * carries the request id a reply must echo, and a listener that never said
 * hello (a paired phone, a second tool that only watches events) has no business
 * holding it. The ceiling: any local holder of the machine token can say hello
 * too, so this keeps the id off sockets that merely watch, and does not make the
 * reply channel authenticated per window.
 */
function controlWindows(): ServerWebSocket<WsData>[] {
  return [...browserSockets.values()].filter((w) => clients.has(w));
}
function sendControl(frame: WsFrame): void {
  const msg = JSON.stringify(frame);
  for (const w of controlWindows()) { try { w.send(msg); } catch { /* the sweep drops a dead socket */ } }
}

/**
 * The settings door (settingsDoor.ts): one way for an agent to change any
 * setting, where the ones that widen what agents may do wait for the person.
 * A window setting the person approved goes back to the windows as a settings.set
 * carrying `grant`, a frame field only this server writes.
 */
async function grantedWindowSet(id: string, value: unknown, expect?: unknown): Promise<{ ok: true } | { ok: false; error: string }> {
  if (controlWindows().length === 0) return { ok: false, error: "no window is open to apply it; open the app and ask again" };
  const rid = nextControlRid();
  const data = { cmd: "ui", do: "settings.set", args: { id, value } } as unknown as ControlCmd;
  const reply = await awaitControl(rid, () => sendControl({ type: "control", data, rid, present: "quiet", level: CONTROL.level, grant: true, ...(expect !== undefined ? { expect: expect as string | number | boolean } : {}) }));
  return reply.ok && reply.applied ? { ok: true } : { ok: false, error: reply.error ?? "the window did not apply it" };
}
/** What a window holds for one of its settings, for the card's "from" side. A
 *  socket posing as a window can lie here; the window that applies a grant checks
 *  its own value against it, so a lie makes a card that applies nothing. */
async function windowValue(id: string): Promise<unknown> {
  const rid = nextControlRid();
  const data = { cmd: "ui", do: "settings.get", args: { id } } as unknown as ControlCmd;
  const reply = await awaitControl(rid, () => sendControl({ type: "control", data, rid, present: "quiet", level: CONTROL.level }));
  const v = reply.ok ? (reply.value as { value?: unknown } | undefined)?.value : undefined;
  return typeof v === "string" || typeof v === "number" || typeof v === "boolean" ? v : undefined;
}
const settingsDoor = makeDoor({
  defs: () => serverSettingDefs({
    terminalEnabled: TERMINAL_ENABLED,
    budgetWrites: BUDGET_WRITE_ENABLED,
    // Editing the rules is an event too: settle their switches and wake-ups, and
    // a chain with an engine added is a plan back for a chair that had none.
    policyChanged: () => { void evaluatePolicy().catch(() => {}); void chairsAgain().catch(() => {}); },
  }),
  trusted: agentsChangeWithoutAsking,
  applyWindow: grantedWindowSet,
  changed: () => broadcast({ type: "settings-requests" }),
});
setRulesDoor(settingsDoor);
/** gateInstalled() reads ~/.claude/settings.json; the rules check asks it on every tool call. */
let gateSeen = { at: 0, on: false };
const gateInstalledCached = (): boolean => {
  if (Date.now() - gateSeen.at > 10_000) gateSeen = { at: Date.now(), on: (() => { try { return gateInstalled(); } catch { return false; } })() };
  return gateSeen.on;
};

/** A window's own name for itself (its `hello`) to its latest socket, which is
 *  how a browser ask reaches one window instead of all of them. */
const browserSockets = new Map<string, ServerWebSocket<WsData>>();
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
    // The desk's header is the desktop app's renderer answering a gate from its
    // own scheme, which is a cross-origin request here (desk.ts).
    "Access-Control-Allow-Headers": `content-type, authorization, ${DESK_HEADER}`,
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

/**
 * Who may say "I am a window that can drive a browser". Registering decides who
 * receives every ask — fill text and URLs included — so it is not a thing the
 * machine token buys: every agent shell holds that. Where the desktop app
 * started this server, only the app's own renderer holds the key (desk.ts) and
 * an Origin opens nothing. On a server started by hand there is no key, and the
 * Origin rule is all there is: it turns away the Origin-less `curl` and lets a
 * deliberate forgery through, the limit SECURITY.md states for such a server.
 */
/*
 * Where the desktop app ADOPTS a server that was already running (electron/
 * main.js pickPort, `adopt`), that server was never piped a key; the app claims
 * one on /desk/claim and holds it while it runs (desk.ts, and its ceiling:
 * whoever claims first holds it). With no claim held, the Origin rule below is
 * all there is. SECURITY.md says
 * the same.
 */
function mayHostBrowser(req: Request): boolean {
  if (deskHeld()) return deskKeyOk(req);
  const o = req.headers.get("origin");
  return !!o && vouchedOrigin(o);
}

/**
 * Who may change the orchestration policy: the person. It decides which engine
 * runs, what a worker may do and when that changes, so it is closed to every
 * credential an agent on this machine holds: the machine token (every agent
 * shell has it), a seat's, an understudy's, a plugin's. A paired device with
 * the full grant was minted at the desk with somebody looking; the desktop
 * app's own window holds the desk key, or, on a hand-started server with no
 * key, speaks from the app's origin (the limit SECURITY.md states for one).
 */
function mayChangePolicy(req: Request, caller: Caller | null): boolean {
  if (caller?.principal || caller?.kind === "plugin") return false;
  if (caller?.kind === "device") return scopeAllows(caller.scope, "full");
  return mayHostBrowser(req);
}

/**
 * Who may post a local review to GitHub: the person's own click, the same
 * people as the policy and nobody else. Every credential an agent on this
 * machine holds is refused: the machine token, a seat's, an understudy's, a
 * plugin's, and any request that presents an agent's name. The ui-control door
 * lists this action as refused for agents (UI_REFUSED_FOR_AGENTS).
 */
function mayPublishReview(req: Request, caller: Caller | null): boolean {
  if (req.headers.get("x-agentglass-agent")) return false;
  return mayChangePolicy(req, caller);
}

/**
 * Who asked for a settings change, as the person's request card says it: a
 * worker by the name the registry holds for it, a seat by its project, else the
 * label a CLI stamped (`--as`, the closed charset callerRequestId allows) marked
 * as the caller's own word for itself. Never a free sentence from the body.
 */
function askerOf(req: Request, caller: Caller | null, as: unknown): string {
  const worker = presentedWorker(req);
  if (worker) return `worker ${worker}`;
  if (caller?.principal === "seat" && caller.seat) return `the chair of ${basename(caller.seat.root)}`;
  if (caller?.kind === "plugin") { const name = pluginOfRequest(req, new URL(req.url)); return name ? `plugin ${name}` : "a plugin"; }
  const label = callerRequestId(as);
  return label ? `an agent calling itself "${label}"` : "an unnamed agent";
}

/** A project root as a policy key: absolute and plain, or nothing. */
function policyRoot(v: unknown): string | undefined | null {
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v !== "string" || v.includes("\0") || !v.startsWith("/") || v.length > 500) return null;
  return resolvePath(v);
}

function localOrigin(req: Request): boolean {
  const o = req.headers.get("origin");
  if (!o) return !crossSiteSubresource(req);
  return vouchedOrigin(o);
}

/**
 * A browser loading this server as a subresource of somebody else's page.
 *
 * A simple GET (an `<img>`, a `<script>`) carries no Origin, so on a server
 * with no token it passed the Origin rule as if it were curl, and a page the
 * person merely visited could make the server spend their ClickUp and GitHub
 * budgets or run a read with side effects. Every current browser says where a
 * request came from in Sec-Fetch-Site, and curl, the hooks and the CLIs send
 * none; a top-level navigation (a link to the UI) is still let through.
 *
 * Only where there is no token. With one, such a request carries none and the
 * token gate answers 401, while the desktop renderer, which is cross-site to
 * loopback, loads avatars as `<img>` with the token in the URL and no Origin;
 * refusing it here would blank them. The ceiling: a desktop app that adopted
 * a server started by hand without a token shows no avatars from it.
 */
function crossSiteSubresource(req: Request): boolean {
  return !AUTH_TOKEN && req.headers.get("sec-fetch-site") === "cross-site" && req.headers.get("sec-fetch-mode") !== "navigate";
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
 * A caller as the action log wants it. `Caller.kind` grew a third value —
 * `plugin`, see auth.ts — and ActorSource has two. A plugin's token was logged
 * as an unnamed device before, which came out as the address it arrived from;
 * it still does, because a plugin has no `device` to name, and the log line is
 * about WHERE a write came from when nobody can be named. What changed is the
 * gate (answersFromADevice), not the log.
 */
function asActor(c: Caller | null | undefined): ActorSource | null {
  if (!c) return null;
  if (c.principal === "seat" && c.seat) return { kind: "machine", seat: basename(c.seat.root) };
  return c.kind === "plugin" ? { kind: "device" } : { kind: c.kind, device: c.device };
}

/** The name a request presents as its own (`X-Agentglass-Agent`, set by the
 *  CLI from AGENTGLASS_AGENT_NAME), when it is a policy-started worker's. Such a
 *  caller may not start workers or touch the seat (a role's TUI worker from
 *  before the policy still reports to its seat, so it is not counted here). This stops a worker that uses the CLI
 *  as it is; it does not stop one that means to get past it. The header is the
 *  worker's to send or leave out, the token file is readable by anything that
 *  runs as this user, and an engine's command rules are prefixes, so a request
 *  without the header is the person's as far as this server can tell
 *  (SECURITY.md, "A worker role"). */
function presentedWorker(req: Request): string | null {
  const n = req.headers.get("x-agentglass-agent");
  const w = n ? AgentOps.agentNamed(n) : null;
  return w && startedByOf(w) ? w.name : null;
}

/** A seat's own chair: the row it sits in, the pane it was adopted in, or a
 *  name only a chair carries. No seat owns one, its own included: a seat that
 *  could would prompt, key or kill another project's orchestrator, which runs
 *  with permissions skipped. */
function isChair(a: { name: string; paneId: string }): boolean {
  return Seat.isSeatName(a.name) || Seat.everySeat().some((s) => s.name === a.name || (!!s.adoptedPane && s.adoptedPane === a.paneId));
}

/** A seat reaches only the agents it owns. One nobody owns (an enlisted tab,
 *  one the person started, one from before owners existed) waits for a seat to
 *  say `own` on purpose; one another project's seat owns is not its to read,
 *  prompt, key or stop. */
function notYours(c: Caller | null | undefined, a: AgentOps.NamedAgent): string | null {
  if (c?.principal !== "seat" || !c.seat) return null;
  if (!a.seatRoot) return `${a.name} has no owner yet; adopt it first: agentglass-agent own ${a.name}`;
  if (a.seatRoot === c.seat.root) return null;
  return `${a.name} belongs to the seat of ${basename(a.seatRoot)}, not to yours (${basename(c.seat.root)}). Ask that seat, or the person.`;
}

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
 *   * or, where the desktop app started this server, **the app's key**
 *     (desk.ts): minted for each sidecar, handed down a pipe to this process
 *     and through the preload to the renderer, in no file, environment or argv
 *     an agent can read. A server the app adopted instead holds the key the app
 *     claimed for it, while the app holds the claim (desk.ts, and its ceiling). There an Origin opens nothing. It used to, and a header
 *     is a string: `curl -H "Origin: agentglass://app"` with the machine token
 *     released the agent's own call, for the helpful agent that reads "approve
 *     it" as the next step and for the one an injected instruction sends alike.
 *     The device store above it is read once, at start, for the same reason:
 *     a row planted in devices.json afterwards is not a device (devices.ts).
 *   * or, on a server started by hand and not claimed, an **Origin** this
 *     server vouches for. There is no key, and the client a person uses
 *     there without pairing first is a browser, which attaches `Origin` to
 *     every POST and cannot hold a secret an agent on the same machine could
 *     not read as well. That keeps the obvious `curl` out and lets a deliberate
 *     forgery through: the limit SECURITY.md states for a hand-started server.
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
function mayReleaseAHold(req: Request, caller: Caller | null): boolean {
  if (answersFromADevice(caller)) return true;
  if (deskHeld()) return deskKeyOk(req);
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
const treeCache = new Map<string, { at: number; text: string; sig: string }>();
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

/*
 * Who is writing into each of the listed checkouts, and where that is more
 * than one live session.
 *
 * Rides on the working list rather than being a route of its own because the
 * list is the thing it qualifies: a section heading that names one branch and
 * may be two authors' work. The panes are read at most every ten seconds — the
 * list itself is re-read every two, and `listPanes` is up to four tmux spawns
 * per live socket plus a walk of /proc per pane (`withTmuxServer` is still one
 * blocking ask per server), none of it worth a late keystroke in the terminal
 * that shares this thread. An agent arriving in or
 * leaving a pane is a ten-second question; the edits are read forward from
 * the last rebuild, so each one costs this thread only the events since
 * (sharedtree.ts).
 *
 * Names are held for a minute for the same reason: a nameless session's name
 * is its first decent prompt, found by parsing its prompts, and a name changes
 * about once in a session's life.
 *
 * Advisory, so it can never cost the list: a failure here is no authors, not an
 * empty Diff view.
 */
const PANES_HELD_TTL_MS = 10_000;
const NAMES_TTL_MS = 60_000;
let panesHeld: { at: number; ids: Set<string> } | null = null;
const authorNames = new Map<string, { at: number; name: string }>();
async function authorsNow(repos: GitRepoRef[], rows: ChangeRow[]): Promise<TreeAuthorsInfo[]> {
  try {
    if (!panesHeld || Date.now() - panesHeld.at > PANES_HELD_TTL_MS) {
      let ids = new Set<string>();
      try { ids = paneHeldSessions(withTmuxServer(await listPanes(lastTmuxTarget()?.socket))); } catch { /* no tmux: last-seen alone decides */ }
      panesHeld = { at: Date.now(), ids };
    }
    const live = liveSessions(recentSessions(), panesHeld.ids);
    // The list's own rows, by the list's own key: an edit whose file has been
    // committed since is not a row, and makes nobody an author. A list cut at
    // ROWS_MAX can miss an author whose files fell past the cut.
    const keys = new Set(rows.map((r) => r.key));
    const trees = treeAuthors(editsBy([...live]), repos.map((r) => ({ path: r.root })), (id) => live.has(id),
      (root, rel) => keys.has(`${root}\0${rel}`));
    if (!trees.length) return [];
    const now = Date.now();
    const ids = [...new Set(trees.flatMap((t) => t.sessions))];
    const stale = ids.filter((id) => (authorNames.get(id)?.at ?? 0) < now - NAMES_TTL_MS);
    if (stale.length) {
      const got = sessionNames(stale);
      if (authorNames.size > 500) authorNames.clear();
      for (const id of stale) authorNames.set(id, { at: now, name: got.get(id) ?? id.slice(0, 8) });
    }
    const name = (id: string) => authorNames.get(id)?.name ?? id.slice(0, 8);
    return trees.map((t) => ({
      root: t.root,
      sessions: t.sessions.map((id) => ({ id, name: name(id) })),
      overlap: t.overlap.map((o) => ({ path: o.path, sessions: o.sessions.map(name) })),
    }));
  } catch { return []; }
}

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

// Read once, now: a row planted in the file after this is not a device (devices.ts).
whenStoreTampered(pushDeviceStoreChanged);
devices();

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
setBrowserSink({
  send: (ask, clientId) => {
    const ws = browserSockets.get(clientId);
    if (!ws || !clients.has(ws)) return false;
    try { return ws.send(JSON.stringify({ type: "browser", data: ask } satisfies WsFrame)) !== 0; } catch { return false; }
  },
  listeners: () => clients.size,
  live: (id) => { const w = browserSockets.get(id); return !!w && clients.has(w); },
});
// The task store has a second writer — the user's editor — so a change there
// reaches the panel through a sweep rather than through anything we did.
setTaskChangeHook(() => broadcast({ type: "tasks" }));
// A reminder that fired changes what the panel and the rail should show, and
// the panel is not necessarily open — so it is pushed, like everything else
// that happens without the user asking.
setReminderHook(() => broadcast({ type: "tasks" }));
// Every way the pending list changes (a hold arrives, is decided, times out, or a
// rule answers it) rings the clients, so they re-read it instead of polling.
onGateChange(() => broadcast({ type: "gate" }));
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
  "/desk/claim",
]);
// `/jira/connect` by name and not `/jira/` by prefix: it is the one Jira route
// that receives a token, and the card routes that follow should be recorded.
const UNDERSTUDY_BLIND = new Set(["/control", "/control/result", "/providers", "/pair", "/jira/connect", ...UNDERSTUDY_MACHINE]);
function understudyBlind(pathname: string): boolean {
  return UNDERSTUDY_BLIND.has(pathname) || UNDERSTUDY_BLIND_PREFIXES.some((p) => pathname.startsWith(p));
}

/**
 * Which class a write on the git and pull-request chokepoints belongs to.
 *
 * Local to this file and NOT a `classFor(route)` in understudy.ts, for the
 * reason written on `UnderstudyClass.routes`: one route can serve two
 * classes, so a general route-to-class map has to guess at exactly the route
 * that matters most. Every name below is unambiguous — a merge is a merge — which is
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
  const data = withEvidence(open);
  /* Only when the list, evidence included, differs from the last one sent:
     with a call open, 15 byte-identical frames a minute went to every client
     (measured). A client that connects later gets the list in `initial`. */
  const sig = JSON.stringify(data);
  if (sig === lastOpenSent) return;
  lastOpenSent = sig;
  broadcast({ type: "openTools", data });
}
let lastOpenCount = 0;
let lastOpenSent = "";
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
  /* The compiled binary has no `../../build-info.json` next to its module; the
     file sits beside the executable, where selfupdate looks. Measured: /health
     answered build:"" on an installed app until this used the same list. */
  stampCache = "";
  /* The checkout's own file first: a stale staged copy must not win there. */
  for (const p of [new URL("../../build-info.json", import.meta.url).pathname, ...buildInfoPaths()]) {
    try {
      const commit = String(JSON.parse(fsRead(p, "utf8")).commit || "");
      if (commit) { stampCache = commit; break; }
    } catch { /* not here — try the next place */ }
  }
  return stampCache;
}

/**
 * The main server's whole request handler, factored out of `Bun.serve`'s
 * own `fetch` so the plugin socket (plugin-socket.ts) can hand it a request
 * too — a boxed `network: "agentglass"` plugin's bridge dials that socket,
 * never this port, and everything below still has to answer it exactly the
 * way it would answer a stranger on the tailnet. `srv` is typed loosely
 * enough (`Server<WsData>`) that the plugin socket's own fake one — no
 * address, no real port, `upgrade` that always fails — satisfies it without
 * this function ever knowing which caller it is talking to.
 */
async function handleServerRequest(req: Request, srv: Server<WsData>): Promise<Response> {
    const url = new URL(req.url);
    const { pathname } = url;
    // Name this request for the loop watchdog: if the loop stalls in the next
    // moment, the stall is reported against this path instead of being one more
    // anonymous freeze in a terminal. See loopwatch.ts.
    const mark = entered(`${req.method} ${pathname}`);
    try { return await (async () => {

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
      error: "a held call is released by a person, not by the process being held — " + (deskHeld()
        ? "the desktop app holds this server's desk, and it takes that from the app's own key or a "
          + "paired-device credential; this request carried neither, whatever its Origin says. "
          + "Answer it in the desktop app, or on a paired phone or browser."
        : "this request carried no Origin and no paired-device credential, which is "
          + "what an agent's own shell looks like. Answer it in the desktop app, in the "
          + "web UI, or on a paired phone."),
    }, 403);
    // A `gh:` root reaches past the open project: see mayReadForeignRoot.
    const foreignRefused = () => json({ ok: false, error: "a repository outside the open project needs full access" }, 403);
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
    // LOCAL_SINKS's exemption reasons on "same-user processes can already read
    // the token file" — which is not true of another account, or a
    // host-networked container under a different uid, dialing loopback. Only
    // the sink exemption narrows on that; every other use of `from` (device
    // list, Block, the network-bind warning) is unchanged, on purpose — see
    // loopbackPeerIsOtherUser in remote.ts.
    const sinkFrom: Origin =
      from === "loopback" && loopbackPeerIsOtherUser(peerSock, srv.port ?? PORT) ? "remote" : from;
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
    //
    // A live plugin token over the plugin socket is the one exception, added
    // for plugin-socket.ts: a boxed `network: "agentglass"` plugin's request
    // always arrives as `from === "remote"` — the whole point of that socket
    // is that it is never mistaken for this machine — even on a zero-config
    // box with no `AGENTGLASS_TOKEN` set, where every plugin used to reach
    // this route over REAL loopback instead. `pluginOfRequest` only ever
    // answers for a token this process itself minted, so checking it alone
    // widens nothing an attacker could hand it directly — but a plugin token
    // travels as `?token=` too, and behind `tailscale serve` a leaked one used
    // to work from the whole tailnet on this real TCP port, where before it
    // got 401. `viaPluginSocket` is true only for the exact request object
    // `plugin-socket.ts`'s own `socketFetch` built for THIS call, so the
    // exemption now requires both: a real plugin credential AND the socket
    // that is the only place this process ever hands one out to answer with.
    if (!AUTH_TOKEN && from === "remote" && !isAuthExempt(pathname, sinkFrom) && !(viaPluginSocket(req) && pluginOfRequest(req, url))) {
      return json({ ok: false, error: "unauthorized — this server has no token configured and only answers local callers" }, 401);
    }
    // A plugin token gets a caller, and so the scope check below, even when no
    // machine token is configured: `caller` left null reads everywhere
    // downstream as "the machine", so on a zero-config server a read-scoped
    // plugin over the plugin socket reached a full-scope route (measured:
    // `POST /plugins/master` answered 200; with a machine token set the same
    // call is 403).
    if ((AUTH_TOKEN || pluginOfRequest(req, url)) && !isAuthExempt(pathname, sinkFrom)) {
      caller = callerFor(req, url, AUTH_TOKEN ?? "");
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
        if (caller.principal === "seat") {
          /* Its own sentence for the same reason the clone has one: the seat
             has no scope to widen, it has powers, and the fix is a setting on
             the project's chair — said here so whoever reads the 403 in a
             pane is told where to go. */
          recordFence(pathname, req.method);
          return json({
            ok: false,
            error: `the orchestrator's seat may not ${req.method} ${pathname}: this chair is set to "${caller.seat?.powers ?? "speak"}"`,
          }, 403);
        }
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
      // Here for a root in the query; the POST routes that read one from the
      // body ask the same question once they have parsed it.
      if (isForeignRoot(url.searchParams.get("root") ?? "") && !mayReadForeignRoot(caller)) return foreignRefused();
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

    // Every /git/ read that names a repository is held to the open project —
    // see gitReadRefusal.
    const gitRefused = gitReadRefusal(caller, req.method, pathname, url.searchParams);
    if (gitRefused) return json(gitRefused, 403);

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
    // Every live panel's scene, over ONE private socket (plugin-canvas.ts).
    // Gated like /plugins/panels: FULL_GET for scope, a plugin's own token
    // refused by kind, and the same origin check as /stream.
    if (pathname === "/plugins/panels/live") {
      if (!trustedCaller(req, from)) return csrfBlocked();
      if (srv.upgrade(req, { data: { kind: "canvas", ip: clientIp ?? null, deviceId: caller?.device?.id ?? null } })) return undefined as unknown as Response;
      return new Response("upgrade failed", { status: 426 });
    }
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
        worker: presentedWorker(req),
        local: peer.source === "socket" && !!clientIp && isLoopback(clientIp) && sinkFrom === "loopback",
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
        note: url.searchParams.get("note") === "1",
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
      // The marker above is claimable by any process that binds the port
      // first, so the shell also asks for proof this server holds the token
      // before it adopts it and sends that token here (auth.ts healthProof).
      // A tokenless server has nothing to prove with and answers without it.
      const challenge = url.searchParams.get("challenge");
      // Only to a direct loopback peer: the shell asks over 127.0.0.1, and
      // answering anyone else turns /health into a signing service a squatter
      // could relay a challenge to through the LAN or tailnet address.
      const direct = peer.source === "socket" && !!clientIp && isLoopback(clientIp);
      const proof = challenge && challenge.length <= 128 && AUTH_TOKEN && direct
        ? healthProof(AUTH_TOKEN, srv.port ?? PORT, challenge) : undefined;
      return json({
        ok: true, service: "agentglass", clients: clients.size,
        notifyWatching: notifyWatching(), build: buildStamp(), proof,
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
      /* The seat is the board's other reader, and gets set aside for the same
         reason: an orchestrator that shows up among the agents it is keeping
         would be reminded to say what it is on, and counted as somebody's
         work. Its mark is the first line of a prompt this server composed,
         so no session can talk its way into the role. */
      const seatItself = hookSaysSeat(body) || isSeatSession(String(body.session_id ?? ""));
      if (seatItself) noteSeatSession(String(body.session_id ?? ""));
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
      const workspaces = workspaceRoots();
      const projects = knownProjects().filter((p) => inScope(p.path, workspaces));
      // `scanning` is what this process is actually doing, not what it was
      // configured to do: it is also false when another live server holds the
      // database file and this one stood its scanner down. `workspace` is the
      // first open project, kept for the callers that only ever had one.
      return json({ projects, scanning: scanningEnabled(), workspace: workspaces[0] ?? null, workspaces });
    }
    // Pick the projects this cockpit is about (or none → the whole machine).
    // Applied live and persisted for the next launch. `roots` is the list the
    // picker sends; `root` is the one-project shape older clients still send.
    if (pathname === "/workspace" && req.method === "POST") {
      if (!trustedCaller(req, from)) return csrfBlocked();
      let b: any = {};
      try { b = await req.json(); } catch { return json({ ok: false, error: "invalid json" }, 400); }
      const res = Array.isArray(b.roots) ? setWorkspaceRoots(b.roots)
        : setWorkspaceRoot(b.root == null ? null : String(b.root));
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
    // Add a folder the picker lists projects from, or forget one. Only the
    // config file changes; the folder is never touched either way.
    if (pathname === "/projects/roots" && req.method === "POST") {
      if (!trustedCaller(req, from)) return csrfBlocked();
      let b: any = {};
      try { b = await req.json(); } catch { return json({ ok: false, error: "invalid json" }, 400); }
      const res = setRepoDir(b.path, b.added !== false);
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
     * What this machine has of each engine and what each can do: version,
     * account names, the roles it can take, and the next thing to fix. Cheap
     * and read-only; `?fresh=1` is Recheck and skips the cache; `?fresh=hermes` rechecks one engine. Never polled.
     */
    if (pathname === "/engines" && req.method === "GET") {
      const fresh = url.searchParams.get("fresh");
      const report = await probeEngines({ fresh: fresh === "1" ? true : fresh ? fresh.split(",") : false });
      // An engine signed in is how a chair gets its plan back: take its card down now.
      void chairsAgain().catch(() => {});
      return json(report);
    }

    /**
     * The one-line test: one real turn on the engine's own login, so a person
     * asks for it and nothing runs it by itself. One at a time per engine.
     */
    if (pathname === "/engines/test" && req.method === "POST") {
      if (!trustedCaller(req, from)) return csrfBlocked();
      let b: { engine?: unknown };
      try { b = (await req.json()) as { engine?: unknown }; } catch { return json({ ok: false, error: "invalid json" }, 400); }
      const engine = typeof b.engine === "string" ? b.engine : "";
      const r = await testEngine(engine);
      noteAction(clientIp, "/engines/test", { engine }, r, asActor(caller));
      return json(r, r.error === "no such engine" ? 400 : 200);
    }

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
    if (pathname === "/agents/board") {
      /* Every source at once — see lantern.ts, which the terminal's "Ask
         about the field" reads too, so the view and the chat cannot disagree. */
      return json({ ok: true, agents: await boardNow(), chairs: await Seat.chairsNow(), watch: lastLook(), cacheTtlMinutes: cacheTtlMinutes() });
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
     * A PERSON CLEARING A LINE, whoever posted it.
     *
     * `done` above is the agent's own way out and is keyed on its session,
     * because that route is tokenless on loopback whatever the install. This
     * one is authenticated like every other route: behind the token where one
     * is set, and on a loopback-only install without one, open to local
     * callers like the rest. A line whose session ended without saying done —
     * the case the board filled up with — can then be taken off by the person
     * at the view.
     */
    if (pathname === "/agents/forget" && req.method === "POST") {
      if (!trustedCaller(req, from)) return csrfBlocked();
      const b = await req.json().catch(() => ({})) as Record<string, unknown>;
      const name = String(b.name ?? "").slice(0, 512).trim();
      if (!name) return json({ ok: false, error: "which agent?" }, 400);
      const cleared = AgentBoard.dropLine(name);
      return json(cleared ? { ok: true, cleared: true } : { ok: false, error: "no line by that name" }, cleared ? 200 : 404);
    }

    /*
     * THE LANTERN'S OWN SETTINGS — whether hooked sessions get asked what they
     * are doing, and how often. Read by the Agents pane in Settings; written
     * by it too. Nothing else here is configurable on purpose: the view is a
     * screen you read, and this is the one thing about it that costs a session
     * something (one line of attention every interval).
     */
    // What the server's own error log says: recurring errors, crash loops, spikes.
    // Read-only, and the badge that shows it is quiet by design — never a notification.
    if (pathname === "/logs/digest" && req.method === "GET") {
      // Cached for 10 s: the Settings window asks on every open, and the answer
      // is a fold of up to 2 MB of JSON lines.
      const t = Date.now();
      if (!logDigestCache || t - logDigestCache.at > 10_000) {
        logDigestCache = { at: t, value: logDigest(SERVER_LOG ? readEntries(SERVER_LOG) : [], t) };
      }
      return json(logDigestCache.value);
    }
    if (pathname === "/lantern/settings" && req.method === "GET") {
      return json({ ok: true, nudge: lanternNudge(), minutes: lanternNudgeMinutes(), watch: lanternWatch(), watchMinutes: lanternWatchMinutes(), cacheTtlMinutes: cacheTtlMinutes(), min: LANTERN_NUDGE_MIN_MIN, max: LANTERN_NUDGE_MAX_MIN });
    }
    if (pathname === "/lantern/settings" && req.method === "POST") {
      if (!trustedCaller(req, from)) return csrfBlocked();
      let b: any = {};
      try { b = await req.json(); } catch { return json({ ok: false, error: "invalid json" }, 400); }
      /* An agent's change goes through the settings door: these spend tokens. */
      if (!mayPublishReview(req, caller)) {
        const who = askerOf(req, caller, b?.as);
        const rs: DoorAnswer[] = [];
        for (const [k, id] of [["nudge", "lantern.nudge"], ["minutes", "lantern.nudgeMinutes"], ["watch", "lantern.watch"], ["watchMinutes", "lantern.watchMinutes"], ["cacheTtlMinutes", "lantern.cacheTtlMinutes"]] as const) {
          if (b?.[k] !== undefined) rs.push(await settingsDoor.change(id, b[k], { person: false, who, confined: caller?.principal === "seat" }));
        }
        const off = rs.find((r) => !(r.ok && r.applied));
        noteAction(clientIp, "/lantern/settings", {}, off ? auditOf(off) : { ok: true }, asActor(caller));
        return doorMany(rs, { nudge: lanternNudge(), minutes: lanternNudgeMinutes(), watch: lanternWatch(), watchMinutes: lanternWatchMinutes(), cacheTtlMinutes: cacheTtlMinutes() });
      }
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
        return json({ ok: false, error: `${agent.label} needs no connecting — there is nothing to wire`, agents: probeAgents() }, 400);
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
    /* The gate is its own switch and never a flag on the one above: telemetry
       may not stop a tool call, and this exists to hold one. */
    if (pathname === "/hooks/gate" && req.method === "POST") {
      if (!trustedCaller(req, from)) return csrfBlocked();
      let b: Record<string, unknown> = {};
      try { b = (await req.json()) as Record<string, unknown>; } catch { /* no body is "turn it on" */ }
      if (!mayPublishReview(req, caller)) return viaDoor("/hooks/gate", "hooks.gate", b.on !== false, b.as);
      return json(applyGate(b.on === false ? "uninstall" : "install"));
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
      let b: { budgets?: unknown; as?: unknown };
      try { b = (await req.json()) as { budgets?: unknown }; } catch { return json({ ok: false, error: "invalid json" }, 400); }
      if (!mayPublishReview(req, caller)) return viaDoor("/budgets/set", "budgets", b.budgets, b.as);
      // Checked by the same function the settings door uses (serverSettings.ts).
      const clean = cleanBudgets(b.budgets);
      if (typeof clean === "string") return json({ ok: false, error: clean }, 400);
      const r = writeBudgets(clean);
      if (!r.ok) return json(r, 400);
      return json({ ...r, budgets: readBudgets(), status: budgetStatus() });
    }

    if (pathname === "/insights") return json({ insights: getInsights() });
    // Live sessions in different checkouts on one port, database, .env or
    // compose project — see collisions.ts. A warning; nothing here blocks.
    if (pathname === "/collisions") return json({ collisions: await getCollisions() });
    if (pathname === "/usage") return json(await getUsage()); // Anthropic plan-limit windows (only meaningful for Claude)
    // Every provider's plan quota in one shape — the dashboard box, the Stats
    // section and the notch all read this one answer. No desktop-only gate:
    // there is no path on disk in the payload and nothing here can act.
    if (pathname === "/usage/providers") { const plugin = caller?.plugin ?? pluginOfRequest(req, url); return json(await allProviderUsage(undefined, accountsFor(plugin ? { plugin } : "person"))); }
    // What the person opens, counted on this machine only (usageopens.ts): the
    // window posts its batches here and the About page and `ui.read usage` read
    // them back. A write to one small file in the state dir, so the strict gate.
    if (pathname === "/usage/opens") {
      if (req.method === "GET") return json(readOpens());
      if (req.method === "POST") {
        if (!trustedCaller(req, from)) return csrfBlocked();
        let b: any = {};
        try { b = await req.json(); } catch { return json({ ok: false, error: "invalid json" }, 400); }
        const r = recordOpens(b?.opens);
        return json(r, r.ok ? 200 : 400);
      }
    }
    // The accounts a plugin says each provider has, never a credential. A paired
    // device is given how a chip reads and nothing else; a plugin, only its own list.
    if (pathname === "/usage/accounts" && req.method === "GET") {
      const plugin = caller?.plugin ?? pluginOfRequest(req, url);
      return json({ ok: true, providers: accountsList(caller?.kind === "device" ? "device" : plugin ? { plugin } : "person") });
    }
    /*
     * A press of an account chip, passed on to the plugin that keeps the list.
     * Only the person in the desktop window: a plugin token is refused by its
     * KIND (a manifest may say scope "full" and a plugin may write any Origin it
     * likes), and so is a paired device. The plugin does the switching; this
     * route only tells it the person asked.
     */
    if ((pathname === "/usage/accounts/switch" || pathname === "/usage/accounts/manage") && req.method === "POST") {
      if (!personMayPress(caller, desktopOnly(req), deskHeld(), deskKeyOk(req))) return csrfBlocked();
      let b: { provider?: unknown; id?: unknown } = {};
      try { b = (await req.json()) as typeof b; } catch { return json({ ok: false, error: "invalid json" }, 400); }
      const switching = pathname.endsWith("/switch");
      const no = switching ? switchRefusal(b.provider, b.id) : manageRefusal(b.provider);
      if (no) return json({ ok: false, error: no }, 409);
      const to = holderOf(b.provider as string)!.plugin;
      pushEvent(to, switching ? { type: "account.switch", provider: b.provider as string, id: b.id as string, at: Date.now() } : { type: "account.manage", provider: b.provider as string, at: Date.now() });
      return json({ ok: true, plugin: to });
    }
    // A client asks whether a long window has newly reached its alert level.
    // The server decides and remembers, once for every client, and tells them
    // all by frame; the answer here is only how many it raised.
    if (pathname === "/usage/pace-claim" && req.method === "POST") {
      if (!trustedCaller(req, from)) return csrfBlocked();
      let b: { alertAt?: unknown } = {};
      try { b = (await req.json()) as typeof b; } catch { /* an empty body means the default level */ }
      const fired = claimPaceAlerts(await allProviderUsage(), coerceAlertAt(b?.alertAt));
      for (const a of fired) broadcast({ type: "pace-alert", data: a });
      return json({ ok: true, fired: fired.length });
    }

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
      await syncLogin();
      return json({ ok: true, used: ingestStatusline(body) });
    }

    // --- control plane: gate ---
    if (pathname === "/gate" && req.method === "POST") {
      let b: any = {};
      try { b = await req.json(); } catch { return json({ decision: "allow", reason: "bad request" }); }
      const ti = b.tool_input ?? {};
      const summary = String(ti.command || ti.file_path || ti.path || ti.pattern || ti.query || ti.description || b.tool_name || "").slice(0, 300);
      /*
       * OUTWARD ACTIONS ARE HELD CLOSED, AND SHOW THEIR TEXT.
       *
       * The rule every arrangement of agents on this machine runs by is that
       * anything a colleague can see belongs to the person, and until now that
       * line was held by each agent remembering it. This is the tool: a push,
       * a pull request, a comment, a review, a merge, a ticket or a message in
       * a channel is recognised (outward.ts), the line a person decides from
       * says WHAT it does and quotes what would be sent, and nobody answering
       * means it does NOT happen — the fail-open default exists so an absent
       * human never blocks work, and work that has already left the machine
       * cannot be blocked afterwards.
       */
      // The hook picks the id so it can re-attach to this exact request after
      // a dropped connection (see /gate/status). Shape-checked in gate.ts;
      // anything else falls back to a server-generated one.
      const greq = { id: typeof b.id === "string" ? b.id : undefined, source_app: String(b.source_app || "unknown"), session_id: String(b.session_id || "unknown"), tool_name: String(b.tool_name || "?"), summary };
      // A retry of an id already sent is answered from what was recorded, before
      // any rule is consulted: a rule or a budget that changed in between must
      // not turn a request somebody is deciding into a second, different answer.
      const again = validGateId(greq.id) ? awaitGate(greq.id) : null;
      if (again) return json(await again);
      const cwd = gateCwd(b.cwd, greq.session_id);
      const out = outwardAction(String(b.tool_name || ""), ti);
      /*
       * RULES DECIDE BEFORE ANYBODY IS ASKED — gaterules.ts.
       *
       * A deny is answered now and written to history. An allow is answered
       * now with an EMPTY reason, which the hook reads as "agentglass has no
       * opinion": Claude Code's own permission prompt still runs, so an allow
       * list means "do not hold this" and never "skip every other check". And
       * an outward action is never let through by one — the allow list is
       * about what a person need not see, and a push is by definition
       * something they do — save the one exception below.
       */
      const rule = gateRuleFor(greq.tool_name, cwd);
      if (rule.kind === "deny") return json(denyByRule(greq, rule.reason));
      // The agent rules (agentRulesStore.ts) first: a "never" is answered now, and an
      // "ask" is held for the person even when a gate rule would let it through.
      let ruled: ReturnType<typeof rulesCheck> | null = null;
      try { ruled = cwd.startsWith("/") ? rulesCheck(cwd, greq.tool_name, ti) : null; } catch { ruled = null; }
      if (ruled?.decision === "never") return json(denyByRule(greq, ruled.reason ?? "an agentglass rule says never"));
      // The one exception: an outward match made only by a generic MCP verb
      // (`create_entities` on a memory store) is released by an allow rule
      // that names that exact tool. A prefix never saw the tool it would be
      // releasing; a name is a person saying which kind of `create` this is.
      // Written to history like a denial, unless it is the harness fetching a
      // tool's schema — no rule made that call, and it would be one row per
      // deferred tool in every session.
      if (rule.kind === "allow" && ruled?.decision !== "ask" && (!out || (out.generic && rule.exact))) {
        return json(rule.meta ? { decision: "allow", reason: "" } : allowByRule(greq));
      }
      const hold = out
        ? [outwardLine(out), out.text ? `“${out.text.replace(/\s+/g, " ").trim().slice(0, 240)}”` : ""].filter(Boolean).join(" · ")
        : budgetHoldFor(greq.session_id, gateFailClosed(), cwd);
      /* "Who answers" and "If nobody answers" (Settings ▸ Agents ▸ Gate). The chair is TOLD, never
         asked to decide: a held call is released by the person alone. Only an OUTWARD hold, once:
         a budget hold is every call of every session, the chair's own included, and each line
         would start a chair turn (gatechair.ts). The ask-again rounds go to the person only. */
      const tell = !!out && gateAnswerer() === "orchestrator";
      if (tell) void tellChair(cwd, greq.session_id, greq.tool_name, outwardLine({ ...out!, target: undefined }), [out!.target, out!.text].filter(Boolean).join(" · "));
      const decision = await submitGate(
        greq,
        Math.min(GATE_MAX_MS, Number(b.timeout_ms) || 60_000),
        hold,
        out ? true : undefined,
        out && gateOnTimeout() === "ask" ? () => {} : undefined,
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
        gates: gateHistory(Number(url.searchParams.get("limit") || 50), { ruleAllows: url.searchParams.get("rule_allows") !== "0" })
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
            held.resolution === "human" ? "somebody else" : held.resolution === "rule" ? "a gate rule" : "the timeout"} — this answer arrived too late`;
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
    //
    // `open finder` is the one command that names a path chosen by the caller,
    // and trustedCaller below is enough for it for three reasons. It carries a
    // spelling and nothing else: this handler never opens, stats or reads the
    // path, it only validates the string (control.ts). Each window then asks
    // /browse and /preview for it under its OWN credentials and locality, so a
    // path the finder may not look at (the keys folder, a dotted folder for a
    // non-local viewer) comes back as the finder's own "closed" state in the
    // window, not as content. And the caller who can send it is the one who can
    // already type the same path into the finder, or into a shell this server
    // hosts: loopback without an Origin, or a vouched Origin plus the token. A
    // page on another origin is refused here, which is the case that matters:
    // it must not be able to put a file in front of the person.
    /*
     * What /control accepts, as data: the registry's entries at or below the
     * level this process allows, with their argument specs. The agent CLI and
     * the MCP server build their commands and their tool lists from this, so
     * they follow the registry (and AGENTGLASS_CONTROL_LEVEL) with nothing of
     * their own to keep in step. A read: it names doors, it opens none.
     */
    if (pathname === "/control/actions" && req.method === "GET") {
      return json({ ok: true, level: CONTROL.level, readonly: CONTROL.readonly, actions: describeUiActions(UI_ACTIONS, CONTROL.level) });
    }
    if (pathname === "/control" && req.method === "POST") {
      if (!trustedCaller(req, from)) return csrfBlocked();
      let b: unknown = {};
      try { b = await req.json(); } catch { return json({ ok: false, error: "invalid json" }, 400); }
      const cmd = parseControlCmd(b, CONTROL.level);
      if (!cmd) {
        /*
         * A body that names a real door above the level this process holds is
         * told which level that door is and which switch would allow it (403,
         * and a line in the log, since an agent that keeps asking for a write
         * it cannot have is worth seeing). A body that names no door at all
         * stays the bare 400: it must not list what exists above its level.
         */
        const no = controlRefusal(b, CONTROL);
        if (!no) {
          // A door this server would run, with arguments it will not: say which argument and what it takes.
          const e = entryOfBody(b as Record<string, unknown>);
          const bad = e && levelAllows(e.def, CONTROL.level) ? argsRefusal(e.id, e.def, (b as { cmd?: unknown }).cmd === "ui" ? (b as { args?: unknown }).args : b) : null;
          return json({ ok: false, error: bad ?? "unknown control command" }, 400);
        }
        const refusedFrom = req.headers.get("origin");
        const refusedAs = callerRequestId((b as { as?: unknown }).as);
        const refusedWho = caller ? { ...asActor(caller)!, fromPage: !!refusedFrom && vouchedOrigin(refusedFrom) } : caller;
        // The 403 is never throttled; the log row is, so a loop of refused writes is not a loop of rows.
        const row = controlRefusals.note(`level:${actorOf(clientIp, refusedWho)}`);
        if (row.log) {
          noteAction(clientIp, `/control/${no.id}`, { ...(refusedAs ? { as: refusedAs } : {}), ...(row.suppressed ? { refused: row.suppressed } : {}) }, { ok: false, error: "level" }, refusedWho);
        }
        return json({ ok: false, error: no.error, level: CONTROL.level }, 403);
      }
      // A proposal to switch to an account that is not in the plugin's list, or is
      // already the active one, is told so here and never put in front of the person.
      if (cmd.cmd === "ui" && cmd.do === "usage.account.stage") {
        const a = cmd.args as { provider: string; id: string };
        const no = switchRefusal(a.provider, a.id);
        if (no) return json({ ok: false, error: no }, 409);
      }
      /*
       * Delivery, said truthfully. The command rides the same sockets every
       * window holds, and with none attached it used to be dropped while the
       * caller was told ok, so a Stream Deck button and an agent could not tell
       * "shown" from "nobody was there". `clients` is the audience broadcast()
       * writes to, so zero here means zero would receive it. What this cannot
       * know is whether a window RAN it: the frame is fire-and-forget, so `ok`
       * still means accepted and sent to N windows, not applied.
       *
       * One audit line per command, the id and the verdict and nothing else:
       * the path or row a command named is a value, and the log records that a
       * door was opened, not what was looked at. Refused-for-no-window is a
       * line too, since an agent that keeps asking is worth seeing.
       */
      const pageOrigin = req.headers.get("origin");
      const who = caller ? { ...asActor(caller)!, fromPage: !!pageOrigin && vouchedOrigin(pageOrigin) } : caller;
      // A settings change names its setting in the line (the id and the fact
      // of change, not the value), and is rate limited per caller.
      const setting = changedSetting(cmd);
      // Any write kind is limited, not only the one built first: a level 3
      // stage opens a dialog on the person's screen and is rate limited too.
      const writes = isWriteKind((UI_ACTIONS[controlId(cmd) as keyof typeof UI_ACTIONS] as { kind?: string } | undefined)?.kind);
      // `as` is the name a CLI or an MCP server stamps itself with (the browser
      // CLI's --as): a label for the log line, never a credential.
      const as = callerRequestId((b as { as?: unknown }).as);
      // How it is shown: quiet for a caller that named itself, now for one that
      // did not, or what the body says. An unknown word is a refusal, since a
      // guess here decides whether a dialog lands on somebody who is typing.
      const present = presentOf((b as { present?: unknown }).present, as, (UI_ACTIONS[controlId(cmd) as keyof typeof UI_ACTIONS] as { kind?: UiKind } | undefined)?.kind);
      if (!present) return json({ ok: false, error: "present is quiet or now" }, 400);
      // The mode is a fact about an open; a read or a settings change shows
      // nothing, so its line does not carry one.
      const kindOf = (UI_ACTIONS[controlId(cmd) as keyof typeof UI_ACTIONS] as { kind?: string } | undefined)?.kind;
      const opens = kindOf === "open" || kindOf === "stage";
      const audit = (ok: boolean, error?: string, queued?: boolean, refused?: number) =>
        noteAction(clientIp, `/control/${controlId(cmd) ?? "unknown"}`, { ...(setting ? { setting } : {}), ...(as ? { as } : {}), ...(opens ? { present } : {}), ...(queued ? { queued: true } : {}), ...(refused ? { refused } : {}) }, { ok, error }, who);
      if (writes && !controlWriteLimit.hit(actorOf(clientIp, who))) {
        const row = controlRefusals.note(`rate:${actorOf(clientIp, who)}`);
        if (row.log) audit(false, "rate limited", undefined, row.suppressed);
        return json({ ok: false, error: "too many changes from this caller; slow down" }, 429);
      }
      const windows = controlWindows().length;
      if (windows === 0) {
        audit(false, "no window");
        return json({ ok: false, error: "no window" }, 503);
      }
      /*
       * A command that carries an `id`, and every read (a read with no answer is
       * nothing), is held until a window says what it did: {ok, applied, value?,
       * error?}, `ok` = a window took it, `applied` = it ran. Without either, the
       * old fire-and-forget answer is unchanged. The request id the windows echo
       * is minted by the server, not the caller's: the caller's `id` is only a
       * label handed back to it. The audit line is written when the window
       * answers (or the wait runs out), so it carries the verdict.
       */
      const label = callerRequestId((b as { id?: unknown }).id);
      // A settings change is answered as well: what it replaced, and the undo handle.
      // A quiet open asks too: the window may hold it behind a chip, and a caller
      // told "ok" for something nobody has seen would be told wrong.
      const asks = label !== null || writes || (cmd.cmd === "ui" && isReadAction(cmd.do)) || (opens && present === "quiet");
      // `level` tells the window what the server holds, so settings.list can say which
      // settings are writable HERE and not only in principle.
      const frame = { present, level: CONTROL.level, ...(as ? { as } : {}) };
      if (!asks) {
        sendControl({ type: "control", data: cmd, ...frame });
        audit(true);
        return json({ ok: true, windows });
      }
      const rid = nextControlRid();
      const reply = await awaitControl(rid, () => sendControl({ type: "control", data: cmd, rid, ...frame }));
      /*
       * A window setting of the escalation class the window would not apply on its
       * own (it narrows nothing): the person's switch sends it back granted, else it
       * becomes a request. /control is a controller's door whoever holds it (the
       * person changes a window setting on its row), so it is never the person here. The window decided, from
       * the value it holds; a socket that only claims to be a window can at most
       * make a request appear, which the person declines.
       */
      if (cmd.cmd === "ui" && cmd.do === "settings.set" && reply.error === NEEDS_APPROVAL) {
        const a = cmd.args as { id: string; value: unknown };
        if (classOf(a.id)?.class === "escalation") {
          if (agentsChangeWithoutAsking()) {
            const g = await grantedWindowSet(a.id, a.value);
            audit(g.ok, g.ok ? undefined : g.error);
            return json(g.ok ? { ok: true, applied: true } : { ok: false, applied: false, error: g.error });
          }
          const q = settingsDoor.askForWindow(a.id, a.id, await windowValue(a.id), a.value, askerOf(req, caller, (b as { as?: unknown }).as));
          audit(false, q.ok ? "waiting for the person" : q.error, q.ok);
          return q.ok ? json({ ...q, ...(label ? { id: label } : {}) }, 202) : json({ ok: false, applied: false, error: q.error }, q.status);
        }
      }
      // Held behind a chip is a verdict too: taken, not yet shown.
      audit(reply.ok && (reply.applied || reply.queued === true), reply.error, reply.queued === true);
      return json({ ...reply, ...(label ? { id: label } : {}) }, reply.error === CONTROL_TIMEOUT_ERROR ? 504 : 200);
    }

    /*
     * A window answering a command it was handed (see POST /control). NOT an
     * agent-facing route: it is the window's call, behind the same trustedCaller
     * gate as /browser/result, and what keeps one caller from answering another's
     * ask is the request id, which only travels on the window sockets. The first
     * answer wins; a second, a late one and an unknown id are all `known: false`,
     * which is ordinary (two windows were open, or the wait ran out).
     */
    if (pathname === "/control/result" && req.method === "POST") {
      if (!trustedCaller(req, from)) return csrfBlocked();
      let b: unknown = {};
      try { b = await req.json(); } catch { return json({ ok: false, error: "invalid json" }, 400); }
      const reply = parseReply(b);
      if (!reply) return json({ ok: false, error: "not a reply" }, 400);
      return json({ ok: true, known: settleControl((b as { rid?: unknown }).rid, reply) });
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
      catch (e) {
        /* Only our own refusal reaches the caller. Anything else — a
           filesystem error, a database error — is logged here and answered
           with a fixed sentence: that text carries absolute paths and
           internals, and a reader on the other end of the wire is owed the
           decision, not the plumbing. */
        if (e instanceof SourceRefused) return json({ ok: false, error: e.message }, 400);
        console.error("[understudy] source/add:", e);
        return json({ ok: false, error: "that path could not be added" }, 400);
      }
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
     * another four hundred megabytes of their work, and a request to
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
        // Same rule as /understudy/source/add: our refusal by name, and
        // nothing else. `IngestRefused` is the "no private-terms list" answer,
        // which the screen shows and acts on.
        if (e instanceof IngestRefused) return json({ ok: false, error: e.message }, 409);
        console.error("[understudy] learn:", e);
        return json({ ok: false, error: "it could not read the sources" }, 409);
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
        console.error("[understudy] ask:", e);
        return json({ ok: false, error: "it could not answer that" }, 400);
      }
    }
    /*
     * Where it may draft actions. Narrow by default, and his to widen.
     *
     * Deliberately its own route rather than a field on some larger settings
     * body: this is the switch that decides whether the understudy may draft a
     * request against a work repository, and a setting like that should
     * be a thing somebody did, not a field that rode along with something else.
     */
    // The checkouts a scheduled start may run in: the Lantern's schedule dialog
    // reads this.
    if (pathname === "/understudy/work/ask" && req.method === "GET") {
      return json({ ok: true, allowed: await openProjectRepos() });
    }
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
    if (pathname === "/desk/claim" && req.method === "POST") {
      if (!trustedCaller(req, from)) return csrfBlocked();
      /*
       * The desktop app taking the desk of a server it adopted (desk.ts). Only
       * the machine token itself — not a device, a plugin, the understudy or a
       * seat — with no Origin, so no page, from a socket that is loopback
       * without anything forwarding it, so nothing off the machine. Those are
       * exactly the callers that could forge the app's Origin already.
       */
      const direct = peer.source === "socket" && !!clientIp && isLoopback(clientIp);
      if (caller?.kind !== "machine" || caller.principal || req.headers.get("origin") || !direct) {
        return json({ ok: false, error: "only the desktop app, on this machine, claims its desk" }, 403);
      }
      const k = req.headers.get(DESK_HEADER) || "";
      if (k.length < 32 || k.length > 128) return json({ ok: false, error: "a desk key is 32 to 128 characters" }, 400);
      const release = claimDesk(k);
      if (!release) return json({ ok: false, error: "this server's desk is already held" }, 409);
      /* Held while this response is open: the app reads it and never ends it.
         A line a minute keeps the connection inside idleTimeout (255 s). The
         release is this claim's own, so a late drop cannot free the next one
         the app makes with the same key. */
      let beat: ReturnType<typeof setInterval> | undefined;
      const drop = () => { clearInterval(beat); release(); };
      if (req.signal.aborted) { drop(); return new Response(null, { status: 499 }); }
      req.signal.addEventListener("abort", drop, { once: true });
      return new Response(new ReadableStream<Uint8Array>({
        start(c) {
          const line = new TextEncoder().encode("held\n");
          c.enqueue(line);
          beat = setInterval(() => { try { c.enqueue(line); } catch { drop(); } }, 60_000);
        },
        cancel: drop,
      }), { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
    }
    /* The lanes that are open, for the Browser panel's quiet row. A read, so the
       same gate as the audit; ids and owners, nothing a page said. */
    if (pathname === "/browser/lanes" && req.method === "GET") {
      if (!trustedCaller(req, from)) return csrfBlocked();
      return json({ ok: true, lanes: listLanes() });
    }
    const browserDataPost = pathname === "/browser/places" || pathname === "/browser/places/forget" || pathname === "/browser/visit";
    if (pathname.startsWith("/browser/") && req.method === "POST" && !browserDataPost) {
      if (!trustedCaller(req, from)) return csrfBlocked();
      const op = pathname.slice("/browser/".length);
      if (op === "ready") {
        // A window saying it has a browser panel that can answer. Heartbeat, so
        // a window that dies without saying goodbye stops being counted.
        if (!mayHostBrowser(req)) return json({ ok: false, error: "only the desktop app can register a browser window" }, 403);
        let b: any = {};
        try { b = await req.json(); } catch { return json({ ok: false, error: "invalid json" }, 400); }
        // The app's own window registering to make lane hosts, which needs no panel.
        // The lanes it knows come back so the app can destroy a host the table has forgotten.
        if (b.manager === true) return json({ ok: noteBrowserManager(b.client, b.on !== false), lanes: listLanes().map((l) => l.id) });
        return json({ ok: noteBrowserReady(b.client, b.on !== false, b.lanes) });
      }
      if (op === "result") {
        // The window reporting back. Not an agent-facing route.
        let b: any = {};
        try { b = await req.json(); } catch { return json({ ok: false, error: "invalid json" }, 400); }
        const known = settleBrowser(b.id, {
          ok: b.ok === true, value: b.value, error: typeof b.error === "string" ? b.error : undefined,
          diagnosis: b.diagnosis,
        }, typeof b.client === "string" ? b.client : "");
        return json({ ok: true, known });
      }
      /* A request that names a lane is gated ONCE, here, for every verb the relay
         answers itself as much as the ones it forwards: closed, unknown or
         somebody else's is a named refusal before anything is asked, and an open
         one is put in scope so every ask this request makes goes to that lane
         and never to the person's tab (browserdrive.ts, laneScope). */
      if (op !== "lane") {
        let pre: unknown = null;
        try { pre = await req.clone().json(); } catch { /* the route reports its own bad json */ }
        const refused = gateLane(op, pre);
        if (refused) return json({ ok: false, error: refused });
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
        const a = parsed.ask.args as { selector: string; dir: string; timeoutMs?: number } & Record<string, unknown>;
        const via: Record<string, unknown> = {};
        for (const k of ["page", "as", "how", "pageExplicit"]) if (a[k] !== undefined) via[k] = a[k];
        const r = await downloadFile({ selector: a.selector, dir: a.dir, timeoutMs: a.timeoutMs, via });
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
      if (op === "scrape") {
        /* Several pages, one read each, in parallel — see `runScrape` for
           what it is and is not. Validated there rather than here, the way
           `do` is, so the CLI and the MCP meet the same refusals. */
        let b: any = {};
        try { b = await req.json(); } catch { return json({ ok: false, error: "invalid json" }, 400); }
        const caller: Record<string, unknown> = {};
        for (const k of ["as", "how", "pageExplicit", "identity"]) if (b[k] !== undefined) caller[k] = b[k];
        const spec = parseScrape(b, caller);
        if ("error" in spec) return json({ ok: false, error: spec.error }, 400);
        const r = await runScrape(spec, caller);
        return json(r);
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
    const remoteNow = () =>
      remoteStatus({
        bind: BIND,
        port: srv.port ?? PORT,
        trustLan: TRUST_LAN,
        token: AUTH_TOKEN,
        webUi: WEB_UI_ENABLED,
      });
    if (pathname === "/remote/status") {
      // `?fresh=1` is the Remote page asking for a tailnet look no older than
      // 10 s, so a `tailscale serve` started elsewhere shows up in seconds
      // instead of at the next 120 s tick.
      if (url.searchParams.get("fresh")) await refreshTailscaleIfStale(srv.port ?? PORT, 10_000);
      return json(remoteNow());
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

    // Turn on Tailscale HTTPS for the port this server answers on. Machine-only
    // like pairing: it changes what the tailnet can reach.
    if (pathname === "/remote/serve" && req.method === "POST") {
      if (!trustedCaller(req, from)) return csrfBlocked();
      if (!atMachine()) return notHere();
      // Every agent shell is on loopback and holds the machine token, so that alone
      // would let one publish the server to the tailnet: it takes the person, as /pair/accept does.
      if (!mayReleaseAHold(req, caller)) return heldPartyBlocked();
      const r = await enableServe(srv.port ?? PORT);
      return json({ ...r, status: remoteNow() });
    }

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

    /** Close the open sockets held by these devices. */
    const closeDeviceSockets = (ids: Set<string>): number => {
      // Revoking a credential while the terminal it opened keeps streaming is
      // the worst of both: the list says gone and the wire says otherwise.
      let closed = 0;
      for (const ws of [...sockets]) {
        if (ws.data?.deviceId && ids.has(ws.data.deviceId)) {
          try { ws.close(1008, "this device was disconnected from the host machine"); closed++; } catch { /* already gone */ }
        }
      }
      return closed;
    };

    /**
     * Cut one device off, and only that one.
     *
     * Rotating the machine's token is the big hammer for "I have lost control
     * of the code"; this is the small one for "that tablet is in a drawer".
     */
    if (pathname === "/pair/forget" && req.method === "POST") {
      if (!atMachine()) return notHere();
      let b: { id?: unknown };
      try { b = (await req.json()) as { id?: unknown }; } catch { return json({ ok: false, error: "invalid json" }, 400); }
      const id = typeof b.id === "string" ? b.id : "";
      if (!revokeDevice(id)) return json({ ok: false, error: "no such device" }, 404);
      return json({ ok: true, closed: closeDeviceSockets(new Set([id])) });
    }

    /**
     * Cut every device off. The desktop shell calls it before it rotates the
     * machine token: a device holds its own credential, so rotating alone left
     * every phone paired.
     */
    if (pathname === "/pair/forget-all" && req.method === "POST") {
      if (!trustedCaller(req, from)) return csrfBlocked();
      if (!atMachine()) return notHere();
      if (!mayReleaseAHold(req, caller)) return heldPartyBlocked();
      const ids = revokeAllDevices();
      return json({ ok: true, revoked: ids.length, closed: closeDeviceSockets(new Set(ids)) });
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
        : r.error === "locked" ? `too many wrong codes — start a new invitation on the computer`
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
     *  it, and a 401 here is how it learns it has been forgotten.
     *
     *  `computer` is this machine's name. Without it the phone had only the
     *  label the desk gave the PHONE ("My phone"), and drew that where it meant
     *  the computer. It is here and not on `/health` because `/health` answers
     *  anyone on the network, and a hostname is often somebody's name. */
    if (pathname === "/pair/whoami") {
      if (!AUTH_TOKEN) return json({ paired: false, scope: "full", machine: true, computer: hostname() });
      const caller = callerFor(req, url, AUTH_TOKEN);
      if (!caller) return json({ paired: false }, 401);
      return json({
        paired: caller.kind === "device",
        machine: caller.kind === "machine",
        scope: caller.scope,
        label: caller.device?.label ?? null,
        id: caller.device?.id ?? null,
        computer: hostname(),
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
      return json({ master: masterEnabled(), envAllowsUnboxed: envAllowsUnboxed(), plugins: listPlugins({ keyExposure: pluginOfRequest(req, url) === null }) });
    }

    if (pathname === "/plugins/master" && req.method === "POST") {
      if (!trustedCaller(req, from)) return csrfBlocked();
      let b: { enabled?: unknown; as?: unknown };
      try { b = (await req.json()) as { enabled?: unknown }; } catch { return json({ ok: false, error: "invalid json" }, 400); }
      if (typeof b.enabled !== "boolean") return json({ ok: false, error: "enabled must be a boolean" }, 400);
      // An agent's switch goes through the settings door: off narrows and applies, on waits.
      if (!mayPublishReview(req, caller)) return viaDoor("/plugins/master", "plugins.master", b.enabled, b.as);
      try {
        await setMaster(b.enabled);
      } catch (e) {
        return json({ ok: false, error: failed("plugins/master", e, b.enabled ? "the master switch was not changed: it could not be saved, try again" : "plugins are stopped, but the switch-off could not be saved, so they come back at the next start") }, 500);
      }
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
      /* An agent's enable is a request whose card shows the declaration from the
         server's record (serverSettings.ts declaration): the person's Approve is the
         approval `approved` stands for. */
      if (!mayPublishReview(req, caller)) return viaDoor("/plugins/enable", `plugin.${b.name}.enabled`, true, (b as { as?: unknown }).as);
      // `approved` is the caller saying it showed the declaration. The window
      // always has; a script has to say so, and the CLI only says it for
      // `--approve`, which prints the declaration first.
      const r = await enablePlugin(b.name, (b as { approved?: unknown }).approved !== false);
      return json(r, r.ok ? 200 : 400);
    }

    if (pathname === "/plugins/allow-unboxed" && req.method === "POST") {
      if (!trustedCaller(req, from)) return csrfBlocked();
      let b: { name?: unknown; allow?: unknown };
      try { b = (await req.json()) as { name?: unknown; allow?: unknown }; } catch { return json({ ok: false, error: "invalid json" }, 400); }
      if (typeof b.name !== "string" || !b.name) return json({ ok: false, error: "name is required" }, 400);
      // A grant is one of the few things this file lets a caller ask for
      // that widens what a process may reach — deliberately not "anything
      // but a literal false", the way /plugins/enable's `approved` reads,
      // because a missing or malformed field defaulting to GRANT is the
      // wrong failure direction for exactly this switch.
      if (typeof b.allow !== "boolean") return json({ ok: false, error: "allow must be true or false" }, 400);
      if (!mayPublishReview(req, caller)) return viaDoor("/plugins/allow-unboxed", `plugin.${b.name}.unboxed`, b.allow, (b as { as?: unknown }).as);
      try {
        const r = await setPluginUnboxedConsent(b.name, b.allow);
        return json(r, r.ok ? 200 : 400);
      } catch (e) {
        return json({ ok: false, error: failed("plugins/allow-unboxed", e, "the plugin could not be started or stopped after the change; refresh to see where it stands") }, 500);
      }
    }

    if (pathname === "/plugins/disable" && req.method === "POST") {
      if (!trustedCaller(req, from)) return csrfBlocked();
      let b: { name?: unknown };
      try { b = (await req.json()) as { name?: unknown }; } catch { return json({ ok: false, error: "invalid json" }, 400); }
      if (typeof b.name !== "string" || !b.name) return json({ ok: false, error: "name is required" }, 400);
      try {
        const ok = await disablePlugin(b.name);
        return json({ ok }, ok ? 200 : 404);
      } catch (e) {
        return json({ ok: false, error: failed("plugins/disable", e, "the plugin is stopped, but the switch-off could not be saved, so it comes back at the next start") }, 500);
      }
    }

    if (pathname === "/plugins/remove" && req.method === "POST") {
      if (!trustedCaller(req, from)) return csrfBlocked();
      let b: { name?: unknown; dropSettings?: unknown };
      try { b = (await req.json()) as { name?: unknown; dropSettings?: unknown }; } catch { return json({ ok: false, error: "invalid json" }, 400); }
      if (typeof b.name !== "string" || !b.name) return json({ ok: false, error: "name is required" }, 400);
      try {
        const ok = await removePlugin(b.name, { dropSettings: b.dropSettings === true });
        return json({ ok }, ok ? 200 : 404);
      } catch (e) {
        const unlock = unlockFirst(e, "remove it");
        if (unlock) return json({ ok: false, error: unlock }, 409);
        return json({ ok: false, error: failed("plugins/remove", e, "the plugin was not removed: its key could not be revoked or the change could not be saved, try again") }, 500);
      }
    }

    /**
     * --- plugins that draw: the plugin's side ---
     *
     * docs/PLUGINS.md, "Drawing in the app". Every route here answers only
     * to a live plugin token and acts only on that plugin's own things;
     * `allowed` lets a plugin through to `/plugin/self` at any scope, and
     * each handler checks the request against what the manifest declared.
     * The name comes from the token, never from the body, so one plugin
     * cannot draw into another's panel or drain another's clicks.
     */
    if (pathname === "/plugin/self" || pathname.startsWith("/plugin/self/")) {
      const self = pluginOfRequest(req, url);
      if (!self) return json({ ok: false, error: "only a running plugin has a self — this needs its own token" }, 403);
      const c = contributesOf(self);
      // Read with a ceiling before it is parsed, like the canvas routes: the
      // only cap there used to be Bun's 32 MB for the whole server.
      const body = async <T,>(): Promise<T | null> => { const r = await readBoundedJson(req, 4 * 1024 * 1024); return r.ok ? (r.value as T) : null; };

      if (pathname === "/plugin/self" && req.method === "GET") {
        return json({ ok: true, name: self, contract: PLUGIN_CONTRACT, contributes: c, settings: pluginOwnSettings(self) });
      }
      if (pathname === "/plugin/self/events" && req.method === "GET") {
        const wait = Math.max(0, Math.min(30_000, Number(url.searchParams.get("wait") ?? 25_000) || 0));
        return json({ ok: true, events: await takeEvents(self, wait) });
      }
      if (req.method !== "POST") return json({ ok: false, error: "not found" }, 404);
      // Operations on a live canvas (plugin-canvas.ts does all of it).
      const ops = pathname.match(new RegExp(`^/plugin/self/panel/(${PANEL_ID_RE.source.slice(1, -1)})/ops$`));
      if (ops) {
        const r = await handleCanvasOps(self, c, ops[1]!, req, () => pluginOfRequest(req, url) === self);
        return json(r.body, r.status);
      }
      if (pathname === "/plugin/self/panel") {
        const raw = await readBoundedJson(req, 1_000_000);
        if (!raw.ok) return json({ ok: false, error: raw.error }, raw.status);
        const b = raw.value as { id?: unknown; tree?: unknown } | null;
        if (!b || typeof b.id !== "string") return json({ ok: false, error: "id and tree are required" }, 400);
        const r = setPanel(self, c, b.id, b.tree);
        return json(r, r.ok ? 200 : 400);
      }
      if (pathname === "/plugin/self/options") {
        const b = await body<{ key?: unknown; options?: unknown }>();
        if (!b || typeof b.key !== "string") return json({ ok: false, error: "key and options are required" }, 400);
        const r = setOptions(self, c, b.key, b.options);
        return json(r, r.ok ? 200 : 400);
      }
      if (pathname === "/plugin/self/inbox/annotations") {
        const b = await body<{ items?: unknown; replace?: unknown }>();
        if (!b) return json({ ok: false, error: "invalid json" }, 400);
        const r = setAnnotations(self, c, b);
        return json(r, r.ok ? 200 : 400);
      }
      if (pathname === "/plugin/self/accounts") {
        const r = setAccounts(self, c, await body<unknown>());
        return json(r, r.ok ? 200 : 400);
      }
      if (pathname === "/plugin/self/settings" && req.method === "POST") {
        /*
         * A plugin filling in its own settings.
         *
         * Only its own, and only fields it declared — `setPluginSettings`
         * checks both, the same way it does for the window. This exists for
         * the case a settings box cannot handle on its own: a prompt the
         * person is meant to edit has to arrive with something in it, and
         * only the plugin knows what the starting text is.
         *
         * The write pushes a `settings` event back, which is how the plugin
         * hears the window's edits too. A plugin that answers that event with
         * another write of the same values would loop, so it compares first —
         * which is the plugin's business, and is why this route does not
         * quietly drop a write that changes nothing.
         */
        const b = await body<{ values?: unknown }>();
        if (!b || !b.values || typeof b.values !== "object") return json({ ok: false, error: "values is required" }, 400);
        const r = await savePluginSettings(self, b.values);
        return json(r, r.ok ? 200 : 400);
      }
      if (pathname === "/plugin/self/pr/run") {
        const r = upsertRun(self, c, await body<unknown>());
        return json(r, r.ok ? 200 : 400);
      }
      /* GitHub reads for a plugin whose box has no keyring: the server holds
         the `gh` login and answers only the operations in plugin-github.ts. */
      if (pathname === "/plugin/self/github" && (req.method as string) === "GET") {
        const op = url.searchParams.get("op") ?? "";
        if (op === "tarball") {
          const built = ghReadArgs(op, url.searchParams);
          return built.ok ? streamTarball(built.args) : json({ ok: false, error: built.error }, 400);
        }
        const r = await runGhRead(op, url.searchParams);
        return json(r, r.ok ? 200 : 400);
      }
      if (pathname === "/plugin/self/pr/notes") {
        const b = await body<{ notes?: unknown }>();
        const r = upsertNotes(self, c, b?.notes);
        return json(r, r.ok ? 200 : 400);
      }
      if (pathname === "/plugin/self/pr/notes/reply") {
        // The plugin answering a finding's thread. Stored with the finding,
        // never sent to GitHub; a 404 here means an app from before this route.
        const r = await replyAsPlugin(self, c, await body<unknown>());
        return json(r, r.ok ? 200 : r.status);
      }
      if (pathname === "/plugin/self/pr/notes/status") {
        // The plugin closing its own finding (open -> resolved only). The
        // person's word outranks it; see resolveOwnNote.
        const r = resolveOwnNote(self, c, await body<unknown>());
        return json(r, r.ok ? 200 : r.status);
      }
      return json({ ok: false, error: "not found" }, 404);
    }

    /* --- plugins that draw: the window's side. Reads are reads; every write
       is unlisted in ANSWER_POST/READ_POST, so it needs `full` like the rest
       of /plugins, and goes through the same CSRF check. */
    if (pathname === "/plugins/icon" && req.method === "GET") {
      // An image, and only ever used as one (`<img>`), with headers that keep
      // it that way if something opens the URL directly: no sniffing, and a
      // sandboxing CSP that gives an SVG no script and no network.
      const icon = pluginIcon(url.searchParams.get("name") ?? "");
      if (!icon) return new Response("not found", { status: 404 });
      return new Response(icon.bytes, { headers: {
        "Content-Type": icon.type,
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
        "Cache-Control": "private, max-age=300",
      } });
    }
    if (pathname === "/plugins/panels" && req.method === "GET") {
      // `?plugin=&panel=` asks for one; a redraw ping names which, so an open
      // window fetches the panel that changed rather than every tree.
      const onlyPlugin = url.searchParams.get("plugin");
      const onlyPanel = url.searchParams.get("panel");
      const out = [];
      for (const p of listPlugins()) {
        if (!p.enabled || (onlyPlugin && p.name !== onlyPlugin)) continue;
        for (const panel of p.contributes.panels ?? []) {
          if (onlyPanel && panel.id !== onlyPanel) continue;
          const st = panelState(p.name, panel.id);
          out.push({
            plugin: p.name, publisher: p.publisher, ...panel, running: isRunning(p.name),
            hasIcon: !!p.icon, color: p.color ?? null, stamp: p.contentHash.slice(0, 12),
            tree: st?.tree ?? null, updatedAt: st?.updatedAt ?? null,
          });
        }
      }
      return json({ ok: true, panels: out });
    }
    if (pathname === "/plugins/action" && req.method === "POST") {
      if (!trustedCaller(req, from)) return csrfBlocked();
      let b: { plugin?: unknown; panel?: unknown; action?: unknown; values?: unknown };
      try { b = (await req.json()) as typeof b; } catch { return json({ ok: false, error: "invalid json" }, 400); }
      if (typeof b.plugin !== "string" || !isRunning(b.plugin)) return json({ ok: false, error: "that plugin is not running" }, 409);
      const a = b.action as { id?: unknown; payload?: unknown } | undefined;
      if (!a || typeof a.id !== "string" || a.id.length > 120) return json({ ok: false, error: "action.id is required" }, 400);
      let values: Record<string, unknown> | undefined;
      if (b.values && typeof b.values === "object" && !Array.isArray(b.values)) {
        const raw = JSON.stringify(b.values);
        if (raw.length > 64_000) return json({ ok: false, error: "form values too large" }, 413);
        values = JSON.parse(raw) as Record<string, unknown>;
      }
      pushEvent(b.plugin, {
        type: "action", panel: typeof b.panel === "string" ? b.panel.slice(0, 40) : undefined,
        action: { id: a.id, payload: a.payload }, values, at: Date.now(),
      });
      return json({ ok: true });
    }
    if (pathname === "/notify/prefs" && req.method === "GET") {
      return json({ ok: true, prefs: readNotifyPrefs() });
    }
    if (pathname === "/notify/prefs" && req.method === "POST") {
      if (!trustedCaller(req, from)) return csrfBlocked();
      let b: unknown;
      try { b = await req.json(); } catch { return json({ ok: false, error: "invalid json" }, 400); }
      const prefs = writeNotifyPrefs(b);
      broadcast({ type: "notify-prefs", data: prefs });
      return json({ ok: true, prefs });
    }
    /* Which repositories the person lets review plugins read the authoring session of
       (`plugins.sessionReads.repos`). Reading it is open to a plugin so its settings can
       say "not allowed here"; changing it is `full` scope and the CSRF check, like the
       rest of /plugins. */
    if (pathname === "/plugins/session-reads" && req.method === "GET") {
      /* `known`: the repositories the app already has a checkout of, as owner/name, for the picker.
         Remembered per checkout by prs.ts (repoIdFor), so this is no `git` call once warm. */
      const known = new Set<string>();
      for (const root of await openProjectRepos().catch(() => [] as string[])) {
        const id = await prRepoIdFor(root).catch(() => null);
        if (id) known.add(id.nameWithOwner.toLowerCase());
      }
      return json({ ok: true, repos: sessionReadRepos(), known: [...known].sort() });
    }
    if (pathname === "/plugins/session-reads" && req.method === "POST") {
      if (!trustedCaller(req, from)) return csrfBlocked();
      let b: { repos?: unknown; as?: unknown };
      try { b = (await req.json()) as { repos?: unknown }; } catch { return json({ ok: false, error: "invalid json" }, 400); }
      /* The window holds this setting and posts here to store it; an agent posting
         here directly is held to the same class: fewer repositories apply, more wait.
         The request is the window's (the approved change comes back through it). */
      if (!mayPublishReview(req, caller)) {
        const prev = sessionReadRepos().join(",");
        // Judge what setSessionReadRepos will store: it also takes a comma string, which
        // would otherwise read as an empty list here and apply without a card.
        const next = coerceRepos(b.repos).join(",");
        const verdict = agentVerdict("plugins.sessionReads.repos", prev, next, agentsChangeWithoutAsking());
        if (verdict !== "apply") {
          const q = settingsDoor.askForWindow("plugins.sessionReads.repos", "plugins.sessionReads.repos", prev, next, askerOf(req, caller, b.as));
          noteAction(clientIp, "/plugins/session-reads", { setting: "plugins.sessionReads.repos", ...(q.ok ? { queued: true } : {}) }, auditOf(q), asActor(caller));
          return doorJson(q);
        }
      }
      return json({ ok: true, repos: setSessionReadRepos(b.repos) });
    }
    // Read marks, synced between devices — see marks.ts. Reading them is a
    // GET like any other; writing them is `answer` scope (auth.ts), because a
    // phone that may reply to a pull request may certainly say it has read one.
    if (pathname === "/marks" && req.method === "GET") {
      const kind = url.searchParams.get("kind") || undefined;
      if (kind && !MARK_KINDS.includes(kind as MarkKind)) return json({ ok: false, error: "unknown kind" }, 400);
      const since = Number(url.searchParams.get("since") || 0);
      // `now` is taken before the read, so asking again from it repeats a row
      // rather than skipping one written while this answer was being built.
      const now = Date.now();
      return json({ marks: listMarks(kind as MarkKind | undefined, since), now });
    }
    if (pathname === "/marks" && req.method === "POST") {
      if (!trustedCaller(req, from)) return csrfBlocked();
      let b: unknown;
      try { b = await req.json(); } catch { return json({ ok: false, error: "invalid json" }, 400); }
      const parsed = parseMarkOps(b);
      if ("error" in parsed) return json({ ok: false, error: parsed.error }, 400);
      const changed = applyMarks(parsed.ops);
      // Only what moved. A replayed batch — a reconnect resending what already
      // landed — changes nothing, and every other device hearing about it
      // would be a frame per reconnect saying nothing.
      if (changed.length) broadcast({ type: "marks", data: changed });
      return json({ ok: true, changed });
    }
    if (pathname === "/plugins/settings" && req.method === "GET") {
      const s = pluginSettings(url.searchParams.get("name") ?? "");
      return s ? json({ ok: true, ...s }) : json({ ok: false, error: "no such plugin" }, 404);
    }
    if (pathname === "/plugins/settings" && req.method === "POST") {
      if (!trustedCaller(req, from)) return csrfBlocked();
      let b: { name?: unknown; values?: unknown };
      try { b = (await req.json()) as typeof b; } catch { return json({ ok: false, error: "invalid json" }, 400); }
      if (typeof b.name !== "string") return json({ ok: false, error: "name is required" }, 400);
      const r = await savePluginSettings(b.name, b.values);
      return json(r, r.ok ? 200 : 400);
    }
    if (pathname === "/plugins/pr-notes" && req.method === "GET") {
      const r = notesFor(url.searchParams.get("repo"), url.searchParams.get("number"));
      if (!r) return json({ ok: false, error: "repo (owner/name) and number are required" }, 400);
      const names = new Map(listPlugins().map((p) => [p.name, p.publisher] as const));
      // The finding buttons of each running plugin ride along, so the window
      // needs no second request to know what to draw.
      const noteActions = Object.fromEntries(listPlugins().filter((p) => p.running && p.contributes.noteActions?.length).map((p) => [p.name, p.contributes.noteActions!] as const));
      return json({ ok: true, ...r, publishers: Object.fromEntries(names), noteActions });
    }
    if (pathname === "/plugins/pr-notes/summary" && req.method === "GET") {
      // `heads=12:abc1234,13:def5678` is the list's own head per pull request,
      // so `stale` can be answered here without asking GitHub anything.
      const heads: Record<number, string> = {};
      for (const part of (url.searchParams.get("heads") ?? "").split(",")) {
        const m = /^(\d{1,9}):([0-9a-fA-F]{7,64})$/.exec(part.trim());
        if (m) heads[Number(m[1])] = m[2]!;
      }
      const one = url.searchParams.get("head");
      const num = url.searchParams.get("number");
      if (one && num && /^[0-9a-fA-F]{7,64}$/.test(one)) heads[Number(num)] = one;
      const slug = url.searchParams.get("repo");
      // The caller's heads come from a cache that may be a push behind. The
      // server's own newest read of each head (with its time) replaces them; a
      // caller's head with no read behind it is unknown-age (at 0), and a review
      // newer than the head we hold earns ONE targeted read before it is called
      // stale (reviewStale: a head read before the review ended says nothing).
      const reads: Record<number, HeadRead> = {};
      if (slug) for (const [n, sha] of Object.entries(heads)) reads[Number(n)] = headRead(slug, Number(n)) ?? { sha, at: 0 };
      if (slug && /^[\w.-]+\/[\w.-]+$/.test(slug)) {
        const only = num ? Number(num) : null;
        const want = headsToRead(slug, reads).filter((n) => only === n || n in reads).slice(0, 5);
        await Promise.all(want.map(async (n) => { const f = await freshHead(slug, n); if (f) reads[n] = f; }));
      }
      const r = summaryFor(slug, num, reads);
      if (!r) return json({ ok: false, error: "repo (owner/name) is required, and number must be a pull request number" }, 400);
      return json({ ok: true, ...r });
    }
    if (pathname === "/plugins/pr-notes/status" && req.method === "POST") {
      if (!trustedCaller(req, from)) return csrfBlocked();
      let b: { plugin?: unknown; id?: unknown; status?: unknown; reply?: unknown; repo?: unknown; number?: unknown };
      try { b = (await req.json()) as typeof b; } catch { return json({ ok: false, error: "invalid json" }, 400); }
      if (typeof b.plugin !== "string" || typeof b.id !== "string") return json({ ok: false, error: "plugin and id are required" }, 400);
      // Who is answering: an agent says so with the header its CLI sends (the
      // same honesty system as presentedWorker); anything else is the person.
      const agent = req.headers.get("x-agentglass-agent");
      const by = agent && /^[A-Za-z0-9_.-]{1,60}$/.test(agent) ? `agent:${agent}` : "user";
      const r = answerNote(b.plugin, b.id, { status: b.status, reply: b.reply, repo: b.repo, number: b.number, by });
      return json(r, r.ok ? 200 : 400);
    }
    if ((pathname === "/plugins/pr-notes/publish-preview" || pathname === "/plugins/pr-notes/publish") && req.method === "POST") {
      /*
       * One organized comment from a local review. The preview reads and writes
       * nothing; the publish is a person's click and nothing else (mayPublishReview).
       * Both answer 403 to a plugin token, an agent's header or the machine token.
       */
      if (!trustedCaller(req, from)) return csrfBlocked();
      if (!mayPublishReview(req, caller)) {
        return json({ ok: false, error: "publishing a review on GitHub is the person's own click; an agent or a plugin cannot do it" }, 403);
      }
      let b: { plugin?: unknown; repo?: unknown; number?: unknown; runId?: unknown; root?: unknown; options?: unknown; markdown?: unknown };
      try { b = (await req.json()) as typeof b; } catch { return json({ ok: false, error: "invalid json" }, 400); }
      const ref = typeof b.plugin === "string" ? notesFor(b.repo, b.number) : null;
      if (typeof b.plugin !== "string" || !ref) return json({ ok: false, error: "plugin, repo (owner/name) and number are required" }, 400);
      const runs = ref.runs.filter((r) => r.plugin === b.plugin);
      const hdr = headerRun(runs, b.plugin);
      const run = typeof b.runId === "string" ? runs.find((r) => r.id === b.runId) : hdr.run;
      if (!run) return json({ ok: false, error: "that plugin has no review on this pull request" }, 404);
      const rid = await prRepoIdFor(b.root);
      if (!rid || rid.nameWithOwner.toLowerCase() !== run.repo.toLowerCase()) return json({ ok: false, error: `that project is not a checkout of ${run.repo}` }, 400);
      const pr: PublishRequest = {
        plugin: b.plugin, repo: run.repo, number: run.number, run,
        // Every finding of this plugin on this pull request, whichever run last touched it.
        notes: publishNotes(ref.notes, b.plugin, run.repo, run.number),
        reviews: hdr.reviews,
        totalCost: hdr.totalCost,
        options: cleanPublishOptions(b.options),
      };
      const deps: PublishDeps = {
        read: async () => {
          const cap = await ghCapability();
          if (!cap.available || !cap.authed) return { ok: false, error: cap.reason ?? "GitHub is not available" };
          const d = await prDetail(b.root, run.number, true);
          if (!d.ok || !d.detail) return { ok: false, error: d.error ?? "could not read the pull request" };
          const det = d.detail as { headSha?: string; readAt?: number; comments?: { nodeId: string; author: string; body: string; url: string }[] };
          return { ok: true, viewer: cap.login ?? "", headSha: det.headSha, headReadAt: det.readAt, comments: det.comments ?? [] };
        },
        create: async (body) => {
          const r = await addComment(b.root, run.number, body);
          return r.ok ? { ok: true, url: r.detail } : { ok: false, error: r.error };
        },
        edit: async (nodeId, body) => {
          const r = await editComment(b.root, nodeId, body, "issue");
          return r.ok ? { ok: true } : { ok: false, error: r.error };
        },
      };
      if (pathname.endsWith("/publish-preview")) {
        const r = await previewReview(pr, deps);
        return json(r, r.ok ? 200 : 400);
      }
      const r = await publishReview(pr, typeof b.markdown === "string" ? b.markdown : undefined, deps);
      if (!r.ok) return json(r, 400);
      markRunPublished(b.plugin, run.id, { at: Date.now(), url: r.url, options: pr.options, ...(r.commit ? { commit: r.commit } : {}) });
      return json({ ok: true, url: r.url, edited: r.edited });
    }
    if (pathname === "/plugins/pr-notes/cost" && req.method === "GET") {
      // Read-only: what a plugin's runs cost, per day, for the Usage screen.
      const r = costByDay(url.searchParams.get("plugin") ?? undefined, url.searchParams.get("days") ?? undefined);
      return json(r, r.ok ? 200 : 400);
    }
    if (pathname === "/plugins/pr-run-decision" && req.method === "POST") {
      // Approve run / Skip on a run waiting for the person's OK. The plugin is
      // told; whether and how it goes on is the plugin's.
      if (!trustedCaller(req, from)) return csrfBlocked();
      let b: { plugin?: unknown; id?: unknown; decision?: unknown };
      try { b = (await req.json()) as typeof b; } catch { return json({ ok: false, error: "invalid json" }, 400); }
      if (typeof b.plugin !== "string") return json({ ok: false, error: "plugin and id are required" }, 400);
      if (!isRunning(b.plugin)) return json({ ok: false, error: "that plugin is not running" }, 409);
      const r = decideRun(b.plugin, b.id, b.decision);
      return json(r, r.ok ? 200 : 400);
    }
    if (pathname === "/plugins/pr-note-action" && req.method === "POST") {
      // A button a plugin declared on its findings was pressed.
      if (!trustedCaller(req, from)) return csrfBlocked();
      let b: { plugin?: unknown; id?: unknown; noteId?: unknown };
      try { b = (await req.json()) as typeof b; } catch { return json({ ok: false, error: "invalid json" }, 400); }
      if (typeof b.plugin !== "string") return json({ ok: false, error: "plugin, id and noteId are required" }, 400);
      if (!isRunning(b.plugin)) return json({ ok: false, error: "that plugin is not running" }, 409);
      const r = pressNoteAction(b.plugin, contributesOf(b.plugin), b.id, b.noteId);
      return json(r, r.ok ? 200 : 400);
    }
    if (pathname === "/plugins/pr-action" && req.method === "POST") {
      // A button a plugin declared in a pull request's header was pressed.
      // Only a declared action of a running plugin; the plugin is told which
      // pull request and nothing else.
      if (!trustedCaller(req, from)) return csrfBlocked();
      let b: { plugin?: unknown; id?: unknown; repo?: unknown; number?: unknown };
      try { b = (await req.json()) as typeof b; } catch { return json({ ok: false, error: "invalid json" }, 400); }
      const ref = validPrRef(b.repo, b.number);
      if (typeof b.plugin !== "string" || typeof b.id !== "string" || !ref) return json({ ok: false, error: "plugin, id, repo and number are required" }, 400);
      if (!isRunning(b.plugin)) return json({ ok: false, error: "that plugin is not running" }, 409);
      if (!contributesOf(b.plugin).prActions?.some((a) => a.id === b.id)) return json({ ok: false, error: "that plugin declares no such action" }, 400);
      pushEvent(b.plugin, { type: "pr-action", id: b.id, ...ref, at: Date.now() });
      return json({ ok: true });
    }
    if (pathname === "/plugins/pr-open" && req.method === "POST") {
      // The person opened a pull request. Told to every running plugin that
      // writes notes, so a reviewer can offer to look without polling GitHub
      // for what the person is reading.
      if (!trustedCaller(req, from)) return csrfBlocked();
      let b: { repo?: unknown; number?: unknown };
      try { b = (await req.json()) as typeof b; } catch { return json({ ok: false, error: "invalid json" }, 400); }
      const ref = validPrRef(b.repo, b.number);
      if (!ref) return json({ ok: false, error: "repo and number are required" }, 400);
      for (const p of listPlugins()) if (p.running && p.contributes.prNotes) pushEvent(p.name, { type: "pr-open", ...ref, at: Date.now() });
      return json({ ok: true });
    }

    if (pathname === "/search") {
      const q = url.searchParams.get("q") || "";
      const limit = Math.min(200, Number(url.searchParams.get("limit") || 60));
      // Optional cockpit filters — same knobs /stats already honours. Absent
      // means "all retained project history" (backward compatible).
      const sinceRaw = url.searchParams.get("since");
      const sinceNum = sinceRaw != null && sinceRaw !== "" ? Number(sinceRaw) : NaN;
      const since = Number.isFinite(sinceNum) ? sinceNum : undefined;
      const provider = url.searchParams.get("provider") || undefined;
      return json({ hits: q.trim() ? searchEvents(q, limit, { since, provider }) : [] });
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
      const scope = workspaceRoots();
      return json({
        // Named when there is one project to name; several have no one name.
        project: scope.length === 1 ? basename(scope[0]!) : null,
        changes: changes.map((c) => ({
          ...c,
          ignored: ignored.get(c.file_path) === true,
          // Unscoped there is no project to be outside of, and the flag stays
          // off rather than becoming "everything" — absent means never hidden.
          outside: scope.length ? !inScope(c.file_path, scope) : false,
        })),
      });
    }

    // --- commit composer: live git working-tree status + commit ---
    if (pathname === "/git/status" && req.method === "POST") {
      if (!localOrigin(req)) return csrfBlocked();
      let b: any = {};
      try { b = await req.json(); } catch { return json({ error: "invalid json" }, 400); }
      // Held to the open project like the GET reads — see gitReadTest.
      const readable = gitReadTest(caller);
      const paths = Array.isArray(b.paths)
        ? b.paths.filter((p: unknown) => typeof p === "string" && readable(p)).slice(0, 500)
        : [];
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
    // A second agentglass.db found at startup, copied or ignored — decided
    // once in db.ts. Paths only, like /privacy.
    if (pathname === "/db/notice") return json(dbNotice());
    // Every outside tool at once, for the Requirements pane. The per-panel
    // capability routes above stay: each panel needs its own answer to render,
    // and this one exists for the question none of them can answer alone.
    // `force=1` is the Recheck button, which is the only reason a caller would
    // want to pay for the probes again inside the cache window.
    if (pathname === "/dependencies") return json(await dependencyReport(url.searchParams.get("force") === "1"));
    // The focused pane's checkout alone, fresh: the terminal's pill polls this
    // instead of the list below, whose cache is why it trailed a change by 15 s.
    if (pathname === "/git/repo") {
      const root = url.searchParams.get("root") || "";
      return body(await singleFlight(`repo:${root}`, async () => JSON.stringify({ repo: await repoNow(root) })));
    }
    if (pathname === "/git/repos") {
      // `all=1` is the project picker: it needs to see past the open projects,
      // or there'd be no way out. It lists what is under the folders the person
      // added (`roots` in the answer); `scan=1` is its explicit "look for
      // projects", the sweep of everywhere the app has seen an agent run, which
      // is never what it shows by default.
      const ignoreScope = url.searchParams.get("all") === "1";
      const rootsOnly = ignoreScope && url.searchParams.get("scan") !== "1";
      // A config from before there were folders gets them on the picker's first
      // read, from the open projects and the ones the old list showed — see
      // seedRepoDirs. Once per process: a file that cannot be written must not
      // be retried on every open.
      if (ignoreScope && repoDirsUnstated()) {
        // Never rejects: a seed that threw would otherwise answer every later
        // read with the same error, and the picker is the way out of anything.
        await (pickerSeed ??= (async () => {
          // Only what an earlier run left behind. A fresh install has none,
          // and seeds nothing but a scope written in its config by hand.
          const history = projectsKnownAtStart();
          const known = history.length ? await knownProjectRoots(getChanges(300, undefined, false).map((c) => c.file_path), history) : [];
          const r = seedRepoDirs([...fileRoots(), ...known]);
          if (!r.ok) console.error(`[picker] could not save the folders an upgrade seeds: ${r.error}`);
        })().catch((e) => console.error(`[picker] could not seed the folders: ${e instanceof Error ? e.message : e}`)));
      }
      // Single-flighted: this sweep is a `git status` per repo across every
      // checkout, and several open tabs asking at the same instant would each
      // launch the whole fan-out. They share one now. (The 15s repoCache behind
      // it still handles reuse across time; this handles reuse across callers.)
      return body(await singleFlight(`repos:${ignoreScope}:${rootsOnly}`, async () => {
        const paths = getChanges(300, undefined, false).map((c) => c.file_path);
        // `hidden` rides along rather than being filtered out here: the picker
        // is the one surface that has to be able to show them again, and a list
        // it cannot see is a list it cannot restore from.
        return JSON.stringify({
          repos: await discoverRepos(paths, knownProjects().map((p) => p.path), { ignoreScope, rootsOnly }),
          hidden: hiddenProjects(),
          // The picker (`all=1`) needs the folders a person added, to render
          // the list it can un-tick from. The unscoped panels need the same
          // set `discoverRepos` actually held them to — `panelRepoDirs()`,
          // which is deliberately `[]` once an upgrade seeds `configuredRepoDirs()`
          // (see config.ts). Answering with the seeded list here made a client
          // that re-filters by `roots` (gitNote.ts's notesWorthyRepos) narrow
          // the panels right back down to it, reintroducing the bug the seed
          // exemption exists to avoid — dropping a worktree beside its project.
          roots: ignoreScope ? configuredRepoDirs() : panelRepoDirs(),
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
      const text = await singleFlight(`tree:${root}`, async () => {
        const hit = treeCache.get(root);
        if (hit && Date.now() - hit.at < TREE_TTL_MS * backoff()) return hit.text;
        const data = await workingTree(root);
        /* A signature of what the tree SAYS, not of when it was read. Every file
           carries `timestamp: now`, so two reads of an unchanged tree differed
           byte for byte: measured at 24 requests a minute of 100% identical
           answers that no ETag or hash could ever match. The stamp stays (the
           type asks for it) and is left out of the signature. The poll cadence
           is unchanged: the doorbell does not ring for an edit made on disk, so
           this poll is the only way such an edit shows up. */
        const sig = Bun.hash(JSON.stringify(data, (k, v) => (k === "timestamp" ? undefined : v))).toString(36);
        const out = JSON.stringify({ ...data, sig });
        if (treeCache.size > 40) treeCache.clear();
        treeCache.set(root, { at: Date.now(), text: out, sig });
        return out;
      });
      const sig = treeCache.get(root)?.sig;
      if (sig && req.headers.get("if-none-match") === `"${sig}"`) {
        return new Response(null, { status: 304, headers: { ETag: `"${sig}"`, ...cors } });
      }
      return new Response(text, {
        headers: { "content-type": "application/json", ...cors, ...(sig ? { ETag: `"${sig}"`, "Cache-Control": "no-cache" } : {}) },
      });
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
        const paths = getChanges(300, undefined, false).map((c) => c.file_path);
        /* Every in-scope checkout, INCLUDING one on main or master. The old
           endpoint dropped those on the grounds that trunk is the base you cut
           from — true of a branch-vs-base diff, false of "what have I changed
           and not committed", and it left anyone whose project has a single
           trunk checkout looking at a permanently empty view. */
        const repos = await discoverRepos(paths, knownProjects().map((p) => p.path), {});
        const result = await changeRows(repos, mode, workspaceRoots(), ROWS_MAX);
        // Committed rows are history; who is writing into a tree NOW is not a question about them.
        if (mode === "working") result.authors = await authorsNow(repos, result.rows);
        const out = JSON.stringify(result);
        rowsCache.set(mode, { at: Date.now(), body: out });
        return out;
      }));
    }
    if (pathname === "/git/file-diff") {
      const root = url.searchParams.get("root") || "";
      const path = url.searchParams.get("path") || "";
      const mode = url.searchParams.get("mode") === "committed" ? "committed" : "working";
      if (!root || !path) return json({ error: "root and path are required" }, 400);
      if (heldBackFrom(caller, [root, resolvePath(root, path)])) return json(HELD_BACK, 403);
      // The same scope gate every other git route uses: a root off the wire is
      // not a licence to read any repo on the disk.
      if (!inScopeReal(root)) return json({ error: "out of scope" }, 403);
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
      // HEAD is in the key: the fingerprint is of the branch TIPS, shared by every
      // worktree of the repo, and a checkout moves HEAD without moving one. A
      // fingerprint alone kept naming the old branch as current — from the phone,
      // from a terminal, from anywhere. One small file read, no subprocess.
      const key = `branches:${root}:${headOf(root)}`;
      return body(await singleFlight(key, () => whileRefsHoldAsync(key, root, () => gitBranches(root))));
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
      // Desktop, phone and an extra tab each poll this on their own timer, and
      // a poll landing in the same instant as another was a second fan-out of
      // tmux spawns for an answer already on its way — see singleflight.ts.
      const live = (await singleFlight(`listPanes:${socketPath(lastTmuxTarget()?.socket ?? [])}`,
        () => listPanes(lastTmuxTarget()?.socket))).map(({ socket: _s, ...p }) => p);
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
    if ((pathname === "/git/conflict-blocks" || pathname === "/git/conflict-file")
      && heldBackFrom(caller, [url.searchParams.get("root") || "", resolvePath(url.searchParams.get("root") || "/", url.searchParams.get("path") || "")])) return json(HELD_BACK, 403);
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
    /* The desktop's own palette, for "System" to wear — null on a desktop that
       publishes none. Read-only and cheap: see desktopPalette.ts. */
    if (pathname === "/desktop/palette" && req.method === "GET") return json({ palette: desktopPalette() });
    if (pathname === "/desktop/logo" && req.method === "GET") {
      const svg = desktopLogo();
      return svg
        ? new Response(svg, { headers: { "content-type": "image/svg+xml", "cache-control": "private, max-age=3600" } })
        : new Response("no mark", { status: 404 });
    }
    if (pathname === "/theme/sync" && req.method === "POST") {
      if (!trustedCaller(req, from)) return csrfBlocked();
      /* This route writes files a person's tmux and nvim read, so an automated
         page load must not reach it — see #455, where a harness that loaded the
         cockpit left the machine's terminals white. The browser refuses first
         (navigator.webdriver in web/src/lib/themes.ts), and that check cannot
         see a plain CDP attach, which is what every script in scripts/ is. */
      if (automatedThemeClient(req.headers.get("user-agent"))) {
        return json({ ok: false, wrote: [], reloaded: [], error: "automated client: a theme reaches tmux and nvim only from a browser someone is using" });
      }
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
    if (pathname === "/issues/counts") {
      return json(await issueCounts(url.searchParams.get("root") || ""));
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
        : pathname === "/providers/disconnect" ? await disconnectProvider(id, { forgetBoards: b.forgetBoards === true })
        : pathname === "/providers/workspace"
          ? await chooseWorkspace(id, String(b.workspaceId ?? ""), String(b.name ?? ""))
        : null;
      if (!r) return json({ ok: false, error: "not found" }, 404);
      return json(r, r.ok ? 200 : 400);
    }
    /*
     * Which tracker each repository's cards live in, and the pull requests that
     * name a Jira card. One block: the choice is read by the card chip and the
     * merge form, and `/jira/prs` is the same search `/clickup/prs` runs, asked
     * with the card's key and no ClickUp id.
     */
    if (pathname === "/tracker/projects" && req.method === "GET") {
      // The repositories to offer a choice for are asked for, because naming
      // them reads each known project's remote (cached five minutes by prs.ts).
      const repos = url.searchParams.get("repos") === "1"
        ? [...new Set((await Promise.all(knownProjects().slice(0, 60).map((p) => prRepoIdFor(p.path).catch(() => null)))).flatMap((r) => r ? [r.nameWithOwner] : []))].sort()
        : undefined;
      return json({ ok: true, projects: trackerProjects(), ...(repos ? { repos } : null) });
    }
    if (pathname === "/tracker/projects" && req.method === "POST") {
      if (!trustedCaller(req, from)) return csrfBlocked();
      const b = await req.json().catch(() => ({})) as Record<string, unknown>;
      const r = setTrackerChoice(b.repo, b.tracker);
      return json(r, r.ok ? 200 : 400);
    }
    if (pathname === "/jira/prs" && req.method === "GET") {
      // A whole project in one search: the board's column. A key is the same
      // shape as below without its number, and just as unfit for anything else.
      const project = (url.searchParams.get("project") ?? "").trim();
      if (project) {
        if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(project)) return json({ ok: false, byCard: {}, error: "That is not a Jira project key" });
        return json(await projectPullRequests(project, prRouteRoot(url.searchParams.get("root") ?? "")));
      }
      const key = (url.searchParams.get("key") ?? "").trim();
      // A key is letters, digits and underscores, a hyphen, digits. It is handed to `gh --search`, so nothing else goes through.
      if (!/^[A-Za-z][A-Za-z0-9_]*-\d+$/.test(key)) return json({ ok: false, prs: [], error: "That is not a Jira card id" });
      const found = await cardPullRequests(key, undefined, prRouteRoot(url.searchParams.get("root") ?? ""));
      // What the card itself says on the site, one request, only when it is asked for by key (the card opened): never per row.
      const links = await jiraLinks(key);
      return json(links.ok && links.data?.length ? { ...found, prs: withStatedLinks(found.prs, links.data) } : found);
    }
    /*
     * The pull requests a card is linked to on the site, and linking one. The
     * read answers 200 with a sentence like the other Jira reads; the write is
     * trusted-caller only, behind the write switch, and idempotent: the card's
     * links are read first and an address already there is not posted again.
     */
    if (req.method === "GET" && pathname === "/jira/links") {
      const r = await jiraLinksAll((url.searchParams.get("key") ?? "").trim());
      return json(r.ok && r.data ? { ok: true, links: r.data.links, web: r.data.web } : { ok: false, links: [], web: [], error: r.error });
    }
    /*
     * `GET /jira/dev?id=`: what the site's development tool (GitHub for Jira and the like) knows about a card, by its numeric id,
     * which the card read already carries. Read once when the card is opened, never polled. `dev` is null whenever there is
     * nothing to show (no tool connected, a panel that is not there, a shape that changed): that is an answer, not an error.
     */
    if (req.method === "GET" && pathname === "/jira/dev") {
      const r = await jiraDev((url.searchParams.get("id") ?? "").trim());
      return json({ ok: true, dev: r.ok ? r.data ?? null : null });
    }
    /*
     * `GET /jira/activity?key=&kind=history|worklog|comments&startAt=`: one page of what happened on a card, read when its
     * tab is opened (history), or when the pane asks for more (the rest of the work log, comments past the card read).
     * Never part of opening a card. An answer is `{ok, events|comments, total, next?}`; `next` is the `startAt` of the following page.
     */
    if (req.method === "GET" && pathname === "/jira/activity") {
      const kind = url.searchParams.get("kind") ?? "";
      if (!(ACTIVITY_KINDS as readonly string[]).includes(kind)) return json({ ok: false, error: `kind is one of ${ACTIVITY_KINDS.join(", ")}` }, 400);
      const at = Number(url.searchParams.get("startAt") ?? 0);
      const r = await jiraActivity(kind as ActivityKind, (url.searchParams.get("key") ?? "").trim(), Number.isFinite(at) && at >= 0 ? at : 0);
      return json(r.ok && r.data ? { ok: true, ...r.data } : { ok: false, error: r.error });
    }
    if (pathname === "/jira/link" && req.method === "POST") {
      if (!trustedCaller(req, from)) return csrfBlocked();
      const b = await req.json().catch(() => ({})) as Record<string, unknown>;
      const r = await jiraLink(String(b.key ?? "").trim(), String(b.url ?? ""), typeof b.title === "string" ? b.title : "");
      return json(r, r.ok ? 200 : 400);
    }
    /*
     * Jira. `/jira/connect` is the second route that receives a token, and like
     * `/providers/connect` it answers with who you are and never with the
     * credential, the email or the address as typed. It is on the understudy's
     * blind list by name (UNDERSTUDY_BLIND) for the same reason that one is.
     */
    if (pathname === "/jira/status") return json(await jiraStatus());
    /*
     * Reading cards. Answers are 200 with `ok: false` and a sentence, the way
     * the ClickUp reads answer: "not connected" is not a failed request. The
     * token is read inside `withStored` and never reaches a response.
     */
    if (req.method === "GET" && pathname === "/jira/task") {
      const r = await withJira((c) => readIssue(c, url.searchParams.get("id") ?? ""));
      return json(r.ok ? { ok: true, task: r.data } : { ok: false, error: r.error });
    }
    if (req.method === "GET" && pathname === "/jira/find") {
      /* One fact, two views: what the panel just read is what the list draws. */
      const r = await withJira(async (c) => {
        const found = await findIssue(c, url.searchParams.get("q") ?? "");
        if (found.ok && found.data) holdJiraCard(c.site, found.data.task);
        return found;
      });
      return json(r.ok ? { ok: true, ...r.data } : { ok: false, error: r.error });
    }
    if (req.method === "GET" && (pathname === "/jira/mine" || pathname === "/jira/search")) {
      const r = await withJira((c) => pathname === "/jira/mine" ? jiraMine(c, { fresh: url.searchParams.get("fresh") === "1" }) : jiraSearchText(c, url.searchParams.get("q") ?? ""));
      return json(r.ok ? { ok: true, ...r.data } : { ok: false, error: r.error, ...(r.throttled ? { throttled: true } : null) });
    }
    if (pathname === "/jira/connect" && req.method === "POST") {
      if (!trustedCaller(req, from)) return csrfBlocked();
      const b = await req.json().catch(() => ({})) as Record<string, unknown>;
      const r = await connectJira({ email: b.email, site: b.site, token: b.token, auth: b.auth });
      return json(r, r.ok ? 200 : 400);
    }
    if (pathname === "/jira/writes" && req.method === "POST") {
      if (!trustedCaller(req, from)) return csrfBlocked();
      const b = await req.json().catch(() => ({})) as Record<string, unknown>;
      if (typeof b.on !== "boolean") return json({ ok: false, error: "on must be true or false" }, 400);
      if (!mayPublishReview(req, caller)) return viaDoor("/jira/writes", "jira.writes", b.on, b.as);
      setJiraWrites(b.on);
      return json({ ok: true, writes: jiraWriteEnabled() });
    }
    if (pathname === "/jira/write-kinds" && req.method === "POST") {
      if (!trustedCaller(req, from)) return csrfBlocked();
      const b = await req.json().catch(() => ({})) as Record<string, unknown>;
      const kind = (JIRA_WRITE_KINDS as readonly string[]).includes(String(b.kind)) ? b.kind as JiraWriteKind : null;
      if (!kind || typeof b.on !== "boolean") return json({ ok: false, error: "kind is move, comment, link or assign, and on is true or false" }, 400);
      if (!mayPublishReview(req, caller)) return viaDoor("/jira/write-kinds", `jira.writes.${kind}`, b.on, b.as);
      setJiraWriteKind(kind, b.on);
      return json({ ok: true, writeKinds: jiraWriteKinds() });
    }
    /*
     * Moving a card. The list is a read, answered 200 like the other Jira reads
     * (an empty list carries the sentence "You cannot move ..."). The move is a
     * write: ClickUp's status codes, 409 for a card that changed underneath.
     */
    if (req.method === "GET" && pathname === "/jira/transitions") {
      const r = await jiraMoves(url.searchParams.get("key") ?? "");
      return json(r.ok ? { ok: true, ...r.data } : { ok: false, error: r.error, ...(r.throttled ? { throttled: true } : null) });
    }
    if (pathname === "/jira/transition" && req.method === "POST") {
      if (!trustedCaller(req, from)) return csrfBlocked();
      const b = await req.json().catch(() => ({})) as Record<string, unknown>;
      const r = await jiraMove(String(b.key ?? ""), String(b.transitionId ?? ""), typeof b.updated === "number" ? b.updated : 0, b.fields);
      // The watch must not announce the person's own move as news.
      if (r.ok && r.task && r.was) jiraRememberOwnMove({ ...r.task, status: r.was }, r.task.status);
      return json(r, r.ok ? 200 : r.conflict ? 409 : 400);
    }
    /*
     * Who is on a card, and the hand-off. People are a read (200 with a
     * sentence); the two writes answer like the move, and like it tell the watch
     * the change was ours. The hand-off is ONE route on purpose: the server
     * orders its writes, so no client can race its own stamp (see handOff).
     * `/jira/settings` is local: the write switch and the hand-off per project.
     */
    if (req.method === "GET" && pathname === "/jira/assignable") {
      const r = await jiraAssignable(url.searchParams.get("key") ?? "", url.searchParams.get("q") ?? "", url.searchParams.get("transition") ?? "");
      return json(r.ok ? { ok: true, people: r.data ?? [] } : { ok: false, error: r.error, ...(r.throttled ? { throttled: true } : null) });
    }
    if (pathname === "/jira/assignee" && req.method === "POST") {
      if (!trustedCaller(req, from)) return csrfBlocked();
      const b = await req.json().catch(() => ({})) as Record<string, unknown>;
      // Anything but a person key or null is refused inside, before a request.
      const r = await jiraSetAssignee(String(b.key ?? ""), b.to as string | null, typeof b.updated === "number" ? b.updated : 0);
      if (r.ok && r.task) jiraRememberOwnAssign(r.task);
      return json(r, r.ok ? 200 : r.conflict ? 409 : 400);
    }
    if (pathname === "/jira/handoff" && req.method === "POST") {
      if (!trustedCaller(req, from)) return csrfBlocked();
      const b = await req.json().catch(() => ({})) as Record<string, unknown>;
      const r = await jiraHandOff(String(b.key ?? ""), typeof b.updated === "number" ? b.updated : 0, {
        ...(typeof b.to === "string" ? { to: b.to } : null),
        ...(typeof b.clear === "boolean" ? { clear: b.clear } : null),
      });
      // A card that moved but could not be read back is still our move (`moved` carries it).
      if (r.ok && r.was !== undefined && (r.task || r.moved)) jiraRememberOwnMove({ ...(r.task ?? r.moved!), status: r.was }, r.task?.status ?? r.moved!.status);
      return json(r, r.ok ? 200 : r.conflict ? 409 : 400);
    }
    /*
     * Steps: what a button on a pull request does to a Jira card, global to the site and by status name.
     * `POST /jira/step` runs one, as ONE request, ordered here (the stamp is checked once, before any write);
     * the settings write only the local file. Behind the write switch like every other write.
     */
    if (req.method === "GET" && pathname === "/jira/steps") return json({ ok: true, ...jiraSteps() });
    if (pathname === "/jira/steps" && req.method === "POST") {
      if (!trustedCaller(req, from)) return csrfBlocked();
      const b = await req.json().catch(() => ({})) as Record<string, unknown>;
      const r = setJiraSteps(b.steps);
      return json(r.ok ? { ok: true, steps: r.steps, overrides: r.overrides } : r, r.ok ? 200 : 400);
    }
    if (pathname === "/jira/step" && req.method === "POST") {
      if (!trustedCaller(req, from)) return csrfBlocked();
      const b = await req.json().catch(() => ({})) as Record<string, unknown>;
      const r = await runStepBody(b);
      if (r.ok && r.was !== undefined && (r.task || r.moved)) jiraRememberOwnMove({ ...(r.task ?? r.moved!), status: r.was }, r.task?.status ?? r.moved!.status);
      return json(r, r.ok ? 200 : r.conflict ? 409 : 400);
    }
    /*
     * The agent door to a card (`agentglass-ui jira ...`, one MCP tool per verb): read it, its moves
     * and steps, run a step, link a pull request. Every verb calls what the routes above call, so the
     * Jira write switch, the per-card lock and the stamp are theirs; this adds the stamp `as`, the
     * control level (the acting verbs leave the app, so they need level 3 as well as the Jira switch, and
     * are refused below it before anything is read), the per-caller write limit and one audit line, and
     * answers in `{state, untrusted}`.
     */
    if (pathname.startsWith("/jira/door/") && req.method === "POST") {
      if (!trustedCaller(req, from)) return csrfBlocked();
      const verb = pathname.slice("/jira/door/".length);
      const b = await req.json().catch(() => ({})) as Record<string, unknown>;
      const as = callerRequestId(b.as);
      const who = caller ? asActor(caller) : null;
      const audit = (ok: boolean, error?: string) =>
        noteAction(clientIp, `/jira/door/${verb}`, { ...(as ? { as } : {}), ...(isDoorActing(verb) && typeof b.key === "string" && ISSUE_KEY.test(b.key) ? { key: b.key } : {}) }, { ok, error }, who);
      if (!(DOOR_VERBS as readonly string[]).includes(verb)) return json({ ok: false, error: `That is not a card verb: ${DOOR_VERBS.join(", ")}` }, 404);
      if (isDoorActing(verb)) {
        const held = doorActingRefusal(verb, CONTROL.level, CONTROL.readonly);
        if (held) { audit(false, "level"); return json({ ok: false, error: held }, 403); }
        if (!controlWriteLimit.hit(actorOf(clientIp, who))) { audit(false, "rate limited"); return json({ ok: false, error: "too many changes from this caller; slow down" }, 429); }
      }
      const r = await runDoor(verb, b);
      audit(r.body.ok === true, typeof r.body.error === "string" ? r.body.error : undefined);
      return json(r.body, r.status);
    }
    if (req.method === "GET" && pathname === "/jira/settings") return json({ ok: true, ...jiraSettings() });
    if (pathname === "/jira/settings" && req.method === "POST") {
      if (!trustedCaller(req, from)) return csrfBlocked();
      const b = await req.json().catch(() => ({})) as Record<string, unknown>;
      const r = jiraSetHandoff(b.project, b.rule === undefined ? undefined : b.rule);
      return json(r.ok ? { ok: true, ...r.settings } : r, r.ok ? 200 : 400);
    }
    /*
     * The projects the workflow map is drawn from, with their statuses: the ones the person chose, else where
     * their cards live. The pick is local; nothing here writes to Jira.
     */
    if (req.method === "GET" && pathname === "/jira/status-units") {
      const r = await jiraStatusUnitsStored(url.searchParams.get("fresh") === "1");
      return json(r.ok ? { ok: true, ...r.data, counted: countedProjects() } : { ok: false, error: r.error, ...(r.throttled ? { throttled: true } : null) });
    }
    if (pathname === "/jira/status-units" && req.method === "POST") {
      if (!trustedCaller(req, from)) return csrfBlocked();
      const raw = await req.json().catch(() => null) as unknown;
      const b = typeof raw === "object" && raw !== null && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
      const r = b && Object.keys(b).every((k) => k === "counted") ? setCountedProjects(b.counted) : { ok: false as const, error: "That is not a list of Jira project keys" };
      return json(r, r.ok ? 200 : 400);
    }
    if (req.method === "GET" && pathname === "/jira/project-statuses") {
      const r = await jiraProjectStatuses(url.searchParams.get("project") ?? "");
      return json(r.ok ? { ok: true, statuses: r.data ?? [] } : { ok: false, error: r.error, ...(r.throttled ? { throttled: true } : null) });
    }
    /*
     * Saved Jira views: boards, saved filters and searches, and projects as
     * folders. Nothing here writes to Jira (so no write gate); the POSTs change
     * only the local address book, behind the same CSRF check as the other
     * local writes. Reads answer 200 with `ok: false` and a sentence.
     * `/jira/views` is the local store alone: its only request, made in the
     * background, is the stale-folder refresh.
     */
    if (req.method === "GET" && pathname === "/jira/views") {
      void refreshJiraFoldersIfStale();
      return json(jiraViews());
    }
    if (req.method === "GET" && pathname === "/jira/view") {
      // `filters` is a comma list of the board's own quick-filter ids; the server looks each up, a query never comes from here.
      const quick = (url.searchParams.get("filters") ?? "").split(",").map((x) => x.trim()).filter(Boolean).slice(0, 9);
      return json(await jiraViewRead(url.searchParams.get("id") || undefined, { force: url.searchParams.get("force") === "1", cached: url.searchParams.get("cached") === "1", quick }));
    }
    /* What sits around a board's cards: quick filters, the active sprint, the epics. Kept ten minutes per board (jiraBoardContext.ts). */
    if (req.method === "GET" && pathname === "/jira/board-context") {
      const r = await withJira(async (c) => ({ ok: true, data: await jiraBoardContext(c, url.searchParams.get("id") ?? "") }));
      return json(r.ok && r.data ? r.data : { ok: false, error: r.error, filters: [], epics: [], ...(r.throttled ? { throttled: true } : null) });
    }
    /* The cards under the board's epics, one kept read for the Areas tree and an Area's page (jiraboards.ts `readBoardAreas`). */
    if (req.method === "GET" && pathname === "/jira/board-areas") {
      const r = await withJira((c) => jiraBoardAreas(c, (url.searchParams.get("id") ?? "").replace(/^board:/, "")));
      return json(r.ok && r.data ? { ok: true, ...r.data } : { ok: false, error: r.error, tasks: [], ...(r.throttled ? { throttled: true } : null) });
    }
    if (pathname === "/jira/rank" && req.method === "POST") {
      if (!trustedCaller(req, from)) return csrfBlocked();
      const b = await req.json().catch(() => ({})) as Record<string, unknown>;
      const r = await jiraRank(String(b.key ?? ""), { before: b.before, after: b.after });
      return json(r, r.ok ? 200 : 400);
    }
    if (req.method === "GET" && pathname === "/jira/view-choices") {
      const r = await withJira((c) => jiraViewChoices(c, url.searchParams.get("q") ?? ""));
      return json(r.ok ? { ok: true, ...r.data } : { ok: false, error: r.error, ...(r.throttled ? { throttled: true } : null) });
    }
    if (req.method === "GET" && pathname === "/jira/project-choices") {
      const r = await withJira((c) => jiraProjectChoices(c));
      return json(r.ok ? { ok: true, ...r.data } : { ok: false, error: r.error, ...(r.throttled ? { throttled: true } : null) });
    }
    if (pathname === "/jira/views/add" && req.method === "POST") {
      if (!trustedCaller(req, from)) return csrfBlocked();
      const b = await req.json().catch(() => ({})) as Record<string, unknown>;
      const r = typeof b.url === "string" ? await jiraAddViewByUrl(b.url) : await jiraAddViewByChoice(b.kind, b.id);
      const out = r.ok && r.data ? r.data : { ok: false, error: r.error };
      return json(out, out.ok ? 200 : 400);
    }
    if (pathname === "/jira/views/remove" && req.method === "POST") {
      if (!trustedCaller(req, from)) return csrfBlocked();
      const b = await req.json().catch(() => ({})) as Record<string, unknown>;
      const r = jiraRemoveView(String(b.id ?? ""));
      return json(r, r.ok ? 200 : 400);
    }
    if (pathname === "/jira/folders/add" && req.method === "POST") {
      if (!trustedCaller(req, from)) return csrfBlocked();
      const b = await req.json().catch(() => ({})) as Record<string, unknown>;
      const r = await jiraAddFolder(b.key);
      return json(r.ok ? { ok: true, ...r.data } : { ok: false, error: r.error }, r.ok ? 200 : 400);
    }
    if (pathname === "/jira/folders/remove" && req.method === "POST") {
      if (!trustedCaller(req, from)) return csrfBlocked();
      const b = await req.json().catch(() => ({})) as Record<string, unknown>;
      jiraRemoveFolder(String(b.id ?? ""));
      return json({ ok: true });
    }
    /*
     * A Jira card's words. `/jira/detail` is the card with its description and
     * comments as Markdown (one issue read); `/jira/people` is who a comment
     * may mention, for what was typed after `@`. Both answer 200 with `ok:
     * false` and a sentence, like the other Jira reads. `/jira/comment` is a
     * write behind the write switch: 400 with a sentence when refused. The
     * format on the wire (ADF or wiki markup) is the connection's, decided in
     * jiraComments.ts.
     */
    if (req.method === "GET" && pathname === "/jira/detail") {
      const r = await jiraDetailRead(url.searchParams.get("key") ?? "");
      return json(r.ok && r.data ? { ok: true, detail: r.data.detail, more: r.data.more } : { ok: false, error: r.error, ...(r.throttled ? { throttled: true } : null) });
    }
    if (req.method === "GET" && pathname === "/jira/people") {
      const r = await jiraMentionable(url.searchParams.get("key") ?? "", url.searchParams.get("q") ?? "");
      return json(r.ok ? { ok: true, people: r.data ?? [] } : { ok: false, error: r.error, ...(r.throttled ? { throttled: true } : null) });
    }
    if (pathname === "/jira/comment" && req.method === "POST") {
      if (!trustedCaller(req, from)) return csrfBlocked();
      const b = await req.json().catch(() => ({})) as Record<string, unknown>;
      const r = await jiraCommentOn(String(b.key ?? ""), typeof b.text === "string" ? b.text : "", b.mentions, b.replyTo);
      return json(r, r.ok ? 200 : 400);
    }
    /* Your own comment, changed or deleted. Both behind the write switch, 400 with a sentence when refused. */
    if (pathname === "/jira/comment/edit" && req.method === "POST") {
      if (!trustedCaller(req, from)) return csrfBlocked();
      const b = await req.json().catch(() => ({})) as Record<string, unknown>;
      const r = await jiraCommentEdit(String(b.key ?? ""), String(b.id ?? ""), typeof b.text === "string" ? b.text : "", b.mentions);
      return json(r, r.ok ? 200 : 400);
    }
    if (pathname === "/jira/comment/delete" && req.method === "POST") {
      if (!trustedCaller(req, from)) return csrfBlocked();
      const b = await req.json().catch(() => ({})) as Record<string, unknown>;
      const r = await jiraCommentDelete(String(b.key ?? ""), String(b.id ?? ""));
      return json(r, r.ok ? 200 : 400);
    }
    /* Time logged on a card (jiraWorklog.ts): an entry added, and your own entries changed or deleted. Each behind the write switch and
       the card's stamp: 409 when the card moved since the person saw it, 400 with a sentence when refused. The answer is the card again
       with the remaining estimate before and after. */
    if ((pathname === "/jira/worklog" || pathname === "/jira/worklog/edit" || pathname === "/jira/worklog/delete") && req.method === "POST") {
      if (!trustedCaller(req, from)) return csrfBlocked();
      const b = await req.json().catch(() => ({})) as Record<string, unknown>;
      const key = String(b.key ?? "");
      const stamp = typeof b.updated === "number" ? b.updated : 0;
      const ask = { time: b.time, started: b.started, note: b.note, adjust: b.adjust };
      const r = pathname === "/jira/worklog" ? await jiraWorkLog(key, ask, stamp)
        : pathname === "/jira/worklog/edit" ? await jiraWorkEdit(key, String(b.id ?? ""), ask, stamp)
        : await jiraWorkDelete(key, String(b.id ?? ""), ask, stamp);
      return json(r, r.ok ? 200 : r.conflict ? 409 : 400);
    }
    /* The connected account's own marks on a card (jiraFollow.ts): watching it and voting for it, each `{ key, on }` and one request. Behind
       the write switch and, unlike the card's other changes, with no stamp: neither moves the card, and both are idempotent. */
    if ((pathname === "/jira/watch" || pathname === "/jira/vote") && req.method === "POST") {
      if (!trustedCaller(req, from)) return csrfBlocked();
      const b = await req.json().catch(() => ({})) as Record<string, unknown>;
      const r = await (pathname === "/jira/watch" ? jiraWatch : jiraVote)(String(b.key ?? ""), b.on);
      return json(r, r.ok ? 200 : 400);
    }
    /* One field of a card's Details changed (jiraEdit.ts). 409 when the card moved since the person saw it. */
    if (pathname === "/jira/edit" && req.method === "POST") {
      if (!trustedCaller(req, from)) return csrfBlocked();
      const b = await req.json().catch(() => ({})) as Record<string, unknown>;
      const r = await jiraEditCard(String(b.key ?? ""), { field: b.field, value: b.value, add: b.add, remove: b.remove, mentions: b.mentions }, typeof b.updated === "number" ? b.updated : 0);
      return json(r, r.ok ? 200 : r.conflict ? 409 : 400);
    }
    /* What a card is joined to (jiraRelate.ts): a sub-task, a link to another card and a web address, each behind the write switch.
       The link types are a read. A removal is by an id the card itself holds; the answer is the card again, or the card's addresses. */
    if (req.method === "GET" && pathname === "/jira/link-types") {
      const r = await jiraLinkKinds();
      return json(r.ok ? { ok: true, kinds: r.data ?? [] } : { ok: false, kinds: [], error: r.error, ...(r.throttled ? { throttled: true } : null) });
    }
    if (req.method === "POST" && (pathname === "/jira/subtask" || pathname === "/jira/relate" || pathname === "/jira/relate/remove" || pathname === "/jira/weblink" || pathname === "/jira/weblink/remove")) {
      if (!trustedCaller(req, from)) return csrfBlocked();
      const b = await req.json().catch(() => ({})) as Record<string, unknown>;
      const key = String(b.key ?? "").trim();
      const r = pathname === "/jira/subtask" ? await jiraSubtask(key, b.title)
        : pathname === "/jira/relate" ? await jiraRelate(key, { other: b.other, typeId: b.typeId, outward: b.outward })
        : pathname === "/jira/relate/remove" ? await jiraUnrelate(key, b.id)
        : pathname === "/jira/weblink" ? await jiraWebLink(key, b.url, b.title)
        : await jiraWebUnlink(key, b.id);
      return json(r, r.ok ? 200 : 400);
    }
    /*
     * A card's files (jiraFiles.ts). `GET /jira/file` streams one file's bytes, or its small picture with `thumb=1`, through
     * this server so the credential never leaves it, and only a file the card read listed: a caller names a card and an id,
     * never an address. What the site redirects to is followed here and is never in an answer. A file that is not a picture
     * or a video is a download (`download=1` makes any file one). `POST /jira/attach` adds one (multipart: `key`, `file`)
     * and `POST /jira/attach/remove` takes one of your own off, both behind the write switch.
     */
    if (req.method === "GET" && pathname === "/jira/file") {
      const r = await jiraFileServe({
        key: url.searchParams.get("key") ?? "", id: url.searchParams.get("id") ?? "", thumb: url.searchParams.get("thumb") === "1",
        download: url.searchParams.get("download") === "1", range: req.headers.get("range"), signal: req.signal,
      });
      return "res" in r ? r.res : json({ ok: false, error: r.error }, r.status);
    }
    if (req.method === "POST" && pathname === "/jira/attach") {
      if (!trustedCaller(req, from)) return csrfBlocked();
      // The declared length first: a body this large is refused before any of it is read.
      if (Number(req.headers.get("content-length")) > JIRA_UPLOAD_MAX + 64 * 1024) return json({ ok: false, error: `A file added here is at most ${JIRA_UPLOAD_MAX / (1024 * 1024)} MB. Add a bigger one in Jira` }, 413);
      const form = await req.formData().catch(() => null);
      const file = form?.get("file");
      if (!form || !(file instanceof File)) return json({ ok: false, error: "Send the file as a form with a `file` part" }, 400);
      const r = await jiraAttach(String(form.get("key") ?? "").trim(), file.name, new Uint8Array(await file.arrayBuffer()));
      return json(r, r.ok ? 200 : 400);
    }
    if (req.method === "POST" && pathname === "/jira/attach/remove") {
      if (!trustedCaller(req, from)) return csrfBlocked();
      const b = await req.json().catch(() => ({})) as Record<string, unknown>;
      const r = await jiraUnattach(String(b.key ?? "").trim(), b.id);
      return json(r, r.ok ? 200 : 400);
    }
    if (req.method === "GET" && pathname === "/jira/labels") {
      const r = await jiraLabels(url.searchParams.get("q") ?? "");
      return json(r.ok ? { ok: true, labels: r.data ?? [] } : { ok: false, error: r.error, ...(r.throttled ? { throttled: true } : null) });
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
      const { reviewRecipes, hiddenRecipes } = await import("./reviewPrompts.ts");
      return json({ ok: true, recipes: reviewRecipes(), hidden: hiddenRecipes() });
    }
    /* Ahead of the /pr-prompts/ family below, whose prefix would answer
       "not found" for it. What the conflict button says, and which model it opens on. POST because
       the file list can be long; it reads only the worktree it is given, and
       only when that is in scope. */
    if (pathname === "/pr-prompts/conflict" && req.method === "POST") {
      if (!trustedCaller(req, from)) return csrfBlocked();
      const b = await req.json().catch(() => ({})) as Record<string, unknown>;
      const worktree = String(b.worktree ?? "");
      if (!worktree || !inScope(worktree)) return json({ ok: false, error: "that worktree is not in scope" }, 400);
      const str = (v: unknown) => (typeof v === "string" ? v : undefined);
      const files = Array.isArray(b.files) ? b.files.filter((f): f is string => typeof f === "string").slice(0, 500) : [];
      return json({ ok: true, ...conflictPrompt({
        worktree, files,
        number: typeof b.number === "number" ? b.number : 0,
        repo: str(b.repo), branch: str(b.branch), base: str(b.base), title: str(b.title),
      }) });
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
      return json({ views: savedViews(), folders: savedFolders(), connected: hasCredential("clickup"), current: currentView(), prefix: knownCardPrefix(), noCustomIds: knownNoCustomIds(), writeEnabled: clickupWriteEnabled(), writeForced: process.env.AGENTGLASS_CLICKUP_WRITE === "1" });
    }
    /* The folder picker's two reads. Spaces first, then one call per space that
       answers with its folders AND the lists inside each of them — which is why
       adding a folder costs nothing beyond what the picker already spent. */
    if (pathname === "/clickup/spaces") {
      const { clickupSpaces } = await import("./clickup.ts");
      const r = await clickupSpaces(url.searchParams.get("fresh") === "1");
      return json(r.ok ? { ok: true, spaces: r.data?.spaces ?? [] } : { ok: false, error: r.error, throttled: r.throttled === true, unauthorised: r.unauthorised === true });
    }
    /* The picker's spaces: the ones this person's cards live in first, the rest after. */
    if (pathname === "/clickup/status-spaces") {
      const { clickupStatusSpaces } = await import("./clickup.ts");
      const r = await clickupStatusSpaces(url.searchParams.get("fresh") === "1");
      return json(r.ok ? { ok: true, ...r.data } : { ok: false, error: r.error, throttled: r.throttled === true, unauthorised: r.unauthorised === true });
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
      if (!token) return json({ ok: false, error: notConnected("clickup", "ClickUp is not connected") });
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
      if (!token) return json({ ok: false, error: notConnected("clickup", "ClickUp is not connected") });
      if (!listId) return json({ ok: false, error: "no list asked for" }, 400);
      const r = await listMeta(token, listId);
      return json(r.ok ? { ok: true, ...r.data } : { ok: false, error: r.error }, r.ok ? 200 : 400);
    }
    if (pathname === "/clickup/prs") {
      // The checkout the search runs in, vetted the same way every other route
      // vets one: a path outside the configured scope is refused rather than
      // corrected, and `gh` then runs where the app already lives.
      const asked = url.searchParams.get("root") ?? "";
      const root = prRouteRoot(asked);
      const r = await cardPullRequests(
        url.searchParams.get("card") ?? "",
        url.searchParams.get("field") ?? undefined,
        root,
        url.searchParams.get("task") ?? "",
      );
      return json(r);
    }
    if (pathname === "/clickup/find") {
      // The prefix comes from what we have already read, so a bare number is
      // enough and nobody has to be asked what their ids look like.
      const r = await findCard(url.searchParams.get("q") ?? "", knownCardPrefix(), { noCustomIds: knownNoCustomIds() });
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
      // workspace here holds the whole organisation, and a picker offering all of
      // them to assign one backend card is a picker nobody uses twice.
      /* No list: the workspace's people, for a setting that names one before a card is open. */
      const r = url.searchParams.has("workspace") ? await workspaceMembers() : await listMembers(url.searchParams.get("list") ?? "");
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
     * A search that answers only at the end made a person watch a spinner.
     * The sweep is three sequential pages of a workspace with thousands of cards, and
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
      /* Not connected is an answer, not a failed request: 200 like every other
         ClickUp read, so a client reads one status convention and devtools show
         no red line for a machine that never connected. */
      if (!hasCredential("clickup")) return json({ ok: false, error: notConnected("clickup", "ClickUp is not connected") });
      const q = url.searchParams.get("q") ?? "";
      const force = url.searchParams.get("force") === "1";
      const r = await searchTasks(q, force);
      return json(r.ok ? { ok: true, ...r.data } : { ok: false, error: r.error }, r.ok ? 200 : 400);
    }
    // The sprints this card could move to. A GET because it reads, and behind
    // the card's own id because a sprint is a list in the CARD's space — there
    // is no workspace-wide answer to ask for.
    if (pathname === "/clickup/sprints") {
      if (!hasCredential("clickup")) return json({ ok: false, error: notConnected("clickup", "ClickUp is not connected") });
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
    /* Every tag the card's space has, for the picker. Separate from the card
       itself because it is asked for on a click and answered from a cache —
       see `tagsForTask` for why it is by space. */
    if (pathname === "/clickup/tags") {
      const r = await tagsForTask(url.searchParams.get("id") ?? "");
      return json(r.ok ? { ok: true, tags: r.data ?? [] } : { ok: false, error: r.error });
    }
    // How much of ClickUp's per-minute allowance the last minute spent: read from the last response, asks ClickUp for nothing.
    if (pathname === "/clickup/budget") {
      const { budgetView, rateBudget } = await import("./clickup.ts");
      return json({ ok: true, ...budgetView(rateBudget()) });
    }
    // How this workspace uses ClickUp. A POST is a partial update, validated as a
    // whole: anything refused writes nothing and says which setting and why.
    if (pathname === "/clickup/prefs") {
      if (req.method !== "POST") return json({ ok: true, prefs: clickupPrefs() });
      if (!trustedCaller(req, from)) return csrfBlocked();
      const before = clickupPrefs().assigned.includeSubtasks;
      const body = await req.json().catch(() => null) as { assigned?: { includeSubtasks?: unknown }; as?: unknown } | null;
      // The heavier read is an escalation for an agent (the settings door); the rest of the prefs are not.
      if (!mayPublishReview(req, caller) && body?.assigned?.includeSubtasks === true && !before) return viaDoor("/clickup/prefs", "clickup.includeSubtasks", true, body.as);
      const r = setClickupPrefs(body);
      // The cached board was read without (or with) subtasks; a stale answer
      // under the new setting would look like the switch did nothing.
      if (r.ok && r.prefs.assigned.includeSubtasks !== before) dropAssignedCache();
      return json(r, r.ok ? 200 : 400);
    }
    if (pathname.startsWith("/clickup/") && req.method === "POST") {
      // Assign somebody, move a card, set a field, add or drop a board, and
      // switch writing on. The change does not land on this machine, which is
      // exactly why it was easy to miss: it lands in a shared workspace where
      // colleagues can see it and where nothing here can take it back.
      if (!trustedCaller(req, from)) return csrfBlocked();
      const b = await req.json().catch(() => ({})) as Record<string, unknown>;
      if (pathname === "/clickup/writes" && !mayPublishReview(req, caller)) return viaDoor("/clickup/writes", "clickup.writes", b.on === true, b.as);
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
            addMe: b.addMe === true,
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
      if (r.ok && "task" in r && r.task) patchCachedTask(r.task);
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

    if (pathname === "/machine/ports") return json(await listPortsAsync());
    if (pathname === "/machine/resources") return json(listResources(Number(url.searchParams.get("limit") || 40)));
    // Cached: the sampler walks /proc every few minutes. `?fresh=1` (the panel
    // being open) may walk again, but never faster than every 30 seconds.
    if (pathname === "/machine/orphans") return json(orphanReport(url.searchParams.get("fresh") === "1", orphanCtx()));
    // On demand and cached for five minutes: a scan runs du, git and docker.
    // `?fresh=1` may rescan, but never faster than every 30 seconds. Read-only.
    if (pathname === "/machine/disk-clean") return json(await diskCleanReport(url.searchParams.get("fresh") === "1", diskCtx()));
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
      if (heldBackFrom(caller, filesReach(pathname, url.searchParams))) return json(HELD_BACK, 403);
      // What a listing or a search RETURNS is narrowed the same way: a name
      // under ~/.ssh is not the key, but it is a map of where the keys are.
      const held = heldBackTest(caller);
      const shown = (rel: string) => !held(resolvePath(root, rel));
      if (pathname === "/files/tree") {
        const t = fileTree(root, url.searchParams.get("rel") || "");
        return json({ ...t, entries: t.entries.filter((e) => shown(e.rel)) });
      }
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
      if (pathname === "/files/find") {
        const f = findFiles(root, url.searchParams.get("q") || "", undefined, url.searchParams.get("ref") || undefined);
        return json({ ...f, files: f.files.filter(shown), dirs: f.dirs.filter(shown) });
      }
      if (pathname === "/files/grep") {
        const g = grepFiles(root, url.searchParams.get("q") || "", undefined, url.searchParams.get("ref") || undefined);
        return json({ ...g, hits: g.hits.filter((h) => shown(h.rel)) });
      }
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
    /* The Finder's own editor (bench slot FINDER_EDIT_SLOT): is it running, has it unsaved buffers, and write them. Constants only reach nvim. */
    if (pathname === "/bench/finder-edit") return json(await finderEditState(url.searchParams.get("root") || ""));
    if (pathname === "/bench/finder-edit/end" && req.method === "POST") {
      if (!trustedCaller(req, from)) return csrfBlocked();
      let b: { root?: unknown } = {};
      try { b = (await req.json()) as { root?: unknown }; } catch { return json({ ok: false, error: "invalid json" }, 400); }
      return json(await finderEditEnd(b?.root));
    }
    if (pathname === "/bench/finder-edit/save" && req.method === "POST") {
      if (!trustedCaller(req, from)) return csrfBlocked();
      let b: { root?: unknown } = {};
      try { b = (await req.json()) as { root?: unknown }; } catch { return json({ ok: false, error: "invalid json" }, 400); }
      return json(await finderEditSave(b?.root));
    }
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

    /* The DEVICES list of the finder's sidebar. Reading it is as open as
       browsing; doing something to one is a write to hardware, so it takes the
       same page gate every write takes plus the desk key, and anyone else may only read: see devicePolicy. The monitor starts on the first read
       and a change that alters the list reaches every window as one frame. */
    if (pathname === "/finder/devices" && req.method === "GET") {
      if (!FS_BROWSE_ENABLED) return json({ error: "directory browsing is disabled (AGENTGLASS_FS_BROWSE_DISABLED=1)" }, 403);
      ensureDeviceWatch(() => broadcast({ type: "devices" }));
      return json(await listDevices());
    }
    if (pathname.startsWith("/finder/devices/") && req.method === "POST") {
      if (!FS_BROWSE_ENABLED) return json({ error: "directory browsing is disabled (AGENTGLASS_FS_BROWSE_DISABLED=1)" }, 403);
      if (!trustedCaller(req, from)) return csrfBlocked();
      const act = pathname.slice("/finder/devices/".length) as DeviceAct;
      if (!["mount", "unmount", "eject", "unlock", "lock"].includes(act)) return json({ ok: false, error: "unknown action" }, 404);
      const no = devicePolicy(act, deskHeld() && deskKeyOk(req));
      if (no) return json({ ok: false, error: no }, 403);
      let b: { id?: unknown; passphrase?: unknown } = {};
      try { b = (await req.json()) as typeof b; } catch { return json({ ok: false, error: "invalid json" }, 400); }
      const r = await actOnDevice(act, b?.id, b?.passphrase);
      b = {};
      if (r.ok) broadcast({ type: "devices" });
      return json(r, r.ok ? 200 : 400);
    }

    /* The Network row and connecting to a server (SFTP, SMB through GVfs).
       Listing the network is a read; every step of a connection is a write that
       carries a credential or a host-key decision, so each takes the page gate
       and a caller with no page is refused (remotePolicy). The request body
       is read into the call and not logged (JS cannot wipe a string, so nothing here promises more). */
    if (pathname === "/finder/network" && req.method === "GET") {
      if (!FS_BROWSE_ENABLED) return json({ error: "directory browsing is disabled (AGENTGLASS_FS_BROWSE_DISABLED=1)" }, 403);
      return json(await discoverNetwork(runTool));
    }
    if ((pathname === "/finder/remotes/connect" || pathname === "/finder/remotes/answer" || pathname === "/finder/remotes/cancel") && req.method === "POST") {
      if (!FS_BROWSE_ENABLED) return json({ error: "directory browsing is disabled (AGENTGLASS_FS_BROWSE_DISABLED=1)" }, 403);
      if (!trustedCaller(req, from)) return csrfBlocked();
      const no = remotePolicy(deskHeld() && deskKeyOk(req));
      if (no) return json({ state: "error", error: no }, 403);
      let b: { uri?: unknown; session?: unknown; answers?: Record<string, unknown>; choice?: unknown } = {};
      try { b = (await req.json()) as typeof b; } catch { return json({ state: "error", error: "invalid json" }, 400); }
      ensureDeviceWatch(() => broadcast({ type: "devices" }));
      let step;
      if (pathname.endsWith("/connect")) step = await remoteSessions.start(b?.uri);
      else if (pathname.endsWith("/answer")) step = await remoteSessions.answer(String(b?.session ?? ""), { answers: b?.answers, choice: b?.choice });
      else { remoteSessions.cancel(String(b?.session ?? "")); step = { state: "error" as const, error: "cancelled" }; }
      b = {};
      if (step.state === "done") broadcast({ type: "devices" });
      return json(step, step.state === "error" ? 400 : 200);
    }

    if (pathname.startsWith("/disk/")) {
      if (!FS_BROWSE_ENABLED) return json({ error: "directory browsing is disabled (AGENTGLASS_FS_BROWSE_DISABLED=1)" }, 403);
      if (pathname === "/disk/places") return json(diskPlaces());
      /* The home index: fuzzy names across the roots, kept by filesystem events. Built on the first question. */
      if (pathname === "/disk/index/search") {
        if (!diskEnabled()) return json({ ok: false, hits: [], error: "searching the machine is disabled (AGENTGLASS_DISK_DISABLED=1)" }, 403);
        const lim = Math.min(200, Math.max(1, Number(url.searchParams.get("limit")) || 60));
        return json(await homeIndex().search(url.searchParams.get("q") || "", lim, req.signal));
      }
      if (pathname === "/disk/index/status") { void homeIndex().ensure(); return json(homeIndex().status()); }
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
    if (pathname === "/browse" || pathname === "/browse/list" || pathname.startsWith("/preview/") || pathname.startsWith("/fs/") || pathname.startsWith("/finder/openwith") || pathname.startsWith("/finder/actions") || pathname === "/finder/bookmarks") {
      /* "local" opens dotted folders and the agentglass config folder, so it is judged
         like the tokenless sinks: a direct loopback socket AND not another OS
         user on this box (sinkFrom). With a token every route here needs it, but
         the zero-config server has none, and the token file's 0600 is then the
         only thing that kept another account out. */
      const localBrowse = peer.source === "socket" && !!clientIp && isLoopback(clientIp) && sinkFrom === "loopback";
      if (!FS_BROWSE_ENABLED) return json({ error: "directory browsing is disabled (AGENTGLASS_FS_BROWSE_DISABLED=1)" }, 403);
      if (req.method === "GET" && heldBackFrom(caller, [url.searchParams.get("path") || ""].filter(Boolean))) return json(HELD_BACK, 403);
      /* Handing a file to the desktop starts a process, so it takes the same
         gate every other write on this surface takes. */
      if (pathname === "/preview/open" && req.method === "POST") {
        if (!trustedCaller(req, from)) return csrfBlocked();
        let b: { path?: unknown } = {};
        try { b = (await req.json()) as { path?: unknown }; } catch { return json({ ok: false, error: "invalid json" }, 400); }
        const r = openInDesktop(b?.path, localBrowse);
        return json(r, r.ok ? 200 : 400);
      }
      /* Open With: the applications a file type has (a read), and starting one. Starting
         an application on a person's files, and changing which one is their default,
         are for the person: the desk key, not the machine token every agent shell holds. */
      if (pathname === "/finder/openwith" && req.method === "GET") {
        const ps = url.searchParams.getAll("path").slice(0, 500);
        if (!ps.length) return json({ ok: false, error: "nothing selected" }, 400);
        if (heldBackFrom(caller, ps)) return json(HELD_BACK, 403);
        const mimes: string[] = [];
        for (const p of ps) {
          const real = browseReal(p, localBrowse);
          if (!real) return json({ ok: false, error: "outside what this may open" }, 403);
          const m = await mimeOf(real);
          if (!m) return json({ ok: false, error: "the type of that file could not be found" }, 400);
          mimes.push(m);
        }
        return json({ ok: true, ...appsForAll(mimes) });
      }
      if (pathname === "/finder/openwith/launch" && req.method === "POST") {
        if (!trustedCaller(req, from)) return csrfBlocked();
        if (!(deskHeld() && deskKeyOk(req))) return json({ ok: false, error: "only the desktop app starts an application for a person" }, 403);
        let b: { id?: unknown; paths?: unknown; always?: unknown; mime?: unknown } = {};
        try { b = (await req.json()) as typeof b; } catch { return json({ ok: false, error: "invalid json" }, 400); }
        if (Array.isArray(b?.paths) && heldBackFrom(caller, b.paths.filter((x): x is string => typeof x === "string"))) return json(HELD_BACK, 403);
        const r = await launchApp(b?.id, b?.paths, { local: localBrowse });
        if (r.ok && b.always === true) {
          const d = await setDefaultApp(b.id, b.mime);
          if (!d.ok) return json({ ok: true, note: d.error });
        }
        return json(r, r.ok ? 200 : 400);
      }
      /* The person's own actions: programs they wrote, run on a selection. Listing and
         matching are reads. Defining, changing, deleting and running one are the
         person's alone: the desk key, never the machine token an agent shell holds. */
      if (pathname.startsWith("/finder/actions")) {
        if (req.method === "GET") {
          if (pathname === "/finder/actions") return json({ ok: true, ...listActions() });
          if (pathname === "/finder/actions/read") { const r = readAction(url.searchParams.get("id") || ""); return json(r, r.ok ? 200 : 404); }
          if (pathname === "/finder/actions/match") {
            const ps = url.searchParams.getAll("path").slice(0, 1000);
            if (heldBackFrom(caller, ps)) return json(HELD_BACK, 403);
            return json({ ok: true, actions: (await actionsFor(ps, url.searchParams.get("source"), localBrowse)).map(({ script: _s, ...a }) => a) });
          }
          return json({ ok: false, error: "no such route" }, 404);
        }
        if (req.method !== "POST") return json({ ok: false, error: "method not allowed" }, 405);
        if (!trustedCaller(req, from)) return csrfBlocked();
        if (!fsWantsJson(req.headers.get("content-type"))) return json({ ok: false, error: "send application/json" }, 415);
        if (!(deskHeld() && deskKeyOk(req))) return json({ ok: false, error: "only the desktop app changes or runs an action for a person" }, 403);
        let b: Record<string, unknown> = {};
        try { b = (await req.json()) as Record<string, unknown>; } catch { return json({ ok: false, error: "invalid json" }, 400); }
        if (!b || typeof b !== "object") return json({ ok: false, error: "invalid json" }, 400);
        let r: { ok: boolean; error?: string };
        if (pathname === "/finder/actions/run") {
          if (Array.isArray(b.paths) && heldBackFrom(caller, b.paths.filter((x): x is string => typeof x === "string"))) return json(HELD_BACK, 403);
          r = await runAction(b.id, b.paths, b.source, { local: localBrowse, deskProven: true, confirmed: b.confirmed === true });
        } else if (pathname === "/finder/actions/save") r = saveAction({ manifest: b.manifest as string | Record<string, unknown>, script: typeof b.script === "string" ? b.script : undefined }, { create: b.create === true });
        else if (pathname === "/finder/actions/delete") r = deleteAction(b.id);
        else return json({ ok: false, error: "no such route" }, 404);
        return json(r, r.ok ? 200 : 400);
      }
      /* The pinned places are GTK's bookmarks file. Reading is a read; pinning writes a file
         in the person's config, so it takes the desk key like the actions above. */
      if (pathname === "/finder/bookmarks") {
        if (req.method === "GET") return json({ ok: true, bookmarks: readBookmarks() });
        if (req.method !== "POST") return json({ ok: false, error: "method not allowed" }, 405);
        if (!trustedCaller(req, from)) return csrfBlocked();
        if (!fsWantsJson(req.headers.get("content-type"))) return json({ ok: false, error: "send application/json" }, 415);
        if (!(deskHeld() && deskKeyOk(req))) return json({ ok: false, error: "only the desktop app pins a place for a person" }, 403);
        let b: { path?: unknown; uri?: unknown } = {};
        try { b = (await req.json()) as { path?: unknown; uri?: unknown }; } catch { return json({ ok: false, error: "invalid json" }, 400); }
        const r = b?.uri !== undefined ? removeBookmarkUri(b.uri) : toggleBookmark(b?.path);
        return json(r, r.ok ? 200 : 400);
      }
      if (pathname === "/preview/reveal" && req.method === "POST") {
        if (!trustedCaller(req, from)) return csrfBlocked();
        let b: { path?: unknown } = {};
        try { b = (await req.json()) as { path?: unknown }; } catch { return json({ ok: false, error: "invalid json" }, 400); }
        const r = revealInFileManager(b?.path, localBrowse);
        return json(r, r.ok ? 200 : 400);
      }
      /* Changing a place. Every write is a POST with the same gate as handing a file
         to the desktop (trusted caller) and only for a caller on this machine; the
         operation itself judges where (fsops.ts). */
      if (pathname.startsWith("/fs/")) {
        const send = (r: { status: number; body: unknown }) => json(r.body, r.status);
        if (req.method === "GET") return send(fsReadOp(pathname.slice(4), url.searchParams, localBrowse));
        if (req.method !== "POST") return json({ ok: false, error: "method not allowed" }, 405);
        if (!trustedCaller(req, from)) return csrfBlocked();
        if (!fsWantsJson(req.headers.get("content-type"))) return json({ ok: false, error: "send application/json" }, 415);
        let b: Record<string, unknown> = {};
        try { b = (await req.json()) as Record<string, unknown>; } catch { return json({ ok: false, error: "invalid json" }, 400); }
        if (!b || typeof b !== "object") return json({ ok: false, error: "invalid json" }, 400);
        if (pathname === "/fs/jobs/cancel") return send(fsJobs("cancel", b.id));
        if (pathname === "/fs/jobs/clear") return send(fsJobs("clear", null));
        if (pathname !== "/fs/op") return json({ ok: false, error: "no such route" }, 404);
        if (heldBackFrom(caller, fsPathsOf(b))) return json(HELD_BACK, 403);
        const gated = fsGate(String(b.op), deskHeld() && deskKeyOk(req));
        if (gated) return send(gated);
        return send(await fsRun(b, localBrowse));
      }
      // A folder a page at a time, for the Machine tab's columns: see browselist.ts.
      if (pathname === "/browse/list") {
        const c = Number(url.searchParams.get("cursor"));
        const n = Number(url.searchParams.get("limit"));
        return json(browseBatch(url.searchParams.get("path") || "", Number.isFinite(c) ? c : 0,
          { limit: Number.isFinite(n) && n > 0 ? n : undefined, showHidden: url.searchParams.get("hidden") === "1", local: localBrowse }));
      }
      if (pathname === "/browse") return json(browseDir(url.searchParams.get("path") || "", url.searchParams.get("hidden") === "1", localBrowse));
      if (pathname === "/preview/facts") return json(fileFacts(url.searchParams.get("path") || "", localBrowse));
      if (pathname === "/preview/media") return json(await mediaFacts(url.searchParams.get("path") || "", localBrowse));
      if (pathname === "/preview/poster") {
        const r = await posterFrame(url.searchParams.get("path") || "", localBrowse);
        if (!r.ok) return json({ error: r.error }, 404);
        return new Response(r.body, { headers: { ...cors, "content-type": "image/jpeg", "cache-control": "no-store", "x-content-type-options": "nosniff" } });
      }
      if (pathname === "/preview/git") return json(await fileGitFacts(url.searchParams.get("path") || "", localBrowse));
      /* The Machine tab's viewers: a slice of the file, never the whole of it in
         memory. `cap` serves the head of a big text file; `Range` is what lets an
         <audio> or <video> seek. Same boundary as the folder list (previewSlice). */
      if (pathname === "/preview/file") {
        const capQ = url.searchParams.get("cap");
        const cap = capQ !== null && Number.isFinite(Number(capQ)) ? Number(capQ) : undefined;
        const r = await previewSlice(url.searchParams.get("path") || "", localBrowse, { range: req.headers.get("range"), cap });
        if (!r.ok) return json({ error: r.error }, r.status);
        return new Response(r.body, {
          status: r.status,
          headers: {
            ...cors,
            ...r.headers,
            "access-control-expose-headers": "x-agx-size, x-agx-truncated, content-range",
            "content-type": r.mime,
            "cache-control": "no-store",
            // Bytes to be drawn, never a document with a script in it: an svg or
            // an html file opened directly here gets no scripts, no network, and
            // an opaque origin.
            "content-security-policy": "sandbox; default-src 'none'; img-src 'self' data: blob:; media-src 'self'; style-src 'unsafe-inline'",
            "x-content-type-options": "nosniff",
          },
        });
      }
      if (pathname === "/preview/raw" || pathname === "/preview/page") {
        const r = await fileBytes(url.searchParams.get("path") || "", localBrowse);
        if (!r.ok) return json({ error: r.error }, 404);
        /* `page` is for a browser tab rather than an <img>: an .html file is
           served as a page, inert (see pagePolicy), where `raw` calls it text. */
        const page = pathname === "/preview/page" ? pagePolicy(url.searchParams.get("path") || "") : null;
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
            "content-type": page?.mime ?? r.mime,
            // A preview is a picture of a file on this machine at this moment;
            // caching it is how a screenshot you just retook shows the old one.
            "cache-control": "no-store",
            // It is a file the user pointed at, and it is served as bytes to be
            // drawn — never as a document with a script in it.
            "content-security-policy": page?.csp ?? "default-src 'none'; img-src 'self' data: blob:; style-src 'unsafe-inline'",
            "x-content-type-options": "nosniff",
          },
        });
      }
    }

    if (pathname === "/docker/capability") return json(await dockerCapability());
    // Single-flighted alongside the git reads: `docker ps`/`docker stats` are
    // slow spawns (seconds each) behind a short cache, and several tabs missing
    // that cache together would each launch one. One sample now serves them all.
    if (pathname === "/docker/overview") {
      const fresh = url.searchParams.get("fresh") === "1";
      return body(await singleFlight(`docker:overview:${fresh}`, async () => JSON.stringify(await dockerOverview(fresh))));
    }
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
    // A credential short of `full` gets SPAWN_CAP of these at a time (see
    // spawncap.ts); the log follow below has its own global cap in dockerlogs.
    if (DOCKER_SPAWNS.has(pathname)) {
      const release = caller && caller.scope !== "full"
        ? takeSpawnSlot(caller.device?.id ?? (caller.plugin ? `plugin:${caller.plugin}` : caller.kind))
        : () => {};
      if (!release) return json({ ok: false, error: "too many docker requests in flight from this device — wait for one to finish" }, 429);
      try {
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
      } finally {
        release();
      }
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

    // One pid, and only while it is flagged as left behind and owned by this
    // user — /machine/kill's reach is every process of ours, this one is not.
    if (pathname === "/machine/orphans/stop" && req.method === "POST") {
      if (!trustedCaller(req, from)) return csrfBlocked();
      let b: any = {};
      try { b = await req.json(); } catch { return json({ ok: false, error: "invalid json" }, 400); }
      const res = stopOrphan(b.pid, orphanCtx());
      noteAction(clientIp, pathname, b, res, asActor(caller));
      return json(res, res.ok ? 200 : 400);
    }

    // The only deletion in /machine: the person's own click. Every credential an
    // agent holds is refused (an agent stages it through the diskclean.stage
    // door and the person clicks); the ids pick lines of a fresh scan and no
    // path ever comes from the body. A real clean also needs the desk key, as
    // the other routes that act on a person's files do: an Origin is a header
    // anybody can set, and here the effect is deletion. A dry run only reads.
    if (pathname === "/machine/disk-clean/run" && req.method === "POST") {
      if (!trustedCaller(req, from)) return csrfBlocked();
      if (!mayPublishReview(req, caller)) return json({ ok: false, error: "only a person's click can clean the disk; an agent stages the plan and the person confirms it" }, 403);
      let b: any = {};
      try { b = await req.json(); } catch { return json({ ok: false, error: "invalid json" }, 400); }
      if (b.dryRun !== true && !(deskHeld() && deskKeyOk(req))) return json({ ok: false, error: "only the desktop app's own window can clean the disk; a hand-started server without it only shows the plan" }, 403);
      const res = await runDiskClean(b.ids, { dryRun: b.dryRun === true, at: b.at }, diskCtx());
      noteAction(clientIp, pathname, { ids: Array.isArray(b.ids) ? b.ids.length : "all", dryRun: b.dryRun === true }, res, asActor(caller));
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
      const page = await inbox(url.searchParams.get("unread") !== "1", url.searchParams.get("force") === "1");
      // What plugins say about the rows is added here, after the cache, so a
      // plugin's word is never frozen into the page GitHub sent.
      return json({ ...page, items: annotate(page.items) });
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
      if (isForeignRoot(b.root) && !mayReadForeignRoot(caller)) return foreignRefused();
      const asked = String(b.root ?? "");
      const root = prRouteRoot(asked);
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
      const root = prRouteRoot(asked);
      const number = Number(url.searchParams.get("number") ?? 0);
      const pr = await prBranches(root, number);
      if (!pr) return json({ ok: false, conflicts: [], clean: false, error: "could not read that pull request's branches" });
      // The number goes through: a pull request from a fork has no branch on
      // origin, and refs/pull/<n>/head is the only ref that always exists.
      return json(await conflictPreview(root, pr.base, pr.head, number));
    }
    /* One file of that preview, markers and all, read out of the tree the
       preview merge wrote. Read-only; the path must be one the preview named. */
    if (pathname === "/prs/conflict-file") {
      const root = prRouteRoot(url.searchParams.get("root") ?? "");
      const number = Number(url.searchParams.get("number") ?? 0);
      const pr = await prBranches(root, number);
      if (!pr) return json({ ok: false, segments: [], blocks: [], lines: 0, stamp: "", error: "could not read that pull request's branches" });
      return json(await conflictPreviewFile(root, pr.base, pr.head, number, url.searchParams.get("path")));
    }
    /* The pull requests on a branch — one out of it, any number into it. Asked
       of GitHub by name rather than filtered out of a scope, because a scope is
       about an AUTHOR and this question is about a branch. */
    if (pathname === "/prs/for-head") {
      const root = prRouteRoot(url.searchParams.get("root") ?? "");
      return json(await prForHead(root, url.searchParams.get("branch") ?? ""));
    }
    if (pathname === "/prs/for-branch") {
      const asked = url.searchParams.get("root") ?? "";
      const root = prRouteRoot(asked);
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
    /* "Tell me when this pull request's CI does X" — the rules and the repo
       defaults, kept server side so they outlive the window. See prNotifyWatch.ts. */
    // The notifications they asked for: the ones still waiting, answering one, the audit. See askedAlerts.ts.
    if (pathname.startsWith("/alerts/asked")) {
      if (req.method === "POST" && !trustedCaller(req, from)) return csrfBlocked();
      const b = req.method === "POST" ? await req.json().catch(() => ({})) as Record<string, unknown> : {};
      const hit = handleAskedAlertRoute(req.method, pathname, b);
      if (hit) return json(hit.data, hit.status);
    }
    if (pathname === "/prs/notify-watch" && req.method === "GET") return json({ ok: true, ...listWatches() });
    // Fires decided while no client was there to hear them, oldest first — for the window on connect and for a phone.
    if (pathname === "/prs/notify-watch/pending" && req.method === "GET") return json({ ok: true, fires: pendingFires() });
    if (pathname.startsWith("/prs/notify-watch/") && req.method === "POST") {
      if (!trustedCaller(req, from)) return csrfBlocked();
      const b = await req.json().catch(() => ({})) as Record<string, unknown>;
      if (isForeignRoot(b.root) && !mayReadForeignRoot(caller)) return foreignRefused();
      if (pathname === "/prs/notify-watch/remove") return json(removeWatch(String(b.id ?? "")));
      if (pathname === "/prs/notify-watch/ack") return json(ackFire(Number(b.seq)));
      const id = await prRepoIdFor(b.root);
      if (!id) return json({ ok: false, error: "no GitHub remote here" }, 400);
      const ctx = { repo: id.nameWithOwner, number: Number(b.number), root: String(b.root), title: String(b.title ?? "") };
      if (pathname === "/prs/notify-watch/add") {
        const r = addWatch({ ...ctx, rule: b.rule });
        if (r.ok) prNotifyKick();
        return json(r, r.ok ? 200 : 400);
      }
      if (pathname === "/prs/notify-watch/apply") {
        const r = applyPreset(ctx);
        if (r.ok) prNotifyKick();
        return json(r, r.ok ? 200 : 400);
      }
      if (pathname === "/prs/notify-watch/default") return json(setPreset(id.nameWithOwner, b.rules, b.auto === true));
      return json({ ok: false, error: "not found" }, 404);
    }
    /* Per check key on this repository: run count, median, p90, failure rate and
       a 14-day trend, from the history the checks reads already fill. Local: no GitHub call. */
    if (pathname === "/prs/check-metrics") {
      const id = await prRepoIdFor(url.searchParams.get("root") || "");
      return json(id ? { ok: true, repo: id.key, checks: repoMetrics(id.key) } : { ok: false, error: "no GitHub remote here" });
    }
    if (pathname === "/prs/rollup") {
      return json(await prRollup(url.searchParams.get("root") || "", url.searchParams.get("number") || 0, url.searchParams.get("force") === "1"));
    }
    if (pathname === "/prs/ref-branches") {
      return json(await refBranchRows(url.searchParams.get("root") || "", url.searchParams.get("key") || ""));
    }
    if (pathname === "/prs/person") {
      return json(await personBoard(url.searchParams.get("root") || "", url.searchParams.get("login") || "", url.searchParams.get("force") === "1"));
    }
    if (pathname === "/prs/row-details") {
      return json(await prRowDetails(url.searchParams.get("root") || "", url.searchParams.get("numbers") || "", url.searchParams.get("finished") || ""));
    }
    if (pathname === "/prs/local-head") {
      return json({ ok: true, local: await localHead(
        url.searchParams.get("root") || "",
        url.searchParams.get("branch") || "",
      ) });
    }
    /* GitHub's public status, cached ten minutes server-side (see prs.ts). */
    if (pathname === "/prs/github-status") {
      return json(await githubStatusCached());
    }
    /* One fresh read for Unstick: the branch as it is on GitHub now, the head the
       pull request points at, its state. `full=1` adds the facts the gate needs. */
    if (pathname === "/prs/unstick-look") {
      const root = prRouteRoot(url.searchParams.get("root") ?? "");
      const n = Number(url.searchParams.get("number") ?? 0);
      if (!Number.isInteger(n) || n <= 0) return json({ ok: false, error: "invalid pull request number" }, 400);
      return json(await unstickLook(root, n, url.searchParams.get("full") === "1"));
    }
    if (pathname === "/prs/behind") {
      const asked = url.searchParams.get("root") ?? "";
      const root = prRouteRoot(asked);
      return json(await branchBehind(root, Number(url.searchParams.get("number") ?? 0), url.searchParams.get("force") === "1"));
    }
    /* The agent session(s) that wrote a pull request, as a redacted brief — only to a
       running plugin whose manifest declares `reads: ["sessions"]`, only in a repository
       the person allowed, and refused whole when anything in it looks like a secret.
       See prsessions.ts for the three locks and what the brief holds. */
    if (pathname === "/prs/sessions") {
      const self = pluginOfRequest(req, url);
      if (!self) return json({ ok: false, error: "only a running plugin reads this, with its own token" }, 403);
      const asked = (url.searchParams.get("root") ?? "").trim();
      const number = Number(url.searchParams.get("number") ?? 0);
      if (!asked) return json({ ok: false, error: "root is required: owner/name or a checkout" }, 400);
      if (!Number.isInteger(number) || number <= 0) return json({ ok: false, error: "invalid pull request number" }, 400);
      const bare = normalizeRepo(asked);
      const wanted = bare && !asked.startsWith("/") ? bare : null;
      const repoOf = wanted ?? (inScopeReal(asked) ? (await prRepoIdFor(asked))?.nameWithOwner ?? null : null);
      const gate = sessionsGate(contributesOf(self), repoOf);
      if (!gate.ok) return json({ ok: false, error: gate.error, missing: gate.missing }, 403);
      const slot = takeSessionsSlot(self);
      if (!slot.ok) return new Response(JSON.stringify({ ok: false, error: `at most ${RATE_PER_HOUR} session reads an hour per plugin; try again in ${slot.retryAfterSec}s` }), {
        status: 429, headers: { "content-type": "application/json", "retry-after": String(slot.retryAfterSec), ...cors } });
      // No checkout of it here is not an error: there is nothing to read.
      const local = wanted ? await locateCheckout(wanted) : { ok: true as const, root: asked };
      if (!local.ok) return json({ ok: true, sessions: [] });
      const pr = await prBranches(local.root, number);
      if (!pr) return json({ ok: true, sessions: [] });
      const out = await answerSessions(local.root, pr.head, {
        rows: (r) => spendRows(r, RETENTION_DAYS ? Date.now() - RETENTION_DAYS * 86_400_000 : 0),
        checkouts: checkoutBranches,
        facts: sessionFacts,
      });
      // The kinds of text found, never the text; and nothing is logged here.
      return out.ok ? json({ ok: true, sessions: out.sessions, ...(out.truncated ? { truncated: true } : {}) }) : json({ ok: false, error: out.error, kinds: out.kinds }, out.status);
    }
    /* What this project's agents have spent, by branch and by checkout — the
       whole repository in one answer, because the board looks its rows up in it
       rather than asking per pull request. Scoped like every other read here:
       an out-of-scope root falls back to the open project instead of reporting
       on a repository the cockpit is not showing. See spend.ts. */
    if (pathname === "/prs/spend") {
      const asked = url.searchParams.get("root") ?? "";
      const root = prRouteRoot(asked);
      return json(await repoSpend(root));
    }
    /* The keyring option: whether it is on, whether the keyring can be used now,
       and how many secrets this process holds from it. Never which, never what. */
    if (pathname === "/keyring" && req.method === "GET") return json(await keyringStatus());
    /* Moves every stored token between the files and the keyring. An agent goes
       through the settings door and waits for the person (secrets.keyring). */
    if (pathname === "/keyring/toggle" && req.method === "POST") {
      if (!trustedCaller(req, from)) return csrfBlocked();
      const b = await req.json().catch(() => ({})) as Record<string, unknown>;
      if (typeof b.enabled !== "boolean") return json({ ok: false, error: "enabled must be true or false" }, 400);
      if (!mayPublishReview(req, caller)) return viaDoor("/keyring/toggle", "secrets.keyring", b.enabled, b.as);
      const r = await setKeyringEnabled(b.enabled);
      return json(r, r.ok ? 200 : 409);
    }
    /* Read the keyring again once it has been unlocked, without a restart. */
    if (pathname === "/keyring/rehydrate" && req.method === "POST") {
      if (!trustedCaller(req, from)) return csrfBlocked();
      if (!mayPublishReview(req, caller)) return json({ ok: false, error: "only the person asks the keyring again" }, 403);
      await rehydrate();
      return json({ ok: true, ...(await keyringStatus()) });
    }
    /* Where this app keeps things, and for how long — read by Settings →
       Privacy. Paths, not contents: the page says what is on disk so somebody
       can go and look, and nothing here reads a credential to display it. */
    if (pathname === "/privacy/retention" && req.method === "POST") {
      if (!trustedCaller(req, from)) return csrfBlocked();
      const b = await req.json().catch(() => ({})) as Record<string, unknown>;
      if (typeof b.days !== "number") return json({ ok: false, error: "days must be a number" }, 400);
      if (!mayPublishReview(req, caller)) return viaDoor("/privacy/retention", "privacy.retentionDays", b.days, b.as);
      const r = setRetentionDays(b.days);
      return json(r.ok ? { ok: true, retentionDays: RETENTION_DAYS } : r, r.ok ? 200 : 400);
    }
    /* The red button on Data & privacy. Never through the settings door: an agent does not decide what the
       person's history is worth, and there is no undo. The body must say so in so many words. */
    if (pathname === "/privacy/erase-history" && req.method === "POST") {
      if (!trustedCaller(req, from)) return csrfBlocked();
      if (!mayPublishReview(req, caller)) return json({ ok: false, error: "only the person at the window erases history" }, 403);
      const b = await req.json().catch(() => ({})) as Record<string, unknown>;
      if (b.confirm !== "erase") return json({ ok: false, error: "send confirm: \"erase\" to erase the history" }, 400);
      const r = eraseHistory();
      reclaimFreePages();
      noteAction(clientIp, "/privacy/erase-history", { events: r.events, sessions: r.sessions, days: r.days }, { ok: true }, asActor(caller));
      return json({ ok: true, ...r });
    }
    if (pathname === "/privacy") {
      const size = (p: string): number | null => { try { return fsStat(p).size; } catch { return null; } };
      return json({
        db: dbPath(),
        dbBytes: size(dbPath()),
        config: configPath(),
        configBytes: size(configPath()),
        credentials: credentialsPath(),
        retentionFromEnv: RETENTION_FROM_ENV,
        retentionDays: RETENTION_DAYS,
        pairedDevices: devices().length,
        // So the page names only the services this machine actually talks to.
        clickup: hasCredential("clickup"),
        jira: hasCredential("jira"),
      });
    }
    if (pathname === "/prs/list") {
      const root = url.searchParams.get("root") || "";
      const filter = url.searchParams.get("filter") || "mine";
      const state = url.searchParams.get("state") || "open";
      // A real client just asked for this — worth re-asking on a timer even
      // while nobody is on this tab. See prWatch.ts.
      noteWatchAsk(root, filter, state);
      const listed = await listPrs(
        root,
        filter,
        state,
        url.searchParams.get("force") === "1",
        url.searchParams.get("after") || undefined,
        url.searchParams.get("q") || undefined,
        url.searchParams.getAll("label"),
      );
      // Only an unpaged, unfiltered read is the whole list: a later page's PRs are old, not new.
      if (!url.searchParams.get("after") && !url.searchParams.get("q") && !url.searchParams.getAll("label").length) noteMine(root, filter, state, listed);
      return json(listed);
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
      if (heldBackFrom(caller, [url.searchParams.get("root") || ""].filter(Boolean))) return json(HELD_BACK, 403);
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
    if (pathname === "/prs/failing-tests") {
      return json(await failingTestsFor(url.searchParams.get("root") || "", url.searchParams.get("refresh") === "1"));
    }
    if (pathname === "/prs/check-failures-cached") {
      return json(await cachedCheckFailures(url.searchParams.get("root") || "", url.searchParams.get("jobs") || ""));
    }
    if (pathname === "/prs/check-failures") {
      return json(await checkFailures(
        url.searchParams.get("root") || "", url.searchParams.get("job") || "",
        { attempt: url.searchParams.get("attempt"), step: url.searchParams.get("step") },
        url.searchParams.get("force") === "1",
      ));
    }
    /* "Check on base": the plan is a read; starting runs repository code on this machine, so it is a POST from a trusted caller. */
    if (pathname === "/prs/check-on-base/plan") {
      const p = await planCheckOnBase(url.searchParams.get("root") || "", url.searchParams.get("number") || "");
      return json(p.ok ? p.plan : p);
    }
    if (pathname === "/prs/check-on-base/status") return json(checkOnBaseStatus(url.searchParams.get("id") || ""));
    if (pathname === "/prs/check-on-base" && req.method === "POST") {
      /* Runs a typed command on a pull request's head, which may be a fork's
         code: the same class as the routes that build and run code, so the
         desktop shell only. The one caller is the PR panel's button; a paired
         phone or a LAN browser can read the plan and the status and cancel a
         run, and is told why it cannot start one. Cancel stays on
         trustedCaller: it stops a process this app started and runs nothing. */
      if (!desktopOnly(req)) return json({ ok: false, error: "Check on base runs code from the pull request, so only the desktop app can start it" }, 403);
      let b: { root?: unknown; number?: unknown; command?: unknown; baseSha?: unknown; headSha?: unknown; sandbox?: unknown; allowNoSandbox?: unknown };
      try { b = (await req.json()) as typeof b; } catch { return json({ ok: false, error: "invalid json" }, 400); }
      if (isForeignRoot(b.root) && !mayReadForeignRoot(caller)) return foreignRefused();
      const started = await startCheckOnBase(b.root, b.number, b.command, b);
      // Running a command from a CI log on this machine is the auditable fact; the command itself is kept, cut short.
      noteAction(clientIp, "/prs/check-on-base",
        { root: b.root, number: b.number, command: typeof b.command === "string" ? b.command.slice(0, 200) : undefined, sandbox: b.sandbox },
        started.ok ? { ok: true } : { ok: false, error: started.error }, asActor(caller));
      return json(started);
    }
    if (pathname === "/prs/check-on-base/cancel" && req.method === "POST") {
      if (!trustedCaller(req, from)) return csrfBlocked();
      let b: { id?: unknown };
      try { b = (await req.json()) as typeof b; } catch { return json({ ok: false, error: "invalid json" }, 400); }
      return json(cancelCheckOnBase(b.id));
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
      if (isForeignRoot(b.root) && !mayReadForeignRoot(caller)) return foreignRefused();
      const got = await prDetail(b.root, b.number);
      if (!got.ok || !got.detail) return json({ ok: false, error: got.error ?? "no such pull request" }, 400);
      const text = nudgeText(got.detail);
      const channel = nudgeChannel();
      const sent = b.send === true && channel.configured ? await sendNudge(text) : null;
      return json({ ok: true, text, channel: channel.configured, sent: sent?.sent ?? false, ...(sent?.error ? { error: sent.error } : {}) });
    }
    if (pathname === "/prs/locate") {
      /*
       * "Which checkout on this machine is owner/name?"
       *
       * Every pull request read goes through a local root, because that is
       * where the remote — and therefore the repository's identity — is read
       * from. That was fine while a pull request was only ever reached from
       * the project it belongs to, and it made a link from anywhere else a
       * dead end: a row in a plugin's list, or a notification about a review,
       * could name a pull request the open project has no checkout of, and
       * the panel answered by searching for the number in the wrong
       * repository.
       *
       * The sweep is the picker's, `all=1`, so a project that is not the open
       * one still counts; `repoIdFor` caches per root for five minutes and is
       * two `git remote get-url` on a miss. Nothing here opens anything: it
       * answers with a path, and the panel decides.
       */
      const want = url.searchParams.get("repo") || "";
      if (!/^[\w.-]+\/[\w.-]+$/.test(want)) return json({ ok: false, error: "repo must be owner/name" }, 400);
      return json(await locateCheckout(want));
    }
    if (pathname === "/prs/detail") {
      return json(await prDetail(
        url.searchParams.get("root") || "",
        url.searchParams.get("number") || "",
        url.searchParams.get("force") === "1",
      ));
    }
    if (pathname === "/prs/diff") {
      const d = await prDiff(url.searchParams.get("root") || "", url.searchParams.get("number") || "", url.searchParams.get("force") === "1");
      /* A diff past its 5 minute copy is re-read and, unchanged, was sent whole
         again (27.8 KB measured on a 12-file pull request). Its content is its
         tag, so the browser's own revalidation answers a 304. */
      const tag = d.ok && d.text ? `"${Bun.hash(d.text).toString(36)}"` : "";
      if (tag && req.headers.get("if-none-match") === tag) return new Response(null, { status: 304, headers: { ETag: tag, ...cors } });
      return new Response(JSON.stringify(d), {
        headers: { "content-type": "application/json", ...cors, ...(tag ? { ETag: tag, "Cache-Control": "no-cache" } : {}) },
      });
    }
    // Images in a PR body. Not JSON — it streams the bytes back, because
    // GitHub's own attachment URLs 404 without the token this attaches.
    if (pathname === "/prs/asset") return prAsset(url.searchParams.get("url") || "", !!caller && caller.scope !== "full");
    /* The diff between two commits of this pull request, from the local clone — see compareDiff. */
    if (pathname === "/prs/compare-diff") {
      return json(await compareDiff(
        url.searchParams.get("root") || "",
        url.searchParams.get("number") || "",
        url.searchParams.get("from") || "",
        url.searchParams.get("to") || "",
      ));
    }
    /* A commit's files as a tar, from the local checkout — see treeAt.ts. Read-only, no GitHub request. */
    if (pathname === "/prs/tree-at") {
      const t = await treeAtTarget(url.searchParams.get("root") || "", url.searchParams.get("sha") || "", url.searchParams.get("number"));
      if (!t.ok) return json(t.missing ? { ok: true, missing: t.missing, error: t.error } : t, t.missing ? 200 : 400);
      const tar = await treeAtTar(t.root, t.sha);
      if (!tar.ok) return json(tar, 400);
      return new Response(tar.body, { headers: { "content-type": "application/x-tar", "x-tree-sha": t.sha, "x-tree-files": String(tar.files), "cache-control": "no-store", ...cors } });
    }
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
      if (isForeignRoot(b.root) && !mayReadForeignRoot(caller)) return foreignRefused();
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
        case "/prs/update-branch": {
          res = await updateBranch(root, n, b.syncLocal, (before) => noteSyncFor(root, n, before));
          if (!res.ok && !res.prLagging) await dropSyncFor(root, n);
          break;
        }
        case "/prs/rerun": res = await rerunFailedChecks(root, n); break;
        case "/prs/rerun-jobs": res = await rerunJobs(root, b.what, b.id); break;
        case "/prs/line-comment": res = await addLineComment(root, n, b); break;
        case "/prs/apply-suggestion": res = await applySuggestion(root, n, b); break;
        case "/prs/merge": res = await mergePr(root, n, b.method, { deleteBranch: b.deleteBranch, auto: b.auto, headSha: b.headSha, subject: b.subject, body: b.body, disableAuto: b.disableAuto }); break;
        case "/prs/close": res = await closePr(root, n, b.reopen === true); break;
        /* Unstick's two writes, each re-checked on the server against a fresh read
           (see shared/unstick.ts) and each its own audit line. */
        case "/prs/unstick-close": res = await unstickClose(root, n); break;
        case "/prs/unstick-reopen": res = await unstickReopen(root, n); break;
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
      const live = (await singleFlight(`listPanes:${socketPath(lastTmuxTarget()?.socket ?? [])}`,
        () => listPanes(lastTmuxTarget()?.socket)))
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
      const now = Date.now();
      const panes = withAgentSessions(live, (id) => {
        const n = paneAgentNote(id);
        return n ? { sessionId: n.session_id, at: n.at } : null;
      }).map((p) => {
        // The window switcher sorts every window on the machine by this, so it
        // is answered here as well as in the strip's frame — one function, one
        // answer. A pane with no agent stays without one.
        const status = paneStatus(p.paneId, now);
        // And its project, from the same cache the strip's groups read, so the
        // switcher names a worktree by the repository it belongs to.
        const repo = windowRepo(p.path);
        return { ...p, ...(status ? { status } : {}), ...(repo !== undefined ? { repo } : {}) };
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
        const panes = await singleFlight(`panesWithPids:${socketPath(lastTmuxTarget()?.socket ?? [])}:${win}`,
          () => panesWithPids(lastTmuxTarget()?.socket, win));
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
      const pane = await singleFlight(`activePane:${socketPath(lastTmuxTarget()?.socket ?? [])}:${win}`,
        () => activePane(lastTmuxTarget()?.socket, win));
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
      const ok = await focusPaneAnywhere(lastTmuxTarget()?.socket, String(b.sessionId ?? ""), String(b.windowId ?? ""), String(b.paneId ?? ""));
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
      const { status, ...body } = said;
      return json(body, said.ok ? 200 : status ?? 400);
    }

    if (pathname === "/terminal/image" && req.method === "POST") {
      if (!trustedCaller(req, from)) return csrfBlocked();
      if (!TERMINAL_ENABLED) return json({ ok: false, error: "the terminal is disabled here" }, 403);
      let b: { data?: unknown; name?: unknown };
      try { b = (await req.json()) as typeof b; } catch { return json({ ok: false, error: "invalid json" }, 400); }
      const data = typeof b.data === "string" ? b.data : "";
      /* `b.name` is the client's and is never consulted here, for path or for
         extension: a filename off the wire used to buy whatever extension it
         claimed, so a payload could be labelled ".png" and be anything at
         all. The extension written to disk now comes only from the bytes
         themselves — see imageUpload.ts. */
      const decoded = decodeImage(data);
      if (!decoded.ok) return json({ ok: false, error: decoded.error }, decoded.status);
      const { bytes, ext } = decoded;
      const file = joinPath(makeViewTempDir("image"), `image${ext}`);
      try { fsWrite(file, bytes); } catch (e) {
        return json({ ok: false, error: failed("view/image", e, "the image could not be saved") }, 500);
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
     * A shell, for a phone with no pane to anchor the socket's own `+` to.
     *
     * That control (`cmd:"agent"` over the terminal WebSocket) reads its
     * project off the pane it is attached to — the point of it — and so it
     * has nothing to read from the empty state, where there is no pane and
     * therefore no socket at all (`TerminalView` is only mounted `if (open)`).
     * A plain HTTP route, taking the project the caller already named rather
     * than one read off a pane, is the narrowest way out of that: the phone
     * already reads `/git/repos` (scoped to the paired project server-side)
     * for the empty state's own list, so `root` is one of its own entries,
     * never free text.
     *
     * No `into`: this is the exact case `engineWindowRunning`'s own fallback
     * exists for — nothing on screen to open "where the client is looking",
     * so a session named after the checkout is the only sensible answer, the
     * same one an unattached run gets.
     */
    if (pathname === "/terminal/open-shell" && req.method === "POST") {
      if (!trustedCaller(req, from)) return csrfBlocked();
      if (!TERMINAL_ENABLED) return json({ ok: false, error: "the terminal is disabled here" }, 403);
      let b: { root?: unknown };
      try { b = (await req.json()) as typeof b; } catch { return json({ ok: false, error: "invalid json" }, 400); }
      const root = gitSafeAbs(b.root);
      if (!root || !inScope(root) || !fsExists(root)) {
        return json({ ok: false, error: "that project is not open" }, 400);
      }
      const name = basename(root) || "shell";
      const opened = await engineWindowRunning(root, name, [], root, undefined, undefined, true);
      if (!opened) return json({ ok: false, error: "the engine would not open a window" }, 500);
      return json({ ok: true, pane: opened.paneId, window: opened.windowId, cwd: root, session: engineSessionName(root) });
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
    /*
     * THE ORCHESTRATOR'S SEAT — open it, empty it, read it, and the one line
     * the agent in it says each round.
     *
     * The project is named by the caller because a seat is not tied to the
     * open project: `Seat.seatable` measures it against the project list this
     * server already serves at `/projects`, and refuses anything else. Nothing
     * about what the seat is told arrives from a client — `Seat.seatPrompt`
     * composes it here from the project's doctrine and the board, the same
     * property `/lantern/ticket` keeps.
     */
    /*
     * Which CLI and model each worker role runs on. The choices offered are
     * the CLIs with a lock (shared/agentKinds.ts), each said with whether it
     * is installed here, so the pane never offers a role something it would
     * refuse at start.
     */
    if (pathname === "/agents/roles" && req.method === "GET") {
      return json({ ok: true, roles: workerRoles(), ...AgentOps.workerRoleChoices() });
    }
    if (pathname === "/agents/roles" && req.method === "POST") {
      if (!trustedCaller(req, from)) return csrfBlocked();
      let b: { role?: unknown; provider?: unknown; model?: unknown; as?: unknown }; try { b = (await req.json()) as typeof b; } catch { b = {}; }
      if (!mayPublishReview(req, caller)) return viaDoor("/agents/roles", `agents.role.${String(b.role)}`, { provider: b.provider, model: b.model }, b.as);
      const r = writeWorkerRole(b.role, { provider: b.provider, model: b.model });
      return json({ ...r, roles: workerRoles() }, r.ok ? 200 : 400);
    }
    /**
     * The orchestration policy (shared/orchestration.ts). GET answers the
     * policy in force for `?root=` (its own, or the global one); POST stores a
     * whole policy and answers with the one now in force. Workers and
     * orchestrators resolve their engine from it when they start.
     */
    /*
     * THE SETTINGS DOOR (settingsDoor.ts; the classes are shared/settingClass.ts).
     *
     * One route an agent changes any server-held setting through. GET lists every
     * one with its class and, unless it is a secret or held per project, its value.
     * POST applies a low-risk change or one that narrows, refuses a secret and the
     * person's own switches, and turns the rest into a request the person answers
     * on POST /settings/requests/decide. The person is told apart from an agent by
     * the test the orchestration policy always used (mayChangePolicy) plus no agent
     * name on the request (mayPublishReview): nothing weaker. A seat speaks only
     * for its own project, as on every /seat route.
     */
    /** A door answer as HTTP: applied 200, waiting for the person 202, refused its own status. */
    /* The action log's verdict: applied is ok; a request waiting for the person is not (yet). */
    /* Function declarations, hoisted: the Settings pages' own routes above this
       line call them too. */
    function auditOf(r: DoorAnswer) { return r.ok && r.applied ? { ok: true } : { ok: false, error: r.ok ? "waiting for the person" : r.error }; }
    function doorJson(r: DoorAnswer): Response {
      if (!r.ok) return json({ ok: false, error: r.error }, r.status);
      return json(r, r.applied ? 200 : 202);
    }
    /** An agent's write on a Settings page's own route: through the door, logged. */
    async function viaDoor(route: string, id: string, value: unknown, as?: unknown): Promise<Response> {
      const r = await settingsDoor.change(id, value, { person: false, who: askerOf(req, caller, as), confined: caller?.principal === "seat" });
      noteAction(clientIp, route, { setting: id, ...(r.ok && !r.applied ? { queued: true } : {}) }, auditOf(r), asActor(caller));
      return doorJson(r);
    }

    /** Several fields of one form, each through the door: the first refusal is the
     *  answer (fields before it may have applied, and `extra` reads them back), else
     *  202 with the requests when any waits for the person. */
    function doorMany(rs: DoorAnswer[], extra: Record<string, unknown>): Response {
      if (!rs.length) return json({ ok: false, error: "nothing to change" }, 400);
      const bad = rs.find((r) => !r.ok);
      if (bad && !bad.ok) return json({ ok: false, error: bad.error, ...extra }, bad.status);
      const pending = rs.flatMap((r) => (r.ok && !r.applied ? [r.pending] : []));
      return json({ ok: true, applied: pending.length === 0, ...(pending.length ? { pending } : {}), ...extra }, pending.length ? 202 : 200);
    }
    function doorRoot(id: string, raw: unknown): { root?: string } | { error: string; status: number } {
      const own = caller?.principal === "seat" ? caller.seat?.root : undefined;
      if (caller?.principal === "seat" && !own) return { error: "this seat's project is not known, so it speaks for none", status: 403 };
      if (classOf(id) && id.startsWith("seat.") && id !== "seat.wakeHours") {
        const g = own ? Seat.seatSpeaksFor(own, raw) : Seat.seatable(typeof raw === "string" && raw ? raw : workspaceRoot());
        return "error" in g ? { error: g.error, status: own ? 403 : 400 } : { root: g.root };
      }
      if (id === "orchestration.policy") {
        if (own) { const g = Seat.seatSpeaksFor(own, raw); return "error" in g ? { error: g.error, status: 403 } : { root: g.root }; }
        const r = policyRoot(raw);
        return r === null ? { error: "root: has to be an absolute path", status: 400 } : r ? { root: r } : {};
      }
      return {};
    }
    if (pathname === "/settings/door" && req.method === "GET") {
      const one = url.searchParams.get("id");
      if (one) {
        const at = doorRoot(one, url.searchParams.get("root"));
        if ("error" in at) return json({ ok: false, error: at.error }, at.status);
        const v = settingsDoor.value(one, at.root);
        return "error" in v ? json({ ok: false, error: v.error }, 404) : json({ ok: true, id: one, ...(at.root ? { root: at.root } : {}), value: v.value });
      }
      return json({ ok: true, trusted: agentsChangeWithoutAsking(), settings: settingsDoor.list() });
    }
    if (pathname === "/settings/door" && req.method === "POST") {
      if (!trustedCaller(req, from)) return csrfBlocked();
      let b: { id?: unknown; value?: unknown; root?: unknown; as?: unknown } = {};
      try { b = (await req.json()) as typeof b; } catch { return json({ ok: false, error: "invalid json" }, 400); }
      if (typeof b.id !== "string" || !b.id || b.id.length > 120) return json({ ok: false, error: "id: a setting id (GET /settings/door lists them)" }, 400);
      const at = doorRoot(b.id, b.root);
      if ("error" in at) return json({ ok: false, error: at.error }, at.status);
      const person = mayPublishReview(req, caller);
      // An agent's asks are limited like its /control writes: a loop is not an errand.
      if (!person && !controlWriteLimit.hit(actorOf(clientIp, asActor(caller)))) return json({ ok: false, error: "too many changes from this caller; slow down" }, 429);
      const r = await settingsDoor.change(b.id, b.value, { root: at.root, person, who: askerOf(req, caller, b.as), confined: caller?.principal === "seat" });
      noteAction(clientIp, "/settings/door", { setting: b.id, ...(at.root ? { root: at.root } : {}), ...(r.ok && !r.applied ? { queued: true } : {}) }, auditOf(r), asActor(caller));
      return doorJson(r);
    }
    if (pathname === "/settings/requests" && req.method === "GET") {
      // A seat reads its own project's requests and nobody else's.
      const own = caller?.principal === "seat" ? caller.seat?.root ?? "\0" : null;
      return json({ ok: true, requests: settingsDoor.pending().filter((r) => own === null || r.root === own) });
    }
    if (pathname === "/settings/requests/decide" && req.method === "POST") {
      if (!trustedCaller(req, from)) return csrfBlocked();
      let b: { id?: unknown; approve?: unknown } = {};
      try { b = (await req.json()) as typeof b; } catch { return json({ ok: false, error: "invalid json" }, 400); }
      if (typeof b.approve !== "boolean") return json({ ok: false, error: "approve: true or false" }, 400);
      const r = await settingsDoor.decide(b.id, b.approve, mayPublishReview(req, caller));
      noteAction(clientIp, "/settings/requests/decide", { approve: b.approve, ...(r.ok ? { setting: r.setting } : {}) }, r.ok ? { ok: true } : { ok: false, error: r.error }, asActor(caller));
      return r.ok ? json(r) : json({ ok: false, error: r.error }, r.status);
    }
    if (pathname === "/orchestration" && req.method === "GET") {
      const root = policyRoot(url.searchParams.get("root"));
      if (root === null) return json({ ok: false, error: "root: has to be an absolute path" }, 400);
      const v = readPolicy(root);
      return json({ ok: true, scope: v.scope, root: v.root, overrides: v.overrides, policy: v.policy });
    }
    if (pathname === "/orchestration" && req.method === "POST") {
      if (!trustedCaller(req, from)) return csrfBlocked();
      let b: { root?: unknown; policy?: unknown } = {};
      try { b = (await req.json()) as typeof b; } catch { return json({ ok: false, error: "invalid json" }, 400); }
      const root = policyRoot(b.root);
      if (root === null) return json({ ok: false, error: "root: has to be an absolute path" }, 400);
      if (!("policy" in b)) return json({ ok: false, error: "policy: is missing" }, 400);
      /* An agent's policy is a request the person answers (the settings door):
         it is the setting that decides which engine runs and what it spends. */
      if (!mayPublishReview(req, caller)) {
        const r = await settingsDoor.change("orchestration.policy", b.policy, { root, person: false, who: askerOf(req, caller, (b as { as?: unknown }).as) });
        noteAction(clientIp, "/orchestration", { ...(root ? { root } : {}), ...(r.ok && !r.applied ? { queued: true } : {}) }, auditOf(r), asActor(caller));
        return doorJson(r);
      }
      const r = writePolicy(root, b.policy);
      noteAction(clientIp, "/orchestration", { ...(root ? { root } : {}) }, r.ok ? { ok: true } : r, asActor(caller));
      if (!r.ok) return json({ ok: false, error: r.error }, 400);
      // Editing the rules is an event too: settle their switches and wake-ups now.
      void evaluatePolicy().catch(() => {});
      // ...and a chain with an engine added is a plan back for a chair that had none.
      void chairsAgain().catch(() => {});
      return json({ ok: true, scope: r.view.scope, root: r.view.root, overrides: r.view.overrides, policy: r.view.policy });
    }
    /**
     * Which rules are on, and why a reading did not change one ("holding: the
     * last usage reading is 47 min old"). Read-only; the evaluator hangs on
     * events, so nothing here asks anybody for a reading.
     */
    if (pathname === "/orchestration/state" && req.method === "GET") {
      return json({ ok: true, rules: ruleStates(), wakeups: armedWakeups() });
    }
    /*
     * Launch permissions: the mode and the deny list every terminal the app
     * opens starts its agent with (launchperm.ts). Anyone may read them.
     *
     * Writing them is the person's: loosening the mode is an escalation for
     * every agent the app starts afterwards. So a write needs a page's Origin
     * (the Settings form), never an Origin-less local caller (a script, an
     * agent's curl), and never a named worker. The UI door does not reach it
     * either: its rows are `agentNever` in the settings registry. A local
     * process can still forge a header; the gate keeps the casual path closed,
     * not the machine's owner out.
     */
    if (pathname === "/launch-permissions" && req.method === "GET") return json({ ok: true, mode: launchMode(), deny: launchDeny() });
    if (pathname === "/launch-permissions" && req.method === "POST") {
      if (!trustedCaller(req, from)) return csrfBlocked();
      let b: { mode?: unknown; deny?: unknown; as?: unknown }; try { b = (await req.json()) as typeof b; } catch { b = {}; }
      /* An agent's change, a worker's included, goes through the settings door:
         a stricter mode or a longer deny list applies, a looser one waits for the person. */
      if (!mayPublishReview(req, caller)) {
        const who = askerOf(req, caller, b.as);
        const rs: DoorAnswer[] = [];
        if (b.mode !== undefined) rs.push(await settingsDoor.change("launch.mode", b.mode, { person: false, who }));
        if (b.deny !== undefined) rs.push(await settingsDoor.change("launch.deny", b.deny, { person: false, who }));
        const off = rs.find((r) => !(r.ok && r.applied));
        noteAction(clientIp, "/launch-permissions", {}, off ? auditOf(off) : { ok: true }, asActor(caller));
        return doorMany(rs, { mode: launchMode(), deny: launchDeny() });
      }
      const r = writeLaunchBase(b);
      return json({ ...r, mode: launchMode(), deny: launchDeny() }, r.ok ? 200 : 400);
    }
    /*
     * THE AGENT RULES (agentRulesStore.ts): one list per project, plus the base
     * set every project shares, that every agent obeys wherever it started.
     * `check` is the hooks' question before each tool call; it also files the
     * quiet first-seen suggestion. A seat reads and writes its own project only.
     */
    if (pathname === "/agent-rules/check" && req.method === "GET") {
      const root = url.searchParams.get("root") ?? "";
      const tool = url.searchParams.get("tool") ?? "";
      if (!root.startsWith("/") || !/^[A-Za-z][A-Za-z0-9_-]{0,99}$/.test(tool)) return json({ ok: false, error: "root: an absolute path; tool: a tool name" }, 400);
      try {
        // `gated`: the gate hook is installed and holds an "ask" itself, so the forwarder stays quiet on one.
        return json({ ok: true, ...rulesCheck(root, tool, (url.searchParams.get("input") ?? "").slice(0, 8000)), gated: gateInstalledCached() });
      } catch (e) {
        // A broken store must not become a decision: the hook reads an error as "no rule".
        return json({ ok: false, decision: "unknown", error: String(e).slice(0, 200) }, 500);
      }
    }
    if (pathname === "/agent-rules" && req.method === "GET") {
      const own = caller?.principal === "seat" ? caller.seat?.root : undefined;
      const root = url.searchParams.get("root") ?? own ?? "";
      if (!(root === "*" || root.startsWith("/"))) return json({ ok: false, error: 'root: a project\'s absolute path, or "*"' }, 400);
      if (own && rulesRoot(root) !== rulesRoot(own) && root !== "*") return json({ ok: false, error: "a seat reads its own project's rules" }, 403);
      return json({ ok: true, ...rulesView(root) });
    }
    if (pathname === "/agent-rules" && req.method === "POST") {
      if (!trustedCaller(req, from)) return csrfBlocked();
      let b: { root?: unknown; action?: unknown; match?: unknown; setting?: unknown; source?: unknown; mode?: unknown; as?: unknown } = {};
      try { b = (await req.json()) as typeof b; } catch { return json({ ok: false, error: "invalid json" }, 400); }
      const person = mayPublishReview(req, caller);
      if (!person && !controlWriteLimit.hit(actorOf(clientIp, asActor(caller)))) return json({ ok: false, error: "too many changes from this caller; slow down" }, 429);
      const own = caller?.principal === "seat" ? caller.seat?.root : undefined;
      if (own && (typeof b.root !== "string" || rulesRoot(b.root) !== rulesRoot(own))) return json({ ok: false, error: "a seat writes its own project's rules; every project's waits for the person" }, 403);
      const r = await setRule(b, { person, by: askerOf(req, caller, b.as) });
      noteAction(clientIp, "/agent-rules", { ...(r.ok ? { rule: r.write.rule.id, queued: !r.write.applied } : {}) }, r.ok ? (r.write.applied ? { ok: true } : { ok: false, error: "waiting for the person" }) : { ok: false, error: r.error }, asActor(caller));
      return r.ok ? json({ ok: true, ...r.write }, r.write.applied ? 200 : 202) : json({ ok: false, error: r.error }, r.status);
    }
    {
      const m = /^\/agent-rules\/(ar_[0-9a-f]{18})\/answer$/.exec(pathname);
      if (m && req.method === "POST") {
        if (!trustedCaller(req, from)) return csrfBlocked();
        let b: { setting?: unknown; dismiss?: unknown } = {};
        try { b = (await req.json()) as typeof b; } catch { return json({ ok: false, error: "invalid json" }, 400); }
        const r = answerRule(m[1]!, b, mayPublishReview(req, caller));
        noteAction(clientIp, "/agent-rules/answer", { rule: m[1] }, r.ok ? { ok: true } : { ok: false, error: r.error }, asActor(caller));
        return r.ok ? json({ ok: true, ...r.write }) : json({ ok: false, error: r.error }, r.status);
      }
    }
    /* Each engine's flags per permission mode: the built-in ones from the engine table, and the person's own words over them. */
    if (pathname === "/launch-flags" && req.method === "GET") {
      return json({ ok: true, overrides: launchFlagOverrides(), builtin: Object.fromEntries(AGENT_PROVIDERS.map((k) => [k.id, k.modeFlags ?? {}])) });
    }
    if (pathname === "/launch-flags" && req.method === "POST") {
      if (!trustedCaller(req, from)) return csrfBlocked();
      let b: { kind?: unknown; modes?: unknown; as?: unknown }; try { b = (await req.json()) as typeof b; } catch { b = {}; }
      if (!mayPublishReview(req, caller)) return viaDoor("/launch-flags", `launch.flags.${String(b.kind)}`, b.modes, b.as);
      const r = writeLaunchFlagOverrides(String(b.kind), b.modes);
      return json({ ...r, overrides: launchFlagOverrides() }, r.ok ? 200 : 400);
    }
    if (pathname === "/seat/wake" && req.method === "GET") return json({ ok: true, hours: seatWakeHours() });
    if (pathname === "/seat/wake" && req.method === "POST") {
      if (!trustedCaller(req, from)) return csrfBlocked();
      const worker = presentedWorker(req);
      if (worker) return json({ ok: false, error: `${worker} is a worker, and a worker has no say over the seat: it reports in its own window.` }, 403);
      let b: { hours?: unknown; as?: unknown }; try { b = (await req.json()) as typeof b; } catch { b = {}; }
      if (!mayPublishReview(req, caller)) return viaDoor("/seat/wake", "seat.wakeHours", b.hours, b.as);
      const r = writeSeatSettings({ seatWakeHours: Number(b.hours) });
      return json({ ...r, hours: seatWakeHours() }, r.ok ? 200 : 400);
    }
    /*
     * THE FIELD, IN A FEW LINES, FOR SOMEBODY WHO PAYS TO READ.
     *
     * The second thing the orchestrator asked for: whether each agent is idle,
     * working or dead and since when, without a pane capture and without eighty
     * rows of listing. `/seat` answers that and a great deal more — the doctrine, the
     * brief, the queue, a photograph of a pane — and the model reading it
     * re-reads its whole context every turn. So the same facts, as text, with
     * nothing else in the envelope.
     */
    /* Whose project a read is about: the person says, with `?root=`; a seat's is
       the one its credential was minted for, whatever the query names. */
    const readGate = (): { root: string } | { error: string; status: number } => {
      if (caller?.principal === "seat") {
        const own = caller.seat?.root;
        if (!own) return { error: "this seat's project is not known, so it speaks for none", status: 403 };
        const g = Seat.seatSpeaksFor(own, url.searchParams.get("root"));
        return "error" in g ? { ...g, status: 403 } : g;
      }
      const g = Seat.seatable(url.searchParams.get("root") || workspaceRoot());
      return "error" in g ? { ...g, status: 400 } : g;
    };
    /* The queue, read-only, for a seat that would rather not carry the whole
       `/seat` answer to find out what is waiting. */
    if (pathname === "/seat/tasks" && req.method === "GET") {
      const gate = readGate();
      if ("error" in gate) return json({ ok: false, error: gate.error }, gate.status);
      return json({ ok: true, root: gate.root, tasks: SeatQueue.tasksFor(gate.root) });
    }
    /* What the seat has asked the person for, as text, for the same reason the
       field is text: the thing reading it pays to read. */
    if (pathname === "/seat/needs" && req.method === "GET") {
      const gate = readGate();
      if ("error" in gate) return json({ ok: false, error: gate.error }, gate.status);
      if (url.searchParams.get("format") === "json") return json({ ok: true, root: gate.root, needs: SeatNeeds.needsFor(gate.root) });
      return new Response(SeatNeeds.needReadout(gate.root), { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
    }
    if (pathname === "/seat/field" && req.method === "GET") {
      const gate = readGate();
      if ("error" in gate) return json({ ok: false, error: gate.error }, gate.status);
      const rows = Seat.fieldFor(gate.root, await boardNow().catch(() => []));
      if (url.searchParams.get("format") === "json") {
        return json({ ok: true, root: gate.root, field: rows, unread: SeatInbox.unreadCount(gate.root), stopped: SeatInbox.unreadWorthWaking(gate.root) });
      }
      /*
       * THE TRAY IS PART OF THE FIELD.
       *
       * "Nobody is stopped on you" while a report in the tray says an agent is
       * waiting for a decision is a true sentence about panes and a false one
       * about the field — measured by the seat reading its own readout with a
       * blocked report sitting unread. An agent stopped on a person is stopped
       * whether the app worked it out from a hook or the agent said so itself.
       */
      const waiting = SeatInbox.unreadWorthWaking(gate.root);
      const unread = SeatInbox.unreadCount(gate.root);
      const tray = unread
        ? `\n\n${unread} unread report${unread === 1 ? "" : "s"} in the tray${waiting ? `, ${waiting} of them stopped or asking for a decision` : ""}: run \`agentglass-agent inbox\`.`
        : "";
      return new Response(fieldReadout(rows) + tray, { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
    }
    if (pathname === "/seat" && req.method === "GET") {
      const gate = readGate();
      if ("error" in gate) return json({ ok: false, error: gate.error }, gate.status);
      return json({ ok: true, ...(await Seat.seatStatus(gate.root)), doctrineText: readDoctrine(gate.root).text, tasks: SeatQueue.tasksFor(gate.root), needs: SeatNeeds.needsFor(gate.root), lines: Seat.seatLines(gate.root), floorHours: seatWakeHours(), models: claudeModels(), defaultModel: Seat.defaultSeatModel() });
    }
    if (pathname.startsWith("/seat/") && req.method === "POST") {
      if (!trustedCaller(req, from)) return csrfBlocked();
      let b: Record<string, unknown>;
      try { b = (await req.json()) as Record<string, unknown>; } catch { return json({ ok: false, error: "invalid json" }, 400); }
      const worker = presentedWorker(req);
      if (worker) return json({ ok: false, error: `${worker} is a worker, and a worker has no say over the seat: it reports in its own window.` }, 403);
      /* Whose project: the person says, a seat does not. A seat's is the one
         its credential was minted for, whatever root the body carries. */
      const asSeat = caller?.principal === "seat";
      const own = asSeat ? caller?.seat?.root : undefined;
      if (asSeat && !own) return json({ ok: false, error: "this seat's project is not known, so it speaks for none" }, 403);
      const gate = own ? Seat.seatSpeaksFor(own, b.root) : Seat.seatable(typeof b.root === "string" && b.root ? b.root : workspaceRoot());
      if ("error" in gate) return json({ ok: false, error: gate.error }, own ? 403 : 400);
      const root = gate.root;
      const verb = pathname.slice("/seat/".length);
      /* The chair's engine, model and powers, and re-seating it, are the
         person's: an agent's change (the seat's own included) goes through the
         settings door, where a narrowing applies and the rest waits for them. */
      if ((verb === "settings" || verb === "change") && !mayPublishReview(req, caller)) {
        const who = askerOf(req, caller, b.as);
        if (verb === "change") {
          const r = await settingsDoor.change("seat.change", true, { root, person: false, who });
          noteAction(clientIp, "/seat/change", { root, ...(r.ok && !r.applied ? { queued: true } : {}) }, auditOf(r), asActor(caller));
          return doorJson(r);
        }
        const rs: DoorAnswer[] = [];
        // The engine first: moving it clears the model, which is then set on top.
        for (const [k, id] of [["kind", "seat.kind"], ["model", "seat.model"], ["powers", "seat.powers"]] as const) {
          if (b[k] !== undefined) rs.push(await settingsDoor.change(id, b[k], { root, person: false, who }));
        }
        return doorMany(rs, { seat: Seat.seatRow(root) });
      }

      if (verb === "open") {
        if (!TERMINAL_ENABLED) return json({ ok: false, error: "the terminal is disabled here" }, 403);
        const powers = Seat.isPower(b.powers) ? b.powers : undefined;
        const model = typeof b.model === "string" ? b.model : undefined;
        const kind = typeof b.kind === "string" && b.kind ? b.kind : undefined;
        const r = await Seat.openSeat({ root, powers, model, kind, wakeHours: seatWakeHours() });
        return json(r, r.ok ? 200 : 400);
      }
      if (verb === "close") return json(await Seat.closeSeat(root));
      /* Changing the engine in the chair is the person's: a seat standing
         itself down to sit again as something else is not a thing it asks. */
      if (verb === "change") {
        if (asSeat) return json({ ok: false, error: "only a person changes the chair" }, 403);
        if (!TERMINAL_ENABLED) return json({ ok: false, error: "the terminal is disabled here" }, 403);
        const r = await Seat.changeChair(root, { wakeHours: seatWakeHours() });
        noteAction(clientIp, "/seat/change", { root }, r, asActor(caller));
        return json(r, r.ok ? 200 : 409);
      }
      /* The seat's own report. Not `/agents/status`: that is the board, and
         the seat is deliberately not on it. */
      if (verb === "say") return json(Seat.seatSays(root, typeof b.line === "string" ? b.line : ""), 200);
      /* The engine and the powers are the person's. A seat's credential is
         turned away at the wall first (auth.ts has no /seat/settings for any
         power); this is the same sentence for the day that list grows. */
      if (verb === "settings") {
        if (asSeat) return json({ ok: false, error: "only a person changes the chair" }, 403);
        if (b.powers !== undefined && !Seat.isPower(b.powers)) return json({ ok: false, error: "powers: speak, nudge or assign" }, 400);
        const row = Seat.seatRow(root);
        const kind = typeof b.kind === "string" && b.kind ? b.kind : undefined;
        const refused = kind ? Seat.chairRefusal(kind) : null;
        if (refused) return json({ ok: false, error: refused }, 400);
        /* A model is one engine's: moving the chair to another engine without
           naming a model leaves the choice to that engine's default. */
        const swapped = !!kind && kind !== (row?.kind || "claude");
        Seat.setSeatSettings(root, typeof b.model === "string" ? b.model : swapped ? "" : row?.model ?? "", Seat.isPower(b.powers) ? b.powers : row?.powers ?? "speak", kind);
        return json({ ok: true, seat: Seat.seatRow(root) });
      }
      /*
       * THE QUEUE. Four verbs and no fifth: a person adds and drops, the seat
       * claims and finishes. Nothing here picks WHAT to work on — the seat
       * does that, out loud, and this only records that it did.
       */
      /* The bank, asked on the seat's behalf. A POST because the question is
         free text and a query string is the wrong place for a sentence. */
      if (verb === "recall") return json({ ok: true, ...recall(String(b.question ?? "")) });
      /*
       * THE INBOX. `report` is what a worker sends; `inbox` is the seat
       * draining it in one call rather than reading five messages. Both are
       * allowed at every power level: reporting and reading are not acts.
       */
      if (verb === "report") {
        const r = SeatInbox.addReport({ root, agent: String(b.agent ?? ""), session: String(b.session ?? ""), text: String(b.text ?? "") });
        /*
         * AND THE SEAT HEARS IT NOW, not at the next sweep.
         *
         * The wake rides the Lantern's look, which is fifteen minutes by
         * default: right for a field that drifts, wrong for an agent saying it
         * is stopped. Measured from the other side — a report saying "waiting
         * for a decision" arrived nowhere, and was found by asking.
         *
         * Floated rather than awaited: the worker's answer is that its report
         * was filed, and that is true whether or not there is anybody in the
         * chair to tell.
         */
        if (r.ok && SeatInbox.worthWaking(r.report)) {
          void SeatWake.wakeForReport(root, r.report.agent).catch(() => false);
        }
        return json(r, r.ok ? 200 : 400);
      }
      if (verb === "inbox") {
        /* Draining marks them read, which is why this is a POST: it changes
           what the next caller sees. `peek` reads without claiming. */
        const reports = b.peek === true ? SeatInbox.unreadReports(root) : SeatInbox.drainReports(root);
        return json({ ok: true, reports, unread: SeatInbox.unreadCount(root) });
      }
      /*
       * WHAT THE SEAT ASKS OF THE PERSON — the other direction of the tray.
       * A report is a worker saying what it needs; this is the seat saying
       * what it needs from the one person who can give it.
       */
      if (verb === "need") {
        const r = SeatNeeds.addNeed({ root, text: b.text, cost: b.cost, recommend: b.recommend, proof: b.proof });
        return json(r, r.ok ? 200 : 400);
      }
      if (verb === "need/finish") {
        const n = SeatNeeds.needById(String(b.id ?? ""));
        if (!n || n.root !== root) return json({ ok: false, error: "no such decision in this project" }, 404);
        SeatNeeds.finishNeed(n.id, String(b.outcome ?? ""));
        return json({ ok: true, need: SeatNeeds.needById(n.id) });
      }
      if (verb === "need/drop") {
        const n = SeatNeeds.needById(String(b.id ?? ""));
        if (!n || n.root !== root) return json({ ok: false, error: "no such decision in this project" }, 404);
        SeatNeeds.dropNeed(n.id);
        return json({ ok: true });
      }
      if (verb === "task") {
        const r = SeatQueue.addTask({ root, title: String(b.title ?? ""), detail: String(b.detail ?? ""), proof: String(b.proof ?? ""), weight: Number(b.weight ?? 0) });
        return json(r, r.ok ? 200 : 400);
      }
      if (verb === "task/drop") {
        const t = SeatQueue.taskById(String(b.id ?? ""));
        if (!t || t.root !== root) return json({ ok: false, error: "no such task in this project" }, 404);
        SeatQueue.dropTask(t.id);
        return json({ ok: true });
      }
      if (verb === "task/claim") {
        const t = SeatQueue.taskById(String(b.id ?? ""));
        if (!t || t.root !== root) return json({ ok: false, error: "no such task in this project" }, 404);
        if (t.attempts >= SeatQueue.MAX_ATTEMPTS) return json({ ok: false, error: `that task has already beaten ${SeatQueue.MAX_ATTEMPTS} agents — it needs a person, not a third go` }, 409);
        const agent = String(b.agent ?? "").trim();
        if (!AgentOps.validName(agent)) return json({ ok: false, error: "claim it for a named agent" }, 400);
        const got = SeatQueue.claimTask(t.id, agent);
        /* 409 rather than 200-with-null: somebody got there first, and a seat
           told "ok" would go and open an agent for work already in hand. */
        return json(got ? { ok: true, task: got } : { ok: false, error: "somebody claimed that first" }, got ? 200 : 409);
      }
      if (verb === "task/finish") {
        const t = SeatQueue.taskById(String(b.id ?? ""));
        if (!t || t.root !== root) return json({ ok: false, error: "no such task in this project" }, 404);
        SeatQueue.finishTask(t.id, String(b.outcome ?? ""));
        return json({ ok: true, task: SeatQueue.taskById(t.id) });
      }
      if (verb === "doctrine") {
        const r = writeDoctrine(root, typeof b.text === "string" ? b.text : "");
        return json(r, r.ok ? 200 : 400);
      }
      /* The rules the seat HANDS OUT, as opposed to the ones it runs by. Two
         files because they govern different people. */
      if (verb === "brief") {
        const r = writeBrief(root, typeof b.text === "string" ? b.text : "");
        return json(r, r.ok ? 200 : 400);
      }
      /*
       * ORCHESTRATE — "put somebody in this project's chair", from anywhere.
       *
       * The same seating the view's button does, reachable from a session in
       * another project entirely, because that is how the ask arrives: a
       * person working in one repository says "give this one an orchestrator"
       * and should not have to go and find the view. Idempotent by the same
       * rule as the button: an occupied chair answers with its occupant.
       */
      /*
       * ADOPT — "the orchestrator for this project is already running, and it
       * is me". For a session that has been working for hours with agents
       * reporting to it: seating a fresh one would throw that away, and the
       * only thing missing was the app knowing who it is.
       *
       * The pane is the identity, because the pane is what liveness rests on
       * everywhere else here. A caller inside a pane knows its own id from
       * $TMUX_PANE.
       */
      if (verb === "adopt") {
        const r = await Seat.adoptSeat({
          root,
          session: String(b.session ?? ""),
          pane: String(b.pane ?? ""),
          powers: Seat.isPower(b.powers) ? b.powers : undefined,
        });
        if (!r.ok) return json(r, 400);
        const d = readDoctrine(root), br = readBrief(root);
        return json({ ok: true, already: r.already, seat: r.seat, doctrine: d.path, brief: br.path });
      }
      if (verb === "orchestrate") {
        if (!TERMINAL_ENABLED) return json({ ok: false, error: "the terminal is disabled here" }, 403);
        const powers = Seat.isPower(b.powers) ? b.powers : undefined;
        const model = typeof b.model === "string" ? b.model : undefined;
        const kind = typeof b.kind === "string" && b.kind ? b.kind : undefined;
        const seeded = { doctrine: readDoctrine(root), brief: readBrief(root) };
        const r = await Seat.openSeat({ root, powers, model, kind, wakeHours: seatWakeHours() });
        if (!r.ok) return json(r, 400);
        return json({
          ok: true, already: r.already, seat: r.seat, agent: r.agent,
          /* Where its two rule files are, and whether this seating wrote them:
             a caller that just created an orchestrator wants to know there is
             something to edit, and where. */
          doctrine: seeded.doctrine.path, doctrineSeeded: seeded.doctrine.seeded,
          brief: seeded.brief.path, briefSeeded: seeded.brief.seeded,
        });
      }
      return json({ ok: false, error: "no such seat verb" }, 404);
    }
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
      return json({ ok: true, result: { agents: (await AgentOps.listAgents(all)).map(settled) } });
    }
    if (pathname.startsWith("/agents/named/") && req.method === "POST") {
      if (!trustedCaller(req, from)) return csrfBlocked();
      if (!TERMINAL_ENABLED) return json({ ok: false, error: "the terminal is disabled here" }, 403);
      const verb = pathname.slice("/agents/named/".length);
      let b: Record<string, unknown>;
      try { b = (await req.json()) as Record<string, unknown>; } catch { return json({ ok: false, error: "invalid json" }, 400); }
      /* One row in the Activity log per act, with the seat's project as the
         actor, and a refusal is an act: what was turned away is the part worth
         reading later. */
      const say = (r: Record<string, unknown>, status = 200): Response => {
        if (["start", "prompt", "keys", "stop", "broadcast", "own", "enlist"].includes(verb)) {
          noteAction(clientIp, `/agents/named/${verb}`, { name: typeof b.name === "string" ? b.name : "" },
            r.ok === true ? { ok: true } : { ok: false, error: String(r.error ?? "") }, asActor(caller));
        }
        return json(r, status);
      };
      const worker = presentedWorker(req);
      if (worker) {
        return say({ ok: false, error: `${worker} is a worker, and a worker does not start, prompt or stop agents: it reports its result in its own window, and the seat that started it reads that.` }, 403);
      }
      const timeoutMs0 = Math.min(600_000, Math.max(0, Number(b.timeout ?? 0) || 0));
      /* A permission prompt on a worker's screen is the person's to answer. A
         seat that owns the worker could otherwise approve it by pressing enter,
         or by pasting a line and its enter: the same answer, by the back door.
         Only the way out (escape, ctrl-c) stays a seat's. */
      const seatAtPrompt = async (paneId: string): Promise<boolean> =>
        caller?.principal === "seat" && AgentOps.stateOfScreen(await AgentOps.screenOf(paneId)) === "needs-you";
      const PROMPT_IS_THE_PERSONS = "a permission prompt is the person's; ask with agentglass-agent need";
      /*
       * BROADCAST — one message, N agents.
       *
       * The orchestrator's own words for why: it was pasting the same
       * paragraph five times, and each paste is a turn of the most expensive
       * context on the machine. Every name is attempted and every outcome is
       * reported: a partial send that read as a success would leave somebody
       * waiting for an instruction that never arrived.
       */
      if (verb === "broadcast") {
        const names = Array.isArray(b.names) ? b.names.filter((n): n is string => typeof n === "string") : [];
        const text = typeof b.text === "string" ? b.text : "";
        if (!text.trim()) return json({ ok: false, error: "nothing to send" }, 400);
        const live = (await AgentOps.listAgents()).filter((a) => a.endedAt === null && !notYours(caller, a));
        const want = names.length ? live.filter((a) => names.includes(a.name)) : live;
        const missing = names.filter((n) => !live.some((a) => a.name === n));
        const sent: { name: string; outcome: string }[] = [];
        for (const a of want) {
          const outcome = await seatAtPrompt(a.paneId) ? `refused: ${PROMPT_IS_THE_PERSONS}` : await AgentOps.promptAgent(a.paneId, text, timeoutMs0 || 10_000, a.kind).catch(() => "gone");
          sent.push({ name: a.name, outcome: String(outcome) });
        }
        return say({
          ok: sent.some((x) => x.outcome === "sent" || x.outcome === "queued"),
          result: { sent, missing, asked: want.length },
        });
      }
      if (!AgentOps.validName(b.name)) return say({ ok: false, error: "name: letters, digits, dot, dash or underscore, 64 at most" }, 400);
      const name = b.name;
      const timeoutMs = Math.min(600_000, Math.max(0, Number(b.timeout ?? 0) || 0));

      if (verb === "start") {
        const cwd = gitSafeAbs(b.cwd);
        const seatRoot = caller?.principal === "seat" ? caller.seat?.root ?? null : null;
        /* A seat starts workers with a role, in its own project. The role is
           where the envelope comes from, so a start without one would be the
           policy as advice; and a worker in another project would answer to
           this project's policy. Both are refused before anything else is read. */
        if (seatRoot) {
          /* Nor under a name a chair carries: `seated` knows an orchestrator
             by its name, so the worker would be one. Measured: with the other
             chair down, the start answered 200. */
          if (isChair({ name, paneId: "" })) {
            return say({ ok: false, error: `${name} is a seat's name, and no worker is started under one` }, 403);
          }
          if (b.role === undefined) {
            return say({ ok: false, error: "a seat starts workers with --role (scout, builder, reviewer or verifier): the role's envelope is what keeps a worker inside the policy, so a start without one is refused" }, 400);
          }
          if (!cwd || !seatMayUse(seatRoot, cwd)) {
            return say({ ok: false, error: `that directory is not inside ${basename(seatRoot)}'s own tree or worktrees, and a seat starts workers only there` }, 400);
          }
        }
        // What the window opens in is the directory that was checked, links followed.
        const runIn = (seatRoot && cwd ? seatMayUse(seatRoot, cwd) : null) ?? cwd;
        /*
         * A SIBLING WORKTREE IS THE SAME PROJECT.
         *
         * `inScope` measures against the open project's directory, so
         * `~/code/app-feature` — a worktree of `~/code/app`, cut by the very
         * brief these agents are handed — read as somewhere else and the start
         * was refused. Measured on a real project here: half the agents live in
         * sibling worktrees, so half of them could not be started from the app
         * at all.
         *
         * The rule widens to the REPOSITORY, not to the machine: a directory
         * qualifies when git says it belongs to the project this app has open.
         * `projectRootOf` is the reader that already answers that question —
         * it strips `.worktrees/` and folds the rest through
         * `--git-common-dir` — and it is the same fold the seat uses to decide
         * where a report lands.
         */
        const sameProject = !!cwd && workspaceRoots().includes(projectRootOf(cwd) ?? "");
        if (!cwd || (!inScope(cwd) && !sameProject) || !fsExists(cwd)) {
          return say({ ok: false, error: "that directory is not in the open project, nor a worktree of it" }, 400);
        }
        /* A name another seat's worker answers to, live or finished, is not
           this seat's to take over: taking it would erase the other's answer.
           One nobody owns is refused only while it is running. */
        const had = AgentOps.agentNamed(name);
        const clash = had ? notYours(caller, had) : null;
        if (clash && (had!.seatRoot || await AgentOps.paneAlive(had!.paneId))) return say({ ok: false, error: clash }, 403);
        const policyRoot = seatRoot ?? projectRootOf(cwd) ?? workspaceRoot() ?? cwd;
        if (policyEngaged(policyRoot, b)) {
          const r = await startThroughPolicy({
            root: workspaceRoot() || cwd, policyRoot, name, cwd: runIn!, prompt: typeof b.prompt === "string" ? b.prompt : "", body: b, seatRoot,
          });
          return say(r.body, r.status);
        }
        /* A worker ROLE picks the CLI itself — Settings says which one each
           role runs on — and brings that CLI's lock and model with it. The
           lock is built here from the role table, never taken from the body:
           naming a kind as well is refused unless it is the same one, so a
           caller cannot ask for a role and quietly get another CLI unlocked. */
        const role = b.role === undefined ? null : AgentOps.roleStart(b.role);
        if (role && !role.ok) {
          return say({ ok: false, error: role.error === "no-role" ? "no such role" : "the CLI this role is set to has no lock this app can apply" }, 400);
        }
        const wanted = role?.ok ? role.kind : typeof b.kind === "string" ? b.kind : "claude";
        if (role?.ok && typeof b.kind === "string" && b.kind !== role.kind) {
          return say({ ok: false, error: `this role runs on ${role.kind} (Settings ▸ Worker roles), not ${b.kind}` }, 400);
        }
        if (!agentKind(wanted)) return say({ ok: false, error: "no such agent" }, 400);
        const args = Array.isArray(b.args) ? b.args.filter((a): a is string => typeof a === "string") : [];
        const r = await AgentOps.startAgent({
          root: workspaceRoot() || cwd, name, cwd: runIn!, kind: wanted,
          prompt: typeof b.prompt === "string" ? b.prompt : "",
          yolo: b.yolo === true, yoloAllowed: chatBypassAllowed(), args,
          remoteControl: typeof b.remoteControl === "string" ? b.remoteControl : undefined,
          keep: b.keep === true,
          ...(role?.ok ? { serverArgs: role.args, env: role.env, lockedRole: true } : {}),
          owner: { seatRoot, model: "", startedBy: null, resumeId: null },
        });
        if (!r.ok) {
          /* `arg-refused` and `lock-loosened` are answered below, with their detail in them. */
          const why: Record<Exclude<AgentOps.StartError, "arg-refused" | "lock-loosened">, string> = {
            exists: "an agent by that name is still running",
            "no-cli": "that agent CLI is not installed here",
            "no-window": "tmux would not open a window for it",
            died: b.keep === true
              ? `the agent CLI exited as soon as it was launched; its tab is kept: agentglass-agent read ${name}`
              : "the agent CLI exited as soon as it was launched",
            "bad-name": "bad name",
            "yolo-refused": "skipping permissions is off in Settings (chatBypass)",
            "yolo-role": "a worker role runs under its lock, and skipping permissions is never combined with one",
            "bad-args": "args must be plain strings",
          };
          /* Named, so the caller learns which arg and why in one answer: what
             an agent is allowed to do is decided in Settings (yolo) or by this
             server, never by a flag riding in `args` — see refusedArg. */
          if (r.error === "lock-loosened") {
            return say({ ok: false, error: `this directory's OpenCode config loosens the role's lock, so it was not started: ${r.detail}` }, 400);
          }
          if (r.error === "arg-refused") {
            return say({ ok: false, error: `${r.flag} is not an arg a start may carry: it changes what the agent is allowed to do, and that is decided in Settings, not in args` }, 400);
          }
          return say({ ok: false, error: why[r.error], result: r.error === "exists" ? { agent: r.agent } : undefined }, r.error === "exists" ? 409 : 400);
        }
        /* `--timeout` on start is Herdr's "wait until the CLI is up": the
           worker's next verb is a prompt, and a paste into a pane whose CLI has
           not drawn its box yet is a paste into a shell. */
        const wait = timeoutMs > 0 ? await AgentOps.waitFor(r.agent.paneId, ["ready", "working", "needs-you"], timeoutMs, 250, r.agent.kind) : null;
        return say({ ok: true, result: { agent: r.agent, state: wait?.state ?? "starting", ready: wait?.reached ?? false } });
      }

      /*
       * ENLIST — a tab somebody opened, under this app's hand.
       *
       * Its first ask was one message to N agents, and for the orchestrator
       * here the N was zero: every agent it runs is a tmux tab it opened by
       * hand, and the registry held only what this app had started.
       */
      if (verb === "enlist") {
        /* From a seat, only a tab inside its own project, never a seat's
           chair, and never under a name that is another seat's or a chair's:
           enlisting decides what the seat's other verbs can reach, and the
           name's old row is replaced by the new one. */
        const seat = caller?.principal === "seat" ? caller.seat?.root ?? null : null;
        const had = AgentOps.agentNamed(name);
        if (seat && isChair({ name, paneId: had?.paneId ?? "" })) {
          return say({ ok: false, error: `${name} is a seat's name, and a seat is nobody's to enlist` }, 403);
        }
        if (seat && had?.seatRoot) {
          const why = notYours(caller, had);
          if (why) return say({ ok: false, error: why }, 403);
        }
        const r = await AgentOps.enlistAgent({
          name, pane: typeof b.pane === "string" ? b.pane : undefined,
          window: typeof b.window === "string" ? b.window : undefined,
          refuse: seat ? (p) => isChair({ name, paneId: p.paneId }) ? "that pane is a seat, and a seat is nobody's to enlist"
            : seatMayUse(seat, p.cwd) ? null
            : `that tab is not inside ${basename(seat)}'s own tree or worktrees, and a seat enlists only there` : undefined,
        });
        if (r.ok) return say({ ok: true, result: { agent: r.agent } });
        const why: Record<string, string> = {
          "bad-name": "name: letters, digits, dot, dash or underscore, 64 at most",
          exists: `an agent by that name is already live in pane ${r.detail}`,
          "no-pane": "no pane by that id or window name on the engine",
          "many-panes": `more than one window is called that (${r.detail}) — say which pane`,
          "not-an-agent": `that pane is running ${r.detail}, not an agent — prompting it would type into a shell`,
          taken: `that pane is already agent ${r.detail}: it answers to that name and its owner`,
          refused: r.detail ?? "",
        };
        return say({ ok: false, error: why[r.error] }, r.error === "exists" ? 409 : 400);
      }

      const a = AgentOps.agentNamed(name);
      /* OWN — a seat takes an agent nobody owns, on purpose. Only a seat: the
         person's own token and a worker are refused, and an agent already
         owned, by anyone, is not taken. */
      if (verb === "own") {
        if (caller?.principal !== "seat" || !caller.seat) return say({ ok: false, error: "only a seat can own an agent: ask from the orchestrator's own session" }, 403);
        if (!a) return say({ ok: false, error: "no agent by that name" }, 404);
        if (a.seatRoot && a.seatRoot !== caller.seat.root) return say({ ok: false, error: `${a.name} belongs to the seat of ${basename(a.seatRoot)}, not to yours (${basename(caller.seat.root)}). Ask that seat, or the person.` }, 403);
        if (a.endedAt !== null) return say({ ok: false, error: "no agent by that name" }, 404);
        /* Having no owner is not enough: a seat's own row has none either, and
           so does every tab the person works in, in any project. */
        if (isChair(a)) return say({ ok: false, error: `${a.name} is a seat, and a seat is nobody's to own` }, 403);
        if (!seatMayUse(caller.seat.root, a.cwd)) {
          return say({ ok: false, error: `${a.name} is not inside ${basename(caller.seat.root)}'s own tree or worktrees, and a seat owns agents only there` }, 403);
        }
        AgentOps.ownAgent(a.name, caller.seat.root);
        return say({ ok: true, result: { name, owner: caller.seat.root } });
      }
      const theirs = a ? notYours(caller, a) : null;
      if (theirs) return say({ ok: false, error: theirs }, 403);
      /* A policy-started worker is a one-shot that has usually finished by the
         time it is told something: that is a resumed turn, not keys in a pane. */
      if (verb === "prompt" && a && startedByOf(a)) {
        const text = typeof b.text === "string" ? b.text : "";
        if (!text.trim()) return say({ ok: false, error: "nothing to send" }, 400);
        const r = await promptHeadless(a, text);
        return say(r.body, r.status);
      }
      /* An ended agent can still be READ while its own tab is on screen: a
         `--keep` one-shot's answer is what it was kept for. And STOPPED, which
         closes that tab: otherwise it stays for the wrapper's day — only a
         tab this app opened, never one somebody lent it by enlisting. Its own
         tab, by the window name it was opened under — a pane id outlives
         nothing across a reboot, and an old row's id may name somebody's pane
         now. */
      const readable = !!a && (verb === "read" || (verb === "stop" && !a.adopted)) && a.endedAt !== null && await AgentOps.keptTabOf(a);
      if (!a || (a.endedAt !== null && !readable)) return json({ ok: false, error: "no agent by that name" }, 404);

      if (verb === "prompt") {
        const text = typeof b.text === "string" ? b.text : "";
        if (!text.trim()) return json({ ok: false, error: "nothing to send" }, 400);
        if (await seatAtPrompt(a.paneId)) return say({ ok: false, error: PROMPT_IS_THE_PERSONS }, 403);
        const outcome = await AgentOps.promptAgent(a.paneId, text, timeoutMs || 10_000, a.kind);
        return say({ ok: outcome === "sent" || outcome === "queued", result: { name, outcome } }, outcome === "gone" ? 410 : 200);
      }
      if (verb === "wait") {
        const raw = typeof b.until === "string" ? b.until.split(",") : [];
        const until = raw.map((s) => s.trim()).filter((s): s is AgentOps.AgentState => ["starting", "ready", "working", "needs-you", "gone"].includes(s));
        if (!until.length) return json({ ok: false, error: "until: ready, working, needs-you or gone" }, 400);
        const w = await AgentOps.waitFor(a.paneId, until, timeoutMs || 90_000, 250, a.kind);
        return json({ ok: w.reached, result: { name, state: w.state, reached: w.reached } });
      }
      if (verb === "read") {
        const lines = Math.min(2000, Math.max(0, Number(b.lines ?? 0) || 0));
        const screen = await AgentOps.screenOf(a.paneId, lines);
        if (screen === null) return json({ ok: false, error: "its window is gone" }, 410);
        /* The bottom of a pane is blank rows, not content: trimmed before the
           tail is cut, or "the last 3 lines" of a 50-row pane are three blanks. */
        const text = lines > 0 ? screen.trimEnd().split("\n").slice(-lines).join("\n") : screen;
        const turn = settled(a);
        return json({ ok: true, result: { name, state: readable ? "gone" : AgentOps.stateOfScreen(screen, a.kind), text, ...(turn.exitCode !== undefined ? { exitCode: turn.exitCode, exitLine: turn.exitLine } : {}) } });
      }
      if (verb === "keys") {
        const key = AgentOps.keyNamed(b.key);
        if (!key) return json({ ok: false, error: "key: enter, escape, up, down, left, right, tab, space, backspace or ctrl-c" }, 400);
        if (key !== "Escape" && key !== "C-c" && await seatAtPrompt(a.paneId)) return say({ ok: false, error: PROMPT_IS_THE_PERSONS }, 403);
        const ok = await AgentOps.pressKey(a.paneId, key);
        return say({ ok, result: { name, key } }, ok ? 200 : 410);
      }
      if (verb === "stop") {
        /* An enlisted tab is let go, not killed: it is somebody's own window
           with their work in it. `kill: true` says the caller meant the window
           and not the registration. The answer says which happened. */
        const r = await AgentOps.stopAgent(a, Date.now(), b.kill === true || !a.adopted);
        return say({ ok: r.ok, result: { name, killed: r.killed, letGo: !r.killed } });
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
          installed: !!agentBinFor(a.id),
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
        // Set when this boot declined to restore; null otherwise.
        crashLoop: crashLoopStatus(),
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

    if (pathname === "/terminal/tmux/windows" && req.method === "GET") {
      const name = String(url.searchParams.get("session") ?? "");
      if (!validSessionName(name)) return json({ ok: false, error: "invalid session" }, 400);
      return json({ ok: true, windows: await windowTree(name) });
    }

    /* Is Claude already working in the window a button is about to open? Exact
       name, in this repository (and, when given, this checkout). Read on mount
       and whenever the tab strip changes, so the card says so after a reload
       and in a second window of the app. */
    if (pathname === "/terminal/tmux/live-window" && req.method === "GET") {
      const root = gitSafeAbs(url.searchParams.get("root"));
      const name = String(url.searchParams.get("name") ?? "");
      if (!root || !name) return json({ ok: false, error: "root and name are required" }, 400);
      if (isForeignRoot(root) && !mayReadForeignRoot(caller)) return foreignRefused();
      const path = url.searchParams.get("path");
      return json({ ok: true, window: await findLiveWindow({ root, name, ...(path ? { path: gitSafeAbs(path) ?? "/nowhere" } : {}) }) });
    }

    if (pathname === "/terminal/tmux/windows" && req.method === "POST") {
      if (!trustedCaller(req, from)) return csrfBlocked();
      let b: any = {};
      try { b = await req.json(); } catch { return json({ ok: false, error: "invalid json" }, 400); }
      const name = String(b.session ?? "");
      if (!validSessionName(name)) return json({ ok: false, error: "invalid session" }, 400);
      // A new window or pane runs a command (a shell when argv is empty), which
      // is the terminal by another door: refused while it is switched off.
      // Closing, selecting and renaming run nothing and stay.
      const starts = b.op === "new" || b.op === "split";
      if (starts && !TERMINAL_ENABLED) return json({ ok: false, error: "the terminal is disabled here" }, 403);
      // A directory is only for a window or pane that STARTS somewhere. Closing
      // or renaming one needs none, and asking for it made a window whose
      // checkout had since been deleted impossible to close.
      const cwd = (starts ? gitSafeAbs(b.cwd) : "") ?? "";
      if (starts && (!cwd || !fsExists(cwd))) return json({ ok: false, error: "that directory is not available" }, 400);
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
        return json({ available: true, reviewFocus: "", files: [], error: failed("walkthrough", e, "the walkthrough could not be written") });
      }
    }
    // Whether an agent is working right now, anywhere — what the desktop
    // shell's "keep the machine awake while an agent works" mode polls.
    if (pathname === "/agents/working") {
      const why = workingWhy();
      return json({ working: anyWorking(why), why });
    }
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
        pricing: pricingProvenance(),
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
    })(); } finally { finished(mark); }
}

setPluginSocketHandler(handleServerRequest as unknown as (req: Request, srv: any) => Promise<Response>);

const server = Bun.serve<WsData>({
  port: PORT,
  hostname: BIND,
  // A frame is a control message or a keystroke; nothing legitimate is large.
  // Unset, Bun allows 16MB per frame, which is a cheap way to exhaust memory.
  maxRequestBodySize: 32 * 1024 * 1024,
  // Bun closes a connection that has been quiet for `idleTimeout` seconds, and
  // the default is 10 — which counts the gaps *inside* a streaming response, not
  // just an idle socket. A streamed response is silent for as long as the
  // work behind it runs, so the default cut it off mid-stream and the browser
  // reported only a generic fetch failure. 255 is the maximum Bun accepts.
  idleTimeout: 255,
  fetch: handleServerRequest,

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
      if (ws.data?.kind === "canvas") {
        // Alive from the start, like the pty: a window that is only listening
        // sends nothing, and the sweep would otherwise call it frozen.
        alive.set(ws, Date.now());
        (ws.data as { handle?: CanvasHandle }).handle = new CanvasHandle({ send: (t) => ws.send(t), buffered: () => ws.getBufferedAmount() });
        return;
      }
      if (ws.data?.kind === "notify") {
        notifySubs.set(ws, subscribeNotifications((n) => {
          try { ws.send(JSON.stringify(n)); } catch { /* closing */ }
        }));
        return;
      }
      clients.add(ws);
      autoFetchWhenSomeoneComes();
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
      // The Lantern's card as it stands, which a client that was closed when it
      // was announced or cleared would otherwise never hear. See lanternSnapshot.
      ws.send(JSON.stringify({ type: "alert", data: lanternSnapshot() } satisfies WsFrame));
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
      if (ws.data?.kind === "canvas") { (ws.data as { handle?: CanvasHandle }).handle?.close(); return; }
      if (ws.data?.kind === "notify") {
        // Unsubscribing is what stops the monitor process once the last
        // listener goes, so this must run on every close path.
        notifySubs.get(ws)?.();
        notifySubs.delete(ws);
        return;
      }
      clients.delete(ws);
      // Only if it is still the latest: a reconnect has already replaced it.
      const cid = (ws.data as { clientId?: string }).clientId;
      if (cid && browserSockets.get(cid) === ws) { browserSockets.delete(cid); dropBrowserTarget(cid); }
    },
    message(ws: ServerWebSocket<WsData>, msg) {
      // A frame that did arrive is still proof somebody is running — for a
      // pty this is a keystroke or a resize, not just the event stream.
      alive.set(ws, Date.now());
      if (ws.data?.kind === "pty") { ptyMessage(ws, msg as string | Buffer); return; }
      if (ws.data?.kind === "canvas") { (ws.data as { handle?: CanvasHandle }).handle?.message(msg as string | Buffer); return; }
      if (ws.data?.kind === "events" && typeof msg === "string" && msg.length < 512 && msg.startsWith("{")) {
        let f: { type?: unknown; clientId?: unknown; browser?: unknown } = {};
        try { f = JSON.parse(msg); } catch { return; }
        /* Named once, and only by a socket that is not a paired device: a phone
           or a dashboard tab has no browser to host, and a socket that could
           rename itself at will would be a way to squat on another window's
           name. The role itself is granted by /browser/ready, which is gated. */
        if (f.type === "hello" && f.browser === true && typeof f.clientId === "string" && f.clientId && f.clientId.length <= 128
          && !ws.data?.deviceId && !(ws.data as { clientId?: string }).clientId) {
          /* A later hello under the same id takes over from a socket that is still
             open, on purpose: a window that reconnects after a network flap says
             hello before the server has noticed the old socket is dead, and
             refusing it would leave that window unaddressable for a minute. The
             id is what protects it (a random UUID, in no route or log), so the
             ceiling is: whoever learns a window's id can take its asks. */
          (ws.data as { clientId?: string }).clientId = f.clientId;
          browserSockets.set(f.clientId, ws);
        }
      }
    },
    /** The answer to the sweep's ping, and — for an event-stream or notify
     *  socket — the only routine evidence its peer ever sends; a pty socket
     *  also gets this from every keystroke, above. */
    pong(ws: ServerWebSocket<WsData>) {
      alive.set(ws, Date.now());
    },
    /** A canvas socket that was behind has emptied its buffer. */
    drain(ws: ServerWebSocket<WsData>) {
      if (ws.data?.kind === "canvas") (ws.data as { handle?: CanvasHandle }).handle?.drain();
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

/*
 * The precedent bank, re-filed after C4/C9/C10 changed shape.
 *
 * At boot rather than on demand: retrieval asks for a class by name, and a
 * bank half in the old drawers and half in the new answers differently
 * depending on when a row was banked. Once per database — the call is a no-op
 * on the second boot.
 */
{
  const moved = refileBank("c4-c9-c10-disjoint", ["C4", "C9", "C10"]);
  if (moved) console.log(`[understudy] re-filed ${moved} precedent(s) into the classes that now claim them`);
}

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
  // The hourly moment to hand the WAL back: never waits, see trimWal.
  trimWal();
}
prune();
setInterval(prune, 3_600_000);
// The idle clock only advances when somebody looks, so look every five minutes
// even with the Machine panel closed; ss twice is cheap next to a stale server.
setInterval(() => { void listPortsAsync().catch(() => {}); }, 300_000).unref?.();

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
startMirrorSweeper(engineSocketArgs());

startPolicyEvaluator();
// A gate installed before its command tested for the script would deny every
// tool call once the script moved. Not in tests: they would rewrite the real file.
if (process.env.NODE_ENV !== "test") { try { healGateCommand(); } catch { /* the Lantern still says what the command does */ } }
// The turn limits lived in memory and are not put back: a worker still on its
// turn is marked as having lost its ceiling, never stopped by an id from before.
void workersAfterRestart().catch(() => {});
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
    console.warn(`[tmux] Restore it by hand when the app is stable, from Settings, or delete ${launchesPath()} to clear this.`);
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
    stopMirrorSweeper();
    stopAllPluginsSync();
    flushPluginNotes();
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
} else {
  const w = tokenlessWarning(AUTH);
  if (w) console.warn(w);
}
// Unconditional rather than gated on "is a gate hook actually installed":
// this process has no way to see settings.json, and printing it either way
// costs one line while an operator who never installed the hook never
// notices it either way.
console.log(
  gateFailClosed()
    ? "✋ gate: fail-closed — a timeout or an unreachable hook DENIES the tool call"
    : "✋ gate: fail-open — a timeout or an unreachable hook ALLOWS the tool call; " +
        "set AGENTGLASS_GATE_FAILCLOSED=1 to deny instead"
);
if (WEB_UI_ENABLED) console.log(`   Web UI      → http://localhost:${server.port}/ (serving ${distPath()})`);
console.log(`   POST events → http://localhost:${server.port}/ingest`);
console.log(`   WebSocket   → ws://localhost:${server.port}/stream`);
console.log(`   Stats API   → http://localhost:${server.port}/stats`);
console.log(`   Retention   → ${RETENTION_DAYS ? `${RETENTION_DAYS} days` : "unlimited"}`);
startPricingRefresh();
const ws = workspaceRoots();
console.log(ws.length ? `   Project     → ${ws.join(", ")} (${ws.length === 1 ? "this project" : "these projects"} only)` : "   Project     → every project on this machine");
// Only meaningful once a project is open — see startAutoFetch().
setAutoFetchAudience(() => clients.size > 0);
startAutoFetch();
// A pull request's checks finished. The latch is on the server so the message
// arrives once per verdict no matter how many browser tabs are watching, and
// the frame carries the names of what failed rather than only a count.
subscribeCi((v) => broadcast({ type: "ci", data: v }));
/* The notify watches: any change sends the whole (small) list, a firing sends
   one frame, and the CI tick reads through prRollup — see prNotifyWatch.ts. */
/** Your open PRs a list read returned — the auto-apply of a repo's default rules. */
function noteMine(root: string, filter: string, state: string, r: { repo: { nameWithOwner: string } | null; prs: { number: number; title: string }[] }): void {
  if (filter !== "mine" || state !== "open" || !r.repo) return;
  try { sawMine(r.repo.nameWithOwner, root, r.prs); } catch { /* a bookkeeping failure must not fail a list */ }
}
// A comment watch is a promise to be told: it reads every remark list the poll sees, before any latch or read mark.
subscribeTalkSeen(watchOnTalkSeen);
subscribeWatchChange(() => broadcast({ type: "prwatch", data: listWatches() }));
subscribeWatchFire((f) => broadcast({ type: "prwatchfire", data: f }));
// What the person asked for stays until they act on it; closing it in one window takes it down in all of them.
subscribeAskedAlerts((e) => broadcast(e));
subscribeWatchChecks((c) => broadcast({ type: "prchecks", data: c }));
const prNotifyKick = process.env.NODE_ENV === "test" ? () => {} : startPrNotifyWatch(async (root, number) => {
  const r = await prRollup(root, number, true); // forced: the watch's own cadence is the budget, and a cached read would add its age to the wait
  // The new commit after a sync or a push has no checks yet, only a head: that is what tells "not started" from "still the old run".
  if (!r.ok && r.sha) return { allDone: false, verdict: null, all: [], state: r.state, sha: r.sha };
  if (!(r.ok && r.checks && r.all)) return null;
  // Past 100 contexts `all` is only the first page: never conclude "all done" from it.
  const complete = !r.truncated;
  return { checks: complete ? r.checks : undefined, allDone: r.checks.allDone && complete, verdict: complete ? r.checks.verdict : null, all: r.all, state: r.state, sha: r.sha };
}).kick;
async function dropSyncFor(root: string, n: unknown): Promise<void> {
  const id = await prRepoIdFor(root).catch(() => null);
  if (id) dropSync(id.nameWithOwner, Number(n));
}
/** An Update branch has begun (GitHub has not answered yet): a watch on this PR must not take the old head's green for the new run's. One read now, then the watch's own cadence. */
async function noteSyncFor(root: string, n: unknown, before?: string): Promise<void> {
  const id = await prRepoIdFor(root).catch(() => null);
  if (!id) return;
  noteSync(id.nameWithOwner, Number(n), before ?? null);
  prNotifyKick();
}
// A plugin drew something, or wrote notes on a pull request. The frame says
// only where to look again; what was drawn is fetched over the token.
setPluginUiHook((f) => broadcast({ type: "plugin", data: f }));
// Which panels are live canvases of an enabled plugin, for the window's socket
// (plugin-canvas.ts). Read from the registry each time: an approval that was
// withdrawn or a plugin that was stopped is the answer, not a cached one.
setCanvasResolver((plugin, panel) => {
  const p = listPlugins().find((x) => x.name === plugin);
  return { canvas: !!p?.enabled && isCanvasPanel(p.contributes, panel), running: !!p && isRunning(plugin) };
});
// Plugins that were on before this server went down come back with fresh
// tokens. After the listener, so their first request finds a server.
// Before the plugins: one that needs a key reads it as it starts. A keyring that
// is locked or missing does not hold the boot (five seconds at most) and does not
// stop it; the secrets read as absent and the features say why.
void rehydrate().catch(() => {}).then(() => resumeEnabledPlugins()).then((names) => { if (names.length) console.log(`   Plugins     → ${names.join(", ")}`); });
/* And somebody speaking on one. Derived from the same poll — GitHub's
   notifications are an inbox rather than a feed a desktop app can subscribe to —
   with the latch on the server, so a review carrying nine line comments is one
   message and not nine. Never a bot. See noteTalk.

   Gated on the read marks first: `noteTalk`'s latch only knows the newest
   remark it has already told a listener about, not whether a person has since
   read the pull request on another device — and prWatch.ts now re-asks the
   list on a timer with nobody at the PRs tab, so a comment read on the desk
   would otherwise buzz a phone that never opened it. See talkAlreadyRead. */
subscribeTalk((n) => {
  if (talkAlreadyRead(n, listMarks("pr"))) return;
  broadcast({ type: "talk", data: n });
});
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

/* Before anything reads the settings: who had ClickUp before they existed keeps
   what they had, and who did not starts from the defaults. See settleFirstRun. */
settleFirstRun(hasStoredCredential("clickup"));
startCardWatch((n) => broadcast({ type: "card", data: n }));
/* The same bell for a connected Jira: one search every six minutes, nothing
   at all while Jira is not connected. See jirawatch.ts. */
import { startJiraWatch, rememberOwnMove as jiraRememberOwnMove, rememberOwnAssign as jiraRememberOwnAssign } from "./jirawatch.ts";
import { boardContext as jiraBoardContext } from "./jiraBoardContext.ts";
import { rankStored as jiraRank } from "./jiraRank.ts";
import { serveFileStored as jiraFileServe, attachFileStored as jiraAttach, removeFileStored as jiraUnattach, UPLOAD_MAX as JIRA_UPLOAD_MAX } from "./jiraFiles.ts";
import { linkKindsStored as jiraLinkKinds, createSubtaskStored as jiraSubtask, relateCardsStored as jiraRelate, unrelateCardsStored as jiraUnrelate, addWebLinkStored as jiraWebLink, removeWebLinkStored as jiraWebUnlink } from "./jiraRelate.ts";
import { detailStored as jiraDetailRead, mentionableStored as jiraMentionable, commentStored as jiraCommentOn, editCommentStored as jiraCommentEdit, deleteCommentStored as jiraCommentDelete } from "./jiraComments.ts";
import { setVoteStored as jiraVote, setWatchStored as jiraWatch } from "./jiraFollow.ts";
import { logWorkStored as jiraWorkLog, editWorkStored as jiraWorkEdit, deleteWorkStored as jiraWorkDelete } from "./jiraWorklog.ts";
import { editStored as jiraEditCard, labelSuggestionsStored as jiraLabels } from "./jiraEdit.ts";
import { ghReadArgs, runGhRead, streamTarball } from "./plugin-github.ts";
startJiraWatch((n) => broadcast({ type: "card", data: n }));
/* Re-asks the open pull request lists a real client has looked at, on a timer,
   so a comment posted while nobody is on the PRs tab still reaches `noteTalk`
   the next time somebody could actually be told about it. See prWatch.ts. Off
   under `bun test`: a suite that left this running would fire real `gh` calls
   on a schedule nothing in the test asked for, against whatever pairs an
   earlier test's process-wide map still holds. */
if (process.env.NODE_ENV !== "test") {
  startOrphanSampler(orphanCtx);
  /* The desktop switched theme: windows re-read its palette, instead of each
     asking every few seconds whether it had. */
  watchDesktopPalette(() => broadcast({ type: "desktop-palette" }));
  startPrWatch({
    liveClients: () => clients.size,
    // A root that no longer resolves rejects; a timer has nobody to tell.
    relist: (root, filter) => { void listPrs(root, filter, "open").then((r) => noteMine(root, filter, "open", r)).catch(() => {}); },
  });
}
/* The Lantern's watch: the field re-read every N minutes, a loud word when
   something on it needs a person. See lanternwatch.ts. */
startLanternWatch();
/* A skill this app installed and nobody edited follows the app's own copy on
   every start. Opt-in, and the installed desktop app is what opts in: a server
   started by a test or an isolated instance shares the real HOME, and must not
   write a person's skills directory. */
if (process.env.AGENTGLASS_SKILL_AUTOUPDATE === "1") {
  try { refreshSkill(); } catch { /* the pane's Install button is still there */ }
}
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
