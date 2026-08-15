// Live Source Control — agentglass's lazygit replacement. Working tree
// (stage/unstage/discard/commit), branches (checkout/create/delete), log
// (browse commits, view a commit's diff), and stash — all with the same diff
// renderer as the telemetry view.
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { diffSplit, diffWrap } from "../lib/diffPrefs.ts";
import { conflictBriefing, CONFLICT_ASK } from "../lib/conflictBrief.ts";
import { ConflictMode } from "./ConflictMode.tsx";
import { ContextMenu, MenuItem } from "./ContextMenu.tsx";
import { RebaseModal } from "./RebaseModal.tsx";
import { CompareModal } from "./CompareModal.tsx";
import { InsightsModal } from "./InsightsModal.tsx";
import { BlameModal } from "./BlameModal.tsx";
import { BisectModal } from "./BisectModal.tsx";
import { requestTermIssue } from "../lib/termIssue.ts";
import { useDismiss } from "../lib/useDismiss.ts";
import { viewHeaderClass, viewHeaderStyle } from "./workspace/ViewHeader.tsx";
import type { GitRepoRef, WorkingTree, GitFileChange, GitBranch, GitBranchInfo, GitStash, GitGraphLine, GitWorktree, WorktreeLeftovers, GitRemote, GitRemoteBranch, GitTag, GitReflogEntry, ConflictBlock, BlockChoice, MergeInfo, FileChange, WalkthroughResult, WalkthroughFile, TidyReport, TidyFinding, GitSubmodule } from "../../../shared/types.ts";
import { partitionByWorktree, splitReadable, goneConfirmTitle, goneConfirmBody, forcedDeletePrompt } from "../lib/goneCleanup.ts";
import { CheckoutPicker } from "./CheckoutPicker.tsx";
import { BasePicker } from "./BasePicker.tsx";
import { ShellConsole } from "./ShellConsole.tsx";
import { RescueModal } from "./RescueModal.tsx";
import { useDialogs } from "./ConfirmDialog.tsx";
import { api } from "../lib/api.ts";
import { subscribeGitChanged } from "../lib/gitBus.ts";
import { seedChat } from "../lib/chatStore.ts";
import { HiliteCtx, useDiffHighlight } from "../lib/diffHighlight.ts";
import { usePoll } from "../lib/usePoll.ts";
import { worktreeTag } from "../lib/worktree.ts";
import { subscribeWorktreeJump, worktreeJump } from "../lib/worktreeJump.ts";
import { checkoutConfirm, needsCheckoutConfirm } from "../lib/checkoutWarning.ts";
import { buildFileTree, visibleRows, allDirPaths } from "../lib/fileTree.ts";
import { useIncremental } from "../lib/useIncremental.ts";
import { CommandLog } from "./CommandLog.tsx";
import { UnifiedDiff, SplitDiff, ThemePicker, Toggle, SCROLLBAR_CSS, ChangesModal, changesetSig, readWalkCache, writeWalkCache } from "./ChangesModal.tsx";
import { useSidebarWidth } from "../lib/sidebarWidth.ts";
import { SidebarGrip } from "./SidebarGrip.tsx";
import { CloseButton } from "./CloseButton.tsx";
import { openPrs, openPr } from "../lib/openPrs.ts";
import { isScratchBranch, scratchNote } from "../lib/scratchBranch.ts";
import { chipTarget } from "../lib/chipTarget.ts";
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
/** One labelled block of the explanation. Small on purpose: three short
 *  answers get read, one paragraph does not. */
function Says({ label, children, tint }: { label: string; children: React.ReactNode; tint?: string }) {
  return (
    <span className="block">
      <span className="block text-[10px] uppercase tracking-wider mb-0.5" style={{ color: "var(--text4)" }}>{label}</span>
      <span className="block text-[10.5px] leading-relaxed" style={{ color: tint ?? "var(--text2)" }}>{children}</span>
    </span>
  );
}

/**
 * What will happen, and why this was picked out — before any shell opens.
 *
 * The tab could already say what a finding was; it could not say what the
 * command would do, or what evidence put the row there, or what happens when
 * it goes wrong. Those are exactly the three things somebody needs in order to
 * agree to a command that changes their repository, and asking them to agree
 * without them is not really asking.
 *
 * The drawing is not decoration. Every situation here is a shape — something
 * still pointing at something that is gone — and a shape is read faster than
 * the sentence describing it.
 */
function TidyExplain({ f, onArm, onCancel }: { f: TidyFinding; onArm: () => void; onCancel: () => void }) {
  return (
    <div className="rounded-lg overflow-hidden" style={{ border: "1px solid color-mix(in srgb, var(--primary) 30%, transparent)", background: "color-mix(in srgb, var(--primary) 5%, transparent)" }}>
      {f.diagram.length > 0 && (
        <pre className="px-3 pt-3 pb-1 text-[10.5px] leading-[1.5] whitespace-pre overflow-x-auto agx-scroll m-0"
          style={{ color: "var(--text3)" }}>{f.diagram.join("\n")}</pre>
      )}
      <div className="px-3 py-2.5 grid gap-2.5" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(230px, 1fr))" }}>
        <Says label="Why this was picked out">{f.why}</Says>
        <Says label="What the command does">{f.effect}</Says>
        {/* Tinted, because the worst case is the one thing here somebody might
            skip — and on most of these rows the worst case is a refusal, which
            is worth knowing before it happens and reads as a failure. */}
        <Says label="What can go wrong" tint="var(--warning)">{f.risk}</Says>
        {/* Named before it runs, not after. These are in the list and out of
            the command, and the difference is worth a sentence. */}
        {f.blocked.length > 0 && (
          <Says label={`Left out of the command (${f.blocked.length})`}>
            {/* One line each, with its own reason: a worktree owning a branch
                and a branch having unmerged commits need different answers. */}
            {f.blocked.map((b) => (
              <span key={b.name} className="block truncate" title={`${b.name} — ${b.why}`}>{b.name} — {b.why}</span>
            ))}
          </Says>
        )}
      </div>
      <div className="px-3 pb-3 flex items-center gap-2 flex-wrap">
        <code className="flex-1 min-w-0 truncate text-[11px] px-2 py-1 rounded" title={f.command ?? ""}
          style={{ color: "var(--text)", background: "color-mix(in srgb, var(--bg3) 50%, transparent)" }}>{f.command}</code>
        <button onClick={onCancel} className="shrink-0 text-[10.5px] px-2 py-1 rounded-lg"
          style={{ color: "var(--text3)", border: "1px solid color-mix(in srgb, var(--border) 40%, transparent)" }}>Cancel</button>
        <button onClick={onArm} className="shrink-0 text-[10.5px] px-2.5 py-1 rounded-lg whitespace-nowrap"
          style={{ color: "var(--text)", background: "color-mix(in srgb, var(--primary) 20%, transparent)", border: "1px solid color-mix(in srgb, var(--primary) 45%, transparent)" }}>
          {"Type it into a shell →"}
        </button>
      </div>
    </div>
  );
}

/**
 * What has piled up in this checkout, and the command that would clear it.
 *
 * Nothing here runs anything. Each finding shows exactly what it found and
 * offers the line as text; pressing `>_` opens a real shell with that line
 * typed at the prompt and stops. The Enter is the user's, on their own
 * repository — which is the whole request this was built for: "tell me how to
 * clean it, and make sure you touch nothing in git."
 */
function TidyView({ report, root, busy }: { report: TidyReport | null; root: string; busy: boolean }) {
  const [open, setOpen] = useState<string | null>(null);
  // Two steps, because they answer different questions: `open` is "explain
  // this to me", `armed` is "now give me the command".
  const [armed, setArmed] = useState<string | null>(null);
  if (busy && !report) return <div className="p-4 text-[11.5px]" style={{ color: "var(--text3)" }}>Looking through the checkout…</div>;
  if (!report) return null;
  if (report.error) return <div className="p-4 text-[11.5px]" style={{ color: "var(--error)" }}>{report.error}</div>;
  if (!report.findings.length) {
    return <div className="p-4 text-[11.5px]" style={{ color: "var(--text3)" }}>Nothing has piled up here — no stale branches, no dangling worktrees, no loose objects worth packing.</div>;
  }
  return (
    <div className="agx-scroll flex-1 min-h-0 overflow-y-auto p-3 flex flex-col gap-2.5">
      {report.findings.map((f) => {
        const total = f.items.length + f.extra;
        return (
          // `shrink-0` and it is load-bearing: this is a flex column, and a
          // flex child is allowed to shrink below its own content. Expanding a
          // card was squashing it instead — the explanation's last sentence
          // and both of its buttons were simply cut off, with no scrollbar and
          // nothing to suggest anything was missing. Measured: 343px of
          // content in a 269px box.
          <div key={f.id} className="rounded-lg overflow-hidden shrink-0" style={{ border: "1px solid color-mix(in srgb, var(--border) 40%, transparent)" }}>
            <div className="flex items-start gap-3 px-3 py-2">
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline gap-2">
                  <span className="text-[12.5px]" style={{ color: "var(--text)" }}>{f.title}</span>
                  <span className="text-[10px] tabular-nums" style={{ color: "var(--text3)" }}>{total}</span>
                </span>
                <span className="block text-[10.5px] mt-0.5" style={{ color: "var(--text2)" }}>{f.what}</span>
              </span>
              {/* Offered only where there is a line safe enough to offer. The
                  stashes finding has none, deliberately, and says why. */}
              {f.command && (
                <button onClick={() => setOpen((v) => (v === f.id ? null : f.id))}
                  className="shrink-0 text-[10.5px] px-2 py-1 rounded-lg whitespace-nowrap"
                  style={open === f.id
                    ? { color: "var(--text)", background: "color-mix(in srgb, var(--primary) 18%, transparent)", border: "1px solid color-mix(in srgb, var(--primary) 40%, transparent)" }
                    : { color: "var(--primary-hover)", border: "1px solid color-mix(in srgb, var(--primary) 34%, transparent)" }}
                  title="Open a shell here with the command typed in — you press Enter">
                  {">_ Clean up"}
                </button>
              )}
            </div>
            {/* The names, because a count is not something anybody can agree to.
                Deleting nine branches is a decision about nine branches. */}
            <div className="px-3 pb-2 flex flex-wrap gap-1">
              {f.items.map((i) => {
                // Held back rather than hidden: it is in the list because it
                // IS one of these, and it is dimmed because the command will
                // not touch it. Learning that from stderr, in red, after
                // pressing Enter, is how this was found.
                const held = f.blocked.find((b) => b.name === i);
                return (
                  <span key={i} className="text-[10px] px-1.5 py-0.5 rounded truncate max-w-[280px]"
                    title={held ? `${i} — ${held.why}` : i}
                    style={held
                      ? { color: "var(--text4)", background: "transparent", border: "1px dashed color-mix(in srgb, var(--text3) 35%, transparent)" }
                      : { color: "var(--text2)", background: "color-mix(in srgb, var(--text) 6%, transparent)" }}>
                    {/* The marker leads, because the name is what gets
                        truncated: these run to ninety characters and a
                        trailing "· held" is the first thing to disappear —
                        which made six held branches look like one. */}
                    {held ? `⊘ ${i}` : i}
                  </span>
                );
              })}
              {f.extra > 0 && <span className="text-[10px] px-1.5 py-0.5" style={{ color: "var(--text3)" }}>+{f.extra} more</span>}
            </div>
            {f.note && (
              <div className="px-3 pb-2 text-[10px]" style={{ color: f.command ? "var(--text3)" : "var(--warning)" }}>{f.note}</div>
            )}
            {open === f.id && f.command && (
              <div className="px-3 pb-3">
                {/* Read before run. The button used to go straight to a shell
                    with a branch-deleting command already typed, which asked
                    somebody to consent to something the row had not explained:
                    not what the command does, and not what put the row there
                    in the first place. */}
                {armed === f.id
                  ? <ShellConsole command={f.command} cwd={root} onClose={() => { setArmed(null); setOpen(null); }} />
                  : <TidyExplain f={f} onArm={() => setArmed(f.id)} onCancel={() => setOpen(null)} />}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

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
function ListToolbar({ q, onQ, placeholder, sort, onSort, sorts, count, total, children }: {
  q: string; onQ: (v: string) => void; placeholder: string;
  sort?: SortKey; onSort?: (s: SortKey) => void; sorts?: { key: SortKey; label: string; title: string }[];
  count: number; total: number; children?: ReactNode;
}) {
  return (
    <div className="flex items-center gap-2 mb-2 flex-wrap">
      <input
        value={q}
        onChange={(e) => onQ(e.target.value)}
        placeholder={placeholder}
        className="px-2.5 py-1.5 rounded-lg text-[11.5px] outline-none min-w-0 flex-1 max-w-md"
        style={{ background: "color-mix(in srgb, var(--bg3) 40%, transparent)", border: "1px solid color-mix(in srgb, var(--border) 45%, transparent)", color: "var(--text)" }}
      />
      {sorts && sort && onSort && (
        <div className="flex items-center gap-1 shrink-0">
          {sorts.map((s) => (
            <button key={s.key} onClick={() => onSort(s.key)} title={s.title}
              className="text-[10px] px-2 py-1 rounded-lg transition-colors whitespace-nowrap"
              style={sort === s.key
                ? { background: "color-mix(in srgb, var(--primary) 18%, transparent)", border: "1px solid color-mix(in srgb, var(--primary) 40%, transparent)", color: "var(--text)" }
                : { background: "transparent", border: "1px solid color-mix(in srgb, var(--border) 22%, transparent)", color: "var(--text3)" }}>
              {s.label}
            </button>
          ))}
        </div>
      )}
      {children}
      {/* Says what the filter did. A list that silently shrinks reads as data
          that went missing. */}
      {q.trim() !== "" && (
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
      <span className="w-2.5 text-[10px] shrink-0 t-dim2">{collapsed ? "▶" : "▼"}</span>
      <span className="text-[11px] truncate" style={{ color: "var(--text2)" }}>{name}</span>
      {/* Only meaningful while folded — otherwise you can just count the rows. */}
      {collapsed && <span className="text-[10px] tabular-nums t-dim2">{count}</span>}
    </div>
  );
}

function FileRow({ c, root, active, writeEnabled, desc, onSelect, action, onAction, onDiscard, onBlame, depth }: {
  c: GitFileChange; root: string; active: boolean; writeEnabled: boolean; desc?: string; onSelect: () => void;
  action: "stage" | "unstage"; onAction: () => void; onDiscard?: () => void;
  /** Right-click a row for its file's blame — who wrote each line. */
  onBlame?: () => void;
  /** Set in tree mode; the directory rows above carry the path, so the row
   *  indents instead of repeating it. Undefined means the old flat list. */
  depth?: number;
}) {
  const dir = dirName(c.file_path, root);
  return (
    <div onClick={onSelect} data-file={active ? "active" : undefined} onContextMenu={onBlame ? (e) => { e.preventDefault(); onBlame(); } : undefined}
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
  if (error) return <div className="text-[10.5px] px-2 py-1.5 rounded" style={{ color: "var(--warning)", background: "color-mix(in srgb, var(--warning) 10%, transparent)" }}>{error}</div>;
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
    <div className="flex flex-col gap-2 pl-2 pb-1" style={{ borderLeft: "1px solid color-mix(in srgb, var(--border) 35%, transparent)" }}>
      {blocks.map((b) => {
        const chosen = picks[b.index];
        const Opt = ({ id, label }: { id: BlockChoice; label: string }) => (
          <button onClick={() => onPick(b.index, id)} disabled={busy}
            className="px-1.5 py-0.5 rounded text-[9.5px] shrink-0"
            style={chosen === id
              ? { color: "var(--primary-hover)", background: "color-mix(in srgb, var(--primary) 16%, transparent)", border: "1px solid color-mix(in srgb, var(--primary) 45%, transparent)" }
              : { color: "var(--text3)", border: "1px solid color-mix(in srgb, var(--border) 35%, transparent)" }}>
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
          style={{ color: "var(--success)", border: "1px solid color-mix(in srgb, var(--success) 40%, transparent)", opacity: left ? 0.4 : 1 }}
          title={left ? "Choose a side for every conflict first" : "Write these choices and stage the file"}>
          Apply and stage
        </button>
      </div>
    </div>
  );
}

export function GitView({ active, onOpenChat }: { active: boolean; onOpenChat?: () => void }) {
  const open = active;
  const sidebarW = useSidebarWidth();
  const [repos, setRepos] = useState<GitRepoRef[]>([]);
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
    }
  }, [wtJump]);
  const [tree, setTree] = useState<WorkingTree | null>(null);
  // Which root the tree on screen belongs to. When it isn't the current root,
  // the header (branch, sync-behind count, push/pull state) is still showing the
  // worktree you just switched away from — so the group can say it is recomputing
  // instead of presenting the old numbers as if they were the new ones.
  const [treeFor, setTreeFor] = useState("");
  const [view, setView] = useState<View>("changes");
  const [selKey, setSelKey] = useState<string | null>(null);
  const [split, setSplit] = useState(diffSplit);
  const [wrap, setWrap] = useState(diffWrap);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<{ ok: boolean; msg: string } | null>(null);
  // The panel's own confirm/prompt. window.confirm renders in OS chrome, reads
  // as somebody else's dialog next to our modals, and blocks the JS thread so
  // nothing can show progress while it is up.
  const { ask, askText, dialog } = useDialogs();
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
  const [commitMenu, setCommitMenu] = useState<{ hash: string; subject: string; x: number; y: number } | null>(null);
  /** The base of the interactive rebase in flight, or null when closed. */
  const [rebaseBase, setRebaseBase] = useState<string | null>(null);
  /** The branch a compare dialog is open on, or null when closed. */
  const [compareTarget, setCompareTarget] = useState<string | null>(null);
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
  const [submodules, setSubmodules] = useState<GitSubmodule[]>([]);
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
  /*
   * The tree that is on screen belongs to a root, and until this read said so
   * it was trusted for whichever root you had just switched to.
   *
   * `loadTree` is async and records the root it answered for in `treeFor`. The
   * conflict screen keys off this value, so between switching worktree and the
   * new tree arriving, a conflict belonging to the checkout you LEFT was drawn
   * over the one you opened — reported as the resolver appearing "para todos
   * los wt/branches", with the file list beside it reading "nothing to commit,
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
    if (!open || !root || treeFor !== root || mergeState === "clean") { setConflicts([]); setMerge(null); return; }
    api.gitConflicts(root).then((r) => setConflicts(r.files ?? [])).catch(() => {});
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
    return [
      ...conflictBriefing(root, tree?.branch, repos.find((r) => r.root === root), mergeState, rels, merge),
      ...CONFLICT_ASK,
    ].join("\n");
  };

  /**
   * The same conflict, in a terminal instead of the chat.
   *
   * Two places the same work can happen, and it is not a setting: the chat
   * renders from the transcript and keeps the pane out of sight; a tmux window
   * gives you the session itself, attached, beside your other shells — where
   * you can watch it edit and take the keyboard off it. Which you want depends
   * on whether you intend to watch or to join in, which is the same choice the
   * pull request panel already offers for a review.
   */
  const askClaudeInTerminal = () => {
    requestTermIssue(root, "conflicts", conflictPrompt(), true);
    // It opens a tmux window somewhere you are not looking, and until this said
    // so the button read as broken: it worked perfectly, silently, and people
    // pressed it again.
    flash(true, `Claude is on it in a tmux window — "conflicts", in ${repoRef?.name ?? "this repo"}`);
  };

  /**
   * The same handoff, in the chat pane instead.
   *
   * Deliberately the lesser of the two: the terminal gives you the session
   * itself, attached, where you can watch it edit and take the keyboard off it.
   *
   * Goes through seedChat() rather than assembling the tab here. This function
   * used to do it by hand and left out the one call that matters — the chat
   * panel keeps its own selection in component state and reads the stored id
   * only at mount — so the prompt landed in a tab nobody was looking at and the
   * chat opened blank. It looked exactly like the button doing nothing.
   */
  const askClaude = () => {
    seedChat(root, conflictPrompt(), "Resolve merge conflicts");
    onOpenChat?.();
  };
  // Only the branches whose upstream is gone — the merged-and-tidied ones. Off
  // by default: it's a cleanup mode, not a way to read the branch list.
  const [onlyGone, setOnlyGone] = useState(false);
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
  const [newWtBranch, setNewWtBranch] = useState("");
  const [commitView, setCommitView] = useState<{ changes: FileChange[]; title: string } | null>(null);
  const [blamePath, setBlamePath] = useState<{ path: string } | null>(null);
  const [walk, setWalk] = useState<WalkthroughResult | null>(null);
  const [walkLoading, setWalkLoading] = useState(false);
  const walkReqSig = useRef<string | null>(null);
  const treeSeq = useRef(0); // guards stale working-tree responses (repo switches)
  const viewSeq = useRef(0); // same, for the non-Changes list views (repo/remote/view switches)
  const frameRef = useRef<HTMLDivElement>(null);
  const firstOpen = useRef(true); // reset the pane to Changes once, not on every re-activation

  const all = useMemo(() => [...(tree?.staged ?? []), ...(tree?.unstaged ?? [])], [tree]);
  const selected = useMemo(() => all.find((c) => keyOf(c) === selKey) ?? all[0] ?? null, [all, selKey]);

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
  const editFile = async (c: GitFileChange | null, hunkIdx = 0) => {
    if (!c) return;
    const line = c.hunks[hunkIdx]?.newStart ?? c.hunks[0]?.newStart ?? 1;
    try {
      const r = await api.editorOpen(c.file_path, line);
      if (!r.ok) return flash(false, r.error || "Could not open the editor");
      if (r.how === "remote") {
        // It landed in a window that may be behind this one, so say so —
        // otherwise pressing `e` looks like it did nothing at all. And when it
        // went to a sibling checkout of the same project rather than this one,
        // name it: the file opens in the nvim you have, which is the point, but
        // you should not have to work out which window it appeared in.
        flash(true, r.viaFamily
          ? `Sent to your nvim in ${r.viaFamily.split("/").pop()} · ${baseName(c.file_path)}:${line}`
          : `Sent to your open nvim · ${baseName(c.file_path)}:${line}`);
      } else if (r.command) {
        // Nothing reachable for *this* file. Saying "no nvim running" when one
        // is open two panes away sends you looking for a bug; naming the repo
        // it's in explains the refusal in one line.
        // Three different situations, three different things to do about them.
        const elsewhere = r.otherCwds?.length
          ? `nvim is open in ${r.otherCwds.map((p) => p.split("/").pop()).join(", ")}, not this repo — copied: ${r.command}`
          : r.stuck
          ? `An nvim is running but not answering (${r.stuck} stale socket${r.stuck === 1 ? "" : "s"}) — copied: ${r.command}`
          : `No nvim running — copied: ${r.command}`;
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
    try { const t = await api.gitTree(r); if (seq !== treeSeq.current) return; setTree(t); setTreeFor(r); if (t.error) flash(false, t.error); }
    catch (e) { if (seq === treeSeq.current) flash(false, String(e)); }
  }, []);
  const rel = (c: GitFileChange) => (c.file_path.startsWith(root + "/") ? c.file_path.slice(root.length + 1) : c.file_path);

  useEffect(() => {
    if (!open) return;
    // Reset the transient composer state only on the FIRST open. This used to run
    // on every activation, so stepping away to the terminal and back threw you
    // from Remotes (or a filtered, scrolled Branches list) straight to Changes,
    // losing the view, the filter and the row you were on — the whole pane read
    // as reset. The view stays mounted the entire time; only its visibility
    // changes, so there is nothing to rebuild, just data to refresh.
    if (firstOpen.current) {
      firstOpen.current = false;
      setToast(null); setTitle(""); setBody(""); setView("changes"); setNewBranch("");
    }
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
    if (view === "branches") {
      track(api.gitBranches(root), setBranchData);
      // Worktrees too, so a branch already checked out in one is marked and its
      // switch OPENS that worktree instead of a `git checkout` that git refuses.
      api.gitWorktrees(root).then((r) => { if (seq === viewSeq.current) setWorktrees(r.worktrees); }).catch(() => {});
    }
    else if (view === "log") track(api.gitGraph(root, 500, logScope), (r) => { setGraph(r.lines); setGraphBranch(r.branch); });
    else if (view === "stashes") {
      track(api.gitStashes(root), (r) => setStashes(r.stashes));
      track(api.gitSnapshots(root), (r) => setSnapshots(r.snapshots ?? []));
    }
    else if (view === "worktrees") track(api.gitWorktrees(root), (r) => setWorktrees(r.worktrees));
    else if (view === "tidy") track(api.gitTidy(root), setTidy);
    else if (view === "remotes") {
      // Two answers, because the pane asks two questions: which remotes there
      // are (the picker) and what is on the selected one (the list). Asked
      // together rather than chained, so the list doesn't wait on the picker.
      api.gitRemotes(root).then((r) => { if (seq === viewSeq.current) setRemotes(r.remotes); }).catch(() => {});
      track(api.gitRemoteBranches(root, remoteSel), (r) => {
        setRemoteRows(r.branches);
        // Which remote the server actually read — how the picker gets its
        // initial selection without this side guessing "origin".
        if (r.remote) setRemoteSel(r.remote);
      });
    }
    else if (view === "tags") track(api.gitTags(root), (r) => setTags(r.tags));
    else if (view === "reflog") track(api.gitReflog(root), (r) => setReflog(r.entries));
    else if (view === "submodules") track(api.gitSubmodules(root), (r) => setSubmodules(r.submodules));
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
  const discard = async (c: GitFileChange) => {
    if (await ask({ title: `Discard changes to ${baseName(c.file_path)}?`, body: "This cannot be undone.", danger: true, confirmLabel: "Discard" })) act(() => api.gitDiscard(root, [rel(c)]), "Discarded");
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
    if (busy || !(await ask({ title: `Delete branch ${b.name}?`, danger: true }))) return;
    setBusy(true);
    setPending(`Delete ${b.name}`);
    try {
      let r = await api.gitBranchDelete(root, b.name, false);
      const wt = r.ok ? null : /worktree at '([^']+)'/.exec(r.error || "")?.[1];
      if (wt) {
        if (!(await ask({ title: `${b.name} is checked out in a worktree`, body: `It lives in ${wtName(wt)}. Remove that worktree and delete the branch?`, danger: true, confirmLabel: "Remove & delete" }))) { flash(false, "Kept"); return; }
        let rm = await api.gitWorktreeRemove(root, wt, false);
        // git refuses to drop a worktree holding work — modified tracked files
        // or, as often, a stray untracked scratch file. Name the cost, then let
        // them take it.
        if (!rm.ok && /modified|untracked|not clean/i.test(rm.error || "")) {
          if (!(await ask({ title: `${wtName(wt)} still has uncommitted or untracked files`, body: "Remove it anyway? That work is gone.", danger: true, confirmLabel: "Remove anyway" }))) { flash(false, rm.error || "Kept"); return; }
          rm = await api.gitWorktreeRemove(root, wt, true);
        }
        if (!rm.ok) { flash(false, rm.error || "Worktree remove failed"); return; }
        reloadWorktrees();
        r = await api.gitBranchDelete(root, b.name, false);
      }
      if (!r.ok && /not fully merged/i.test(r.error || "")) {
        const q = forcedDeletePrompt(b.name, b.mergedIntoTrunk === true, branchData.trunk ?? "the trunk");
        if (await ask({ title: q.title, body: q.body, danger: true, confirmLabel: q.confirmLabel })) {
          r = await api.gitBranchDelete(root, b.name, true);
        }
      }
      flash(r.ok, r.ok ? `Deleted ${b.name}` : r.error || "Failed");
      if (r.ok) reloadBranches();
    } catch (e) { flash(false, String(e)); }
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
      if (!r.ok || !r.url) { flash(false, r.error || "Could not work out where that branch lives"); return; }
      window.open(r.url, "_blank", "noopener,noreferrer");
    } catch (e) { flash(false, String(e)); }
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
    const base = onlyGone ? goneBranches : branchData.branches;
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
  }, [onlyGone, goneBranches, branchData.branches, q, sort]);
  const branchTotal = onlyGone ? goneBranches.length : branchData.branches.length;

  /** The same search, over the lists that are not branches. Each one over the
   *  fields you would actually remember: a stash by what it says, a tag by its
   *  name or its commit, a worktree by its branch or its directory. */
  const hit = useCallback((...fields: (string | undefined | null)[]) => {
    const needle = q.trim().toLowerCase();
    return !needle || fields.filter(Boolean).join(" ").toLowerCase().includes(needle);
  }, [q]);
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
   * that branch. Reported from a screenshot of exactly that, two minutes after
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
  const goneUnmerged = goneBranches.filter((b) => !b.mergedIntoTrunk);

  /**
   * Branch name → the worktree holding it, excluding this checkout. `git branch
   * -D` refuses outright on these, which is what made a bulk run report
   * "deleted 0, 3 failed" with no hint that a worktree was the reason.
   *
   * Fetched here rather than read off the `worktrees` state, and that is not
   * belt-and-braces: that state is only ever filled by the Worktrees tab
   * (`view === "worktrees"`), so from the Branches tab it is an empty array and
   * this map would find nothing — the partition below would send every branch
   * down the "delete it directly" path and reproduce the exact failure this is
   * fixing. Fresh is also the only correct answer for a destructive action:
   * another agent adds or removes worktrees in this repo while the panel sits
   * open.
   */
  const heldByWorktreeNow = async (): Promise<Map<string, string>> => {
    const { worktrees: live } = await api.gitWorktrees(root);
    return new Map(live.filter((w) => !w.current && w.branch && w.branch !== "(detached)").map((w) => [w.branch, w.path] as const));
  };

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
   *
   * The branches still held by a worktree are a second, separate question, and
   * it gets its own confirmation *with the file list in it*. Not politeness:
   * `git worktree remove` deletes gitignored files without `--force` and
   * without a word, so a checkout that reports itself clean can still be
   * holding every `compose/envs/*.env` and a page of local notes. `-D` on the
   * branch is reversible for thirty days through the reflog; `rm -rf` on an
   * ignored file is not reversible at all. So nothing is removed until the
   * files that would go have been named on screen.
   */
  const deleteGone = async () => {
    if (!goneMerged.length || busy) return;
    const trunk = branchData.trunk ?? "the trunk";
    // Busy BEFORE the first await, not after the confirmation. `git worktree
    // list` costs a status per checkout — on a repo with eighteen of them the
    // press was followed by seconds of a button that looked untouched, and the
    // first thing to appear was a dialog. A control that has been pressed has
    // to say so on the same frame.
    setBusy(true);
    setPending("Checking worktrees");
    let heldByWorktree: Map<string, string>;
    // Without the map every branch looks free to delete, which is the wrong
    // half of the fork to guess at — so a failure here stops the whole thing.
    try { heldByWorktree = await heldByWorktreeNow(); }
    catch (e) { flash(false, `Couldn't list this repo's worktrees: ${String(e)}`); setBusy(false); setPending(null); return; }
    const { free, held } = partitionByWorktree(goneMerged, heldByWorktree);
    setPending(null);
    setBusy(false); // the question is theirs to answer; nothing is running
    if (!(await ask({ title: goneConfirmTitle(free, held, trunk), body: goneConfirmBody(free, held, goneUnmerged.length, trunk), confirmLabel: "Continue" }))) return;
    setBusy(true);
    const failed: string[] = [];
    let done = 0;
    try {
      for (const b of free) {
        setPending(`Deleting ${b.name}`);
        const r = await api.gitBranchDelete(root, b.name, true).catch(() => ({ ok: false, error: "" }));
        if (r.ok) done++; else failed.push(`${b.name}${r.error ? ` (${r.error})` : ""}`);
      }
      if (held.length) done += await deleteHeldByWorktrees(held, heldByWorktree, failed);
      flash(failed.length === 0,
        failed.length === 0
          ? `Deleted ${done} merged branch${done === 1 ? "" : "es"}`
          : `Deleted ${done}, ${failed.length} kept: ${failed.slice(0, 2).join("; ")}${failed.length > 2 ? "…" : ""}`);
    } finally {
      setBusy(false);
      setPending(null);
      reloadBranches();
      reloadWorktrees();
    }
  };

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
  const deleteHeldByWorktrees = async (held: GitBranch[], heldByWorktree: Map<string, string>, failed: string[]): Promise<number> => {
    const paths = held.map((b) => heldByWorktree.get(b.name)!);
    let reports: WorktreeLeftovers[];
    try { reports = (await api.gitWorktreeLeftovers(root, paths)).leftovers; }
    catch (e) { for (const b of held) failed.push(`${b.name} (couldn't inspect its worktree: ${String(e)})`); return 0; }

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
        if (!fix.ok) { flash(false, `${wtName(r.path)}: ${fix.error || "chown failed"}`); continue; }
        r.blocked = undefined; // re-read below now that it can succeed
      }
      // Re-split against the repaired reports rather than trusting the old
      // verdict: the whole point is that some of them are removable now.
      ({ removable, refused } = splitReadable(held, heldByWorktree, reports));
    }

    for (const { branch, why } of refused) failed.push(`${branch.name} (${why})`);
    if (!removable.length) return 0;

    // The modal replaces what used to be a confirm() listing the same files.
    // Reading a list you then have to copy by hand is a step people skip at the
    // exact moment they shouldn't, so the list is now the thing you act on.
    const picked = await new Promise<Map<string, string[]> | null>((resolve) => {
      setRescue({ reports: removable.map(({ report }) => report), resolve });
    });
    if (!picked) { setRescue(null); return 0; } // cancelled — nothing removed, nothing copied
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

    let done = 0;
    // `report.path` rather than another lookup: it is the path the server just
    // confirmed it inspected, so the thing removed is the thing priced.
    for (const { branch, report } of removable) {
      if (keptBack.has(report.path)) continue; // its rescue failed; already reported
      step(`Removing ${wtName(report.path)}`);
      const rm = await api.gitWorktreeRemove(root, report.path, true).catch((e) => ({ ok: false, error: String(e) }));
      if (!rm.ok) { failed.push(`${branch.name} (${rm.error || "worktree remove failed"})`); continue; }
      const r = await api.gitBranchDelete(root, branch.name, true).catch((e) => ({ ok: false, error: String(e) }));
      if (r.ok) done++; else failed.push(`${branch.name} (${r.error || "branch delete failed"})`);
    }
    setRescue(null);
    return done;
  };
  const mergeBranch = async (name: string) => { if (await ask({ title: `Merge ${name} into the current branch?`, confirmLabel: "Merge" })) act(() => api.gitMerge(root, name), `Merged ${name}`).then((ok) => { if (ok) reloadBranches(); }); };
  const rebaseBranch = async (name: string) => { if (await ask({ title: `Rebase the current branch onto ${name}?`, confirmLabel: "Rebase" })) act(() => api.gitRebase(root, name), `Rebased onto ${name}`).then((ok) => { if (ok) reloadBranches(); }); };
  const renameBranch = async (name: string) => {
    const to = await askText({ title: `Rename ${name}`, input: { label: "New name", initial: name }, confirmLabel: "Rename" });
    if (to && to !== name) act(() => api.gitBranchRename(root, name, to), `Renamed → ${to}`).then((ok) => { if (ok) reloadBranches(); });
  };
  // log
  const openCommit = async (hash: string, subject: string) => {
    try { const { changes } = await api.gitCommitDiff(root, hash); setCommitView({ changes, title: `${hash} · ${subject}` }); }
    catch (e) { flash(false, String(e)); }
  };
  const resetTo = async (hash: string, mode: "soft" | "mixed" | "hard") => {
    if (mode === "hard" && !(await ask({ title: `Hard reset to ${hash}?`, body: "This DISCARDS working-tree changes.", danger: true, confirmLabel: "Reset --hard" }))) return;
    act(() => api.gitReset(root, hash, mode), `reset --${mode} ${hash}`).then((ok) => { if (ok) api.gitGraph(root, 500, logScope).then((r) => setGraph(r.lines)); });
  };
  /**
   * The log's picks, ordered oldest-first as the server replays them.
   *
   * The log lists newest at the top, so the pick order (click / `c` order) is
   * display order; the sequencer applies oldest first, which is the reverse.
   */
  const pickedHashes = () => [...pickSet].reverse();
  const reloadGraph = () => api.gitGraph(root, 500, logScope).then((r) => { setGraph(r.lines); setGraphBranch(r.branch); }).catch(() => {});
  /**
   * Cherry-pick the picked commits as ONE sequencer run.
   *
   * One run is the point: a conflict pauses the series at the commit that
   * fought, and continuing replays the rest — where per-commit cherry-picks
   * would stop each at the same conflict forever. Oldest first, so a series
   * "replays in order", which is how people read the list.
   */
  const runCherryPick = async (noCommit = false) => {
    const hashes = pickedHashes();
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
    setCommitMenu(null);
    await runCherryPick(noCommit);
  };
  /**
   * Revert one commit from the row menu: a new commit undoing it. A conflict
   * pauses as `reverting`, which the existing conflict screen already handles
   * (its continue/abort branch on that state).
   */
  const revertOne = async (hash: string) => {
    setCommitMenu(null);
    if (await act(() => api.gitRevert(root, hash), "reverted", "revert")) reloadGraph();
  };
  /** Fold the picked commits into one, tree preserved. Oldest..newest must run
   *  to the tip — the server verifies; the panel just sends the span. */
  const squashPicked = async () => {
    const hashes = pickedHashes();
    if (hashes.length < 2) { flash(false, "Pick two or more consecutive commits ending at the tip to squash"); return; }
    const ok = await act(() => api.gitSquash(root, hashes[0], hashes[hashes.length - 1]),
      `squashed ${hashes.length} commits`, "squash");
    if (ok) { setPickSet(new Set()); reloadGraph(); }
  };
  // base branch
  /** Fetched when a picker opens, not on mount. Depending on the Branches tab
   *  having been visited made the picker useless exactly when you reach for it
   *  — the first time. */
  const loadBaseRefs = () => {
    if (!baseRefs.length) api.gitBaseCandidates(root).then((r) => setBaseRefs(r.refs ?? [])).catch(() => {});
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
    if (busy || !(await ask({ title: `Remove worktree ${wtName(w.path)}?`, danger: true, confirmLabel: "Remove" }))) return;
    setBusy(true);
    setPending(`Remove ${wtName(w.path)}`);
    try {
      let r = await api.gitWorktreeRemove(root, w.path, false);
      if (!r.ok && /modified|untracked|not clean/i.test(r.error || "")) {
        if (!(await ask({ title: `${wtName(w.path)} still has uncommitted or untracked files`, body: "Remove it anyway? That work is gone.", danger: true, confirmLabel: "Remove anyway" }))) { flash(false, r.error || "Kept"); return; }
        r = await api.gitWorktreeRemove(root, w.path, true);
      }
      flash(r.ok, r.ok ? "Removed worktree" : r.error || "Failed");
      if (r.ok) { reloadWorktrees(); reloadBranches(); }
    } catch (e) { flash(false, String(e)); }
    finally { setBusy(false); setPending(null); }
  };
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
  // The lazygit move: a branch already checked out in a worktree can't be
  // `git checkout`ed here (git refuses a branch that is out elsewhere), so
  // switching to it OPENS that worktree; otherwise it is a plain checkout.
  const switchTo = (b: GitBranch) => { const wt = wtByBranch.get(b.name); if (wt && wt.path !== root) openWorktree(wt); else checkout(b.name); };
  // stashes
  const reloadStashes = () => api.gitStashes(root).then((r) => setStashes(r.stashes)).catch(() => {});
  const stashPush = async () => { if (await act(() => api.gitStashPush(root, ""), "Stashed")) reloadStashes(); };
  const stashOp = async (op: "apply" | "pop" | "drop", index: number) => {
    if (op === "drop" && !(await ask({ title: "Drop this stash?", body: "The stashed changes are gone.", danger: true, confirmLabel: "Drop" }))) return;
    const fn = op === "apply" ? api.gitStashApply : op === "pop" ? api.gitStashPop : api.gitStashDrop;
    if (await act(() => fn(root, index), op + "ed")) reloadStashes();
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
    act(() => api.gitStashApplyOverwrite(root, index), "Applied over").then((ok) => { if (ok) reloadStashes(); });
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
    if (!url || !url.trim()) return;
    const path = await askText({ title: "Where should it live?", input: { label: "Submodule path (e.g. vendor/lib)", initial: url.trim().split("/").pop()?.replace(/\.git$/, "") || "" }, confirmLabel: "Add" });
    if (!path || !path.trim()) return;
    if (await act(() => api.gitSubmoduleAdd(root, url.trim(), path.trim()), `Added ${path.trim()}`)) reloadSubmodules();
  };
  const submoduleOp = async (op: "update" | "sync", path: string, okMsg: string) => {
    const fn = op === "update" ? api.gitSubmoduleUpdate : api.gitSubmoduleSync;
    if (await act(() => fn(root, path), okMsg)) reloadSubmodules();
  };
  const submoduleDeinitAsk = async (path: string) => {
    if (!(await ask({ title: `Deinit ${path}?`, body: "The checkout is removed; the gitlink and .gitmodules entry stay. Re-run update to bring it back.", confirmLabel: "Deinit" }))) return;
    if (await act(() => api.gitSubmoduleDeinit(root, path), `Deinitialized ${path}`)) reloadSubmodules();
  };
  const submoduleRemoveAsk = async (path: string) => {
    if (!(await ask({ title: `Remove ${path}?`, body: "The gitlink, its checkout and its .gitmodules section are all deleted.", danger: true, confirmLabel: "Remove" }))) return;
    if (await act(() => api.gitSubmoduleRemove(root, path), `Removed ${path}`)) reloadSubmodules();
  };
  // tags
  const reloadTags = () => api.gitTags(root).then((r) => setTags(r.tags)).catch(() => {});
  const createTagAsk = async () => {
    const name = await askText({ title: "New tag", input: { label: "Tag name (e.g. v1.2.3)", initial: "" }, confirmLabel: "Create" });
    if (!name || !name.trim()) return;
    const message = await askText({ title: `Tag ${name.trim()}`, input: { label: "Message — blank for a lightweight tag", initial: "" }, confirmLabel: "Create" });
    if (message === null) return;
    const annotated = message.trim().length > 0;
    if (await act(() => api.gitTagCreate(root, name.trim(), { annotated, message }), `Tagged ${name.trim()}`)) reloadTags();
  };
  const tagDeleteAsk = async (name: string) => {
    if (!(await ask({ title: `Delete tag ${name}?`, body: "Removes the local ref only — the remote copy (if any) is untouched.", danger: true, confirmLabel: "Delete" }))) return;
    if (await act(() => api.gitTagDelete(root, name), `Deleted ${name}`)) reloadTags();
  };
  const tagPush = async (name: string) => {
    if (await act(() => api.gitTagPush(root, name), `Pushed ${name}`)) reloadTags();
  };
  const tagDeleteRemoteAsk = async (name: string) => {
    if (!(await ask({ title: `Delete ${name} on the remote?`, body: "Runs push <remote> :refs/tags/<name>. The local tag stays.", danger: true, confirmLabel: "Delete remotely" }))) return;
    if (await act(() => api.gitTagDeleteRemote(root, name), `Deleted ${name} remotely`)) reloadTags();
  };
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
          const l = graph[rowIdx];
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
    else if (k === "e" && selected && editor?.editor) { e.preventDefault(); void editFile(selected); }
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
    if (action === "discard" && !(await ask({ title: "Discard this hunk?", body: "This cannot be undone.", danger: true, confirmLabel: "Discard" }))) return;
    act(() => api.gitApplyHunk(root, selected.file_path, selected.staged, action, selected.hunks[i]), `${action}d hunk`);
  };
  const hunkBtn = (label: string, tint: string, onClick: () => void) => (
    <button onClick={onClick} className="text-[10px] px-1.5 py-0.5 rounded" style={{ fontFamily: "system-ui, sans-serif", color: tint, background: "color-mix(in srgb, var(--bg3) 70%, transparent)", border: "1px solid color-mix(in srgb, var(--border) 30%, transparent)" }}>{label}</button>
  );
  const hunkActionFn = (writeEnabled && selected && selected.status === "modified" && !selected.binary)
    ? (i: number) => (
        <span className="inline-flex items-center gap-1">
          {selected.staged
            ? hunkBtn("－ Unstage hunk", "var(--text)", () => applyHunk("unstage", i))
            : <>{hunkBtn("＋ Stage hunk", "var(--text)", () => applyHunk("stage", i))}{hunkBtn("↺ Discard", "var(--error)", () => applyHunk("discard", i))}</>}
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
  const renderFiles = (changes: GitFileChange[], action: "stage" | "unstage", onAction: (c: GitFileChange) => void, prefix: string) => {
    const row = (c: GitFileChange, depth?: number) => (
      <FileRow key={prefix + c.file_path} c={c} root={root} writeEnabled={writeEnabled} depth={depth}
        desc={descMap.get(c.file_path)?.description} active={selKey === keyOf(c)}
        onSelect={() => setSelKey(keyOf(c))} action={action} onAction={() => onAction(c)}
        onBlame={writeEnabled ? () => setBlamePath({ path: c.file_path }) : undefined}
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
  // The search and the sort are part of the identity: without them the
  // incremental window keeps the first N rows of the PREVIOUS list, so
  // typing filters a page you are no longer looking at.
  const incBranches = useIncremental(shownBranches, `${root}:${onlyGone}:${q}:${sort}`);
  const incGraph = useIncremental(graph, root);
  const incReflog = useIncremental(reflog, root);
  const incTags = useIncremental(tags, root);
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
    if (!q) return remoteRows;
    const terms = q.split(/\s+/);
    return remoteRows.filter((b) => {
      const hay = `${b.name} ${b.subject} ${b.author}`.toLowerCase();
      return terms.every((t) => hay.includes(t));
    });
  }, [remoteRows, remoteQuery]);
  const incRemoteBranches = useIncremental(shownRemoteBranches, `${root}:${remoteSel}:${remoteQuery}`);

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
  useEffect(() => { setRowIdx(0); setQ(""); setSort("recent"); }, [view, root]);
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
    api.gitRepos().then(({ repos }) => setRepos(repos)).catch(() => { /* keep the stale list rather than an empty one */ });
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
    return (
      <button onClick={() => setView(id)} title={`${VIEW_LABEL[id]}${n ? ` (${n})` : ""} — press ${num}`}
        aria-keyshortcuts={String(num)}
        className="text-[10.5px] leading-none rounded-[5px] transition-colors flex items-baseline gap-1.5 whitespace-nowrap shrink-0"
        style={{
          padding: "7px 7px 4px",
          background: on ? "color-mix(in srgb, var(--primary) 15%, transparent)" : "transparent",
          color: on ? "var(--text)" : "var(--text3)",
          opacity: on ? 1 : 0.72,
        }}>
        {/* The key that gets you here. lazygit does the same in its panel titles
            (gui.showPanelJumps) — a shortcut nothing advertises is a shortcut
            nobody uses. A bare digit was ambiguous with the count while both
            sat on the same line at the same size; raising the count settles it
            without needing an outline around this one. */}
        <span className="tabular-nums" style={{ fontSize: 10, opacity: on ? 0.9 : 0.5, color: on ? "var(--primary-hover)" : undefined }}>{num}</span>
        <span className="relative">
          {VIEW_LABEL[id]}
          {/* Zero is left off rather than drawn: these counts start at zero and
              are only true once that tab has been visited, so a fresh panel
              printing "0" on Tags would be stating something it never checked.
              Every offset is explicit because the CSS reset gives `sup` its own
              `top`, and inheriting that would put the digits somewhere other
              than where this was designed and measured. */}
          {!!n && (
            <sup
              className="tabular-nums"
              style={{
                fontSize: 7.5, lineHeight: 1, verticalAlign: "super",
                position: "relative", top: -4.5, left: 1.5,
                opacity: on ? 1 : 0.68, color: on ? "var(--primary-hover)" : undefined,
              }}
            >{n}</sup>
          )}
        </span>
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
                    onAskClaude={askClaude}
                    onAskClaudeTerminal={askClaudeInTerminal}
                    onOpenEditor={(relPath, line) => {
                      void api.editorOpen(`${root}/${relPath}`, line).then((r) => {
                        if (!r.ok) flash(false, r.error || "Could not open the editor");
                      }).catch((e) => flash(false, String(e)));
                    }}
                  />
                ) : (
                <>
                {/* No overflow-hidden here, ever: the repo picker's dropdown is
                    absolutely positioned inside this row, and clipping the row
                    clipped the menu to a sliver. Overflow is prevented by the
                    branch chip yielding space and the tab strip scrolling —
                    not by cutting off whatever escapes. */}
                <div className={viewHeaderClass} style={viewHeaderStyle}>
                  <h2 className="sr-only">Source control</h2>
                  <CheckoutPicker
                    repos={repos}
                    value={root}
                    onPick={(r) => { setRoot(r); setSelKey(null); }}
                    branchLabel={currentBranchName || null}
                    branches={{ items: branchData.branches, disabled: busy || !writeEnabled, onCheckout: checkout, gone: (b) => trackChip(b.track).gone }}
                    onOpenChange={(o) => { if (o) refreshPicker(); }}
                  />
                  {/* Scrolls rather than shoves. Eight tabs plus a long branch
                      name will not fit a narrow window, and something has to
                      give — a strip you can flick is better than controls
                      pushed off the right edge. */}
                  <div className="flex items-center gap-2.5 ml-1 min-w-0 overflow-x-auto agw-noscrollbar">
                    {VIEW_GROUPS.map((g) => <ViewGroup key={g.label} views={g.views} />)}
                  </div>
                  <div className="ml-auto flex items-center gap-1.5 min-w-0" style={{ opacity: treeStale ? 0.5 : 1, transition: "opacity .18s ease" }}>
                    {/* Switched worktrees — say the numbers are being recomputed
                        rather than leave the old branch's sync count sitting
                        there looking current. */}
                    {treeStale && <span className="animate-spin shrink-0 text-[12px]" style={{ color: "var(--text3)" }} title="Reading the branch you switched to…">⟳</span>}
                    <button
                      onClick={() => setInsightsOpen(true)}
                      disabled={busy}
                      className="text-[11px] px-2 py-1 rounded-lg whitespace-nowrap shrink-0"
                      style={{ color: "var(--text2)", border: "1px solid color-mix(in srgb, var(--border) 40%, transparent)", opacity: busy ? 0.5 : 1 }}
                      title="Repo insights — commit pace, contributors, churn, changelog"
                    >☰ insights</button>
                    {branch?.state === "bisecting" && (
                      <button
                        onClick={() => setBisectOpen(true)}
                        className="text-[11px] px-2 py-1 rounded-lg whitespace-nowrap shrink-0"
                        style={{ color: "var(--warning)", border: "1px solid color-mix(in srgb, var(--warning) 45%, transparent)" }}
                        title="A bisect is in progress — mark the checked-out commit good or bad"
                      >◉ bisect</button>
                    )}
                    {branch && <BranchChip branch={branch} onCopied={(n) => flash(true, `copied ${n}`)} />}
                    {/* Offered only while undoing is exact: an unpushed merge
                        at the tip, on a clean tree. Once anything is committed
                        on top the tip is no longer the merge; once it is
                        pushed the honest undo is a revert, not a rewrite.
                        Deliberately a sibling of the sync block rather than
                        inside it — nested there it inherited "there is
                        something to merge" as a visibility condition and so
                        vanished the instant a sync succeeded, which is exactly
                        the moment it exists for. */}
                    {branch?.canUndoMerge && (
                      <button
                        onClick={async () => {
                          if (!(await ask({ title: `Undo the last merge on ${branch.name}?`, body: "The branch goes back to exactly where it was. Nothing has been pushed, so nothing anyone else has is affected.", confirmLabel: "Undo merge" }))) return;
                          void act(() => api.gitUndoMerge(root), "merge undone", "undo");
                        }}
                        disabled={!writeEnabled || busy}
                        className="text-[11px] px-2 py-1 rounded-lg whitespace-nowrap shrink-0"
                    style={{ color: "var(--text2)", border: "1px solid color-mix(in srgb, var(--border) 40%, transparent)", opacity: busy ? 0.5 : 1 }}
                    title="Undo the last merge — the branch returns to exactly where it was. Offered only because it is unpushed and nothing sits on top of it.">
                    {pending === "undo" ? "undoing…" : "⎌ undo merge"}
                      </button>
                    )}

                    {/*
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
                      */}
                    {/* Where it goes is `chipTarget`'s answer and not this
                        line's — see the file, which carries the four
                        screenshots. No fallback on the press: `from` only ever
                        comes back on the one success path, and that path always
                        names the repository, so a "we know the number but not
                        the repository" case does not exist and a branch for it
                        would be a lie the next reader has to keep alive. What
                        it does instead is not draw the chip, because a button
                        that leads nowhere is worse than no button. */}
                    {prChip.kind === "open" && (
                      <button
                        onClick={() => openPr(prChip.repo, prChip.pr.number)}
                        className="text-[11px] px-2 py-1 rounded-lg whitespace-nowrap flex items-center gap-1.5"
                        style={{ color: "var(--primary)", border: "1px solid color-mix(in srgb, var(--primary) 40%, transparent)" }}
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
                    )}

                    {/* Nothing comes OUT of this branch, but things go INTO it.
                        An integration branch is the ordinary case of that, and
                        the answer to "where is my pull request" there is "there
                        are twelve, and they land here". */}
                    {prAskFailed && !branchPr && prsOntoBranch.length === 0 && (
                      <span className="text-[11px] px-2 py-1 rounded-lg whitespace-nowrap"
                        title={`${prAskFailed} — so this header cannot say whether the branch has a pull request`}
                        style={{ color: "var(--text4)", border: "1px dashed color-mix(in srgb, var(--text) 18%, transparent)" }}>
                        PR unknown
                      </span>
                    )}
                    {!branchPr && prsOntoBranch.length > 0 && (
                      <button
                        onClick={() => openPrs(currentBranchName)}
                        className="text-[11px] px-2 py-1 rounded-lg whitespace-nowrap flex items-center gap-1.5"
                        style={{ color: "var(--text2)", border: "1px solid color-mix(in srgb, var(--border) 45%, transparent)" }}
                        title={`${prsOntoBranch.length} open pull request${prsOntoBranch.length === 1 ? "" : "s"} merge into ${currentBranchName}:\n${prsOntoBranch.slice(0, 6).map((p) => `#${p.number} ${p.title}`).join("\n")}`}>
                        <span style={{ color: "var(--text4)" }}>→</span>
                        {prsOntoBranch.length} PR{prsOntoBranch.length === 1 ? "" : "s"} land here
                      </button>
                    )}

                    {/* Update from base — merge master's latest into the branch
                        you are on, in this checkout. Sits with fetch/pull/push
                        because it belongs to the same family of "bring this
                        checkout up to date"; it was only on the Worktrees tab
                        before, which is not where anyone looks for it.
                        Hidden when there is nothing to merge, and on the trunk
                        itself, which has no base. */}
                    {branch?.base && (branch.behindBase ?? 0) > 0 && (
                      <div className="relative flex items-center">
                    {/* A merge over uncommitted work is refused by the
                            server, so the button should not offer it. Saying
                            why beats a click that produces an error toast —
                            and the reason is the fix. */}
                        <button
                          onClick={() => act(() => api.gitSyncBase(root), `merged ${branch.base}`, "sync")}
                          disabled={!writeEnabled || busy || !tree?.clean || twinBehind}
                          className="text-[11px] px-2 py-1 rounded-l-lg whitespace-nowrap"
                          style={{ color: "var(--warning)", border: "1px solid color-mix(in srgb, var(--warning) 40%, transparent)", borderRight: "none", opacity: (!writeEnabled || busy || !tree?.clean || twinBehind) ? 0.45 : 1 }}
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
                          onOpen={loadBaseRefs}
                          onPick={(name) => setBaseFor(branch.name, name)}
                          disabled={!writeEnabled || busy}
                          className="text-[11px] px-1.5 py-1 rounded-r-lg"
                          style={{ color: "var(--warning)", border: "1px solid color-mix(in srgb, var(--warning) 40%, transparent)" }}
                          title={`Merging from ${branch.base} — pick a different base`} />
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
                    {/*
                      Two defects, and the first is why it looked broken: it
                      only reloaded the working TREE. On the Branches tab — or
                      Tidy, or Worktrees — pressing it did nothing at all,
                      because none of those come from the tree. It refreshes
                      what you are actually looking at now, and the tree too.

                      The second is the one its neighbours already solved and
                      it never got: it said nothing while it worked and nothing
                      when it finished. The comment three buttons up says it —
                      several seconds of nothing reads as "the button is
                      broken" — and on a fast repo the honest problem is the
                      opposite, that a refresh which changes nothing visible is
                      indistinguishable from one that never ran. So it spins
                      while it goes, and says so briefly when it lands.
                    */}
                    <button onClick={refreshAll} disabled={refreshing} title="Refresh this view and the working tree"
                      className="text-[13px] px-2 py-1 rounded-lg disabled:opacity-60" style={{ color: refreshed ? "var(--success)" : "var(--text2)" }}>
                      <span className={refreshing ? "inline-block animate-spin" : "inline-block"}>{refreshed && !refreshing ? "✓" : "⟳"}</span>
                    </button>
                  </div>
                </div>

                {/* Git has stopped in the middle of something. It used to say
                    so in the header chip and offer nothing — leaving you in a
                    conflicted repo with a toast and no way forward, which is
                    the worst moment for the app to go quiet. */}
                {mergeState !== "clean" && (
                  <div className="shrink-0 px-4 py-2 border-b flex flex-col gap-1.5"
                    style={{ borderColor: "color-mix(in srgb, var(--warning) 45%, transparent)", background: "color-mix(in srgb, var(--warning) 8%, transparent)" }}>
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-[11px] font-semibold whitespace-nowrap" style={{ color: "var(--warning)" }}>
                        {mergeState} — {conflicts.length} conflicted file{conflicts.length === 1 ? "" : "s"}
                      </span>
                      {/* Abort first, and always available: it is the only move
                          that is guaranteed safe, and the one you reach for
                          when you did not mean to start this. */}
                      <button onClick={() => act(() => api.gitMergeAbort(root), "merge aborted", "abort")} disabled={busy}
                        className="text-[10.5px] px-2 py-0.5 rounded-lg whitespace-nowrap"
                        style={{ color: "var(--error)", border: "1px solid color-mix(in srgb, var(--error) 40%, transparent)" }}
                        title="Throw the merge away and put the tree back exactly as it was">abort</button>
                      <button onClick={() => act(() => api.gitMergeContinue(root), "merge completed", "continue")} disabled={busy || conflicts.length > 0}
                        className="text-[10.5px] px-2 py-0.5 rounded-lg whitespace-nowrap"
                        style={{ color: "var(--success)", border: "1px solid color-mix(in srgb, var(--success) 40%, transparent)", opacity: conflicts.length ? 0.4 : 1 }}
                        title={conflicts.length ? "resolve every file first" : "commit the merge"}>continue</button>
                      {conflicts.length > 0 && (
                        <>
                          <button onClick={askClaude}
                            className="text-[10.5px] px-2 py-0.5 rounded-lg whitespace-nowrap"
                            style={{ color: "var(--primary-hover)", border: "1px solid color-mix(in srgb, var(--primary) 45%, transparent)" }}
                            title="Open a chat in this repo, asking Claude to resolve them">✦ ask claude</button>
                          {/* The other half of the same choice — see
                              askClaudeInTerminal. A tmux window in this repo,
                              attached, beside your own shells. */}
                          <button onClick={askClaudeInTerminal}
                            className="text-[10.5px] px-2 py-0.5 rounded-lg whitespace-nowrap"
                            style={{ color: "var(--primary-hover)", border: "1px solid color-mix(in srgb, var(--primary) 45%, transparent)" }}
                            title="Open a tmux window in this repo with Claude on it, told which side is which">▸_ in a terminal</button>
                        </>
                      )}
                    </div>
                    {/* Whole-file resolutions: the two that need no editor, and
                        between them most conflicts — a lockfile, a generated
                        migration, a file the other side deleted. */}
                    {conflicts.map((f) => {
                      const relPath = f.startsWith(root) ? f.slice(root.length + 1) : f;
                      const open = blockFile === relPath;
                      return (
                        <div key={f} className="flex flex-col gap-1">
                        <div className="flex items-center gap-2 text-[10.5px]">
                          {/* The name opens the resolver, because that is the
                              only place this file can be read: an unmerged path
                              is a combined diff, which the changes list does not
                              parse — so it is not in that list to select. */}
                          <button onClick={() => void openBlocks(relPath)}
                            className="min-w-0 flex-1 truncate text-left hover:underline"
                            style={{ color: open ? "var(--text)" : "var(--text2)" }}
                            title={`Work through the conflicts in ${f}`}>{relPath}</button>
                          {/* Whole-file is still one click; this is for the file
                              with two unrelated conflicts, where taking a side
                              wholesale to fix one throws away the other. */}
                          <button onClick={() => void openBlocks(relPath)} disabled={busy}
                            className="px-1.5 py-0.5 rounded shrink-0"
                            style={open
                              ? { color: "var(--primary-hover)", border: "1px solid color-mix(in srgb, var(--primary) 45%, transparent)" }
                              : { color: "var(--text3)", border: "1px solid color-mix(in srgb, var(--border) 40%, transparent)" }}
                            title="Choose a side for each conflict in this file">{open ? "hide" : "one by one"}</button>
                          <button onClick={() => act(() => api.gitResolve(root, [relPath], "ours"), `kept ours for ${relPath}`)} disabled={busy}
                            className="px-1.5 py-0.5 rounded shrink-0" style={{ color: "var(--text3)", border: "1px solid color-mix(in srgb, var(--border) 40%, transparent)" }}
                            title="Keep this branch's version">ours</button>
                          <button onClick={() => act(() => api.gitResolve(root, [relPath], "theirs"), `took theirs for ${relPath}`)} disabled={busy}
                            className="px-1.5 py-0.5 rounded shrink-0" style={{ color: "var(--text3)", border: "1px solid color-mix(in srgb, var(--border) 40%, transparent)" }}
                            title="Take the incoming version">theirs</button>
                        </div>
                        {/* The resolver itself is in the MAIN pane — see
                            below. In this strip it was three inches tall under
                            a list of four hundred files that had nothing to do
                            with it. */}
                        </div>
                      );
                    })}
                  </div>
                )}

                {view === "tidy" ? (
                  <TidyView report={tidy} root={root} busy={busyView === "tidy"} />
                ) : view === "changes" ? (
                  <div className="flex-1 min-h-0 flex">
                    <div className="shrink-0 flex flex-col min-h-0" style={{ width: sidebarW }}>
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
                          {/* Named, not silently missing: a summary that covers
                              a different changeset than the one on screen is
                              worse than none, because it is the one you trust. */}
                          {!!walk?.withheld?.length && (
                            <div className="mt-1 text-[9.5px] leading-snug t-dim2">
                              Not sent: {walk.withheld.join(", ")} — credential files are kept out of the prompt.
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
                                  <span className="w-3.5 text-center text-[11px] font-bold shrink-0" style={{ color: "var(--warning)" }}>!</span>
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
                            ＋ {(tree?.staged.length ?? 0) + (tree?.unstaged.length ?? 0)} more the merge brought — show them
                          </button>
                        )}
                        {(!conflicts.length || mergeRest) && !!tree?.staged.length && (
                          <Section title="Staged" count={tree.staged.length} tint="var(--success)" action="unstage all" onAll={writeEnabled ? () => act(() => api.gitUnstageAll(root)) : undefined}>
                            {renderFiles(tree.staged, "unstage", unstage, "s")}
                          </Section>
                        )}
                        {(!conflicts.length || mergeRest) && !!tree?.unstaged.length && (
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
                            <span className="w-3.5 text-center text-[11px] font-bold shrink-0" style={{ color: "var(--warning)" }}>!</span>
                            <span className="text-[12px] font-medium truncate" style={{ color: "var(--text)" }} title={blockFile}>{blockFile}</span>
                            <span className="text-[10.5px] shrink-0" style={{ color: "var(--warning)" }}>in conflict</span>
                            <div className="ml-auto flex items-center gap-1.5 shrink-0">
                              <button onClick={() => act(() => api.gitResolve(root, [blockFile], "ours"), `kept ours for ${blockFile}`)} disabled={busy}
                                className="text-[10.5px] px-1.5 py-0.5 rounded" style={{ color: "var(--text3)", border: "1px solid color-mix(in srgb, var(--border) 40%, transparent)" }}
                                title="Keep this branch's version of the whole file">ours</button>
                              <button onClick={() => act(() => api.gitResolve(root, [blockFile], "theirs"), `took theirs for ${blockFile}`)} disabled={busy}
                                className="text-[10.5px] px-1.5 py-0.5 rounded" style={{ color: "var(--text3)", border: "1px solid color-mix(in srgb, var(--border) 40%, transparent)" }}
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
                  <div className="flex-1 min-h-0 flex flex-col">
                    {/*
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
                      */}
                    <div className="shrink-0 px-3 pt-2.5 pb-2 flex items-center gap-2">
                      <span className="text-[9.5px] uppercase tracking-wider t-dim2 shrink-0">history of</span>
                      <span className="min-w-0 truncate text-[11px] px-2 py-0.5 rounded" style={{ color: "var(--primary-hover)", background: "color-mix(in srgb, var(--primary) 12%, transparent)" }}
                        title={logScope === "all" ? "every branch in this repository" : `${graphBranch || "HEAD"} — the branch this checkout is on`}>
                        {logScope === "all" ? "every branch" : `⎇ ${graphBranch || branch?.name || "HEAD"}`}
                      </span>
                      <div className="flex items-center gap-px rounded-md ml-1" style={{ background: "color-mix(in srgb, var(--border) 12%, transparent)" }}>
                        {([["head", "this branch"], ["all", "all branches"]] as const).map(([s, label]) => (
                          <button key={s} onClick={() => setLogScope(s)}
                            className="text-[10px] px-2 py-1 rounded-md whitespace-nowrap"
                            style={{ background: logScope === s ? "color-mix(in srgb, var(--primary) 16%, transparent)" : "transparent", color: logScope === s ? "var(--text)" : "var(--text3)", border: `1px solid color-mix(in srgb, var(--border) ${logScope === s ? 40 : 15}%, transparent)` }}
                            title={s === "head" ? "Only the commits reachable from this checkout's HEAD" : "git log --all — every branch, which is a lot on a shared repo"}>
                            {label}
                          </button>
                        ))}
                      </div>
                      <span className="ml-auto shrink-0 text-[9.5px] tabular-nums t-dim2">{graph.length ? `${graph.filter((l) => l.hash).length} commits` : ""}</span>
                    </div>
                    {/* The series-cherry-pick action bar: appears when commits
                        are picked, replaces the row it grew from, and carries
                        the replay order in its own words — "oldest first" is
                        the part people second-guess. The keys are what the
                        picker itself advertised: `c` toggles a row. */}
                    {pickSet.size > 0 && (
                      <div className="shrink-0 mx-3 mb-2 px-2.5 py-1.5 rounded-lg flex items-center gap-2" style={{ background: "color-mix(in srgb, var(--primary) 10%, transparent)", border: "1px solid color-mix(in srgb, var(--primary) 35%, transparent)" }}>
                        <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded" style={{ color: "var(--primary-hover)", background: "color-mix(in srgb, var(--primary) 16%, transparent)" }}>{pickSet.size}</span>
                        <span className="min-w-0 flex-1 truncate text-[10.5px] t-dim2">cherry-pick: oldest first, one run</span>
                        <button onClick={() => void runCherryPick()} disabled={busy || !writeEnabled}
                          className="agx-btn text-[10.5px] px-2.5 py-1 rounded-md font-medium whitespace-nowrap"
                          style={{ color: "var(--bg)", background: "var(--primary)", border: "1px solid var(--primary)", opacity: busy || !writeEnabled ? 0.5 : 1 }}
                          title="Replay the picked commits onto this branch in one run — a conflict pauses the series, and Continue finishes it">
                          {pending === `pick:${pickSet.size}` ? "picking…" : `cherry-pick ${pickSet.size}`}
                        </button>
                        <button onClick={() => void runCherryPick(true)} disabled={busy || !writeEnabled}
                          className="agx-btn text-[10.5px] px-2 py-1 rounded-md whitespace-nowrap"
                          style={{ color: "var(--text2)", border: "1px solid color-mix(in srgb, var(--border) 35%, transparent)", opacity: busy || !writeEnabled ? 0.5 : 1 }}
                          title="Cherry-pick without committing — the changes land staged, so you can review or amend them first">
                          stage only
                        </button>
                        {pickSet.size >= 2 && (
                          <button onClick={() => void squashPicked()} disabled={busy || !writeEnabled}
                            className="agx-btn text-[10.5px] px-2 py-1 rounded-md whitespace-nowrap"
                            style={{ color: "var(--text2)", border: "1px solid color-mix(in srgb, var(--border) 35%, transparent)", opacity: busy || !writeEnabled ? 0.5 : 1 }}
                            title="Fold the picked commits into one, tree preserved. Must be a consecutive run ending at the tip of this branch.">
                            squash {pickSet.size}
                          </button>
                        )}
                        <CloseButton onClick={() => setPickSet(new Set())} disabled={busy} title="Clear the selection" className="rounded" style={{ color: "var(--text3)" }} />
                      </div>
                    )}
                  <div onScroll={incGraph.onScroll} className="agx-scroll flex-1 min-h-0 overflow-auto py-1 text-[11.5px]" style={{ fontFamily: "var(--font-mono, ui-monospace), monospace" }}>
                    {incGraph.rows.map((l, i) => {
                      const isCommit = !!l.hash;
                      const picked = isCommit && pickSet.has(l.hash!);
                      return (
                        <div key={i} onClick={isCommit ? () => {
                          if (pickSet.size > 0 || picked) { setPickSet((prev) => { const next = new Set(prev); next.has(l.hash!) ? next.delete(l.hash!) : next.add(l.hash!); return next; }); return; }
                          setRowIdx(i); openCommit(l.hash!, l.subject || "");
                        } : undefined}
                          {...rowProps(i === rowIdx)}
                          className={`flex items-center gap-2 px-3 whitespace-pre ${isCommit ? "cursor-pointer hover:brightness-125" : ""}`}
                          style={{ lineHeight: "1.55", ...(i === rowIdx ? rowProps(true).style : {}), ...(picked ? { background: "color-mix(in srgb, var(--primary) 16%, transparent)" } : {}) }}
                          title={isCommit ? (pickSet.size > 0 ? "Toggle this commit in the cherry-pick series" : "View this commit's diff") : undefined}
                          onContextMenu={isCommit ? (e) => { e.preventDefault(); setRowIdx(i); setCommitMenu({ hash: l.hash!, subject: l.subject || "", x: e.clientX, y: e.clientY }); } : undefined}>
                          <span style={{ color: "color-mix(in srgb, var(--primary) 75%, var(--text3))" }}>{l.graph}</span>
                          {isCommit && <>
                            <span className="shrink-0 tabular-nums" style={{ color: picked ? "var(--primary-hover)" : "var(--text3)" }}>{picked ? "●" : ""}</span>
                            <span className="shrink-0 tabular-nums" style={{ color: "var(--primary-hover)" }}>{l.hash}</span>
                            {l.refs && <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded" style={{ color: "var(--success)", background: "color-mix(in srgb, var(--success) 12%, transparent)" }}>{l.refs}</span>}
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
                  </div>
                ) : view === "branches" ? (
                  <div onScroll={incBranches.onScroll} className="agx-scroll flex-1 min-h-0 overflow-y-auto p-3">
                    {writeEnabled && (
                      <div className="flex items-center gap-2 mb-3 max-w-lg">
                        <input value={newBranch} onChange={(e) => setNewBranch(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") createBranch(); }} placeholder="new-branch-name" className="flex-1 px-2.5 py-1.5 rounded-lg text-[11.5px] outline-none" style={{ background: "color-mix(in srgb, var(--bg3) 40%, transparent)", border: "1px solid color-mix(in srgb, var(--border) 45%, transparent)", color: "var(--text)" }} />
                        <button onClick={createBranch} disabled={busy || !newBranch.trim()} className="text-[11px] px-3 py-1.5 rounded-lg font-medium" style={{ background: "color-mix(in srgb, var(--primary) 18%, transparent)", border: "1px solid color-mix(in srgb, var(--primary) 40%, transparent)", color: "var(--text)", opacity: newBranch.trim() ? 1 : 0.5 }}>+ create & switch</button>
                      </div>
                    )}
                    <ListToolbar
                      q={q} onQ={(v) => { setQ(v); setRowIdx(0); }}
                      placeholder="Search branches by name or last commit…"
                      sort={sort} onSort={(s) => { setSort(s); setRowIdx(0); }}
                      sorts={[
                        { key: "recent", label: "recent", title: "Most recently committed first — git's own order" },
                        { key: "name", label: "name", title: "Alphabetical, for when you know the ticket number" },
                        { key: "track", label: "unsynced", title: "Furthest from its upstream first — what still has something to settle" },
                      ]}
                      count={shownBranches.length} total={branchTotal}
                    />
                    {/* Merged-and-tidied branches pile up invisibly — a repo worked
                        one-ticket-per-branch ends up mostly dead entries. lazygit
                        marks them but never lets you see just those, which is the
                        view you want when the actual job is deleting them. */}
                    {goneCount > 0 && (
                      <div className="flex items-center gap-2 mb-2 flex-wrap">
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
                            {busy ? `${pending ?? "working"}…` : `delete ${goneMerged.length} merged`}
                          </button>
                        )}
                        {onlyGone && (() => {
                          // Composed, not concatenated. Each piece used to carry
                          // its own separator and guess whether it needed one,
                          // so with nothing merged the sweep note and the kept
                          // count ran together into one unreadable string.
                          // Joining a list cannot produce that.
                          const parts: ReactNode[] = [];
                          if (goneMerged.length) parts.push(<>{goneMerged.length} already in {branchData.trunk ?? "the trunk"}</>);
                          // "Not merged" is a verdict, and while the squash /
                          // rebase sweep is still running it is not one we have
                          // yet: those checks are what turn most of these
                          // green. Saying so beats stating a false negative as
                          // final, and it clears itself: the sweep pushes the
                          // moment it proves anything.
                          if (goneUnmerged.length) parts.push(
                            branchData.checking
                              ? <span style={{ color: "var(--text2)" }}>Checking {goneUnmerged.length} more…</span>
                              : <span style={{ color: "var(--warning)" }}>{goneUnmerged.length} not merged — kept</span>,
                          );
                          return <span className="text-[9.5px] t-dim2">{parts.map((p, i) => <Fragment key={i}>{i > 0 && " · "}{p}</Fragment>)}</span>;
                        })()}
                      </div>
                    )}
                    {!incBranches.rows.length && <PaneEmpty busy={busyView === "branches"} what="branches" />}
                    {incBranches.rows.map((b, i) => {
                      const t = trackChip(b.track);
                      const sel = i === rowIdx;
                      // Current from the FRESH working-tree poll, not the branch
                      // list — so the ⎇ moves the instant you switch.
                      const isCurrent = b.name === currentBranchName;
                      // Checked out in a worktree? Then "switch" means open that
                      // worktree, and the row says so — lazygit's one-list model.
                      const wt = wtByBranch.get(b.name);
                      const wtElsewhere = wt && wt.path !== root;
                      return (
                        // The cursor wins over the current-branch tint: you need
                        // to see where the keyboard is, and "this is HEAD" is
                        // already said by the ⎇ glyph.
                        <div key={b.name} onClick={() => setRowIdx(i)} {...rowProps(sel)}
                          className="group px-2.5 py-1.5 rounded-md"
                          // The action column is reserved whether or not the
                          // buttons are drawn, so hovering cannot resize the
                          // subject beside it. See ROW_GRID.
                          style={{ ...ROW_GRID, ...(sel ? rowProps(true).style : { background: isCurrent ? "color-mix(in srgb, var(--primary) 12%, transparent)" : "transparent" }), ["--gitrow-actions" as string]: writeEnabled ? "23rem" : "0px" }}>
                          <span className="text-center text-[11px]" style={{ color: "var(--primary-hover)" }}>{isCurrent ? "⎇" : ""}</span>
                          {/* Name and its badges share one track and truncate
                              together — the badges say what the branch IS, so
                              they must not be pushed out by a long name. */}
                          <span className="flex items-center gap-1.5 min-w-0">
                            <button disabled={isCurrent || !writeEnabled || busy} onClick={(e) => { e.stopPropagation(); switchTo(b); }} className="text-[12px] font-medium text-left truncate min-w-0" style={{ color: isCurrent ? "var(--text)" : "var(--text2)", cursor: isCurrent ? "default" : "pointer" }} title={isCurrent ? `${b.name} — you are here` : wtElsewhere ? `${b.name} — open its worktree` : `Switch to ${b.name}`}>{b.name}</button>
                            {/* Checked out in a worktree — switching opens it. */}
                            {wt && <span className="shrink-0 text-[10px] px-1 py-px rounded" style={{ color: "var(--primary-hover)", background: "color-mix(in srgb, var(--primary) 14%, transparent)" }} title={`checked out in ${wt.path}`}>▸ {wtName(wt.path)}</span>}
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
                            {t.gone && <span className="shrink-0 text-[10px] px-1 py-px rounded" style={{ color: "var(--error)", background: "color-mix(in srgb, var(--error) 12%, transparent)" }} title={`${b.upstream} no longer exists on the remote — this branch was probably merged`}>gone</span>}
                            {/* Cut to read a pull request, not to build anything —
                                see lib/scratchBranch.ts for why the rule is this
                                narrow. Drawn in the quiet neutral rather than a
                                warning colour: this is a classification, not a
                                problem, and the row beside it uses red for a
                                branch whose remote is gone. */}
                            {isScratchBranch(b.name) && (
                              <span className="shrink-0 text-[10px] px-1 py-px rounded"
                                style={{ color: "var(--text3)", background: "color-mix(in srgb, var(--text) 8%, transparent)" }}
                                title={scratchNote(b.name)}>scratch</span>
                            )}
                            {/* In sync, and freshly enough fetched to mean it. */}
                            {b.upstream && !t.gone && !t.ahead && !t.behind && <span className="shrink-0 text-[9.5px]" style={{ color: "var(--success)" }} title={`in sync with ${b.upstream}`}>✓</span>}
                          </span>
                          <span className="min-w-0 truncate text-[10px] t-dim2" title={b.subject}>{b.subject}</span>
                          <span className="text-[9.5px] t-dim2 whitespace-nowrap text-right">{b.date}</span>
                          {writeEnabled && !isCurrent ? (
                            <div className={`flex items-center justify-end gap-1.5 transition-opacity ${sel ? "opacity-100" : "opacity-0 group-hover:opacity-100"}`}>
                              {/* The switch, first and filled — the action you came
                                  for. "Open worktree" when it lives in one, else a
                                  plain checkout. */}
                              {wtElsewhere
                                ? <button onClick={(e) => { e.stopPropagation(); openWorktree(wt!); }} disabled={busy} className="agx-btn text-[10px] px-2 py-0.5 rounded whitespace-nowrap font-medium" style={{ color: "var(--bg)", background: "var(--primary)", border: "1px solid var(--primary)" }} title={`Open ${b.name}'s worktree — ${wt!.path}`}>▸ Open worktree</button>
                                : <button onClick={(e) => { e.stopPropagation(); checkout(b.name); }} disabled={busy} className="agx-btn text-[10px] px-2 py-0.5 rounded whitespace-nowrap font-medium" style={{ color: "var(--bg)", background: "var(--primary)", border: "1px solid var(--primary)" }} title={`Switch this checkout to ${b.name}`}>⎇ Checkout</button>}
                              <button onClick={(e) => { e.stopPropagation(); openBranchOnWeb(b); }} className="agx-btn text-[10px] px-1.5 py-0.5 rounded whitespace-nowrap" style={{ color: "var(--text2)", border: "1px solid color-mix(in srgb, var(--border) 30%, transparent)" }} title={trackChip(b.track).gone ? "its remote branch is gone — find the pull request it came from" : "open this branch on GitHub"}>open ↗</button>
                              <button onClick={(e) => { e.stopPropagation(); mergeBranch(b.name); }} className="agx-btn text-[10px] px-1.5 py-0.5 rounded" style={{ color: "var(--text2)", border: "1px solid color-mix(in srgb, var(--border) 30%, transparent)" }} title={`Merge ${b.name} into current`}>merge</button>
                              <button onClick={(e) => { e.stopPropagation(); setCompareTarget(b.name); }} className="agx-btn text-[10px] px-1.5 py-0.5 rounded" style={{ color: "var(--text2)", border: "1px solid color-mix(in srgb, var(--border) 30%, transparent)" }} title={`Compare ${b.name} with another ref — how far apart they are`}>compare</button>
                              <button onClick={(e) => { e.stopPropagation(); rebaseBranch(b.name); }} className="agx-btn text-[10px] px-1.5 py-0.5 rounded" style={{ color: "var(--text2)", border: "1px solid color-mix(in srgb, var(--border) 30%, transparent)" }} title={`Rebase current onto ${b.name}`}>rebase</button>
                              <button onClick={(e) => { e.stopPropagation(); renameBranch(b.name); }} className="agx-btn text-[10px] px-1.5 py-0.5 rounded" style={{ color: "var(--text2)" }}>rename</button>
                              <button onClick={(e) => { e.stopPropagation(); deleteBranch(b); }} className="agx-btn text-[10px] px-1.5 py-0.5 rounded" style={{ color: "var(--error)" }} title="Delete branch">delete</button>
                            </div>
                          ) : <span className="text-[10px] px-1.5 py-0.5 rounded inline-block" style={{ border: "1px solid transparent" }} aria-hidden>&nbsp;</span>}
                        </div>
                      );
                    })}
                    <MoreRows shown={incBranches.rows.length} total={shownBranches.length} onAll={incBranches.showAll} />
                  </div>
                ) : view === "stashes" ? (
                  <div className="agx-scroll flex-1 min-h-0 overflow-y-auto p-3">
                    {writeEnabled && <button onClick={stashPush} disabled={busy || tree?.clean} className="mb-3 text-[11px] px-3 py-1.5 rounded-lg font-medium" style={{ background: "color-mix(in srgb, var(--primary) 16%, transparent)", border: "1px solid color-mix(in srgb, var(--primary) 35%, transparent)", color: "var(--text)", opacity: tree?.clean ? 0.5 : 1 }}>⇩ stash all changes</button>}
                    {/* Snapshots: named checkpoints that never touch the tree.
                        stash push MOVES work off the tree; a snapshot copies it
                        and leaves the tree alone — so "before I try this" can
                        restore even after the experiment goes sideways. */}
                    {writeEnabled && (
                      <div className="flex items-center gap-2 mb-2 max-w-lg">
                        <input value={snapshotLabel} onChange={(e) => setSnapshotLabel(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") snapshotNow(); }} placeholder="snapshot label (optional) — tree is not touched" className="flex-1 px-2.5 py-1.5 rounded-lg text-[11.5px] outline-none" style={{ background: "color-mix(in srgb, var(--bg3) 40%, transparent)", border: "1px solid color-mix(in srgb, var(--border) 45%, transparent)", color: "var(--text)" }} />
                        <button onClick={snapshotNow} disabled={busy || tree?.clean} className="text-[11px] px-3 py-1.5 rounded-lg font-medium whitespace-nowrap" style={{ background: "color-mix(in srgb, var(--info) 16%, transparent)", border: "1px solid color-mix(in srgb, var(--info) 35%, transparent)", color: "var(--text)", opacity: tree?.clean ? 0.5 : 1 }} title="Copy the current tree into refs/agx/wip — nothing moves, restore anytime">⟳ snapshot now</button>
                      </div>
                    )}
                    {snapshots.length > 0 && (
                      <div className="mb-3">
                        <div className="text-[9.5px] uppercase tracking-wider t-dim2 mb-1">snapshots</div>
                        <div className="space-y-0.5">
                          {snapshots.map((s) => (
                            <div key={s.ref} className="group px-2.5 py-1.5 rounded-md" style={{ background: "color-mix(in srgb, var(--info) 7%, transparent)", border: "1px solid color-mix(in srgb, var(--info) 18%, transparent)" }}>
                              <div className="flex items-center gap-2">
                                <span className="text-[9.5px] tabular-nums font-mono" style={{ color: "var(--info)" }}>{s.sha.slice(0, 7)}</span>
                                <span className="min-w-0 flex-1 truncate text-[11.5px]" style={{ color: "var(--text)" }}>{s.label || "untitled snapshot"}</span>
                                <span className="shrink-0 text-[9.5px] t-dim2">{s.time}</span>
                                {writeEnabled && (
                                  <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100">
                                    <button onClick={() => act(() => api.gitSnapshotRestore(root, s.sha), "Restored snapshot")} className="text-[10px] px-1.5 py-0.5 rounded" style={{ color: "var(--success)", border: "1px solid color-mix(in srgb, var(--success) 30%, transparent)" }} title="Apply the snapshot's tree onto the current one">restore</button>
                                    <button onClick={async () => { if (await ask({ title: "Delete this snapshot?", body: "The checkpoint is gone for good.", danger: true, confirmLabel: "Delete" })) act(() => api.gitSnapshotDelete(root, s.sha), "Deleted snapshot"); }} className="text-[10px] px-1.5 py-0.5 rounded" style={{ color: "var(--error)" }}>delete</button>
                                  </div>
                                )}
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                    {writeEnabled && (
                      <div className="mb-2">
                        <button onClick={() => { setPartialOpen(!partialOpen); }} className="text-[11px] px-3 py-1.5 rounded-lg font-medium" style={{ background: "color-mix(in srgb, var(--primary) 12%, transparent)", border: "1px solid color-mix(in srgb, var(--primary) 30%, transparent)", color: "var(--text)" }}>▣ stash some files…</button>
                        {partialOpen && (
                          <div className="mt-2 rounded-lg p-2.5 max-w-lg" style={{ background: "color-mix(in srgb, var(--bg3) 30%, transparent)", border: "1px solid color-mix(in srgb, var(--border) 35%, transparent)" }}>
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
                    <ListToolbar q={q} onQ={(v) => { setQ(v); setRowIdx(0); }} placeholder="Search stashes…" count={shownStashes.length} total={stashes.length} />
                    {shownStashes.map((s, i) => (
                      <div key={s.ref} {...rowProps(i === rowIdx)} className="group px-2.5 py-1.5 rounded-md" onClick={() => setRowIdx(i)}
                        style={{ ...ROW_GRID, gridTemplateColumns: "5rem minmax(0, 1fr) var(--gitrow-actions, 0px)", ...rowProps(i === rowIdx).style, ["--gitrow-actions" as string]: writeEnabled ? "18rem" : "0px" }}>
                        <span className="text-[10px] tabular-nums t-dim2">{s.ref}</span>
                        <span className="min-w-0 truncate text-[11.5px]" style={{ color: "var(--text)" }} title={s.message}>{s.message}</span>
                        {writeEnabled ? (
                          <div className="flex items-center justify-end gap-1 opacity-0 group-hover:opacity-100">
                            <button onClick={() => stashOp("apply", s.index)} className="text-[10px] px-1.5 py-0.5 rounded" style={{ color: "var(--text2)", border: "1px solid color-mix(in srgb, var(--border) 30%, transparent)" }}>apply</button>
                            <button onClick={() => stashOp("pop", s.index)} className="text-[10px] px-1.5 py-0.5 rounded" style={{ color: "var(--success)", border: "1px solid color-mix(in srgb, var(--success) 30%, transparent)" }}>pop</button>
                            <button onClick={() => stashToBranch(s.index)} className="text-[10px] px-1.5 py-0.5 rounded" style={{ color: "var(--text2)", border: "1px solid color-mix(in srgb, var(--border) 30%, transparent)" }} title="Check out a new branch at the stash's base, apply onto it, drop the stash">branch</button>
                            <button onClick={() => stashOverwrite(s.index, s.message)} className="text-[10px] px-1.5 py-0.5 rounded" style={{ color: "var(--warning)", border: "1px solid color-mix(in srgb, var(--warning) 35%, transparent)" }} title="Apply even where the working tree has moved on — replaces those paths">overwrite</button>
                            <button onClick={() => stashRename(s.index, s.message.replace(/^[^:]*: /, ""))} className="text-[10px] px-1.5 py-0.5 rounded" style={{ color: "var(--text2)", border: "1px solid color-mix(in srgb, var(--border) 30%, transparent)" }}>rename</button>
                            <button onClick={() => stashOp("drop", s.index)} className="text-[10px] px-1.5 py-0.5 rounded" style={{ color: "var(--error)" }}>drop</button>
                          </div>
                        ) : <span className="text-[10px] px-1.5 py-0.5 rounded inline-block" style={{ border: "1px solid transparent" }} aria-hidden>&nbsp;</span>}
                      </div>
                    ))}
                    {!stashes.length && <PaneEmpty busy={busyView === "stashes"} what="stashes" />}
                  </div>
                ) : view === "remotes" ? (
                  /*
                   * The remote, and then what is actually on it.
                   *
                   * This tab used to be one row — "origin · 790 branches · url"
                   * — which is a fact about the repository nobody needs twice.
                   * The 790 were the interesting part and there was no way to
                   * see them, so a branch a colleague pushed was reachable only
                   * by typing git in a terminal. Now the remote line is a
                   * header (a picker, when there is more than one) and the pane
                   * below it is the branch list, searchable, with the one
                   * action that matters: get it onto this machine.
                   */
                  <div className="flex-1 min-h-0 flex flex-col">
                    <div className="px-3 pt-3 pb-2 shrink-0 flex flex-col gap-2">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        {remotes.map((r) => {
                          const on = r.name === remoteSel;
                          return (
                            <button key={r.name} onClick={() => { setRemoteSel(r.name); setRemoteQuery(""); }}
                              className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-[11px] max-w-full"
                              style={{ background: on ? "color-mix(in srgb, var(--primary) 14%, transparent)" : "transparent", border: `1px solid color-mix(in srgb, var(--${on ? "primary" : "border"}) ${on ? 35 : 30}%, transparent)`, color: on ? "var(--text)" : "var(--text2)" }}
                              title={`${r.fetchUrl}${r.pushUrl && r.pushUrl !== r.fetchUrl ? `\npushes to ${r.pushUrl}` : ""}`}>
                              <span className="font-medium shrink-0">{r.name}</span>
                              <span className="shrink-0 text-[9.5px] tabular-nums t-dim2">{r.branches}</span>
                              <span className="min-w-0 truncate text-[9.5px] t-dim2">{r.fetchUrl}</span>
                              {/* Only worth showing when they differ — the fork
                                  setup, where you fetch from upstream and push
                                  to your own. */}
                              {r.pushUrl && r.pushUrl !== r.fetchUrl && <span className="shrink-0 text-[10px] px-1 py-px rounded" style={{ color: "var(--warning)", background: "color-mix(in srgb, var(--warning) 12%, transparent)" }}>push ≠ fetch</span>}
                            </button>
                          );
                        })}
                      </div>
                      {!!remotes.length && (
                        <div className="flex items-center gap-2">
                          <input value={remoteQuery} onChange={(e) => { setRemoteQuery(e.target.value); setRowIdx(0); }}
                            placeholder={`search ${remoteSel || "remote"} branches…`}
                            className="flex-1 min-w-0 px-2.5 py-1.5 rounded-lg text-[11.5px] outline-none"
                            style={{ background: "color-mix(in srgb, var(--bg3) 40%, transparent)", border: "1px solid color-mix(in srgb, var(--border) 45%, transparent)", color: "var(--text)" }} />
                          {/* Counted against the whole list, not the page: "36
                              of 790" is the only way to know whether the search
                              narrowed anything. */}
                          <span className="shrink-0 text-[9.5px] tabular-nums t-dim2">
                            {remoteQuery.trim() ? `${shownRemoteBranches.length} of ${remoteRows.length}` : `${remoteRows.length} branch${remoteRows.length === 1 ? "" : "es"}`}
                          </span>
                          {remoteQuery.trim() && (
                            <button onClick={() => setRemoteQuery("")} className="shrink-0 text-[10px] px-1.5 py-0.5 rounded" style={{ color: "var(--text2)", border: "1px solid color-mix(in srgb, var(--border) 30%, transparent)" }}>clear</button>
                          )}
                        </div>
                      )}
                      {/* These refs are the last fetch's answer, and every other
                          number in this panel is measured against them. Saying
                          so is cheaper than someone wondering why a branch
                          pushed a minute ago isn't here. */}
                      {!!remotes.length && <div className="text-[9.5px] t-dim2">as of the last fetch — press fetch above for anything newer</div>}
                    </div>
                    <div onScroll={incRemoteBranches.onScroll} className="agx-scroll flex-1 min-h-0 overflow-y-auto px-3 pb-3">
                      {!shownRemoteBranches.length && (
                        remoteQuery.trim() && remoteRows.length
                          ? <div className="grid place-items-center py-10 t-dim2 text-[12px]">nothing on {remoteSel} matches “{remoteQuery.trim()}”</div>
                          : <PaneEmpty busy={busyView === "remotes"} what={remotes.length ? "remote branches" : "remotes"} />
                      )}
                      {incRemoteBranches.rows.map((b, i) => {
                        const sel = i === rowIdx;
                        return (
                          <div key={b.ref} onClick={() => setRowIdx(i)} {...rowProps(sel)}
                            className="group px-2.5 py-1.5 rounded-md"
                            style={{ ...ROW_GRID, gridTemplateColumns: "minmax(0, 1fr) auto 5rem minmax(0, 22rem) 11rem 5.5rem var(--gitrow-actions, 0px)", ...rowProps(sel).style, ["--gitrow-actions" as string]: writeEnabled ? "17rem" : "0px" }}>
                            <span className="text-[11.5px] font-medium truncate min-w-0" style={{ color: b.local ? "var(--text)" : "var(--text2)" }} title={b.ref}>{b.name}</span>
                            {/* Whether you already have it is the whole reason
                                this list is worth reading. A checkout that has
                                it out is stronger still — that is where the
                                work would go. */}
                            {b.worktree
                              ? <span className="shrink-0 text-[10px] px-1 py-px rounded" style={{ color: "var(--primary-hover)", background: "color-mix(in srgb, var(--primary) 14%, transparent)" }} title={`checked out in ${b.worktree}`}>▸ {wtName(b.worktree)}</span>
                              : b.local
                                ? <span className="shrink-0 text-[10px] px-1 py-px rounded" style={{ color: "var(--success)", background: "color-mix(in srgb, var(--success) 12%, transparent)" }} title={b.tracking ? "you have this branch, tracking this remote one" : "you have a local branch of this name — it tracks something else"}>{b.tracking ? "local" : "local ≠"}</span>
                                : null}
                            <span className="text-[9.5px] tabular-nums t-dim2">{b.hash}</span>
                            <span className="min-w-0 truncate text-[10px] t-dim2" title={b.subject}>{b.subject}</span>
                            <span className="text-[9.5px] t-dim2 truncate min-w-0 text-right" title={b.author}>{b.author}</span>
                            <span className="text-[9.5px] t-dim2 text-right whitespace-nowrap">{b.date}</span>
                            <span className="flex items-center justify-end gap-1.5">
                            {writeEnabled && !b.local && (
                              // Three real buttons, ordered by how much they move,
                              // shown on the row you are on (not hover-only) so it
                              // is obvious the actions are there and what each does.
                              // "Checkout" is filled because it is the one that
                              // moves this checkout; the other two are quieter
                              // because they leave it where it is.
                              <div className={`shrink-0 flex items-center gap-1.5 transition-opacity ${sel ? "opacity-100" : "opacity-0 group-hover:opacity-100"}`}>
                                <button onClick={(e) => { e.stopPropagation(); takeRemote(b, "local"); }} disabled={busy}
                                  className="agx-btn text-[10px] px-2 py-0.5 rounded whitespace-nowrap"
                                  style={{ color: "var(--success)", background: "color-mix(in srgb, var(--success) 14%, transparent)", border: "1px solid color-mix(in srgb, var(--success) 42%, transparent)" }}
                                  title={`Bring “${b.name}” to local: create a local branch tracking ${b.ref}. Your current checkout stays put — nothing is switched.`}>↓ Bring local</button>
                                <button onClick={(e) => { e.stopPropagation(); takeRemote(b, "checkout"); }} disabled={busy}
                                  className="agx-btn text-[10px] px-2 py-0.5 rounded whitespace-nowrap font-medium"
                                  style={{ color: "var(--bg)", background: "var(--primary)", border: "1px solid var(--primary)" }}
                                  title={`Create the local branch and switch THIS checkout onto ${b.name}.`}>⎇ Checkout</button>
                                <button onClick={(e) => { e.stopPropagation(); takeRemote(b, "worktree"); }} disabled={busy}
                                  className="agx-btn text-[10px] px-2 py-0.5 rounded whitespace-nowrap"
                                  style={{ color: "var(--text2)", background: "color-mix(in srgb, var(--bg3) 45%, transparent)", border: "1px solid color-mix(in srgb, var(--border) 45%, transparent)" }}
                                  title={`Check ${b.name} out in its own folder beside this one — this checkout is untouched.`}>+ Worktree</button>
                              </div>
                            )}
                            {/* Already here: the useful action is going there,
                                not making a second copy. */}
                            {b.local && b.worktree && b.worktree !== root && (
                              <button onClick={(e) => { e.stopPropagation(); openWorktree({ path: b.worktree!, branch: b.name, head: b.hash, current: false, bare: false, locked: false }); }}
                                className={`agx-btn shrink-0 text-[10px] px-2 py-0.5 rounded whitespace-nowrap transition-opacity ${sel ? "opacity-100" : "opacity-0 group-hover:opacity-100"}`}
                                style={{ color: "var(--bg)", background: "var(--primary)", border: "1px solid var(--primary)" }}
                                title={`Open its worktree — ${b.worktree}`}>▸ Open worktree</button>
                            )}
                            </span>
                          </div>
                        );
                      })}
                      <MoreRows shown={incRemoteBranches.rows.length} total={shownRemoteBranches.length} onAll={incRemoteBranches.showAll} />
                    </div>
                  </div>
                ) : view === "tags" ? (
                  <div onScroll={incTags.onScroll} className="agx-scroll flex-1 min-h-0 overflow-y-auto p-3">
                    {writeEnabled && (
                      <button onClick={() => void createTagAsk()} className="mb-3 text-[11px] px-3 py-1.5 rounded-lg font-medium" style={{ background: "color-mix(in srgb, var(--primary) 16%, transparent)", border: "1px solid color-mix(in srgb, var(--primary) 35%, transparent)", color: "var(--text)" }}>+ new tag</button>
                    )}
                    <ListToolbar q={q} onQ={(v) => { setQ(v); setRowIdx(0); }} placeholder="Search tags by name, commit or subject…"
                      sort={sort} onSort={(x) => { setSort(x); setRowIdx(0); }}
                      sorts={[{ key: "recent", label: "recent", title: "Newest tag first" }, { key: "name", label: "name", title: "Alphabetical" }]}
                      count={shownTags.length} total={tags.length} />
                    {incTags.rows.map((t, i) => (
                      <div key={t.name} {...rowProps(i === rowIdx)} className="group px-2.5 py-1.5 rounded-md" onClick={() => setRowIdx(i)}
                        style={{ ...ROW_GRID, gridTemplateColumns: "minmax(0, 18rem) 5rem minmax(0, 1fr) auto", ...rowProps(i === rowIdx).style }}>
                        <span className="text-[11.5px] font-medium truncate min-w-0" style={{ color: "var(--text)" }} title={t.name}>{t.annotated ? "🏷" : "⚑"} {t.name}</span>
                        <span className="text-[9.5px] tabular-nums t-dim2">{t.hash}</span>
                        <span className="min-w-0 truncate text-[10px] t-dim2" title={t.subject}>{t.subject}</span>
                        <span className="flex items-center gap-1 whitespace-nowrap">
                          <span className="text-[9.5px] t-dim2 text-right">{t.date}</span>
                          {writeEnabled && (
                            <span className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                              <button onClick={(e) => { e.stopPropagation(); tagPush(t.name); }} className="w-5 h-5 grid place-items-center rounded text-[11px]" style={{ color: "var(--info)" }} title="Push to the remote">⇡</button>
                              <button onClick={(e) => { e.stopPropagation(); void tagDeleteRemoteAsk(t.name); }} className="w-5 h-5 grid place-items-center rounded text-[11px]" style={{ color: "var(--warning)" }} title="Delete on the remote">↷</button>
                              <CloseButton onClick={(e) => { e.stopPropagation(); void tagDeleteAsk(t.name); }} className="rounded" style={{ color: "var(--error)" }} title="Delete locally" />
                            </span>
                          )}
                        </span>
                      </div>
                    ))}
                    {!shownTags.length && <PaneEmpty busy={busyView === "tags"} what="tags" />}
                    <MoreRows shown={incTags.rows.length} total={shownTags.length} onAll={incTags.showAll} />
                  </div>
                ) : view === "submodules" ? (
                  <div className="agx-scroll flex-1 min-h-0 overflow-y-auto p-3">
                    {writeEnabled && (
                      <button onClick={submoduleAddAsk} className="mb-3 text-[11px] px-3 py-1.5 rounded-lg font-medium" style={{ background: "color-mix(in srgb, var(--primary) 16%, transparent)", border: "1px solid color-mix(in srgb, var(--primary) 35%, transparent)", color: "var(--text)" }}>+ add submodule</button>
                    )}
                    {submodules.length === 0 && !busy && <PaneEmpty busy={false} what="submodules" />}
                    {submodules.map((s) => (
                      <div key={s.path} className="group px-2.5 py-1.5 rounded-md" style={{ background: "color-mix(in srgb, var(--bg3) 22%, transparent)", border: "1px solid color-mix(in srgb, var(--border) 25%, transparent)", marginBottom: 6 }}>
                        <div className="flex items-center gap-2">
                          <span className="min-w-0 flex-1 truncate text-[11.5px] font-medium" style={{ color: "var(--text)" }}>{s.path}</span>
                          <span className="shrink-0 rounded px-1.5 py-px text-[9px] font-medium" style={{
                            background: s.status === "clean" ? "color-mix(in srgb, var(--success) 16%, transparent)" : s.status === "modified" ? "color-mix(in srgb, var(--warning) 16%, transparent)" : s.status === "conflict" ? "color-mix(in srgb, var(--error) 16%, transparent)" : "color-mix(in srgb, var(--text3) 16%, transparent)",
                            color: s.status === "clean" ? "var(--success)" : s.status === "modified" ? "var(--warning)" : s.status === "conflict" ? "var(--error)" : "var(--text2)",
                            border: "1px solid color-mix(in srgb, var(--border) 30%, transparent)",
                          }}>
                            {s.status === "clean" ? "clean" : s.status === "modified" ? "modified" : s.status === "conflict" ? "conflict" : "uninitialized"}
                          </span>
                          <span className="shrink-0 font-mono text-[9.5px] t-dim2">{s.sha.slice(0, 7)}</span>
                          {writeEnabled && (
                            <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100">
                              <button onClick={() => submoduleOp("update", s.path, `Updated ${s.path}`)} className="text-[10px] px-1.5 py-0.5 rounded" style={{ color: "var(--text2)", border: "1px solid color-mix(in srgb, var(--border) 30%, transparent)" }} title="git submodule update --init --recursive">update</button>
                              <button onClick={() => submoduleOp("sync", s.path, `Synced ${s.path}`)} className="text-[10px] px-1.5 py-0.5 rounded" style={{ color: "var(--text2)", border: "1px solid color-mix(in srgb, var(--border) 30%, transparent)" }} title="Re-write URLs from .gitmodules into the checkout">sync</button>
                              <button onClick={() => submoduleDeinitAsk(s.path)} className="text-[10px] px-1.5 py-0.5 rounded" style={{ color: "var(--warning)", border: "1px solid color-mix(in srgb, var(--warning) 35%, transparent)" }}>deinit</button>
                              <button onClick={() => submoduleRemoveAsk(s.path)} className="text-[10px] px-1.5 py-0.5 rounded" style={{ color: "var(--error)" }}>remove</button>
                            </div>
                          )}
                        </div>
                        <div className="mt-0.5 flex items-center gap-2 text-[9.5px] t-dim2">
                          <span className="truncate">{s.url || "no url in .gitmodules"}</span>
                          {s.branch && <span className="shrink-0">· {s.branch}</span>}
                        </div>
                      </div>
                    ))}
                  </div>
                ) : view === "reflog" ? (
                  <div onScroll={incReflog.onScroll} className="agx-scroll flex-1 min-h-0 overflow-y-auto p-3">
                    {/* Where HEAD has been. This is the trail that makes a bad
                        reset or rebase recoverable, which is why it earns a tab
                        of its own rather than living inside the log. */}
                    {incReflog.rows.map((e, i) => (
                      <div key={e.ref} {...rowProps(i === rowIdx)} className="group flex items-center gap-3 px-2.5 py-1 rounded-md" onClick={() => setRowIdx(i)}>
                        <span className="shrink-0 text-[9.5px] tabular-nums t-dim2" style={{ minWidth: 68 }}>{e.ref}</span>
                        <span className="shrink-0 text-[9.5px] tabular-nums" style={{ color: "var(--primary-hover)" }}>{e.shortHash}</span>
                        <span className="shrink-0 text-[9.5px] px-1 py-px rounded" style={{ minWidth: 92, color: "var(--text2)", background: "color-mix(in srgb, var(--bg3) 45%, transparent)" }}>{e.action}</span>
                        <span className="min-w-0 flex-1 truncate text-[11px]" style={{ color: "var(--text)" }}>{e.subject}</span>
                        <span className="shrink-0 text-[9.5px] t-dim2">{e.date}</span>
                        <div className={`shrink-0 flex items-center gap-1 transition-opacity ${i === rowIdx ? "opacity-100" : "opacity-0 group-hover:opacity-100"}`}>
                          <button onClick={(ev) => { ev.stopPropagation(); navigator.clipboard?.writeText(e.shortHash).catch(() => {}); }} className="agx-btn text-[9.5px] px-1.5 py-0.5 rounded" style={{ color: "var(--text2)", border: "1px solid color-mix(in srgb, var(--border) 30%, transparent)" }} title="Copy the sha">copy</button>
                          {/* The point of the reflog: whatever you did, the
                              entry before it is where HEAD was. Reset here is
                              the recovery move, and it is hard by default — the
                              whole reason this list exists. The confirm below
                              is the guard. */}
                          <button onClick={(ev) => { ev.stopPropagation(); resetTo(e.shortHash, "hard"); }} className="agx-btn text-[9.5px] px-1.5 py-0.5 rounded" style={{ color: "var(--warning)", border: "1px solid color-mix(in srgb, var(--warning) 35%, transparent)" }} title={`Reset the current branch to this entry (${e.subject}) — hard, discarding working-tree changes`}>reset here</button>
                        </div>
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
                    <ListToolbar q={q} onQ={(v) => { setQ(v); setRowIdx(0); }} placeholder="Search worktrees by branch or directory…" count={shownWorktrees.length} total={worktrees.length} />
                    {shownWorktrees.map((w, i) => (
                      // Fixed tracks for the directory and the branch so they
                      // line up down the list. With seventeen ticket worktrees
                      // whose names differ in length by thirty characters, a
                      // flex row put every branch chip at a different x and the
                      // eye had nothing to run down.
                      <div key={w.path} onClick={() => setRowIdx(i)} {...rowProps(i === rowIdx)}
                        className="group px-2.5 py-1.5 rounded-md"
                        style={{ ...ROW_GRID, gridTemplateColumns: "14px minmax(0, 14rem) minmax(0, 20rem) 5rem minmax(0, 1fr) auto", ...(i === rowIdx ? rowProps(true).style : { background: w.current ? "color-mix(in srgb, var(--primary) 12%, transparent)" : "transparent" }) }}>
                        <span className="text-center text-[11px]" style={{ color: "var(--primary-hover)" }}>{w.current ? "▸" : ""}</span>
                        <button onClick={() => openWorktree(w)} className="text-[12px] font-medium text-left truncate min-w-0" style={{ color: "var(--text)" }} title={`Open ${w.path}`}>{wtName(w.path)}</button>
                        <span className="text-[10px] px-1.5 py-0.5 rounded truncate min-w-0" style={{ color: "var(--primary-hover)", background: "color-mix(in srgb, var(--primary) 10%, transparent)" }} title={w.branch}>⎇ {w.branch}</span>
                        <span className="text-[9.5px] tabular-nums t-dim2 flex items-center gap-1">
                          {w.head}
                          {w.locked && <span className="text-[10px]" style={{ color: "var(--warning)" }}>locked</span>}</span>
                        {/* Same reading as the repo picker's. It is also the
                            reason the sync button below may be disabled, so it
                            has to be visible on the row that carries it. */}
                        <span className="min-w-0 truncate text-[9.5px] t-dim2 flex items-center gap-1.5" title={w.path}>
                          {!!w.dirty && <span className="shrink-0 text-[10px] tabular-nums" style={{ color: "var(--warning)" }} title={`${w.dirty} uncommitted change${w.dirty === 1 ? "" : "s"} in this checkout`}>●{w.dirty}</span>}
                          <span className="truncate min-w-0">{w.path}</span>
                        </span>
                        <span className="flex items-center justify-end gap-2 whitespace-nowrap">
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
                            {/* Disabled on a dirty checkout, exactly like the
                                header's sync button — syncFromBase refuses to
                                merge over uncommitted work, so an enabled
                                button here could only ever produce an error
                                toast. The header got this right and this row
                                did not, which is worse than either: the same
                                action looked possible in one place and not the
                                other. */}
                            {writeEnabled && (() => {
                              const blocked = !!w.dirty;
                              return (
                                <button
                                  onClick={() => act(() => api.gitSyncBase(w.path, w.base ?? undefined), `merged ${w.base}`, `sync:${w.path}`)}
                                  disabled={busy || blocked}
                                  className="shrink-0 text-[10px] px-1.5 py-0.5 rounded"
                                  style={{ color: "var(--primary-hover)", border: "1px solid color-mix(in srgb, var(--primary) 35%, transparent)", opacity: busy || blocked ? 0.45 : 1 }}
                                  title={blocked
                                    ? `Commit or stash the ${w.dirty} change${w.dirty === 1 ? "" : "s"} in ${wtName(w.path)} first — merging over uncommitted work is how you lose it`
                                    : `Merge ${w.base} into ${w.branch}, in that worktree. A merge, not a rebase — nothing already pushed gets rewritten.`}>
                                  {pending === `sync:${w.path}` ? "syncing…" : "sync"}
                                </button>
                              );
                            })()}
                          </>
                        )}
                        {/* Correcting the base has to be reachable when there
                            is NO gap, which is why this sits outside the chip
                            above. A wrong base almost always reports zero — it
                            named something this branch already contains — so
                            hiding the picker behind "there is a gap" hid it in
                            precisely the case it exists for. Quiet until the
                            row is hovered, because on the rows where the base
                            is right it is one more thing to read. */}
                        {writeEnabled && w.branch !== "(detached)" && (
                          <BasePicker
                            branch={w.branch} base={w.base ?? null} refs={baseRefs}
                            onOpen={loadBaseRefs}
                            onPick={(name) => setBaseFor(w.branch, name)}
                            disabled={busy}
                            label={(w.behindBase ?? 0) > 0 ? "▾" : "base ▾"}
                            title={w.base ? `Measured against ${w.base} — pick a different base` : "No base known for this branch — pick one"}
                            className={`shrink-0 text-[10px] px-1.5 py-0.5 rounded ${(w.behindBase ?? 0) > 0 ? "" : "opacity-0 group-hover:opacity-100"}`}
                            style={{ color: "var(--text3)", border: "1px solid color-mix(in srgb, var(--border) 40%, transparent)" }} />
                        )}
                        {writeEnabled && !w.current && <button onClick={() => removeWorktree(w)} className="shrink-0 text-[10px] opacity-0 group-hover:opacity-100 px-1.5 py-0.5 rounded" style={{ color: "var(--error)" }} title="Remove worktree">remove</button>}
                        </span>
                      </div>
                    ))}
                    {!shownWorktrees.length && <PaneEmpty busy={busyView === "worktrees"} what="worktrees" />}
                  </div>
                )}

                <CommandLog open={logOpen} onClose={() => setLogOpen(false)} />
                <ShortcutBar view={view} logOpen={logOpen} onToggleLog={() => setLogOpen((v) => !v)} editorName={editor?.editor} />
                </>
                )}
                {helpOpen && !inConflict && <HelpSheet view={view} onClose={() => setHelpOpen(false)} />}
                {toast && <div className="absolute bottom-4 left-1/2 -translate-x-1/2 px-3.5 py-2 rounded-lg text-[11px] shadow-xl" style={{ zIndex: 40, background: "var(--bg3)", border: `1px solid ${toast.ok ? "color-mix(in srgb, var(--success) 50%, transparent)" : "color-mix(in srgb, var(--error) 50%, transparent)"}`, color: toast.ok ? "var(--success)" : "var(--error)" }}>{toast.msg}</div>}
      {/* A commit's diff, reusing the full file-changes viewer. Still a modal:
          it's a drill-down from a row you clicked, not a place you navigate
          to — the rail's views are the destinations, this is a detour. */}
      <ChangesModal open={!!commitView} onClose={() => setCommitView(null)} onBack={() => setCommitView(null)} backLabel="Log" presetChanges={commitView?.changes} presetTitle={commitView?.title} />
      {rescue && <RescueModal reports={rescue.reports} progress={rescue.progress} onCancel={() => rescue.resolve(null)} onConfirm={(picked) => rescue.resolve(picked)} />}
      {rebaseBase && (
        <RebaseModal root={root} base={rebaseBase} branch={currentBranchName || branch?.name || "HEAD"}
          onClose={() => setRebaseBase(null)}
          onDone={() => { setRebaseBase(null); reloadGraph(); }} />
      )}
      {compareTarget && (
        <CompareModal root={root} initialBase={compareTarget} onClose={() => setCompareTarget(null)} />
      )}
      {insightsOpen && <InsightsModal root={root} onClose={() => setInsightsOpen(false)} />}
      {blamePath && (
        <BlameModal root={root} path={blamePath.path}
          onClose={() => setBlamePath(null)}
          onOpenCommit={(hash, subject) => { setBlamePath(null); void openCommit(hash, subject); }} />
      )}
      {bisectOpen && (
        <BisectModal root={root} onClose={() => setBisectOpen(false)}
          onReset={() => setBisectOpen(false)}
          onOpenCommit={(hash, subject) => { setBisectOpen(false); void openCommit(hash, subject); }}
          onChanged={() => { loadTree(root); void loadView(); }} />
      )}
      {/* The commit row's right-click menu. The reset it offers is the old
          right-click, kept under its own heading so the cherry-pick actions
          can sit above it without either reading as the other. */}
      {commitMenu && (
        <ContextMenu x={commitMenu.x} y={commitMenu.y} onClose={() => setCommitMenu(null)}>
          <MenuItem onClick={() => { const m = commitMenu; setCommitMenu(null); openCommit(m.hash, m.subject); }}>View diff</MenuItem>
          <MenuItem onClick={() => { navigator.clipboard?.writeText(commitMenu.hash).catch(() => {}); setCommitMenu(null); }}>Copy hash</MenuItem>
          <MenuItem onClick={() => void cherryPickOne(commitMenu.hash)}>Cherry-pick onto this branch</MenuItem>
          <MenuItem onClick={() => void cherryPickOne(commitMenu.hash, true)}>Cherry-pick, stage only</MenuItem>
          <MenuItem onClick={() => void revertOne(commitMenu.hash)}>Revert (new commit undoing it)</MenuItem>
          <MenuItem onClick={() => { const m = commitMenu; setCommitMenu(null); setRebaseBase(m.hash); }}>Rebase from here…</MenuItem>
          <div className="my-0.5 h-px" style={{ background: "color-mix(in srgb, var(--border) 60%, transparent)" }} />
          <MenuItem danger onClick={() => {
            const m = commitMenu;
            setCommitMenu(null);
            void askText({ title: `Reset current branch to ${m.hash}`, input: { label: "Mode — soft, mixed or hard", initial: "mixed" }, confirmLabel: "Reset" })
              .then((mode) => { if (mode === "soft" || mode === "mixed" || mode === "hard") resetTo(m.hash, mode); });
          }}>Reset here…</MenuItem>
        </ContextMenu>
      )}
      {dialog}
    </div>
  );
}
