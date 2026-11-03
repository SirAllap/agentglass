// Open several: what happened to each project (frame 12). A refused open keeps
// this panel up with the reason per project instead of one sentence at the
// bottom, and what can still be opened stays one button away.
import type { OpenRow } from "../../lib/projectPick.ts";
import { ICON } from "../../lib/iconSize.ts";
import { DoneIcon, WarningIcon } from "../../lib/glyphIcons.tsx";
import { middleSplit, tildify } from "../../lib/projectsPaths.ts";
import { Button, EDGE } from "../workspace/Chrome.tsx";
import { Foot, HAIR, Kbd, Status, PaneHead, Tile } from "./ui.tsx";

export function ResultPane({ rows, opened, busy, onRetry, onOpenReady, onBack }: {
  rows: readonly OpenRow[]; opened: boolean; busy: boolean; onRetry: () => void; onOpenReady: (paths: string[]) => void; onBack: () => void;
}) {
  const failed = rows.filter((r) => r.state === "fail").length;
  const ready = rows.filter((r) => r.state === "ready").map((r) => r.path);
  const title = opened ? `Opened ${rows.length} project${rows.length === 1 ? "" : "s"}` : failed ? `Could not open ${failed} of ${rows.length}` : `Opening ${rows.length} project${rows.length === 1 ? "" : "s"}`;
  return (
    <div className="flex flex-col flex-1 min-w-0 min-h-0">
      <PaneHead title={title} onBack={onBack} backDisabled={busy} />
      <div className="pm-px py-1.5 text-[11.5px] shrink-0" style={{ background: "color-mix(in srgb, var(--bg3) 40%, var(--surface-card))", color: "var(--text3)" }}>
        <b className="text-[10.5px] uppercase tracking-wide mr-2" style={{ color: "var(--text2)" }}>Result</b>
        {[[rows.filter((r) => r.state === "ok").length, "opened"], [failed, "failed"], [ready.length, "not opened"], [rows.filter((r) => r.state === "opening").length, "opening"]].filter(([n]) => n).map(([n, w]) => `${n} ${w}`).join(" · ")}
      </div>
      <div className="agx-scroll pm-mx mt-1 rounded-xl overflow-y-auto min-h-0" style={{ border: EDGE }} role="list">
        {rows.map((r) => {
          const hue = r.state === "ok" ? "success" : r.state === "fail" ? "error" : r.state === "ready" ? "muted" : "primary";
          const m = middleSplit(tildify(r.path));
          return (
            <div key={r.path} role="listitem" className="grid items-start gap-x-2.5 px-3 py-2.5" style={{ gridTemplateColumns: "22px minmax(0,1fr) auto", borderBottom: HAIR }}>
              <Tile hue={hue} spin={r.state === "opening"}>{r.state === "ok" ? <DoneIcon size={ICON.xs} /> : r.state === "fail" ? <WarningIcon size={ICON.xs} /> : <span className="inline-block w-3 h-3 rounded-full" style={{ border: "2px solid currentColor", borderTopColor: "transparent" }} />}</Tile>
              <span className="min-w-0">
                <b className="block text-[12.5px] truncate" title={r.path}>{r.path.split("/").pop()}</b>
                <span className="block font-mono text-[11px] truncate" style={{ color: "var(--text3)" }} title={r.path}>{m.head}{m.tail}</span>
                {r.why && <span className="block text-[11.5px] mt-1" style={{ color: "var(--error)", overflowWrap: "anywhere" }}>{r.why}</span>}
              </span>
              <Status hue={hue}>{r.state === "ok" ? "Opened" : r.state === "fail" ? "Failed" : r.state === "ready" ? "Not opened" : "Opening…"}</Status>
            </div>
          );
        })}
      </div>
      <span className="flex-1" />
      <Foot hint={<span><Kbd>Esc</Kbd> back</span>}>
        {failed > 0 && <Button onClick={onRetry} disabled={busy}>Retry all</Button>}
        {failed > 0 && ready.length > 0 && <Button tone="primary" disabled={busy} onClick={() => onOpenReady(ready)}>Open the {ready.length} that can</Button>}
        <Button onClick={onBack} disabled={busy}>Back to list</Button>
      </Foot>
    </div>
  );
}
