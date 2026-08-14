/*
 * Resolving a conflict, with nothing else on screen.
 *
 * This replaces a strip of buttons above the ordinary git panel — where you
 * could, mid-merge, still fetch, push, stage an unrelated file, switch branch
 * and write a commit message. Every one of those either fails with a message
 * nobody reads or makes the situation worse, and having them in reach while
 * you concentrate on two versions of the same function is its own kind of
 * hazard. So while git is stopped, this is the whole view.
 *
 * Three things it does that the strip could not:
 *
 *   - it shows the WHOLE file. Two competing fragments with nothing around
 *     them is not enough to choose between them; the code they sit in is the
 *     evidence. Real line numbers, so what is on screen matches what nvim
 *     shows when you jump there.
 *
 *   - it lets you write a third thing. Four fixed sides cover the conflicts
 *     where one branch is simply right, and not the ordinary ones.
 *
 *   - it never commits anything you have not been shown. A merge of four
 *     hundred files carries the three you resolved and the rest you did not,
 *     so the last button opens the list rather than making the commit.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../lib/api.ts";
import { bandLabels, stepLabel } from "../lib/conflictBrief.ts";
import { reviewRows } from "../lib/mergeReview.ts";
import type {
  BlockChoice, ConflictBlock, ConflictFile, GitActionResult, GitFileChange,
  MergeInfo, MergeSessionView,
} from "../../../shared/types.ts";

/** Unchanged lines kept either side of a conflict before the rest is folded.
 *  Twelve is about a function signature plus its opening lines — enough to
 *  know where you are without turning a lockfile into a scroll. */
const CONTEXT = 12;

/** Above this many conflicts the file stops being something you work through
 *  one at a time. Nothing is hidden silently: the screen says so and offers
 *  the two moves that still make sense. */
const TOO_MANY_BLOCKS = 60;

const isEdit = (c: BlockChoice | undefined): c is { edit: string[] } => !!c && typeof c !== "string";

/** What a made choice is called, once the block is folded away. */
function choiceLabel(c: BlockChoice, labels: { ours: string; theirs: string }): string {
  if (isEdit(c)) return c.edit.length ? "written by hand" : "deleted";
  return c === "ours" ? `kept ${labels.ours}`
    : c === "theirs" ? `took ${labels.theirs}`
    : c === "both" ? "kept both"
    : "kept both, theirs first";
}

const KEY_CHOICE: Record<string, BlockChoice> = { "1": "ours", "2": "theirs", "3": "both", "4": "theirs-first" };

/* ------------------------------------------------------------------ pieces */

function Btn({ children, onClick, disabled, tone, title, grow }: {
  children: React.ReactNode; onClick: () => void; disabled?: boolean;
  tone?: "ours" | "theirs" | "danger" | "go" | "quiet"; title?: string; grow?: boolean;
}) {
  const c = tone === "ours" ? "var(--primary-hover)"
    : tone === "theirs" ? "var(--warning)"
    : tone === "danger" ? "var(--error)"
    : tone === "go" ? "var(--success)"
    : "var(--text2)";
  return (
    <button onClick={onClick} disabled={disabled} title={title}
      className={`text-[11px] px-2 py-1 rounded-lg whitespace-nowrap ${grow ? "flex-1" : "shrink-0"}`}
      style={{
        color: c,
        border: `1px solid color-mix(in srgb, ${c} 38%, transparent)`,
        opacity: disabled ? 0.4 : 1,
      }}>{children}</button>
  );
}

/** A key cap, so the shortcut is on the control rather than in a help sheet. */
const Cap = ({ k }: { k: string }) => (
  <span className="tabular-nums mr-1" style={{ fontSize: 8.5, opacity: 0.6 }}>{k}</span>
);

function Line({ n, text, tone }: { n: number; text: string; tone?: "ours" | "theirs" }) {
  return (
    <div className="flex" style={{ whiteSpace: "pre" }}>
      <span className="shrink-0 text-right tabular-nums select-none pr-2"
        style={{ width: "5ch", color: "var(--text3)", opacity: 0.6 }}>{n}</span>
      <span className="pl-2" style={{ color: tone ? "var(--text)" : "var(--text2)" }}>{text || " "}</span>
    </div>
  );
}

/* ------------------------------------------------------------------- screen */

export interface ConflictModeProps {
  root: string;
  branchName: string;
  /** Which two sides git stopped between, read from `.git`. */
  merge: MergeInfo | null;
  /** Absolute paths git has left conflicted, from the panel's own poll. */
  conflicts: string[];
  /** Everything staged for this merge — what the final commit would carry. */
  staged: GitFileChange[];
  busy: boolean;
  writeEnabled: boolean;
  act: (fn: () => Promise<GitActionResult>, okMsg?: string, label?: string) => Promise<boolean>;
  ask: (o: { title: string; body: string; confirmLabel: string; danger?: boolean }) => Promise<boolean>;
  flash: (ok: boolean, msg: string) => void;
  onAskClaude: () => void;
  onAskClaudeTerminal: () => void;
  onOpenEditor: (rel: string, line: number) => void;
}

export function ConflictMode(p: ConflictModeProps) {
  const { root, merge, conflicts, busy, writeEnabled } = p;

  const rels = useMemo(
    () => conflicts.map((f) => (f.startsWith(root) ? f.slice(root.length + 1) : f)),
    [conflicts, root],
  );

  const [session, setSession] = useState<MergeSessionView | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [file, setFile] = useState<ConflictFile | null>(null);
  const [fileErr, setFileErr] = useState<string | null>(null);
  const [picks, setPicks] = useState<Record<number, BlockChoice>>({});
  const [editing, setEditing] = useState<{ index: number; text: string } | null>(null);
  const [opened, setOpened] = useState<Set<number>>(new Set());
  const [cursor, setCursor] = useState(0);
  const [saving, setSaving] = useState(false);
  const [review, setReview] = useState(false);
  const frame = useRef<HTMLDivElement>(null);

  const labels = bandLabels(merge, p.branchName);
  const step = stepLabel(merge);
  /** Both refs fit on a button, or neither does — see the whole-file pair. */
  const shortSides = labels.ours.length <= 14 && labels.theirs.length <= 14;

  /* The record of what this stop conflicted. Polled with the conflict list
     because git forgets the set as soon as a file is staged, and the counter
     below is built entirely from it. */
  useEffect(() => {
    let dead = false;
    api.gitMergeSession(root).then((s) => { if (!dead) setSession(s.ok ? s : null); }).catch(() => {});
    return () => { dead = true; };
  }, [root, conflicts.length]);

  /* Land on something. The first file still conflicted, and only when nothing
     is chosen — reselecting under somebody mid-edit would be worse than not
     selecting at all. */
  useEffect(() => {
    if (sel && rels.includes(sel)) return;
    setSel(rels[0] ?? null);
  }, [rels, sel]);

  const load = useCallback(async (rel: string) => {
    setFile(null); setFileErr(null); setPicks({}); setEditing(null); setOpened(new Set()); setCursor(0);
    const r = await api.gitConflictFile(root, rel);
    if (!r.ok) { setFileErr(r.error || "cannot read that file"); return; }
    setFile(r);
  }, [root]);

  useEffect(() => { if (sel) void load(sel); }, [sel, load]);
  useEffect(() => { frame.current?.focus(); }, []);

  const blocks = file?.blocks ?? [];
  const answered = blocks.filter((b) => picks[b.index] !== undefined).length;
  const allAnswered = blocks.length > 0 && answered === blocks.length;

  /* The counter, from the record rather than from git. Reload halfway through
     and git can only say how many are LEFT; how many there were is the part it
     throws away. */
  const total = session?.files.length ?? rels.length;
  /** Files the merge brings that nobody had to decide. Counted the same way
   *  the review counts them, so the two never disagree. */
  const clean = reviewRows(root, session?.files ?? [], p.staged).filter((r) => !r.decided).length;
  const left = session?.left.length ?? rels.length;
  const done = Math.max(0, total - left);

  const pick = (index: number, c: BlockChoice) => {
    setPicks((prev) => ({ ...prev, [index]: c }));
    setEditing(null);
    const next = blocks.findIndex((b, i) => i > cursor && picks[b.index] === undefined && b.index !== index);
    if (next >= 0) setCursor(next);
  };

  const startEdit = (b: ConflictBlock) => {
    const cur = picks[b.index];
    setEditing({ index: b.index, text: isEdit(cur) ? cur.edit.join("\n") : b.ours.join("\n") });
  };

  /** Write every decision at once, and stage the file. The stamp goes with it,
   *  so a file something else rewrote in the meantime is refused rather than
   *  resolved against a parse that no longer exists. */
  const apply = async () => {
    if (!sel || !file || !allAnswered) return;
    setSaving(true);
    try {
      const list = blocks.map((b) => picks[b.index]!);
      const ok = await p.act(() => api.gitResolveBlocks(root, sel, list, file.stamp), `${sel} resolved`);
      if (ok) {
        const s = await api.gitMergeSession(root);
        if (s.ok) setSession(s);
      }
    } finally { setSaving(false); }
  };

  const wholeFile = async (side: "ours" | "theirs") => {
    if (!sel) return;
    const b = blocks.length;
    const drops = side === "ours"
      ? blocks.reduce((n, x) => n + x.theirs.length, 0)
      : blocks.reduce((n, x) => n + x.ours.length, 0);
    const other = side === "ours" ? labels.theirs : labels.ours;
    if (b > 1 && !(await p.ask({
      title: `Take ${side === "ours" ? labels.ours : labels.theirs} for the whole of ${sel}?`,
      body: `That answers all ${b} conflicts the same way and drops ${drops} line${drops === 1 ? "" : "s"} from ${other}. If the conflicts are about different things, this loses the ones you did not mean to decide.`,
      confirmLabel: `Take ${side}`,
    }))) return;
    if (await p.act(() => api.gitResolve(root, [sel], side), `${sel}: kept ${side}`)) {
      const s = await api.gitMergeSession(root);
      if (s.ok) setSession(s);
    }
  };

  const reopen = async (rel: string) => {
    const mine = session?.mine.includes(rel);
    if (!(await p.ask({
      title: `Put the conflict in ${rel} back?`,
      danger: true,
      body: mine
        ? "This throws away how it was resolved and restores git's original markers. There is no undo for the resolution."
        : "This file was resolved outside this panel — by an agent, an editor, or by hand. Putting the conflict back deletes that work, and this panel cannot show you what it was. Open the file first if you are not sure.",
      confirmLabel: "Put the conflict back",
    }))) return;
    if (await p.act(() => api.gitReopenConflict(root, rel, true), `${rel} is conflicted again`)) {
      const s = await api.gitMergeSession(root);
      if (s.ok) setSession(s);
      setSel(rel);
    }
  };

  /* --------------------------------------------------------------- keyboard */

  const onKey = (e: React.KeyboardEvent) => {
    const el = e.target as HTMLElement | null;
    if (/input|textarea|select/i.test(el?.tagName ?? "") || el?.isContentEditable) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const b = blocks[cursor];
    if (!b) return;
    const c = KEY_CHOICE[e.key];
    if (c) { e.preventDefault(); pick(b.index, c); return; }
    if (e.key === "e") { e.preventDefault(); startEdit(b); return; }
    if (e.key === "n" || e.key === "j") { e.preventDefault(); setCursor((i) => Math.min(blocks.length - 1, i + 1)); }
    if (e.key === "p" || e.key === "k") { e.preventDefault(); setCursor((i) => Math.max(0, i - 1)); }
  };

  /*
   * Leave the review when the operation moves on.
   *
   * A rebase continues INTO the next commit, so the screen that was reviewing
   * commit 1 was still up when commit 2 stopped — showing its freshly
   * conflicted file as something you had already decided, with a commit button
   * under it. Found by driving a three-commit rebase; the state simply never
   * had a reason to reset.
   */
  const op = session?.op ?? "";
  useEffect(() => { setReview(false); }, [op]);

  /* ------------------------------------------------------------------ views */

  // Belt as well as braces: the review is only ever about a merge with nothing
  // left to decide, so it cannot be reached — or lingered in — while files are
  // still conflicted, whatever else changed underneath.
  if (review && left === 0) {
    return (
      <Review
        {...p}
        files={(session?.files ?? []).filter((f) => !(session?.left ?? []).includes(f))}
        step={step}
        onBack={() => setReview(false)}
      />
    );
  }

  const tooMany = blocks.length > TOO_MANY_BLOCKS;

  return (
    <div ref={frame} tabIndex={-1} onKeyDown={onKey}
      className="flex-1 min-h-0 flex flex-col outline-none">

      {/* Who is merging into what. Read from .git, not deduced from the
          checkout's base — that deduction names the wrong branch for any merge
          that is not of your own base, and the wrong commit for every rebase. */}
      <div className="shrink-0 px-4 py-2 border-b flex items-center gap-3 flex-wrap"
        style={{ borderColor: "color-mix(in srgb, var(--border) 45%, transparent)", background: "var(--bg2)" }}>
        <span className="text-[11px] font-semibold" style={{ color: "var(--warning)" }}>
          {merge?.state === "rebasing" ? "Rebasing" : merge?.state === "cherry-picking" ? "Cherry-picking"
            : merge?.state === "reverting" ? "Reverting" : "Merging"}
        </span>
        <span className="text-[11px] font-mono truncate" style={{ color: "var(--primary-hover)" }}>{labels.ours}</span>
        <span className="text-[10px]" style={{ color: "var(--text3)" }}>◀ incoming</span>
        <span className="text-[11px] font-mono truncate" style={{ color: "var(--warning)" }}>{labels.theirs}</span>
        {step && (
          <span className="text-[10px] px-1.5 py-0.5 rounded" style={{ color: "var(--text2)", border: "1px solid color-mix(in srgb, var(--border) 40%, transparent)" }}
            title="A rebase replays your commits one at a time and stops on each one that conflicts. It is not over when this file is.">{step}</span>
        )}
        <span className="ml-auto text-[11px] tabular-nums" style={{ color: "var(--text2)" }}>
          <b style={{ color: "var(--text)" }}>{done}</b> of <b style={{ color: "var(--text)" }}>{total}</b> file{total === 1 ? "" : "s"} resolved
        </span>
      </div>

      <div className="flex-1 min-h-0 flex">

        {/* The files, and only the files. What entered cleanly is a line at the
            bottom, not four hundred rows to scroll past. */}
        <div className="shrink-0 flex flex-col border-r" style={{ width: 236, borderColor: "color-mix(in srgb, var(--border) 45%, transparent)", background: "var(--bg2)" }}>
          <div className="px-3 pt-2.5 pb-1.5 text-[10px] tracking-[0.14em] uppercase" style={{ color: "var(--text3)" }}>In conflict</div>
          <div className="agx-scroll overflow-y-auto flex-1 min-h-0">
            {(session?.files.length ? session.files : rels).map((rel) => {
              const isLeft = rels.includes(rel);
              const on = rel === sel;
              return (
                <div key={rel} className="group flex items-center gap-1.5 px-3 py-1 text-[11px]"
                  style={{ background: on ? "var(--bg3)" : "transparent", borderLeft: `2px solid ${on ? "var(--primary)" : "transparent"}` }}>
                  <span className="shrink-0 w-[1ch]" style={{ color: isLeft ? "var(--text3)" : "var(--success)" }}>{isLeft ? (on ? "●" : "○") : "✓"}</span>
                  <button onClick={() => setSel(rel)} className="min-w-0 flex-1 truncate text-left font-mono"
                    style={{ color: on ? "var(--text)" : "var(--text2)", direction: "rtl", textAlign: "left" }}
                    title={rel}>{rel}</button>
                  {on && !!blocks.length && (
                    <span className="shrink-0 tabular-nums text-[9.5px]" style={{ color: "var(--text3)" }}>{answered}/{blocks.length}</span>
                  )}
                  {!isLeft && (
                    <button onClick={() => void reopen(rel)} disabled={busy || !writeEnabled}
                      className="shrink-0 text-[10px] opacity-0 group-hover:opacity-100 px-1 rounded"
                      style={{ color: "var(--error)" }}
                      title="Put git's original conflict back. This deletes the resolution.">undo</button>
                  )}
                </div>
              );
            })}
          </div>
          {/* Everything else this merge carries. Named, because the last button
              commits it and a number you were never shown is not consent. */}
          <button onClick={() => setReview(true)}
            className="shrink-0 text-left px-3 py-2 border-t text-[10.5px] leading-snug"
            style={{ borderColor: "color-mix(in srgb, var(--border) 45%, transparent)", color: "var(--text3)" }}>
            <b style={{ color: "var(--text2)" }}>{clean} more file{clean === 1 ? "" : "s"}</b> come in with
            this merge without conflicting.<br />
            <span style={{ textDecoration: "underline", textUnderlineOffset: 2 }}>Review them →</span>
          </button>
        </div>

        {/* The file itself. */}
        <div className="flex-1 min-w-0 flex flex-col">
          <div className="shrink-0 flex items-center gap-2.5 px-3 py-1.5 border-b text-[11px]"
            style={{ borderColor: "color-mix(in srgb, var(--border) 45%, transparent)" }}>
            <span className="font-mono truncate" style={{ color: "var(--text)" }}>{sel ?? "—"}</span>
            {file && <span style={{ color: "var(--text3)" }}>{blocks.length} conflict{blocks.length === 1 ? "" : "s"} · {file.lines} lines</span>}
            {/* Both or neither. Naming one side by its branch and the other by
                the word — which is what happened when only one ref was short
                enough to fit — reads as two different kinds of control. */}
            <div className="ml-auto flex items-center gap-1.5">
              <Btn tone="quiet" onClick={() => void wholeFile("ours")} disabled={busy || !sel}
                title={`Answer every conflict in this file with ${labels.ours}`}>all {shortSides ? labels.ours : "ours"}</Btn>
              <Btn tone="quiet" onClick={() => void wholeFile("theirs")} disabled={busy || !sel}
                title={`Answer every conflict in this file with ${labels.theirs}`}>all {shortSides ? labels.theirs : "theirs"}</Btn>
              <Btn tone="quiet" onClick={() => sel && p.onOpenEditor(sel, blocks[cursor]?.line ?? 1)} disabled={!sel}
                title="Open this file in your editor, at this conflict">▸_ editor</Btn>
            </div>
          </div>

          <div className="flex-1 min-h-0 overflow-auto agx-scroll font-mono text-[11.5px]" style={{ lineHeight: 1.7 }}>
            {fileErr && (
              <div className="m-3 px-3 py-2 rounded-lg text-[11px]" style={{ color: "var(--error)", border: "1px solid color-mix(in srgb, var(--error) 35%, transparent)" }}>
                {fileErr}
                <div className="mt-1.5" style={{ color: "var(--text3)" }}>
                  Take one side for the whole file with the buttons above, or open it in your editor.
                </div>
              </div>
            )}
            {!fileErr && !file && sel && <div className="px-4 py-3 text-[11px]" style={{ color: "var(--text3)" }}>reading {sel}…</div>}
            {file && !blocks.length && (
              <div className="m-3 px-3 py-2 rounded-lg text-[11px]" style={{ color: "var(--text2)", border: "1px solid color-mix(in srgb, var(--border) 40%, transparent)" }}>
                Nothing is conflicted in this file any more — something else resolved it.
                <div className="mt-1.5">
                  <Btn tone="go" onClick={() => void p.act(() => api.gitResolve(root, [sel!], "ours"), `${sel} staged`)} disabled={busy}>Mark it resolved</Btn>
                </div>
              </div>
            )}
            {file && tooMany && (
              <div className="m-3 px-3 py-2 rounded-lg text-[11px]" style={{ color: "var(--text2)", border: "1px solid color-mix(in srgb, var(--warning) 35%, transparent)" }}>
                <b style={{ color: "var(--warning)" }}>{blocks.length} conflicts in one file.</b> Working through them one at a time here
                would take longer than it is worth — this is usually a lockfile or something generated, where one side is simply right.
                Take a side for the whole file above, or open it in your editor.
              </div>
            )}
            {file && !tooMany && (
              <Body
                file={file} picks={picks} labels={labels} cursor={cursor} opened={opened}
                editing={editing}
                onCursor={setCursor}
                onPick={pick}
                onEdit={startEdit}
                onEditText={(t) => setEditing((e) => (e ? { ...e, text: t } : e))}
                onEditDone={(save) => {
                  if (editing && save) pick(editing.index, { edit: editing.text === "" ? [] : editing.text.split("\n") });
                  else setEditing(null);
                }}
                onOpenFold={(i) => setOpened((s) => new Set(s).add(i))}
              />
            )}
          </div>

          {/* Applying is one action for the whole file: every block is written
              at once against the parse they were chosen from. */}
          {file && !!blocks.length && !tooMany && (
            <div className="shrink-0 px-3 py-2 border-t flex items-center gap-2 text-[11px]"
              style={{ borderColor: "color-mix(in srgb, var(--border) 45%, transparent)" }}>
              <span style={{ color: "var(--text3)" }}>{answered} of {blocks.length} conflict{blocks.length === 1 ? "" : "s"} in this file answered</span>
              <div className="ml-auto flex items-center gap-2">
                <Btn tone="go" onClick={() => void apply()} disabled={!allAnswered || saving || busy || !writeEnabled}
                  title={allAnswered ? "Write every choice and stage the file" : "Answer every conflict first"}>
                  {saving ? "writing…" : `Resolve ${sel?.split("/").pop() ?? "file"}`}
                </Btn>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* The ways out. Abort is always here and always first: it is the only
          move that is guaranteed safe. */}
      <div className="shrink-0 px-3 py-2 border-t flex items-center gap-2"
        style={{ borderColor: "color-mix(in srgb, var(--border) 45%, transparent)", background: "var(--bg2)" }}>
        <Btn tone="danger" disabled={busy}
          onClick={async () => {
            if (!(await p.ask({
              title: `Abandon this ${merge?.state === "rebasing" ? "rebase" : "merge"}?`,
              body: "The tree goes back to exactly how it was. Every resolution made here is lost.",
              danger: true, confirmLabel: "Abandon it",
            }))) return;
            void p.act(() => api.gitMergeAbort(root), "merge aborted", "abort");
          }}
          title="Throw it away and put the tree back exactly as it was">Abandon</Btn>
        {/*
          * One action, two places — and they used to read as two unrelated
          * buttons, which is why "Hand to Claude" and "In a terminal" both got
          * pressed to find out what the difference was.
          *
          * The terminal is the one that leads. It gives you the session itself,
          * attached, beside your own shells, where you can watch it edit and
          * take the keyboard off it. The chat pane renders from a transcript
          * and shows you less; it stays because sometimes that is what you
          * want, not because it is an equal choice.
          */}
        <span className="text-[10.5px] ml-1" style={{ color: "var(--text3)" }}>Hand it to Claude</span>
        <Btn tone="ours" onClick={p.onAskClaudeTerminal}
          title="Opens a tmux window in this repo with Claude on it, told which side is which and which files are in conflict">▸_ in a terminal</Btn>
        <button onClick={p.onAskClaude}
          className="text-[10.5px] px-1 shrink-0"
          style={{ color: "var(--text3)", textDecoration: "underline", textUnderlineOffset: 3 }}
          title="The same handoff in the chat pane instead — it renders from the transcript, so you see less of what it is doing">in the chat</button>
        <div className="ml-auto flex items-center gap-2">
          {left > 0
            ? <span className="text-[10.5px]" style={{ color: "var(--text3)" }}>{left} file{left === 1 ? "" : "s"} still to resolve</span>
            : <span className="text-[10.5px]" style={{ color: "var(--success)" }}>every conflict answered</span>}
          <Btn tone="go" disabled={left > 0 || busy || !writeEnabled} onClick={() => setReview(true)}
            title={left > 0 ? "Resolve every file first" : "See everything this commit would carry, then commit"}>
            Review and {merge?.state === "rebasing" ? "continue" : "commit"}{step ? ` — ${step}` : ""}
          </Btn>
        </div>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- the file */

/**
 * The file, with the runs far from any conflict folded.
 *
 * Not virtualization. `useIncremental` in this codebase rejects windowed
 * rendering on purpose, and it is the wrong shape here anyway: what makes a
 * 4000-line lockfile unreadable is not the DOM, it is that 3900 of those lines
 * are irrelevant. Twelve lines of context each side is what you need to judge
 * a conflict; the rest is one row saying how much was skipped, and it opens.
 */
function Body({ file, picks, labels, cursor, opened, editing, onCursor, onPick, onEdit, onEditText, onEditDone, onOpenFold }: {
  file: ConflictFile;
  picks: Record<number, BlockChoice>;
  labels: { ours: string; theirs: string };
  cursor: number;
  opened: Set<number>;
  editing: { index: number; text: string } | null;
  onCursor: (i: number) => void;
  onPick: (index: number, c: BlockChoice) => void;
  onEdit: (b: ConflictBlock) => void;
  onEditText: (t: string) => void;
  onEditDone: (save: boolean) => void;
  onOpenFold: (i: number) => void;
}) {
  const at = new Map(file.blocks.map((b) => [b.index, b]));
  const order = file.blocks.map((b) => b.index);

  return (
    /*
     * One width for the whole file, and it is the longest line in it.
     *
     * The lines are `white-space: pre`, so a long one scrolls this pane
     * sideways — and everything painted here (an ours/theirs tint, the taken
     * side's green bar, the cursor rail) is a plain block, which is as wide as
     * the pane and not as wide as what the pane can scroll to. Scroll right and
     * the tint ends mid-air over code that is still conflicted. Same shape of
     * bug as the diff panes; same fix.
     */
    <div className="py-2" style={{ width: "max-content", minWidth: "100%" }}>
      {file.segments.map((seg, i) => {
        if (seg.kind === "text") {
          const prevIsConflict = i > 0;
          const nextIsConflict = i < file.segments.length - 1;
          const head = prevIsConflict ? CONTEXT : 0;
          const tail = nextIsConflict ? CONTEXT : 0;
          const hidden = seg.lines.length - head - tail;
          if (opened.has(i) || hidden <= 1) {
            return <div key={i}>{seg.lines.map((l, k) => <Line key={k} n={seg.from + k} text={l} />)}</div>;
          }
          return (
            <div key={i}>
              {seg.lines.slice(0, head).map((l, k) => <Line key={k} n={seg.from + k} text={l} />)}
              <button onClick={() => onOpenFold(i)}
                className="w-full text-left px-[5ch] py-1 text-[10.5px]"
                style={{ color: "var(--text3)", background: "color-mix(in srgb, var(--bg3) 45%, transparent)" }}>
                ⋯ {hidden} unchanged lines
              </button>
              {tail > 0 && seg.lines.slice(seg.lines.length - tail).map((l, k) => (
                <Line key={`t${k}`} n={seg.from + seg.lines.length - tail + k} text={l} />
              ))}
            </div>
          );
        }

        const b = at.get(seg.index);
        if (!b) return null;
        const chosen = picks[b.index];
        const isCursor = order[cursor] === b.index;

        if (chosen !== undefined && editing?.index !== b.index) {
          return (
            <button key={i} onClick={() => onPick(b.index, chosen)} onDoubleClick={() => onEdit(b)}
              className="w-full text-left my-1 px-[5ch] py-1 text-[10.5px] flex items-center gap-2"
              style={{ color: "var(--text3)", background: "color-mix(in srgb, var(--success) 7%, transparent)", borderLeft: "2px solid color-mix(in srgb, var(--success) 55%, transparent)" }}>
              <span style={{ color: "var(--success)" }}>✓</span>
              <span>line {b.line} — {choiceLabel(chosen, labels)}</span>
              <span className="ml-auto" style={{ textDecoration: "underline", textUnderlineOffset: 2 }}>change</span>
            </button>
          );
        }

        return (
          <div key={i} onMouseEnter={() => onCursor(order.indexOf(b.index))}
            style={isCursor ? { boxShadow: "inset 2px 0 0 var(--primary)" } : undefined}>

            <div className="px-[5ch] pt-1 text-[9.5px] tracking-wider uppercase" style={{ color: "var(--primary-hover)" }}>
              ours · {labels.ours}
            </div>
            <div style={{ background: "color-mix(in srgb, var(--primary) 8%, transparent)", borderLeft: "2px solid color-mix(in srgb, var(--primary) 55%, transparent)" }}>
              {b.ours.map((l, k) => <Line key={k} n={(b.ourLine ?? b.line + 1) + k} text={l} tone="ours" />)}
            </div>

            {b.base && (
              <>
                <div className="px-[5ch] pt-1 text-[9.5px] tracking-wider uppercase" style={{ color: "var(--text3)" }}>before either change</div>
                <div style={{ background: "color-mix(in srgb, var(--bg3) 40%, transparent)", borderLeft: "2px solid color-mix(in srgb, var(--border) 55%, transparent)" }}>
                  {b.base.map((l, k) => <Line key={k} n={(b.ourLine ?? 0) + b.ours.length + 1 + k} text={l} />)}
                </div>
              </>
            )}

            <div className="px-[5ch] pt-1 text-[9.5px] tracking-wider uppercase" style={{ color: "var(--warning)" }}>
              theirs · {labels.theirs}
            </div>
            <div style={{ background: "color-mix(in srgb, var(--warning) 8%, transparent)", borderLeft: "2px solid color-mix(in srgb, var(--warning) 55%, transparent)" }}>
              {b.theirs.map((l, k) => <Line key={k} n={(b.theirLine ?? b.line + 1) + k} text={l} tone="theirs" />)}
            </div>

            {editing?.index === b.index ? (
              <div className="px-[5ch] py-2 flex flex-col gap-1.5">
                <textarea autoFocus value={editing.text} onChange={(e) => onEditText(e.target.value)}
                  spellCheck={false} rows={Math.min(20, Math.max(3, editing.text.split("\n").length + 1))}
                  className="w-full rounded-lg px-2 py-1.5 text-[11.5px] font-mono outline-none"
                  style={{ background: "var(--bg)", border: "1px solid color-mix(in srgb, var(--primary) 45%, transparent)", color: "var(--text)", lineHeight: 1.7 }} />
                <div className="flex items-center gap-2">
                  <Btn tone="go" onClick={() => onEditDone(true)}>Use this</Btn>
                  <Btn tone="quiet" onClick={() => onEditDone(false)}>Cancel</Btn>
                  <span className="text-[10px]" style={{ color: "var(--text3)" }}>
                    Empty deletes the whole region. Conflict markers are refused.
                  </span>
                </div>
              </div>
            ) : (
              <div className="px-[5ch] py-1.5 flex items-center gap-1.5 flex-wrap">
                <Btn tone="ours" onClick={() => onPick(b.index, "ours")}><Cap k="1" />Keep ours</Btn>
                <Btn tone="theirs" onClick={() => onPick(b.index, "theirs")}><Cap k="2" />Take theirs</Btn>
                <Btn tone="quiet" onClick={() => onPick(b.index, "both")}><Cap k="3" />Both</Btn>
                <Btn tone="quiet" onClick={() => onPick(b.index, "theirs-first")}><Cap k="4" />Both ⇅</Btn>
                <Btn tone="quiet" onClick={() => onEdit(b)}><Cap k="e" />Write it myself</Btn>
                {isCursor && <span className="text-[10px] ml-1" style={{ color: "var(--text3)" }}>n · p to move</span>}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/* -------------------------------------------------------------- the review */

/**
 * What the commit would actually carry.
 *
 * The screen hides the changes list while you resolve, which is right — and it
 * would be indefensible to then offer a button that commits four hundred files
 * you were never shown. So the last action is not the commit; it is this, and
 * the commit is confirmed from here. The conflicted files are pinned to the
 * top because they are the ones a human decided.
 */
function Review({ root, staged, files, busy, writeEnabled, act, ask, merge, step, onBack }: {
  root: string;
  staged: GitFileChange[];
  files: string[];
  busy: boolean;
  writeEnabled: boolean;
  act: ConflictModeProps["act"];
  ask: ConflictModeProps["ask"];
  merge: MergeInfo | null;
  step: string | null;
  onBack: () => void;
}) {
  const rows = reviewRows(root, files, staged);
  const rebase = merge?.state === "rebasing";

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="shrink-0 px-4 py-2 border-b flex items-center gap-3"
        style={{ borderColor: "color-mix(in srgb, var(--border) 45%, transparent)", background: "var(--bg2)" }}>
        <button onClick={onBack} className="text-[11px]" style={{ color: "var(--text2)" }}>← Back to the conflicts</button>
        <span className="text-[11px] font-semibold ml-2" style={{ color: "var(--text)" }}>
          What this {rebase ? "commit" : "merge"} carries
        </span>
        <span className="ml-auto text-[11px] tabular-nums" style={{ color: "var(--text2)" }}>{rows.length} files</span>
      </div>

      <div className="flex-1 min-h-0 overflow-auto agx-scroll py-1">
        {rows.map((r) => (
          <div key={r.path} className="flex items-center gap-2 px-4 py-1 text-[11px] font-mono">
            <span className="shrink-0 w-[1ch]" style={{ color: r.decided ? "var(--warning)" : "var(--text3)" }}>{r.decided ? "◆" : "·"}</span>
            <span className="min-w-0 truncate" style={{ color: r.decided ? "var(--text)" : "var(--text2)" }}>{r.path}</span>
            {r.decided && <span className="shrink-0 text-[10px] px-1 rounded" style={{ color: "var(--warning)", border: "1px solid color-mix(in srgb, var(--warning) 35%, transparent)" }}>you decided this</span>}
            <span className="ml-auto shrink-0 tabular-nums text-[10px]" style={{ color: "var(--text3)" }}>
              {r.change
                ? <><span style={{ color: "var(--success)" }}>+{r.change.additions ?? 0}</span> <span style={{ color: "var(--error)" }}>−{r.change.deletions ?? 0}</span></>
                /* Resolved to exactly what this branch already had, so it adds
                   nothing to the tree. Still a decision, and still in the
                   commit — saying "no change" beats leaving it off the list. */
                : <span title="You resolved it to what this branch already had, so it changes nothing">unchanged</span>}
            </span>
          </div>
        ))}
        {!rows.length && <div className="px-4 py-3 text-[11px]" style={{ color: "var(--text3)" }}>nothing staged</div>}
      </div>

      <div className="shrink-0 px-3 py-2 border-t flex items-center gap-2"
        style={{ borderColor: "color-mix(in srgb, var(--border) 45%, transparent)", background: "var(--bg2)" }}>
        <span className="text-[10.5px]" style={{ color: "var(--text3)" }}>
          {files.length} of these you decided; the other {Math.max(0, rows.length - files.length)} git merged on its own.
          {step && ` This is ${step} — the ${rebase ? "rebase" : "operation"} continues after it.`}
        </span>
        <div className="ml-auto">
          <Btn tone="go" disabled={busy || !writeEnabled}
            onClick={async () => {
              if (!(await ask({
                title: rebase ? `Continue the rebase?` : `Commit this merge?`,
                body: `${rows.length} file${rows.length === 1 ? "" : "s"} go in.${step ? ` This is ${step}; the rebase will stop again if a later commit conflicts.` : ""}`,
                confirmLabel: rebase ? "Continue" : "Commit the merge",
              }))) return;
              void act(() => api.gitMergeContinue(root), rebase ? "rebase continued" : "merge committed", "continue");
            }}>
            {rebase ? "Continue the rebase" : "Commit the merge"}
          </Btn>
        </div>
      </div>
    </div>
  );
}
