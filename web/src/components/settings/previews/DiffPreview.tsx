import { useEffect, useMemo } from "react";
import { SplitDiff, UnifiedDiff } from "../../diff/DiffLines.tsx";
import { HiliteCtx, useDiffHighlight } from "../../../lib/diffHighlight.ts";
import type { DiffHunk } from "../../../../../shared/types.ts";
import { PreviewBox, PreviewNote } from "./Frame.tsx";

export interface DiffPreviewProps {
  split: boolean;
  wrap: boolean;
  /** The page's syntax-theme choice ("auto" or a theme id); left out, the saved one read at mount. */
  syntaxTheme?: string;
}

/** A hunk with one long line, so Wrap shows what it does. Invented code. */
const HUNKS: DiffHunk[] = [{
  oldStart: 12, oldLines: 8, newStart: 12, newLines: 10,
  lines: [
    " function reconnect(socket) {",
    "-  const wait = 500;",
    "+  const wait = backoff(attempt);",
    "   if (!socket.open) {",
    "+    log.warn(\"retrying in \" + wait + \" ms, attempt \" + attempt + \" of \" + MAX_ATTEMPTS + \" on \" + socket.url);",
    "     return schedule(wait);",
    "   }",
    " }",
    "-export const MAX_WAIT = 30_000;",
    "+export const MAX_WAIT = 30_000; // ms, capped",
    "+export const JITTER = 0.2;",
  ],
}];

/** Builds a hunk from its lines; the line counts follow from the prefixes. */
function hunk(oldStart: number, newStart: number, lines: string[]): DiffHunk {
  const oldLines = lines.filter((l) => l[0] !== "+").length;
  return { oldStart, oldLines, newStart, newLines: lines.length - lines.filter((l) => l[0] === "-").length, lines };
}

export interface DemoFile { path: string; hunks: DiffHunk[] }

/** A working session's diff: a reconnect module and its test, with additions, deletions and context runs. Invented code. */
export const SESSION_FILES: DemoFile[] = [
  { path: "src/net/reconnect.ts", hunks: [
    hunk(1, 1, [
      " import { log } from \"../log\";",
      "+import { jitter } from \"./jitter\";",
      " import type { Socket } from \"./socket\";",
      " ",
      "-const BASE_WAIT = 500;",
      "+export const BASE_WAIT = 500;",
      "+export const MAX_ATTEMPTS = 8;",
      " export const MAX_WAIT = 30_000;",
      " ",
    ]),
    hunk(14, 16, [
      " export function backoff(attempt: number): number {",
      "-  return Math.min(BASE_WAIT * attempt, MAX_WAIT);",
      "+  const raw = BASE_WAIT * 2 ** attempt;",
      "+  return Math.min(jitter(raw, 0.2), MAX_WAIT);",
      " }",
      " ",
      "-export function reconnect(socket: Socket) {",
      "-  if (!socket.open) schedule(BASE_WAIT);",
      "+export function reconnect(socket: Socket, attempt = 0): void {",
      "+  if (socket.open) return;",
      "+  if (attempt >= MAX_ATTEMPTS) {",
      "+    log.error(`giving up on ${socket.url} after ${attempt} attempts`);",
      "+    socket.emit(\"failed\");",
      "+    return;",
      "+  }",
      "+  const wait = backoff(attempt);",
      "+  log.warn(`retrying ${socket.url} in ${wait} ms (attempt ${attempt + 1} of ${MAX_ATTEMPTS})`);",
      "+  setTimeout(() => reconnect(socket, attempt + 1), wait);",
      " }",
      " ",
      " export function onClose(socket: Socket) {",
      "-  reconnect(socket);",
      "+  if (socket.intentional) return;",
      "+  reconnect(socket);",
      " }",
    ]),
  ] },
  { path: "src/net/reconnect.test.ts", hunks: [
    hunk(1, 1, [
      " import { describe, expect, it, vi } from \"vitest\";",
      "-import { reconnect } from \"./reconnect\";",
      "+import { backoff, reconnect, MAX_ATTEMPTS, MAX_WAIT } from \"./reconnect\";",
      " import { fakeSocket } from \"./testing\";",
      " ",
      "+describe(\"backoff\", () => {",
      "+  it(\"grows with each attempt\", () => {",
      "+    expect(backoff(3)).toBeGreaterThan(backoff(1));",
      "+  });",
      "+",
      "+  it(\"never passes the cap\", () => {",
      "+    expect(backoff(40)).toBeLessThanOrEqual(MAX_WAIT);",
      "+  });",
      "+});",
      "+",
      " describe(\"reconnect\", () => {",
      "-  it(\"retries\", () => {",
      "-    const socket = fakeSocket({ open: false });",
      "-    reconnect(socket);",
      "-    expect(socket.retries).toBe(1);",
      "-  });",
      "+  it(\"retries once the wait is over\", () => {",
      "+    vi.useFakeTimers();",
      "+    const socket = fakeSocket({ open: false });",
      "+    reconnect(socket);",
      "+    vi.runOnlyPendingTimers();",
      "+    expect(socket.retries).toBe(1);",
      "+  });",
      "+",
      "+  it(\"gives up after MAX_ATTEMPTS\", () => {",
      "+    const socket = fakeSocket({ open: false });",
      "+    reconnect(socket, MAX_ATTEMPTS);",
      "+    expect(socket.emitted).toContain(\"failed\");",
      "+  });",
      " });",
    ]),
  ] },
];

/** The diff renderer on invented files, with no frame: what a live window shows for this view. */
export function DiffDemo({ split, wrap, syntaxTheme, files }: DiffPreviewProps & { files?: DemoFile[] }) {
  // The hook reads the saved syntax theme once, at mount; the page's control moves after that.
  const { hilite, setThemePref } = useDiffHighlight("src/net/reconnect.ts");
  useEffect(() => { if (syntaxTheme) setThemePref(syntaxTheme); }, [syntaxTheme, setThemePref]);
  const list = useMemo(() => files ?? [{ path: "src/net/reconnect.ts", hunks: HUNKS }], [files]);
  return (
    <div data-preview="diff" className="flex flex-col gap-3 min-w-0">
      {list.map((f) => (
        <div key={f.path} className="rounded-lg overflow-x-auto overflow-y-hidden min-w-0" style={{ background: "var(--bg)", borderWidth: 1, borderStyle: "solid", borderColor: "var(--surface-line)" }}>
          <div className="px-3 py-1.5 text-[11px]" style={{ color: "var(--text3)", background: "var(--surface-nav)" }}>{f.path}</div>
          <HiliteCtx.Provider value={hilite}>
            {split ? <SplitDiff hunks={f.hunks} wrap={wrap} /> : <UnifiedDiff hunks={f.hunks} wrap={wrap} />}
          </HiliteCtx.Provider>
        </div>
      ))}
    </div>
  );
}

/** The real diff renderer on a small invented diff: Split or Inline, Wrap or scroll. */
export function DiffPreview(p: DiffPreviewProps) {
  return (
    <PreviewBox label="A diff, split or inline">
      <DiffDemo {...p} />
      <PreviewNote>The app's own diff view on an invented change.</PreviewNote>
    </PreviewBox>
  );
}
