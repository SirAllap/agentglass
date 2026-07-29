import { useMemo, useState } from "react";
import { Screen } from "./mobileUi.tsx";
import type { DiffHunk } from "../../../shared/types.ts";
// One rule for which file a line number lives in, shared with the draft that
// stores the remark, so the renderer and the payload cannot disagree.
import { sideFor } from "./reviewDraft.ts";

/**
 * A diff you can actually read on a phone.
 *
 * Everyone says this cannot be done, and it can — but only by giving up the
 * right things rather than shrinking the desktop one:
 *
 *   · Unified, always. Two columns on a 390px screen gives each side twenty
 *     characters, which is not reading, it is guessing.
 *   · Wrapped by default, with a hanging indent, so a line that ran on is
 *     never mistaken for a new one. Scrolling is one tap away for the times
 *     you need to see the real shape of the code.
 *   · A `+` / `−` glyph as well as the tint. At 11.5px, outdoors, in one hand,
 *     colour alone is not a signal you can rely on — and it is no signal at
 *     all to a good number of people.
 *   · Prev / next file in the footer, because the alternative is going back to
 *     a list and finding your place in it again.
 */
export const DIFF_CSS = `
.mb-diff{font-size:11.5px;line-height:1.62;border-radius:14px;overflow:hidden;
  border:1px solid color-mix(in srgb,var(--border) 32%,transparent);
  background:color-mix(in srgb,#000 30%,transparent)}
.mb-dl{display:flex;width:100%;text-align:left;align-items:flex-start;background:transparent}
/* Only where a line is a control. A diff has to stay dense to be readable at
   all — 44px a line shows eighteen of them, which is not reading code — so this
   buys what it can without turning the screen into a list. What actually makes
   a mis-tap survivable is the sheet: it opens naming the file, the line and
   which side of the diff it is, before anything has been written. */
button.mb-dl{padding:3px 0}
.mb-dl .g{flex:none;width:34px;padding:1px 7px 1px 0;text-align:right;color:var(--text4);opacity:.5;
  user-select:none;font-size:10px;font-variant-numeric:tabular-nums}
.mb-dl .s{flex:none;width:12px;user-select:none;opacity:.9}
.mb-dl .c{flex:1;min-width:0;padding-right:9px;white-space:pre-wrap;overflow-wrap:break-word;
  text-indent:-1.6ch;padding-left:1.6ch}
.mb-diff.nowrap{overflow-x:auto}
.mb-diff.nowrap .c{white-space:pre;overflow-wrap:normal;text-indent:0;padding-left:0}
.mb-diff.nowrap .mb-dl{min-width:max-content}
.mb-dl.add{background:color-mix(in srgb,var(--success) 13%,transparent)}
.mb-dl.add .g,.mb-dl.add .s{color:var(--success);opacity:.95}
.mb-dl.del{background:color-mix(in srgb,var(--error) 12%,transparent)}
/* A line you have already said something about. The marker is on the gutter
   rather than the whole row so it reads against an added line's green and a
   deleted line's red alike. */
.mb-dl.said{background:color-mix(in srgb,var(--primary) 17%,transparent)}
.mb-dl.said .g{color:var(--primary-hover);opacity:1;font-weight:700}
.mb-dl.said .g::after{content:"●";font-size:7px;vertical-align:top;margin-left:2px}
.mb-dl.del .g,.mb-dl.del .s{color:var(--error);opacity:.95}
.mb-dl.hdr{background:color-mix(in srgb,var(--primary) 10%,transparent);color:var(--text4);
  font-size:10.5px;padding:4px 0}
`;

type Line = { kind: "ctx" | "add" | "del" | "hdr"; n: string; text: string };


/** Anything carrying hunks: a working-tree change or a parsed pull request
 *  diff. Both already speak this shape, so neither needs translating. */
export type Hunked = { hunks: DiffHunk[] };

/** Flatten hunks into the one column this screen shows. */
function toLines(f: Hunked | undefined): Line[] {
  if (!f?.hunks?.length) return [];
  const out: Line[] = [];
  for (const h of f.hunks) {
    out.push({ kind: "hdr", n: "", text: `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@` });
    let oldN = h.oldStart, newN = h.newStart;
    for (const raw of h.lines) {
      const c = raw[0];
      if (c === "+") out.push({ kind: "add", n: String(newN++), text: raw.slice(1) });
      else if (c === "-") out.push({ kind: "del", n: String(oldN++), text: raw.slice(1) });
      else { out.push({ kind: "ctx", n: String(newN), text: raw.slice(1) }); oldN++; newN++; }
    }
  }
  return out;
}

export function MobileDiff({ open, file, files, index, onIndex, onBack, onLine, markOn, extra }: {
  open: boolean;
  file: Hunked | undefined;
  /** Paths in order, for prev/next and for the "3 of 11" the footer shows. */
  files: string[];
  index: number;
  onIndex: (i: number) => void;
  onBack: () => void;
  /**
   * Tapping a line — a review comment on a pull request, nothing on a working
   * tree diff, where the line has no stable identity to hang a comment on.
   *
   * The side is not decoration, it is half the address: a deleted line is
   * numbered in the old file and everything else in the new one, so `(path,
   * line)` alone is ambiguous and resolving it the wrong way puts the remark on
   * unrelated code. This handed over only `(path, line)` for as long as nothing
   * passed it — see reviewDraft.ts.
   */
  onLine?: (path: string, line: number, side: "LEFT" | "RIGHT") => void;
  /** How many remarks are already queued on a given line, so a line you have
   *  annotated looks different from one you have not. */
  markOn?: (path: string, line: number, side: "LEFT" | "RIGHT") => boolean;
  extra?: React.ReactNode;
}) {
  const [wrap, setWrap] = useState(true);
  const path = files[index] ?? "";
  const lines = useMemo(() => toLines(file), [file]);
  const name = path.split("/").pop() || path;
  const dir = path.slice(0, path.length - name.length).replace(/\/$/, "");

  return (
    <Screen
      open={open} title={name} sub={dir || undefined} onBack={onBack}
      right={
        <button className="mb-press" style={{ minHeight: 42, padding: "0 11px", fontSize: 11, color: "var(--primary-hover)", background: "transparent" }}
          onClick={() => setWrap((w) => !w)}>{wrap ? "Wrap" : "Scroll"}</button>
      }
      foot={files.length > 1 ? (
        <>
          <button className="mb-btn sm mb-press" onClick={() => onIndex((index - 1 + files.length) % files.length)}>‹ Prev</button>
          <span className="flex-1 text-center text-[10.5px] mb-tnum" style={{ color: "var(--text3)" }}>
            File {index + 1} of {files.length}
          </span>
          <button className="mb-btn sm mb-press" onClick={() => onIndex((index + 1) % files.length)}>Next ›</button>
        </>
      ) : undefined}
    >
      {lines.length === 0 ? (
        <div className="mb-empty"><div className="g">◇</div><b>No textual diff</b>
          <span>Binary, renamed, or too large to show.</span></div>
      ) : (
        <div className={`mb-diff${wrap ? "" : " nowrap"}`}>
          {lines.map((l, i) => {
            const sign = l.kind === "add" ? "+" : l.kind === "del" ? "−" : " ";
            if (l.kind === "hdr") {
              return <div key={i} className="mb-dl hdr"><span className="g" /><span className="s" /><span className="c">{l.text}</span></div>;
            }
            const body = <><span className="g">{l.n}</span><span className="s">{sign}</span><span className="c">{l.text}</span></>;
            if (!onLine) return <div key={i} className={`mb-dl ${l.kind}`}>{body}</div>;
            const n = Number(l.n) || 0;
            const side = sideFor(l.kind);
            const said = markOn?.(path, n, side) ?? false;
            return (
              <button key={i} className={`mb-dl ${l.kind} mb-press${said ? " said" : ""}`}
                onClick={() => onLine(path, n, side)}>{body}</button>
            );
          })}
        </div>
      )}
      {extra && <div className="flex gap-2 flex-wrap mt-3">{extra}</div>}
      <p className="mt-3 text-[10.5px] leading-relaxed" style={{ color: "var(--text3)" }}>
        {onLine ? "Tap a line to comment on it. " : ""}
        <b style={{ color: "var(--text2)" }}>Wrap</b> trades sideways scrolling for taller lines.
      </p>
    </Screen>
  );
}

/** Shared by the pull request and the working tree: one row per file, its size,
 *  and a switch for the state you are keeping about it. */
export function FileRow({ path, add, del, note, on, onToggle, switchLabel, onOpen }: {
  path: string; add: number; del: number; note?: string;
  on: boolean; onToggle: () => void; switchLabel: string; onOpen: () => void;
}) {
  return (
    <div className="mb-row" style={{ padding: 13 }}>
      <button className="mb-press flex items-center gap-3 min-w-0 flex-1 text-left self-stretch" style={{ background: "transparent" }} onClick={onOpen}>
        <span className="i">
          <b>{path}</b>
          {note && <span>{note}</span>}
        </span>
        <span className="r mb-tnum">
          <i className="not-italic block" style={{ color: "var(--success)" }}>+{add}</i>
          <i className="not-italic block" style={{ color: "var(--error)" }}>−{del}</i>
        </span>
      </button>
      <button className="mb-sw mb-press" data-on={on ? "1" : "0"} role="switch" aria-checked={on}
        aria-label={switchLabel} onClick={onToggle} />
    </div>
  );
}

