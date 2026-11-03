import { useEffect, useMemo, useRef, useState } from "react";
import { CHIP, CHIP_SURFACE, CHIP_SURFACE_CLS, INPUT, INPUT_STYLE, EDGE, LINE, ListRow, Button } from "./workspace/Chrome.tsx";
import { ICON } from "../lib/iconSize.ts";
import { BranchIcon, FolderIcon, SearchIcon, WarningIcon } from "../lib/glyphIcons.tsx";
import { pickerBody } from "../lib/gitDialog.ts";
import type { GitRepoRef, GitBranch } from "../../../shared/types.ts";
import { useDismiss } from "../lib/useDismiss.ts";

/**
 * The one control for "which checkout".
 *
 * There were seven of these, written at seven different times, and they had
 * drifted the way separately-maintained things do: two chevron glyphs, five
 * widths (300, 320, 340, 460, 520), three placeholders and one — Tasks — with no
 * filter at all, which is unusable the moment a project has a dozen worktrees.
 * Same question, seven answers, and nothing to learn once that transferred to
 * the next panel.
 *
 * Source control's was the most finished of them, so it is the one this became,
 * comments and all. What each panel still decides for itself is WHICH list it
 * shows and WHAT it does with the answer — this only owns how it looks, how it
 * filters, and how it takes the keyboard.
 *
 * It does NOT own the value. Chat's checkout is where that conversation runs;
 * the docked console's is where you build; Source control's is what you are
 * reading. Those are different questions that happen to share a shape, and the
 * one thing worse than seven pickers is one picker that silently moves four
 * panels at once.
 */

/** The two verbs kept apart, for `branches`. Picking a repo row changes what
 *  you are looking at; picking a branch row runs `git checkout` over the
 *  directory you are standing in. Only Source control passes these, and only
 *  under their own heading. */
export interface CheckoutBranches {
  items: GitBranch[];
  /** Rows go flat while a write is in flight or writes are off entirely. */
  disabled?: boolean;
  onCheckout: (name: string) => void;
  /** Whether a branch's upstream is gone, drawn as a chip. Passed in rather
   *  than computed here: the rule for that lives with the panel that knows what
   *  a track string means. */
  gone?: (b: GitBranch) => boolean;
}

export function CheckoutPicker({
  repos, value, onPick,
  branches, branchLabel, placeholder = "Repo", emptyLabel = "no repos seen yet",
  triggerMaxWidth = 240, disabled, title, onOpenChange, onDismiss, loading, error, onRetry,
}: {
  repos: GitRepoRef[];
  /** The chosen checkout's root. Empty means nothing picked yet. */
  value: string;
  onPick: (root: string) => void;
  branches?: CheckoutBranches;
  /**
   * What to write after the repo name on the trigger.
   *
   * Source control passes its working-tree poll rather than letting the button
   * read the repo list: you switch branch from that very panel, and the list is
   * a cached sweep, so the control at the top went on saying what it said
   * before. `undefined` falls back to the list; `null` draws nothing.
   */
  branchLabel?: string | null;
  placeholder?: string;
  emptyLabel?: string;
  triggerMaxWidth?: number;
  disabled?: boolean;
  title?: string;
  /**
   * The menu opened, or closed.
   *
   * Two callers need it. One refreshes on the way in: the lists go stale — a
   * worktree cut since the view loaded is not in `repos`, and each row's branch
   * is whatever the last sweep saw, which a checkout from this very panel then
   * contradicts — and refreshing on open is what keeps that honest without a
   * poll. The other needs to know the menu HAS the keyboard, because
   * focus-follows-mouse must not drag the cursor back to the shell while
   * somebody is typing into the filter.
   */
  onOpenChange?: (open: boolean) => void;
  /**
   * Called when the menu closes without a pick.
   *
   * The filter input takes the keyboard while it is open, so a panel that was
   * being TYPED INTO — the terminal — has to get the cursor back or the next
   * keystroke lands on `<body>`. Every panel that has nowhere to hand it back
   * to simply omits this.
   */
  onDismiss?: () => void;
  /** The list is still being read: rows are drawn as skeletons. */
  loading?: boolean;
  /** The last refresh failed. Said in a sentence above whatever list there is
   *  (a stale list is kept rather than emptied), with a way to retry. */
  error?: string | null;
  onRetry?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const rowsRef = useRef<HTMLDivElement>(null);

  const close = (dismissed: boolean) => {
    setOpen(false);
    setQuery("");
    onOpenChange?.(false);
    if (dismissed) onDismiss?.();
  };
  useDismiss(open, box, () => close(true));

  const here = repos.find((r) => r.root === value) ?? null;
  /*
   * A value the list does not offer, still shown.
   *
   * A checkout can move, be removed, or fall out of the open project's scope,
   * and some of these values are STORED — a budget is attached to a root, and a
   * chat remembers where it runs. Falling back to the placeholder would read as
   * "everything" or "pick one" while the setting underneath still says
   * something else entirely, so the row is kept, marked, and selectable.
   */
  const unlisted = value && !here ? value : "";
  const leafOf = (p: string) => p.split("/").filter(Boolean).pop() || p;

  /** Path included: a worktree is found by its card id ("20343"), which lives
   *  in the directory name rather than in the project's. */
  const shownRepos = useMemo(() => {
    const q = query.trim().toLowerCase();
    return repos.filter((r) => !q || (r.name + " " + r.branch + " " + r.root).toLowerCase().includes(q));
  }, [repos, query]);

  const shownBranches = useMemo(() => {
    if (!branches) return [];
    const q = query.trim().toLowerCase();
    const checkedOut = new Set(repos.map((r) => r.branch));
    return branches.items
      .filter((b) => !checkedOut.has(b.name) && (!q || b.name.toLowerCase().includes(q)))
      .slice(0, 80);
  }, [branches, repos, query]);

  const body = pickerBody({ loading: !!loading && !repos.length, error: error && !repos.length ? error : null, total: repos.length, shown: shownRepos.length + shownBranches.length, query });

  /** One list for the keyboard, because the cursor crosses the heading between
   *  them and "third row down" has to mean the third row down. */
  const walk = useMemo(
    () => [
      ...shownRepos.map((r) => ({ kind: "repo" as const, key: r.root, run: () => { onPick(r.root); close(false); } })),
      ...shownBranches.map((b) => ({ kind: "branch" as const, key: b.name, run: () => { branches?.onCheckout(b.name); close(false); } })),
    ],
    [shownRepos, shownBranches], // eslint-disable-line react-hooks/exhaustive-deps
  );

  // Opening lands on what is already chosen, so ⏎ straight away is a no-op
  // rather than a jump to whatever happens to be first.
  useEffect(() => {
    if (!open) return;
    const at = shownRepos.findIndex((r) => r.root === value);
    setCursor(at < 0 ? 0 : at);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  // Filtering moves the ground under the cursor — see the branch rows, which
  // rise to meet it as repos drop out — so it is pinned back inside the list.
  useEffect(() => { setCursor((c) => Math.min(c, Math.max(0, walk.length - 1))); }, [walk.length]);

  useEffect(() => {
    if (!open) return;
    rowsRef.current?.querySelector<HTMLElement>("[data-cursor='1']")?.scrollIntoView({ block: "nearest" });
  }, [cursor, open]);

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") { e.preventDefault(); close(true); return; }
    if (e.key === "Enter") { e.preventDefault(); walk[cursor]?.run(); return; }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!walk.length) return;
      setCursor((c) => (c + (e.key === "ArrowDown" ? 1 : -1) + walk.length) % walk.length);
    }
  };

  return (
    <div className="relative" ref={box}>
      {/* One line. A worktree directory carries a whole ticket name, and
          wrapped it made the button two rows tall and shoved whatever sat
          under the header down with it. */}
      <button
        onClick={() => { if (open) { close(true); return; } setOpen(true); onOpenChange?.(true); }}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        /* `CHIP`, the app's one control shape, rather than a pill of its own.
           It is the FIRST control in the view, so its shape is the expectation
           every header sets — and this one was a `rounded-full px-3` where the
           Terminal's and the pull-request panel's were a rounded-lg and a
           rounded-md at three different heights. Reported as "son todos
           diferentes". */
        className={`${CHIP} ${CHIP_SURFACE_CLS} flex items-center gap-1.5 shrink-0 disabled:opacity-50`}
        style={{ maxWidth: triggerMaxWidth, ...CHIP_SURFACE }}
        title={title ?? (here ? `${here.name}\n${here.root}` : unlisted ? `${unlisted}\nnot in the current list` : undefined)}
      >
        <span className="font-medium truncate min-w-0" style={unlisted ? { color: "var(--warning-ink)" } : undefined}>
          {here?.name ?? (unlisted ? leafOf(unlisted) : placeholder)}
        </span>
        {(() => {
          const b = branchLabel === undefined ? here?.branch : branchLabel;
          return b ? <span className="t-dim2 shrink-0 truncate" style={{ maxWidth: "9rem" }} title={`on ${b}`}>· {b}</span> : null;
        })()}
        {/* The same caret `ScopeChip` draws, so the picker in this header and the
            one in every other header are the same object down to the arrow. */}
        <svg width={ICON.xs} height={ICON.xs} viewBox="0 0 12 12" fill="none" aria-hidden
          className="shrink-0" style={{ opacity: 0.7 }}>
          <path d="M3 5l3 3 3-3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open && (
        /* Wide enough for a whole worktree name beside its branch: those are
           the two pieces that tell one checkout from another, and at 320 with
           the branch clipped at 150 they were both cut off on the same row. */
        <div
          className="absolute left-0 mt-1 rounded-xl text-[11px] flex flex-col"
          role="listbox"
          onKeyDown={onKey}
          style={{
            zIndex: 30, background: "var(--surface-card)",
            border: EDGE, boxShadow: "var(--surface-lift), 0 24px 60px -18px rgba(0,0,0,0.5)",
            width: 380, maxWidth: "min(86vw, 760px)", maxHeight: 420, overflow: "hidden",
          }}
        >
          <div className="m-2 shrink-0 relative">
                  <span className="absolute left-2.5 top-1/2 -translate-y-1/2" style={{ color: "var(--text3)" }}><SearchIcon size={ICON.sm} /></span>
                  <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Find a checkout"
              aria-label="Filter checkouts"
              className={`w-full pl-8 pr-16 ${INPUT}`} style={INPUT_STYLE}
            />
                  {body === "rows" && <span className="absolute right-2.5 top-1/2 -translate-y-1/2 tabular-nums text-[10.5px]" style={{ color: "var(--text3)", fontFamily: "var(--font-mono, ui-monospace, monospace)" }}>{shownRepos.length} of {repos.length}</span>}
                </div>
          <div ref={rowsRef} className="agx-scroll overflow-y-auto overflow-x-hidden px-1 pb-1.5" style={{ minHeight: 0 }}>
            {error && (
              <div role="alert" className="mx-2 mb-1.5 flex items-center gap-2.5 rounded-lg px-3 py-2 text-[11.5px]" style={{ color: "var(--error-ink)", background: "color-mix(in srgb, var(--error) 10%, transparent)", border: "1px solid color-mix(in srgb, var(--error) 28%, transparent)" }}>
                <WarningIcon size={ICON.md} /><span className="min-w-0 flex-1">{error}</span>
                {onRetry && <Button size="compact" onClick={onRetry} className="shrink-0">Try again</Button>}
              </div>
            )}
            {body === "loading" && (
              <div role="status" aria-label="Reading checkouts" className="px-2 flex flex-col gap-1.5">
                {[0, 1, 2].map((i) => <div key={i} className="rounded-lg motion-safe:animate-pulse" style={{ height: 40, background: "var(--surface-inset)", opacity: 1 - i * 0.2 }} />)}
              </div>
            )}
            {unlisted && (
              <div className="px-2.5 py-1.5 flex items-center gap-2" style={{ background: "color-mix(in srgb, var(--warning) 10%, transparent)" }}>
                <span className="shrink-0 text-[8.5px] leading-none px-1 py-0.5 rounded" style={{ color: "var(--warning-ink)", border: "1px solid color-mix(in srgb, var(--warning) 40%, transparent)" }}>SET</span>
                <span className="min-w-0 flex-1 truncate" style={{ color: "var(--warning-ink)" }} title={unlisted}>{unlisted}</span>
                <span className="shrink-0 t-dim2 text-[9.5px]">not in this list</span>
              </div>
            )}
            {shownRepos.map((r, i) => (
              <ListRow
                key={r.root}
                role="option"
                aria-selected={r.root === value}
                data-cursor={i === cursor ? "1" : undefined}
                onMouseEnter={() => setCursor(i)}
                onClick={() => { onPick(r.root); close(false); }}
                current={r.root === value}
                hot={i === cursor}
                title={r.worktreeOf ? `${r.branch}\n${r.root}` : r.root}
                /* The tile names the kind outright and reads the same wherever
                   the row lands. It was an indent once, which says nothing as
                   soon as the list is filtered and the parent is off screen. */
                leading={
                  <span className="grid place-items-center rounded-lg"
                    title={r.worktreeOf ? `worktree of ${r.worktreeOf}` : "main checkout"}
                    style={{ width: 28, height: 28, background: "var(--surface-inset)", border: EDGE, color: r.worktreeOf ? "var(--primary-ink)" : "var(--text2)" }}>
                    {r.worktreeOf ? <BranchIcon size={ICON.sm} /> : <FolderIcon size={ICON.sm} />}
                  </span>
                }
                /* A worktree IS its branch — that's the whole point of one per
                   ticket — so the branch is the name and the folder a terse
                   stub of it. A project is the other way round: the folder is
                   the identity and the branch is what happens to be checked
                   out. The folder is shown either way, since a checkout can
                   rename the row otherwise, and a directory's identity must
                   not move under a click. */
                sub={r.worktreeOf ? `worktree · ${r.name}` : `repo · ${r.branch}`}
                trailing={<>
                  {r.dirty > 0 && <span className="text-[10px] tabular-nums" style={{ color: "var(--warning-ink)" }} title={`${r.dirty} changed file${r.dirty === 1 ? "" : "s"}`}>●{r.dirty}</span>}
                  {r.behind > 0 && <span className="text-[10px] tabular-nums" style={{ color: "var(--warning-ink)" }} title={`${r.behind} behind upstream`}>↓{r.behind}</span>}
                  {r.ahead > 0 && <span className="text-[10px] tabular-nums" style={{ color: "var(--success-ink)" }} title={`${r.ahead} ahead of upstream`}>↑{r.ahead}</span>}
                </>}
              >
                {r.worktreeOf ? r.branch : r.name}
              </ListRow>
            ))}

            {shownBranches.length > 0 && (
              <>
                {/* Under their own heading, and last. These are the only rows in
                    this menu that write to disk. */}
                <div className="px-3 pt-2 pb-1 text-[10px] uppercase tracking-wider t-dim2" style={{ borderTop: LINE }}>Branches — checkout here</div>
                {shownBranches.map((b, i) => {
                  const at = shownRepos.length + i;
                  return (
                    <ListRow
                      key={b.name}
                      role="option"
                      aria-selected={false}
                      data-cursor={at === cursor ? "1" : undefined}
                      onMouseEnter={() => setCursor(at)}
                      disabled={branches?.disabled}
                      onClick={() => { branches?.onCheckout(b.name); close(false); }}
                      hot={at === cursor}
                      roomy
                      title={b.name}
                      leading={
                        <span className="grid place-items-center rounded-lg" title="local branch — checked out in the current directory"
                          style={{ width: 28, height: 28, background: "var(--surface-inset)", border: EDGE, color: "var(--text2)" }}><BranchIcon size={ICON.sm} /></span>
                      }
                      trailing={branches?.gone?.(b) ? <span className="text-[10px] px-1 rounded" style={{ color: "var(--error-ink)", background: "color-mix(in srgb, var(--error) 12%, transparent)" }}>gone</span> : null}
                    >
                      {b.name}
                    </ListRow>
                  );
                })}
              </>
            )}

            {body === "empty" && <div className="px-3 py-4 text-center text-[12px] t-dim2">{emptyLabel}</div>}
            {body === "no-match" && walk.length === 0 && (
              <div className="px-3 py-4 text-center text-[12px]" style={{ color: "var(--text3)" }}>
                <div className="font-medium break-all" style={{ color: "var(--text2)" }}>No checkout called “{query.trim()}”</div>
                <div className="mt-0.5">Check the spelling, or clear the search.</div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
