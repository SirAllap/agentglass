import { useEffect, useRef, useState } from "react";
import type { Changelog, ChangelogEntry, GitRangeCounts } from "../../../../shared/types.ts";
import { CopyIcon, DoneIcon, WarningIcon, CheckboxIcon, TagIcon } from "../../lib/glyphIcons.tsx";
import { ICON, HIT } from "../../lib/iconSize.ts";
import { EDGE, LINE } from "../workspace/Chrome.tsx";
import { RangePicker } from "./RangePicker.tsx";
import { changelogMarkdown, copyText, emptyChangelogText } from "../../lib/insightsView.ts";
import { changelogState, changesText, copyView, fromRows, fromShown, nothingNew, toRows, unlistedText, type CopyState } from "../../lib/insightsModel.ts";

const DOT: Record<string, string> = { "Breaking changes": "var(--error)", Features: "var(--success)", Fixes: "var(--info)", Performance: "var(--warning)" };

function Entry({ e }: { e: ChangelogEntry }) {
  return (
    <li className="grid items-baseline gap-2 text-[12px] leading-snug" style={{ gridTemplateColumns: "52px 62px minmax(0,1fr)" }}>
      <span className="font-mono text-[10.5px]" style={{ color: "var(--text3)" }}>{e.hash}</span>
      {e.scope ? <span className="justify-self-start max-w-full truncate rounded px-1 text-[10.5px] font-mono" style={{ color: "var(--info-ink)", border: "1px solid color-mix(in srgb, var(--info) 30%, transparent)" }}>{e.scope}</span> : <span />}
      <span className="min-w-0" style={{ color: "var(--text)", overflowWrap: "anywhere" }}>{e.subject}</span>
    </li>
  );
}

export function ChangelogPane({ changelog, counts, refs, from, to, onFrom, onTo, onRetry }: {
  changelog: Changelog | null; counts: GitRangeCounts | null; refs: { tags: string[]; branches: string[] };
  from: string; to: string; onFrom: (v: string) => void; onTo: (v: string) => void; onRetry: () => void;
}) {
  const [copy, setCopy] = useState<CopyState>("idle");
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const state = changelogState(changelog, counts);
  const md = changelogMarkdown(changelog);
  const cv = copyView(copy);
  const press = async () => {
    clearTimeout(timer.current);
    const r = await copyText(md, (t) => navigator.clipboard.writeText(t));
    setCopy(r);
    const after = copyView(r).resetsAfter;
    if (after) timer.current = setTimeout(() => setCopy("idle"), after);
  };
  const atHead = to === "HEAD";
  const nn = nothingNew(changelog, counts);
  const btn = { height: HIT, border: EDGE, background: "var(--surface-card)", color: "var(--text)" } as const;
  const unlisted = unlistedText(changelog);

  return (
    <div className="flex flex-col min-h-0 h-full">
      <div className="shrink-0 flex items-center gap-2 px-4 pt-3 pb-2">
        <span className="text-[13px] font-semibold" style={{ color: "var(--text)" }}>Changelog</span>
        <button type="button" onClick={press} disabled={!md} title={cv.tip} aria-describedby="agx-copy-live"
          className="ml-auto inline-flex items-center gap-1.5 px-2.5 rounded-lg text-[12px] font-medium disabled:opacity-40"
          style={{ ...btn, color: copy === "copied" ? "var(--success)" : copy === "failed" ? "var(--error-ink)" : "var(--text)", width: 172, whiteSpace: "nowrap", justifyContent: "center" }}>
          {copy === "copied" ? <DoneIcon size={ICON.sm} /> : copy === "failed" ? <WarningIcon size={ICON.sm} /> : <CopyIcon size={ICON.sm} />}{cv.label}
        </button>
        <span id="agx-copy-live" role="status" aria-live="polite" className="sr-only">{cv.live}</span>
      </div>
      <div className="shrink-0 flex items-center gap-2 px-4 pb-2.5 text-[12px]" style={{ color: "var(--text3)", borderBottom: LINE }}>
        From
        <RangePicker label="From" icon="tag" value={from} shown={fromShown(from, changelog)}
          sections={(q) => { const r = fromRows(counts, q, atHead); return [{ title: "Tags, newest first", note: String(r.tags.length), rows: r.tags }, { title: "Other", rows: r.other }]; }}
          onPick={onFrom} />
        to
        <RangePicker label="To" icon="branch" value={to} shown={to}
          sections={(q) => { const r = toRows(refs.branches, refs.tags, q); return [{ title: "Now", rows: r.head }, { title: "Branches", rows: r.branches }, { title: "Tags", rows: r.tags }]; }}
          onPick={onTo} />
        <span className="ml-auto tabular-nums whitespace-nowrap shrink-0">{changesText(changelog)}</span>
      </div>

      <div className={`min-h-0 flex-1 overflow-y-auto px-4 py-3 ${cv.selectable ? "select-text" : ""}`} style={cv.selectable ? { userSelect: "text" } : undefined}>
        {state === "loading" && <div role="status" aria-label="Reading the changelog" className="flex flex-col gap-2">{[40, 100, 80, 70].map((w, i) => <div key={i} className="rounded motion-safe:animate-pulse" style={{ width: `${w}%`, height: 14, background: "var(--surface-inset)" }} />)}</div>}
        {state === "error" && (
          <div role="alert" className="flex flex-col gap-2.5 text-[12px]">
            <div className="font-semibold" style={{ color: "var(--error-ink)" }}>The changelog could not be read</div>
            <pre className="m-0 whitespace-pre-wrap rounded-lg px-2.5 py-2 text-[11px] font-mono" style={{ background: "var(--surface-inset)", border: EDGE, color: "var(--text2)", overflowWrap: "anywhere" }}>{changelog?.error}</pre>
            <button type="button" onClick={onRetry} className="self-start px-2.5 rounded-lg text-[12px] font-medium" style={btn}>Try again</button>
          </div>
        )}
        {state === "empty-repo" && <div className="text-[12px] py-6 text-center" style={{ color: "var(--text3)" }}>Nothing to list until the first commit.</div>}
        {state === "no-commits" && changelog && <div className="text-[12px] py-6 text-center" style={{ color: "var(--text3)" }}>{emptyChangelogText(changelog)}</div>}
        {state === "nothing-new" && nn && (
          <div className="flex flex-col items-center text-center gap-2 py-8">
            <span className="grid place-items-center rounded-lg" aria-hidden style={{ width: 36, height: 36, color: "var(--success)", background: "color-mix(in srgb, var(--success) 10%, transparent)" }}><CheckboxIcon size={ICON.lg} checked /></span>
            <div className="text-[14px] font-semibold" style={{ color: "var(--text)" }}>Nothing new since {nn.tag}</div>
            <div className="text-[12px]" style={{ color: "var(--text3)" }}>HEAD is the tag itself.{nn.older ? " Pick an older start to see what went into it." : ""}</div>
            {nn.older && (
              <button type="button" onClick={() => onFrom(nn.older!.value)} className="inline-flex items-center gap-1.5 px-2.5 rounded-lg text-[12px] font-medium" style={btn}>
                <TagIcon size={ICON.sm} />From {nn.older.label} · {nn.older.count} change{nn.older.count === 1 ? "" : "s"}
              </button>
            )}
          </div>
        )}
        {state === "list" && changelog && (
          <div className="flex flex-col gap-4">
            {changelog.sections.map((s) => (
              <section key={s.title}>
                <h4 className="m-0 mb-1.5 flex items-center gap-2 text-[12px] font-semibold" style={{ color: "var(--text)" }}>
                  <i aria-hidden style={{ width: 8, height: 8, borderRadius: 2, background: DOT[s.title] ?? "var(--text3)" }} />{s.title}<span className="font-normal tabular-nums" style={{ color: "var(--text3)" }}>{s.entries.length}</span>
                </h4>
                <ul className="m-0 p-0 list-none flex flex-col gap-1.5">{s.entries.map((e, i) => <Entry key={i} e={e} />)}</ul>
              </section>
            ))}
          </div>
        )}
      </div>
      {unlisted && state === "list" && (
        <div className="shrink-0 px-4 py-2 text-[11.5px]" style={{ color: "var(--text3)", borderTop: LINE }}>
          From the subjects written as <code className="font-mono rounded px-1" style={{ background: "var(--surface-inset)" }}>type(scope): what</code>. {unlisted}
        </div>
      )}
    </div>
  );
}
