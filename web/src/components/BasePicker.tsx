import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { useCloseWithOwner } from "../lib/layerOwner.ts";
import { Portal } from "./Portal.tsx";
import { BranchIcon, DoneIcon } from "../lib/glyphIcons.tsx";
import { LAYER } from "../lib/layers.ts";
import { PickerCard, type PickerItem } from "./PickerCard.tsx";
import { ICON } from "../lib/iconSize.ts";
import { Button, EDGE } from "./workspace/Chrome.tsx";

/**
 * Pick what a branch is measured and merged against.
 *
 * Git does not record what a branch was cut from, so the app has to work it
 * out: an override, the base its pull request declares, then the shape of
 * history. The first two are exact and the third is a guess — and a guess needs
 * somewhere to be corrected, or a branch measured against the wrong thing stays
 * wrong forever.
 *
 * Reachable even when the branch is level with its base. That is not a detail:
 * a *wrong* base usually reports zero, because the thing it named is one this
 * branch already contains. Hiding the picker behind "there is a gap" hides it
 * in exactly the case you need it — which is what the worktree rows did, where
 * the only affordance lived inside the behind-chip and the behind-chip only
 * appeared when the base was already right.
 *
 * Rendered through a Portal for the same reason `Select` is: the worktree list
 * scrolls and clips, so a list positioned in the normal flow would be cut off
 * by its own container. It flips above the button when there is no room below,
 * because the rows that most need this are the ones at the bottom of a long
 * list.
 */
export type BaseRef = { name: string; remote: boolean };

export function BasePicker({
  branch, base, refs, onOpen, onPick, disabled, label = "▾", title, className, style, error, onRetry,
}: {
  branch: string;
  base: string | null;
  refs: BaseRef[];
  /** Called when the menu opens, so the ref list is fetched on demand rather
   *  than by every row on every render. */
  onOpen: () => void;
  onPick: (name: string) => void;
  disabled?: boolean;
  label?: string;
  title?: string;
  className?: string;
  style?: React.CSSProperties;
  /** The ref list could not be read: said in a sentence, with a way to retry. */
  error?: string | null;
  onRetry?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  useCloseWithOwner(() => setOpen(false), { open, from: btnRef });
  const [pos, setPos] = useState<{ top?: number; bottom?: number; right: number; maxHeight: number }>({ right: 0, maxHeight: 320 });

  useLayoutEffect(() => {
    if (!open || !btnRef.current) return;
    const r = btnRef.current.getBoundingClientRect();
    const below = window.innerHeight - r.bottom - 12;
    const above = r.top - 12;
    // Flip up only when down genuinely does not fit *and* up is roomier —
    // flipping for a few pixels' gain moves the menu somewhere the eye is not.
    const up = below < 220 && above > below;
    setPos({
      top: up ? undefined : r.bottom + 6,
      bottom: up ? window.innerHeight - r.top + 6 : undefined,
      right: Math.max(8, window.innerWidth - r.right),
      maxHeight: Math.max(180, Math.min(340, up ? above : below)),
    });
  }, [open]);

  const close = () => setOpen(false);

  const isTrunk = (n: string) => /(^|\/)(master|main)$/.test(n);
  // The current base sorts first (PickerCard), then the trunk, then the rest as
  // git ordered them (most recent first): `at` carries that rank.
  const items: PickerItem[] = useMemo(() => refs.filter((b) => b.name !== branch).map((b, i, all) => ({
    id: b.name, label: b.name, mono: true, at: isTrunk(b.name) ? all.length + 1 : 0,
    sub: `${b.remote ? "remote" : "local"}${isTrunk(b.name) ? " · trunk" : ""}`,
    leading: (
      <span className="grid place-items-center rounded-lg"
        style={{ width: 28, height: 28, background: "var(--surface-inset)", border: EDGE, color: b.remote ? "var(--info-ink)" : "var(--text2)" }}>
        <BranchIcon size={ICON.sm} />
      </span>),
    trailing: b.name === base ? <span className="grid place-items-center rounded-full" style={{ width: 18, height: 18, background: "var(--primary)", color: "var(--on-primary)" }} data-tip="current base"><DoneIcon size={ICON.xs} /></span> : null,
  })), [refs, branch, base]);
  const currentSet = useMemo(() => new Set(base ? [base] : []), [base]);

  return (
    <>
      <button
        ref={btnRef}
        onClick={(e) => {
          e.stopPropagation(); // rows select on click; opening the menu is not selecting
          if (disabled) return;
          if (open) { close(); return; }
          onOpen();
          setOpen(true);
        }}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={className}
        style={{ ...style, ...(disabled ? { opacity: 0.5 } : null) }}
        data-tip={title ?? (base ? `Measured against ${base} — pick a different base` : "Pick what this branch is measured against")}>
        {label}
      </button>
      <Portal>
        {open && (
            <>
              <div className="fixed inset-0" style={{ zIndex: LAYER.menu - 1 }} onClick={close} />
              <div
                className="fixed" style={{ top: pos.top, bottom: pos.bottom, right: pos.right, zIndex: LAYER.menu }}>
                {/* A real repo has hundreds of refs — this one offers 827 — so
                    the card's search is how the list is usable. */}
                <PickerCard
                  items={items} current={currentSet} loading={!refs.length} error={error} onRetry={onRetry}
                  onPick={(id) => { close(); onPick(id); }} onClose={close}
                  placeholder="Find a branch" noun="branch" room={pos.maxHeight}
                  emptyText="There is no other branch to measure against."
                  style={{ position: "static" }}
                  /* Clearing the override is how you get back to the app's own
                     answer, which is right far more often than not — without
                     it, one correction pins the branch to a hand-picked base
                     for good. The server treats an empty base as `--unset`. */
                  footer={<Button onClick={() => { close(); onPick(""); }} className="shrink-0"
                    title="Forget the override and go back to the base this app works out on its own">Work it out for me</Button>}
                  footerNote={base ? <>now <span className="font-mono">{base}</span></> : "no base set"} />
              </div>
            </>
          )}
      </Portal>
    </>
  );
}
