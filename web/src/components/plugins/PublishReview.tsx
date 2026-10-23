import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../../lib/api.ts";
import { ago } from "../../lib/fileRecents.ts";
import { openExternal } from "../../lib/externalUrl.ts";
import { ICON } from "../../lib/iconSize.ts";
import {
  NOTHING_LEAVES_WARNING, NOTHING_OPEN_WARNING, PREVIEW_CARD_LINE, PREVIEW_TABS, allTicked, canPost, charCounter, freshOptions, optionRows, postLabel, publishAllOptions, publishButtonState,
  readPreviewTab, rememberPreviewTab,
  type PreviewTab, type PublishButtonState,
} from "../../lib/publishReview.ts";
import type { HeadRead } from "../../../../shared/headCompare.ts";
import type { PublishOptions } from "../../../../shared/reviewPublish.ts";
import { Portal } from "../Portal.tsx";
import { Md, MD_CSS } from "../PrPanel.tsx";
import { Button, CTRL_H, EDGE, LINE, Tabs, tintEdge } from "../workspace/Chrome.tsx";
import type { LocalNote, LocalRun } from "./LocalReview.tsx";

/**
 * "Publish review…": the one way a local review reaches GitHub, and only when
 * the person presses Post comment in the dialog. The dialog IS the
 * confirmation, so there is no second question. No agent, plugin or door can
 * open it for them or press it (UI_REFUSED_FOR_AGENTS); the routes behind it
 * refuse anything but a window.
 */

const AMBER = "var(--warning-ink)";

/** The button and its chips, for one plugin's run. Same bar height as its neighbours. */
export function PublishReview({ run, notes, root, head, superseded = false }: {
  run?: LocalRun;
  /** Every note of this plugin on this pull request, closed ones too. */
  notes: LocalNote[];
  root: string;
  /** The pull request's head and when the app read it; a head read before the review ended cannot call it stale. */
  head?: HeadRead;
  /** A newer finished review of the same plugin covers the head. */
  superseded?: boolean;
}) {
  const [open, setOpen] = useState(false);
  // A finding belongs to the pull request, not to the run that last touched it.
  const mine = useMemo(() => notes.filter((n) => run && n.plugin === run.plugin), [notes, run]);
  const st: PublishButtonState = publishButtonState(run, mine, head, superseded);
  return (
    <>
      <div className="shrink-0 inline-flex items-center gap-1.5" style={{ height: CTRL_H.compact }}>
        <Button size="compact" tone="primary" disabled={st.disabled} title={st.tooltip} onClick={() => setOpen(true)}>{st.label}</Button>
        {st.staleChip && (
          <span className="rounded px-1.5 text-[10px] leading-none inline-flex items-center whitespace-nowrap" style={{ height: CTRL_H.compact, color: AMBER, border: tintEdge(AMBER, 45) }}
            title="The pull request has new commits since this review. Publishing posts it as it is.">stale review · head moved</span>
        )}
        {st.supersededChip && (
          <span className="rounded px-1.5 text-[10px] leading-none inline-flex items-center whitespace-nowrap" style={{ height: CTRL_H.compact, color: "var(--text3)", border: EDGE }}
            title="A newer review covers the current head">superseded by a newer review</span>
        )}
        {st.published && (
          <button type="button" onClick={() => openExternal(st.published!.url)} title="Open the published comment on GitHub"
            className="rounded px-1.5 text-[10px] leading-none inline-flex items-center gap-1 whitespace-nowrap hover:brightness-125"
            style={{ height: CTRL_H.compact, color: "var(--text2)", border: EDGE, background: "transparent" }}>
            published to GitHub · {ago(st.published.at)}
            <svg width={ICON.xs} height={ICON.xs} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M7 17 17 7M8 7h9v9" /></svg>
          </button>
        )}
      </div>
      {open && run && <PublishDialog run={run} notes={mine} root={root} onClose={() => setOpen(false)} />}
    </>
  );
}

function PublishDialog({ run, notes, root, onClose }: { run: LocalRun; notes: LocalNote[]; root: string; onClose: () => void }) {
  const [options, setOptions] = useState<PublishOptions>(freshOptions);
  const [markdown, setMarkdown] = useState("");
  const [existing, setExisting] = useState<{ commentId: string; url: string } | null>(null);
  const [openN, setOpenN] = useState<number | null>(null);
  const [omitted, setOmitted] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [posting, setPosting] = useState(false);
  const [tab, setTab] = useState<PreviewTab>(readPreviewTab);
  const [dirty, setDirty] = useState(false);
  const seq = useRef(0);
  const body = { plugin: run.plugin, repo: run.repo, number: run.number, root, runId: run.id };

  // The preview follows the boxes. Only the latest answer lands.
  useEffect(() => {
    const mine = ++seq.current;
    setLoading(true); setError(null);
    api.pluginPublishPreview({ ...body, options }).then((r) => {
      if (mine !== seq.current) return;
      setLoading(false);
      if (!r.ok) { setError(r.error ?? "The preview could not be built"); return; }
      setMarkdown(r.markdown ?? ""); setDirty(false);
      setExisting(r.existing ?? null); setOpenN(r.openCount ?? null); setOmitted(r.omitted ?? 0);
    }).catch((e) => { if (mine === seq.current) { setLoading(false); setError(String(e)); } });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options, run.id]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !posting) { e.preventDefault(); e.stopPropagation(); onClose(); }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [posting, onClose]);

  const post = async () => {
    if (!canPost(markdown, posting || loading)) return;
    setPosting(true); setError(null);
    const r = await api.pluginPublish({ ...body, options, ...(dirty ? { markdown } : {}) }).catch((e) => ({ ok: false, error: String(e) }));
    setPosting(false);
    if (r.ok) onClose();
    else setError(r.error ?? "GitHub did not take the comment. Nothing was changed.");
  };
  const toggle = (key: keyof PublishOptions) => setOptions((o) => ({ ...o, [key]: !o[key] }));

  return (
    <PublishDialogView run={run} notes={notes} options={options} markdown={markdown} existing={existing} openN={openN} omitted={omitted}
      loading={loading} error={error} posting={posting} tab={tab} dirty={dirty}
      onToggle={toggle} onAll={() => setOptions(publishAllOptions())} onTab={(t) => { setTab(t); rememberPreviewTab(t); }}
      onText={(t) => { setMarkdown(t); setDirty(true); }} onPost={() => void post()} onClose={onClose} />
  );
}

export interface PublishDialogViewProps {
  run: Pick<LocalRun, "plugin" | "repo" | "number" | "sha">;
  notes: LocalNote[];
  options: PublishOptions;
  markdown: string;
  existing: { commentId: string; url: string } | null;
  openN: number | null;
  omitted: number;
  loading: boolean; error: string | null; posting: boolean; tab: PreviewTab; dirty: boolean;
  onToggle: (key: keyof PublishOptions) => void; onAll: () => void; onTab: (t: PreviewTab) => void; onText: (t: string) => void;
  onPost: () => void; onClose: () => void;
}

/** The dialog as a picture of its state; PublishDialog above owns the state. */
export function PublishDialogView(p: PublishDialogViewProps) {
  const { run, notes, options, markdown, existing, openN, omitted, loading, error, posting, tab, dirty, onClose } = p;
  const rows = optionRows(notes, options);
  const counter = charCounter(markdown.length);

  return (
    <Portal>
      <div className="fixed inset-0 agx-scrim" style={{ zIndex: 10004 }} onClick={() => { if (!posting) onClose(); }} />
      <div className="fixed inset-0 flex items-center justify-center p-6 pointer-events-none" style={{ zIndex: 10005 }}>
        <div role="dialog" aria-modal="true" aria-label="Publish review to the pull request"
          className="pointer-events-auto w-full max-w-[1000px] max-h-full flex flex-col rounded-xl overflow-hidden"
          style={{ background: "var(--surface-card)", border: EDGE, boxShadow: "0 20px 60px rgba(0,0,0,0.5)", height: "min(640px, 100%)" }}>
          <div className="px-4 py-2.5 flex items-center gap-2 flex-wrap" style={{ borderBottom: LINE }}>
            <span className="text-[13px] font-medium" style={{ color: "var(--text)" }}>{existing ? "Update published review" : "Publish review to the pull request"}</span>
            <span className="flex-1" />
            <span className="text-[10.5px] t-mono" style={{ color: "var(--text3)" }}>
              {run.repo} #{run.number}{run.sha ? ` · reviewed commit ${run.sha.slice(0, 7)}` : ""}
            </span>
          </div>
          <div className="flex-1 min-h-0 grid" style={{ gridTemplateColumns: "minmax(220px, 300px) minmax(0, 1fr)" }}>
            <div className="p-3.5 overflow-y-auto flex flex-col gap-1" style={{ borderRight: LINE }}>
              <div className="text-[10px] uppercase tracking-[.12em] mb-1" style={{ color: "var(--text3)" }}>What goes out</div>
              {rows.map((r) => (
                <label key={r.key} className="flex items-center gap-2 text-[11.5px] cursor-pointer min-h-[26px]" style={{ color: "var(--text)" }}>
                  <input type="checkbox" checked={r.checked} disabled={posting} onChange={() => p.onToggle(r.key)} />
                  <span className="min-w-0">{r.label}{r.count !== null && <span style={{ color: "var(--text3)" }}> ({r.count})</span>}</span>
                </label>
              ))}
              <div className="my-2">
                <Button size="compact" disabled={posting || allTicked(options)} onClick={p.onAll}>Publish all for context</Button>
              </div>
              {openN === 0 && (
                <div className="rounded-md px-2.5 py-2 text-[11px]" role="status"
                  style={{ color: AMBER, border: tintEdge(AMBER, 40), background: `color-mix(in srgb, ${AMBER} 8%, transparent)` }}>
                  {NOTHING_OPEN_WARNING}
                </div>
              )}
              <div className="rounded-md px-2.5 py-2 text-[11px] leading-snug mt-1" style={{ color: AMBER, border: tintEdge(AMBER, 40), background: `color-mix(in srgb, ${AMBER} 8%, transparent)` }}>
                {NOTHING_LEAVES_WARNING}
              </div>
              {omitted > 0 && <div className="text-[10.5px] mt-1" style={{ color: "var(--text3)" }}>{omitted} lowest-severity {omitted === 1 ? "finding is" : "findings are"} left out to fit GitHub's size limit.</div>}
              {dirty && <div className="text-[10.5px] mt-1" style={{ color: "var(--text3)" }}>You edited the text. Changing a box rebuilds it and drops the edits.</div>}
              <div className="flex-1" />
            </div>
            <div className="p-3.5 min-w-0 min-h-0 flex flex-col gap-1.5">
              <style>{MD_CSS}</style>
              <div className="flex items-center gap-2" style={{ borderBottom: LINE }}>
                <Tabs value={tab} options={PREVIEW_TABS} onChange={p.onTab} label="Comment view" panelId="publish-review-panel" />
                <span className="flex-1" />
                <span className="text-[10.5px] tabular-nums" aria-live="polite" style={{ color: counter.over ? "var(--error-ink)" : "var(--text3)" }}>Size {counter.text} characters</span>
              </div>
              {tab === "markdown" ? (
                <textarea id="publish-review-panel" role="tabpanel" value={markdown} aria-label="Comment text" spellCheck={false}
                  onChange={(e) => p.onText(e.target.value)}
                  className="flex-1 min-h-0 w-full rounded-md p-2.5 text-[11.5px] leading-relaxed t-mono resize-none"
                  style={{ border: EDGE, background: "var(--surface-base, transparent)", color: "var(--text)" }} />
              ) : (
                <div id="publish-review-panel" role="tabpanel" className="flex-1 min-h-0 overflow-auto" style={{ opacity: loading ? 0.5 : 1 }}>
                  <div className="agx-card rounded-md overflow-hidden" style={{ border: EDGE }}>
                    <div className="px-3 py-2 text-[11px]" style={{ borderBottom: LINE, color: "var(--text3)" }}>
                      <b style={{ color: "var(--text)", fontWeight: 500 }}>{PREVIEW_CARD_LINE}</b>
                    </div>
                    <div className="px-3 py-2.5 text-[12px]"><Md body={markdown} /></div>
                  </div>
                </div>
              )}
              {error && <div className="text-[11px]" role="alert" style={{ color: "var(--error-ink)" }}>{error}</div>}
            </div>
          </div>
          <div className="px-4 py-2.5 flex items-center gap-2 flex-wrap" style={{ borderTop: LINE }}>
            <Button size="compact" disabled={!markdown} onClick={() => { void navigator.clipboard?.writeText(markdown).catch(() => {}); }}>Copy markdown</Button>
            <span className="flex-1" />
            <Button size="compact" disabled={posting} onClick={onClose}>Cancel</Button>
            <Button size="compact" tone="primary" pending={posting} disabled={!canPost(markdown, posting || loading)} onClick={p.onPost}>{postLabel(!!existing)}</Button>
          </div>
        </div>
      </div>
    </Portal>
  );
}
