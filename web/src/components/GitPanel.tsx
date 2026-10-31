// Live Source Control — agentglass's lazygit replacement. Working tree
// (stage/unstage/discard/commit), branches (checkout/create/delete), log
// (browse commits, view a commit's diff), and stash — all with the same diff
// renderer as the telemetry view.
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { diffSplit, diffWrap } from "../lib/diffPrefs.ts";
import { GIT_MODAL_TTL_MS, hasGitModal, subscribeGitModal, takeGitModal } from "../lib/gitModalIntent.ts";
import { conflictBriefing, conflictHandoff, opNoun } from "../lib/conflictBrief.ts";
import { remoteCompareRef } from "../lib/compareSeed.ts";
import { ConflictMode } from "./ConflictMode.tsx";
import { ContextMenu, MenuItem } from "./ContextMenu.tsx";
import { GitToast } from "./git/GitToast.tsx";
import { RebaseModal } from "./RebaseModal.tsx";
import { CompareModal } from "./CompareModal.tsx";
import { InsightsModal } from "./InsightsModal.tsx";
import { BlameModal } from "./BlameModal.tsx";
import { BisectModal } from "./BisectModal.tsx";
import { requestTermIssue } from "../lib/termIssue.ts";
import { useLiveWindow, openLiveWindow, followHandoff } from "../lib/liveWindow.ts";
import { useDismiss } from "../lib/useDismiss.ts";
import { viewHeaderClass, viewHeaderStyle } from "./workspace/ViewHeader.tsx";
import { Button, CHIP, RefreshButton, Segmented, Textarea, INPUT, INPUT_STYLE, EDGE, LINE } from "./workspace/Chrome.tsx";
import { ICON } from "../lib/iconSize.ts";
import { ArrowIcon, BranchIcon, ChartIcon, CommitIcon, CrossIcon, DoneIcon, FileIcon, IconLabel, ListIcon, MinusIcon, PlusIcon, RefreshIcon, SearchIcon, SparkleIcon, StashIcon, TargetIcon, TerminalIcon, TreeIcon, UndoIcon } from "../lib/glyphIcons.tsx";
import type { GitRepoRef, WorkingTree, GitFileChange, GitBranch, GitBranchInfo, GitStash, GitGraphLine, GitWorktree, WorktreeLeftovers, GitRemote, GitRemoteBranch, GitTag, GitReflogEntry, GitTagOrigin, ConflictBlock, BlockChoice, MergeInfo, FileChange, WalkthroughResult, WalkthroughFile, TidyReport, GitSubmodule, GitCommit } from "../../../shared/types.ts";
import { partitionByWorktree, splitReadable, goneConfirmTitle, goneConfirmBody, forcedDeletePrompt } from "../lib/goneCleanup.ts";
import { CheckoutPicker } from "./CheckoutPicker.tsx";
import { GitHeader, StateBanner, type SlotEntries } from "./GitHeader.tsx";
import { BasePicker } from "./BasePicker.tsx";
import { RescueModal } from "./RescueModal.tsx";
import { useGitDialogs } from "./GitDialogs.tsx";
import { api, IS_DEMO } from "../lib/api.ts";
import { refusalFinal, useCoverHold } from "../lib/cover.ts";
import { subscribeGitChanged } from "../lib/gitBus.ts";
import { HiliteCtx, useDiffHighlight } from "../lib/diffHighlight.ts";
import { usePoll } from "../lib/usePoll.ts";
import { worktreeTag } from "../lib/worktree.ts";
import { subscribeWorktreeJump, worktreeJump } from "../lib/worktreeJump.ts";
import { checkoutConfirm, needsCheckoutConfirm } from "../lib/checkoutWarning.ts";
import { buildFileTree, visibleRows, allDirPaths } from "../lib/fileTree.ts";
import { useIncremental } from "../lib/useIncremental.ts";
import { CommandLog } from "./CommandLog.tsx";
import { UnifiedDiff, SplitDiff, SCROLLBAR_CSS } from "./diff/DiffLines.tsx";
import { ThemePicker, Toggle, DiffSettingsLink } from "./diff/DiffControls.tsx";
import { changesetSig, readWalkCache, writeWalkCache } from "../lib/walkCache.ts";
import { PresetDiff } from "./diff/PresetDiff.tsx";
import { useSidebarWidth } from "../lib/sidebarWidth.ts";
import { SidebarGrip } from "./SidebarGrip.tsx";
import { CloseButton } from "./CloseButton.tsx";
import { GitRowMenu } from "./GitRowMenu.tsx";
import { GitPalette, type PaletteRow } from "./GitPalette.tsx";
import { Pill, inkOver } from "./git/ui.tsx";
import { RECENT_COUNT, goneBanner, sectionBranches } from "../lib/gitBranchList.ts";
import { orderPicked, isRunToTip, pickNumbers } from "../lib/orderPicked.ts";
import { commitEffect } from "../lib/commitActions.ts";
import { GitDock, DockIcon } from "./GitDock.tsx";
import { dockActionsFor, dockTarget, hunkActionsFor, toolbarFor, bulkDeleteView } from "../lib/gitDock.ts";
import {
  frameSentence, failToast, branchSelection, remoteSelection, tagSelection, notHereFirst, type BranchPick,
  submoduleSelection, worktreeSelection, stashSelection, stashClashes, unmergedPaths, refusedForSubmodule, forceRemoveAsk, putBackAsk,
} from "../lib/gitG4.ts";
import { BranchInspector, GoneBanner, OnlyBranchFrame, NameList } from "./git/BranchesFrames.tsx";
import { RemoteBranchInspector, NoRemoteFrame, remoteUrlLine } from "./git/RemotesFrames.tsx";
import { TagInspector, TagForm, TagOriginChip, NoTagsFrame } from "./git/TagsFrames.tsx";
import { SubmoduleInspector, NoSubmodulesFrame } from "./git/SubmodulesFrames.tsx";
import { WorktreeInspector } from "./git/WorktreesFrames.tsx";
import { StashInspector, NoStashesFrame, stashOverlap, type StashFiles } from "./git/StashesFrames.tsx";
import { TidyView } from "./git/TidyFrames.tsx";
import { CommitInspector, ReflogInspector, StateFrame, CleanFrame, ErrorFrame, ErrorBox, MONO, retryButton } from "./git/HistoryFrames.tsx";
import { PickBar } from "./git/PickBar.tsx";
import { pickedList } from "../lib/gitLogView.ts";
import { stashDetailTarget } from "../lib/stashDetail.ts";
import { ListSearch, LogToolbar, NothingMatches } from "./git/LogSearch.tsx";
import { useLogSearch } from "./git/useLogSearch.ts";
import { pathMatches, reflogMatches, searchEmpty } from "../lib/gitSearch.ts";
import { List, branchRows, remoteBranchRows, tagRows, stashRows, worktreeRows, submoduleRows, reflogRows, commitRows } from "./git/Lists.tsx";
import { primaryAction, actionsFor, bulkDeletable, pastTense, discardCommand, protectedRefusal, submoduleAddRefusal, BUSY_REASON, quoteRef, type GitKind, type GitRowState } from "../lib/gitActions.ts";
import { openPrs, openPr } from "../lib/openPrs.ts";
import { isScratchBranch, scratchNote } from "../lib/scratchBranch.ts";
import { chipTarget } from "../lib/chipTarget.ts";
import { openPeek } from "../lib/openPeek.ts";
import { groupHunks } from "../lib/changeGroups.ts";
import type { PrBranchSummary } from "../../../shared/types.ts";

const unifiedText = (c: GitFileChange) => c.hunks.map((h) => `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@\n${h.lines.join("\n")}`).join("\n");

type View = "changes" | "log" | "reflog" | "branches" | "remotes" | "tags" | "stashes" | "worktrees" | "tidy" | "submodules";


/**
 * Views, grouped the way lazygit groups its panels.
 *
 * The grouping isn't cosmetic — it's what `[` and `]` cycle through. Local
 * branches, remotes and tags are three readings of "refs", and commits and
 * reflog are two readings of "history", so each pair sits under one heading and
 * you tab between them rather than hunting along a row of eight equal buttons.
 */
const VIEW_GROUPS: { label: string; views: View[] }[] = [
  { label: "Files", views: ["changes"] },
  { label: "History", views: ["log", "reflog"] },
  { label: "Refs", views: ["branches", "remotes", "tags", "submodules"] },
  { label: "Worktrees", views: ["worktrees"] },
  { label: "Stash", views: ["stashes"] },
  // Last, and it earns the place: this is the tab you open when the others
  // have got long, which is the only time it has anything to say.
  { label: "Tidy", views: ["tidy"] },
];
const VIEW_LABEL: Record<View, string> = {
  changes: "Changes", log: "Log", reflog: "Reflog", branches: "Branches",
  remotes: "Remotes", tags: "Tags", stashes: "Stashes", worktrees: "Worktrees",
  tidy: "Tidy", submodules: "Submodules",
};
/** Left-to-right order — the order `[` / `]` walk, and the order the number
 *  keys index into. Derived from the groups so the two can't drift apart. */
const ALL_VIEWS: View[] = VIEW_GROUPS.flatMap((g) => g.views);
/**
 * `%(upstream:track)` → the three things it can mean.
 *
 * "[ahead 4, behind 53]" is the obvious one. "[gone]" is the one that matters
 * in practice: the upstream branch was deleted on the remote, which is what a
 * merged-and-tidied PR leaves behind. Reporting that as 0/0 makes a stale
 * branch look identical to a branch in perfect sync — and on a repo where most
 * work happens on ticket branches, that's most of the list lying.
 */
function trackChip(track: string): { ahead: number; behind: number; gone: boolean } {
  const a = track.match(/ahead (\d+)/), b = track.match(/behind (\d+)/);
  return { ahead: a ? +a[1] : 0, behind: b ? +b[1] : 0, gone: track.includes("gone") };
}

/**
 * A branch row, in the terms the action rules speak.
 *
 * The translation is here rather than in gitActions.ts on purpose: that file
 * knows what you may do to a branch and must not have to learn how this app
 * spells "gone" inside a raw `[ahead 4, behind 53]` string. `mergedIntoTrunk`
 * is deliberately read as "true only if true" — absent means there was no trunk
 * to compare against, which is not the same as not merged, and treating it as
 * false is what would offer Delete as the one-click action on a branch nobody
 * has merged anywhere.
 */
function branchState(b: GitBranch, isCurrent: boolean, elsewhere: boolean, busy?: boolean): GitRowState {
  const t = trackChip(b.track);
  return {
    current: isCurrent,
    gone: t.gone,
    ahead: t.ahead,
    behind: t.behind,
    upstream: !!b.upstream,
    elsewhere,
    merged: b.mergedIntoTrunk === true,
    busy,
  };
}
const wtName = (p: string) => p.split("/").pop() || p;

/** What git is mid-way through, when it's mid-way through anything. Worth its
 *  own colour: during a rebase or a merge most commit actions are unavailable
 *  and the only useful move is continue/abort, so the header has to say so
 *  rather than showing a branch name as if nothing were going on. */
const STATE_LABEL: Record<string, string> = {
  rebasing: "rebasing", merging: "merging", "cherry-picking": "cherry-picking",
  reverting: "reverting", bisecting: "bisecting",
};

const STATUS_TINT: Record<string, string> = {
  modified: "var(--info)", added: "var(--success)", deleted: "var(--error)",
  renamed: "var(--warning)", untracked: "var(--success)", copied: "var(--warning)",
  unmerged: "var(--error)", "type-changed": "var(--warning)",
};
const STATUS_LETTER: Record<string, string> = {
  modified: "M", added: "A", deleted: "D", renamed: "R", untracked: "U",
  copied: "C", unmerged: "!", "type-changed": "T",
};
const baseName = (p: string) => p.split("/").pop() || p;
// a file can be in BOTH staged & unstaged after partial staging — key by side.
const keyOf = (c: GitFileChange) => (c.staged ? "s:" : "u:") + c.file_path;
function dirName(p: string, root: string) {
  const rel = p.startsWith(root + "/") ? p.slice(root.length + 1) : p;
  const i = rel.lastIndexOf("/");
  return i >= 0 ? rel.slice(0, i) : "";
}

/**
 * The keys that work *right now*, along the bottom.
 *
 * lazygit's most underrated habit: the footer changes with the focused panel,
 * so the shortcuts you can use are always on screen and nobody has to memorise
 * a table. `?` opens the full list for whatever is focused.
 */
const VIEW_KEYS: Record<View, [string, string][]> = {
  changes: [["j/k", "file"], ["space", "stage"], ["x", "discard"], ["`", "tree/flat"], ["-/=", "fold"]],
  log: [["j/k", "commit"], ["c", "pick"], ["right-click", "menu"]],
  // Nothing to steer: the tab is a list of findings and a button per finding.
  tidy: [],
  reflog: [["j/k", "entry"]],
  branches: [["j/k", "branch"], ["space", "switch"], ["d", "delete"]],
  // `space` is the harmless one on purpose — see rowAction: checkout and
  // worktree both move something on disk and stay mouse-only.
  remotes: [["j/k", "branch"], ["space", "+ local"]],
  tags: [["j/k", "tag"]],
  submodules: [["j/k", "submodule"]],
  stashes: [["j/k", "stash"], ["space", "apply"], ["d", "drop"]],
  worktrees: [["j/k", "worktree"], ["space", "open"], ["d", "remove"]],
};

/**
 * Style + scroll behaviour for the row j/k is currently on.
 *
 * Spread onto any list row. Keeping it in one place is what stops the seven
 * lists from each inventing their own highlight, and the ref is what makes the
 * cursor usable at all: without scrolling it into view, holding `j` walks the
 * selection off the bottom of a 200-row reflog and you're following an
 * invisible cursor.
 */
/**
 * What a list pane shows when it has no rows.
 *
 * "no worktrees" is a claim about the repository, and these views made it while
 * the request was still in flight — so the answer to "does this repo have
 * worktrees" flipped from no to three a second later, and every slow tab looked
 * like an empty one. Nothing here is new information; it is the difference
 * between not knowing yet and knowing the answer is none.
 */
export type SortKey = "recent" | "name" | "track";

/**
 * The row's shape, in one place, because five tabs drawing "roughly the same
 * row" by hand is why they did not line up.
 *
 * A grid, not a flex row. The old row was flex with the subject as the only
 * flexible child and the action buttons appearing on hover — so hovering
 * *changed the width available to the text*, the subject reflowed under the
 * cursor, and on the selected row the buttons landed on top of the sentence
 * they had just squeezed. Nothing was overlapping in the CSS sense; the layout
 * was simply being recomputed by the pointer.
 *
 * Fixed tracks fix that: the action column is always allocated, whether or not
 * anything is drawn in it, so a row looks the same hovered and not. The cost is
 * a strip of empty space on the right of every row, and it is worth it — that
 * strip is what stops the list moving while you read it.
 */
const ROW_GRID = {
  display: "grid",
  // The NAME takes the flexible track, not the commit subject. It was the
  // other way round, which spent the wide column on "Merge remote-tracking
  // branch 'origin/…' into …" — the same sentence on half the rows — while
  // truncating the one thing you are scanning for. The subject keeps a
  // generous but capped lane and a tooltip for the rest.
  gridTemplateColumns: "14px minmax(0, 1fr) minmax(0, 30rem) auto var(--gitrow-actions, 0px)",
  alignItems: "center",
  columnGap: "0.5rem",
} as const;

/** Search, sort, and whatever chips the tab wants — one strip, one place.
 *
 *  The search is `autoFocus`-free on purpose: these tabs are reached by number
 *  keys and j/k, and stealing focus on every tab change would break that. */
function ListToolbar({ q, onQ, placeholder, sort, onSort, sorts, count, total, children, lead, bare }: {
  q: string; onQ: (v: string) => void; placeholder: string;
  sort?: SortKey; onSort?: (s: SortKey) => void; sorts?: { key: SortKey; label: string; title: string }[];
  count: number; total: number; children?: ReactNode;
  /**
   * What this tab creates — the new-branch field and its button, the snapshot
   * label, "+ new tag".
   *
   * It sits IN this strip rather than in one of its own above it. Every tab had
   * two rows of controls doing one job, which cost a row of height on each of
   * six tabs and made the panel read as two toolbars stacked. Reported as
   * "it can all go on one single line", and it can.
   */
  lead?: ReactNode;
  /** A list that is empty or failed has nothing to search or sort: only what creates stays. */
  bare?: boolean;
}) {
  return (
    <div className="flex items-center gap-2 mb-2 flex-wrap">
      {lead}
      {!bare && (
        <label className="relative min-w-0 flex-1 max-w-md flex items-center">
          <SearchIcon size={ICON.sm} className="absolute left-2.5 pointer-events-none" />
          <input
            value={q}
            onChange={(e) => onQ(e.target.value)}
            placeholder={placeholder}
            className={`min-w-0 w-full ${INPUT}`}
            style={{ ...INPUT_STYLE, paddingLeft: 30 }}
          />
        </label>
      )}
      {!bare && sorts && sort && onSort && (
        <Segmented track label="Sort" value={sort} onChange={onSort} options={sorts.map((s) => ({ id: s.key, label: s.label, title: s.title }))} />
      )}
      {!bare && children}
      {/* Says what the filter did. A list that silently shrinks reads as data
          that went missing. */}
      {!bare && q.trim() !== "" && (
        <span className="text-[9.5px] t-dim2 shrink-0 tabular-nums">{count} of {total}</span>
      )}
    </div>
  );
}

function PaneEmpty({ busy, what }: { busy: boolean; what: string }) {
  return (
    <div className="grid place-items-center py-10 t-dim2 text-[12px]">
      {busy
        ? <span className="flex items-center gap-2"><span className="agx-spin" aria-hidden="true" />Loading {what}…</span>
        : <>No {what}</>}
    </div>
  );
}

const rowProps = (active: boolean) => ({
  ref: active
    ? (el: HTMLDivElement | null) => el?.scrollIntoView({ block: "nearest" })
    : undefined,
  style: active
    ? { background: "color-mix(in srgb, var(--primary) 15%, transparent)", outline: "1px solid color-mix(in srgb, var(--primary) 35%, transparent)" }
    : undefined,
});

/** Keys that work everywhere, listed after the view's own in the `?` sheet. */
const GLOBAL_KEYS: [string, string][] = [
  ["1 – 8", "jump straight to a tab (the number is on it)"],
  ["[ ]", "previous / next tab"],
  ["j / k", "move down / up"],
  ["R", "refresh (does not fetch)"],
  ["@", "show or hide the command log"],
  ["?", "this list"],
  ["esc", "close"],
];

/**
 * The contextual key sheet, on `?`.
 *
 * The single most valuable thing lazygit does for discoverability: rather than
 * expecting anyone to learn a table, the panel tells you what it can do right
 * now. Everything here is also reachable with the mouse — this is a reference,
 * not a hidden second interface.
 */
function HelpSheet({ view, onClose }: { view: View; onClose: () => void }) {
  const rows = (keys: [string, string][]) => keys.map(([k, label]) => (
    <div key={k} className="flex items-baseline gap-3 py-0.5">
      <kbd className="shrink-0 text-[10px] px-1.5 py-0.5 rounded font-mono" style={{ minWidth: 54, textAlign: "center", background: "color-mix(in srgb, var(--bg3) 60%, transparent)", border: EDGE, color: "var(--text)" }}>{k}</kbd>
      <span className="text-[11px]" style={{ color: "var(--text2)" }}>{label}</span>
    </div>
  ));
  return (
    <div onClick={onClose} className="absolute inset-0 grid place-items-center" style={{ zIndex: 50, background: "color-mix(in srgb, #000 55%, transparent)" }}>
      <div onClick={(e) => e.stopPropagation()} className="rounded-xl px-5 py-4 shadow-2xl" style={{ minWidth: 420, background: "var(--surface-card)", border: EDGE }}>
        <div className="flex items-center gap-2 mb-3">
          <span className="text-[12px] font-semibold" style={{ color: "var(--text)" }}>Keys</span>
          <span className="text-[10px] px-1.5 py-0.5 rounded" style={{ background: "color-mix(in srgb, var(--primary) 14%, transparent)", color: "var(--primary-hover)" }}>{VIEW_LABEL[view]}</span>
          <CloseButton onClick={onClose} className="ml-auto" />
        </div>
        {rows(VIEW_KEYS[view])}
        <div className="my-2.5 h-px" style={{ background: "color-mix(in srgb, var(--border) 35%, transparent)" }} />
        {rows(GLOBAL_KEYS)}
        <div className="mt-3 text-[9.5px] t-dim2 leading-snug">
          Every one of these is a button too — the keyboard is a shortcut, not a second interface.
        </div>
      </div>
    </div>
  );
}

function ShortcutBar({ view, logOpen, onToggleLog, editorName }: { view: View; logOpen: boolean; onToggleLog: () => void; editorName?: string | null }) {
  /* Advertised whenever there is a file to open: it opens the app's own editor
     pane now rather than shouting at an nvim somewhere else, so it no longer
     depends on this machine having one running. `editorName` still gates it —
     a machine with no editor at all has nothing to open the pane with. */
  const keys: [string, string][] = view === "changes" && editorName
    ? [...VIEW_KEYS.changes.slice(0, 2), ["e", "open it here"], ...VIEW_KEYS.changes.slice(2)]
    : VIEW_KEYS[view];
  return (
    <div className="shrink-0 px-4 py-1 border-t text-[9.5px] t-dim2 flex items-center gap-3" style={{ borderColor: "color-mix(in srgb, var(--border) 40%, transparent)" }}>
      {keys.map(([k, label]) => (
        <span key={k}><b className="font-semibold" style={{ color: "var(--text2)" }}>{k}</b> {label}</span>
      ))}
      <span><b className="font-semibold" style={{ color: "var(--text2)" }}>[ ]</b> tab</span>
      <span><b className="font-semibold" style={{ color: "var(--text2)" }}>1–8</b> jump</span>
      <span className="ml-auto flex items-center gap-3">
        <button onClick={onToggleLog} className="hover:opacity-80" style={{ color: logOpen ? "var(--text2)" : undefined }}>
          <b className="font-semibold">@</b> command log
        </button>
        <span><b className="font-semibold" style={{ color: "var(--text2)" }}>?</b> all keys</span>
      </span>
    </div>
  );
}

/** "Showing 60 of 787" — without it, a windowed list reads as a list that lost
 *  rows. The button is there for the rare case you genuinely want them all. */
function MoreRows({ shown, total, onAll }: { shown: number; total: number; onAll: () => void }) {
  if (shown >= total) return null;
  return (
    <div className="flex items-center gap-2 px-2.5 py-2 text-[10px] t-dim2">
      <span className="tabular-nums">showing {shown} of {total}</span>
      <button onClick={onAll} className="px-1.5 py-0.5 rounded" style={{ color: "var(--text2)", border: EDGE }}>show all</button>
      <span className="t-dim2">· scroll for more</span>
    </div>
  );
}

/** A directory in tree mode. Clicking anywhere on it folds it — the whole row
 *  is the target, because a 10px chevron is a miserable thing to aim at. */
function DirRow({ name, depth, count, collapsed, onToggle }: {
  name: string; depth: number; count: number; collapsed: boolean; onToggle: () => void;
}) {
  return (
    <div onClick={onToggle} className="flex items-center gap-1.5 py-0.5 rounded-md cursor-pointer select-none hover:opacity-80"
      style={{ paddingLeft: 8 + depth * 12 }}>
      {/* Drawn and rotated rather than two typed characters. A 10px ▶ is a
          speck: the same finding that took the ▾ out of the notification rows
          and out of the git group headings. */}
      <svg width={ICON.xs} height={ICON.xs} viewBox="0 0 12 12" fill="none" aria-hidden
        className="shrink-0" style={{ color: "var(--text4)", transform: collapsed ? "rotate(-90deg)" : "none", transition: "transform .12s" }}>
        <path d="M2.5 4.5L6 8l3.5-3.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <span className="text-[11px] truncate" style={{ color: "var(--text2)" }}>{name}</span>
      {/* Only meaningful while folded — otherwise you can just count the rows. */}
      {collapsed && <span className="text-[10px] tabular-nums t-dim2">{count}</span>}
    </div>
  );
}

function FileRow({ c, root, active, desc, onSelect, onBlame, onMenu, depth, ticked, onTick }: {
  c: GitFileChange; root: string; active: boolean; desc?: string; onSelect: () => void;
  /** The row's tick box, for acting on several files at once. */
  ticked?: boolean; onTick?: () => void;
  /** Right-click a row for its file's blame — who wrote each line. */
  onBlame?: () => void;
  /** The row menu, when there is one. Supersedes `onBlame` on right-click:
   *  blame is one item inside it now, next to discard and the file's history. */
  onMenu?: (x: number, y: number) => void;
  /** Set in tree mode; the directory rows above carry the path, so the row
   *  indents instead of repeating it. Undefined means the old flat list. */
  depth?: number;
}) {
  const dir = dirName(c.file_path, root);
  return (
    <div onClick={onSelect} data-file={active ? "active" : undefined}
      onContextMenu={onMenu ? (e) => { e.preventDefault(); onSelect(); onMenu(e.clientX, e.clientY); } : onBlame ? (e) => { e.preventDefault(); onBlame(); } : undefined}
      // A card, like every other row in this view: a status rail in the file's
      // own colour, the name at the size the eye lands on, and the counts and
      // the action in a lane that cannot be grown into. The status LETTER stays
      // — in a file list it is the fastest read there is — but it sits on the
      // rail rather than floating in a column of its own.
      className="flex items-center gap-2 pr-2 py-1.5 rounded-lg cursor-pointer transition-colors" title={c.file_path}
      style={{
        background: active ? "color-mix(in srgb, var(--primary) 14%, transparent)" : "color-mix(in srgb, var(--bg3) 26%, transparent)",
        border: `1px solid ${active ? "color-mix(in srgb, var(--primary) 40%, transparent)" : "color-mix(in srgb, var(--text) 6%, transparent)"}`,
        // The same rail every other card in this view has, in the file's own
        // status colour: added, modified, deleted, conflicted read down the
        // left edge without touching the letter beside them.
        borderLeft: `3px solid ${STATUS_TINT[c.status]}`,
        marginBottom: 4,
        boxShadow: active ? "0 6px 16px -12px rgba(0,0,0,.8)" : "none",
        paddingLeft: depth == null ? 8 : 8 + depth * 12,
      }}>
      {onTick && (
        <input type="checkbox" checked={!!ticked} onChange={onTick} onClick={(e) => e.stopPropagation()}
          aria-label={`Pick ${baseName(c.file_path)}`} className="shrink-0 self-start mt-0.5 accent-[var(--primary)]" />
      )}
      <span className="w-4 text-center text-[10px] font-bold shrink-0 self-start mt-0.5 rounded"
        style={{ color: STATUS_TINT[c.status], background: `color-mix(in srgb, ${STATUS_TINT[c.status]} 14%, transparent)` }}
        title={c.status}>{STATUS_LETTER[c.status]}</span>
      <span className="min-w-0 flex-1 truncate">
        <span className="block truncate text-[11.5px]" style={{ color: active ? "var(--text)" : "var(--text2)" }}>
          {/* In tree mode the directory is already spelled out by the rows
              above, so repeating it here is noise on every single line. */}
          {baseName(c.file_path)}{depth == null && dir && <span className="t-dim2 text-[9.5px] ml-1.5">{dir}</span>}
        </span>
        {/* Its own line, not the path's: set tight and 9.5px it read as the
            filename wrapping onto a second line. */}
        {desc && <span className="block truncate text-[10px] leading-normal t-dim2 mt-0.5" title={desc}>{desc}</span>}
      </span>
      <span className="shrink-0 self-start mt-0.5 text-[9.5px] tabular-nums flex items-center gap-1 opacity-80">
        {c.additions > 0 && <span style={{ color: "var(--success-ink)" }}>+{c.additions}</span>}
        {c.deletions > 0 && <span style={{ color: "var(--error-ink)" }}>−{c.deletions}</span>}
      </span>
    </div>
  );
}

function Section({ title, count, tint, action, onAll, children }: { title: string; count: number; tint: string; action?: string; onAll?: () => void; children: React.ReactNode }) {
  return (
    <div className="mb-1">
      <div className="flex items-center gap-2 px-2 py-1 sticky top-0 z-10" style={{ background: "var(--surface-card)" }}>
        <span className="w-1.5 h-1.5 rounded-full" style={{ background: tint }} />
        <span className="text-[10px] uppercase tracking-wider font-semibold" style={{ color: "var(--text2)" }}>{title}</span>
        <span className="text-[9.5px] t-dim2 tabular-nums">{count}</span>
        <span aria-hidden className="flex-1 h-px" style={{ background: "color-mix(in srgb, var(--text) 8%, transparent)" }} />
        {action && count > 0 && onAll && <button onClick={onAll} className="text-[10px] px-1.5 py-0.5 rounded hover:underline" style={{ color: "var(--text3)" }}>{action}</button>}
      </div>
      <div className="px-1">{children}</div>
    </div>
  );
}

/** Source control as a workspace view.
 *
 *  Staying mounted while hidden is worth more here than anywhere else: the
 *  commit message drafts (`title`/`body`) used to be destroyed every time you
 *  looked at something else, which is precisely what you do before committing. */

/**
 * One conflict at a time, with both sides side by side.
 *
 * Every block must be answered before this applies anything. Defaulting the
 * ones nobody looked at to "ours" is exactly the silent loss this screen exists
 * to prevent, so unanswered blocks are counted and the button stays disabled
 * rather than quietly choosing for you.
 */
function BlockResolver({ blocks, error, picks, onPick, onApply, busy }: {
  blocks: ConflictBlock[] | null;
  error: string | null;
  picks: Record<number, BlockChoice>;
  onPick: (i: number, c: BlockChoice) => void;
  onApply: () => void;
  busy: boolean;
}) {
  if (error) return <div className="text-[10.5px] px-2 py-1.5 rounded" style={{ color: "var(--warning-ink)", background: "color-mix(in srgb, var(--warning) 10%, transparent)" }}>{error}</div>;
  if (!blocks) return <div className="text-[10.5px] t-dim2 flex items-center gap-2 px-2 py-1.5"><span className="agx-spin" aria-hidden="true" />Reading the file…</div>;
  if (!blocks.length) return <div className="text-[10.5px] t-dim2 px-2 py-1.5">No conflict markers left in this file</div>;

  const left = blocks.filter((b) => !picks[b.index]).length;
  const Side = ({ label, lines, tone }: { label: string; lines: string[]; tone: string }) => (
    <div className="min-w-0 flex-1">
      <div className="text-[10px] mb-0.5 truncate" style={{ color: tone }}>{label}</div>
      <pre className="text-[10px] leading-[1.5] px-1.5 py-1 rounded overflow-x-auto agx-scroll m-0"
        style={{ background: "color-mix(in srgb, var(--bg) 60%, transparent)", color: "var(--text2)", maxHeight: 160 }}>
        {lines.length ? lines.join("\n") : "(Nothing — this side removes these lines)"}
      </pre>
    </div>
  );

  return (
    <div className="flex flex-col gap-2 pl-2 pb-1" style={{ borderLeft: LINE }}>
      {blocks.map((b) => {
        const chosen = picks[b.index];
        const Opt = ({ id, label }: { id: BlockChoice; label: string }) => (
          <button onClick={() => onPick(b.index, id)} disabled={busy}
            className="px-1.5 py-0.5 rounded text-[9.5px] shrink-0"
            style={chosen === id
              ? { color: "var(--primary-hover)", background: "color-mix(in srgb, var(--primary) 16%, transparent)", border: "1px solid color-mix(in srgb, var(--primary) 45%, transparent)" }
              : { color: "var(--text3)", border: EDGE }}>
            {label}
          </button>
        );
        return (
          <div key={b.index} className="flex flex-col gap-1">
            <div className="flex items-center gap-1.5">
              <span className="text-[9.5px] t-dim2 tabular-nums shrink-0">line {b.line}</span>
              <div className="flex items-center gap-1 ml-auto">
                <Opt id="ours" label="Ours" />
                <Opt id="theirs" label="Theirs" />
                <Opt id="both" label="Both" />
                <Opt id="theirs-first" label="Both \u21c5" />
              </div>
            </div>
            <div className="flex gap-2">
              <Side label={b.ourLabel} lines={b.ours} tone="var(--success)" />
              {/* Only when git recorded one: with the default conflict style
                  there is no ancestor, and an empty column would read as "the
                  base was empty" rather than "not recorded". */}
              {b.base && <Side label="Base" lines={b.base} tone="var(--text3)" />}
              <Side label={b.theirLabel} lines={b.theirs} tone="var(--info)" />
            </div>
          </div>
        );
      })}
      <div className="flex items-center gap-2">
        <span className="text-[9.5px] t-dim2">{left ? `${left} still to choose` : "Every conflict answered"}</span>
        <button onClick={onApply} disabled={busy || left > 0}
          className="ml-auto px-2 py-0.5 rounded text-[10px] font-medium"
          style={{ color: "var(--success-ink)", border: "1px solid color-mix(in srgb, var(--success) 40%, transparent)", opacity: left ? 0.4 : 1 }}
          title={left ? "Choose a side for every conflict first" : "Write these choices and stage the file"}>
          Apply and stage
        </button>
      </div>
    </div>
  );
}

export function GitView({ active }: { active: boolean }) {
  /** A modal asked for through /control while this view is not on screen. The
   *  view then loads its checkout and lists as if it were open, for as long as
   *  the modal is up, and nothing else: the person stays on the view they were
   *  on. See lib/gitModalIntent.ts. */
  const [asked, setAsked] = useState(hasGitModal);
  const open = active || asked;
  const sidebarW = useSidebarWidth();
  const [repos, setRepos] = useState<GitRepoRef[]>([]);
  const [reposError, setReposError] = useState<string | null>(null);
  const [root, setRoot] = useState<string>("");
  // A worktree jump from the Terminal chrome scopes this panel to the chosen
  // checkout. Every view stays mounted, so this subscription is always live —
  // the jump lands whether or not Source control was the view on screen. Served
  // once per request `n`; the root init below is `cur || first`, so this never
  // fights it.
  const wtJump = useSyncExternalStore(subscribeWorktreeJump, worktreeJump);
  const wtJumpServed = useRef(0);
  useEffect(() => {
    if (wtJump && wtJump.view === "git" && wtJump.root && wtJump.n !== wtJumpServed.current) {
      wtJumpServed.current = wtJump.n;
      setRoot(wtJump.root);
      if (wtJump.tab) setView(wtJump.tab);
    }
  }, [wtJump]);
  const [tree, setTree] = useState<WorkingTree | null>(null);
  const [protectedBranches, setProtectedBranches] = useState<string[]>([]);
  /** The first read of the tree has come back, one way or the other. */
  const [treeRead, setTreeRead] = useState(false);
  /** Why the working tree could not be read; the Changes pane offers Try again. */
  const [treeFail, setTreeFail] = useState<string | null>(null);
  // Which root the tree on screen belongs to. When it isn't the current root,
  // the header (branch, sync-behind count, push/pull state) is still showing the
  // worktree you just switched away from — so the group can say it is recomputing
  // instead of presenting the old numbers as if they were the new ones.
  const [treeFor, setTreeFor] = useState("");
  const [view, setView] = useState<View>("changes");
  const [selKey, setSelKey] = useState<string | null>(null);
  // Ticked rows (Changes): one list at a time, so the dock offers Stage or Unstage, not both.
  const [ticked, setTicked] = useState<ReadonlySet<string>>(new Set());
  const [lastCommit, setLastCommit] = useState<GitCommit | null>(null);
  const [split, setSplit] = useState(diffSplit);
  const [wrap, setWrap] = useState(diffWrap);
  const [title, setTitle] = useState("");
  /** Set while the commit box is rewriting the tip instead of adding a commit. */
  const [amend, setAmend] = useState<{ hash: string } | null>(null);
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<{ ok: boolean; msg: string } | null>(null);
  // The panel's own confirm/prompt. window.confirm renders in OS chrome, reads
  // as somebody else's dialog next to our modals, and blocks the JS thread so
  // nothing can show progress while it is up.
  const { ask, askText, dialog } = useGitDialogs();
  /**
   * One search box and one sort, shared by every list tab.
   *
   * Shared rather than per-tab state because the question is the same on all of
   * them — "where is the row about ORBIT-1042" — and a repo with 54 branches,
   * 23 worktrees, 127 tags and 22 stashes is a repo where scrolling to find one
   * is the whole cost of the panel. Cleared on a tab or repo change: a filter
   * still applied to a list you are no longer looking at is an empty pane with
   * no visible reason.
   */
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<SortKey>("recent");
  // branches / log / stashes / worktrees
  const [branchData, setBranchData] = useState<{ current: string; branches: GitBranch[]; trunk?: string | null; checking?: boolean }>({ current: "", branches: [] });
  const [newBranch, setNewBranch] = useState("");
  const [graph, setGraph] = useState<GitGraphLine[]>([]);
  const [stashes, setStashes] = useState<GitStash[]>([]);
  /** The partial-stash picker: open, selected files, keep-index. Files are
   *  picked from the working tree's unstaged set (the stash moves work off the
   *  tree, so there is nothing to pick once it is gone). */
  const [partialOpen, setPartialOpen] = useState(false);
  const [partialSel, setPartialSel] = useState<ReadonlySet<string>>(new Set());
  const [partialKeep, setPartialKeep] = useState(false);
  const [worktrees, setWorktrees] = useState<GitWorktree[]>([]);
  const [tidy, setTidy] = useState<TidyReport | null>(null);
  /** The right-click menu on a commit row: what was clicked, where. */
  /** The base of the interactive rebase in flight, or null when closed. */
  const [rebaseBase, setRebaseBase] = useState<string | null>(null);
  /** The branch a compare dialog is open on, or null when closed. */
  const [compareTarget, setCompareTarget] = useState<string | null>(null);
  /** Set when the compare is against the files on disk, not a second ref. */
  const [compareAgainst, setCompareAgainst] = useState<"worktree" | undefined>(undefined);
  const [bisectFrom, setBisectFrom] = useState<string | undefined>(undefined);
  /** Whether the insights modal is open. */
  const [insightsOpen, setInsightsOpen] = useState(false);
  const [bisectOpen, setBisectOpen] = useState(false);
  /**
   * Commits picked out of the log for a series cherry-pick — hashes, in the
   * order the user picked them. Empty when nothing is picked.
   *
   * The selection is deliberately not the keyboard cursor: picking a spread of
   * commits across a long history (or a `-n` staging pass) must survive moving
   * around and re-reading the log.
   */
  const [pickSet, setPickSet] = useState<ReadonlySet<string>>(new Set());
  /** The rescue prompt, and the promise deleteHeldByWorktrees() is parked on
   *  while it is open. Null means no prompt; resolving with null is a cancel. */
  const [rescue, setRescue] = useState<{ reports: WorktreeLeftovers[]; resolve: (v: Map<string, string[]> | null) => void; progress?: string } | null>(null);
  const [remotes, setRemotes] = useState<GitRemote[]>([]);
  /** The remote whose branches the pane is listing, and that list. Empty until
   *  the first answer names one — the server picks the only/first remote when
   *  we ask without one, so there is no guess to make here. */
  const [remoteSel, setRemoteSel] = useState("");
  const [remoteRows, setRemoteRows] = useState<GitRemoteBranch[]>([]);
  const [remoteQuery, setRemoteQuery] = useState("");
  const [tags, setTags] = useState<GitTag[]>([]);
  const [reflog, setReflog] = useState<GitReflogEntry[]>([]);
  /** The reflog is switched off for this repository (core.logAllRefUpdates=false). */
  const [reflogOff, setReflogOff] = useState(false);
  /** Why the Log or the Reflog could not be read; each frame offers Try again. */
  const [histFail, setHistFail] = useState<string | null>(null);
  /** Why the Branches, Remotes or Tags list could not be read. Raw text goes to the console, never the frame. */
  const [viewFail, setViewFail] = useState<string | null>(null);
  const [tagFormOpen, setTagFormOpen] = useState(false);
  /** Whether each tag is on a remote. `asked` is false for a repository with no remote: nothing was asked, no chip. */
  const [tagOrigins, setTagOrigins] = useState<{ asked: boolean; list: GitTagOrigin[] }>({ asked: false, list: [] });
  const [submodules, setSubmodules] = useState<GitSubmodule[]>([]);
  // Worktrees git refused to remove over a submodule: only these draw "Remove anyway".
  const [wtRefused, setWtRefused] = useState<ReadonlySet<string>>(new Set());
  // The stash this panel last applied, and the file list of the one picked.
  const [appliedStash, setAppliedStash] = useState<string | undefined>();
  const [stashFiles, setStashFiles] = useState<{ hash: string; files: StashFiles } | null>(null);
  /** WIP snapshots — named checkpoints that never touch the tree. */
  const [snapshots, setSnapshots] = useState<{ sha: string; ref: string; time: string; label: string }[]>([]);
  const [snapshotLabel, setSnapshotLabel] = useState("");
  /**
   * Whose history the Log shows: this checkout's own, or every branch.
   *
   * Remembered across sessions because it is a preference, not a mode you set
   * per visit — and defaulted to the branch you are standing on, which is the
   * answer to "what have I been doing" that the pane is usually asked.
   */
  const [logScope, setLogScope] = useState<"head" | "all">(() => {
    try { return localStorage.getItem("agx_git_log_scope") === "all" ? "all" : "head"; } catch { return "head"; }
  });
  useEffect(() => { try { localStorage.setItem("agx_git_log_scope", logScope); } catch { /* private mode */ } }, [logScope]);
  /** The branch the log was read from, as the server saw it — so the pane can
   *  name it rather than leave you to infer it from the commits. */
  const [graphBranch, setGraphBranch] = useState("");
  /** Which view has a request in flight, so "still loading" and "genuinely
   *  empty" stop rendering as the same blank pane. */
  const [busyView, setBusyView] = useState<View | null>(null);
  /** Files git has stopped on. Only ever non-empty mid-merge. */
  const [conflicts, setConflicts] = useState<string[]>([]);
  // False until the list for this stop has been read: an empty list that has not
  // arrived must not read as "0 conflicted files, ready to continue".
  const [conflictsLoaded, setConflictsLoaded] = useState(false);
  // The file whose blocks are open, and the choice made for each. Held here
  // rather than in a child so closing the file and reopening it starts clean —
  // a half-made set of choices restored from before is worse than none.
  const [blockFile, setBlockFile] = useState<string | null>(null);
  const [blocks, setBlocks] = useState<ConflictBlock[] | null>(null);
  const [blockErr, setBlockErr] = useState<string | null>(null);
  const [picks, setPicks] = useState<Record<number, BlockChoice>>({});

  const openBlocks = useCallback(async (rel: string) => {
    if (blockFile === rel) { setBlockFile(null); setBlocks(null); return; }
    setBlockFile(rel); setBlocks(null); setBlockErr(null); setPicks({});
    const r = await api.gitConflictBlocks(root, rel);
    if (!r.ok) { setBlockErr(r.error || "cannot read that file"); return; }
    setBlocks(r.blocks);
  }, [root, blockFile]);

  /** Local heads and remote-tracking refs, for the "measure against…" lists.
   *  One repo's refs serve every base picker on screen — the header's and one
   *  per worktree row — because a worktree family shares its refs. */
  const [baseRefs, setBaseRefs] = useState<{ name: string; remote: boolean }[]>([]);
  const [baseRefsError, setBaseRefsError] = useState<string | null>(null);
  /*
   * The tree that is on screen belongs to a root, and until this read said so
   * it was trusted for whichever root you had just switched to.
   *
   * `loadTree` is async and records the root it answered for in `treeFor`. The
   * conflict screen keys off this value, so between switching worktree and the
   * new tree arriving, a conflict belonging to the checkout you LEFT was drawn
   * over the one you opened — reported as the resolver appearing "for every
   * worktree/branch", with the file list beside it reading "nothing to commit,
   * working tree clean" because that half had already caught up.
   *
   * A tree from somewhere else is not evidence about here, so it reads clean
   * until the right one lands. Clean is the safe default: the worst it does is
   * show the ordinary strip for one refresh, where the alternative locks the
   * panel into a conflict screen for a repository that has none.
   */
  const mergeState = treeFor === root ? (tree?.branch.state ?? "clean") : "clean";
  /**
   * Which two sides git has stopped between, as git has them — not as the
   * checkout's base branch suggests.
   *
   * Read alongside the conflict list because everything downstream needs it:
   * the band labels, the handoff prompt, and whether this operation replays a
   * series. The deduction it replaces names the wrong ref for any merge that
   * is not of your own base, and the wrong commit for every rebase.
   */
  const [merge, setMerge] = useState<MergeInfo | null>(null);
  /**
   * Git has stopped, and there is a decision to make.
   *
   * Bisecting is excluded deliberately: it is a stopped state with no two
   * sides to choose between, so the conflict screen would have nothing to
   * show. It keeps the old strip, which offers the one thing it needs (reset).
   */
  const inConflict = mergeState !== "clean" && mergeState !== "bisecting";
  useEffect(() => {
    // `treeFor` for the same reason as `mergeState` above: asking the server
    // about a root whose tree has not arrived yet answers about the wrong one.
    if (!open || !root || treeFor !== root || mergeState === "clean") {
      setConflicts([]);
      setConflictsLoaded(false);
      setMerge(null);
      /*
       * AND CLOSE THE EDITOR, because the conflict it is editing is gone.
       *
       * `blockFile` was only ever cleared by its own close button or by
       * applying — so a merge that ended UNDERNEATH it (an abort, a branch
       * change, somebody resolving it in a terminal) left the three-way editor
       * open over a file that no longer conflicts. Reported plainly: "it stays
       * sort of stuck… no matter which branch I switch to".
       *
       * It is a real stuck state, not a cosmetic one: the editor is drawn
       * instead of the changes list, so the panel stops being usable for
       * anything else until the tab is reloaded.
       */
      setBlockFile(null);
      setBlocks(null);
      setPicks({});
      setBlockErr(null);
      return;
    }
    api.gitConflicts(root).then((r) => { setConflicts(r.files ?? []); setConflictsLoaded(true); }).catch(() => {});
    api.gitMergeInfo(root).then((r) => setMerge(r.ok ? r : null)).catch(() => {});
  }, [open, root, treeFor, mergeState, tree]);

  /**
   * Hand the conflict to Claude, in the repo it happened in.
   *
   * The expensive part of a conflict is understanding two intents well enough
   * to reconcile them, which is the one thing an agent sitting in this repo is
   * genuinely good at — and the chat already runs `claude` in a given cwd, so
   * this is a prompt and a tab rather than a feature.
   */
  /** The prompt both handoffs send. Written once: the briefing is the valuable
   *  part, and two copies of it would drift. */
  const conflictPrompt = () => {
    const rels = conflicts.map((p) => p.startsWith(root) ? p.slice(root.length + 1) : p);
    const ref = repos.find((r) => r.root === root);
    return conflictHandoff(
      conflictBriefing(root, tree?.branch, ref, mergeState, rels, merge),
      () => api.prConflictPrompt({ worktree: root, files: rels, branch: tree?.branch?.name, base: tree?.branch?.base ?? undefined }),
    );
  };

  /**
   * Hand the conflict to an agent in a terminal.
   *
   * A tmux window gives you the session itself, attached, beside your other
   * shells — where you can watch it edit and take the keyboard off it.
   */
  // The prompt is fetched first and can take a moment; without this a second
  // press in that window opened a second tab.
  const handing = useRef(false);
  /* Asked of the engine: while Claude is working in this checkout's "conflicts"
     window the button opens that tab instead of starting a second Claude. */
  const conflictWindow = useLiveWindow(root, "conflicts", root);
  const askClaudeInTerminal = async () => {
    if (conflictWindow) { void openLiveWindow(conflictWindow); return; }
    if (handing.current) return;
    handing.current = true;
    const h = await conflictPrompt().catch((e) => { handing.current = false; throw e; });
    const done = await requestTermIssue(root, "conflicts", h.prompt, true, false, "", h.model, h.effort, true).finally(() => { handing.current = false; });
    // It opens a tmux window somewhere you are not looking, and until this said
    // so the button read as broken: it worked perfectly, silently, and people
    // pressed it again. It says what the terminal answered, not what was asked.
    if (done.ok) flash(true, done.reused
      ? `Claude is already working in "conflicts" — switched to its tab instead of starting another`
      : `Claude is on it in a tmux window — "conflicts", in ${repoRef?.name ?? "this repo"}`);
    else flash(false, `Claude was not started: ${done.error}`);
    // The point of a tmux window is to watch the agent edit; the resolver stays
    // mounted behind and re-reads when the person comes back to it.
    void followHandoff(done, () => api.tmuxLiveWindow(root, "conflicts", root).then((r) => (r.ok ? r.window ?? null : null)));
  };

  // Only the branches whose upstream is gone — the merged-and-tidied ones. Off
  // by default: it's a cleanup mode, not a way to read the branch list.
  // Tree by default, as lazygit does — a change spread across one module reads
  // as a shape rather than as thirty near-identical paths.
  const [treeMode, setTreeMode] = useState(true);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [logOpen, setLogOpen] = useState(false);
  /** Mid-merge: whether the four hundred files the merge brought are on screen.
   *  Off, because they are not what you came for — and they come back on their
   *  own once the conflict is gone. */
  const [mergeRest, setMergeRest] = useState(false);
  // Whether this machine can edit at all. Probed once on open — a key that is
  // advertised and then fails with "command not found" is worse than a key that
  // was never offered.
  const [editor, setEditor] = useState<{ hasNvim: boolean; editor: string | null } | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  // Names the action currently running, so its own button can say so. `busy`
  // alone only knows that *something* is running, which is why every button
  // greyed out together and none of them explained why.
  const [pending, setPending] = useState<string | null>(null);
  /**
   * Cursor for the list views — everything except Changes, which has its own
   * selection keyed by file path because staging reorders rows under it.
   *
   * One index shared across views rather than one per view: they're never on
   * screen together, and remembering a position in a list you left is a good way
   * to come back to a highlighted row you didn't choose.
   */
  const [rowIdx, setRowIdx] = useState(0);
  /**
   * The row whose right-click menu is open.
   *
   * It carries its own `run` rather than a discriminated union of every row
   * type this panel lists. The alternative — one payload shape per kind and a
   * switch over them here — puts the knowledge of what a tag is next to the
   * knowledge of what a stash is, in a component that is already 3,500 lines.
   * This way each section hands over a closure that already knows its object,
   * and this state stays one shape.
   */
  const [rowMenu, setRowMenu] = useState<
    { kind: GitKind; name: string; state: GitRowState; x: number; y: number; run: (id: string) => void } | null
  >(null);
  /** ⌘K. Off by default and never restored from storage: a palette that was
   *  open when you last closed the view is a palette in your way. */
  const [paletteOpen, setPaletteOpen] = useState(false);
  /** Folded prefix groups, by prefix. Empty string is the no-prefix pile.
   *  Named for the groups rather than "collapsed" because this file already has
   *  a `collapsed` — the file tree's — and two of those in one component is how
   *  the wrong one gets read. */
  const [groupsClosed, setGroupsClosed] = useState<Set<string>>(new Set());
  /** Branches ticked for a bulk action, by name. Cleared whenever the list
   *  underneath changes meaning — a selection that survives a filter is a
   *  selection you cannot see. */
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [newWtBranch, setNewWtBranch] = useState("");
  const [commitView, setCommitView] = useState<{ changes: FileChange[]; title: string } | null>(null);
  const [blamePath, setBlamePath] = useState<{ path: string } | null>(null);
  // A modal asked for through /control (lib/gitModalIntent.ts). Not before there
  // is a checkout for it to be about: draining at mount would spend the one slot
  // on a modal with no repository and leave nothing to retry when one arrived.
  useEffect(() => {
    if (!root) return;
    const run = () => {
      const m = takeGitModal();
      if (!m) return;
      // The pane the agent was in, not the checkout this view last showed.
      if (m.root) setRoot(m.root);
      if (m.which === "insights") setInsightsOpen(true);
      else if (m.which === "bisect") setBisectOpen(true);
      else if (m.which === "palette") setPaletteOpen(true);
      else if (m.which === "compare") setCompareTarget(m.base);
      else if (m.which === "rebase") setRebaseBase(m.base);
      else setBlamePath({ path: m.path });
    };
    run();
    return subscribeGitModal(run);
  }, [root]);
  const modalUp = !!(rebaseBase || compareTarget || insightsOpen || bisectOpen || blamePath || paletteOpen);
  const modalSeen = useRef(false);
  useEffect(() => {
    // A request wakes the view even before it has a checkout to drain into
    // (and even after another subscriber took it: the modal is up, not pending).
    const wake = () => setAsked(true);
    const off = subscribeGitModal(wake);
    // One nobody could serve (no checkout) expires with the mailbox itself.
    const t = asked && !modalUp ? setTimeout(() => setAsked(false), GIT_MODAL_TTL_MS + 1000) : null;
    return () => { off(); if (t) clearTimeout(t); };
  }, [asked, modalUp]);
  useEffect(() => {
    if (modalUp) modalSeen.current = true;
    else if (modalSeen.current) { modalSeen.current = false; setAsked(false); }
  }, [modalUp]);
  const [walk, setWalk] = useState<WalkthroughResult | null>(null);
  const [walkLoading, setWalkLoading] = useState(false);
  const walkReqSig = useRef<string | null>(null);
  const treeSeq = useRef(0); // guards stale working-tree responses (repo switches)
  const viewSeq = useRef(0); // same, for the non-Changes list views (repo/remote/view switches)
  const frameRef = useRef<HTMLDivElement>(null);
  const firstOpen = useRef(true); // reset the pane to Changes once, not on every re-activation

  const all = useMemo(() => [...(tree?.staged ?? []), ...(tree?.unstaged ?? [])], [tree]);
  const selected = useMemo(() => all.find((c) => keyOf(c) === selKey) ?? all[0] ?? null, [all, selKey]);
  /*
   * What the LIST marks, which is not the same as what was clicked.
   *
   * With nothing clicked yet the pane already shows the first file — that is
   * the `?? all[0]` above — but the rows compared against `selKey`, which is
   * still null, so a diff was on screen while every row beside it looked
   * equally unselected. Reported for this list and for the pull-request one,
   * which had the same split between "what is displayed" and "what is marked".
   */
  const activeKey = selected ? keyOf(selected) : null;
  const tickedChanges = useMemo(() => all.filter((c) => ticked.has(keyOf(c))), [all, ticked]);
  const tick = (c: GitFileChange) => setTicked((cur) => {
    const k = keyOf(c);
    const n = new Set([...cur].filter((x) => x[0] === k[0]));
    if (!n.delete(k)) n.add(k);
    return n;
  });
  useEffect(() => setTicked(new Set()), [root]);
  // The clean frame names the last commit; one row is all it needs.
  useEffect(() => {
    if (!open || !root || !tree?.clean) return;
    let live = true;
    api.gitLog(root, 1).then((r) => { if (live) setLastCommit(r.commits[0] ?? null); }).catch(() => { if (live) setLastCommit(null); });
    return () => { live = false; };
  }, [open, root, tree?.clean, tree?.branch.name]);

  /**
   * Mid-merge, open the conflict — in the resolver, not in the file list.
   *
   * Two things are true and only the second one is obvious. A merge stages
   * everything it merged, so a branch four hundred commits behind arrives with
   * four hundred rows and ONE that needs a person. And the conflicted file is
   * not among those rows at all: git emits an unmerged path as a COMBINED diff
   * (`diff --cc`, `@@@` hunks) which this panel's parser does not read, so the
   * one file worth opening is the one file missing from the list. Measured on
   * the real thing after two attempts at selecting a row that was never there.
   *
   * So the answer is not a selection. It is the block resolver, which is the
   * tool for this and already knows how to read a conflicted file — opened on
   * arrival rather than waiting to be found.
   *
   * Once per set of conflicts: reopening what somebody just closed is worse
   * than not opening it at all.
   */
  const autoOpened = useRef<string>("");
  useEffect(() => {
    if (!conflicts.length) { autoOpened.current = ""; return; }
    const rels = conflicts.map((p) => (p.startsWith(root) ? p.slice(root.length + 1) : p));
    const key = rels.join("|");
    if (autoOpened.current === key || blockFile) return;
    autoOpened.current = key;
    void openBlocks(rels[0]!);
  }, [conflicts, root, blockFile, openBlocks]);

  /**
   * Open the selected file in nvim, at the change you're looking at.
   *
   * lazygit's `e`, with the part that matters for this setup: if an nvim is
   * already running in this repo it gets the file, rather than a second one
   * being started beside it. The server decides that — it's the side that can
   * see the editor's socket.
   *
   * The line is the first hunk's, not line 1. Jumping to the top of a 900-line
   * file you opened *because* of a diff means scrolling back to where you
   * already were.
   */
  /**
   * Open the selected file in the editor, HERE.
   *
   * It used to hand the file to whatever nvim happened to be running, and on a
   * machine with none it copied a command to the clipboard and called that an
   * answer. The file now always opens in a floating modal with nvim. So `e` and
   * the button do the same
   * thing the pull request does, and the file opens at the change you were
   * reading with the rest of them down the right.
   */
  const editFile = (c: GitFileChange | null, hunkIdx = 0) => {
    if (!c) return;
    const groups = groupHunks(c.hunks);
    openPeek({
      root,
      path: c.file_path,
      label: rel(c),
      edit: true,
      branch: tree?.branch?.name || undefined,
      line: groups[hunkIdx]?.from ?? groups[0]?.from ?? 1,
      groups,
    });
  };


  const { hilite, themePref, setThemePref, bold, setBold, hiliteError } = useDiffHighlight(selected?.file_path);
  const writeEnabled = tree?.writeEnabled ?? false;
  const flash = (ok: boolean, msg: string) => { setToast({ ok, msg }); setTimeout(() => setToast(null), 2600); };
  /** A failure's toast text: one plain sentence on the G4 tabs (F18), git's own words go to the console. */
  const fail = (raw: string, remote?: string) => { console.warn("git failed:", raw); return failToast(view, raw, remote ?? (view === "remotes" ? remoteSel : undefined)); };

  // AI walkthrough of the *working tree* — cached per changeset (shared cache
  // with the telemetry viewer), so re-opening never re-hits the model.
  const walkSig = useMemo(() => changesetSig(all), [all]);
  const descMap = useMemo(() => { const m = new Map<string, WalkthroughFile>(); for (const f of walk?.files ?? []) m.set(f.path, f); return m; }, [walk]);
  useEffect(() => { if (!open) return; walkReqSig.current = null; setWalkLoading(false); setWalk(all.length ? (readWalkCache()[walkSig] ?? null) : null); }, [open, walkSig]); // eslint-disable-line react-hooks/exhaustive-deps
  const explain = (force = false) => {
    if (walkLoading || !all.length) return;
    if (!force) { const c = readWalkCache()[walkSig]; if (c) { setWalk(c); return; } }
    const reqSig = walkSig; walkReqSig.current = reqSig; setWalkLoading(true);
    const files = all.map((c) => ({ path: c.file_path, tool: "git", additions: c.additions, deletions: c.deletions, patch: unifiedText(c) }));
    api.walkthrough(files)
      .then((r) => { if (walkReqSig.current !== reqSig) return; setWalk(r); if (r.available && !r.error) writeWalkCache(reqSig, r); })
      .catch((e) => { if (walkReqSig.current === reqSig) setWalk({ available: true, reviewFocus: "", files: [], error: String(e) }); })
      .finally(() => { if (walkReqSig.current === reqSig) setWalkLoading(false); });
  };

  const loadTree = useCallback(async (r: string) => {
    if (!r) return;
    const seq = ++treeSeq.current;
    try { const t = await api.gitTree(r); if (seq !== treeSeq.current) return; setTree((cur) => (cur && t.sig && cur.sig === t.sig && cur.root === t.root ? cur : t)); setTreeFor(r); setTreeFail(t.error ?? null); if (t.error) flash(false, t.error); }
    catch (e) { if (seq === treeSeq.current) { setTreeFail(String(e)); flash(false, fail(String(e))); } }
    finally { if (seq === treeSeq.current) setTreeRead(true); }
  }, []);
  /* On screen at launch, Git holds the launch cover until the working tree has
     been read once — answered or failed — so it arrives with its files listed
     instead of "Reading the working tree…". */
  useCoverHold("git", active && !IS_DEMO && !treeRead);
  const rel = (c: GitFileChange) => (c.file_path.startsWith(root + "/") ? c.file_path.slice(root.length + 1) : c.file_path);

  useEffect(() => {
    if (!open) return;
    // Reset the transient composer state only on the FIRST open. This used to run
    // on every activation, so stepping away to the terminal and back threw you
    // from Remotes (or a filtered, scrolled Branches list) straight to Changes,
    // losing the view, the filter and the row you were on — the whole pane read
    // as reset. The view stays mounted the entire time; only its visibility
    // changes, so there is nothing to rebuild, just data to refresh.
    // Not the view: it starts on Changes already, and setting it here undid
    // the tab a worktree jump had just chosen when that jump opened the panel.
    if (firstOpen.current) {
      firstOpen.current = false;
      setToast(null); setTitle(""); setBody(""); setAmend(null); setNewBranch("");
    }
    api.editorCapability().then(setEditor).catch(() => setEditor({ hasNvim: false, editor: null }));
    // Refused while the server is still starting: asked again rather than left
    // empty. The list was read once per open, so a slow cold start opened on
    // an empty Git that stayed empty until the view was opened again.
    let live = true;
    let retry: ReturnType<typeof setTimeout> | null = null;
    const readRepos = () => api.gitRepos().then(({ repos }) => {
      if (!live) return;
      setRepos(repos);
      const first = repos[0]?.root ?? "";
      setRoot((cur) => cur || first); // the [root, open] effect owns tree loading
      if (!first) setTreeRead(true); // no checkout: there is no tree to wait for
    }).catch((e) => {
      if (!live) return;
      if (e instanceof TypeError && !refusalFinal()) { retry = setTimeout(readRepos, 500); return; }
      flash(false, String(e));
      setTreeRead(true);
    });
    void readRepos();
    if (active) requestAnimationFrame(() => frameRef.current?.focus());
    return () => { live = false; if (retry) clearTimeout(retry); };
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { if (open && root) loadTree(root); }, [root, open, loadTree]);

  // load the data a non-Changes view needs when it (or the repo) becomes active
  //
  // Every one of these ends in `.catch(() => {})` and leaves the previous
  // view's state in place, so an in-flight fetch and an empty result were the
  // same picture: a blank pane, or worse "no worktrees" under a repo that has
  // three. `busy` marks the view whose request is outstanding, which is all the
  // empty states need to tell the two apart.
  const loadView = useCallback(() => {
    if (!open || !root) return;
    // Like treeSeq for the working tree: each run claims a sequence number, and a
    // reply from a repo/remote/view you have since switched away from is dropped
    // rather than painted under the current selection. The busyView guard below
    // owns only the spinner — and keys on `view`, so it cannot tell two answers
    // for the *same* view apart (a remote switch stays on "remotes"), which is
    // exactly the stale-write this closes.
    const seq = ++viewSeq.current;
    const track = <T,>(p: Promise<T>, use: (v: T) => void) => {
      setBusyView(view);
      p.then((v) => { if (seq === viewSeq.current) use(v); }).catch(() => {}).finally(() => {
        // Only clear if this is still the view being looked at: switching tabs
        // mid-flight would otherwise have the old request turn off the new
        // one's spinner.
        setBusyView((b) => (b === view ? null : b));
      });
    };
    const failing = <T,>(p: Promise<T>) => p.then(
      (r) => { if (seq === viewSeq.current) setViewFail(null); return r; },
      (e) => { if (seq === viewSeq.current) { console.warn("git view failed:", e); setViewFail(String(e?.message ?? e)); } throw e; },
    );
    if (view === "branches") {
      track(failing(api.gitBranches(root)), setBranchData);
      // Worktrees too, so a branch already checked out in one is marked and its
      // switch OPENS that worktree instead of a `git checkout` that git refuses.
      api.gitWorktrees(root).then((r) => { if (seq === viewSeq.current) setWorktrees(r.worktrees); }).catch(() => {});
    }
    else if (view === "log") track(api.gitGraph(root, 500, logScope).then(
      (r) => { if (seq === viewSeq.current) setHistFail(null); return r; },
      (e) => { if (seq === viewSeq.current) setHistFail(String(e?.message ?? e)); throw e; },
    ), (r) => { setGraph(r.lines); setGraphBranch(r.branch); });
    else if (view === "stashes") {
      track(failing(api.gitStashes(root)), (r) => setStashes(r.stashes));
      track(api.gitSnapshots(root), (r) => setSnapshots(r.snapshots ?? []));
    }
    else if (view === "worktrees") track(failing(api.gitWorktrees(root)), (r) => setWorktrees(r.worktrees));
    else if (view === "tidy") track(failing(api.gitTidy(root)), setTidy);
    else if (view === "remotes") {
      // Two answers, because the pane asks two questions: which remotes there
      // are (the picker) and what is on the selected one (the list). Asked
      // together rather than chained, so the list doesn't wait on the picker.
      api.gitRemotes(root).then((r) => { if (seq === viewSeq.current) setRemotes(r.remotes); }).catch(() => {});
      track(failing(api.gitRemoteBranches(root, remoteSel)), (r) => {
        setRemoteRows(r.branches);
        // Which remote the server actually read — how the picker gets its
        // initial selection without this side guessing "origin".
        if (r.remote) setRemoteSel(r.remote);
      });
    }
    else if (view === "tags") track(failing(api.gitTags(root)), (r) => setTags(r.tags));
    else if (view === "reflog") track(api.gitReflog(root).then(
      (r) => { if (seq === viewSeq.current) setHistFail(null); return r; },
      (e) => { if (seq === viewSeq.current) setHistFail(String(e?.message ?? e)); throw e; },
    ), (r) => { setReflog(r.entries); setReflogOff(!!r.reflogOff); });
    else if (view === "submodules") track(failing(api.gitSubmodules(root)), (r) => setSubmodules(r.submodules));
  }, [open, root, view, logScope, remoteSel]);

  /**
   * The header refresh: this view, and the working tree, with something to see.
   *
   * Declared after loadView, and that is not tidiness: the dependency array
   * reads it at once, so putting this above was a temporal dead zone — the
   * same shape that blanked the whole window this morning. tsc caught this
   * one, because a deps array is evaluated where it is written rather than
   * inside a callback nobody calls yet.
   *
   * The tick is held for a moment on purpose. A repository that answers in
   * 80ms would otherwise flash a spinner nobody's eye catches, and "it did
   * nothing" and "it did it faster than you can see" look identical — which
   * was the actual complaint. The floor is on the FEEDBACK, never on the work:
   * the reload starts immediately and is not delayed by a millisecond.
   */
  const [refreshing, setRefreshing] = useState(false);
  const [refreshed, setRefreshed] = useState(false);
  const refreshAll = useCallback(() => {
    if (!root) return;
    setRefreshed(false);
    setRefreshing(true);
    const started = Date.now();
    void Promise.allSettled([loadTree(root), Promise.resolve(loadView())]).then(() => {
      const seen = Date.now() - started;
      setTimeout(() => {
        setRefreshing(false);
        setRefreshed(true);
        setTimeout(() => setRefreshed(false), 1400);
      }, Math.max(0, 320 - seen));
    });
  }, [root, loadTree, loadView]);

  useEffect(() => { loadView(); }, [loadView]);

  // Any repository mutation, from anywhere — this panel, another window, or a
  // `git pull` typed into the app's own terminal — re-reads what is on screen.
  // The dropdown's counts in particular came from a 5s server cache that the
  // panel re-fetched *immediately* after an action, so it kept answering with
  // numbers from before it.
  useEffect(() => subscribeGitChanged(() => {
    if (!open) return;
    if (root) loadTree(root);
    loadView();
    api.gitRepos().then((r) => setRepos(r.repos)).catch(() => {});
  }), [open, root, loadTree, loadView]);

  // The working tree changes from outside this app — a commit in a terminal, a
  // branch switch, an agent editing files — and none of that emits an event we
  // could listen for, so an open panel would otherwise sit on whatever it read
  // when it opened. Not while a write is in flight: refreshing mid-stage would
  // fight the optimistic selection the action is about to set.
  /*
   * Two clocks, because the views cost wildly different amounts.
   *
   * The working tree is a `git status` — tens of milliseconds — and it's the
   * thing that genuinely moves while you watch, since an agent is editing files
   * under you. Worth 2.5s.
   *
   * The other views are history. `log --graph -n500` measures 864ms on a real
   * repo, so re-running it every 2.5s spent a third of every cycle rebuilding a
   * list of commits that, by definition, already happened. Commits, branches
   * and tags change when *you* do something — and every action already forces a
   * reload through act(). So this only needs to catch changes made outside the
   * app, which 10s covers with room to spare.
   */
  usePoll(active && !!root && !busy, () => loadTree(root));
  // The polls' first tick is 2.5s / 10s after the view returns; an agent that
  // edited or staged files while the Terminal was in front should show at once
  // (the conflict list rides on loadView, not on the tree).
  useEffect(() => { if (active && root) { loadTree(root); loadView(); } }, [active]); // eslint-disable-line react-hooks/exhaustive-deps
  usePoll(active && !!root && !busy, loadView, 10_000);


  /**
   * Run a git action, and make sure the screen agrees with the repo afterwards.
   *
   * Two things this has to get right, both of which it used to get wrong:
   *
   *   * Say something. Every action reported success only through a toast, and
   *     a pull that takes two seconds looked identical to a dead button. `label`
   *     names the action in flight so the button that started it can show it.
   *   * Refresh *everything* that moved. It reloaded the working tree only, but
   *     ahead/behind lives on the repo list — which was fetched once when the
   *     panel opened. So you could pull, watch the commits arrive, and still be
   *     told you were 2 behind, forever.
   */
  const act = async (fn: () => Promise<{ ok: boolean; error?: string; output?: string }>, okMsg?: string, label?: string) => {
    if (busy) return false;
    setBusy(true);
    setPending(label ?? null);
    try {
      const r = await fn();
      if (r.ok) { if (okMsg || r.output) flash(true, okMsg || r.output || "done"); } else flash(false, r.error ? fail(r.error) : "failed");
      await loadTree(root);
      // Cheap, and the only way the header chip and the repo dropdown stop
      // showing counts from before the action.
      api.gitRepos().then(({ repos }) => setRepos(repos)).catch(() => {});
      return r.ok;
    } catch (e) { flash(false, fail(String(e))); return false; } finally { setBusy(false); setPending(null); }
  };

  // working tree ops
  const stage = async (c: GitFileChange) => { if (await act(() => api.gitStage(root, [rel(c)]))) setSelKey("s:" + c.file_path); };
  const unstage = async (c: GitFileChange) => { if (await act(() => api.gitUnstage(root, [rel(c)]))) setSelKey("u:" + c.file_path); };
  const discard = async (c: GitFileChange) => {
    if (await ask({ title: `Discard changes to ${baseName(c.file_path)}?`, command: discardCommand(rel(c), c.status === "untracked"), irreversible: true, danger: true, confirmLabel: "Discard" })) act(() => api.gitDiscard(root, [rel(c)]), "Discarded");
  };
  const startAmend = async () => {
    const info = await api.gitAmendInfo(root).catch(() => null);
    if (!info?.ok) return void flash(false, "Could not read the last commit");
    if (info.refusal) return void flash(false, info.refusal);
    setTitle(info.title ?? ""); setBody(info.body ?? ""); setAmend({ hash: info.hash ?? "" });
  };
  const stopAmend = () => { setAmend(null); setTitle(""); setBody(""); };
  const doAmend = async () => {
    if (!amend || !title.trim()) return;
    if (!(await ask({
      title: `Rewrite ${amend.hash}?`,
      body: "It is replaced by a new commit with the staged files and this message. Its hash changes.",
      command: "git commit --amend", confirmLabel: "Amend" }))) return;
    if (await act(() => api.gitAmendStaged(root, title, body), "Amended")) { stopAmend(); reloadGraph(); }
  };
  const doCommit = async () => {
    if (!title.trim()) { flash(false, "Commit title required"); return; }
    if (await act(() => api.gitCommitStaged(root, title, body), "Committed")) { setTitle(""); setBody(""); api.gitGraph(root, 500, logScope).then((r) => setGraph(r.lines)).catch(() => {}); }
  };
  // branches
  const reloadBranches = () => api.gitBranches(root).then(setBranchData).catch(() => {});
  /** The row for the directory we are standing in: what "here" is called, what
   *  it holds, and what is uncommitted in it. */
  const here = repos.find((r) => r.root === root) ?? null;
  const checkout = async (name: string) => {
    // A checkout moves a branch INTO a folder and evicts what was there. Said
    // out loud first — see lib/checkoutWarning.ts.
    const t = { branch: name, dir: here?.name ?? wtName(root), displacing: here?.branch ?? null, dirty: here?.dirty ?? 0 };
    if (needsCheckoutConfirm(t) && !(await ask(checkoutConfirm(t)))) return;
    if (await act(() => api.gitCheckout(root, name), `On ${name}`)) { reloadBranches(); setView("changes"); }
  };
  const createBranch = async () => { const n = newBranch.trim(); if (!n) return; if (await act(() => api.gitBranchCreate(root, n), `Created ${n}`)) { setNewBranch(""); reloadBranches(); setView("changes"); } };
  /**
   * Delete a branch, and offer the repair when git refuses.
   *
   * Two of git's refusals aren't really refusals, they're a missing step, and
   * the panel used to dead-end on both — it printed the stderr into a toast
   * that clears itself after 2.6s and left you to finish the job in a terminal:
   *
   *   * "used by worktree at '<path>'" — the branch is checked out somewhere
   *     else. The path is right there in the error, so parse it back out and
   *     offer to remove that worktree first. Making the user read a vanishing
   *     toast, switch to the Worktrees tab and match the path by eye is the
   *     kind of thing this panel exists to avoid.
   *   * "not fully merged" — true of every squash-merged branch, which is most
   *     of them here: the PR landed as a new commit, so the branch tip is not
   *     an ancestor of anything. Both answers to "is it really merged?" get a
   *     way forward, and they are not the same way:
   *
   *       - Proven (`mergedIntoTrunk`, computed against the trunk rather than
   *         whatever HEAD happens to be): git's refusal is the stale one, the
   *         dialog says so, and the forced retry is a formality.
   *       - Not proven: the refusal might be right, and it might be one of the
   *         gaps the server's own probes admit to (a branch whose only commits
   *         ahead are merges; a repo with more branches than one sweep checks).
   *         Being unable to tell those apart is not a reason to leave someone
   *         with a toast that vanishes and no next step, so the delete is still
   *         offered, named as unproven, with what it would cost and the reflog
   *         window that can undo it.
   *
   * Deliberately not routed through `act`: it reports failures by flashing the
   * message and returns a bare boolean, and the whole point here is to branch
   * on *which* failure came back.
   */
  const deleteBranch = async (b: GitBranch) => {
    const no = protectedRefusal(protectedBranches, [b.name]);
    if (no) { flash(false, no); return; }
    if (busy || !(await ask({ title: `Delete branch ${b.name}?`, body: "Deletes the local branch. If git says it is not merged, or a worktree holds it, you are asked again before anything is forced or removed.", danger: true, confirmLabel: "Delete" }))) return;
    setBusy(true);
    setPending(`Delete ${b.name}`);
    try {
      let r = await api.gitBranchDelete(root, b.name, false);
      const wt = r.ok ? null : /worktree at '([^']+)'/.exec(r.error || "")?.[1];
      if (wt) {
        if (!(await ask({ title: `${b.name} is checked out in a worktree`, body: `It lives in ${wtName(wt)}. Remove that worktree and delete the branch?`, danger: true, confirmLabel: "Remove & delete" }))) { flash(false, "Kept"); return; }
        // The same rescue step the bulk path takes: it names the ignored files
        // the removal would delete without a word, and offers to keep them.
        const failed: string[] = [];
        const { removed, cancelled } = await rescueThenRemoveWorktrees([b], new Map([[b.name, wt]]), failed);
        if (cancelled) { flash(false, "Nothing was removed"); return; }
        if (!removed.length) { flash(false, failed[0] ? fail(failed[0]) : "Worktree remove failed"); return; }
        reloadWorktrees();
        r = await api.gitBranchDelete(root, b.name, false);
      }
      if (!r.ok && /not fully merged/i.test(r.error || "")) {
        const q = forcedDeletePrompt(b.name, b.mergedIntoTrunk === true, branchData.trunk ?? "the trunk");
        if (await ask({ title: q.title, body: q.body, danger: true, confirmLabel: q.confirmLabel })) {
          r = await api.gitBranchDelete(root, b.name, true);
        }
      }
      flash(r.ok, r.ok ? `Deleted ${b.name}` : r.error ? fail(r.error) : "Failed");
      if (r.ok) reloadBranches();
    } catch (e) { flash(false, fail(String(e))); }
    finally { setBusy(false); setPending(null); }
  };

  /**
   * A branch held by another worktree: the rescue modal (what the removal would
   * delete, and a chance to keep it) is the one confirmation, then the worktree
   * goes and the branch is deleted with -d. -D is only offered, as a second ask,
   * when git says the branch is not merged.
   */
  const removeAndDelete = async (b: GitBranch) => {
    const wt = wtByBranch.get(b.name);
    if (busy || !wt || wt.path === root) return;
    const no = protectedRefusal(protectedBranches, [b.name]) ?? (wt.busy ? BUSY_REASON : undefined);
    if (no) { flash(false, no); return; }
    setBusy(true);
    setPending(`Remove ${wtName(wt.path)}`);
    try {
      const failed: string[] = [];
      const { removed, cancelled } = await rescueThenRemoveWorktrees([b], new Map([[b.name, wt.path]]), failed);
      if (cancelled) { flash(false, "Nothing was removed"); return; }
      if (!removed.length) { flash(false, failed[0] ? fail(failed[0]) : "Worktree remove failed"); return; }
      reloadWorktrees();
      let r = await api.gitBranchDelete(root, b.name, false);
      if (!r.ok && /not fully merged/i.test(r.error || "")) {
        const q = forcedDeletePrompt(b.name, b.mergedIntoTrunk === true, branchData.trunk ?? "the trunk");
        if (await ask({ title: q.title, body: q.body, danger: true, confirmLabel: q.confirmLabel })) r = await api.gitBranchDelete(root, b.name, true);
      }
      flash(r.ok, r.ok ? `Deleted ${b.name}` : r.error ? fail(r.error) : "Failed");
      if (r.ok) reloadBranches();
    } catch (e) { flash(false, fail(String(e))); }
    finally { setBusy(false); setPending(null); }
  };

  /**
   * Open a branch where it lives on the web.
   *
   * A live branch has a tree page and the URL is pure string work. A `gone` one
   * has no tree page — that is what gone means — so the only useful destination
   * is the pull request it came from, which costs a lookup. Resolved on click
   * rather than prefetched for every row: thirteen gone branches would be
   * thirteen network calls for a link nobody pressed.
   */
  const openBranchOnWeb = async (b: GitBranch) => {
    if (busy) return;
    setBusy(true);
    try {
      const r = await api.prBranchUrl(root, b.name, trackChip(b.track).gone);
      if (!r.ok || !r.url) { flash(false, r.error ? fail(r.error) : "Could not work out where that branch lives"); return; }
      window.open(r.url, "_blank", "noopener,noreferrer");
    } catch (e) { flash(false, fail(String(e))); }
    finally { setBusy(false); }
  };

  // Branches whose upstream is gone. Never the current one: git refuses to
  // delete a checked-out branch anyway, and offering it is just a failed call.
  const goneBranches = branchData.branches.filter((b) => !b.current && trackChip(b.track).gone);
  const goneCount = goneBranches.length;
  /**
   * The branch list as it is actually drawn: the gone filter, then the search,
   * then the sort.
   *
   * Searched over name AND subject, because half of what you remember about a
   * branch is what its last commit said, not what somebody named the ref. Sort
   * defaults to `recent`, which is git's own order here and the one that makes
   * a 54-branch list usable at all — `name` is for when you know the ticket
   * number, and `track` puts what you are behind on at the top.
   */
  const shownBranches = useMemo(() => {
    const base = branchData.branches;
    const needle = q.trim().toLowerCase();
    const hits = needle
      /* The word on the chip is searchable, which is the whole cleanup mode:
         typing "scratch" leaves exactly the branches cut to read a pull
         request. Cheaper than a filter button, and it needs no explaining
         because the word is already on screen. */
      ? base.filter((b) => `${b.name} ${b.subject ?? ""} ${b.upstream ?? ""} ${isScratchBranch(b.name) ? "scratch" : ""}`.toLowerCase().includes(needle))
      : base;
    if (sort === "recent") return hits;
    const out = [...hits];
    if (sort === "name") out.sort((a, b) => a.name.localeCompare(b.name));
    // Most out-of-sync first, ahead counting for as much as behind: both mean
    // "this one still has something to settle".
    else out.sort((a, b) => {
      const w = (x: GitBranch) => { const t = trackChip(x.track); return t.behind + t.ahead; };
      return w(b) - w(a);
    });
    return out;
  }, [branchData.branches, q, sort]);
  const branchTotal = branchData.branches.length;

  /** The same search, over the lists that are not branches. Each one over the
   *  fields you would actually remember: a stash by what it says, a tag by its
   *  name or its commit, a worktree by its branch or its directory. */
  const hit = useCallback((...fields: (string | undefined | null)[]) => {
    const needle = q.trim().toLowerCase();
    return !needle || fields.filter(Boolean).join(" ").toLowerCase().includes(needle);
  }, [q]);
  const shownSubmodules = useMemo(() => submodules.filter((x) => hit(x.path, x.url)), [submodules, hit]);
  const shownStashes = useMemo(() => stashes.filter((x) => hit(x.ref, x.message)), [stashes, hit]);
  const shownTags = useMemo(() => {
    const out = tags.filter((x) => hit(x.name, x.subject, x.hash));
    return sort === "name" ? [...out].sort((a, b) => a.name.localeCompare(b.name)) : out;
  }, [tags, hit, sort]);
  const shownWorktrees = useMemo(() => worktrees.filter((x) => hit(x.branch, x.path)), [worktrees, hit]);
  // The branch you are ACTUALLY on, read off the fresh working-tree poll (2.5s)
  // rather than the branch list (10s) so the ⎇ and the disabled state track a
  // switch — from here, the terminal, or another window — without a lag where
  // the list still crowns the branch you just left.
  const currentBranchName = tree?.branch?.name || branchData.current;

  /*
   * The pull request open on this branch, if there is one.
   *
   * Asked of GitHub BY BRANCH, not filtered out of a scope. The first version
   * read the `mine` scope and matched on head, and it was wrong in the ordinary
   * case rather than at the edges: the branch open on this checkout had a pull
   * request, opened by a colleague, and the chip never appeared. A scope is
   * about an author; this question is about a branch.
   */
  const [branchPr, setBranchPr] = useState<PrBranchSummary | null>(null);
  /*
   * The other half, and the reason the first half read as broken.
   *
   * A branch can have no pull request of its own and still be the one twelve
   * others land ON — a base branch, which is exactly what an integration branch
   * is. Measured on a real checkout: standing on it, no chip appeared, and the
   * repository had twelve open pull requests pointing at it. "Only when there
   * is one" was the right rule applied to the wrong question.
   */
  const [prsOntoBranch, setPrsOntoBranch] = useState<PrBranchSummary[]>([]);
  /* Kept beside them because the chip's whole job is to OPEN one, and the
     panel's jump is addressed by owner/name and number. Without the name the
     only thing a click can do with a number is type it into a search box —
     which is what it used to do, and it stopped on "25 of 388 matches". */
  const [prRepo, setPrRepo] = useState<string | null>(null);
  /* Why the chips are absent, when the reason is not "there is no pull
     request". Silence used to cover both, and the two want different actions
     from you — one is nothing to do, the other is `gh auth login`. */
  const [prAskFailed, setPrAskFailed] = useState<string | null>(null);
  /* Two reasons to ask GitHub again — see the effect below. `gitTick` moves on
     any repository mutation this app can see; `refocus` on coming back to the
     window, which is the only way a merge done in a browser reaches us. */
  const [gitTick, setGitTick] = useState(0);
  const [refocus, setRefocus] = useState(0);
  useEffect(() => subscribeGitChanged(() => setGitTick((n) => n + 1)), []);
  useEffect(() => {
    const back = () => { if (document.visibilityState === "visible") setRefocus((n) => n + 1); };
    window.addEventListener("focus", back);
    document.addEventListener("visibilitychange", back);
    return () => { window.removeEventListener("focus", back); document.removeEventListener("visibilitychange", back); };
  }, []);
  // Whoever opened it. A branch you are standing in is yours to care about
  // however it got its pull request.
  /*
   * Asked again, rather than once and for ever.
   *
   * The dependencies used to be the root and the branch alone, which means
   * this asked when you ARRIVED on a branch and never again. A pull request
   * merged from anywhere else — the browser, another session, an auto-merge —
   * left the chip saying "2 PRs land here" for as long as the panel stayed on
   * that branch. Seen exactly that way, two minutes after
   * both of them had merged.
   *
   * Two triggers, and neither is a poll:
   *
   *   `gitTick` is the same counter the rest of this panel already re-reads on
   *   — any repository mutation from this app, another window, or a `git` typed
   *   into the terminal — so a merge that lands through the app is reflected
   *   with everything else.
   *
   *   `refocus` covers the case the bus cannot see: the merge happened on
   *   github.com, in a browser, and nothing on this machine moved. Coming back
   *   to the window is the moment a stale answer is about to be read, and it is
   *   also the only moment worth spending a GitHub call on.
   *
   * Deliberately NOT a timer. `prsForBranch` shells out to `gh`, and the rate
   * limit is shared with the PR panel; a chip nobody is looking at should cost
   * nothing.
   */
  useEffect(() => {
    if (!root || !currentBranchName) { setBranchPr(null); setPrsOntoBranch([]); setPrRepo(null); setPrAskFailed(null); return; }
    let live = true;
    void api.prsForBranch(root, currentBranchName)
      .then((r) => {
        if (!live) return;
        setBranchPr(r.from ?? null);
        setPrsOntoBranch(r.into ?? []);
        setPrRepo(r.repo ?? null);
        /*
         * Only when GitHub could not be ASKED — not when there is no GitHub.
         *
         * `prsForBranch` also answers `ok:false` with "no GitHub remote here",
         * which is not a failure, it is the truth about a local-only checkout.
         * Reading `ok` alone put a dashed "PR unknown" chip in the header of
         * every repository that has no remote, where the honest answer is
         * silence. `needsAuth` is the field that was added to tell the two
         * apart, and this is the reader it was added for.
         */
        setPrAskFailed(r.needsAuth ? (r.error || "GitHub did not answer") : null);
      })
      /* A thrown request is the network, not the repository — that one IS a
         "could not ask". */
      .catch(() => { if (live) { setBranchPr(null); setPrsOntoBranch([]); setPrRepo(null); setPrAskFailed("GitHub did not answer"); } });
    return () => { live = false; };
  }, [root, currentBranchName, gitTick, refocus]);
  /* The chip's whole decision, in one value: whether there is anything to draw
     and, if there is, exactly which pull request pressing it opens. Held here
     rather than spelled into the `onClick` because that is where it was when it
     went wrong, and a line of JSX is not something a test can reach. */
  const prChip = chipTarget(prRepo, branchPr);
  // Branch → its worktree, so the list reads like lazygit's: one list, each
  // branch tagged when it is checked out in a worktree, and switching to it
  // opens that worktree instead of a checkout git would refuse.
  const wtByBranch = useMemo(() => new Map(worktrees.filter((w) => w.branch && w.branch !== "(detached)" && !w.prunable).map((w) => [w.branch, w] as const)), [worktrees]);

  // Merged into the trunk — the only honest reading of "its PR landed". NOT
  // `git branch -d`, which compares against whatever is checked out: from a
  // worktree on a ticket branch that rejects every merged PR in the repo.
  const goneMerged = goneBranches.filter((b) => b.mergedIntoTrunk);

  /**
   * The worktree half: price it, show the price, then charge it.
   *
   * One request covers the whole batch, and its answer is the dialog — every
   * path that disappears, per checkout, with the rebuildable noise
   * (`__pycache__/`, `node_modules/`) counted rather than listed so the lines
   * that matter aren't buried under four hundred that don't.
   *
   * A checkout we could not read is not removed, whatever the user answers.
   * "Could not list what's in there" and "there's nothing in there" produce the
   * same empty list, and only one of them is safe to act on.
   */
  const rescueThenRemoveWorktrees = async (held: GitBranch[], heldByWorktree: Map<string, string>, failed: string[]): Promise<{ removed: GitBranch[]; cancelled: boolean }> => {
    const paths = held.map((b) => heldByWorktree.get(b.name)!);
    let reports: WorktreeLeftovers[];
    try { reports = (await api.gitWorktreeLeftovers(root, paths)).leftovers; }
    catch (e) { for (const b of held) failed.push(`${b.name} (couldn't inspect its worktree: ${String(e)})`); return { removed: [], cancelled: false }; }

    let { removable, refused } = splitReadable(held, heldByWorktree, reports);

    // A checkout blocked only by ownership is a checkout one dialog away from
    // working, so offer that dialog instead of reporting a dead end. The
    // elevation is the desktop's own (pkexec) and does chown, never rm — the
    // removal still runs as the user, through every check below.
    const blocked = reports.filter((r) => r.blocked && refused.some((f) => heldByWorktree.get(f.branch.name) === r.path));
    if (blocked.length && await ask({
      title: `${blocked.length} worktree${blocked.length === 1 ? " has" : "s have"} files owned by ${[...new Set(blocked.flatMap((r) => r.blocked!.owners))].join(", ")}`,
      body: `A container wrote them, so nothing can delete them as you.\n\n${blocked.map((r) => `${wtName(r.path)} — ${r.blocked!.count}${r.blocked!.more ? "+" : ""} files`).join("\n")}\n\nHand them back? Your desktop will ask for your password. agentglass never sees it, and only runs chown — the deletion still happens as you.`,
      confirmLabel: "Hand them back",
    })) {
      for (const r of blocked) {
        setPending(`Restoring ownership of ${wtName(r.path)}`);
        const fix = await api.gitWorktreeChown(root, r.path).catch((e) => ({ ok: false, error: String(e) }));
        if (!fix.ok) { flash(false, `${wtName(r.path)}: ${fix.error ? fail(fix.error) : "chown failed"}`); continue; }
        r.blocked = undefined; // re-read below now that it can succeed
      }
      // Re-split against the repaired reports rather than trusting the old
      // verdict: the whole point is that some of them are removable now.
      ({ removable, refused } = splitReadable(held, heldByWorktree, reports));
    }

    for (const { branch, why } of refused) failed.push(`${branch.name} (${why})`);
    if (!removable.length) return { removed: [], cancelled: false };

    // The modal replaces what used to be a confirm() listing the same files.
    // Reading a list you then have to copy by hand is a step people skip at the
    // exact moment they shouldn't, so the list is now the thing you act on.
    const picked = await new Promise<Map<string, string[]> | null>((resolve) => {
      setRescue({ reports: removable.map(({ report }) => report), resolve });
    });
    if (!picked) { setRescue(null); return { removed: [], cancelled: true }; } // cancelled — nothing removed, nothing copied
    // The modal STAYS UP for the rest of this, showing what is happening.
    // Copying 700K and removing three checkouts is seconds of work, and closing
    // the dialog first left the user staring at an unchanged panel, free to
    // navigate away mid-delete with nothing on screen saying why.
    const step = (progress: string) => setRescue((r) => (r ? { ...r, progress } : r));

    // Copy first, remove second, and never the other way round. A failed rescue
    // has to be able to stop the removal, which it cannot do once the directory
    // is gone.
    const keptBack = new Set<string>();
    let rescued = 0;
    for (const [path, rels] of picked) {
      if (!rels.length) continue;
      step(`Keeping ${rels.length} file${rels.length === 1 ? "" : "s"} from ${wtName(path)}`);
      const res = await api.gitWorktreeRescue(root, path, rels).catch((e) => ({ ok: false, error: String(e), copied: [] as string[], skipped: [] as { path: string; why: string }[] }));
      // Every path asked for has to come back accounted for. Counting only
      // `skipped` trusts the server to have reported its own omissions, and a
      // request that silently returns fewer copies than it was given then
      // reads as a clean success — which is how five screenshots were deleted
      // after being "kept". Anything unaccounted for is a loss.
      const missing = rels.filter((r) => !(res.copied ?? []).includes(r) && !(res.skipped ?? []).some((s) => s.path === r));
      const lost = [...(res.skipped ?? []), ...missing.map((path) => ({ path, why: "never confirmed by the server" }))];
      if (lost.length) {
        // Anything we could not save is a reason to leave that worktree alone:
        // removing it now destroys the very file the user asked to keep.
        const b = removable.find(({ report }) => report.path === path)?.branch;
        if (b) failed.push(`${b.name} (kept — couldn't save ${lost.slice(0, 2).map((s) => `${s.path}: ${s.why}`).join("; ")})`);
        keptBack.add(path);
      }
      if (res.copied?.length) rescued += res.copied.length;
    }

    if (rescued) flash(true, `Kept ${rescued} file${rescued === 1 ? "" : "s"} in the main checkout`);

    const removed: GitBranch[] = [];
    // `report.path` rather than another lookup: it is the path the server just
    // confirmed it inspected, so the thing removed is the thing priced.
    for (const { branch, report } of removable) {
      if (keptBack.has(report.path)) continue; // its rescue failed; already reported
      step(`Removing ${wtName(report.path)}`);
      const rm = await api.gitWorktreeRemove(root, report.path, true).catch((e) => ({ ok: false, error: String(e) }));
      if (!rm.ok) { failed.push(`${branch.name} (${rm.error || "worktree remove failed"})`); continue; }
      removed.push(branch);
    }
    setRescue(null);
    return { removed, cancelled: false };
  };
  /** Bulk: the shared rescue step, then `-D` on each branch whose checkout went. */
  const deleteHeldByWorktrees = async (held: GitBranch[], heldByWorktree: Map<string, string>, failed: string[]): Promise<{ done: number; cancelled: boolean }> => {
    const { removed, cancelled } = await rescueThenRemoveWorktrees(held, heldByWorktree, failed);
    let done = 0;
    for (const branch of removed) {
      const r = await api.gitBranchDelete(root, branch.name, true).catch((e) => ({ ok: false, error: String(e) }));
      if (r.ok) done++; else failed.push(`${branch.name} (${r.error || "branch delete failed"})`);
    }
    return { done, cancelled };
  };
  const mergeBranch = async (name: string) => { if (await ask({ title: `Merge ${name} into the current branch?`, confirmLabel: "Merge" })) act(() => api.gitMerge(root, name), `Merged ${name}`).then((ok) => { if (ok) reloadBranches(); }); };
  const rebaseBranch = async (name: string) => { if (await ask({ title: `Rebase the current branch onto ${name}?`, confirmLabel: "Rebase" })) act(() => api.gitRebase(root, name), `Rebased onto ${name}`).then((ok) => { if (ok) reloadBranches(); }); };
  const renameBranch = async (name: string) => {
    const no = protectedRefusal(protectedBranches, [name]);
    if (no) { flash(false, no); return; }
    const to = await askText({ title: `Rename ${name}`, input: { label: "New name", initial: name }, confirmLabel: "Rename" });
    if (to && to !== name) act(() => api.gitBranchRename(root, name, to), `Renamed → ${to}`).then((ok) => { if (ok) reloadBranches(); });
  };
  // log
  const openCommit = async (hash: string, subject: string) => {
    try { const { changes } = await api.gitCommitDiff(root, hash); setCommitView({ changes, title: `${hash} · ${subject}` }); }
    catch (e) { flash(false, String(e)); }
  };
  const resetTo = async (hash: string, mode: "soft" | "mixed" | "hard") => {
    // Every mode moves the branch tip, so every mode asks the shared protected check first.
    const no = tree?.branch.detached ? undefined : protectedRefusal(protectedBranches, [tree?.branch.name ?? ""]);
    if (no) { flash(false, `${no}: unprotect it in the Branches tab to reset it`); return; }
    // Soft and mixed lose no work, so they get a plain ask; only hard is red.
    const hard = mode === "hard";
    if (!(await ask({
      title: hard ? `Hard reset to ${hash}?` : `Reset ${tree?.branch.name ?? "this branch"} to ${hash}?`,
      body: hard ? "This DISCARDS working-tree changes."
        : `The commits after it are undone. Their changes stay ${mode === "soft" ? "staged" : "in your files, unstaged"}; no file changes.`,
      danger: hard, command: `git reset --${mode} ${hash}`, confirmLabel: hard ? "Reset --hard" : `Reset --${mode}` }))) return;
    act(() => api.gitReset(root, hash, mode), `reset --${mode} ${hash}`).then((ok) => { if (ok) api.gitGraph(root, 500, logScope).then((r) => setGraph(r.lines)); });
  };
  /**
   * The log's picks, ordered oldest-first as the server replays them.
   *
   * The log lists newest at the top, so the pick order (click / `c` order) is
   * display order; the sequencer applies oldest first, which is the reverse.
   */
  const pickedHashes = () => {
    const ordered = orderPicked(pickSet, graph.filter((l) => !!l.hash).map((l) => l.hash!));
    return ordered ? ordered.reverse() : [...pickSet].reverse();
  };
  const reloadGraph = () => api.gitGraph(root, 500, logScope).then((r) => { setGraph(r.lines); setGraphBranch(r.branch); }).catch(() => {});
  /**
   * Cherry-pick the picked commits as ONE sequencer run.
   *
   * One run is the point: a conflict pauses the series at the commit that
   * fought, and continuing replays the rest — where per-commit cherry-picks
   * would stop each at the same conflict forever. Oldest first, so a series
   * "replays in order", which is how people read the list.
   */
  const runCherryPick = async (noCommit = false, hashes = pickedHashes()) => {
    if (!hashes.length) return;
    const how = noCommit ? "staged" : "committed";
    const ok = await act(() => api.gitCherryPick(root, hashes, noCommit),
      `cherry-picked ${hashes.length} commit${hashes.length === 1 ? "" : "s"}`,
      `pick:${hashes.length}`);
    if (ok) {
      setPickSet(new Set());
      reloadGraph();
    }
  };
  /** Right-click → "Cherry-pick" on a single row: same path as the series, with
   *  a series of one. */
  const cherryPickOne = async (hash: string, noCommit = false) => {
    setPickSet(new Set([hash]));
    // The hash goes in directly: `pickSet` above is the render's old value, and
    // reading it back here cherry-picked nothing (or the previous pick).
    await runCherryPick(noCommit, [hash]);
  };
  /**
   * Revert one commit from the row menu: a new commit undoing it. A conflict
   * pauses as `reverting`, which the existing conflict screen already handles
   * (its continue/abort branch on that state).
   */
  const revertOne = async (hash: string) => {
    if (!(await ask({ title: `Revert ${hash}?`, body: "Adds a new commit that undoes it. History is not rewritten.", danger: true, command: `git revert ${hash}`, confirmLabel: "Revert" }))) return;
    if (await act(() => api.gitRevert(root, hash), "reverted", "revert")) reloadGraph();
  };
  /**
   * The commit menu's items, for the Log and the Reflog alike: one function,
   * so a fix to one tab cannot miss the other. The red items (revert, reset)
   * ask once, here, in a GitDialog; the menu no longer asks first.
   */
  const runCommitAction = (id: string, hash: string, subject: string) => {
    switch (commitEffect(id)) {
      case "show": return void openCommit(hash, subject);
      case "compare-worktree": setCompareAgainst("worktree"); return setCompareTarget(hash);
      case "branch-here": return void (async () => {
        const n = (await askText({ title: `New branch from ${hash}`, input: { label: "Branch name" }, confirmLabel: "Create & switch" }))?.trim();
        if (n && await act(() => api.gitBranchCreate(root, n, hash), `Created ${n}`)) { reloadBranches(); setView("changes"); }
      })();
      case "cherry-pick": return void cherryPickOne(hash);
      case "cherry-pick-stage": return void cherryPickOne(hash, true);
      case "revert": return void revertOne(hash);
      case "reset-soft": return void resetTo(hash, "soft");
      case "reset-mixed": return void resetTo(hash, "mixed");
      case "reset-hard": return void resetTo(hash, "hard");
      case "copy-sha": return void navigator.clipboard?.writeText(hash).catch(() => {});
      case "rebase": return setRebaseBase(hash);
      case "bisect": setBisectFrom(hash); return setBisectOpen(true);
    }
  };
  /** Fold the picked commits into one, tree preserved. Oldest..newest must run
   *  to the tip — the server verifies; the panel just sends the span. */
  const squashPicked = async () => {
    const hashes = pickedHashes();
    const loaded = graph.filter((l) => !!l.hash).map((l) => l.hash!);
    const ordered = orderPicked(pickSet, loaded);
    if (hashes.length < 2 || !ordered || !isRunToTip(ordered, loaded)) { flash(false, "Pick two or more consecutive commits ending at the tip to squash"); return; }
    if (!(await ask({
      title: `Squash ${hashes.length} commits into one?`,
      body: "The history is rewritten: the separate commits and their messages are gone from this branch. The files stay exactly as they are. Only git's reflog can bring the old commits back.",
      danger: true, confirmLabel: "Squash",
    }))) return;
    const ok = await act(() => api.gitSquash(root, hashes[0], hashes[hashes.length - 1]),
      `squashed ${hashes.length} commits`, "squash");
    if (ok) { setPickSet(new Set()); reloadGraph(); }
  };
  /** Abort from the strip. Asks only when files are already resolved (or the
   *  record cannot be read): those answers are lost, a fresh stop loses nothing. */
  const aborting = useRef(false);
  const abortMerge = async () => {
    // A second click while the session is being read or the question is open
    // would raise a second question; `busy` is not set until the abort runs.
    if (busy || aborting.current) return;
    // A bisect has no resolutions to lose: ending it is a reset, no question.
    if (mergeState === "bisecting") { void act(() => api.gitMergeAbort(root), "Bisect ended", "abort"); return; }
    aborting.current = true;
    try {
      const s = await api.gitMergeSession(root).catch(() => null);
      const resolved = s?.ok ? s.files.length - s.left.length : 1;
      if (resolved > 0 && !(await ask({
        title: "Abort and discard your resolutions?",
        body: "The tree goes back to exactly how it was before this started. Every file you already resolved is thrown away.",
        danger: true, confirmLabel: "Abort",
      }))) return;
    } finally { aborting.current = false; }
    void act(() => api.gitMergeAbort(root), `${opNoun(mergeState)} aborted`, "abort");
  };
  /** Apply a snapshot over the working tree: same paths take the snapshot's version. */
  const restoreSnapshot = async (sha: string) => {
    if (!(await ask({
      title: "Restore this snapshot over your working tree?",
      body: "Files you changed at the same paths since the snapshot are replaced by the snapshot's version. Those edits are lost.",
      danger: true, confirmLabel: "Restore",
    }))) return;
    void act(() => api.gitSnapshotRestore(root, sha), "Restored snapshot");
  };
  // base branch
  /** Fetched when a picker opens, not on mount. Depending on the Branches tab
   *  having been visited made the picker useless exactly when you reach for it
   *  — the first time. */
  const loadBaseRefs = () => {
    if (!baseRefs.length) { setBaseRefsError(null); api.gitBaseCandidates(root).then((r) => setBaseRefs(r.refs ?? [])).catch(() => setBaseRefsError("Could not read the branch list.")); }
  };
  /**
   * Record what a branch is measured against — or, with an empty name, forget
   * the override and go back to what the app works out on its own.
   *
   * Written to the repo's own config, which a worktree family shares, so this
   * is the same call whether it came from the header or from a row. Both views
   * are reloaded because both display the answer, and a correction that only
   * lands in the half you happened to click from reads as not having worked.
   */
  const setBaseFor = async (name: string, base: string) => {
    const ok = await act(() => api.gitSetBase(root, name, base || null), base ? `base set to ${base}` : "base back to automatic", "sync");
    if (ok) { reloadWorktrees(); loadTree(root); }
  };
  // worktrees
  const reloadWorktrees = () => api.gitWorktrees(root).then((r) => setWorktrees(r.worktrees)).catch(() => {});
  const addWorktree = async () => {
    const br = newWtBranch.trim(); if (!br) return;
    const path = `${root}-${br.replace(/[\/\s]+/g, "-")}`; // sibling dir named repo-branch
    if (await act(() => api.gitWorktreeAdd(root, path, br, true), `Worktree ${wtName(path)}`)) { setNewWtBranch(""); reloadWorktrees(); }
  };
  // Same shape as the worktree step inside deleteBranch: a dirty worktree is a
  // question ("that work is gone — still?"), not a dead end.
  const removeWorktree = async (w: GitWorktree) => {
    if (w.busy) { flash(false, BUSY_REASON); return; }
    if (busy || !(await ask({ title: `Remove worktree ${wtName(w.path)}?`, danger: true, command: `git worktree remove ${quoteRef(w.path)}`, irreversible: true, confirmLabel: "Remove" }))) return;
    setBusy(true);
    setPending(`Remove ${wtName(w.path)}`);
    try {
      let r = await api.gitWorktreeRemove(root, w.path, false);
      if (!r.ok && /modified|untracked|not clean/i.test(r.error || "")) {
        if (!(await ask({ title: `${wtName(w.path)} still has uncommitted or untracked files`, body: "Remove it anyway? That work is gone.", danger: true, confirmLabel: "Remove anyway" }))) { flash(false, r.error ? fail(r.error) : "Kept"); return; }
        r = await api.gitWorktreeRemove(root, w.path, true);
      } else if (!r.ok && refusedForSubmodule(r.error)) {
        // Forcing is its own ask, from the dock's "Remove anyway": it names what force drops.
        setWtRefused((cur) => new Set(cur).add(w.path));
        flash(false, "git refused: a submodule is set up in it.");
        return;
      }
      flash(r.ok, r.ok ? "Removed worktree" : r.error ? fail(r.error) : "Failed");
      if (r.ok) { reloadWorktrees(); reloadBranches(); }
    } catch (e) { flash(false, fail(String(e))); }
    finally { setBusy(false); setPending(null); }
  };
  const forceRemoveWorktree = async (w: GitWorktree) => {
    if (busy || !(await ask({ ...forceRemoveAsk(wtName(w.path)), danger: true, command: `git worktree remove --force ${quoteRef(w.path)}`, irreversible: true, confirmLabel: "Remove anyway" }))) return;
    if (await act(() => api.gitWorktreeRemove(root, w.path, true), "Removed worktree")) {
      setWtRefused((cur) => { const n = new Set(cur); n.delete(w.path); return n; });
      reloadWorktrees(); reloadBranches();
    }
  };
  const unlockWorktree = async (w: GitWorktree) => { if (await act(() => api.gitWorktreeUnlock(root, w.path), `Unlocked ${wtName(w.path)}`)) reloadWorktrees(); };
  // remote branches
  const reloadRemoteBranches = () => api.gitRemoteBranches(root, remoteSel).then((r) => setRemoteRows(r.branches)).catch(() => {});
  /**
   * Get a remote branch onto this machine, three ways.
   *
   * "local" makes the branch and stops — the safe one, and the one that fits a
   * repo where the working tree belongs to an agent that is mid-edit. "checkout"
   * also switches this checkout onto it. "worktree" gives it a directory of its
   * own, which on a repo worked one-ticket-per-branch is usually what "add that
   * branch to my local env" actually means.
   */
  const takeRemote = async (b: GitRemoteBranch, how: "local" | "checkout" | "worktree") => {
    if (how === "worktree") {
      const path = `${root}-${b.name.replace(/[\/\s]+/g, "-")}`; // sibling dir, same shape as the Worktrees tab uses
      if (await act(() => api.gitWorktreeAdd(root, path, b.name, true, b.ref), `Worktree ${wtName(path)}`, `take:${b.ref}`)) {
        reloadRemoteBranches(); reloadWorktrees(); reloadBranches();
      }
      return;
    }
    const ok = await act(() => api.gitTrackRemote(root, b.ref, how === "checkout"),
      how === "checkout" ? `On ${b.name}` : `${b.name} is local now`, `take:${b.ref}`);
    if (!ok) return;
    reloadRemoteBranches(); reloadBranches();
    // Checking out moved the working tree — the Changes view is now the thing
    // worth looking at, the same as it is after a checkout from the Branches tab.
    if (how === "checkout") setView("changes");
  };

  const openWorktree = (w: GitWorktree) => { setRoot(w.path); setSelKey(null); setView("changes"); };

  /**
   * One place where an action id becomes something happening.
   *
   * The hover button, the right-click menu and the palette all call this with
   * an id from lib/gitActions.ts, which is what stops the three from drifting:
   * a new action is one entry in the catalogue and one case here, and it shows
   * up in all three surfaces at once. The ids that are not here cannot be
   * produced for a branch — the catalogue only offers `push` on the branch you
   * are standing on, and the row for that branch has no button at all.
   */
  const branchAction = (id: string, b: GitBranch) => {
    const wt = wtByBranch.get(b.name);
    switch (id) {
      case "checkout": return void checkout(b.name);
      case "open-worktree": return void (wt && openWorktree(wt));
      case "worktree-new": {
        // Sibling directory named repo-branch, the same shape the Worktrees tab
        // makes, so the two do not produce different layouts on disk.
        const path = `${root}-${b.name.replace(/[\/\s]+/g, "-")}`;
        return void act(() => api.gitWorktreeAdd(root, path, b.name, false), `Worktree ${wtName(path)}`);
      }
      case "compare": return setCompareTarget(b.name);
      case "merge": return void mergeBranch(b.name);
      case "rebase": return void rebaseBranch(b.name);
      case "push": return void act(() => api.gitPush(root), "pushed", "push");
      case "publish": return void act(() => api.gitPush(root), "published", "push");
      case "pull": return void act(() => api.gitPull(root), "pulled", "pull");
      case "open-web": return openBranchOnWeb(b);
      case "copy-name": return void navigator.clipboard?.writeText(b.name).catch(() => { /* no clipboard permission */ });
      case "rename": return void renameBranch(b.name);
      case "delete": return void deleteBranch(b);
    }
  };
  // The lazygit move: a branch already checked out in a worktree can't be
  // `git checkout`ed here (git refuses a branch that is out elsewhere), so
  // switching to it OPENS that worktree; otherwise it is a plain checkout.
  const switchTo = (b: GitBranch) => { const wt = wtByBranch.get(b.name); if (wt && wt.path !== root) openWorktree(wt); else checkout(b.name); };
  // stashes
  const reloadStashes = () => api.gitStashes(root).then((r) => setStashes(r.stashes)).catch(() => {});
  const stashPush = async () => { if (await act(() => api.gitStashPush(root, ""), "Stashed")) reloadStashes(); };
  const stashOp = async (op: "apply" | "pop" | "drop", index: number) => {
    if (op === "drop" && !(await ask({ title: "Drop this stash?", body: "The stashed changes are gone.", command: `git stash drop ${quoteRef(`stash@{${index}}`)}`,irreversible: true, danger: true, confirmLabel: "Drop" }))) return;
    const fn = op === "apply" ? api.gitStashApply : op === "pop" ? api.gitStashPop : api.gitStashDrop;
    const hash = stashes.find((x) => x.index === index)?.hash;
    if (await act(() => fn(root, index), pastTense(op))) reloadStashes();
    else if (op !== "drop") { setAppliedStash(hash); reloadStashes(); }
  };
  const stashRename = async (index: number, message: string) => {
    const to = await askText({ title: "Rename this stash", input: { label: "New label — the \"On <branch>: \" prefix is kept", initial: message }, confirmLabel: "Rename" });
    if (to && to.trim() && to.trim() !== message) act(() => api.gitStashRename(root, index, to.trim()), "Renamed stash").then((ok) => { if (ok) reloadStashes(); });
  };
  const stashToBranch = async (index: number) => {
    const name = await askText({ title: "Turn this stash into a branch", input: { label: "Branch name", initial: "wip-" + Date.now().toString(36) }, confirmLabel: "Branch it" });
    if (name && name.trim()) act(() => api.gitStashToBranch(root, index, name.trim()), `Branched ${name.trim()}`).then((ok) => { if (ok) { reloadStashes(); reloadBranches(); } });
  };
  const stashOverwrite = async (index: number, message: string) => {
    if (!(await ask({ title: "Apply this stash over your working tree?", body: `Anything you changed at the same paths is replaced by the stash's version of them (${message}).`, danger: true, confirmLabel: "Apply over" }))) return;
    const hash = stashes.find((x) => x.index === index)?.hash;
    act(() => api.gitStashApplyOverwrite(root, index), "Applied over").then((ok) => { if (ok) reloadStashes(); else setAppliedStash(hash); });
  };
  /** The stash half of the catalogue. `show` reuses the selection the panel
   *  already has for a stash rather than opening a second viewer. */
  const stashAction = (id: string, s: GitStash) => {
    switch (id) {
      case "apply": return void stashOp("apply", s.index);
      case "pop": return void stashOp("pop", s.index);
      case "drop": return void stashOp("drop", s.index);
      case "to-branch": return void stashToBranch(s.index);
      case "overwrite": return void stashOverwrite(s.index, s.message);
      case "rename": return void stashRename(s.index, s.message.replace(/^[^:]*: /, ""));
      case "show": { const t = stashDetailTarget(s); return void (t && openCommit(t.hash, t.title)); }
      case "stash-resolve": return stashResolve();
      case "stash-put-back": return void stashPutBack();
      case "stash-files": return void loadStashFiles(s.hash);
    }
  };
  /** Paths the last apply left unmerged: what the tree says, with the stash still there. */
  const unmerged = useMemo(() => unmergedPaths([...(tree?.staged ?? []), ...(tree?.unstaged ?? [])], root), [tree, root]);
  useEffect(() => { if (!unmerged.length) setAppliedStash(undefined); }, [unmerged.length]);
  // The same entry a merge conflict uses: the block resolver in the Changes view.
  const stashResolve = () => { if (!unmerged.length) return; setView("changes"); if (blockFile !== unmerged[0]) void openBlocks(unmerged[0]!); };
  const stashPutBack = async () => {
    if (!unmerged.length || !(await ask({ ...putBackAsk(unmerged), danger: true, confirmLabel: "Put it back" }))) return;
    if (await act(() => api.gitStashPutBack(root), "Put your tree back")) { setBlockFile(null); setBlocks(null); setAppliedStash(undefined); }
  };
  const loadStashFiles = async (hash: string) => {
    setStashFiles({ hash, files: "loading" });
    try { const r = await api.gitStashFiles(root, hash); setStashFiles((cur) => (cur?.hash === hash ? { hash, files: r.files } : cur)); }
    catch (e) { console.warn("stash files failed:", e); setStashFiles((cur) => (cur?.hash === hash ? { hash, files: "failed" } : cur)); }
  };

  const stashPartialNow = async () => {
    const paths = [...partialSel];
    if (!paths.length) return;
    if (await act(() => api.gitStashPartial(root, paths, partialKeep), `Stashed ${paths.length} file${paths.length === 1 ? "" : "s"}`)) {
      setPartialSel(new Set());
      setPartialOpen(false);
      reloadStashes();
    }
  };
  // submodules
  const reloadSubmodules = () => api.gitSubmodules(root).then((r) => setSubmodules(r.submodules)).catch(() => {});
  const submoduleAddAsk = async () => {
    const url = await askText({ title: "Add a submodule", input: { label: "Clone URL" }, confirmLabel: "Add" });
    if (url === null) return;
    if (submoduleAddRefusal(url)) return void flash(false, submoduleAddRefusal(url)!);
    const path = await askText({ title: "Where should it live?", input: { label: "Submodule path (e.g. vendor/lib)", initial: url.trim().split("/").pop()?.replace(/\.git$/, "") || "" }, confirmLabel: "Add" });
    if (path === null) return;
    if (submoduleAddRefusal(url, path)) return void flash(false, submoduleAddRefusal(url, path)!);
    if (await act(() => api.gitSubmoduleAdd(root, url.trim(), path.trim()), `Added ${path.trim()}`)) reloadSubmodules();
  };
  const submoduleOp = async (op: "update" | "sync", path: string, okMsg: string) => {
    const fn = op === "update" ? api.gitSubmoduleUpdate : api.gitSubmoduleSync;
    if (await act(() => fn(root, path), okMsg)) reloadSubmodules();
  };
  const submoduleDeinitAsk = async (path: string) => {
    if (!(await ask({ title: `Unregister ${path}?`, body: "The checkout is removed, and so is any uncommitted work inside it. The gitlink and .gitmodules entry stay; Update brings the folder back.", command: `git submodule deinit -f -- ${quoteRef(path)}`, danger: true, confirmLabel: "Unregister" }))) return;
    if (await act(() => api.gitSubmoduleDeinit(root, path), `Deinitialized ${path}`)) reloadSubmodules();
  };
  const submoduleRemoveAsk = async (path: string) => {
    if (!(await ask({ title: `Remove ${path}?`, body: "The gitlink, its checkout and its .gitmodules section are all deleted.", danger: true, confirmLabel: "Remove" }))) return;
    if (await act(() => api.gitSubmoduleRemove(root, path), `Removed ${path}`)) reloadSubmodules();
  };
  // tags
  const reloadTags = () => api.gitTags(root).then((r) => setTags(r.tags)).catch(() => {});
  const createTag = async (name: string, message: string) => {
    // An empty message is a lightweight tag; a typed one makes it annotated.
    if (await act(() => api.gitTagCreate(root, name, { annotated: message.length > 0, message }), `Tagged ${name}`)) { setTagFormOpen(false); reloadTags(); }
  };
  const tagDeleteAsk = async (name: string) => {
    if (!(await ask({ title: `Delete tag ${name}?`, command: `git tag -d ${quoteRef(name)}`, body: "Removes the local ref only — the remote copy (if any) is untouched.", danger: true, confirmLabel: "Delete" }))) return;
    if (await act(() => api.gitTagDelete(root, name), `Deleted ${name}`)) reloadTags();
  };
  const tagPush = async (name: string) => {
    if (await act(() => api.gitTagPush(root, name), `Pushed ${name}`)) reloadTags();
  };
  const tagDeleteRemoteAsk = async (name: string) => {
    if (!(await ask({ title: `Delete ${name} on the remote?`, command: `git push origin --delete ${quoteRef(name)}`, body: "Runs push <remote> :refs/tags/<name>. The local tag stays.", danger: true, confirmLabel: "Delete remotely" }))) return;
    if (await act(() => api.gitTagDeleteRemote(root, name), `Deleted ${name} remotely`)) reloadTags();
  };
  /**
   * The ticked branches, deleted in one go.
   *
   * Sequential rather than parallel: the server has one thread, and nine
   * `git branch -d` fired at once is nine spawns queueing behind each other
   * anyway — with the difference that a failure halfway through a parallel
   * batch leaves you unable to say which ones went. `force` follows
   * merged-ness per branch, exactly as the single delete does, so a branch
   * whose commits are nowhere else still refuses.
   */
  const deletePicked = async () => {
    if (busy) return;
    const rows = bulk.can;
    if (!rows.length) return;
    const no = protectedRefusal(protectedBranches, rows.map((b) => b.name));
    if (no) { flash(false, no); return; }
    // The whole batch as one command line, before anything runs. Nine branches
    // is nine decisions and this is the one screen that can show all nine.
    const forced = rows.filter((b) => !(b.mergedIntoTrunk === true || trackChip(b.track).gone));
    const safe = rows.filter((b) => !forced.includes(b));
    const view = bulkDeleteView([...picked], bulk.held.map((b) => b.name));
    if (!(await ask({
      title: `Delete ${rows.length} branch${rows.length === 1 ? "" : "es"}?`,
      body: `git branch -d on ${safe.length}${forced.length ? `, git branch -D on ${forced.length}` : ""}.`
        + (forced.length ? `\n\nNot in the trunk: ${forced.map((b) => b.name).join(", ")}. Those need -D and cannot be recovered from here.` : ""),
      node: <NameList can={view.can} cannot={view.cannot} />,
      danger: true,
      confirmLabel: `Delete ${rows.length}`,
    }))) return;
    setBusy(true);
    let gone = 0;
    try {
      for (const b of rows) {
        setPending(`Delete ${b.name}`);
        const r = await api.gitBranchDelete(root, b.name, !(b.mergedIntoTrunk === true || trackChip(b.track).gone));
        if (r.ok) gone++;
      }
    } finally {
      setBusy(false);
      setPending(null);
      setPicked(new Set());
      flash(gone === rows.length, gone === rows.length ? `Deleted ${gone}` : `Deleted ${gone} of ${rows.length}`);
      reloadBranches();
    }
  };

  /** A changed file. `staged` decides the whole menu, so it is passed in rather
   *  than re-derived: the same path can be in both lists at once when part of
   *  it is staged, and the row knows which list it is in. */
  const fileAction = (id: string, c: GitFileChange, action: "stage" | "unstage") => {
    switch (id) {
      case "stage": case "unstage": return void (action === "stage" ? stage(c) : unstage(c));
      case "blame": return setBlamePath({ path: c.file_path });
      case "copy-path": return void navigator.clipboard?.writeText(relOf(c)).catch(() => { /* no clipboard permission */ });
      case "discard": return void discard(c);
    }
  };

  /** A branch that lives on the remote. The three ways to take it differ in one
   *  thing — what happens to the checkout you are standing in — which is what
   *  their labels say and what decides which one is the row's button. */
  const remoteBranchAction = (id: string, b: GitRemoteBranch) => {
    switch (id) {
      case "bring-local": return void takeRemote(b, "local");
      case "checkout": return void takeRemote(b, "checkout");
      case "worktree": return void takeRemote(b, "worktree");
      case "checkout-local": return void checkout(b.name);
      case "open-worktree": return b.worktree
        ? openWorktree({ path: b.worktree, branch: b.name, head: b.hash, current: false, bare: false, locked: false })
        : undefined;
      case "compare": return setCompareTarget(remoteCompareRef(b));
      case "copy-name": return void navigator.clipboard?.writeText(b.name).catch(() => { /* no clipboard permission */ });
    }
  };

  /** A remote, and a submodule. Both short, because both only offer what there
   *  is an endpoint for — see the note in the catalogue. */
  const remoteAction = (id: string, r: GitRemote) => {
    switch (id) {
      case "fetch": return void act(() => api.gitFetch(root, r.name), `fetched ${r.name}`, "fetch");
      case "copy-url": return void navigator.clipboard?.writeText(r.fetchUrl).catch(() => { /* no clipboard permission */ });
    }
  };
  const submoduleToolbarRun = (id: string) => {
    if (id === "submodule-add") return void submoduleAddAsk();
    if (id === "submodule-open-gitmodules") {
      void api.editorOpen(`${root}/.gitmodules`, 1).then((r) => { if (!r.ok) flash(false, r.error ? fail(r.error) : "Could not open .gitmodules"); }).catch((e) => flash(false, fail(String(e))));
    }
  };
  const submoduleAction = (id: string, s: GitSubmodule) => {
    switch (id) {
      case "update": return void submoduleOp("update", s.path, `Updated ${s.path}`);
      case "submodule-sync": return void submoduleOp("sync", s.path, `Synced ${s.path}`);
      case "submodule-deinit": return void submoduleDeinitAsk(s.path);
      case "submodule-remove": return void submoduleRemoveAsk(s.path);
      case "copy-path": return void navigator.clipboard?.writeText(s.path).catch(() => { /* no clipboard permission */ });
    }
  };

  /** The worktree half. Small on purpose: a checkout is a place, not a thing
   *  with a life cycle, and the two things you do with a place are go to it and
   *  stop keeping it. */
  const worktreeAction = (id: string, w: GitWorktree) => {
    switch (id) {
      case "open": return openWorktree(w);
      case "copy-path": return void navigator.clipboard?.writeText(w.path).catch(() => { /* no clipboard permission */ });
      case "remove": return void removeWorktree(w);
      case "worktree-unlock": return void unlockWorktree(w);
      case "worktree-force-remove": return void forceRemoveWorktree(w);
    }
  };

  /** Same contract as `branchAction`, for a tag: an id from the catalogue in,
   *  something happening out. Both deletes ask first — the menu shows the git
   *  and waits — which the three glyph buttons on the row never did. */
  const tagAction = (id: string, t: GitTag) => {
    switch (id) {
      case "checkout": return void checkout(t.name);
      case "compare": return setCompareTarget(t.name);
      case "push": return void tagPush(t.name);
      case "copy-name": return void navigator.clipboard?.writeText(t.name).catch(() => { /* no clipboard permission */ });
      case "copy-sha": return void navigator.clipboard?.writeText(t.hash).catch(() => { /* no clipboard permission */ });
      case "delete": return void tagDeleteAsk(t.name);
      case "delete-remote": return void tagDeleteRemoteAsk(t.name);
    }
  };

  /**
   * Everything the palette can offer, from every section at once.
   *
   * Declared AFTER the four dispatchers on purpose: they are `const`, so
   * reading them above their declaration is a temporal-dead-zone crash at
   * render — the kind that shows up as a black window rather than as an error
   * anyone can read. The typecheck catches it; the ordering is what keeps it
   * caught.
   *
   * Branches come from the FULL list rather than the filtered one: the palette
   * is how you reach a branch without first finding the view it lives in, and
   * filtering it by the search box above would make it a slower copy of that
   * search. Each row carries the same closure its own menu uses, so an action
   * run from here and from the row are one code path.
   */
  const paletteRows = useMemo<PaletteRow[]>(() => [
    ...branchData.branches.map((b) => {
      const wt = wtByBranch.get(b.name);
      return {
        kind: "branch" as const,
        name: b.name,
        state: branchState(b, b.name === currentBranchName, !!(wt && wt.path !== root), wt?.busy),
        run: (id: string) => branchAction(id, b),
      };
    }),
    ...tags.map((t) => ({ kind: "tag" as const, name: t.name, run: (id: string) => tagAction(id, t) })),
    ...stashes.map((s) => ({ kind: "stash" as const, name: s.ref, run: (id: string) => stashAction(id, s) })),
    ...worktrees.map((w) => ({ kind: "worktree" as const, name: w.path, state: { current: w.current }, run: (id: string) => worktreeAction(id, w) })),
    ...remotes.map((r) => ({ kind: "remote" as const, name: r.name, run: (id: string) => remoteAction(id, r) })),
    ...submodules.map((s) => ({ kind: "submodule" as const, name: s.path, run: (id: string) => submoduleAction(id, s) })),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the dispatchers are
    // recreated every render by design; depending on them would rebuild this list
    // on every keystroke in the panel.
  ], [branchData.branches, tags, stashes, worktrees, remotes, submodules, wtByBranch, currentBranchName, root]);

  /** Capture the tree as a named checkpoint — touches nothing, restore is
   *  always possible, cap is 30. */
  const snapshotNow = async () => {
    const label = snapshotLabel.trim();
    const ok = await act(() => api.gitSnapshotCreate(root, label || undefined), label ? `Snapshot "${label}"` : "Snapshot", "snapshot");
    if (ok) {
      setSnapshotLabel("");
      api.gitSnapshots(root).then((r) => setSnapshots(r.snapshots ?? [])).catch(() => {});
      api.gitStashes(root).then((r) => setStashes(r.stashes)).catch(() => {});
    }
  };

  /** Repo-relative, which is what the tree nests on — the change list carries
   *  absolute paths. Declared here because the memo below reads it on the very
   *  first render; further down it is still in its dead zone and touching it
   *  throws before anything paints. */
  const relOf = (c: GitFileChange) => (c.file_path.startsWith(root + "/") ? c.file_path.slice(root.length + 1) : c.file_path);

  /**
   * The files in the order they are actually on screen.
   *
   * `all` is git's own order — every staged change, then every unstaged one,
   * with untracked files trailing at the end. The tree renders something else
   * entirely: directories first, alphabetical within each, and nothing at all
   * inside a folded directory. Navigating `all` while reading the tree means
   * `j` jumps somewhere the eye isn't, and on a repo with untracked files it
   * walks those as a separate run — which is exactly what it looked like.
   *
   * Built from the same call the renderer uses, so the two cannot drift apart.
   * Directory rows are dropped: they have no diff to show, and skipping over
   * them is what makes a fold act like the shortcut it is.
   */
  const visibleFiles = useMemo(() => {
    if (!treeMode) return all;
    const files = (changes: GitFileChange[]) =>
      visibleRows(buildFileTree(changes, relOf), collapsed)
        .filter((r) => r.node.kind === "file")
        .map((r) => (r.node as { change: GitFileChange }).change);
    return [...files(tree?.staged ?? []), ...files(tree?.unstaged ?? [])];
  }, [treeMode, all, tree, collapsed, root]);

  // keyboard nav (changes view) — lazygit-like: j/k move, s stage, u unstage, x discard
  const moveSel = (dir: 1 | -1) => {
    const list = visibleFiles;
    if (!list.length) return;
    const i = Math.max(0, list.findIndex((c) => selected && keyOf(c) === keyOf(selected)));
    const n = list[(i + dir + list.length) % list.length];
    if (n) { setSelKey(keyOf(n)); requestAnimationFrame(() => frameRef.current?.querySelector('[data-file="active"]')?.scrollIntoView({ block: "nearest" })); }
  };
  /**
   * lazygit's keyboard model, minus the keys a browser refuses to give up.
   *
   * Three rules the research made clear and that are easy to get wrong:
   *   * `[` / `]` cycle *sub-tabs* within a group. `h`/`l` do NOT — in lazygit
   *     they move between panels, and only mean "hunk" inside the staging view.
   *   * `1`–`5` jump to a panel group, landing on whichever of its tabs you
   *     were last on, rather than always resetting to the first.
   *   * `?` opens the contextual action list. `x` is *discard* in current
   *     lazygit, so binding it to a menu would put a destructive key where
   *     muscle memory expects a harmless one.
   *
   * No ctrl-chords anywhere: ctrl+w/t/r/p/s/f are all reserved by the browser
   * and can't be reliably intercepted.
   */
  const onKey = (e: React.KeyboardEvent) => {
    const el = e.target as HTMLElement | null;
    // ⌘K first, and before the input guard: the palette is the one key that
    // should work while the cursor sits in the search box, because that is
    // exactly where you are when you realise you want to DO something to what
    // you were looking for rather than keep looking.
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      // The app's own Ctrl+K listens on window; without this both palettes opened.
      e.stopPropagation();
      setPaletteOpen(true);
      return;
    }
    if (/input|textarea|select/i.test(el?.tagName ?? "") || el?.isContentEditable) return;
    if (commitView) return;
    // Conflict mode owns the keyboard while it is up: its own 1..4/e/n/p would
    // otherwise also switch tabs underneath it, to views that are not rendered.
    if (inConflict) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key;

    // --- navigation, live in every view ---
    //
    // A number per tab, not per group. lazygit numbers 1–5 because it has five
    // *stacked panels*, each with its own sub-tabs; this is one row of eight
    // equal-looking buttons, so numbering the groups left Reflog, Remotes and
    // Tags unreachable by number for a reason nothing on screen explained. The
    // rule that survives translation is "the number you can see takes you
    // there" — which is why the tabs render their index.
    if (k >= "1" && k <= "8") {
      const v = ALL_VIEWS[Number(k) - 1];
      if (v) { e.preventDefault(); setView(v); }
      return;
    }
    if (k === "]" || k === "[") {
      e.preventDefault();
      const i = ALL_VIEWS.indexOf(view);
      setView(ALL_VIEWS[(i + (k === "]" ? 1 : ALL_VIEWS.length - 1)) % ALL_VIEWS.length]);
      return;
    }
    if (k === "@") { e.preventDefault(); setLogOpen((v) => !v); return; }
    if (k === "?") { e.preventDefault(); setHelpOpen((v) => !v); return; }
    if (k === "Escape" && (helpOpen || logOpen)) { e.preventDefault(); setHelpOpen(false); setLogOpen(false); return; }
    if (k === "R") { e.preventDefault(); loadTree(root); loadView(); return; }

    const lower = k.toLowerCase();

    // --- the list views: one cursor, moved the same way everywhere ---
    if (view !== "changes") {
      const n = rowCount;
      if (!n) return;
      if (lower === "j" || k === "ArrowDown") { e.preventDefault(); setRowIdx((i) => Math.min(n - 1, i + 1)); }
      else if (lower === "k" || k === "ArrowUp") { e.preventDefault(); setRowIdx((i) => Math.max(0, i - 1)); }
      else if (k === "Home") { e.preventDefault(); setRowIdx(0); }
      else if (k === "End") { e.preventDefault(); setRowIdx(n - 1); }
      else if (hasRowAction) {
        // `space` is the view's main action (checkout / apply / open), `d` is
        // remove — both go through the same confirm the buttons use.
        if (k === " ") { e.preventDefault(); rowAction("primary"); }
        else if (lower === "d") { e.preventDefault(); rowAction("delete"); }
      }
      else if (view === "log") {
        // `c` picks the commit under the cursor for a series cherry-pick —
        // same toggle the mouse does. Nothing else in this view takes a key,
        // so the bar's hints can claim it without competition.
        if (lower === "c") {
          e.preventDefault();
          const l = logCommits[Math.min(rowIdx, logCommits.length - 1)];
          if (l?.hash) setPickSet((prev) => {
            const next = new Set(prev);
            next.has(l.hash!) ? next.delete(l.hash!) : next.add(l.hash!);
            return next;
          });
        }
      }
      return;
    }

    // --- the changes view owns the rest ---
    if (lower === "j" || k === "ArrowDown") { e.preventDefault(); moveSel(1); }
    else if (lower === "k" || k === "ArrowUp") { e.preventDefault(); moveSel(-1); }
    else if (k === "`") { e.preventDefault(); setTreeMode((v) => !v); }
    else if (k === "-" && treeMode) { e.preventDefault(); setCollapsed(new Set(allDirPaths(buildFileTree(all, relOf)))); }
    else if ((k === "=" || k === "+") && treeMode) { e.preventDefault(); setCollapsed(new Set()); }
    // Space is lazygit's stage/unstage toggle; s/u kept as the directional pair
    // this panel already taught people.
    else if ((k === " " || lower === "s") && selected && writeEnabled && !selected.staged) { e.preventDefault(); stage(selected); }
    else if ((k === " " || lower === "u") && selected && writeEnabled && selected.staged) { e.preventDefault(); unstage(selected); }
    else if (lower === "x" && selected && writeEnabled && !selected.staged) { e.preventDefault(); discard(selected); }
    // lazygit's `e`. Lowercase only: `E` stays free for an "edit in a new
    // instance" variant if that ever turns out to be wanted.
    // `e`, as lazygit has it — but it opens the editor HERE rather than
    // shouting at one somewhere else, so it no longer depends on there being an
    // nvim already running.
    else if (k === "e" && selected) { e.preventDefault(); editFile(selected); }
  };

  // Which tab each group was last left on, so 1–5 returns you where you were.
  const lastTab = useRef<(View | undefined)[]>([]);
  useEffect(() => {
    const i = VIEW_GROUPS.findIndex((g) => g.views.includes(view));
    if (i >= 0) lastTab.current[i] = view;
  }, [view]);

  // interactive hunk staging (unified view, modified files)
  const applyHunk = async (action: "stage" | "unstage" | "discard", i: number) => {
    if (!selected || !writeEnabled) return;
    if (action === "discard" && !(await ask({ title: "Discard this hunk?", irreversible: true, danger: true, confirmLabel: "Discard" }))) return;
    act(() => api.gitApplyHunk(root, selected.file_path, selected.staged, action, selected.hunks[i]), `${pastTense(action)} hunk`);
  };
  const hunkBtn = (label: ReactNode, tint: string, onClick: () => void, id: string) => (
    <button key={id} data-hunk={id} onClick={onClick} className="inline-flex items-center text-[10px] px-1.5 rounded" style={{ height: 18, fontFamily: "system-ui, sans-serif", color: tint, background: "color-mix(in srgb, var(--bg3) 70%, transparent)", border: EDGE }}>{label}</button>
  );
  const hunkActionFn = (writeEnabled && selected && selected.status === "modified" && !selected.binary)
    ? (i: number) => (
        <span className="inline-flex items-center gap-1">
          {hunkActionsFor(selected.staged).map((a) => hunkBtn(
            <IconLabel icon={a.icon === "minus" ? <MinusIcon size={ICON.xs} /> : a.icon === "plus" ? <PlusIcon size={ICON.xs} /> : <UndoIcon size={ICON.xs} />}>{a.label}</IconLabel>,
            a.kind === "danger" ? "var(--error)" : "var(--text)", () => applyHunk(a.id.replace("-hunk", "") as "stage" | "unstage" | "discard", i), a.id))}
        </span>
      )
    : undefined;

  const repoRef = repos.find((r) => r.root === root);
  const branch = tree?.branch;
  // The header is showing another worktree's numbers until this lands.
  const treeStale = treeFor !== root;
  /**
   * Behind a remote copy *of this branch* — the only case where merging the
   * base is the wrong move, because that copy has already merged what you are
   * about to merge again.
   *
   * A branch that tracks the trunk directly is not that case: its upstream IS
   * the base, so "behind upstream" and "behind base" are the same commits and
   * the merge is exactly how you close them. Treating the two alike disabled
   * the button on every local-only branch and sent people to a pull that
   * cannot run — `pull --ff-only` refuses the moment you are also ahead.
   *
   * `undefined` means a server too old to answer: keep the old, careful
   * behaviour rather than assuming.
   */
  const twinBehind = !!branch && branch.behind > 0 && branch.upstreamIsBase !== true;
  const toggleDir = (path: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      next.has(path) ? next.delete(path) : next.add(path);
      return next;
    });

  /** One staged/unstaged group, as a tree or as the old flat list. Both paths
   *  emit the same FileRow, so selection, staging and the diff pane don't know
   *  which mode they're in. */
  const shownStaged = (tree?.staged ?? []).filter((c) => pathMatches(c.file_path, q));
  const shownUnstaged = (tree?.unstaged ?? []).filter((c) => pathMatches(c.file_path, q));
  const renderFiles = (changes: GitFileChange[], action: "stage" | "unstage", prefix: string) => {
    const row = (c: GitFileChange, depth?: number) => (
      <FileRow key={prefix + c.file_path} c={c} root={root} depth={depth}
        desc={descMap.get(c.file_path)?.description} active={activeKey === keyOf(c)}
        onSelect={() => setSelKey(keyOf(c))}
        ticked={ticked.has(keyOf(c))} onTick={() => tick(c)}
        onBlame={writeEnabled ? () => setBlamePath({ path: c.file_path }) : undefined}
        onMenu={(x, y) => setRowMenu({
          kind: "file", name: relOf(c), state: { merged: action === "unstage", untracked: c.status === "untracked" },
          x, y,
          run: (id) => fileAction(id, c, action),
        })} />
    );
    if (!treeMode) return changes.map((c) => row(c));
    return visibleRows(buildFileTree(changes, relOf), collapsed).map(({ node, depth }) =>
      node.kind === "dir"
        ? <DirRow key={prefix + "d:" + node.path} name={node.name} depth={depth} count={node.count}
            collapsed={collapsed.has(node.path)} onToggle={() => toggleDir(node.path)} />
        : row(node.change, depth));
  };

  // Long lists are rendered a screenful at a time — see useIncremental. These
  // are the four that actually get long on a real repo (787 remote branches,
  // 500 commits, 200 reflog entries, 125 tags).
  // The search and the sort are part of the identity: without them the
  // incremental window keeps the first N rows of the PREVIOUS list, so
  // typing filters a page you are no longer looking at.
  const incBranches = useIncremental(shownBranches, `${root}:${q}:${sort}`);

  /*
   * Group the branches, but only when grouping says something.
   *
   * Two conditions, and both are about the repository rather than about taste:
   * enough branches that the list is a scroll (8), and more than one family in
   * it. A repository whose branches are all `feat/` gets one heading over
   * everything, which is a heading that means nothing; one with six branches
   * does not need furniture. Searching turns it off too — a search result is
   * already a filtered list and grouping it hides how few hits there were.
   */
  const grouping = sort === "recent" && !q.trim() && incBranches.rows.length > RECENT_COUNT + 1;
  const branchPlan = useMemo(
    () => (grouping ? sectionBranches(incBranches.rows, currentBranchName) : null),
    [grouping, incBranches.rows, currentBranchName],
  );
  /** The rows in the order they are drawn: the cursor, the inspector and the dock all index into this. */
  const listBranches = branchPlan?.order ?? incBranches.rows;
  const banner = goneBanner(goneMerged.length, branchData.trunk);
  /** The ticked branches that a bulk delete can actually deliver, and the ones
   *  git would refuse. Both counts are shown, because a button that says 9 and
   *  deletes 7 is the bug this split exists to avoid. */
  const bulk = useMemo(() => {
    const rows = incBranches.rows.filter((b) => picked.has(b.name));
    return bulkDeletable(rows, (b) => branchState(b, b.name === currentBranchName, !!(wtByBranch.get(b.name) && wtByBranch.get(b.name)!.path !== root)));
  }, [incBranches.rows, picked, currentBranchName, wtByBranch, root]);
  const [logSel, setLogSel] = useState<string | null>(null);
  const logSearch = useLogSearch(graph, q, logSel);
  const incGraph = useIncremental(logSearch.lines, root);
  const shownReflog = useMemo(() => reflog.filter((e) => reflogMatches(e, q)), [reflog, q]);
  const incReflog = useIncremental(shownReflog, root);
  const incTags = useIncremental(shownTags, `${root}:${q}:${sort}`);
  useEffect(() => {
    if (!open || !root || (view !== "log" && view !== "reflog" && view !== "branches")) return;
    api.gitProtectedBranches(root).then((r) => setProtectedBranches(r.branches ?? [])).catch(() => setProtectedBranches([]));
  }, [open, root, view]);
  // Which tags the remote has. Only asked when a remote exists, so a repository
  // with none never starts a process; a failed answer is "unknown", not "only here".
  useEffect(() => {
    if (!open || !root || view !== "tags") return;
    let live = true;
    api.gitRemotes(root)
      .then((r) => (r.remotes.length ? api.gitTagsOrigin(root).then((t) => ({ asked: true, list: t.tags })) : { asked: false, list: [] }))
      .catch(() => ({ asked: true, list: [] as GitTagOrigin[] }))
      .then((o) => { if (live) setTagOrigins(o); });
    return () => { live = false; };
  }, [open, root, view, tags]);
  const originOf = (name: string): GitTagOrigin | undefined =>
    tagOrigins.asked ? tagOrigins.list.find((t) => t.name === name) ?? { name, onOrigin: "unknown" } : undefined;
  // The Log and Reflog dock: what is picked, and the one row of buttons for it.
  const logCommits = useMemo(() => incGraph.rows.filter((l) => !!l.hash), [incGraph.rows]);
  const logCursor = logCommits[Math.min(rowIdx, logCommits.length - 1)];
  useEffect(() => { if (logCursor?.hash) setLogSel(logCursor.hash); }, [logCursor?.hash]);
  // One commit picked: the dock acts on it, not on wherever the cursor has moved to.
  const logCur = dockTarget(logCommits, pickSet, logCursor);
  const reflogCur = incReflog.rows[Math.min(rowIdx, incReflog.rows.length - 1)];
  const pickOrder = useMemo(() => pickNumbers(pickSet, graph.filter((l) => !!l.hash).map((l) => l.hash!)), [pickSet, graph]);
  const dockRepo = { dirty: tree ? !tree.clean : false, detached: !!tree?.branch.detached, branch: tree?.branch.name, protectedBranches };
  /*
    * Whose history this is.
    *
    * The pane used to run `--all` and say nothing about it,
    * so from a worktree on a ticket branch you got 500
    * commits belonging to every branch in the repo — your own
    * branch nowhere near the top — with no clue that was even
    * the question being answered. Naming the branch is half
    * the fix; the toggle is the other half, because "show me
    * the whole graph" is a real thing to want, just not the
    * default.
    */
  const dockFor = view === "reflog"
    ? dockActionsFor("reflog", { count: reflogCur ? 1 : 0 }, dockRepo)
    : dockActionsFor("log", { count: logCur ? 1 : 0 }, dockRepo);
  // The Changes dock: one file picked at a time, so the count is 0 or 1.
  const dockFiles = tickedChanges.length ? tickedChanges : selected ? [selected] : [];
  const one = dockFiles.length === 1 ? dockFiles[0] : undefined;
  const changesDock = dockActionsFor("changes", {
    count: dockFiles.length, staged: dockFiles[0]?.staged, untracked: one?.status === "untracked", path: one ? rel(one) : undefined,
  }, dockRepo);
  /** The dock runs the same handlers as the row menu; Discard asks once there. */
  const changesRun = async (id: string) => {
    if (dockFiles.length > 1) {
      const paths = dockFiles.map(rel);
      const n = `${paths.length} files`;
      if (id === "stage") await act(() => api.gitStage(root, paths), `Staged ${n}`);
      else if (id === "unstage") await act(() => api.gitUnstage(root, paths), `Unstaged ${n}`);
      else if (id === "discard" && await ask({ title: `Discard changes to ${n}?`, irreversible: true, danger: true, confirmLabel: "Discard" })) await act(() => api.gitDiscard(root, paths), "Discarded");
      else return;
      setTicked(new Set());
    } else if (one) fileAction(id, one, one.staged ? "unstage" : "stage");
  };
  /** The Log and Reflog dock runs the row menu's handlers; each red one (revert,
   *  reset) asks once, inside its own handler, so the dock must not ask again. */
  const dockRun = async (id: string) => {
    const hash = view === "reflog" ? reflogCur?.shortHash : logCur?.hash;
    const subject = (view === "reflog" ? reflogCur?.subject : logCur?.subject) ?? "";
    if (!hash) return;
    if (id === "reset-hard") return void resetTo(hash, "hard");
    runCommitAction(id, hash, subject);
  };
  // The Branches dock: ticked rows win over the cursor, and several ticked is one bulk dock.
  const pickOf = (b?: GitBranch): BranchPick | undefined => {
    if (!b) return undefined;
    const wt = wtByBranch.get(b.name);
    const t = trackChip(b.track);
    return { name: b.name, isCurrent: b.name === currentBranchName, held: !!wt && wt.path !== root, ahead: t.ahead, behind: t.behind, hasUpstream: !!b.upstream, busy: wt?.busy };
  };
  const curBranch = listBranches[Math.min(rowIdx, listBranches.length - 1)];
  const branchesDock = dockActionsFor("branches",
    branchSelection([...picked], pickOf(curBranch), (n) => pickOf(branchData.branches.find((b) => b.name === n))), dockRepo);
  /** Only one branch in the repository, and the list is not still loading. */
  const onlyBranch = branchData.branches.length === 1 && busyView !== "branches";
  const branchesRun = (id: string) => {
    if (picked.size > 1) {
      if (id === "clear") return setPicked(new Set());
      if (id === "copy-name") return void navigator.clipboard?.writeText([...picked].join("\n")).catch(() => { /* no clipboard permission */ });
      if (id === "delete") return void deletePicked();
      return;
    }
    const b = picked.size === 1 ? branchData.branches.find((x) => x.name === [...picked][0]) : curBranch;
    if (!b) return;
    if (id === "branch-remove-and-delete") return void removeAndDelete(b);
    branchAction(id, b);
  };
  const curTag = incTags.rows[Math.min(rowIdx, incTags.rows.length - 1)];
  const tagsDock = dockActionsFor("tags", tagSelection(curTag, curTag ? originOf(curTag.name) : undefined), dockRepo);
  // Submodules, Worktrees, Stashes: same shape as Tags, one list + inspector + dock each.
  const curSub = shownSubmodules[Math.min(rowIdx, shownSubmodules.length - 1)];
  const submodulesDock = dockActionsFor("submodules", submoduleSelection(curSub?.path), dockRepo);
  const curWt = shownWorktrees[Math.min(rowIdx, shownWorktrees.length - 1)];
  const worktreesDock = dockActionsFor("worktrees", worktreeSelection(curWt, wtRefused), dockRepo);
  const curStash = shownStashes[Math.min(rowIdx, shownStashes.length - 1)];
  const stashesDock = dockActionsFor("stashes", stashSelection(curStash, !!curStash && stashClashes(unmerged.length, curStash.hash, appliedStash)), dockRepo);
  const curStashHash = curStash?.hash;
  useEffect(() => { if (view === "stashes" && curStashHash) void loadStashFiles(curStashHash); }, [view, curStashHash, root]); // eslint-disable-line react-hooks/exhaustive-deps
  /** Fetch from, and Copy the URL of, the remote picked in the strip. */
  const remoteToolbarRun = (id: string) => {
    const r = remotes.find((x) => x.name === remoteSel);
    if (r) remoteAction(id === "remote-fetch" ? "fetch" : "copy-url", r);
  };
  /**
   * The remote's branches, filtered here rather than on the server.
   *
   * 790 of them arrive in one response and a repo's branch names are how people
   * actually search — "20343", "phone", a colleague's prefix — so this is a
   * substring match over name, subject and author, all terms having to hit. A
   * round trip per keystroke would be slower and no more correct.
   */
  const shownRemoteBranches = useMemo(() => {
    const q = remoteQuery.trim().toLowerCase();
    if (!q) return notHereFirst(remoteRows);
    const terms = q.split(/\s+/);
    return notHereFirst(remoteRows.filter((b) => {
      const hay = `${b.name} ${b.subject} ${b.author}`.toLowerCase();
      return terms.every((t) => hay.includes(t));
    }));
  }, [remoteRows, remoteQuery]);
  const incRemoteBranches = useIncremental(shownRemoteBranches, `${root}:${remoteSel}:${remoteQuery}`);
  const curRemote = incRemoteBranches.rows[Math.min(rowIdx, incRemoteBranches.rows.length - 1)];
  const remotesDock = dockActionsFor("remotes", remoteSelection(curRemote, root), dockRepo);

  /** How many rows the focused view has, so j/k knows where the end is. */
  const rowCount =
    view === "branches" ? shownBranches.length :
    view === "reflog" ? reflog.length :
    view === "tags" ? shownTags.length :
    view === "remotes" ? shownRemoteBranches.length :
    view === "stashes" ? shownStashes.length :
    view === "worktrees" ? shownWorktrees.length :
    view === "log" ? graph.length : 0;

  // A list that shrinks under the cursor (deleting branches, applying stashes)
  // would otherwise leave it pointing past the end.
  useEffect(() => { setRowIdx((i) => (rowCount ? Math.min(i, rowCount - 1) : 0)); }, [rowCount]);
  useEffect(() => { setRowIdx(0); setQ(""); setSort("recent"); setViewFail(null); setTagFormOpen(false); }, [view, root]);
  // The current branch moved (our checkout, the terminal, another window). The
  // working-tree poll notices before the 10s branch-list poll, so pull the list
  // forward the moment it changes — otherwise it sits crowning the branch you
  // just left, which reads as "it didn't switch" and blocks switching again.
  useEffect(() => {
    if (open && root && tree?.branch?.name) reloadBranches();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tree?.branch?.name]);
  // The repo picker is a switcher: repos + worktrees + local branches. It can be
  // opened from any view, so make sure the branch list is loaded when it is —
  // otherwise the branches section is empty everywhere but the Branches tab.
  const refreshPicker = useCallback(() => {
    if (!root) return;
    reloadBranches();
    /**
     * And the repo list itself, which is where each row's branch comes from.
     *
     * `reloadBranches()` refreshes the BRANCHES of the current checkout; the
     * "which branch is this repo on" beside each row is `GitRepoRef.branch`,
     * loaded with the repo list on mount and never again. So the picker showed
     * whatever was checked out when the view first opened — a checkout made
     * since, from this very panel, left it naming a branch you had already
     * left. It is the one line in the picker that claims to be live.
     */
    api.gitRepos().then(({ repos }) => { setRepos(repos); setReposError(null); }).catch(() => setReposError("Could not refresh the list. Showing the last one.")); // a stale list is kept rather than an empty one
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root]);
  // A different repo has different remotes: carrying the selection over asks for
  // branches from a remote this one may not even have.
  useEffect(() => { setRemoteSel(""); setRemoteRows([]); setRemoteQuery(""); }, [root]);

  /**
   * What `space` (the view's main action) and `d` (remove) do to the row under
   * the cursor — the same functions the mouse calls, so there is exactly one
   * code path per action and the keyboard can't drift from the buttons.
   *
   * Only defined for the views whose shortcut bar advertises them. A bar that
   * promises a key nothing implements is worse than no bar.
   */
  const rowAction = (kind: "primary" | "delete"): void => {
    if (!writeEnabled || busy) return;
    if (view === "branches") {
      const b = shownBranches[rowIdx];
      if (!b || b.name === currentBranchName) return;
      kind === "primary" ? switchTo(b) : deleteBranch(b);
    } else if (view === "stashes") {
      const s = shownStashes[rowIdx];
      if (!s) return;
      stashOp(kind === "primary" ? "apply" : "drop", s.index);
    } else if (view === "worktrees") {
      const w = shownWorktrees[rowIdx];
      if (!w || (kind === "delete" && w.current)) return;
      kind === "primary" ? openWorktree(w) : removeWorktree(w);
    } else if (view === "remotes") {
      // Only the harmless one gets a key. Checking out and creating a worktree
      // both move something on disk, and neither should be one keystroke away
      // from a list you scroll with j/k.
      const b = shownRemoteBranches[rowIdx];
      if (!b || b.local || kind === "delete") return;
      takeRemote(b, "local");
    }
  };
  const hasRowAction = view === "branches" || view === "stashes" || view === "worktrees" || view === "remotes";

  const COUNTS: Partial<Record<View, number>> = {
    changes: all.length, branches: branchData.branches.length, worktrees: worktrees.length,
    stashes: stashes.length, tags: tags.length,
    // Branches on the remotes, not how many remotes there are. "1" over a pane
    // listing 789 branches was the tab counting the wrong noun: every other tab
    // counts the rows you are about to see, and this one counted the heading.
    // Summed across remotes for the fork setup, where the answer is "everything
    // you can reach", not "everything on whichever one is selected".
    remotes: remotes.reduce((n, r) => n + r.branches, 0),
  };
  /**
   * One tab: the key that gets you there, the name, and the count raised on the
   * name as a footnote.
   *
   * Two problems, one shape. The count used to be a chip beside the label,
   * which cost ~28px per counted tab — eight tabs plus a 60-character branch
   * name plus fetch/pull/push did not fit, so the strip scrolled and "Stashes"
   * was permanently a sliver reading "8 S" behind the branch chip. Moving the
   * count onto a second line fixed the width and bought a different problem:
   * eight bordered boxes, each with an outlined keycap and an internal rule,
   * and a dead empty line under the two tabs that have no count. That read as
   * a row of controls rather than a tab strip.
   *
   * As a superscript the count is an attribute of the name instead of a second
   * value competing with the jump key, so the box, the keycap outline and the
   * rule can all go — and the tabs that have no count simply have no
   * superscript, with nothing left for the absence to be a hole in. Measured
   * against the previous design in a mock of the real 1900px header: 686px vs
   * 746px, comfortably inside the ~890px the strip actually gets.
   *
   * The padding is deliberately top-heavy (7px over 4px): the raised digits
   * need that room, or the active tab's tint clips through them.
   */
  const ViewTab = ({ id }: { id: View }) => {
    const n = COUNTS[id];
    const num = ALL_VIEWS.indexOf(id) + 1;
    const on = view === id;
    /*
     * A segmented control, not a row of words.
     *
     * These were 10.5px labels with a superscript count and a leading digit,
     * all in three greys — nine of them in a line, and picking one meant
     * reading all nine. Now the selected one is a filled pill and the count is
     * a real badge, so which section you are in is answered by shape and the
     * counts are readable at arm's length. The digit shortcut moved into the
     * tooltip: it is a thing you learn once, not a thing you read every time.
     */
    return (
      <button onClick={() => setView(id)} title={`${VIEW_LABEL[id]}${n ? ` (${n})` : ""} — press ${num}`}
        aria-keyshortcuts={String(num)} aria-selected={on} role="tab"
        className="text-[11px] leading-none rounded-lg transition-all flex items-center gap-1.5 whitespace-nowrap shrink-0 font-medium px-3 min-h-[28px]"
        style={{
          background: on ? "color-mix(in srgb, var(--primary) 18%, transparent)" : "transparent",
          border: `1px solid ${on ? "color-mix(in srgb, var(--primary) 42%, transparent)" : "transparent"}`,
          color: on ? "var(--text)" : "var(--text3)",
        }}>
        <span>{VIEW_LABEL[id]}</span>
        {!!n && (
          <span className="tabular-nums text-[9px] px-1.5 py-px rounded-full"
            style={{
              color: on ? "var(--primary-hover)" : "var(--text3)",
              background: on ? "color-mix(in srgb, var(--primary) 22%, transparent)" : "color-mix(in srgb, var(--text) 10%, transparent)",
            }}>{n}</span>
        )}
      </button>
    );
  };
  /** One group's tabs. Held together by proximity alone — 1px between siblings
   *  against the 9px between groups — which is enough to read "these three are
   *  one panel" now that the tabs themselves carry no border to compete with. */
  const ViewGroup = ({ views }: { views: View[] }) => (
    <div className="flex items-baseline gap-px">
      {views.map((v) => <ViewTab key={v} id={v} />)}
    </div>
  );

  const undoMerge = async () => {
    if (!branch) return;
    if (!(await ask({ title: `Undo the last merge on ${branch.name}?`, body: "The branch goes back to exactly where it was. Nothing has been pushed, so nothing anyone else has is affected.", confirmLabel: "Undo merge" }))) return;
    void act(() => api.gitUndoMerge(root), "merge undone", "undo");
  };
  // Name a branch at the commit a detached HEAD is on, then land on it.
  const makeBranchHere = async () => {
    const n = (await askText({ title: "Make a branch here", input: { label: "Branch name" }, confirmLabel: "Create & switch" }))?.trim();
    if (!n) return;
    if (await act(() => api.gitBranchCreate(root, n), `Created ${n}`)) { reloadBranches(); setView("changes"); }
  };
  // The situational items of the header, each built here (they close over this
  // panel's state) and ordered, capped and overflowed by GitHeader.
  const slotBisect = branch?.state === "bisecting" ? (
    <button
      onClick={() => setBisectOpen(true)}
      className="text-[11px] px-2.5 h-[26px] inline-flex items-center rounded-lg whitespace-nowrap shrink-0"
      style={{ color: "var(--warning-ink)", border: "1px solid color-mix(in srgb, var(--warning) 45%, transparent)" }}
      title="A bisect is in progress — mark the checked-out commit good or bad"
    ><IconLabel icon={<TargetIcon size={ICON.xs} />}>bisect</IconLabel></button>
  ) : null;
  /* Offered only while undoing is exact: an unpushed merge
      at the tip, on a clean tree. Once anything is committed
      on top the tip is no longer the merge; once it is
      pushed the honest undo is a revert, not a rewrite.
      Deliberately a sibling of the sync block rather than
      inside it — nested there it inherited "there is
      something to merge" as a visibility condition and so
      vanished the instant a sync succeeded, which is exactly
      the moment it exists for. */
  const undoOff = !writeEnabled || busy;
  const slotUndo = branch?.canUndoMerge ? (
    <button
      onClick={() => void undoMerge()}
      disabled={undoOff}
      className="text-[11px] px-2 h-[26px] inline-flex items-center rounded-lg whitespace-nowrap shrink-0"
  style={{ color: "var(--text2)", border: EDGE, opacity: busy ? 0.5 : 1 }}
  title="Undo the last merge — the branch returns to exactly where it was. Offered only because it is unpushed and nothing sits on top of it.">
  {pending === "undo" ? "undoing…" : <IconLabel icon={<UndoIcon size={ICON.xs} />}>undo merge</IconLabel>}
    </button>
  ) : null;
  /*
    * The pull request for the branch you are standing on.
    *
    * Getting from a checkout to its review meant going to the
    * Pull requests view and finding it in a list of hundreds
    * that reorders itself by activity — for a branch whose
    * name is already on screen, two feet to the left.
    *
    * Shown only when there IS one. A button that leads to a
    * search returning nothing is worse than no button: it
    * makes you doubt the branch rather than the button.
    */
  /* Where it goes is `chipTarget`'s answer and not this
      line's — see the file, which carries the four
      screenshots. No fallback on the press: `from` only ever
      comes back on the one success path, and that path always
      names the repository, so a "we know the number but not
      the repository" case does not exist and a branch for it
      would be a lie the next reader has to keep alive. What
      it does instead is not draw the chip, because a button
      that leads nowhere is worse than no button. */
  const slotPr = prChip.kind === "open" ? (
    <button
      onClick={() => openPr(prChip.repo, prChip.pr.number)}
      className="text-[11px] px-2.5 h-[26px] rounded-lg whitespace-nowrap flex items-center gap-1.5"
      style={{ color: "var(--primary-ink)", border: "1px solid color-mix(in srgb, var(--primary) 40%, transparent)" }}
      title={`${prChip.pr.title} — open it in Pull requests`}>
      {/* The state as a dot rather than a word: the row is
          already dense and the colour is the whole message. */}
      {/*
        * Optional, and that is not defensiveness — it is the
        * shape of what this asks for.
        *
        * The lookup requests the cheap field set on purpose:
        * `statusCheckRollup` is a separate GraphQL walk per
        * pull request and measured four times the cost of the
        * rest put together, which is not a price worth paying
        * behind a chip. So there IS no rollup here, and
        * reading `checks.failure` off it threw at render and
        * took the whole Source control view to a black screen.
        */}
      {/* And so there is no dot either. It was drawn grey in
          every case, because `checks` is never here — and grey
          is this app's word for "nothing has reported", so a
          branch with three red checks looked exactly like one
          with no CI. An absent fact is not a state; the way to
          draw it is not to. */}
      PR #{prChip.pr.number}
    </button>
  ) : null;
  /* Nothing comes OUT of this branch, but things go INTO it.
      An integration branch is the ordinary case of that, and
      the answer to "where is my pull request" there is "there
      are twelve, and they land here". */
  const slotPrUnknown = prAskFailed && !branchPr && prsOntoBranch.length === 0 ? (
    <span className="text-[11px] px-2.5 h-[26px] inline-flex items-center rounded-lg whitespace-nowrap"
      title={`${prAskFailed} — so this header cannot say whether the branch has a pull request`}
      style={{ color: "var(--text4)", border: "1px dashed color-mix(in srgb, var(--text) 18%, transparent)" }}>
      PR unknown
    </span>
  ) : null;
  const slotPrsLand = !branchPr && prsOntoBranch.length > 0 ? (
    <button
      onClick={() => openPrs(currentBranchName)}
      className="text-[11px] px-2.5 h-[26px] rounded-lg whitespace-nowrap flex items-center gap-1.5"
      style={{ color: "var(--text2)", border: EDGE }}
      title={`${prsOntoBranch.length} open pull request${prsOntoBranch.length === 1 ? "" : "s"} merge into ${currentBranchName}:\n${prsOntoBranch.slice(0, 6).map((p) => `#${p.number} ${p.title}`).join("\n")}`}>
      <span style={{ color: "var(--text4)" }}>→</span>
      {prsOntoBranch.length} PR{prsOntoBranch.length === 1 ? "" : "s"} land here
    </button>
  ) : null;
  /* Update from base — merge master's latest into the branch
      you are on, in this checkout. Sits with fetch/pull/push
      because it belongs to the same family of "bring this
      checkout up to date"; it was only on the Worktrees tab
      before, which is not where anyone looks for it.
      Hidden when there is nothing to merge, and on the trunk
      itself, which has no base. */
  const syncOff = !writeEnabled || busy || !tree?.clean || twinBehind;
  const syncRun = () => { if (!syncOff && branch) void act(() => api.gitSyncBase(root), `merged ${branch.base}`, "sync"); };
  const slotSync = branch?.base && (branch.behindBase ?? 0) > 0 ? (
    <div className="relative flex items-center">
  {/* A merge over uncommitted work is refused by the
          server, so the button should not offer it. Saying
          why beats a click that produces an error toast —
          and the reason is the fix. */}
      <button
        onClick={syncRun}
        disabled={syncOff}
        className="text-[11px] px-2 h-[26px] inline-flex items-center rounded-l-[7px] whitespace-nowrap"
        style={{ color: "var(--warning-ink)", border: "1px solid color-mix(in srgb, var(--warning) 40%, transparent)", borderRight: "none", opacity: syncOff ? 0.45 : 1 }}
        title={!tree?.clean
          ? "Commit or stash your changes first — merging over uncommitted work is how you lose it"
          : twinBehind
          // Syncing while behind your own remote makes a
          // second merge commit for content the remote has
          // already merged — the two then have to be
          // reconciled. Pull is the move; sync afterwards if
          // anything is still missing.
          ? `Pull first — ${branch.behind} commit${branch.behind === 1 ? "" : "s"} on ${branch.upstream} you do not have. Syncing now would make a duplicate merge and diverge from it.`
          : `Merge ${branch.base} into ${branch.name}. Brings the base branch's latest commits into this one — a merge, not a rebase, so nothing already pushed is rewritten.`}>
        {pending === "sync" ? "syncing…" : `⇣ sync ↓${branch.behindBase}`}
      </button>
      {/* Not every branch is cut from trunk. This picks what
          to merge from and remembers it in the repo's own
          config, so the choice sticks per branch. */}
      <BasePicker
        branch={branch.name} base={branch.base} refs={baseRefs}
        onOpen={loadBaseRefs} error={baseRefsError} onRetry={loadBaseRefs}
        onPick={(name) => setBaseFor(branch.name, name)}
        disabled={!writeEnabled || busy}
        className="text-[11px] px-1.5 h-[26px] inline-flex items-center rounded-r-[7px]"
        style={{ color: "var(--warning-ink)", border: "1px solid color-mix(in srgb, var(--warning) 40%, transparent)" }}
        title={`Merging from ${branch.base} — pick a different base`} />
    </div>
  ) : null;

  const headerSlot: SlotEntries = {
    bisect: slotBisect ? { label: "Bisect", run: () => setBisectOpen(true), node: slotBisect } : undefined,
    undo: slotUndo ? { label: "Undo merge", run: () => { if (!undoOff) void undoMerge(); }, node: slotUndo } : undefined,
    pr: slotPr ? { label: `PR #${prChip.kind === "open" ? prChip.pr.number : ""}`, run: () => { if (prChip.kind === "open") openPr(prChip.repo, prChip.pr.number); }, node: slotPr } : undefined,
    "pr-unknown": slotPrUnknown ? { label: "PR unknown", node: slotPrUnknown } : undefined,
    "prs-land": slotPrsLand ? { label: `${prsOntoBranch.length} PR${prsOntoBranch.length === 1 ? "" : "s"} land here`, run: () => openPrs(currentBranchName), node: slotPrsLand } : undefined,
    sync: slotSync ? { label: `Sync from ${branch?.base ?? "base"}`, run: syncRun, node: slotSync } : undefined,
  };

  // Git has stopped in the middle of something. The conflict screen replaces the
  // header, so this strip is drawn on both: a stopped repo says so, with its way
  // out, wherever you are.
  const stateBanner = (
    <StateBanner state={mergeState} conflicts={conflictsLoaded ? conflicts.length : null} busy={busy} onAbort={abortMerge}
      onContinue={() => act(() => api.gitMergeContinue(root), "merge completed", "continue")} />
  );

  return (
    <div ref={frameRef} tabIndex={-1} onKeyDown={onKey}
      className="flex-1 min-h-0 flex flex-col outline-none overflow-hidden relative">
                <style>{SCROLLBAR_CSS}</style>
                {/*
                  * While git is stopped, this IS the panel.
                  *
                  * Not a strip of buttons above the ordinary view: that left
                  * fetch, push, stage, discard, branch-switch and the commit
                  * box all one click away in the middle of a merge, where each
                  * of them either fails with a message nobody reads or makes
                  * the situation worse. Reducing the screen to the decision in
                  * front of you is the point, not a side effect.
                  *
                  * The lockdown is not this line: the server refuses the same
                  * moves whoever asks. This is what stops you being offered
                  * them.
                  */}
                {inConflict ? (
                  <>
                  {stateBanner}
                  <ConflictMode
                    root={root}
                    branchName={currentBranchName || (branch?.name ?? "")}
                    merge={merge}
                    conflicts={conflicts}
                    staged={tree?.staged ?? []}
                    busy={busy}
                    writeEnabled={writeEnabled}
                    act={act}
                    ask={ask}
                    flash={flash}
                    onAskClaudeTerminal={askClaudeInTerminal}
                    terminalWindowLive={!!conflictWindow}
                    onOpenEditor={(relPath, line) => {
                      void api.editorOpen(`${root}/${relPath}`, line).then((r) => {
                        if (!r.ok) flash(false, r.error ? fail(r.error) : "Could not open the editor");
                      }).catch((e) => flash(false, fail(String(e))));
                    }}
                  />
                  </>
                ) : (
                <>
                <GitHeader
                  root={root} branch={branch} stateLabel={(st) => STATE_LABEL[st] ?? null}
                  writeEnabled={writeEnabled} busy={busy} treeStale={treeStale}
                  picker={
                    <CheckoutPicker
                      repos={repos}
                      value={root}
                      onPick={(r) => { setRoot(r); setSelKey(null); }}
                      branchLabel={currentBranchName || null}
                      branches={{ items: branchData.branches, disabled: busy || !writeEnabled, onCheckout: checkout, gone: (b) => trackChip(b.track).gone }}
                      onOpenChange={(o) => { if (o) refreshPicker(); }}
                      error={reposError} onRetry={refreshPicker}
                    />
                  }
                  tabs={VIEW_GROUPS.map((g) => <ViewGroup key={g.label} views={g.views} />)}
                  slot={headerSlot}
                  refresh={<RefreshButton onRefresh={refreshAll} busy={refreshing} done={refreshed}
                    title="Refresh this view and the working tree" />}
                  onBusy={setBusy}
                  onChanged={async () => { await loadTree(root); api.gitRepos().then(({ repos }) => setRepos(repos)).catch(() => {}); }}
                  flash={flash} onCopied={(n) => flash(true, `copied ${n}`)}
                  onOpenInsights={() => setInsightsOpen(true)}
                  onOpenRemotes={() => setView("remotes")} onOpenLog={() => setLogOpen(true)}
                  onMakeBranch={makeBranchHere}
                />
                {stateBanner}

                {view === "tidy" ? (
                  viewFail ? <ErrorFrame title="Tidy could not look" sentence={frameSentence(viewFail)} onRetry={() => void loadView()} />
                  : <TidyView report={tidy} root={root} busy={busyView === "tidy"} onRefresh={() => void loadView()} onOpenStashes={() => { setView("stashes"); setRowIdx(0); }} />
                ) : view === "changes" ? (
                  <div className="flex-1 min-h-0 flex flex-col">
                    <div className="shrink-0 flex items-center gap-2 px-3 py-2 border-b" style={{ borderColor: "color-mix(in srgb, var(--border) 40%, transparent)" }}>
                      <Segmented track label="File list layout" value={treeMode ? "tree" : "flat"} onChange={(v) => setTreeMode(v === "tree")}
                        options={[
                          { id: "tree", label: <IconLabel icon={<TreeIcon size={ICON.xs} />}>tree</IconLabel>, title: "File tree (`)" },
                          { id: "flat", label: <IconLabel icon={<ListIcon size={ICON.xs} />}>flat</IconLabel>, title: "Flat list (`)" },
                        ]} />
                      {treeMode && !!tree && !tree.clean && (
                        <>
                          <Button square size="compact" onClick={() => setCollapsed(new Set(allDirPaths(buildFileTree(all, relOf))))} title="Collapse all (-)" aria-label="Collapse all"><MinusIcon size={ICON.xs} /></Button>
                          <Button square size="compact" onClick={() => setCollapsed(new Set())} title="Expand all (=)" aria-label="Expand all"><PlusIcon size={ICON.xs} /></Button>
                        </>
                      )}
                      <Button className="ml-auto" onClick={() => explain(!!walk)} disabled={walkLoading || !tree || tree.clean}>
                        <IconLabel icon={<SparkleIcon size={ICON.xs} />}>{walkLoading ? "explaining…" : walk ? "Re-explain changes" : "Explain changes"}</IconLabel>
                      </Button>
                    </div>
                    {!tree ? (
                      treeFail
                        ? <StateFrame title="The changes could not be read" text="Git did not answer for this folder. Try again, or open the command log to see what it said." actions={<>{retryButton(() => void loadTree(root))}<button onClick={() => setLogOpen(true)} className={CHIP}>Open the command log</button></>} />
                        : <StateFrame busy title="Reading the working tree…" />
                    ) : tree.clean ? (
                      <CleanFrame sha={lastCommit?.shortHash}>
                        {lastCommit && <>Last commit {lastCommit.date}: “{lastCommit.subject}”. </>}
                        {branch?.ahead ? <>{branch.ahead} commit{branch.ahead === 1 ? "" : "s"} on <b>{branch.name}</b> {branch.ahead === 1 ? "is" : "are"} not on {branch.upstream ?? "the remote"} yet: push is in the top bar.</> : "Nothing to commit here."}
                      </CleanFrame>
                    ) : (
                  <div className="flex-1 min-h-0 flex">
                    <div className="shrink-0 flex flex-col min-h-0 agx-sidelist" style={{ width: sidebarW }}>
                      {(walk?.reviewFocus || walk?.error || !!walk?.withheld?.length) && (
                        <div className="shrink-0 px-2.5 py-2 border-b" style={{ borderColor: "color-mix(in srgb, var(--border) 40%, transparent)" }}>
                          {(walk?.reviewFocus || walk?.error) && (
                            <div className="text-[10px] leading-snug" style={{ color: walk?.error ? "var(--warning)" : "var(--text2)" }}>
                              {walk?.reviewFocus ? <><span className="t-dim2 uppercase tracking-wide text-[8.5px] mr-1">focus</span>{walk.reviewFocus}</> : walk?.error}
                            </div>
                          )}
                          {/* Named, not silently missing: a summary that covers
                              a different changeset than the one on screen is
                              worse than none, because it is the one you trust. */}
                          {!!walk?.withheld?.length && (
                            <div className="mt-1 text-[10.5px] leading-snug t-dim2">
                              Not sent: {walk.withheld.join(", ")} — credential files are kept out of the prompt.
                            </div>
                          )}
                        </div>
                      )}
                      <ListSearch q={q} onQ={setQ} placeholder="Search changed files by path…"
                        count={shownStaged.length + shownUnstaged.length} total={(tree?.staged.length ?? 0) + (tree?.unstaged.length ?? 0)}
                        note={selected && q.trim() !== "" && !pathMatches(selected.file_path, q) ? `${relOf(selected)} is open, not matching` : undefined} />
                      <div className="agx-scroll flex-1 min-h-0 overflow-y-auto py-1">
                        {/*
                          * Mid-merge, the list is about the conflict.
                          *
                          * A merge stages everything it merged: a branch four
                          * hundred commits behind arrives with four hundred rows
                          * and one file that needs a person — and that file is
                          * not even among them, because git emits an unmerged
                          * path as a combined diff this panel cannot parse. So
                          * the rows that matter are built from the conflict list
                          * itself, and everything the merge brought waits behind
                          * a count until it is asked for.
                          */}
                        {conflicts.length > 0 && (
                          <Section title="Conflicted" count={conflicts.length} tint="var(--warning)">
                            {conflicts.map((f) => {
                              const relPath = f.startsWith(root) ? f.slice(root.length + 1) : f;
                              const on = blockFile === relPath;
                              return (
                                <button key={f} onClick={() => void openBlocks(relPath)}
                                  className="w-full flex items-center gap-2 px-2.5 py-1 text-left hover:bg-white/5"
                                  style={on ? { background: "color-mix(in srgb, var(--warning) 14%, transparent)" } : undefined}
                                  title={f}>
                                  <span className="w-3.5 text-center text-[11px] font-bold shrink-0" style={{ color: "var(--warning-ink)" }}>!</span>
                                  <span className="text-[11.5px] truncate" style={{ color: on ? "var(--text)" : "var(--text2)" }}>{relPath}</span>
                                </button>
                              );
                            })}
                          </Section>
                        )}
                        {conflicts.length > 0 && !mergeRest && (
                          <button onClick={() => setMergeRest(true)}
                            className="w-full text-left px-3 py-2 text-[10.5px] hover:bg-white/5"
                            style={{ color: "var(--text3)" }}>
                            <PlusIcon size={ICON.xs} className="inline-block align-[-2px] mr-1" />{(tree?.staged.length ?? 0) + (tree?.unstaged.length ?? 0)} more the merge brought — show them
                          </button>
                        )}
                        {(!conflicts.length || mergeRest) && !!shownStaged.length && (
                          <Section title="Staged" count={shownStaged.length} tint="var(--success)" action="unstage all" onAll={writeEnabled ? () => act(() => api.gitUnstageAll(root)) : undefined}>
                            {renderFiles(shownStaged, "unstage", "s")}
                          </Section>
                        )}
                        {(!conflicts.length || mergeRest) && !!shownUnstaged.length && (
                          <Section title="Changes" count={shownUnstaged.length} tint="var(--warning)" action="stage all" onAll={writeEnabled ? () => act(() => api.gitStageAll(root)) : undefined}>
                            {renderFiles(shownUnstaged, "stage", "u")}
                          </Section>
                        )}
                        {searchEmpty(q, shownStaged.length + shownUnstaged.length) && <NothingMatches q={q} />}
                      </div>
                      {/* The commit box. It is the one place in this view where you WRITE
                          rather than pick, so it gets a surface of its own rather
                          than a hairline and the panel's ground. */}
                      <div className="shrink-0 border-t p-3 space-y-2" style={{ borderColor: "color-mix(in srgb, var(--text) 8%, transparent)", background: "color-mix(in srgb, var(--bg3) 22%, transparent)" }}>
                        <input value={title} onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter") doCommit(); }} placeholder="Summary of what changed…" disabled={!writeEnabled} className={`w-full ${INPUT}`} style={INPUT_STYLE} />
                        <Textarea value={body} onChange={(e) => setBody(e.target.value)} onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter") doCommit(); }} placeholder="Why, if it needs saying (optional)…" rows={2} disabled={!writeEnabled} className="agx-scroll w-full !min-h-0 resize-none" />
                        {amend ? (
                          <div className="flex gap-2">
                            <Button tone="primary" className="flex-1 justify-center" onClick={doAmend} data-dock="amend-run"
                              disabled={!writeEnabled || busy || !tree?.staged.length || !title.trim()}
                              title={tree?.staged.length ? "Replace the last commit with the staged files and this message" : "Stage the files to fold into it first"}>
                              <IconLabel icon={<CommitIcon size={ICON.xs} />}>Amend {amend.hash}</IconLabel>
                            </Button>
                            <Button onClick={stopAmend} data-dock="amend-cancel">Cancel</Button>
                          </div>
                        ) : (<>
                          <Button tone="primary" className="w-full justify-center" onClick={doCommit} disabled={!writeEnabled || busy || !tree?.staged.length || !title.trim()}>
                            <IconLabel icon={<CommitIcon size={ICON.xs} />}>Commit {tree?.staged.length ? `${tree.staged.length} staged` : ""}</IconLabel>
                            {!!tree?.staged.length && branch?.name && <>to <span className="px-1 rounded" style={{ fontFamily: "var(--font-mono, ui-monospace, monospace)", border: "1px solid color-mix(in srgb, currentColor 35%, transparent)" }}>{branch.name}</span></>}
                          </Button>
                          {writeEnabled && toolbarFor("changes").map((a) => (
                            <Button key={a.id} className="w-full justify-center" disabled={busy} onClick={() => void startAmend()} data-dock={a.id}
                              title="Rewrite the last commit with the staged files and a new message">
                              <DockIcon name={a.icon} />{a.label}
                            </Button>
                          ))}
                        </>)}
                        {!writeEnabled && <div className="text-[9.5px] t-dim2 text-center">read-only (AGENTGLASS_GIT_WRITE_DISABLED)</div>}
                      </div>
                    </div>
                    <SidebarGrip />
                    <div className="flex-1 min-w-0 min-h-0 flex flex-col">
                      {/*
                        * A conflict takes the whole pane, like every other tool
                        * that resolves one.
                        *
                        * It used to render inside the merge strip: three inches
                        * of two-column comparison above a list of four hundred
                        * files the merge had brought along and an unrelated
                        * diff. The file being argued about is the screen while
                        * you are arguing about it.
                        */}
                      {blockFile ? (
                        <>
                          <div className="flex items-center gap-2 px-4 py-2 border-b shrink-0" style={{ borderColor: "color-mix(in srgb, var(--border) 40%, transparent)" }}>
                            <span className="w-3.5 text-center text-[11px] font-bold shrink-0" style={{ color: "var(--warning-ink)" }}>!</span>
                            <span className="text-[12px] font-medium truncate" style={{ color: "var(--text)" }} title={blockFile}>{blockFile}</span>
                            <span className="text-[10.5px] shrink-0" style={{ color: "var(--warning-ink)" }}>in conflict</span>
                            <div className="ml-auto flex items-center gap-1.5 shrink-0">
                              <button onClick={() => act(() => api.gitResolve(root, [blockFile], "ours"), `kept ours for ${blockFile}`)} disabled={busy}
                                className="text-[10.5px] px-1.5 py-0.5 rounded" style={{ color: "var(--text3)", border: EDGE }}
                                title="Keep this branch's version of the whole file">ours</button>
                              <button onClick={() => act(() => api.gitResolve(root, [blockFile], "theirs"), `took theirs for ${blockFile}`)} disabled={busy}
                                className="text-[10.5px] px-1.5 py-0.5 rounded" style={{ color: "var(--text3)", border: EDGE }}
                                title="Take the incoming version of the whole file">theirs</button>
                              <CloseButton onClick={() => { setBlockFile(null); setBlocks(null); setPicks({}); }} style={{ color: "var(--text3)" }} title="Back to the changes" className="rounded" />
                            </div>
                          </div>
                          <div className="agx-scroll flex-1 min-h-0 overflow-y-auto p-3">
                            <BlockResolver
                              blocks={blocks} error={blockErr} picks={picks}
                              onPick={(i: number, c: BlockChoice) => setPicks((p) => ({ ...p, [i]: c }))}
                              busy={busy}
                              onApply={() => {
                                const list = (blocks ?? []).map((b) => picks[b.index] ?? "ours");
                                const f = blockFile;
                                void act(() => api.gitResolveBlocks(root, f, list), `resolved ${f}`)
                                  .then(() => { setBlockFile(null); setBlocks(null); setPicks({}); });
                              }} />
                          </div>
                        </>
                      ) : selected ? (
                        <>
                          <div className="flex items-center gap-2 px-4 py-2 border-b shrink-0" style={{ borderColor: "color-mix(in srgb, var(--border) 40%, transparent)" }}>
                            <span className="w-3.5 text-center text-[11px] font-bold shrink-0" style={{ color: STATUS_TINT[selected.status] }}>{STATUS_LETTER[selected.status]}</span>
                            <span className="text-[12px] font-medium truncate" style={{ color: "var(--text)" }} title={selected.file_path}>{rel(selected)}</span>
                            <span className="shrink-0 text-[10.5px] tabular-nums flex items-center gap-1.5">
                              {selected.additions > 0 && <span style={{ color: "var(--success-ink)" }}>+{selected.additions}</span>}
                              {selected.deletions > 0 && <span style={{ color: "var(--error-ink)" }}>−{selected.deletions}</span>}
                            </span>
                            <div className="ml-auto flex items-center gap-1.5 shrink-0">
                              {/* `e` has always done this; the button is for the
                                  hands that are on the mouse. It opens at the
                                  first changed line rather than at the top —
                                  scrolling back to where you already were is
                                  the whole reason people stay in the diff. */}
                              {/* Opens HERE, the way the pull request does —
                                  the modal with an editor in it, at the first
                                  changed line, with the rest down its right.
                                  `e` still sends the file to an nvim you
                                  already have open; the two are different
                                  intentions and both are worth having. */}
                              <Toggle onClick={() => editFile(selected)}
                                title={`Open ${rel(selected)} here, at its first change`}><IconLabel icon={<FileIcon size={ICON.xs} />}>open</IconLabel></Toggle>
                              <Segmented track label="Diff layout" value={split ? "split" : "unified"} onChange={(v) => setSplit(v === "split")}
                                options={[{ id: "split", label: "split", title: "Side by side" }, { id: "unified", label: "unified", title: "One column" }]} />
                              <Toggle on={wrap} onClick={() => setWrap((w) => !w)} title="Toggle line wrap">wrap</Toggle>
                              <ThemePicker value={themePref} onChange={setThemePref} error={hiliteError} /><DiffSettingsLink />
                              <Toggle on={bold} onClick={() => setBold((b) => !b)} title="Bold keywords, functions & types (Neovim-style)">bold</Toggle>
                            </div>
                          </div>
                          {/*
                            * The column that scrolls.
                            *
                            * The diff panes deliberately do not: `overflow-x:
                            * auto` computes `overflow-y: auto` unless the other
                            * axis is pinned, and two nested vertical scrollers
                            * is the double-scroll this app already fixed once
                            * (see DiffLines.tsx). The pull-request view gives
                            * them an outer scroller; this one did not, so in
                            * split+wrap nothing scrolled at all and the file
                            * was simply cut off at the bottom of the pane.
                            *
                            * And a BLOCK, not a flex row — which is the half
                            * that took two goes. As a flex row this container
                            * stretches its children to its own height, and a
                            * child with `overflow-y: hidden` then CLIPS its
                            * content instead of growing past it: the scrollbar
                            * appears and scrolls nothing, because as far as the
                            * container is concerned there is nothing below.
                            * Block lets the diff be as tall as the file and
                            * this column scroll it, which is what the panes
                            * mean by "inside whatever scrolls the page".
                            */}
                          <div className="agx-scroll flex-1 min-h-0 relative overflow-y-auto" data-diff-scroller style={{ background: "var(--bg)" }}>
                            {selected.binary ? <div className="h-full grid place-items-center t-dim2 text-[12px]">binary file — no textual diff</div>
                              : <HiliteCtx.Provider value={selected.hunks.reduce((n, h) => n + h.lines.length, 0) > 3000 ? { ...hilite, theme: null } : hilite}>{split ? <SplitDiff c={selected} wrap={wrap} hunkAction={hunkActionFn} /> : <UnifiedDiff c={selected} wrap={wrap} hunkAction={hunkActionFn} />}</HiliteCtx.Provider>}
                          </div>
                        </>
                      ) : (
                        /* The other half of the Changes view, which for most of
                           the day is the biggest empty rectangle in the app. It
                           used to hold one grey sentence in the dead centre.
                           Now it either tells you where you stand or tells you
                           what to press — and it is the one place with room to
                           put the keys somewhere they can be read. */
                        <div className="flex-1 grid place-items-center px-6">
                          <div className="flex flex-col items-center gap-2 text-center" style={{ maxWidth: 380 }}>
                            <div className="text-[13px]" style={{ color: "var(--text2)" }}>
                              Select a file to see its diff
                            </div>
                            {(
                              <div className="flex flex-wrap items-center justify-center gap-1.5 mt-1">
                                {[["j / k", "move"], ["space", "stage"], ["x", "discard"], ["`", "tree or flat"]].map(([k, what]) => (
                                  <span key={k} className="flex items-center gap-1.5 text-[9.5px] px-2 py-1 rounded-lg"
                                    style={{ color: "var(--text3)", background: "color-mix(in srgb, var(--text) 6%, transparent)" }}>
                                    <b style={{ color: "var(--text2)", fontFamily: "var(--font-mono, ui-monospace, monospace)", fontWeight: 500 }}>{k}</b>{what}
                                  </span>
                                ))}
                              </div>
                            )}
                          </div>
                        </div>
                      )}
                      {!blockFile && !!tree && !tree.clean && (
                        <GitDock {...changesDock} onRun={changesRun} disabled={!writeEnabled}
                          selection={dockFiles.length > 1 ? `${dockFiles.length} picked` : one ? rel(one) : "nothing picked"} selectionTitle={one?.file_path} />
                      )}
                    </div>
                  </div>
                    )}
                  </div>
                ) : view === "log" ? (
                  <div className="flex-1 min-h-0 flex flex-col">
                  {!graph.length ? (<>
                    <LogToolbar scope={logScope} onScope={setLogScope} />
                    {histFail ? <ErrorBox title="The history could not be read" text="Git could not read the history. Your files are not touched; the command log has the full output."
                        code={histFail.split("\n").filter(Boolean).slice(-2).join("\n")} onRetry={() => void loadView()} onLog={() => setLogOpen(true)} />
                    : busyView === "log" ? <StateFrame busy title="Reading the log…" />
                    : <StateFrame icon={<span className="grid place-items-center" style={{ color: "var(--text3)" }}><DockIcon name="commit" size={ICON.lg} /></span>} ghost
                        title={<>No commits yet on <span style={{ fontFamily: MONO }}>{graphBranch || branch?.name || "this branch"}</span></>}
                        text="The first commit you make in Changes starts the history here."
                        actions={<Button onClick={() => setView("changes")}><DockIcon name="arrow" />Go to Changes</Button>} />}
                  </>) : (<>
                  <LogToolbar scope={logScope} onScope={setLogScope}
                    search={{ q, onQ: (v) => { setQ(v); setRowIdx(logSearch.indexFor(v)); },
                      count: logSearch.lines.length - (logSearch.pinned ? 1 : 0), total: graph.filter((l) => !!l.hash).length }} />
                  {searchEmpty(q, logSearch.lines.length - (logSearch.pinned ? 1 : 0)) && <NothingMatches q={q} grow={!logSearch.pinned} />}
                  {!!logSearch.lines.length && (
                  <div onScroll={incGraph.onScroll} className="agx-scroll flex-1 min-h-0 overflow-auto text-[11.5px]" style={{ fontFamily: "var(--font-mono, ui-monospace), monospace" }}>
                    {/*
                      * The log, as LINES rather than cards, with the graph in a
                      * gutter of its own outside them.
                      *
                      * Cards are right for a list of things — a branch, a
                      * worktree, a stash — each of which is a discrete object
                      * with its own state. A commit is not one of those: it is a
                      * moment in a sequence, and its meaning is what sits above
                      * and below it. The card's border, radius, lift and 4px gap
                      * all said "these are apart" about the one list where they
                      * are not — and they cut the graph five hundred times, once
                      * per row. Flush to the inspector, too: the log's content is
                      * a subject, and a centred 860px measure cut merge subjects
                      * mid-branch-name with 700px of window sitting empty beside them.
                      */}
                    <List
                      flush
                      rows={commitRows(incGraph.rows, {
                        picked: pickSet,
                        numbers: pickOrder,
                        run: runCommitAction,
                        layout: logSearch.layout, pinned: logSearch.pinned,
                        remotes: remotes.map((r) => r.name),
                      })}
                      inspector={(i) => <CommitInspector line={logCommits[i]} root={root} lines={graph} layout={logSearch.layout} />}
                      cursor={rowIdx} onCursor={setRowIdx}
                      onMenu={(r, x, y) => setRowMenu({ kind: r.kind, name: r.name, state: r.state, x, y, run: r.run })}
                      busy={busyView === "log"} what="commits" disabled={!writeEnabled}
                    />
                    <MoreRows shown={incGraph.rows.length} total={logSearch.lines.length} onAll={incGraph.showAll} />
                  </div>
                  )}
                  {pickSet.size > 0 && (
                    <PickBar shas={pickedList(pickSet, graph.filter((l) => !!l.hash).map((l) => l.hash!))} branch={tree?.branch.name}
                      disabled={busy || !writeEnabled} picking={pending === `pick:${pickSet.size}`}
                      onPick={() => void runCherryPick()} onStage={() => void runCherryPick(true)} onSquash={() => void squashPicked()}
                      onClear={() => setPickSet(new Set())} />
                  )}
                  <GitDock {...dockFor} onRun={(id) => void dockRun(id)} disabled={!writeEnabled}
                    selection={logCur?.hash ?? "nothing picked"} selectionIcon="commit" selectionTitle={logCur?.subject} />
                  </>)}
                  </div>
                ) : view === "branches" ? (
                  <div className="flex-1 min-h-0 flex flex-col">
                    <div className="shrink-0 px-3 pt-3">
                    <ListToolbar
                      lead={writeEnabled ? (
                        <>
                          <label className="relative w-56 shrink-0 flex items-center">
                            <PlusIcon size={ICON.sm} className="absolute left-2.5 pointer-events-none" />
                            <input value={newBranch} onChange={(e) => setNewBranch(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") createBranch(); }} placeholder="new-branch-name" className={`min-w-0 w-full ${INPUT}`} style={{ ...INPUT_STYLE, paddingLeft: 30 }} />
                          </label>
                          <Button tone={newBranch.trim() ? "primary" : "plain"} onClick={createBranch} disabled={busy || !newBranch.trim()}><ArrowIcon size={ICON.xs} />Create &amp; switch</Button>
                        </>
                      ) : null}
                      q={q} onQ={(v) => { setQ(v); setRowIdx(0); }}
                      placeholder="Search branches by name or last commit…"
                      sort={sort} onSort={(s) => { setSort(s); setRowIdx(0); }}
                      sorts={[
                        { key: "recent", label: "recent", title: "Most recently committed first — git's own order" },
                        { key: "name", label: "name", title: "Alphabetical, for when you know the ticket number" },
                        { key: "track", label: "unsynced", title: "Furthest from its upstream first — what still has something to settle" },
                      ]}
                      count={shownBranches.length} total={branchTotal}
                      bare={!!viewFail || onlyBranch}
                    />
                      </div>
                      {viewFail ? <ErrorFrame title="Branches could not be listed" sentence={frameSentence(viewFail)} raw={viewFail} onRetry={() => void loadView()}
                          extra={<Button onClick={() => setLogOpen(true)}><TerminalIcon size={ICON.xs} />Open the command log</Button>} />
                      : onlyBranch ? <OnlyBranchFrame name={branchData.branches[0].name} />
                      : (<>
                      <div onScroll={incBranches.onScroll} className="agx-scroll flex-1 min-h-0 overflow-auto py-1">
                    {/* Sections (CURRENT, RECENT, folded families, MERGED) when the
                        list is long enough to have a shape: `branchPlan` puts the
                        rows in drawn order, so the cursor `rowIdx` walks what the
                        eye sees. */}
                    <List
                      rows={branchRows(listBranches, {
                        current: currentBranchName,
                        worktreeOf: (n) => wtByBranch.get(n),
                        root,
                        trunk: branchData.trunk,
                        picked,
                        onPick: (n) => setPicked((prev) => { const next = new Set(prev); next.has(n) ? next.delete(n) : next.add(n); return next; }),
                        run: branchAction,
                        track: trackChip,
                      })}
                      sections={branchPlan?.sections}
                      aboveList={banner ? <GoneBanner banner={banner} onReview={() => { setView("tidy"); setRowIdx(0); }} /> : undefined}
                      cursor={rowIdx} onCursor={setRowIdx}
                      onMenu={(r, x, y) => setRowMenu({ kind: r.kind, name: r.name, state: r.state, x, y, run: r.run })}
                      busy={busyView === "branches"} what="branches" disabled={!writeEnabled}
                      inspector={(i) => {
                        const b = listBranches[i];
                        return <BranchInspector branch={b} track={b ? trackChip(b.track) : { ahead: 0, behind: 0, gone: false }}
                          worktree={b ? wtByBranch.get(b.name) : undefined} root={root} trunk={branchData.trunk} isCurrent={b?.name === currentBranchName} />;
                      }}
                    />
                    <MoreRows shown={incBranches.rows.length} total={shownBranches.length} onAll={incBranches.showAll} />
                      </div>
                      <GitDock {...branchesDock} onRun={branchesRun} disabled={!writeEnabled}
                        selection={picked.size > 1 ? `${picked.size} ticked` : curBranch
                          ? <span className="inline-flex items-center gap-1" style={{ color: curBranch.name === currentBranchName ? "var(--text)" : wtByBranch.has(curBranch.name) ? "var(--text2)" : "var(--info-ink)" }}>
                              <BranchIcon size={ICON.xs} />{curBranch.name}
                            </span>
                          : "nothing picked"}
                        cmd={picked.size > 1 || !curBranch || curBranch.name !== currentBranchName ? undefined
                          : actionsFor("branch", curBranch.name, { current: true, upstream: !!curBranch.upstream, ahead: trackChip(curBranch.track).ahead }).find((a) => a.id === branchesDock.actions[0]?.id)?.command}
                        selectionTitle={picked.size > 1 ? [...picked].join("\n") : curBranch?.name} />
                      </>)}
                    </div>
                ) : view === "stashes" ? (
                  <div className="flex-1 min-h-0 flex flex-col">
                  <div className="agx-scroll shrink-0 max-h-[55%] overflow-y-auto px-3 pt-3">
                    {/* One row, not four stacked. Stash-all, the snapshot field
                        and "some files" are three ways to put work aside; they
                        belong beside each other. */}
                    <div className="flex items-center gap-2 flex-wrap mb-3">
                    {writeEnabled && <button onClick={stashPush} disabled={busy || tree?.clean} className="text-[11px] px-3 min-h-[28px] inline-flex items-center rounded-lg font-medium" style={{ background: "color-mix(in srgb, var(--primary) 16%, transparent)", border: "1px solid color-mix(in srgb, var(--primary) 35%, transparent)", color: "var(--text)", opacity: tree?.clean ? 0.5 : 1 }}>⇩ stash all changes</button>}
                    {/* Snapshots: named checkpoints that never touch the tree.
                        stash push MOVES work off the tree; a snapshot copies it
                        and leaves the tree alone — so "before I try this" can
                        restore even after the experiment goes sideways. */}
                    {writeEnabled && (
                      <>
                        <input value={snapshotLabel} onChange={(e) => setSnapshotLabel(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") snapshotNow(); }} placeholder="snapshot label (optional) — tree is not touched" className={`min-w-0 w-56 shrink-0 ${INPUT}`} style={INPUT_STYLE} />
                        <button onClick={snapshotNow} disabled={busy || tree?.clean} className={`${CHIP} font-medium`} style={{ background: "color-mix(in srgb, var(--info) 16%, transparent)", border: "1px solid color-mix(in srgb, var(--info) 35%, transparent)", color: "var(--text)", opacity: tree?.clean ? 0.5 : 1 }} title="Copy the current tree into refs/agx/wip — nothing moves, restore anytime"><IconLabel icon={<RefreshIcon size={ICON.xs} />}>snapshot now</IconLabel></button>
                      </>
                    )}
                    {writeEnabled && (
                      <button onClick={() => { setPartialOpen(!partialOpen); }} className={`${CHIP} font-medium`} style={{ background: "color-mix(in srgb, var(--primary) 12%, transparent)", border: "1px solid color-mix(in srgb, var(--primary) 30%, transparent)", color: "var(--text)" }}><IconLabel icon={<StashIcon size={ICON.xs} />}>stash some files…</IconLabel></button>
                    )}
                    {/* The search belongs in the same strip as the controls
                        above it: they are all "what do I do with work set
                        aside", and it was the fourth row of chrome before the
                        first stash. */}
                    {!!stashes.length && (
                      <input value={q} onChange={(e) => { setQ(e.target.value); setRowIdx(0); }}
                        placeholder="Search stashes…"
                        className={`min-w-0 flex-1 max-w-xs ${INPUT}`}
                        style={INPUT_STYLE} />
                    )}
                    </div>
                    {snapshots.length > 0 && (
                      <div className="mb-3">
                        <div className="text-[9.5px] uppercase tracking-wider t-dim2 mb-1">snapshots</div>
                        <div className="space-y-0.5">
                          {snapshots.map((s) => (
                            <div key={s.ref} className="group px-2.5 py-1.5 rounded-md" style={{ background: "color-mix(in srgb, var(--info) 7%, transparent)", border: "1px solid color-mix(in srgb, var(--info) 18%, transparent)" }}>
                              <div className="flex items-center gap-2">
                                <span className="text-[9.5px] tabular-nums font-mono" style={{ color: "var(--info-ink)" }}>{s.sha.slice(0, 7)}</span>
                                <span className="min-w-0 flex-1 truncate text-[11.5px]" style={{ color: "var(--text)" }}>{s.label || "untitled snapshot"}</span>
                                <span className="shrink-0 text-[9.5px] t-dim2">{s.time}</span>
                                {writeEnabled && (
                                  <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100">
                                    <button onClick={() => restoreSnapshot(s.sha)} className="text-[10px] px-1.5 py-0.5 rounded" style={{ color: "var(--success-ink)", border: "1px solid color-mix(in srgb, var(--success) 30%, transparent)" }} title="Apply the snapshot's tree onto the current one">restore</button>
                                    <button onClick={async () => { if (await ask({ title: "Delete this snapshot?", body: "The checkpoint is gone for good.", danger: true, confirmLabel: "Delete" })) act(() => api.gitSnapshotDelete(root, s.sha), "Deleted snapshot"); }} className="text-[10px] px-1.5 py-0.5 rounded" style={{ color: "var(--error-ink)" }}>delete</button>
                                  </div>
                                )}
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                    {writeEnabled && (
                      <div>
                        {partialOpen && (
                          <div className="mt-2 rounded-lg p-2.5 max-w-lg" style={{ background: "color-mix(in srgb, var(--bg3) 30%, transparent)", border: EDGE }}>
                            <div className="text-[9.5px] uppercase tracking-wider t-dim2 mb-1">pick from the working tree</div>
                            <div className="space-y-1 max-h-48 overflow-y-auto mb-2">
                              {(tree?.unstaged ?? []).map((c) => {
                                const p = relOf(c);
                                return (
                                  <label key={p} className="flex items-center gap-2 cursor-pointer">
                                    <input type="checkbox" checked={partialSel.has(p)} onChange={(e) => { const n = new Set(partialSel); if (e.target.checked) n.add(p); else n.delete(p); setPartialSel(n); }} className="accent-[var(--primary)]" />
                                    <span className="truncate text-[11px]" style={{ color: "var(--text)" }}>{p}</span>
                                  </label>
                                );
                              })}
                              {!tree?.unstaged.length && <div className="text-[10.5px] t-dim2">nothing to pick — the tree is clean</div>}
                            </div>
                            <div className="flex items-center gap-3">
                              <label className="flex items-center gap-1.5 text-[10.5px] cursor-pointer" style={{ color: "var(--text2)" }}>
                                <input type="checkbox" checked={partialKeep} onChange={(e) => setPartialKeep(e.target.checked)} className="accent-[var(--primary)]" />
                                keep in working tree (stash & keep)
                              </label>
                              <button onClick={stashPartialNow} disabled={!partialSel.size} className="text-[11px] px-3 py-1 rounded-lg font-medium ml-auto" style={{ background: "color-mix(in srgb, var(--primary) 18%, transparent)", border: "1px solid color-mix(in srgb, var(--primary) 40%, transparent)", color: "var(--text)", opacity: partialSel.size ? 1 : 0.45 }}>stash {partialSel.size || ""} file{partialSel.size === 1 ? "" : "s"}</button>
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                    {viewFail ? <ErrorFrame title="Stashes could not be listed" sentence={frameSentence(viewFail)} onRetry={() => void loadView()} />
                    : !stashes.length && busyView !== "stashes" ? <NoStashesFrame />
                    : (<>
                      <div className="agx-scroll flex-1 min-h-0 overflow-auto py-1">
                        <List
                          rows={stashRows(shownStashes, stashAction)}
                          inspector={(i) => {
                            const st = shownStashes[i];
                            const files = st && stashFiles?.hash === st.hash ? stashFiles.files : "loading";
                            const treeRels = new Set([...(tree?.staged ?? []), ...(tree?.unstaged ?? [])].map(rel));
                            return <StashInspector stash={st} files={files} onRetry={() => st && void loadStashFiles(st.hash)}
                              overlap={Array.isArray(files) ? stashOverlap(files, treeRels) : []}
                              clashPaths={st && stashClashes(unmerged.length, st.hash, appliedStash) ? unmerged : []} />;
                          }}
                          cursor={rowIdx} onCursor={setRowIdx}
                          onMenu={(r, x, y) => setRowMenu({ kind: r.kind, name: r.name, state: r.state, x, y, run: r.run })}
                          busy={busyView === "stashes"} what="stashes" disabled={!writeEnabled}
                        />
                      </div>
                      <GitDock {...stashesDock} onRun={(id) => curStash && stashAction(id, curStash)} disabled={!writeEnabled}
                        selection={curStash?.ref ?? "nothing picked"} selectionTitle={curStash?.message} />
                    </>)}
                  </div>
                ) : view === "remotes" ? (
                  <div className="flex-1 min-h-0 flex flex-col">
                    {/* The remote line is the header: which remote, Fetch from it, where it
                        points, and the search. These refs are the last fetch's answer, and every
                        other number in this panel is measured against them, so the note says so. */}
                    {!!remotes.length && (
                      <div className="shrink-0 px-3 pt-3 pb-2 flex items-center gap-2 flex-wrap">
                        <div className="flex items-center gap-1.5 flex-wrap shrink-0">
                          {remotes.map((r) => (
                            <span key={r.name}
                              onContextMenu={(e) => { e.preventDefault(); setRowMenu({ kind: "remote", name: r.name, state: {}, x: e.clientX, y: e.clientY, run: (id) => remoteAction(id, r) }); }}>
                              <Pill on={r.name === remoteSel} onClick={() => { setRemoteSel(r.name); setRemoteQuery(""); }} title={remoteUrlLine(r)}>
                                <DockIcon name="cloud" />{r.name} <span className="tabular-nums" style={{ color: "var(--text2)" }}>{r.branches}</span>
                              </Pill>
                            </span>
                          ))}
                        </div>
                        {toolbarFor("remotes", remoteSel).map((a) => a.id === "remote-copy-url"
                          ? <Button key={a.id} square label="Copy the URL" onClick={() => remoteToolbarRun(a.id)}><DockIcon name={a.icon} /></Button>
                          : <Button key={a.id} disabled={busy} onClick={() => remoteToolbarRun(a.id)}><DockIcon name={a.icon} />{a.label}</Button>)}
                        <span className="min-w-0 flex-1 truncate text-[10.5px] t-dim2" style={{ fontFamily: "var(--font-mono, ui-monospace, monospace)" }}
                          title={remoteUrlLine(remotes.find((r) => r.name === remoteSel))}>{remoteUrlLine(remotes.find((r) => r.name === remoteSel))}</span>
                        <input value={remoteQuery} onChange={(e) => { setRemoteQuery(e.target.value); setRowIdx(0); }}
                          placeholder="Search remote branches…" className={`w-64 min-w-0 ${INPUT}`} style={INPUT_STYLE} />
                        {/* "36 of 790" is the only way to know whether the search narrowed anything. */}
                        <span className="shrink-0 text-[9.5px] tabular-nums t-dim2">
                          {remoteQuery.trim() ? `${shownRemoteBranches.length} of ${remoteRows.length}` : `${remoteRows.length} branch${remoteRows.length === 1 ? "" : "es"}`}
                        </span>
                        {remoteQuery.trim() && <button onClick={() => setRemoteQuery("")} className="shrink-0 text-[10px] px-1.5 py-0.5 rounded" style={{ color: "var(--text2)", border: EDGE }}>clear</button>}
                      </div>
                    )}
                    {viewFail ? (
                      <ErrorFrame title={frameSentence(viewFail, remoteSel).startsWith("Could not reach") ? `${remoteSel || "The remote"} could not be reached` : "Remote branches could not be listed"}
                        sentence={frameSentence(viewFail, remoteSel)} onRetry={() => void loadView()} />
                    ) : !remotes.length ? (
                      busyView === "remotes" ? <PaneEmpty busy what="remotes" />
                        : <NoRemoteFrame copy={(t) => void navigator.clipboard?.writeText(t).catch(() => { /* no clipboard permission */ })} />
                    ) : (<>
                      <div onScroll={incRemoteBranches.onScroll} className="agx-scroll flex-1 min-h-0 overflow-auto py-1">
                        {!shownRemoteBranches.length && (
                          remoteQuery.trim() && remoteRows.length
                            ? <div className="grid place-items-center py-10 t-dim2 text-[12px]">nothing on {remoteSel} matches “{remoteQuery.trim()}”</div>
                            : <PaneEmpty busy={busyView === "remotes"} what="remote branches" />
                        )}
                        <List
                          rows={remoteBranchRows(incRemoteBranches.rows, { root, run: remoteBranchAction })}
                          inspector={(i) => <RemoteBranchInspector branch={incRemoteBranches.rows[i]} remote={remoteSel} current={branch?.name} root={root} />}
                          cursor={rowIdx}
                          onCursor={setRowIdx}
                          onMenu={(r, x, y) => setRowMenu({ kind: r.kind, name: r.name, state: r.state, x, y, run: r.run })}
                          busy={busyView === "remotes"}
                          what="remote branches"
                          disabled={!writeEnabled}
                        />
                        <MoreRows shown={incRemoteBranches.rows.length} total={shownRemoteBranches.length} onAll={incRemoteBranches.showAll} />
                      </div>
                      <GitDock {...remotesDock} onRun={(id) => curRemote && remoteBranchAction(id, curRemote)} disabled={!writeEnabled}
                        selection={curRemote?.ref ?? "nothing picked"} selectionTitle={curRemote?.ref} />
                    </>)}
                  </div>
                ) : view === "tags" ? (
                  <div className="flex-1 min-h-0 flex flex-col">
                    <div className="shrink-0 px-3 pt-3">
                      <ListToolbar
                        lead={writeEnabled ? (
                          <Button on={tagFormOpen} onClick={() => setTagFormOpen((v) => !v)}><DockIcon name="plus" />{toolbarFor("tags")[0].label}</Button>
                        ) : null}
                        q={q} onQ={(v) => { setQ(v); setRowIdx(0); }} placeholder="Search tags…"
                        sort={sort} onSort={(x) => { setSort(x); setRowIdx(0); }}
                        sorts={[{ key: "recent", label: "recent", title: "Newest tag first" }, { key: "name", label: "name", title: "Alphabetical" }]}
                        count={shownTags.length} total={tags.length} />
                      {tagFormOpen && writeEnabled && (
                        <TagForm head={branch?.name} existing={tags.map((t) => t.name)} busy={busy}
                          onCreate={(n, m) => void createTag(n, m)} onCancel={() => setTagFormOpen(false)} />
                      )}
                    </div>
                    {viewFail ? <ErrorFrame title="Tags could not be listed" sentence={frameSentence(viewFail)} onRetry={() => void loadView()} />
                    : !tags.length && busyView !== "tags" ? <NoTagsFrame />
                    : (<>
                      <div onScroll={incTags.onScroll} className="agx-scroll flex-1 min-h-0 overflow-auto py-1">
                        <List
                          rows={tagRows(incTags.rows, tagAction, (n) => <TagOriginChip origin={originOf(n)} />)}
                          inspector={(i) => <TagInspector tag={incTags.rows[i]} origin={incTags.rows[i] ? originOf(incTags.rows[i].name) : undefined} />}
                          cursor={rowIdx} onCursor={setRowIdx}
                          onMenu={(r, x, y) => setRowMenu({ kind: r.kind, name: r.name, state: r.state, x, y, run: r.run })}
                          busy={busyView === "tags"} what="tags" disabled={!writeEnabled}
                        />
                        <MoreRows shown={incTags.rows.length} total={shownTags.length} onAll={incTags.showAll} />
                      </div>
                      <GitDock {...tagsDock} onRun={(id) => curTag && tagAction(id, curTag)} disabled={!writeEnabled}
                        selection={curTag?.name ?? "nothing picked"} selectionTitle={curTag?.subject} />
                    </>)}
                  </div>
                ) : view === "submodules" ? (
                  <div className="flex-1 min-h-0 flex flex-col">
                    <div className="shrink-0 px-3 pt-3">
                      <ListToolbar
                        lead={writeEnabled ? toolbarFor("submodules").map((a) => (
                          <Button key={a.id} disabled={busy} onClick={() => submoduleToolbarRun(a.id)}><DockIcon name={a.icon} />{a.label}</Button>
                        )) : null}
                        q={q} onQ={(v) => { setQ(v); setRowIdx(0); }} placeholder="Search submodules…"
                        count={shownSubmodules.length} total={submodules.length} />
                    </div>
                    {viewFail ? <ErrorFrame title="Submodules could not be listed" sentence={frameSentence(viewFail)} onRetry={() => void loadView()} />
                    : !submodules.length && busyView !== "submodules" ? <NoSubmodulesFrame />
                    : (<>
                      <div className="agx-scroll flex-1 min-h-0 overflow-auto py-1">
                        <List
                          rows={submoduleRows(shownSubmodules, submoduleAction)}
                          inspector={(i) => <SubmoduleInspector sub={shownSubmodules[i]} />}
                          cursor={rowIdx} onCursor={setRowIdx}
                          onMenu={(r, x, y) => setRowMenu({ kind: r.kind, name: r.name, state: r.state, x, y, run: r.run })}
                          busy={busyView === "submodules"} what="submodules" disabled={!writeEnabled}
                        />
                      </div>
                      <GitDock {...submodulesDock} onRun={(id) => curSub && submoduleAction(id, curSub)} disabled={!writeEnabled}
                        selection={curSub?.path ?? "nothing picked"} />
                    </>)}
                  </div>
                ) : view === "reflog" ? (
                  <div className="flex-1 min-h-0 flex flex-col">
                    {/* Where HEAD has been. This is the trail that makes a bad
                        reset or rebase recoverable, which is why it earns a tab
                        of its own rather than living inside the log. */}
                    {histFail ? (
                      <StateFrame title="The reflog could not be read" text={histFail} actions={<>{retryButton(() => void loadView())}<button onClick={() => setLogOpen(true)} className={CHIP}>Open the command log</button></>} />
                    ) : reflogOff && !reflog.length ? (
                      <StateFrame title="This checkout keeps no reflog" text="core.logAllRefUpdates is off here, so git did not record where HEAD has been."
                        code={"$ git config core.logAllRefUpdates\nfalse"}
                        actions={<>
                          <Button tone="primary" disabled={busy || !writeEnabled} onClick={() => void act(() => api.gitReflogEnable(root), "Reflog turned on").then((ok) => { if (ok) void loadView(); })}>Turn it on for this repository</Button>
                          <button onClick={() => setLogOpen(true)} className={CHIP}>Open the command log</button>
                        </>} />
                    ) : !reflog.length ? (
                      busyView === "reflog" ? <StateFrame busy title="Reading the reflog…" />
                      : <StateFrame title="HEAD has not moved yet" text="Commits, checkouts, resets and rebases show up here as they happen, so any of them can be undone later." />
                    ) : (<>
                    <ListSearch q={q} onQ={(v) => { setQ(v); setRowIdx(0); }} placeholder="Search where HEAD has been…"
                      count={shownReflog.length} total={reflog.length} />
                    {searchEmpty(q, shownReflog.length) ? <NothingMatches q={q} /> : (
                    <div onScroll={incReflog.onScroll} className="agx-scroll flex-1 min-h-0 overflow-y-auto p-3">
                      <List
                        rows={reflogRows(incReflog.rows, (id, e) => runCommitAction(id, e.shortHash, e.subject))}
                        inspector={(i) => <ReflogInspector entry={incReflog.rows[i]} />}
                        cursor={rowIdx} onCursor={setRowIdx}
                        onMenu={(r, x, y) => setRowMenu({ kind: r.kind, name: r.name, state: r.state, x, y, run: r.run })}
                        busy={busyView === "reflog"} what="reflog entries" disabled={!writeEnabled}
                      />
                      <MoreRows shown={incReflog.rows.length} total={shownReflog.length} onAll={incReflog.showAll} />
                    </div>
                    )}
                    <GitDock {...dockFor} onRun={(id) => void dockRun(id)} disabled={!writeEnabled}
                      selection={reflogCur?.shortHash ?? "nothing picked"} selectionTitle={reflogCur?.subject} />
                    </>)}
                  </div>
                ) : (
                  <div className="flex-1 min-h-0 flex flex-col">
                    <div className="shrink-0 px-3 pt-3">
                    <ListToolbar
                      lead={writeEnabled ? (<>
                        <input value={newWtBranch} onChange={(e) => setNewWtBranch(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") addWorktree(); }} placeholder="new-branch → new worktree (sibling dir)" className={`min-w-0 w-56 shrink-0 ${INPUT}`} style={INPUT_STYLE} />
                        <button onClick={addWorktree} disabled={busy || !newWtBranch.trim()} className={`${CHIP} font-medium`} style={{ background: "color-mix(in srgb, var(--primary) 18%, transparent)", border: "1px solid color-mix(in srgb, var(--primary) 40%, transparent)", color: "var(--text)", opacity: newWtBranch.trim() ? 1 : 0.5 }}>+ add worktree</button>
                      </>) : null}
                      q={q} onQ={(v) => { setQ(v); setRowIdx(0); }}
                      placeholder="Search worktrees by branch or directory…"
                      count={shownWorktrees.length} total={worktrees.length} />
                    </div>
                    {viewFail ? <ErrorFrame title="Worktrees could not be listed" sentence={frameSentence(viewFail)} onRetry={() => void loadView()} /> : (<>
                      <div className="agx-scroll flex-1 min-h-0 overflow-auto py-1">
                        <List
                          rows={worktreeRows(shownWorktrees, { run: worktreeAction })}
                          inspector={(i) => <WorktreeInspector wt={shownWorktrees[i]} />}
                          cursor={rowIdx} onCursor={setRowIdx}
                          onMenu={(r, x, y) => setRowMenu({ kind: r.kind, name: r.name, state: r.state, x, y, run: r.run })}
                          busy={busyView === "worktrees"} what="worktrees" disabled={!writeEnabled}
                        />
                      </div>
                      <GitDock {...worktreesDock} onRun={(id) => curWt && worktreeAction(id, curWt)} disabled={!writeEnabled}
                        selection={curWt ? wtName(curWt.path) : "nothing picked"} selectionTitle={curWt?.locked ? "locked" : curWt?.path} />
                    </>)}
                  </div>
                )}

                <CommandLog open={logOpen} onClose={() => setLogOpen(false)} />
                <ShortcutBar view={view} logOpen={logOpen} onToggleLog={() => setLogOpen((v) => !v)} editorName={editor?.editor} />
                </>
                )}
                {helpOpen && !inConflict && <HelpSheet view={view} onClose={() => setHelpOpen(false)} />}
                {toast && (active
                  ? <GitToast toast={toast} />
                  // Hidden view (a modal asked for from another one): the toast
                  // is the only answer to what the palette just ran, so it floats.
                  : <GitToast toast={toast} floating />)}
      {/* A commit's diff, reusing the full file-changes viewer. Still a modal:
          it's a drill-down from a row you clicked, not a place you navigate
          to — the rail's views are the destinations, this is a detour. */}
      <PresetDiff open={!!commitView} onClose={() => setCommitView(null)} onBack={() => setCommitView(null)} backLabel="Log" changes={commitView?.changes ?? []} title={commitView?.title} root={root} />
      {rescue && <RescueModal reports={rescue.reports} progress={rescue.progress} onCancel={() => rescue.resolve(null)} onConfirm={(picked) => rescue.resolve(picked)} />}
      {rebaseBase && (
        <RebaseModal root={root} base={rebaseBase} branch={currentBranchName || branch?.name || "HEAD"}
          onClose={() => setRebaseBase(null)}
          onDone={(m) => { setRebaseBase(null); reloadGraph(); flash(true, m); }} />
      )}
      {compareTarget && (
        <CompareModal root={root} initialBase={compareTarget} initialOther={currentBranchName} against={compareAgainst}
          onClose={() => { setCompareTarget(null); setCompareAgainst(undefined); }} />
      )}
      {insightsOpen && <InsightsModal root={root} onClose={() => setInsightsOpen(false)} onGoToChanges={() => setView("changes")} onOpenLog={() => { setInsightsOpen(false); setLogOpen(true); }} />}
      {blamePath && (
        <BlameModal root={root} path={blamePath.path}
          onClose={() => setBlamePath(null)}
          onOpenCommit={(hash, subject) => { setBlamePath(null); void openCommit(hash, subject); }} />
      )}
      {bisectOpen && (
        <BisectModal root={root} initialGood={bisectFrom} onClose={() => { setBisectOpen(false); setBisectFrom(undefined); }}
          onReset={() => setBisectOpen(false)}
          onOpenCommit={(hash, subject) => { setBisectOpen(false); void openCommit(hash, subject); }}
          onChanged={(m) => { loadTree(root); void loadView(); if (m) flash(true, m); }} />
      )}
      {/* The branch row's menu: everything the seven buttons used to be, plus
          what there was never room for, grouped and with the irreversible ones
          asking once and showing the git they run. */}
      {/* Every action in the repository, by name, without the pointer. Built
          from the same catalogue the rows use, so it cannot offer something a
          row would refuse. */}
      {paletteOpen && (
        <GitPalette rows={paletteRows} onClose={() => setPaletteOpen(false)} />
      )}
      {rowMenu && (
        <GitRowMenu
          kind={rowMenu.kind} name={rowMenu.name} state={rowMenu.state}
          x={rowMenu.x} y={rowMenu.y}
          onClose={() => setRowMenu(null)}
          onAction={(id) => rowMenu.run(id)}
        />
      )}
      {dialog}
    </div>
  );
}
