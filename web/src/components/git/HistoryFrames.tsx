/*
 * What the Log and the Reflog show beside the list and instead of it: the
 * inspector of the picked row, and the frames for empty, loading and failed.
 * Every failed frame carries Try again.
 */
import type { ReactNode } from "react";
import type { GitGraphLine, GitReflogEntry } from "../../../../shared/types.ts";
import { Button } from "../workspace/Chrome.tsx";
import { DoneIcon, RefreshIcon, WarningIcon } from "../../lib/glyphIcons.tsx";
import { ICON } from "../../lib/iconSize.ts";
import { wash, INSPECTOR_RULE } from "./ui.tsx";
import { CommitAvatar } from "./CommitAvatar.tsx";
import { FilesBlock, MiniCard, useCommitFiles } from "./CommitDetail.tsx";
import type { GraphRow } from "../../lib/gitGraph.ts";
import { DockIcon } from "../GitDock.tsx";

export const MONO = "var(--font-mono, ui-monospace, monospace)";

/** The 36px tile that leads an empty or failed frame: the glyph in a tone, on a wash of it. */
export function FrameIcon({ icon, tone }: { icon: ReactNode; tone: string }) {
  return <span className="grid place-items-center shrink-0" style={{ width: 36, height: 36, borderRadius: 10, color: `var(${tone})`, background: wash(tone, 10), boxShadow: `inset 0 0 0 1px ${wash(tone, 24)}` }}>{icon}</span>;
}

export function StateFrame({ title, text, code, busy, actions, icon, ghost }: {
  title: ReactNode; text?: string; code?: string; busy?: boolean; actions?: ReactNode;
  /** A tile above the title (the empty Log's commit icon). */
  icon?: ReactNode;
  /** Dashed placeholder rows under the sentence, fading out: where the first rows will be. */
  ghost?: boolean;
}) {
  return (
    <div className="flex-1 min-h-0 grid place-items-center px-4 py-10 text-center" role="status" aria-busy={busy}>
      <div className="flex flex-col items-center gap-2" style={{ maxWidth: 460 }}>
        {icon}
        <div className="text-[13px] font-medium" style={{ color: "var(--text)" }}>{title}</div>
        {text && <p className="m-0 text-[11px] leading-relaxed" style={{ color: "var(--text3)" }}>{text}</p>}
        {code && (
          <pre className="m-0 px-2.5 py-1.5 rounded-lg text-[10.5px] text-left select-all max-w-full overflow-x-auto"
            style={{ fontFamily: MONO, color: "var(--text2)", background: wash("--text", 5) }}>{code}</pre>
        )}
        {ghost && (
          <div aria-hidden className="flex flex-col gap-1.5 w-[280px] mt-0.5 mb-1.5">
            {[1, 0.6, 0.3].map((o) => <i key={o} className="block h-7 rounded-lg" style={{ opacity: o, border: `1px dashed ${wash("--text", 18)}` }} />)}
          </div>
        )}
        {!!actions && <div className="flex items-center gap-2 mt-1">{actions}</div>}
      </div>
    </div>
  );
}

/** The log that could not be read: a card with what git said, Try again, and the command log at the far end. */
export function ErrorBox({ title, text, code, onRetry, onLog }: { title: string; text: string; code?: string; onRetry: () => void; onLog: () => void }) {
  return (
    <div className="flex-1 min-h-0 grid place-items-center px-4 py-10" role="alert">
      <div className="w-full text-left overflow-hidden rounded-xl" style={{ maxWidth: 600, background: "var(--bg)", boxShadow: `inset 0 0 0 1px ${wash("--error", 24)}` }}>
        <div className="grid gap-2.5 p-3.5 pb-2.5" style={{ gridTemplateColumns: "36px 1fr" }}>
          <span className="grid place-items-center rounded-xl" style={{ width: 36, height: 36, color: "var(--error)", background: wash("--error", 10), boxShadow: `inset 0 0 0 1px ${wash("--error", 24)}` }}><DockIcon name="alert" size={ICON.lg} /></span>
          <div>
            <div className="text-[14px] font-semibold" style={{ color: "var(--text)" }}>{title}</div>
            <p className="m-0 mt-0.5 text-[12.5px] leading-relaxed" style={{ color: "var(--text3)" }}>{text}</p>
          </div>
        </div>
        {code && <pre className="mx-3.5 my-0 px-2.5 py-2 rounded-lg text-[11px] leading-relaxed select-all whitespace-pre-wrap" style={{ fontFamily: MONO, color: "var(--error-ink)", background: wash("--error", 5), boxShadow: `inset 0 0 0 1px ${wash("--error", 12)}` }}>{code}</pre>}
        <div className="flex items-center gap-1.5 p-3.5">
          <Button tone="primary" onClick={onRetry}><DockIcon name="refresh" />Try again</Button>
          <span className="flex-1" />
          <Button tone="quiet" onClick={onLog}><DockIcon name="list" />Open the command log</Button>
        </div>
      </div>
    </div>
  );
}

/** Changes with nothing to commit: where the branch stands, in place of the file list. */
export function CleanFrame({ sha, children }: { sha?: string; children?: ReactNode }) {
  return (
    <div className="flex-1 min-h-0 grid place-items-center px-4 py-10 text-center">
      <div className="flex flex-col items-center gap-2" style={{ maxWidth: 460 }}>
        <div className="grid place-items-center rounded-full mb-1" style={{ width: 34, height: 34, background: wash("--success", 14), color: "var(--success-ink)" }}><DoneIcon size={ICON.sm} /></div>
        <div className="text-[13px] font-medium" style={{ color: "var(--text)" }}>
          {sha ? <>Nothing changed since <span style={{ fontFamily: MONO }}>{sha}</span></> : "Nothing changed"}
        </div>
        {children && <p className="m-0 text-[11px] leading-relaxed" style={{ color: "var(--text3)" }}>{children}</p>}
      </div>
    </div>
  );
}

/**
 * A failed list on the G4 tabs, as the approved frame draws it: a card with a red tile, the title,
 * one plain sentence, git's own line when the caller has it, and Try again beside what else the frame offers.
 */
export function ErrorFrame({ title, sentence, onRetry, extra, raw }: { title: string; sentence: string; onRetry: () => void; extra?: ReactNode; raw?: string }) {
  return (
    <div className="flex-1 min-h-0 grid place-items-center px-4 py-10" role="alert">
      <div className="flex flex-col gap-3 w-full px-3.5 py-3.5" style={{ maxWidth: 600, borderRadius: 12, background: wash("--error", 4), boxShadow: `inset 0 0 0 1px ${wash("--error", 26)}` }}>
        <div className="flex items-start gap-3">
          <FrameIcon icon={<WarningIcon size={ICON.md} />} tone="--error" />
          <div className="min-w-0">
            <div className="text-[14px] font-semibold" style={{ color: "var(--text)" }}>{title}</div>
            <p className="m-0 mt-0.5 text-[12px] leading-snug" style={{ color: "var(--text3)" }}>{sentence}</p>
          </div>
        </div>
        {raw && <pre className="m-0 px-2.5 py-2 text-[11px] text-left select-all overflow-x-auto whitespace-pre-wrap break-words"
          style={{ borderRadius: 8, fontFamily: MONO, color: "var(--error-ink)", background: wash("--error", 6), boxShadow: `inset 0 0 0 1px ${wash("--error", 18)}` }}>{raw}</pre>}
        <div className="flex items-center gap-2">
          <Button tone="primary" onClick={onRetry}><RefreshIcon size={ICON.xs} />Try again</Button>
          <span className="flex-1" />
          {extra}
        </div>
      </div>
    </div>
  );
}

/** "Try again" plus whatever else the frame offers. */
export const retryButton = (onClick: () => void) => <Button tone="primary" onClick={onClick}>Try again</Button>;

export function Aside({ children }: { children: ReactNode }) {
  return (
    <aside className="agx-scroll hidden lg:flex flex-col gap-3 w-[360px] shrink-0 min-w-0 overflow-y-auto p-4 self-stretch"
      style={{ borderLeft: INSPECTOR_RULE, background: "linear-gradient(180deg, color-mix(in srgb, var(--bg2) 40%, var(--bg)), var(--bg) 140px)" }}>
      {children}
    </aside>
  );
}

export const Fact = ({ k, v, mono, wide }: { k: string; v?: string; mono?: boolean; wide?: boolean }) => !v ? null : (
  <div className="flex gap-3 text-[11px] min-w-0">
    <span className={`${wide ? "w-20" : "w-12"} shrink-0`} style={{ color: "var(--text3)" }}>{k}</span>
    <span className="min-w-0 break-words" title={v} style={{ color: "var(--text2)", fontFamily: mono ? MONO : undefined }}>{v}</span>
  </div>
);

/** The top of an inspector: a tinted tile with the object's icon, its name, one line under it. */
export function InspectorHead({ icon, tone, title, sub }: { icon: ReactNode; tone: string; title: string; sub?: ReactNode }) {
  return (
    <div className="flex items-start gap-3 min-w-0">
      <span className="grid place-items-center shrink-0 rounded-lg" style={{ width: 36, height: 36, color: `var(${tone})`, background: wash(tone, 14) }}>{icon}</span>
      <div className="min-w-0">
        <div className="text-[14px] font-semibold break-all" style={{ color: "var(--text)", fontFamily: MONO }}>{title}</div>
        {sub && <div className="text-[11px] mt-0.5" style={{ color: "var(--text3)" }}>{sub}</div>}
      </div>
    </div>
  );
}

export function NothingPicked({ what }: { what: string }) {
  return <Aside><div className="text-[11.5px]" style={{ color: "var(--text3)" }}>Pick {what} to see its details.</div></Aside>;
}

export function CommitInspector({ line, root, lines, layout }: {
  line?: GitGraphLine; root: string; lines: readonly GitGraphLine[]; layout: ReadonlyMap<string, GraphRow>;
}) {
  const files = useCommitFiles(root, line?.hash);
  if (!line?.hash) return <NothingPicked what="a commit" />;
  const merge = (line.parents?.length ?? 0) > 1;
  return (
    <Aside>
      <div className="grid items-start gap-2.5 min-w-0" style={{ gridTemplateColumns: "36px minmax(0, 1fr)" }}>
        <span className="grid place-items-center rounded-xl" style={{
          width: 36, height: 36, color: "var(--text2)", background: wash("--text", 4), boxShadow: `inset 0 0 0 1px ${wash("--text", 12)}` }}>
          <DockIcon name={merge ? "merge" : "commit"} size={ICON.lg} />
        </span>
        <div className="min-w-0">
          <div className="text-[14px] font-semibold leading-snug break-words" style={{ color: "var(--text)" }}>{line.subject}</div>
          <div className="mt-0.5 text-[12px] leading-snug flex flex-wrap items-center gap-x-1.5" style={{ color: "var(--text3)" }}>
            <CommitAvatar author={line.author} size={ICON.lg} />
            <span>{line.author}</span><span aria-hidden>·</span><span>{line.date}</span><span aria-hidden>·</span>
            <span style={{ fontFamily: MONO }}>{line.hash}</span>
          </div>
        </div>
      </div>
      <MiniCard lines={lines} layout={layout} hash={line.hash} />
      <FilesBlock files={files} />
    </Aside>
  );
}

export function ReflogInspector({ entry }: { entry?: GitReflogEntry }) {
  if (!entry) return <NothingPicked what="an entry" />;
  return (
    <Aside>
      <div className="text-[14px] font-medium break-words" style={{ color: "var(--text)" }}>{entry.subject || entry.action}</div>
      <div className="flex flex-col gap-1.5">
        <Fact k="Entry" v={entry.ref} mono />
        <Fact k="Did" v={entry.action} />
        <Fact k="When" v={entry.date} />
        <Fact k="Commit" v={entry.shortHash} mono />
      </div>
      <div className="text-[11px] leading-relaxed px-3 py-2 rounded-lg" style={{ color: "var(--text2)", background: wash("--text", 5) }}>
        <b>Lost a commit?</b> Pick its row and press <b>New branch from here</b> — the commit gets a name again and nothing else moves.
      </div>
    </Aside>
  );
}
