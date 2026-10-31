/*
 * The Tidy tab: what has piled up, and the command that would clear each thing.
 * No dock, because nothing is picked: each finding carries its own Clean up.
 */
import { useState } from "react";
import type { ReactNode } from "react";
import type { TidyFinding, TidyReport } from "../../../../shared/types.ts";
import { ArrowIcon, BlockedIcon, DoneIcon, IconLabel, RefreshIcon, TerminalIcon } from "../../lib/glyphIcons.tsx";
import { ICON } from "../../lib/iconSize.ts";
import { frameSentence, tidySegments } from "../../lib/gitG4.ts";
import { Button, EDGE } from "../workspace/Chrome.tsx";
import { ShellConsole } from "../ShellConsole.tsx";
import { ErrorFrame } from "./HistoryFrames.tsx";
import { Empty, edge } from "./ui.tsx";

/** One labelled block of the explanation. Small on purpose: three short
 *  answers get read, one paragraph does not. */
function Says({ label, children, tint }: { label: string; children: ReactNode; tint?: string }) {
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
          style={{ color: "var(--text3)", border: EDGE }}>Cancel</button>
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
/** Segment colours of the bar, in finding order. */
const SEG = ["var(--info)", "var(--warning)", "var(--text3)", "var(--success)", "var(--error)"];


export function TidyView({ report, root, busy, onRefresh, onOpenStashes }: {
  report: TidyReport | null; root: string; busy: boolean; onRefresh: () => void; onOpenStashes: () => void;
}) {
  const [open, setOpen] = useState<string | null>(null);
  // Two steps, because they answer different questions: `open` is "explain
  // this to me", `armed` is "now give me the command".
  const [armed, setArmed] = useState<string | null>(null);
  if (busy && !report) return <Empty what="clutter" busy />;
  if (!report) return null;
  if (report.error) {
    console.warn("tidy failed:", report.error);
    return <ErrorFrame title="Tidy could not look" sentence={frameSentence(report.error)} onRetry={onRefresh} />;
  }
  if (!report.findings.length) {
    return (
      <div className="flex-1 min-h-0 grid place-items-center gap-1.5 py-14 px-6 text-center">
        <div className="grid place-items-center rounded-full mb-1"
          style={{ width: 34, height: 34, background: "color-mix(in srgb, var(--success) 14%, transparent)", color: "var(--success-ink)" }}><DoneIcon size={ICON.sm} /></div>
        <div className="text-[12.5px]" style={{ color: "var(--text)" }}>Nothing has piled up</div>
        <div className="text-[10.5px]" style={{ color: "var(--text3)", maxWidth: 340 }}>
          No stale branches, no dangling worktrees, no loose objects worth packing.
        </div>
        <div className="mt-2"><Button onClick={onRefresh} disabled={busy}><RefreshIcon size={ICON.sm} />Check again</Button></div>
      </div>
    );
  }
  const segs = tidySegments(report.findings);
  const things = report.findings.length;
  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="shrink-0 flex items-center gap-3 px-3 py-2 flex-wrap" style={{ borderBottom: edge(8) }}>
        <span className="min-w-0 flex-1 text-[11.5px]" style={{ color: "var(--text2)" }}>
          <b style={{ color: "var(--text)" }}>{things} {things === 1 ? "thing has" : "things have"} piled up.</b>{" "}
          Nothing here runs git: <b>Clean up</b> opens a shell with the command typed. You press Enter.
        </span>
        <Button onClick={onRefresh} disabled={busy}><RefreshIcon size={ICON.sm} />Check again</Button>
      </div>
      <div className="shrink-0 px-3 pt-3 w-full mx-auto" style={{ maxWidth: 1100 }}>
        <div className="flex h-2 gap-0.5 rounded-full overflow-hidden" role="img" aria-label={segs.map((g) => `${g.count} ${g.label}`).join(", ")}>
          {segs.map((g, i) => <span key={g.id} style={{ width: `${g.pct}%`, background: SEG[i % SEG.length] }} />)}
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-0.5 mt-1.5 text-[10.5px]" style={{ color: "var(--text3)" }}>
          {segs.map((g, i) => (
            <span key={g.id} className="inline-flex items-center gap-1.5">
              <span className="rounded-sm" style={{ width: 8, height: 8, background: SEG[i % SEG.length] }} />{g.count} {g.label}
            </span>
          ))}
        </div>
      </div>
      {/* A reading measure. These cards are prose — a finding, what it means,
          and what it would cost — and prose set to 2000px is not read, it is
          skimmed past. Centred, so the pane does not read as pinned to one edge. */}
      <div className="agx-scroll flex-1 min-h-0 overflow-y-auto p-3 flex flex-col gap-2.5 w-full mx-auto" style={{ maxWidth: 1100 }}>
      {report.findings.map((f) => {
        const total = f.items.length + f.extra;
        return (
          // `shrink-0` and it is load-bearing: this is a flex column, and a
          // flex child is allowed to shrink below its own content. Expanding a
          // card was squashing it instead — the explanation's last sentence
          // and both of its buttons were simply cut off, with no scrollbar and
          // nothing to suggest anything was missing. Measured: 343px of
          // content in a 269px box.
          <div key={f.id} className="rounded-lg overflow-hidden shrink-0" style={{ border: EDGE, background: "color-mix(in srgb, var(--bg3) 34%, transparent)" }}>
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
              {f.command ? (
                <Button on={open === f.id} onClick={() => setOpen((v) => (v === f.id ? null : f.id))}
                  title="Open a shell here with the command typed in — you press Enter">
                  <TerminalIcon size={ICON.sm} />Clean up
                </Button>
              ) : f.id === "stashes" && <Button onClick={onOpenStashes}><ArrowIcon size={ICON.sm} />Open Stashes</Button>}
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
                    {held ? <IconLabel icon={<BlockedIcon size={ICON.xs} />}>{i}</IconLabel> : i}
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
    </div>
  );
}
