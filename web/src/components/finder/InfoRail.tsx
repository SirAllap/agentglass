/*
 * The finder's right rail: what the selected file IS, what git says about it,
 * what it is made of, and what can be done with it.
 *
 * "Which one is this" was the reason the old preview pane existed, and it stays
 * the reason: a screenshot and a note next to each other in a folder are told
 * apart by size, age and kind before they are told apart by opening. The new
 * half is the outline, because a long file is navigated by its structure — a
 * document by its headings, a program by its definitions — and the jump is one
 * click into the pane beside it.
 *
 * The primary action goes to the bench and says what it does there (see
 * primaryAction): opening a file for editing is the one
 * thing the finder no longer does by itself.
 */
import { useEffect, useRef, useState } from "react";
import type { FileGitFacts } from "../../../../shared/types.ts";
import { CopyIcon, DoneIcon, EditIcon, LinkIcon, TerminalIcon } from "../../lib/glyphIcons.tsx";
import { HIT, ICON } from "../../lib/iconSize.ts";
import { ago } from "../../lib/fileRecents.ts";
import { copyLabel, flash, humanBytes, shortenHome } from "../../lib/paletteModel.ts";
import { typeLabel, viewerActions, type OutlineItem } from "../../lib/finderViewer.ts";
import { EDGE, LINE } from "../workspace/Chrome.tsx";
import { primaryAction } from "../../lib/finderFolder.ts";
import { RevealButton } from "./RevealButton.tsx";
import type { LoadedFile } from "./useFileSource.ts";

/** One height for the four actions, so a stack of them reads as a stack. */
const ACTION_H = HIT + 6;

const Head = ({ children }: { children: React.ReactNode }) => (
  <div className="text-[9.5px] uppercase tracking-[0.14em] mb-2" style={{ color: "var(--text4)", fontWeight: 600 }}>{children}</div>
);
const Fact = ({ k, v, title }: { k: string; v: React.ReactNode; title?: string }) => (
  <div className="flex items-baseline justify-between gap-3 py-1 text-[11px]">
    <span className="shrink-0" style={{ color: "var(--text3)" }}>{k}</span>
    <span className="min-w-0 truncate text-right tabular-nums" style={{ color: "var(--text)" }} title={title}>{v}</span>
  </div>
);

const STATUS_INK: Record<string, string> = {
  clean: "var(--success-ink)", modified: "var(--warning-ink)", added: "var(--success-ink)", untracked: "var(--info-ink)",
  deleted: "var(--error-ink)", renamed: "var(--info-ink)", conflict: "var(--error-ink)", ignored: "var(--text3)",
};
/** Git's own one-letter codes. "clean" has none: it is drawn as a check. */
const STATUS_LETTER: Record<string, string> = { modified: "M", added: "A", untracked: "?", deleted: "D", renamed: "R", conflict: "!", ignored: "·" };

export function InfoRail({ file, git, outline, current, home, onJump, onBench, onCopyPath, onOpenBrowser }: {
  file: LoadedFile;
  git: FileGitFacts | null;
  outline: OutlineItem[];
  /** Index into `outline` of where the reader is, or -1. */
  current: number;
  home: string;
  onJump: (item: OutlineItem, nth: number) => void;
  onBench: () => void;
  onCopyPath: (abs: string) => void;
  onOpenBrowser?: (abs: string) => void;
}) {
  const { source, facts, text, kind } = file;
  const abs = source?.abs ?? null;
  const acts = kind ? viewerActions(kind) : { bench: false, browser: false };
  const primary = primaryAction(kind, !!file.error);

  /* "Copied ✓" for a moment: a button that does something invisible reads as a
     button that did nothing, and gets pressed again. */
  const [copied, setCopied] = useState(false);
  const copyFlash = useRef<ReturnType<typeof flash> | null>(null);
  copyFlash.current ??= flash(setCopied);
  useEffect(() => () => copyFlash.current?.cancel(), []);
  useEffect(() => { setCopied(false); copyFlash.current?.cancel(); }, [source?.abs, source?.rel]);

  if (!source) {
    return <Rail><div className="p-4 text-[11px]" style={{ color: "var(--text3)" }}>Nothing selected</div></Rail>;
  }

  const lines = text === null ? null : text.replace(/\n$/, "").split("\n").length;
  const words = kind === "markdown" && text !== null ? (text.match(/\S+/g) ?? []).length : null;
  const more = file.truncated ? "≥ " : "";
  const bytes = facts?.ok ? facts.bytes : null;

  return (
    <Rail>
      <section className="px-4 py-4" style={{ borderBottom: LINE }}>
        <Head>File</Head>
        <Fact k="Path" v={git?.path ?? (abs ? shortenHome(abs, home) : `${source.rel}${source.ref ? ` @ ${source.ref}` : ""}`)} title={abs ?? source.rel} />
        <Fact k="Type" v={typeLabel(file.name, kind, facts?.ok ? facts.mime : "")} />
        {(bytes !== null || lines !== null) && (
          <Fact k="Size" v={[bytes !== null ? humanBytes(bytes) : null, lines !== null && kind !== "markdown" ? `${more}${lines} lines` : null,
            words !== null ? `${more}${words.toLocaleString("en-US")} words` : null].filter(Boolean).join(" · ")} />
        )}
        {facts?.ok && facts.width && facts.height ? <Fact k="Dimensions" v={`${facts.width}×${facts.height}`} /> : null}
        {words !== null && <Fact k="Read time" v={`${Math.max(1, Math.round(words / 220))} min`} />}
        {facts?.ok && <Fact k="Modified" v={ago(facts.mtime)} />}
      </section>

      {git?.ok && git.repo && (
        <section className="px-4 py-4" style={{ borderBottom: LINE }}>
          <Head>Git</Head>
          <div className="flex items-center justify-between gap-3 py-1 text-[11px]">
            <span className="flex items-center gap-2 min-w-0">
              <span className="grid place-items-center rounded text-[10.5px] font-semibold shrink-0"
                style={{ width: 20, height: 20, color: STATUS_INK[git.status ?? "clean"], background: "color-mix(in srgb, currentColor 16%, transparent)" }}>
                {git.status && git.status !== "clean" ? STATUS_LETTER[git.status] : <DoneIcon size={ICON.xs} />}
              </span>
              <span style={{ color: "var(--text3)" }}>{git.status}</span>
            </span>
            {(git.added || git.removed) ? (
              <span className="tabular-nums shrink-0">
                <span style={{ color: "var(--success-ink)" }}>+{git.added ?? 0}</span>{" "}
                <span style={{ color: "var(--error-ink)" }}>{"−"}{git.removed ?? 0}</span>
              </span>
            ) : null}
          </div>
          {git.branch && <Fact k="Branch" v={git.branch} />}
          {git.commit && <Fact k="Last commit" v={`${git.commit.hash} · ${ago(git.commit.at)}`} />}
          {git.commit && <div className="text-[11px] mt-1 leading-snug" style={{ color: "var(--text3)" }}>{"“"}{git.commit.subject}{"”"}</div>}
        </section>
      )}

      {outline.length > 0 && (
        <section className="px-4 py-4 min-h-0" style={{ borderBottom: LINE }}>
          <Head>{kind === "markdown" ? "Contents · jump" : "Outline · jump"}</Head>
          <ul className="m-0 p-0 list-none -mx-2 agx-scroll overflow-y-auto" style={{ maxHeight: 220 }}>
            {outline.map((o, i) => {
              /* Headings can repeat ("Notes" under two parents); which one this
                 is decides which heading the reader scrolls to. */
              const nth = outline.slice(0, i).filter((x) => x.label === o.label).length;
              const on = i === current;
              return (
                <li key={i}>
                  <button onClick={() => onJump(o, nth)} title={`Line ${o.line}`}
                    className="agx-btn w-full flex items-baseline justify-between gap-3 rounded-md py-1 pr-2 text-left text-[11px]"
                    style={{ paddingLeft: 8 + (o.level - 1) * 10, color: "var(--info-ink)",
                      background: on ? "color-mix(in srgb, var(--primary) 14%, transparent)" : undefined }}>
                    <span className="truncate" style={{ fontFamily: kind === "markdown" ? undefined : "var(--font-mono, ui-monospace, monospace)" }}>{o.label}</span>
                    <span className="shrink-0 tabular-nums" style={{ color: "var(--text3)" }}>{kind === "markdown" ? i + 1 : `:${o.line}`}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      <section className="px-4 py-4">
        <Head>Actions</Head>
        <div className="flex flex-col gap-2">
          {primary && (
            <button onClick={onBench} className="flex items-center justify-between rounded-md px-3 text-[11.5px]"
              style={{ minHeight: ACTION_H, background: "var(--text)", color: "var(--bg)", fontWeight: 500 }} title={primary.title}>
              <span className="inline-flex items-center gap-1.5">
                {primary.id === "edit" ? <EditIcon size={ICON.sm} /> : <TerminalIcon size={ICON.sm} />}{primary.label}
              </span>
              <span className="text-[10px] opacity-70">{"⌘⏎"}</span>
            </button>
          )}
          {abs && (
            <button onClick={() => { onCopyPath(abs); copyFlash.current?.fire(); }} aria-live="polite"
              className="flex items-center justify-between rounded-md px-3 text-[11.5px]"
              style={{ minHeight: ACTION_H, color: copied ? "var(--success-ink)" : "var(--text2)", border: EDGE }}>
              <span className="inline-flex items-center gap-1.5">
                {copied ? <DoneIcon size={ICON.sm} /> : <CopyIcon size={ICON.sm} />}{copyLabel("Copy path", copied)}
              </span>
              <span className="text-[10px]" style={{ color: "var(--text4)" }}>{"⌘"}C</span>
            </button>
          )}
          {abs && <RevealButton path={abs} what="file" label="Show in folder" block />}
          {abs && acts.browser && onOpenBrowser && (
            <button onClick={() => onOpenBrowser(abs)} className="flex items-center gap-1.5 rounded-md px-3 text-[11.5px]"
              style={{ minHeight: ACTION_H, color: "var(--text2)", border: EDGE }} title="Open it in the app's browser">
              <LinkIcon size={ICON.sm} />Open in browser
            </button>
          )}
        </div>
      </section>
    </Rail>
  );
}

const Rail = ({ children }: { children: React.ReactNode }) => (
  <aside className="shrink-0 flex flex-col overflow-y-auto agx-scroll" style={{ width: 290, borderLeft: LINE, background: "var(--surface-card)" }} aria-label="File information">
    {children}
  </aside>
);
