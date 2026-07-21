// Live Source Control — agentglass's lazygit replacement. Working tree
// (stage/unstage/discard/commit), branches (checkout/create/delete), log
// (browse commits, view a commit's diff), and stash — all with the same diff
// renderer as the telemetry view.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { GitRepoRef, WorkingTree, GitFileChange, GitBranch, GitBranchInfo, GitStash, GitGraphLine, GitWorktree, GitRemote, GitTag, GitReflogEntry, FileChange, WalkthroughResult, WalkthroughFile } from "../../../shared/types.ts";
import { api } from "../lib/api.ts";
import { subscribeGitChanged } from "../lib/gitBus.ts";
import { HiliteCtx, useDiffHighlight } from "../lib/diffHighlight.ts";
import { usePoll } from "../lib/usePoll.ts";
import { worktreeTag } from "../lib/worktree.ts";
import { buildFileTree, visibleRows, allDirPaths } from "../lib/fileTree.ts";
import { useIncremental } from "../lib/useIncremental.ts";
import { CommandLog } from "./CommandLog.tsx";
import { UnifiedDiff, SplitDiff, ThemePicker, Toggle, SCROLLBAR_CSS, ChangesModal, changesetSig, readWalkCache, writeWalkCache } from "./ChangesModal.tsx";

const unifiedText = (c: GitFileChange) => c.hunks.map((h) => `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@\n${h.lines.join("\n")}`).join("\n");

type View = "changes" | "log" | "reflog" | "branches" | "remotes" | "tags" | "stashes" | "worktrees";

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
  { label: "Refs", views: ["branches", "remotes", "tags"] },
  { label: "Worktrees", views: ["worktrees"] },
  { label: "Stash", views: ["stashes"] },
];
const VIEW_LABEL: Record<View, string> = {
  changes: "Changes", log: "Log", reflog: "Reflog", branches: "Branches",
  remotes: "Remotes", tags: "Tags", stashes: "Stashes", worktrees: "Worktrees",
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
const wtName = (p: string) => p.split("/").pop() || p;

/** What git is mid-way through, when it's mid-way through anything. Worth its
 *  own colour: during a rebase or a merge most commit actions are unavailable
 *  and the only useful move is continue/abort, so the header has to say so
 *  rather than showing a branch name as if nothing were going on. */
const STATE_LABEL: Record<string, string> = {
  rebasing: "rebasing", merging: "merging", "cherry-picking": "cherry-picking",
  reverting: "reverting", bisecting: "bisecting",
};

/**
 * The branch, and how it stands against its upstream — lazygit's reading of it.
 *
 * `✓` in sync · `↑N` ahead · `↓N` behind · `↓N↑M` diverged · nothing at all when
 * the branch doesn't track anything. The tick matters: without it "in sync" and
 * "never fetched" look identical, and the whole point of the auto-fetch is that
 * you can now trust the difference.
 */
function BranchChip({ branch, onCopied }: { branch: GitBranchInfo; onCopied?: (name: string) => void }) {
  const { ahead, behind, upstream, state } = branch;
  const busy = state && state !== "clean" ? STATE_LABEL[state] : null;
  return (
    // One line, always. A ticket-shaped branch name is 60 characters and used
    // to wrap inside the chip, which made the whole header two rows tall and
    // pushed everything else down. The name truncates, the counts never do —
    // they are the part you are actually reading — and the full name is one
    // hover or one click away.
    <span className="px-2 py-0.5 rounded-md text-[11px] inline-flex items-center gap-1 min-w-0 max-w-[min(30vw,340px)] cursor-pointer"
      style={{ background: "color-mix(in srgb, var(--primary) 12%, transparent)", color: "var(--primary-hover)" }}
      onClick={() => {
        navigator.clipboard?.writeText(branch.name).then(() => onCopied?.(branch.name)).catch(() => { /* no clipboard permission */ });
      }}
      title={`${branch.name}${upstream ? `\ntracking ${upstream}` : "\nno upstream — nothing to compare against"}\n\nclick to copy the branch name`}>
      <span className="truncate min-w-0">⎇ {branch.name}</span>
      {busy && <span style={{ color: "var(--warning)" }}>({busy})</span>}
      {/* Behind first, then ahead — it reads as "pull this many, push that many",
          and it's the order lazygit uses, so the shape is already familiar. */}
      {behind > 0 && <span style={{ color: "var(--warning)" }}>↓{behind}</span>}
      {ahead > 0 && <span style={{ color: "var(--success)" }}>↑{ahead}</span>}
      {upstream && !ahead && !behind && <span style={{ color: "var(--success)" }} title="in sync with upstream">✓</span>}
    </span>
  );
}

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
  log: [["j/k", "commit"]],
  reflog: [["j/k", "entry"]],
  branches: [["j/k", "branch"], ["space", "checkout"], ["d", "delete"]],
  remotes: [["j/k", "remote"]],
  tags: [["j/k", "tag"]],
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
function PaneEmpty({ busy, what }: { busy: boolean; what: string }) {
  return (
    <div className="grid place-items-center py-10 t-dim2 text-[12px]">
      {busy
        ? <span className="flex items-center gap-2"><span className="agx-spin" aria-hidden="true" />loading {what}…</span>
        : <>no {what}</>}
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

/**
 * A network action, which is to say one that takes long enough to need saying so.
 *
 * `busy` disables every button at once, which on its own reads as the whole
 * panel having died. Only the button you actually pressed changes its label, so
 * the rest are visibly *waiting* rather than broken.
 */
function RemoteButton({ label, runningLabel, running, disabled, primary, onClick }: {
  label: string; runningLabel?: string; running: boolean; disabled: boolean; primary?: boolean; onClick: () => void;
}) {
  return (
    // nowrap + shrink-0: this row holds a 60-character branch name, and flex
    // was solving the overflow by breaking "↑ push (1)" across two lines and
    // making the whole header taller. The branch chip is the one thing here
    // that may shrink; the controls are not negotiable.
    <button onClick={onClick} disabled={disabled}
      className="text-[11px] px-2.5 py-1 rounded-lg transition-opacity active:scale-[0.97] whitespace-nowrap shrink-0"
      style={{
        color: primary ? "var(--text)" : "var(--text2)",
        fontWeight: primary ? 500 : undefined,
        background: primary ? "color-mix(in srgb, var(--primary) 16%, transparent)" : undefined,
        border: `1px solid color-mix(in srgb, var(--${primary ? "primary" : "border"}) ${primary ? 30 : 35}%, transparent)`,
        // Dim only while *this* one runs, or when writes are off entirely.
        opacity: disabled && !running ? 0.45 : 1,
      }}>
      {running ? (runningLabel ?? `${label}…`) : label}
    </button>
  );
}

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
      <kbd className="shrink-0 text-[10px] px-1.5 py-0.5 rounded font-mono" style={{ minWidth: 54, textAlign: "center", background: "color-mix(in srgb, var(--bg3) 60%, transparent)", border: "1px solid color-mix(in srgb, var(--border) 30%, transparent)", color: "var(--text)" }}>{k}</kbd>
      <span className="text-[11px]" style={{ color: "var(--text2)" }}>{label}</span>
    </div>
  ));
  return (
    <div onClick={onClose} className="absolute inset-0 grid place-items-center" style={{ zIndex: 50, background: "color-mix(in srgb, #000 55%, transparent)" }}>
      <div onClick={(e) => e.stopPropagation()} className="rounded-xl px-5 py-4 shadow-2xl" style={{ minWidth: 420, background: "var(--bg2)", border: "1px solid color-mix(in srgb, var(--border) 55%, transparent)" }}>
        <div className="flex items-center gap-2 mb-3">
          <span className="text-[12px] font-semibold" style={{ color: "var(--text)" }}>Keys</span>
          <span className="text-[10px] px-1.5 py-0.5 rounded" style={{ background: "color-mix(in srgb, var(--primary) 14%, transparent)", color: "var(--primary-hover)" }}>{VIEW_LABEL[view]}</span>
          <button onClick={onClose} className="ml-auto text-[14px] t-dim2 hover:opacity-70">✕</button>
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
  // Only advertised where it works: on a machine with no editor at all, `e`
  // does nothing, and a bar that claims otherwise is the bar lying.
  const keys: [string, string][] = view === "changes" && editorName
    ? [...VIEW_KEYS.changes.slice(0, 2), ["e", `edit in ${editorName}`], ...VIEW_KEYS.changes.slice(2)]
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
      <button onClick={onAll} className="px-1.5 py-0.5 rounded" style={{ color: "var(--text2)", border: "1px solid color-mix(in srgb, var(--border) 30%, transparent)" }}>show all</button>
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
      <span className="w-2.5 text-[8px] shrink-0 t-dim2">{collapsed ? "▶" : "▼"}</span>
      <span className="text-[11px] truncate" style={{ color: "var(--text2)" }}>{name}</span>
      {/* Only meaningful while folded — otherwise you can just count the rows. */}
      {collapsed && <span className="text-[9px] tabular-nums t-dim2">{count}</span>}
    </div>
  );
}

function FileRow({ c, root, active, writeEnabled, desc, onSelect, action, onAction, onDiscard, depth }: {
  c: GitFileChange; root: string; active: boolean; writeEnabled: boolean; desc?: string; onSelect: () => void;
  action: "stage" | "unstage"; onAction: () => void; onDiscard?: () => void;
  /** Set in tree mode; the directory rows above carry the path, so the row
   *  indents instead of repeating it. Undefined means the old flat list. */
  depth?: number;
}) {
  const dir = dirName(c.file_path, root);
  return (
    <div onClick={onSelect} data-file={active ? "active" : undefined}
      className="group flex items-center gap-2 pr-1.5 py-1 rounded-md cursor-pointer"
      style={{ background: active ? "color-mix(in srgb, var(--primary) 15%, transparent)" : "transparent", paddingLeft: depth == null ? 8 : 8 + depth * 12 }}>
      <span className="w-3.5 text-center text-[10px] font-bold shrink-0 self-start mt-0.5" style={{ color: STATUS_TINT[c.status] }} title={c.status}>{STATUS_LETTER[c.status]}</span>
      <span className="min-w-0 flex-1 truncate">
        <span className="block truncate text-[11.5px]" style={{ color: active ? "var(--text)" : "var(--text2)" }}>
          {/* In tree mode the directory is already spelled out by the rows
              above, so repeating it here is noise on every single line. */}
          {baseName(c.file_path)}{depth == null && dir && <span className="t-dim2 text-[9.5px] ml-1.5">{dir}</span>}
        </span>
        {desc && <span className="block truncate text-[9.5px] leading-tight t-dim2" title={desc}>{desc}</span>}
      </span>
      <span className="shrink-0 self-start mt-0.5 text-[9.5px] tabular-nums flex items-center gap-1 opacity-80">
        {c.additions > 0 && <span style={{ color: "var(--success)" }}>+{c.additions}</span>}
        {c.deletions > 0 && <span style={{ color: "var(--error)" }}>−{c.deletions}</span>}
      </span>
      {writeEnabled && (
        <div className="shrink-0 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
          {onDiscard && <button onClick={(e) => { e.stopPropagation(); onDiscard(); }} title="Discard changes (irreversible)" className="w-5 h-5 grid place-items-center rounded text-[11px]" style={{ color: "var(--error)" }}>↺</button>}
          <button onClick={(e) => { e.stopPropagation(); onAction(); }} title={action === "stage" ? "Stage" : "Unstage"} className="w-5 h-5 grid place-items-center rounded text-[13px] font-bold" style={{ color: "var(--text)", background: "color-mix(in srgb, var(--bg3) 60%, transparent)" }}>{action === "stage" ? "＋" : "－"}</button>
        </div>
      )}
    </div>
  );
}

function Section({ title, count, tint, action, onAll, children }: { title: string; count: number; tint: string; action?: string; onAll?: () => void; children: React.ReactNode }) {
  return (
    <div className="mb-1">
      <div className="flex items-center gap-2 px-2 py-1 sticky top-0 z-10" style={{ background: "var(--bg2)" }}>
        <span className="w-1.5 h-1.5 rounded-full" style={{ background: tint }} />
        <span className="text-[10px] uppercase tracking-wider font-semibold" style={{ color: "var(--text2)" }}>{title}</span>
        <span className="text-[9.5px] t-dim2 tabular-nums">{count}</span>
        {action && count > 0 && onAll && <button onClick={onAll} className="ml-auto text-[9.5px] px-1.5 py-0.5 rounded" style={{ color: "var(--text3)", border: "1px solid color-mix(in srgb, var(--border) 30%, transparent)" }}>{action}</button>}
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
export function GitView({ active }: { active: boolean }) {
  const open = active;
  const [repos, setRepos] = useState<GitRepoRef[]>([]);
  const [root, setRoot] = useState<string>("");
  const [tree, setTree] = useState<WorkingTree | null>(null);
  const [view, setView] = useState<View>("changes");
  const [selKey, setSelKey] = useState<string | null>(null);
  const [split, setSplit] = useState(true);
  const [wrap, setWrap] = useState(false);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<{ ok: boolean; msg: string } | null>(null);
  const [repoOpen, setRepoOpen] = useState(false);
  const [repoQuery, setRepoQuery] = useState("");
  // branches / log / stashes / worktrees
  const [branchData, setBranchData] = useState<{ current: string; branches: GitBranch[]; trunk?: string | null }>({ current: "", branches: [] });
  const [newBranch, setNewBranch] = useState("");
  const [graph, setGraph] = useState<GitGraphLine[]>([]);
  const [stashes, setStashes] = useState<GitStash[]>([]);
  const [worktrees, setWorktrees] = useState<GitWorktree[]>([]);
  const [remotes, setRemotes] = useState<GitRemote[]>([]);
  const [tags, setTags] = useState<GitTag[]>([]);
  const [reflog, setReflog] = useState<GitReflogEntry[]>([]);
  /** Which view has a request in flight, so "still loading" and "genuinely
   *  empty" stop rendering as the same blank pane. */
  const [busyView, setBusyView] = useState<View | null>(null);
  /** The "merge from…" list on the header's sync button. */
  const [baseOpen, setBaseOpen] = useState(false);
  // Only the branches whose upstream is gone — the merged-and-tidied ones. Off
  // by default: it's a cleanup mode, not a way to read the branch list.
  const [onlyGone, setOnlyGone] = useState(false);
  // Tree by default, as lazygit does — a change spread across one module reads
  // as a shape rather than as thirty near-identical paths.
  const [treeMode, setTreeMode] = useState(true);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [logOpen, setLogOpen] = useState(false);
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
  const [newWtBranch, setNewWtBranch] = useState("");
  const [commitView, setCommitView] = useState<{ changes: FileChange[]; title: string } | null>(null);
  const [walk, setWalk] = useState<WalkthroughResult | null>(null);
  const [walkLoading, setWalkLoading] = useState(false);
  const walkReqSig = useRef<string | null>(null);
  const treeSeq = useRef(0); // guards stale working-tree responses (repo switches)
  const frameRef = useRef<HTMLDivElement>(null);

  const all = useMemo(() => [...(tree?.staged ?? []), ...(tree?.unstaged ?? [])], [tree]);
  const selected = useMemo(() => all.find((c) => keyOf(c) === selKey) ?? all[0] ?? null, [all, selKey]);

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
  const editFile = async (c: GitFileChange | null, hunkIdx = 0) => {
    if (!c) return;
    const line = c.hunks[hunkIdx]?.newStart ?? c.hunks[0]?.newStart ?? 1;
    try {
      const r = await api.editorOpen(c.file_path, line);
      if (!r.ok) return flash(false, r.error || "could not open the editor");
      if (r.how === "remote") {
        // It landed in a window that may be behind this one, so say so —
        // otherwise pressing `e` looks like it did nothing at all. And when it
        // went to a sibling checkout of the same project rather than this one,
        // name it: the file opens in the nvim you have, which is the point, but
        // you should not have to work out which window it appeared in.
        flash(true, r.viaFamily
          ? `sent to your nvim in ${r.viaFamily.split("/").pop()} · ${baseName(c.file_path)}:${line}`
          : `sent to your open nvim · ${baseName(c.file_path)}:${line}`);
      } else if (r.command) {
        // Nothing reachable for *this* file. Saying "no nvim running" when one
        // is open two panes away sends you looking for a bug; naming the repo
        // it's in explains the refusal in one line.
        // Three different situations, three different things to do about them.
        const elsewhere = r.otherCwds?.length
          ? `nvim is open in ${r.otherCwds.map((p) => p.split("/").pop()).join(", ")}, not this repo — copied: ${r.command}`
          : r.stuck
          ? `an nvim is running but not answering (${r.stuck} stale socket${r.stuck === 1 ? "" : "s"}) — copied: ${r.command}`
          : `no nvim running — copied: ${r.command}`;
        flash(true, elsewhere);
        navigator.clipboard?.writeText(r.command).catch(() => { /* no clipboard permission */ });
      }
    } catch (e) { flash(false, String(e)); }
  };
  const { hilite, themePref, setThemePref, bold, setBold, hiliteError } = useDiffHighlight(selected?.file_path);
  const writeEnabled = tree?.writeEnabled ?? false;
  const flash = (ok: boolean, msg: string) => { setToast({ ok, msg }); setTimeout(() => setToast(null), 2600); };

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
    try { const t = await api.gitTree(r); if (seq !== treeSeq.current) return; setTree(t); if (t.error) flash(false, t.error); }
    catch (e) { if (seq === treeSeq.current) flash(false, String(e)); }
  }, []);
  const rel = (c: GitFileChange) => (c.file_path.startsWith(root + "/") ? c.file_path.slice(root.length + 1) : c.file_path);

  useEffect(() => {
    if (!open) return;
    setToast(null); setTitle(""); setBody(""); setView("changes"); setNewBranch("");
    api.editorCapability().then(setEditor).catch(() => setEditor({ hasNvim: false, editor: null }));
    api.gitRepos().then(({ repos }) => {
      setRepos(repos);
      const first = repos[0]?.root ?? "";
      setRoot((cur) => cur || first); // the [root, open] effect owns tree loading
    }).catch((e) => flash(false, String(e)));
    requestAnimationFrame(() => frameRef.current?.focus());
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
    const track = <T,>(p: Promise<T>, use: (v: T) => void) => {
      setBusyView(view);
      p.then(use).catch(() => {}).finally(() => {
        // Only clear if this is still the view being looked at: switching tabs
        // mid-flight would otherwise have the old request turn off the new
        // one's spinner.
        setBusyView((b) => (b === view ? null : b));
      });
    };
    if (view === "branches") track(api.gitBranches(root), setBranchData);
    else if (view === "log") track(api.gitGraph(root, 500), (r) => setGraph(r.lines));
    else if (view === "stashes") track(api.gitStashes(root), (r) => setStashes(r.stashes));
    else if (view === "worktrees") track(api.gitWorktrees(root), (r) => setWorktrees(r.worktrees));
    else if (view === "remotes") track(api.gitRemotes(root), (r) => setRemotes(r.remotes));
    else if (view === "tags") track(api.gitTags(root), (r) => setTags(r.tags));
    else if (view === "reflog") track(api.gitReflog(root), (r) => setReflog(r.entries));
  }, [open, root, view]);
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
  usePoll(open && !!root && !busy, () => loadTree(root));
  usePoll(open && !!root && !busy, loadView, 10_000);

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
      if (r.ok) { if (okMsg || r.output) flash(true, okMsg || r.output || "done"); } else flash(false, r.error || "failed");
      await loadTree(root);
      // Cheap, and the only way the header chip and the repo dropdown stop
      // showing counts from before the action.
      api.gitRepos().then(({ repos }) => setRepos(repos)).catch(() => {});
      return r.ok;
    } catch (e) { flash(false, String(e)); return false; } finally { setBusy(false); setPending(null); }
  };

  // working tree ops
  const stage = async (c: GitFileChange) => { if (await act(() => api.gitStage(root, [rel(c)]))) setSelKey("s:" + c.file_path); };
  const unstage = async (c: GitFileChange) => { if (await act(() => api.gitUnstage(root, [rel(c)]))) setSelKey("u:" + c.file_path); };
  const discard = (c: GitFileChange) => { if (confirm(`Discard changes to ${baseName(c.file_path)}? This cannot be undone.`)) act(() => api.gitDiscard(root, [rel(c)]), "discarded"); };
  const doCommit = async () => {
    if (!title.trim()) { flash(false, "commit title required"); return; }
    if (await act(() => api.gitCommitStaged(root, title, body), "committed")) { setTitle(""); setBody(""); api.gitGraph(root, 500).then((r) => setGraph(r.lines)).catch(() => {}); }
  };
  // branches
  const reloadBranches = () => api.gitBranches(root).then(setBranchData).catch(() => {});
  const checkout = async (name: string) => { if (await act(() => api.gitCheckout(root, name), `on ${name}`)) { reloadBranches(); setView("changes"); } };
  const createBranch = async () => { const n = newBranch.trim(); if (!n) return; if (await act(() => api.gitBranchCreate(root, n), `created ${n}`)) { setNewBranch(""); reloadBranches(); setView("changes"); } };
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
   *     an ancestor of anything. Only offer the forced retry when we've already
   *     verified the work is in the trunk (`mergedIntoTrunk`, computed against
   *     the trunk rather than whatever HEAD happens to be). Without that proof
   *     the refusal is correct and stands.
   *
   * Deliberately not routed through `act`: it reports failures by flashing the
   * message and returns a bare boolean, and the whole point here is to branch
   * on *which* failure came back.
   */
  const deleteBranch = async (b: GitBranch) => {
    if (busy || !confirm(`Delete branch ${b.name}?`)) return;
    setBusy(true);
    setPending(`delete ${b.name}`);
    try {
      let r = await api.gitBranchDelete(root, b.name, false);
      const wt = r.ok ? null : /worktree at '([^']+)'/.exec(r.error || "")?.[1];
      if (wt) {
        if (!confirm(`${b.name} is checked out in the worktree ${wtName(wt)}.\n\nRemove that worktree and delete the branch?`)) { flash(false, "kept"); return; }
        let rm = await api.gitWorktreeRemove(root, wt, false);
        // git refuses to drop a worktree holding work — modified tracked files
        // or, as often, a stray untracked scratch file. Name the cost, then let
        // them take it.
        if (!rm.ok && /modified|untracked|not clean/i.test(rm.error || "")) {
          if (!confirm(`${wtName(wt)} still has uncommitted or untracked files.\n\nRemove it anyway? That work is gone.`)) { flash(false, rm.error || "kept"); return; }
          rm = await api.gitWorktreeRemove(root, wt, true);
        }
        if (!rm.ok) { flash(false, rm.error || "worktree remove failed"); return; }
        reloadWorktrees();
        r = await api.gitBranchDelete(root, b.name, false);
      }
      if (!r.ok && /not fully merged/i.test(r.error || "") && b.mergedIntoTrunk) {
        const trunk = branchData.trunk ?? "the trunk";
        if (confirm(`git says ${b.name} isn't merged, but its commits are already in ${trunk} — a squash merge rewrites them, so the tip never becomes an ancestor.\n\nDelete it anyway?`)) {
          r = await api.gitBranchDelete(root, b.name, true);
        }
      }
      flash(r.ok, r.ok ? `deleted ${b.name}` : r.error || "failed");
      if (r.ok) reloadBranches();
    } catch (e) { flash(false, String(e)); }
    finally { setBusy(false); setPending(null); }
  };

  // Branches whose upstream is gone. Never the current one: git refuses to
  // delete a checked-out branch anyway, and offering it is just a failed call.
  const goneBranches = branchData.branches.filter((b) => !b.current && trackChip(b.track).gone);
  const goneCount = goneBranches.length;
  const shownBranches = onlyGone ? goneBranches : branchData.branches;

  // Merged into the trunk — the only honest reading of "its PR landed". NOT
  // `git branch -d`, which compares against whatever is checked out: from a
  // worktree on a ticket branch that rejects every merged PR in the repo.
  const goneMerged = goneBranches.filter((b) => b.mergedIntoTrunk);
  const goneUnmerged = goneBranches.filter((b) => !b.mergedIntoTrunk);

  /**
   * Delete the gone branches whose work is already in the trunk.
   *
   * Forced (`-D`), and that's safe *because* of the check above: we've verified
   * each one is an ancestor of the trunk, so there is nothing to lose. Using
   * `-d` and letting git decide is what produced "deleted 0, kept 9" — git was
   * comparing against the ticket branch the worktree had checked out.
   *
   * Anything gone but *not* in the trunk is left alone and named. That's the
   * genuinely dangerous case — a remote branch deleted without merging — and
   * it's the one case where an unrecoverable delete would actually cost you
   * something.
   */
  const deleteGone = async () => {
    if (!goneMerged.length || busy) return;
    const trunk = branchData.trunk ?? "the trunk";
    if (!confirm(
      `Delete ${goneMerged.length} branch${goneMerged.length === 1 ? "" : "es"} already merged into ${trunk}?` +
      (goneUnmerged.length ? `\n\n${goneUnmerged.length} more have no remote branch but are NOT in ${trunk} — those are kept.` : "")
    )) return;
    setBusy(true);
    const failed: string[] = [];
    try {
      for (const b of goneMerged) {
        const r = await api.gitBranchDelete(root, b.name, true).catch(() => ({ ok: false }));
        if (!r.ok) failed.push(b.name);
      }
      const done = goneMerged.length - failed.length;
      flash(failed.length === 0,
        failed.length === 0
          ? `deleted ${done} merged branch${done === 1 ? "" : "es"}`
          : `deleted ${done}, ${failed.length} failed: ${failed.slice(0, 3).join(", ")}${failed.length > 3 ? "…" : ""}`);
    } finally {
      setBusy(false);
      reloadBranches();
    }
  };
  const mergeBranch = (name: string) => { if (confirm(`Merge ${name} into the current branch?`)) act(() => api.gitMerge(root, name), `merged ${name}`).then((ok) => { if (ok) reloadBranches(); }); };
  const rebaseBranch = (name: string) => { if (confirm(`Rebase the current branch onto ${name}?`)) act(() => api.gitRebase(root, name), `rebased onto ${name}`).then((ok) => { if (ok) reloadBranches(); }); };
  const renameBranch = (name: string) => { const to = prompt(`Rename ${name} to:`, name); if (to && to.trim() && to !== name) act(() => api.gitBranchRename(root, name, to.trim()), `renamed → ${to.trim()}`).then((ok) => { if (ok) reloadBranches(); }); };
  // log
  const openCommit = async (hash: string, subject: string) => {
    try { const { changes } = await api.gitCommitDiff(root, hash); setCommitView({ changes, title: `${hash} · ${subject}` }); }
    catch (e) { flash(false, String(e)); }
  };
  const resetTo = (hash: string, mode: "soft" | "mixed" | "hard") => {
    if (mode === "hard" && !confirm(`Hard reset to ${hash}? This DISCARDS working-tree changes.`)) return;
    act(() => api.gitReset(root, hash, mode), `reset --${mode} ${hash}`).then((ok) => { if (ok) api.gitGraph(root, 500).then((r) => setGraph(r.lines)); });
  };
  // worktrees
  const reloadWorktrees = () => api.gitWorktrees(root).then((r) => setWorktrees(r.worktrees)).catch(() => {});
  const addWorktree = async () => {
    const br = newWtBranch.trim(); if (!br) return;
    const path = `${root}-${br.replace(/[\/\s]+/g, "-")}`; // sibling dir named repo-branch
    if (await act(() => api.gitWorktreeAdd(root, path, br, true), `worktree ${wtName(path)}`)) { setNewWtBranch(""); reloadWorktrees(); }
  };
  // Same shape as the worktree step inside deleteBranch: a dirty worktree is a
  // question ("that work is gone — still?"), not a dead end.
  const removeWorktree = async (w: GitWorktree) => {
    if (busy || !confirm(`Remove worktree ${wtName(w.path)}?`)) return;
    setBusy(true);
    setPending(`remove ${wtName(w.path)}`);
    try {
      let r = await api.gitWorktreeRemove(root, w.path, false);
      if (!r.ok && /modified|untracked|not clean/i.test(r.error || "")) {
        if (!confirm(`${wtName(w.path)} still has uncommitted or untracked files.\n\nRemove it anyway? That work is gone.`)) { flash(false, r.error || "kept"); return; }
        r = await api.gitWorktreeRemove(root, w.path, true);
      }
      flash(r.ok, r.ok ? "removed worktree" : r.error || "failed");
      if (r.ok) { reloadWorktrees(); reloadBranches(); }
    } catch (e) { flash(false, String(e)); }
    finally { setBusy(false); setPending(null); }
  };
  const openWorktree = (w: GitWorktree) => { setRoot(w.path); setRepoOpen(false); setSelKey(null); setView("changes"); };
  // stashes
  const reloadStashes = () => api.gitStashes(root).then((r) => setStashes(r.stashes)).catch(() => {});
  const stashPush = async () => { if (await act(() => api.gitStashPush(root, ""), "stashed")) reloadStashes(); };
  const stashOp = async (op: "apply" | "pop" | "drop", index: number) => {
    if (op === "drop" && !confirm("Drop this stash?")) return;
    const fn = op === "apply" ? api.gitStashApply : op === "pop" ? api.gitStashPop : api.gitStashDrop;
    if (await act(() => fn(root, index), op + "ed")) reloadStashes();
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
    if (/input|textarea|select/i.test(el?.tagName ?? "") || el?.isContentEditable) return;
    if (commitView) return;
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
    else if (k === "e" && selected && editor?.editor) { e.preventDefault(); void editFile(selected); }
  };

  // Which tab each group was last left on, so 1–5 returns you where you were.
  const lastTab = useRef<(View | undefined)[]>([]);
  useEffect(() => {
    const i = VIEW_GROUPS.findIndex((g) => g.views.includes(view));
    if (i >= 0) lastTab.current[i] = view;
  }, [view]);

  // interactive hunk staging (unified view, modified files)
  const applyHunk = (action: "stage" | "unstage" | "discard", i: number) => {
    if (!selected || !writeEnabled) return;
    if (action === "discard" && !confirm("Discard this hunk? This cannot be undone.")) return;
    act(() => api.gitApplyHunk(root, selected.file_path, selected.staged, action, selected.hunks[i]), `${action}d hunk`);
  };
  const hunkBtn = (label: string, tint: string, onClick: () => void) => (
    <button onClick={onClick} className="text-[9px] px-1.5 py-0.5 rounded" style={{ fontFamily: "system-ui, sans-serif", color: tint, background: "color-mix(in srgb, var(--bg3) 70%, transparent)", border: "1px solid color-mix(in srgb, var(--border) 30%, transparent)" }}>{label}</button>
  );
  const hunkActionFn = (writeEnabled && selected && selected.status === "modified" && !selected.binary)
    ? (i: number) => (
        <span className="inline-flex items-center gap-1">
          {selected.staged
            ? hunkBtn("－ unstage hunk", "var(--text)", () => applyHunk("unstage", i))
            : <>{hunkBtn("＋ stage hunk", "var(--text)", () => applyHunk("stage", i))}{hunkBtn("↺ discard", "var(--error)", () => applyHunk("discard", i))}</>}
        </span>
      )
    : undefined;

  const repoRef = repos.find((r) => r.root === root);
  const branch = tree?.branch;
  const toggleDir = (path: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      next.has(path) ? next.delete(path) : next.add(path);
      return next;
    });

  /** One staged/unstaged group, as a tree or as the old flat list. Both paths
   *  emit the same FileRow, so selection, staging and the diff pane don't know
   *  which mode they're in. */
  const renderFiles = (changes: GitFileChange[], action: "stage" | "unstage", onAction: (c: GitFileChange) => void, prefix: string) => {
    const row = (c: GitFileChange, depth?: number) => (
      <FileRow key={prefix + c.file_path} c={c} root={root} writeEnabled={writeEnabled} depth={depth}
        desc={descMap.get(c.file_path)?.description} active={selKey === keyOf(c)}
        onSelect={() => setSelKey(keyOf(c))} action={action} onAction={() => onAction(c)}
        onDiscard={action === "stage" && writeEnabled ? () => discard(c) : undefined} />
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
  const incBranches = useIncremental(shownBranches, `${root}:${onlyGone}`);
  const incGraph = useIncremental(graph, root);
  const incReflog = useIncremental(reflog, root);
  const incTags = useIncremental(tags, root);

  /** How many rows the focused view has, so j/k knows where the end is. */
  const rowCount =
    view === "branches" ? shownBranches.length :
    view === "reflog" ? reflog.length :
    view === "tags" ? tags.length :
    view === "remotes" ? remotes.length :
    view === "stashes" ? stashes.length :
    view === "worktrees" ? worktrees.length :
    view === "log" ? graph.length : 0;

  // A list that shrinks under the cursor (deleting branches, applying stashes)
  // would otherwise leave it pointing past the end.
  useEffect(() => { setRowIdx((i) => (rowCount ? Math.min(i, rowCount - 1) : 0)); }, [rowCount]);
  useEffect(() => { setRowIdx(0); }, [view, root]);

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
      if (!b || b.current) return;
      kind === "primary" ? checkout(b.name) : deleteBranch(b);
    } else if (view === "stashes") {
      const s = stashes[rowIdx];
      if (!s) return;
      stashOp(kind === "primary" ? "apply" : "drop", s.index);
    } else if (view === "worktrees") {
      const w = worktrees[rowIdx];
      if (!w || (kind === "delete" && w.current)) return;
      kind === "primary" ? openWorktree(w) : removeWorktree(w);
    }
  };
  const hasRowAction = view === "branches" || view === "stashes" || view === "worktrees";

  const COUNTS: Partial<Record<View, number>> = {
    changes: all.length, branches: branchData.branches.length, worktrees: worktrees.length,
    stashes: stashes.length, remotes: remotes.length, tags: tags.length,
  };
  const ViewTab = ({ id }: { id: View }) => {
    const n = COUNTS[id];
    const num = ALL_VIEWS.indexOf(id) + 1;
    return (
      <button onClick={() => setView(id)} title={`${VIEW_LABEL[id]} — press ${num}`}
        aria-keyshortcuts={String(num)}
        className="text-[10.5px] px-2 py-1 rounded-md transition-colors flex items-center gap-1.5 whitespace-nowrap shrink-0"
        style={{ background: view === id ? "color-mix(in srgb, var(--primary) 16%, transparent)" : "transparent", color: view === id ? "var(--text)" : "var(--text3)", border: `1px solid color-mix(in srgb, var(--border) ${view === id ? 40 : 15}%, transparent)` }}>
        {/* The key that gets you here. lazygit does the same in its panel titles
            (gui.showPanelJumps) — a shortcut nothing advertises is a shortcut
            nobody uses.

            Drawn as a keycap rather than a bare digit. Bare, it read as a
            count — "1 Changes" looked like one change — and next to a real one
            ("4 Branches 44") the row became two numbers with a word wedged
            between them. An outlined cap says "press this"; the count beside
            it is a filled chip, so the two are different kinds of object
            before either is read. */}
        <span
          className="tabular-nums leading-none rounded-[3px] px-1 py-[1px]"
          style={{
            fontSize: 8.5,
            opacity: view === id ? 0.85 : 0.5,
            border: "1px solid color-mix(in srgb, var(--text3) 45%, transparent)",
          }}
        >{num}</span>
        {VIEW_LABEL[id]}
        {n != null && n > 0 && (
          <span
            className="tabular-nums leading-none rounded-full px-1.5 py-[1px]"
            style={{ fontSize: 9, background: "color-mix(in srgb, var(--primary) 18%, transparent)", color: "var(--primary-hover)" }}
          >{n}</span>
        )}
      </button>
    );
  };
  /** One group's tabs. A single-view group renders as a plain button; a
   *  multi-view one shows its siblings separated by a hairline, which is what
   *  makes "these three are one panel" legible without a second row. */
  const ViewGroup = ({ views }: { views: View[] }) => (
    <div className="flex items-center gap-px rounded-md" style={views.length > 1 ? { background: "color-mix(in srgb, var(--border) 12%, transparent)" } : undefined}>
      {views.map((v) => <ViewTab key={v} id={v} />)}
    </div>
  );

  return (
    <div ref={frameRef} tabIndex={-1} onKeyDown={onKey}
      className="flex-1 min-h-0 flex flex-col outline-none overflow-hidden relative">
                <style>{SCROLLBAR_CSS}</style>
                {/* No overflow-hidden here, ever: the repo picker's dropdown is
                    absolutely positioned inside this row, and clipping the row
                    clipped the menu to a sliver. Overflow is prevented by the
                    branch chip yielding space and the tab strip scrolling —
                    not by cutting off whatever escapes. */}
                <div className="flex items-center gap-3 px-5 py-3 border-b shrink-0" style={{ borderColor: "color-mix(in srgb, var(--border) 40%, transparent)" }}>
                  <span className="text-[15px] font-semibold whitespace-nowrap shrink-0" style={{ color: "var(--text)" }}>Source control</span>
                  <div className="relative">
                    {/* Also one line. A worktree directory carries the whole
                        ticket name, and wrapped it made the button two rows
                        tall and shoved the tab strip down with it. */}
                    <button onClick={() => setRepoOpen((o) => !o)} className="flex items-center gap-1.5 text-[11px] px-2.5 py-1 rounded-lg max-w-[240px] shrink-0 whitespace-nowrap" style={{ background: "color-mix(in srgb, var(--bg3) 50%, transparent)", border: "1px solid color-mix(in srgb, var(--border) 40%, transparent)", color: "var(--text)" }}
                      title={repoRef ? `${repoRef.name}\n${repoRef.root}` : undefined}>
                      <span className="font-medium truncate min-w-0">{repoRef?.name ?? "repo"}</span><span className="t-dim2 shrink-0">▼</span>
                    </button>
                    {repoOpen && (
                      <div className="absolute left-0 mt-1 rounded-lg text-[11px] shadow-2xl flex flex-col" style={{ zIndex: 30, background: "var(--bg2)", border: "1px solid color-mix(in srgb, var(--border) 55%, transparent)", minWidth: 320, maxHeight: 420, overflow: "hidden" }}>
                        <input autoFocus value={repoQuery} onChange={(e) => setRepoQuery(e.target.value)} placeholder="filter repos…" className="m-1.5 px-2.5 py-1.5 rounded-md text-[11px] outline-none shrink-0" style={{ background: "color-mix(in srgb, var(--bg3) 50%, transparent)", border: "1px solid color-mix(in srgb, var(--border) 40%, transparent)", color: "var(--text)" }} />
                        <div className="agx-scroll overflow-y-auto pb-1" style={{ minHeight: 0 }}>
                          {/* Path included: a worktree is found by its card id
                              ("20343"), which lives in the directory name. */}
                          {repos.filter((r) => { const q = repoQuery.trim().toLowerCase(); return !q || (r.name + " " + r.branch + " " + r.root).toLowerCase().includes(q); }).map((r) => (
                            <button key={r.root} onClick={() => { setRoot(r.root); setRepoOpen(false); setRepoQuery(""); setSelKey(null); }} className="w-full text-left px-2.5 py-1.5 flex items-center gap-2" style={{ background: r.root === root ? "color-mix(in srgb, var(--primary) 15%, transparent)" : "transparent" }}>
                              {/* Was "└", an indent meaning "child of the line
                                  above" — which says nothing once you filter
                                  the list and the parent is off screen, and
                                  left projects marked by the absence of a
                                  character. A badge names the kind outright,
                                  and reads the same wherever the row lands.
                                  The terminal's picker uses the same one. */}
                              <span
                                className="shrink-0 text-[8.5px] leading-none px-1 py-[2px] rounded"
                                title={r.worktreeOf ? `worktree of ${r.worktreeOf}` : "main checkout"}
                                style={r.worktreeOf
                                  ? { color: "var(--primary)", background: "color-mix(in srgb, var(--primary) 16%, transparent)", border: "1px solid color-mix(in srgb, var(--primary) 32%, transparent)" }
                                  : { color: "var(--text3)", border: "1px solid color-mix(in srgb, var(--border) 40%, transparent)" }}
                              >{r.worktreeOf ? "WT" : "REPO"}</span>
                              {/* A worktree IS its branch — that's the whole point
                                  of having one per ticket. The directory name is
                                  a terse stub of it (`orbit-WEB-1188` for a
                                  branch called `WEB-1188-quota-banner-copy…`),
                                  so leading with the directory spent the wide
                                  column on the less informative of the two and
                                  truncated the one you were reading. Projects
                                  keep their name, since there the folder is the
                                  identity and the branch is just what's checked
                                  out right now. */}
                              <span className="min-w-0 flex-1 truncate font-medium" style={{ color: "var(--text)" }} title={r.worktreeOf ? `${r.branch}\n${r.root}` : r.root}>
                                {r.worktreeOf ? r.branch : r.name}
                              </span>
                              {!r.worktreeOf && <span className="shrink-0 truncate t-dim2 text-[9.5px]" style={{ maxWidth: 150 }} title={r.branch}>{r.branch}</span>}
                              {r.dirty > 0 && <span className="shrink-0 text-[9px] tabular-nums" style={{ color: "var(--warning)" }}>●{r.dirty}</span>}
                              {/* Same reading as the header chip. This used to be
                                  hardcoded to zero, so the one place you pick a
                                  repo from could never tell you one had drifted. */}
                              {r.behind > 0 && <span className="shrink-0 text-[9px] tabular-nums" style={{ color: "var(--warning)" }} title={`${r.behind} behind upstream`}>↓{r.behind}</span>}
                              {r.ahead > 0 && <span className="shrink-0 text-[9px] tabular-nums" style={{ color: "var(--success)" }} title={`${r.ahead} ahead of upstream`}>↑{r.ahead}</span>}
                            </button>
                          ))}
                          {!repos.length && <div className="px-3 py-2 t-dim2">no repos seen yet</div>}
                        </div>
                      </div>
                    )}
                  </div>
                  {/* Scrolls rather than shoves. Eight tabs plus a long branch
                      name will not fit a narrow window, and something has to
                      give — a strip you can flick is better than controls
                      pushed off the right edge. */}
                  <div className="flex items-center gap-2 ml-1 min-w-0 overflow-x-auto agw-noscrollbar">
                    {VIEW_GROUPS.map((g) => <ViewGroup key={g.label} views={g.views} />)}
                  </div>
                  <div className="ml-auto flex items-center gap-1.5 min-w-0">
                    {branch && <BranchChip branch={branch} onCopied={(n) => flash(true, `copied ${n}`)} />}
                    {/* Update from base — merge master's latest into the branch
                        you are on, in this checkout. Sits with fetch/pull/push
                        because it belongs to the same family of "bring this
                        checkout up to date"; it was only on the Worktrees tab
                        before, which is not where anyone looks for it.
                        Hidden when there is nothing to merge, and on the trunk
                        itself, which has no base. */}
                    {branch?.base && (branch.behindBase ?? 0) > 0 && (
                      <div className="relative flex items-center">
                        <button
                          onClick={() => act(() => api.gitSyncBase(root), `merged ${branch.base}`, "sync")}
                          disabled={!writeEnabled || busy}
                          className="text-[11px] px-2 py-1 rounded-l-lg whitespace-nowrap"
                          style={{ color: "var(--warning)", border: "1px solid color-mix(in srgb, var(--warning) 40%, transparent)", borderRight: "none", opacity: (!writeEnabled || busy) ? 0.5 : 1 }}
                          title={`Merge ${branch.base} into ${branch.name}. Brings the base branch's latest commits into this one — a merge, not a rebase, so nothing already pushed is rewritten.`}>
                          {pending === "sync" ? "syncing…" : `⇣ sync ↓${branch.behindBase}`}
                        </button>
                        {/* Not every branch is cut from trunk. This picks what
                            to merge from and remembers it in the repo's own
                            config, so the choice sticks per branch. */}
                        <button
                          onClick={() => setBaseOpen((o) => !o)}
                          disabled={!writeEnabled || busy}
                          className="text-[11px] px-1.5 py-1 rounded-r-lg"
                          style={{ color: "var(--warning)", border: "1px solid color-mix(in srgb, var(--warning) 40%, transparent)", opacity: (!writeEnabled || busy) ? 0.5 : 1 }}
                          title={`Merging from ${branch.base} — pick a different base`}>▾</button>
                        {baseOpen && (
                          <div className="absolute right-0 top-full mt-1 rounded-lg text-[11px] shadow-2xl flex flex-col"
                            style={{ zIndex: 40, background: "var(--bg2)", border: "1px solid color-mix(in srgb, var(--border) 55%, transparent)", minWidth: 260, maxHeight: 320, overflow: "hidden" }}>
                            <div className="px-2.5 py-1.5 t-dim2 text-[9.5px] uppercase tracking-wider shrink-0">merge into {branch.name} from…</div>
                            <div className="agx-scroll overflow-y-auto pb-1">
                              {branchData.branches.filter((b) => b.name !== branch.name).map((b) => (
                                <button key={b.name} onClick={async () => {
                                  setBaseOpen(false);
                                  await act(() => api.gitSetBase(root, branch.name, b.name), `base set to ${b.name}`, "sync");
                                }}
                                  className="w-full text-left px-2.5 py-1.5 truncate"
                                  style={{ background: b.name === branch.base ? "color-mix(in srgb, var(--primary) 15%, transparent)" : "transparent", color: "var(--text)" }}
                                  title={b.name}>{b.name}</button>
                              ))}
                              {!branchData.branches.length && <div className="px-2.5 py-2 t-dim2">open the Branches tab first</div>}
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                    {/* Each says what it's doing while it does it. A pull over a
                        slow network is several seconds of nothing otherwise, and
                        the honest reading of that is "the button is broken". */}
                    <RemoteButton label="fetch" running={pending === "fetch"} disabled={!writeEnabled || busy}
                      onClick={() => act(() => api.gitFetch(root), "fetched", "fetch")} />
                    <RemoteButton label={`↓ pull${branch && branch.behind > 0 ? ` (${branch.behind})` : ""}`} runningLabel="pulling…"
                      running={pending === "pull"} disabled={!writeEnabled || busy}
                      onClick={() => act(() => api.gitPull(root), "pulled", "pull")} />
                    <RemoteButton label={`↑ push${branch && branch.ahead > 0 ? ` (${branch.ahead})` : ""}`} runningLabel="pushing…"
                      running={pending === "push"} disabled={!writeEnabled || busy} primary
                      onClick={() => act(() => api.gitPush(root), "pushed", "push")} />
                    <button onClick={() => loadTree(root)} title="Refresh" className="text-[13px] px-2 py-1 rounded-lg" style={{ color: "var(--text2)" }}>⟳</button>
                  </div>
                </div>

                {view === "changes" ? (
                  <div className="flex-1 min-h-0 flex">
                    <div className="w-[340px] shrink-0 border-r flex flex-col min-h-0" style={{ borderColor: "color-mix(in srgb, var(--border) 40%, transparent)" }}>
                      {!tree?.clean && (
                        <div className="shrink-0 px-2.5 py-2 border-b" style={{ borderColor: "color-mix(in srgb, var(--border) 40%, transparent)" }}>
                          <button onClick={() => explain(!!walk)} disabled={walkLoading} className="text-[11px] px-2.5 py-1 rounded-lg w-full" style={{ color: "var(--text)", background: "color-mix(in srgb, var(--info) 13%, transparent)", border: "1px solid color-mix(in srgb, var(--info) 28%, transparent)", opacity: walkLoading ? 0.6 : 1 }}>
                            {walkLoading ? "✨ explaining…" : walk ? "✨ re-explain changes" : "✨ Explain changes"}
                          </button>
                          {(walk?.reviewFocus || walk?.error) && (
                            <div className="mt-1.5 text-[10px] leading-snug" style={{ color: walk?.error ? "var(--warning)" : "var(--text2)" }}>
                              {walk?.reviewFocus ? <><span className="t-dim2 uppercase tracking-wide text-[8.5px] mr-1">focus</span>{walk.reviewFocus}</> : walk?.error}
                            </div>
                          )}
                        </div>
                      )}
                      {!tree?.clean && (
                        <div className="shrink-0 flex items-center gap-1 px-2.5 py-1 border-b" style={{ borderColor: "color-mix(in srgb, var(--border) 25%, transparent)" }}>
                          <button onClick={() => setTreeMode((v) => !v)} title="Toggle file tree / flat list (`)" className="text-[9.5px] px-1.5 py-0.5 rounded" style={{ color: "var(--text3)", border: "1px solid color-mix(in srgb, var(--border) 25%, transparent)" }}>{treeMode ? "⊟ tree" : "≡ flat"}</button>
                          {treeMode && (
                            <>
                              <button onClick={() => setCollapsed(new Set(allDirPaths(buildFileTree(all, relOf))))} title="Collapse all (-)" className="text-[9.5px] px-1.5 py-0.5 rounded" style={{ color: "var(--text3)" }}>−</button>
                              <button onClick={() => setCollapsed(new Set())} title="Expand all (=)" className="text-[9.5px] px-1.5 py-0.5 rounded" style={{ color: "var(--text3)" }}>＋</button>
                            </>
                          )}
                        </div>
                      )}
                      <div className="agx-scroll flex-1 min-h-0 overflow-y-auto py-1">
                        {tree?.clean && <div className="px-3 py-6 text-center t-dim2 text-[11px]">✓ nothing to commit, working tree clean</div>}
                        {!!tree?.staged.length && (
                          <Section title="Staged" count={tree.staged.length} tint="var(--success)" action="unstage all" onAll={writeEnabled ? () => act(() => api.gitUnstageAll(root)) : undefined}>
                            {renderFiles(tree.staged, "unstage", unstage, "s")}
                          </Section>
                        )}
                        {!!tree?.unstaged.length && (
                          <Section title="Changes" count={tree.unstaged.length} tint="var(--warning)" action="stage all" onAll={writeEnabled ? () => act(() => api.gitStageAll(root)) : undefined}>
                            {renderFiles(tree.unstaged, "stage", stage, "u")}
                          </Section>
                        )}
                      </div>
                      <div className="shrink-0 border-t p-2.5 space-y-2" style={{ borderColor: "color-mix(in srgb, var(--border) 40%, transparent)" }}>
                        <input value={title} onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter") doCommit(); }} placeholder="Commit message (summary)…" disabled={!writeEnabled} className="w-full px-2.5 py-1.5 rounded-lg text-[11.5px] outline-none" style={{ background: "color-mix(in srgb, var(--bg3) 40%, transparent)", border: "1px solid color-mix(in srgb, var(--border) 45%, transparent)", color: "var(--text)" }} />
                        <textarea value={body} onChange={(e) => setBody(e.target.value)} onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter") doCommit(); }} placeholder="Extended description (optional)…" rows={2} disabled={!writeEnabled} className="agx-scroll w-full px-2.5 py-1.5 rounded-lg text-[11px] outline-none resize-none" style={{ background: "color-mix(in srgb, var(--bg3) 40%, transparent)", border: "1px solid color-mix(in srgb, var(--border) 45%, transparent)", color: "var(--text)" }} />
                        <button onClick={doCommit} disabled={!writeEnabled || busy || !tree?.staged.length || !title.trim()} className="w-full py-1.5 rounded-lg text-[11.5px] font-semibold" style={{ background: "color-mix(in srgb, var(--primary) 22%, transparent)", border: "1px solid color-mix(in srgb, var(--primary) 45%, transparent)", color: "var(--text)", opacity: (!writeEnabled || !tree?.staged.length || !title.trim()) ? 0.45 : 1 }}>⎇ Commit {tree?.staged.length ? `${tree.staged.length} staged` : ""}</button>
                        {!writeEnabled && <div className="text-[9.5px] t-dim2 text-center">read-only (AGENTGLASS_GIT_WRITE_DISABLED)</div>}
                      </div>
                    </div>
                    <div className="flex-1 min-w-0 min-h-0 flex flex-col">
                      {selected ? (
                        <>
                          <div className="flex items-center gap-2 px-4 py-2 border-b shrink-0" style={{ borderColor: "color-mix(in srgb, var(--border) 40%, transparent)" }}>
                            <span className="w-3.5 text-center text-[11px] font-bold shrink-0" style={{ color: STATUS_TINT[selected.status] }}>{STATUS_LETTER[selected.status]}</span>
                            <span className="text-[12px] font-medium truncate" style={{ color: "var(--text)" }} title={selected.file_path}>{rel(selected)}</span>
                            <span className="shrink-0 text-[10.5px] tabular-nums flex items-center gap-1.5">
                              {selected.additions > 0 && <span style={{ color: "var(--success)" }}>+{selected.additions}</span>}
                              {selected.deletions > 0 && <span style={{ color: "var(--error)" }}>−{selected.deletions}</span>}
                            </span>
                            <div className="ml-auto flex items-center gap-1.5 shrink-0">
                              {writeEnabled && (selected.staged ? <Toggle onClick={() => unstage(selected)} title="Unstage this file">－ unstage</Toggle> : <Toggle onClick={() => stage(selected)} title="Stage this file">＋ stage</Toggle>)}
                              <Toggle on={split} onClick={() => setSplit((s) => !s)} title="Split / unified">{split ? "split" : "unified"}</Toggle>
                              <Toggle on={wrap} onClick={() => setWrap((w) => !w)} title="Toggle line wrap">wrap</Toggle>
                              <ThemePicker value={themePref} onChange={setThemePref} error={hiliteError} />
                              <Toggle on={bold} onClick={() => setBold((b) => !b)} title="Bold keywords, functions & types (Neovim-style)">bold</Toggle>
                            </div>
                          </div>
                          <div className="flex-1 min-h-0 flex relative" style={{ background: "var(--bg)" }}>
                            {selected.binary ? <div className="flex-1 grid place-items-center t-dim2 text-[12px]">binary file — no textual diff</div>
                              : <HiliteCtx.Provider value={selected.hunks.reduce((n, h) => n + h.lines.length, 0) > 3000 ? { ...hilite, theme: null } : hilite}>{split ? <SplitDiff c={selected} wrap={wrap} /> : <UnifiedDiff c={selected} wrap={wrap} hunkAction={hunkActionFn} />}</HiliteCtx.Provider>}
                          </div>
                        </>
                      ) : <div className="flex-1 grid place-items-center t-dim2 text-[12px]">{tree ? "select a file to view its diff" : "loading…"}</div>}
                    </div>
                  </div>
                ) : view === "log" ? (
                  <div onScroll={incGraph.onScroll} className="agx-scroll flex-1 min-h-0 overflow-auto py-1 text-[11.5px]" style={{ fontFamily: "var(--font-mono, ui-monospace), monospace" }}>
                    {incGraph.rows.map((l, i) => {
                      const isCommit = !!l.hash;
                      return (
                        <div key={i} onClick={isCommit ? () => { setRowIdx(i); openCommit(l.hash!, l.subject || ""); } : undefined}
                          {...rowProps(i === rowIdx)}
                          className={`flex items-center gap-2 px-3 whitespace-pre ${isCommit ? "cursor-pointer hover:brightness-125" : ""}`}
                          style={{ lineHeight: "1.55", ...(i === rowIdx ? rowProps(true).style : {}) }}
                          title={isCommit ? "View this commit's diff" : undefined}
                          onContextMenu={isCommit ? (e) => { e.preventDefault(); const m = prompt(`reset current branch to ${l.hash} — type: soft, mixed, or hard`, "mixed"); if (m === "soft" || m === "mixed" || m === "hard") resetTo(l.hash!, m); } : undefined}>
                          <span style={{ color: "color-mix(in srgb, var(--primary) 75%, var(--text3))" }}>{l.graph}</span>
                          {isCommit && <>
                            <span className="shrink-0 tabular-nums" style={{ color: "var(--primary-hover)" }}>{l.hash}</span>
                            {l.refs && <span className="shrink-0 text-[9px] px-1.5 py-0.5 rounded" style={{ color: "var(--success)", background: "color-mix(in srgb, var(--success) 12%, transparent)" }}>{l.refs}</span>}
                            <span className="min-w-0 flex-1 truncate" style={{ color: "var(--text)" }}>{l.subject}</span>
                            <span className="shrink-0 text-[9.5px] t-dim2">{l.author}</span>
                            <span className="shrink-0 text-[9.5px] t-dim2 w-24 text-right">{l.date}</span>
                          </>}
                        </div>
                      );
                    })}
                    {!graph.length && <PaneEmpty busy={busyView === "log"} what="commits" />}
                    <MoreRows shown={incGraph.rows.length} total={graph.length} onAll={incGraph.showAll} />
                  </div>
                ) : view === "branches" ? (
                  <div onScroll={incBranches.onScroll} className="agx-scroll flex-1 min-h-0 overflow-y-auto p-3">
                    {writeEnabled && (
                      <div className="flex items-center gap-2 mb-3 max-w-lg">
                        <input value={newBranch} onChange={(e) => setNewBranch(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") createBranch(); }} placeholder="new-branch-name" className="flex-1 px-2.5 py-1.5 rounded-lg text-[11.5px] outline-none" style={{ background: "color-mix(in srgb, var(--bg3) 40%, transparent)", border: "1px solid color-mix(in srgb, var(--border) 45%, transparent)", color: "var(--text)" }} />
                        <button onClick={createBranch} disabled={busy || !newBranch.trim()} className="text-[11px] px-3 py-1.5 rounded-lg font-medium" style={{ background: "color-mix(in srgb, var(--primary) 18%, transparent)", border: "1px solid color-mix(in srgb, var(--primary) 40%, transparent)", color: "var(--text)", opacity: newBranch.trim() ? 1 : 0.5 }}>+ create & switch</button>
                      </div>
                    )}
                    {/* Merged-and-tidied branches pile up invisibly — a repo worked
                        one-ticket-per-branch ends up mostly dead entries. lazygit
                        marks them but never lets you see just those, which is the
                        view you want when the actual job is deleting them. */}
                    {goneCount > 0 && (
                      <div className="flex items-center gap-2 mb-2">
                        <button onClick={() => setOnlyGone((v) => !v)} className="text-[10.5px] px-2.5 py-1 rounded-lg transition-colors"
                          style={{ background: onlyGone ? "color-mix(in srgb, var(--error) 16%, transparent)" : "transparent", border: `1px solid color-mix(in srgb, var(--error) ${onlyGone ? 45 : 22}%, transparent)`, color: onlyGone ? "var(--text)" : "var(--text2)" }}
                          title="Branches whose remote branch no longer exists — usually a merged PR that was tidied up">
                          {onlyGone ? "✕ show all branches" : `⌫ ${goneCount} gone`}
                        </button>
                        {/* Only offers what it can actually deliver: the ones
                            verified to be in the trunk. "delete all N" that
                            deletes zero is worse than a smaller honest number. */}
                        {onlyGone && writeEnabled && goneMerged.length > 0 && (
                          <button onClick={deleteGone} disabled={busy} className="text-[10.5px] px-2.5 py-1 rounded-lg font-medium"
                            style={{ background: "color-mix(in srgb, var(--error) 18%, transparent)", border: "1px solid color-mix(in srgb, var(--error) 40%, transparent)", color: "var(--error)", opacity: busy ? 0.55 : 1 }}>
                            {busy ? "deleting…" : `delete ${goneMerged.length} merged`}
                          </button>
                        )}
                        {onlyGone && (
                          <span className="text-[9.5px] t-dim2">
                            {goneMerged.length > 0 && <>{goneMerged.length} already in {branchData.trunk ?? "the trunk"}</>}
                            {goneMerged.length > 0 && goneUnmerged.length > 0 && " · "}
                            {goneUnmerged.length > 0 && <span style={{ color: "var(--warning)" }}>{goneUnmerged.length} not merged — kept</span>}
                          </span>
                        )}
                      </div>
                    )}
                    {!incBranches.rows.length && <PaneEmpty busy={busyView === "branches"} what="branches" />}
                    {incBranches.rows.map((b, i) => {
                      const t = trackChip(b.track);
                      const sel = i === rowIdx;
                      return (
                        // The cursor wins over the current-branch tint: you need
                        // to see where the keyboard is, and "this is HEAD" is
                        // already said by the ⎇ glyph.
                        <div key={b.name} onClick={() => setRowIdx(i)} {...rowProps(sel)}
                          className="group flex items-center gap-2 px-2.5 py-1.5 rounded-md"
                          style={sel ? rowProps(true).style : { background: b.current ? "color-mix(in srgb, var(--primary) 12%, transparent)" : "transparent" }}>
                          <span className="w-3 text-center text-[11px] shrink-0" style={{ color: "var(--primary-hover)" }}>{b.current ? "⎇" : ""}</span>
                          <button disabled={b.current || !writeEnabled || busy} onClick={() => checkout(b.name)} className="text-[12px] font-medium text-left shrink-0 truncate" style={{ maxWidth: 340, color: b.current ? "var(--text)" : "var(--text2)", cursor: b.current ? "default" : "pointer" }} title={b.name}>{b.name}</button>
                          {/* Behind before ahead — "pull this many, push that many". */}
                          {(t.ahead > 0 || t.behind > 0) && (
                            <span className="shrink-0 text-[9.5px] tabular-nums">
                              {t.behind > 0 && <span style={{ color: "var(--warning)" }}>↓{t.behind}</span>}
                              {t.ahead > 0 && <span className="ml-1" style={{ color: "var(--success)" }}>↑{t.ahead}</span>}
                            </span>
                          )}
                          {/* Its remote branch is gone — a merged, tidied-up PR.
                              Safe to delete locally, and the usual reason a branch
                              list grows to 57 entries. */}
                          {t.gone && <span className="shrink-0 text-[9px] px-1 py-px rounded" style={{ color: "var(--error)", background: "color-mix(in srgb, var(--error) 12%, transparent)" }} title={`${b.upstream} no longer exists on the remote — this branch was probably merged`}>gone</span>}
                          {/* In sync, and freshly enough fetched to mean it. */}
                          {b.upstream && !t.gone && !t.ahead && !t.behind && <span className="shrink-0 text-[9.5px]" style={{ color: "var(--success)" }} title={`in sync with ${b.upstream}`}>✓</span>}
                          <span className="min-w-0 flex-1 truncate text-[10px] t-dim2">{b.subject}</span>
                          <span className="shrink-0 text-[9.5px] t-dim2">{b.date}</span>
                          {writeEnabled && !b.current && (
                            <div className="shrink-0 flex items-center gap-1 opacity-0 group-hover:opacity-100">
                              <button onClick={() => mergeBranch(b.name)} className="text-[10px] px-1.5 py-0.5 rounded" style={{ color: "var(--text2)", border: "1px solid color-mix(in srgb, var(--border) 30%, transparent)" }} title={`Merge ${b.name} into current`}>merge</button>
                              <button onClick={() => rebaseBranch(b.name)} className="text-[10px] px-1.5 py-0.5 rounded" style={{ color: "var(--text2)", border: "1px solid color-mix(in srgb, var(--border) 30%, transparent)" }} title={`Rebase current onto ${b.name}`}>rebase</button>
                              <button onClick={() => renameBranch(b.name)} className="text-[10px] px-1.5 py-0.5 rounded" style={{ color: "var(--text2)" }}>rename</button>
                              <button onClick={() => deleteBranch(b)} className="text-[10px] px-1.5 py-0.5 rounded" style={{ color: "var(--error)" }} title="Delete branch">delete</button>
                            </div>
                          )}
                        </div>
                      );
                    })}
                    <MoreRows shown={incBranches.rows.length} total={shownBranches.length} onAll={incBranches.showAll} />
                  </div>
                ) : view === "stashes" ? (
                  <div className="agx-scroll flex-1 min-h-0 overflow-y-auto p-3">
                    {writeEnabled && <button onClick={stashPush} disabled={busy || tree?.clean} className="mb-3 text-[11px] px-3 py-1.5 rounded-lg font-medium" style={{ background: "color-mix(in srgb, var(--primary) 16%, transparent)", border: "1px solid color-mix(in srgb, var(--primary) 35%, transparent)", color: "var(--text)", opacity: tree?.clean ? 0.5 : 1 }}>⇩ stash all changes</button>}
                    {stashes.map((s, i) => (
                      <div key={s.ref} {...rowProps(i === rowIdx)} className="group flex items-center gap-3 px-2.5 py-1.5 rounded-md" onClick={() => setRowIdx(i)}>
                        <span className="shrink-0 text-[10px] tabular-nums t-dim2">{s.ref}</span>
                        <span className="min-w-0 flex-1 truncate text-[11.5px]" style={{ color: "var(--text)" }}>{s.message}</span>
                        {writeEnabled && (
                          <div className="shrink-0 flex items-center gap-1 opacity-0 group-hover:opacity-100">
                            <button onClick={() => stashOp("apply", s.index)} className="text-[10px] px-1.5 py-0.5 rounded" style={{ color: "var(--text2)", border: "1px solid color-mix(in srgb, var(--border) 30%, transparent)" }}>apply</button>
                            <button onClick={() => stashOp("pop", s.index)} className="text-[10px] px-1.5 py-0.5 rounded" style={{ color: "var(--success)", border: "1px solid color-mix(in srgb, var(--success) 30%, transparent)" }}>pop</button>
                            <button onClick={() => stashOp("drop", s.index)} className="text-[10px] px-1.5 py-0.5 rounded" style={{ color: "var(--error)" }}>drop</button>
                          </div>
                        )}
                      </div>
                    ))}
                    {!stashes.length && <PaneEmpty busy={busyView === "stashes"} what="stashes" />}
                  </div>
                ) : view === "remotes" ? (
                  <div className="agx-scroll flex-1 min-h-0 overflow-y-auto p-3">
                    {remotes.map((r, i) => (
                      <div key={r.name} {...rowProps(i === rowIdx)} className="flex items-center gap-3 px-2.5 py-2 rounded-md" onClick={() => setRowIdx(i)}>
                        <span className="shrink-0 text-[12px] font-medium" style={{ color: "var(--text)" }}>{r.name}</span>
                        <span className="shrink-0 text-[9.5px] tabular-nums t-dim2">{r.branches} branch{r.branches === 1 ? "" : "es"}</span>
                        <span className="min-w-0 flex-1 truncate text-[10px] t-dim2" title={r.fetchUrl}>{r.fetchUrl}</span>
                        {/* Only worth showing when they differ — the fork setup,
                            where you fetch from upstream and push to your own. */}
                        {r.pushUrl && r.pushUrl !== r.fetchUrl && <span className="shrink-0 text-[9px] px-1 py-px rounded" style={{ color: "var(--warning)", background: "color-mix(in srgb, var(--warning) 12%, transparent)" }} title={`pushes to ${r.pushUrl}`}>push ≠ fetch</span>}
                      </div>
                    ))}
                    {!remotes.length && <PaneEmpty busy={busyView === "remotes"} what="remotes" />}
                  </div>
                ) : view === "tags" ? (
                  <div onScroll={incTags.onScroll} className="agx-scroll flex-1 min-h-0 overflow-y-auto p-3">
                    {incTags.rows.map((t, i) => (
                      <div key={t.name} {...rowProps(i === rowIdx)} className="flex items-center gap-3 px-2.5 py-1.5 rounded-md" onClick={() => setRowIdx(i)}>
                        <span className="shrink-0 text-[11.5px] font-medium truncate" style={{ maxWidth: 260, color: "var(--text)" }} title={t.name}>{t.annotated ? "🏷" : "⚑"} {t.name}</span>
                        <span className="shrink-0 text-[9.5px] tabular-nums t-dim2">{t.hash}</span>
                        <span className="min-w-0 flex-1 truncate text-[10px] t-dim2">{t.subject}</span>
                        <span className="shrink-0 text-[9.5px] t-dim2">{t.date}</span>
                      </div>
                    ))}
                    {!tags.length && <PaneEmpty busy={busyView === "tags"} what="tags" />}
                    <MoreRows shown={incTags.rows.length} total={tags.length} onAll={incTags.showAll} />
                  </div>
                ) : view === "reflog" ? (
                  <div onScroll={incReflog.onScroll} className="agx-scroll flex-1 min-h-0 overflow-y-auto p-3">
                    {/* Where HEAD has been. This is the trail that makes a bad
                        reset or rebase recoverable, which is why it earns a tab
                        of its own rather than living inside the log. */}
                    {incReflog.rows.map((e, i) => (
                      <div key={e.ref} {...rowProps(i === rowIdx)} className="flex items-center gap-3 px-2.5 py-1 rounded-md" onClick={() => setRowIdx(i)}>
                        <span className="shrink-0 text-[9.5px] tabular-nums t-dim2" style={{ minWidth: 68 }}>{e.ref}</span>
                        <span className="shrink-0 text-[9.5px] tabular-nums" style={{ color: "var(--primary-hover)" }}>{e.shortHash}</span>
                        <span className="shrink-0 text-[9.5px] px-1 py-px rounded" style={{ minWidth: 92, color: "var(--text2)", background: "color-mix(in srgb, var(--bg3) 45%, transparent)" }}>{e.action}</span>
                        <span className="min-w-0 flex-1 truncate text-[11px]" style={{ color: "var(--text)" }}>{e.subject}</span>
                        <span className="shrink-0 text-[9.5px] t-dim2">{e.date}</span>
                      </div>
                    ))}
                    {!reflog.length && <PaneEmpty busy={busyView === "reflog"} what="reflog entries" />}
                    <MoreRows shown={incReflog.rows.length} total={reflog.length} onAll={incReflog.showAll} />
                  </div>
                ) : (
                  <div className="agx-scroll flex-1 min-h-0 overflow-y-auto p-3">
                    {writeEnabled && (
                      <div className="flex items-center gap-2 mb-3 max-w-lg">
                        <input value={newWtBranch} onChange={(e) => setNewWtBranch(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") addWorktree(); }} placeholder="new-branch → new worktree (sibling dir)" className="flex-1 px-2.5 py-1.5 rounded-lg text-[11.5px] outline-none" style={{ background: "color-mix(in srgb, var(--bg3) 40%, transparent)", border: "1px solid color-mix(in srgb, var(--border) 45%, transparent)", color: "var(--text)" }} />
                        <button onClick={addWorktree} disabled={busy || !newWtBranch.trim()} className="text-[11px] px-3 py-1.5 rounded-lg font-medium whitespace-nowrap" style={{ background: "color-mix(in srgb, var(--primary) 18%, transparent)", border: "1px solid color-mix(in srgb, var(--primary) 40%, transparent)", color: "var(--text)", opacity: newWtBranch.trim() ? 1 : 0.5 }}>+ add worktree</button>
                      </div>
                    )}
                    {worktrees.map((w, i) => (
                      <div key={w.path} onClick={() => setRowIdx(i)} {...rowProps(i === rowIdx)}
                        className="group flex items-center gap-2 px-2.5 py-1.5 rounded-md"
                        style={i === rowIdx ? rowProps(true).style : { background: w.current ? "color-mix(in srgb, var(--primary) 12%, transparent)" : "transparent" }}>
                        <span className="w-3 text-center text-[11px] shrink-0" style={{ color: "var(--primary-hover)" }}>{w.current ? "▸" : ""}</span>
                        <button onClick={() => openWorktree(w)} className="text-[12px] font-medium text-left shrink-0" style={{ color: "var(--text)" }} title={`Open ${w.path}`}>{wtName(w.path)}</button>
                        <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded" style={{ color: "var(--primary-hover)", background: "color-mix(in srgb, var(--primary) 10%, transparent)" }}>⎇ {w.branch}</span>
                        <span className="shrink-0 text-[9.5px] tabular-nums t-dim2">{w.head}</span>
                        {w.locked && <span className="shrink-0 text-[9px]" style={{ color: "var(--warning)" }}>locked</span>}
                        <span className="min-w-0 flex-1 truncate text-[9.5px] t-dim2">{w.path}</span>
                        {/* How far this checkout has drifted from what it was
                            branched off, and the one-click way to close the
                            gap. Shown only when there is a gap: a checkout
                            level with its base needs no button, and the trunk
                            has no base at all. */}
                        {!!w.base && (w.behindBase ?? 0) > 0 && (
                          <>
                            <span className="shrink-0 text-[9.5px] tabular-nums" style={{ color: "var(--warning)" }}
                              title={`${w.behindBase} commit${w.behindBase === 1 ? "" : "s"} on ${w.base} that this branch does not have`}>
                              ↓{w.behindBase} behind {w.base}
                            </span>
                            {writeEnabled && (
                              <button
                                onClick={() => act(() => api.gitSyncBase(w.path, w.base ?? undefined), `merged ${w.base}`, "sync")}
                                disabled={busy}
                                className="shrink-0 text-[10px] px-1.5 py-0.5 rounded"
                                style={{ color: "var(--primary-hover)", border: "1px solid color-mix(in srgb, var(--primary) 35%, transparent)", opacity: busy ? 0.5 : 1 }}
                                title={`Merge ${w.base} into ${w.branch}, in that worktree. A merge, not a rebase — nothing already pushed gets rewritten.`}>
                                {pending === "sync" ? "syncing…" : "sync"}
                              </button>
                            )}
                          </>
                        )}
                        {writeEnabled && !w.current && <button onClick={() => removeWorktree(w)} className="shrink-0 text-[10px] opacity-0 group-hover:opacity-100 px-1.5 py-0.5 rounded" style={{ color: "var(--error)" }} title="Remove worktree">remove</button>}
                      </div>
                    ))}
                    {!worktrees.length && <PaneEmpty busy={busyView === "worktrees"} what="worktrees" />}
                  </div>
                )}

                <CommandLog open={logOpen} onClose={() => setLogOpen(false)} />
                <ShortcutBar view={view} logOpen={logOpen} onToggleLog={() => setLogOpen((v) => !v)} editorName={editor?.editor} />
                {helpOpen && <HelpSheet view={view} onClose={() => setHelpOpen(false)} />}
                {toast && <div className="absolute bottom-4 left-1/2 -translate-x-1/2 px-3.5 py-2 rounded-lg text-[11px] shadow-xl" style={{ zIndex: 40, background: "var(--bg3)", border: `1px solid ${toast.ok ? "color-mix(in srgb, var(--success) 50%, transparent)" : "color-mix(in srgb, var(--error) 50%, transparent)"}`, color: toast.ok ? "var(--success)" : "var(--error)" }}>{toast.msg}</div>}
      {/* A commit's diff, reusing the full file-changes viewer. Still a modal:
          it's a drill-down from a row you clicked, not a place you navigate
          to — the rail's views are the destinations, this is a detour. */}
      <ChangesModal open={!!commitView} onClose={() => setCommitView(null)} onBack={() => setCommitView(null)} backLabel="Log" presetChanges={commitView?.changes} presetTitle={commitView?.title} />
    </div>
  );
}
