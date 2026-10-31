/*
 * Compare two refs: how far ahead/behind each side is, and the diff between
 * the two tips. A pre-merge look — nothing is moved, staged or written.
 *
 * The two refs pick from the same menu (branches, tags, remotes); the swap
 * button trades them so "which side am I on" is a click, not a re-pick.
 */
import { useEffect, useState } from "react";
import { GitDialog, DialogError, DialogSkeleton } from "./GitDialog.tsx";
import { UNREACHABLE } from "../lib/gitDialog.ts";
import { api } from "../lib/api.ts";
import type { GitFileChange } from "../../../shared/types.ts";
import { SwapIcon } from "../lib/glyphIcons.tsx";
import { ICON } from "../lib/iconSize.ts";
import { Button, CTRL_H, EDGE } from "./workspace/Chrome.tsx";
import { Field, FIELD_SELECT } from "./SettingsKit.tsx";
import { Select } from "./Select.tsx";

import { initialOtherFor, baseOptions } from "../lib/compareSeed.ts";

/** What the server takes for "the working tree" as the other side. */
const WORKTREE = "@worktree";

type CompareResult = {
  ok: boolean;
  ahead?: { hash: string; shortHash: string; subject: string; author: string; date: string; refs: string }[];
  behind?: { hash: string; shortHash: string; subject: string; author: string; date: string; refs: string }[];
  diff?: GitFileChange[];
  error?: string;
};

const CHANGE_STATUS: Record<string, string> = {
  added: "var(--success)",
  deleted: "var(--error)",
  modified: "var(--warning)",
  renamed: "var(--info)",
  untracked: "var(--text3)",
};

export function CompareModal({ root, initialBase, initialOther, against, onClose }: {
  root: string;
  /** The ref the dialog opens on — the branch it was launched from. */
  initialBase: string;
  /** The side to open against — the current branch. Ignored when it is not a
   *  ref in the menu (detached HEAD) or is the base itself. */
  initialOther?: string | null;
  /** Compare the base with the files on disk instead of with a second ref. */
  against?: "worktree";
  onClose: () => void;
}) {
  const [refs, setRefs] = useState<string[]>([]);
  const [base, setBase] = useState(initialBase);
  const toTree = against === "worktree";
  const [other, setOther] = useState(toTree ? WORKTREE : "");
  const [r, setR] = useState<CompareResult | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.gitRefs(root).then((x) => setRefs(x.refs ?? [])).catch(() => {});
  }, [root]);

  // Auto-pick the other side when the menu arrives and nothing is chosen.
  useEffect(() => {
    if (toTree || other || !refs.length) return;
    const firstOther = initialOtherFor(initialOther, base, refs) ?? refs.find((n) => n !== base);
    if (firstOther) setOther(firstOther);
  }, [refs, base, other]);

  const fetch = async (b: string, o: string) => {
    if (!b || !o) return;
    setBusy(true);
    try {
      const x = await api.gitCompare(root, b, o);
      setR(x as CompareResult);
    } catch {
      setR({ ok: false, error: UNREACHABLE });
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => { void fetch(base, other); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [base, other, root]);

  const total = r?.ok
    ? (r.diff ?? []).reduce((n, f) => n + f.additions + f.deletions, 0)
    : 0;

  return (
    <GitDialog title="What differs between the two?" subtitle="Read-only. Nothing is moved, staged or written." tone="primary" width={760}
      cancelLabel="Close" onClose={onClose} initialFocus="none"
      reason={r?.ok && busy ? "Comparing…" : undefined}>
      <div className="flex items-start gap-2">
        <div className="flex-1 min-w-0">
          <Field label="Base" htmlFor="cmp-base" block>
            <Select title="Base" className={FIELD_SELECT} style={{ height: CTRL_H.regular }} value={base} onChange={setBase}
              options={baseOptions(refs, base).map((n) => ({ value: n, label: n }))} />
          </Field>
        </div>
        <Button square label="Swap the two sides" className="mt-6" disabled={toTree} onClick={() => { setBase(other); setOther(base); }}><SwapIcon size={ICON.sm} /></Button>
        <div className="flex-1 min-w-0">
          <Field label="Other" htmlFor="cmp-other" block>
            {toTree
              ? <div className="w-full px-2 py-1.5 rounded-lg text-[11.5px]" style={{ background: "var(--bg3)", border: EDGE, color: "var(--text)" }}>Working tree</div>
              : <Select title="Other" className={FIELD_SELECT} style={{ height: CTRL_H.regular }} value={other} onChange={setOther}
                  options={refs.map((n) => ({ value: n, label: n }))} />}
          </Field>
        </div>
      </div>

      {r?.ok ? (
        <>
          <div className="mt-4 flex items-center gap-3 flex-wrap">
            {!toTree && <>
            <span className="text-[11.5px] px-2 py-1 rounded-lg tabular-nums" style={{ background: "color-mix(in srgb, var(--success) 12%, transparent)", color: "var(--success-ink)" }} title="commits {other} has that {base} doesn't">
              ↑ {r.ahead!.length} ahead
            </span>
            <span className="text-[11.5px] px-2 py-1 rounded-lg tabular-nums" style={{ background: "color-mix(in srgb, var(--warning) 12%, transparent)", color: "var(--warning-ink)" }} title="commits {base} has that {other} doesn't">
              ↓ {r.behind!.length} behind
            </span></>}
            <span className="text-[11px] px-2 py-1 rounded-lg tabular-nums" style={{ background: "color-mix(in srgb, var(--info) 12%, transparent)", color: "var(--info-ink)" }} title="lines changed between the two tips">
              {r.diff!.length} file{r.diff!.length === 1 ? "" : "s"}, {total} line{total === 1 ? "" : "s"}
            </span>
            {busy && <span className="text-[10px] t-dim2 ml-auto">comparing…</span>}
          </div>

          {(r.ahead!.length > 0 || r.behind!.length > 0) && (
            <div className="mt-4">
              <div className="text-[9.5px] uppercase tracking-wider t-dim2 mb-1.5">commits</div>
              <div className="space-y-0.5">
                {r.behind!.map((c) => (
                  <div key={c.hash} className="flex items-center gap-2 px-2 py-1 rounded-md text-[11px]" style={{ background: "color-mix(in srgb, var(--bg3) 45%, transparent)" }}>
                    <span className="shrink-0 text-[9.5px] px-1 py-px rounded" style={{ background: "color-mix(in srgb, var(--warning) 14%, transparent)", color: "var(--warning-ink)" }} title={`{base} has this, {other} doesn't`}>↓</span>
                    <span className="shrink-0 tabular-nums font-mono" style={{ color: "var(--primary-hover)" }}>{c.shortHash}</span>
                    <span className="min-w-0 flex-1 truncate" style={{ color: "var(--text)" }}>{c.subject}</span>
                    <span className="shrink-0 text-[9.5px] t-dim2">{c.author}</span>
                  </div>
                ))}
                {r.ahead!.map((c) => (
                  <div key={c.hash} className="flex items-center gap-2 px-2 py-1 rounded-md text-[11px]" style={{ background: "color-mix(in srgb, var(--bg3) 45%, transparent)" }}>
                    <span className="shrink-0 text-[9.5px] px-1 py-px rounded" style={{ background: "color-mix(in srgb, var(--success) 14%, transparent)", color: "var(--success-ink)" }} title={`{other} has this, {base} doesn't`}>↑</span>
                    <span className="shrink-0 tabular-nums font-mono" style={{ color: "var(--primary-hover)" }}>{c.shortHash}</span>
                    <span className="min-w-0 flex-1 truncate" style={{ color: "var(--text)" }}>{c.subject}</span>
                    <span className="shrink-0 text-[9.5px] t-dim2">{c.author}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {r.diff!.length > 0 && (
            <div className="mt-4">
              <div className="text-[9.5px] uppercase tracking-wider t-dim2 mb-1.5">diff — {base} vs {toTree ? "working tree" : other}</div>
              <div className="space-y-0.5">
                {r.diff!.map((f) => {
                  const rel = f.file_path.replace(root + "/", "");
                  return (
                    <div key={f.file_path} className="flex items-center gap-2 px-2 py-1 rounded-md text-[11px] font-mono" style={{ background: "color-mix(in srgb, var(--bg3) 45%, transparent)" }}>
                      <span className="shrink-0 w-14 text-[9px] uppercase" style={{ color: CHANGE_STATUS[f.status] ?? "var(--text3)" }}>{f.status}</span>
                      <span className="min-w-0 flex-1 truncate" style={{ color: "var(--text)" }}>{rel}</span>
                      <span className="shrink-0 tabular-nums" style={{ color: "var(--success-ink)" }}>+{f.additions}</span>
                      <span className="shrink-0 tabular-nums" style={{ color: "var(--error-ink)" }}>−{f.deletions}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {!r.diff!.length && !r.ahead!.length && !r.behind!.length && (
            <div className="mt-6 text-center text-[11.5px] t-dim2 py-6">{toTree ? "No changes against the working tree." : `Identical — ${base} and ${other} point at the same history.`}</div>
          )}
        </>
      ) : (
        busy && !r ? <DialogSkeleton rows={3} label="Comparing…" />
        : <DialogError message={r?.error || "Pick two refs to compare."} onRetry={r?.error ? () => void fetch(base, other) : undefined} />
      )}
    </GitDialog>
  );
}
