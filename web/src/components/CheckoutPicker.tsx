import { useMemo, useRef, useState } from "react";
import { CHIP, CHIP_SURFACE, CHIP_SURFACE_CLS, EDGE, Button } from "./workspace/Chrome.tsx";
import { ICON } from "../lib/iconSize.ts";
import { BranchIcon, FolderIcon } from "../lib/glyphIcons.tsx";
import { PickerCard, type PickerItem } from "./PickerCard.tsx";
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
  const box = useRef<HTMLDivElement>(null);

  const close = (dismissed: boolean) => {
    setOpen(false);
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

  // One list of rows for the card: checkouts, then the branches that would be
  // checked out here, folded under their own heading (open at first, so the
  // verb that writes to disk is still in plain view).
  const items: PickerItem[] = useMemo(() => {
    const checkedOut = new Set(repos.map((r) => r.branch));
    const rows: PickerItem[] = [];
    if (unlisted) rows.push({
      id: "\u0000unlisted", label: leafOf(unlisted), sub: "set, not in this list", title: unlisted, disabled: true, on: true,
      leading: <span className="shrink-0 text-[8.5px] leading-none px-1 py-0.5 rounded" style={{ color: "var(--warning-ink)", border: "1px solid color-mix(in srgb, var(--warning) 40%, transparent)" }}>SET</span>,
      trailing: <span className="shrink-0 t-dim2 text-[9.5px]">not in this list</span>,
    });
    for (const r of repos) rows.push({
      id: "r:" + r.root, label: r.worktreeOf ? r.branch : r.name, mono: !!r.worktreeOf,
      /* Path in the match: a worktree is found by its card id, which lives in the directory name. */
      sub: (r.worktreeOf ? `worktree · ${r.name}` : `repo · ${r.branch}`) + " " + r.root,
      title: r.worktreeOf ? `${r.branch}\n${r.root}` : r.root,
      leading: (
        <span className="grid place-items-center rounded-lg"
          data-tip={r.worktreeOf ? `worktree of ${r.worktreeOf}` : "main checkout"}
          style={{ width: 28, height: 28, background: "var(--surface-inset)", border: EDGE, color: r.worktreeOf ? "var(--primary-ink)" : "var(--text2)" }}>
          {r.worktreeOf ? <BranchIcon size={ICON.sm} /> : <FolderIcon size={ICON.sm} />}
        </span>),
      trailing: <>
        {r.dirty > 0 && <span className="text-[10px] tabular-nums" style={{ color: "var(--warning-ink)" }} data-tip={`${r.dirty} changed file${r.dirty === 1 ? "" : "s"}`}>●{r.dirty}</span>}
        {r.behind > 0 && <span className="text-[10px] tabular-nums" style={{ color: "var(--warning-ink)" }} data-tip={`${r.behind} behind upstream`}>↓{r.behind}</span>}
        {r.ahead > 0 && <span className="text-[10px] tabular-nums" style={{ color: "var(--success-ink)" }} data-tip={`${r.ahead} ahead of upstream`}>↑{r.ahead}</span>}
      </>,
    });
    if (branches) for (const b of branches.items.filter((x) => !checkedOut.has(x.name)).slice(0, 80)) rows.push({
      id: "b:" + b.name, label: b.name, mono: true, group: "branches", disabled: branches.disabled,
      leading: (
        <span className="grid place-items-center rounded-lg" data-tip="local branch — checked out in the current directory"
          style={{ width: 28, height: 28, background: "var(--surface-inset)", border: EDGE, color: "var(--text2)" }}><BranchIcon size={ICON.sm} /></span>),
      trailing: branches.gone?.(b) ? <span className="text-[10px] px-1 rounded" style={{ color: "var(--error-ink)", background: "color-mix(in srgb, var(--error) 12%, transparent)" }}>gone</span> : null,
    });
    return rows;
  }, [repos, branches, unlisted]); // eslint-disable-line react-hooks/exhaustive-deps
  const currentSet = useMemo(() => new Set(here ? ["r:" + here.root] : []), [here]);
  const pick = (id: string) => {
    if (id.startsWith("r:")) onPick(id.slice(2));
    else if (id.startsWith("b:")) branches?.onCheckout(id.slice(2));
    else return;
    close(false);
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
        data-tip={title ?? (here ? `${here.name}\n${here.root}` : unlisted ? `${unlisted}\nnot in the current list` : undefined)}
      >
        <span className="font-medium truncate min-w-0" style={unlisted ? { color: "var(--warning-ink)" } : undefined}>
          {here?.name ?? (unlisted ? leafOf(unlisted) : placeholder)}
        </span>
        {(() => {
          const b = branchLabel === undefined ? here?.branch : branchLabel;
          return b ? <span className="t-dim2 shrink-0 truncate" style={{ maxWidth: "9rem" }} data-tip={`on ${b}`}>· {b}</span> : null;
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
           the two pieces that tell one checkout from another. */
        <PickerCard
          items={items} current={currentSet} loading={!!loading && !repos.length} error={error && !repos.length ? error : null} onRetry={onRetry}
          groupLabels={(k) => (k === "branches" ? "Branches — checkout here" : k)} defaultOpen={["branches"]}
          onPick={pick} onClose={() => close(true)}
          placeholder="Find a checkout" noun="checkout" emptyText={emptyLabel} width={380}
          style={{ position: "absolute", left: 0, top: "100%", marginTop: 4 }}
          footerNote={error && repos.length ? <span style={{ color: "var(--error-ink)" }}>{error}</span> : undefined}
          footer={error && repos.length && onRetry ? <Button size="compact" onClick={onRetry} className="shrink-0">Try again</Button> : undefined} />
      )}
    </div>
  );
}
