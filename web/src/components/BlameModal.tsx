/*
 * Blame + file history — who wrote each line of a file, and the file's commit
 * trail (following renames). Read-only. Clicking a history entry reblames the
 * file as of that commit; clicking a blame line opens that commit's diff.
 */
import { useEffect, useMemo, useState } from "react";
import { GitDialog, DialogError, DialogSkeleton } from "./GitDialog.tsx";
import { UNREACHABLE } from "../lib/gitDialog.ts";
import { api } from "../lib/api.ts";
import { repoRelative } from "../lib/gitActions.ts";
import type { BlameLine, FileHistoryEntry } from "../../../shared/types.ts";
import { Button, EDGE, ListRow } from "./workspace/Chrome.tsx";

const SHORT = 7;

export function BlameModal({ root, path, onClose, onOpenCommit }: {
  root: string;
  path: string;
  onClose: () => void;
  onOpenCommit: (hash: string, subject: string) => void;
}) {
  const [lines, setLines] = useState<BlameLine[]>([]);
  const [history, setHistory] = useState<FileHistoryEntry[]>([]);
  const [at, setAt] = useState("HEAD");
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");

  const load = async (ref: string) => {
    setBusy(true);
    setError("");
    try {
      const b = await api.gitBlame(root, path, ref);
      if (!b.ok) { setError(b.error || "blame failed"); setLines([]); }
      else setLines(b.lines ?? []);
    } catch { setError(UNREACHABLE); setLines([]); }
    setBusy(false);
  };

  useEffect(() => { void load("HEAD"); }, [root, path]);
  useEffect(() => {
    api.gitFileHistory(root, path).then((h) => setHistory(h.entries ?? [])).catch(() => {});
  }, [root, path]);

  const bySha = useMemo(() => {
    const m = new Map<string, { author: string; subject: string; time: number }>();
    for (const l of lines) {
      if (l.sha && !m.has(l.sha)) m.set(l.sha, { author: l.author, subject: l.subject, time: l.time });
    }
    return m;
  }, [lines]);

  const reblame = async (fullHash: string, short: string) => {
    setAt(short);
    await load(fullHash);
  };

  const fmt = (t: number) => (t ? new Date(t * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "");

  return (
    <GitDialog title={repoRelative(root, path)} tone="neutral" width={920} cancelLabel="Close" onClose={onClose} initialFocus="none"
      reason="Read-only. A click on a line opens its commit."
      subtitle={<span className="inline-flex items-center gap-2">Who wrote each line, as of
        <span className="rounded px-1.5 py-px text-[10px] font-mono" style={{ color: "var(--info-ink)", border: "1px solid color-mix(in srgb, var(--info) 30%, transparent)" }}>{at}</span>
        {at !== "HEAD" && <Button size="compact" onClick={() => reblame("HEAD", "HEAD")}>back to HEAD</Button>}
      </span>}>
    <div className="flex gap-3" style={{ height: "clamp(220px, 56vh, 560px)" }}>
      {/* History — the file's commits; a click reblames as of it. */}
      <div className="w-72 shrink-0 min-h-0 flex flex-col rounded-lg" style={{ background: "color-mix(in srgb, var(--bg3) 30%, transparent)", border: EDGE }}>
        <div className="text-[9.5px] uppercase tracking-wider t-dim2 px-3 pt-2.5 pb-1 shrink-0">file history · click to reblame</div>
        <div className="agx-scroll flex-1 min-h-0 overflow-y-auto px-1.5 pb-2">
          {history.map((h) => (
            <ListRow key={h.fullHash} current={at === h.hash} onClick={() => reblame(h.fullHash, h.hash)}
              sub={<><span className="font-mono" style={{ color: "var(--info-ink)" }}>{h.hash}</span> · {h.author}</>}
              trailing={<span className="text-[9.5px]">{fmt(h.time)}</span>}>
              {h.subject}
            </ListRow>
          ))}
          {!history.length && !busy && <div className="text-[10.5px] t-dim2 px-2 py-2">no history</div>}
        </div>
      </div>

      {/* The blame itself. */}
      <div className="flex-1 min-h-0 flex flex-col rounded-lg" style={{ background: "color-mix(in srgb, var(--bg3) 30%, transparent)", border: EDGE }}>
        <div className="text-[9.5px] uppercase tracking-wider t-dim2 px-3 pt-2.5 pb-1 shrink-0">blame · click a line to open its commit</div>
        {busy ? (
          <div className="flex-1 p-3"><DialogSkeleton rows={4} label="Reading blame…" /></div>
        ) : error ? (
          <div className="flex-1 p-3"><DialogError message={error} onRetry={() => void load(at === "HEAD" ? "HEAD" : history.find((h) => h.hash === at)?.fullHash ?? "HEAD")} /></div>
        ) : (
          <div className="agx-scroll flex-1 min-h-0 overflow-y-auto px-1.5 pb-2 font-mono text-[10.5px] leading-[1.55]">
            {lines.map((l) => {
              const meta = l.sha ? bySha.get(l.sha) : null;
              return (
                <button key={l.line} onClick={() => { if (l.sha) onOpenCommit(l.sha, meta?.subject || ""); }}
                  className="w-full flex items-baseline gap-2 text-left rounded-sm hover:bg-[color-mix(in_srgb,var(--primary)_10%,transparent)]"
                  title={l.sha ? `${l.sha.slice(0, SHORT)} · ${meta?.subject ?? ""} · ${meta?.author ?? ""}` : "not yet committed"}>
                  <span className="shrink-0 w-7 text-right select-none" style={{ color: "var(--text3)" }}>{l.line}</span>
                  <span className="shrink-0 w-[4.6rem] truncate" style={{ color: l.sha ? "var(--info)" : "var(--warning)" }}>{l.sha ? l.sha.slice(0, SHORT) : "local"}</span>
                  <span className="shrink-0 w-20 truncate" style={{ color: "var(--text3)" }}>{meta?.author ?? ""}</span>
                  <span className="min-w-0 flex-1 truncate" style={{ color: "var(--text2)" }}>{l.content}</span>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
    </GitDialog>
  );
}
