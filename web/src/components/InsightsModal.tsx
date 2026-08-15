/*
 * Repo insights — the last N days of a repository's life: commit pace, who
 * did the work, where the churn concentrated, and the changelog those
 * conventional-commit subjects would make. Read-only: nothing here writes a
 * ref, touches the tree or calls a remote.
 */
import { useEffect, useMemo, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import { Portal } from "./Portal.tsx";
import { CloseButton } from "./CloseButton.tsx";
import { api } from "../lib/api.ts";
import type { RepoStats, Changelog, ChangelogEntry } from "../../../shared/types.ts";

const DAY_OPTS = [7, 30, 90];

/** A compact area sparkline — the churn series. */
function Spark({ values, color }: { values: number[]; color: string }) {
  const w = 150, h = 36;
  if (values.length < 2) return null;
  const max = Math.max(...values, 1e-9);
  const step = w / (values.length - 1);
  const pts = values.map((v, i) => [i * step, h - (v / max) * (h - 6) - 3] as const);
  const line = pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const area = `${line} ${w},${h} 0,${h}`;
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className="shrink-0" aria-hidden>
      <polygon points={area} fill={`color-mix(in srgb, ${color} 16%, transparent)`} />
      <polyline points={line} fill="none" stroke={color} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function Stat({ k, v, sub }: { k: string; v: string | number; sub?: string }) {
  return (
    <div className="min-w-0 rounded-lg p-3" style={{ background: "color-mix(in srgb, var(--bg3) 40%, transparent)", border: "1px solid color-mix(in srgb, var(--border) 30%, transparent)" }}>
      <div className="text-[9.5px] uppercase tracking-wider t-dim2 truncate">{k}</div>
      <div className="text-[20px] font-semibold leading-none tabular-nums mt-1" style={{ color: "var(--text)" }}>{v}</div>
      {sub && <div className="text-[10px] t-dim2 mt-1 truncate">{sub}</div>}
    </div>
  );
}

function Entry({ e }: { e: ChangelogEntry }) {
  return (
    <li className="flex items-baseline gap-2 text-[11.5px] leading-relaxed">
      <span className="shrink-0 font-mono text-[9.5px] t-dim2">{e.hash}</span>
      {e.scope && <span className="shrink-0 rounded px-1 text-[9.5px] font-mono" style={{ color: "var(--info)", border: "1px solid color-mix(in srgb, var(--info) 30%, transparent)" }}>{e.scope}</span>}
      <span className="min-w-0" style={{ color: "var(--text)" }}>{e.subject}</span>
    </li>
  );
}

export function InsightsModal({ root, onClose }: { root: string; onClose: () => void }) {
  const [days, setDays] = useState(30);
  const [stats, setStats] = useState<RepoStats | null>(null);
  const [changelog, setChangelog] = useState<Changelog | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(true);

  useEffect(() => {
    let live = true;
    setBusy(true);
    api.gitRepoStats(root, days).then((s) => { if (live) { setStats(s); setBusy(false); } }).catch(() => { if (live) setBusy(false); });
    api.gitChangelog(root).then((c) => { if (live) setChangelog(c); }).catch(() => {});
    return () => { live = false; };
  }, [root, days]);

  const markdown = useMemo(() => {
    if (!changelog?.sections.length) return "";
    const head = changelog.from ? `# Changelog ${changelog.from}..${changelog.to}` : `# Changelog (to ${changelog.to})`;
    const body = changelog.sections.map((s) => `## ${s.title}\n\n${s.entries.map((e) => `- ${e.scope ? `**${e.scope}:** ` : ""}${e.subject} (${e.hash})`).join("\n")}`).join("\n\n");
    return `${head}\n\n${body}\n`;
  }, [changelog]);

  const copy = async () => {
    try { await navigator.clipboard.writeText(markdown); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* clipboard unavailable */ }
  };

  const churn = (stats?.churn ?? []).map((d) => d.added - d.deleted);
  const totalCommits = (stats?.churn ?? []).reduce((s, d) => s + d.commits, 0);

  return (
    <Portal>
      <AnimatePresence>
        <motion.div className="fixed inset-0 z-[90] flex items-center justify-center p-4" style={{ background: "color-mix(in srgb, #000 45%, transparent)" }} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
          <motion.div
            className="agx-scroll relative w-full max-w-2xl max-h-[85vh] overflow-y-auto rounded-2xl p-5"
            style={{ background: "var(--bg2)", border: "1px solid var(--border)", boxShadow: "0 24px 80px rgba(0,0,0,.5)" }}
            initial={{ opacity: 0, scale: .97, y: 8 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: .97, y: 8 }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-3 mb-4">
              <h3 className="text-[13px] font-semibold" style={{ color: "var(--text)" }}>Repo insights</h3>
              <div className="flex items-center gap-1 ml-1">
                {DAY_OPTS.map((d) => (
                  <button key={d} onClick={() => setDays(d)} className="text-[10px] px-2 py-0.5 rounded-md" style={d === days ? { background: "color-mix(in srgb, var(--primary) 25%, transparent)", color: "var(--text)", border: "1px solid color-mix(in srgb, var(--primary) 45%, transparent)" } : { color: "var(--text2)", border: "1px solid color-mix(in srgb, var(--border) 40%, transparent)" }}>{d}d</button>
                ))}
              </div>
              <CloseButton onClick={onClose} />
            </div>

            {busy && !stats ? (
              <div className="py-10 text-center text-[11.5px] t-dim2">Reading the log…</div>
            ) : stats?.error ? (
              <div className="py-10 text-center text-[11.5px]" style={{ color: "var(--error)" }}>{stats.error}</div>
            ) : (
              <div className="space-y-5">
                <div className="grid grid-cols-4 gap-2">
                  <Stat k="commits" v={totalCommits} sub={`${stats?.commitsPerDay ?? 0}/day avg`} />
                  <Stat k="contributors" v={stats?.contributors.length ?? 0} />
                  <Stat k="files touched" v={stats?.filesTouched ?? 0} />
                  <Stat k="lines changed" v={stats?.linesChanged ?? 0} sub={`${((stats?.linesChanged ?? 0) / Math.max(1, totalCommits)).toFixed(0)}/commit`} />
                </div>

                {(stats?.churn.length ?? 0) > 1 && (
                  <div className="flex items-center gap-4 rounded-lg p-3" style={{ background: "color-mix(in srgb, var(--bg3) 40%, transparent)", border: "1px solid color-mix(in srgb, var(--border) 30%, transparent)" }}>
                    <div className="min-w-0 flex-1">
                      <div className="text-[9.5px] uppercase tracking-wider t-dim2 mb-1">net line churn by day</div>
                      <div className="flex items-center gap-3">
                        <Spark values={churn} color={stats && (stats.linesChanged ?? 0) > 0 ? "var(--info)" : "var(--text3)"} />
                        <span className="text-[10px] t-dim2 whitespace-nowrap">green-heavy days add lines; dips delete</span>
                      </div>
                    </div>
                  </div>
                )}

                <div>
                  <div className="text-[9.5px] uppercase tracking-wider t-dim2 mb-1.5">top contributors</div>
                  <div className="space-y-1">
                    {(stats?.topContributors ?? []).map((c, i) => (
                      <div key={`${c.name}\x00${c.email}`} className="flex items-center gap-2 text-[11.5px]">
                        <span className="w-4 shrink-0 text-right tabular-nums t-dim2 text-[10px]">{i + 1}</span>
                        <span className="min-w-0 flex-1 truncate" style={{ color: "var(--text)" }}>{c.name || c.email}</span>
                        <span className="shrink-0 tabular-nums" style={{ color: "var(--text2)" }}>{c.commits} commit{c.commits === 1 ? "" : "s"}</span>
                        <span className="shrink-0 tabular-nums w-20 text-right" style={{ color: c.added >= c.deleted ? "var(--success)" : "var(--error)" }}>+{c.added} −{c.deleted}</span>
                      </div>
                    ))}
                    {!stats?.topContributors.length && <div className="text-[11px] t-dim2">no commits in this window</div>}
                  </div>
                </div>

                {!!stats?.hotspots.length && (
                  <div>
                    <div className="text-[9.5px] uppercase tracking-wider t-dim2 mb-1.5">hotspots — where the churn lives</div>
                    <div className="space-y-1">
                      {stats.hotspots.map((h) => (
                        <div key={h.path} className="flex items-center gap-2 text-[11px]">
                          <span className="min-w-0 flex-1 truncate font-mono text-[10.5px]" style={{ color: "var(--text2)" }}>{h.path}</span>
                          <span className="shrink-0 tabular-nums t-dim2">{h.commits}c</span>
                          <span className="shrink-0 tabular-nums w-20 text-right" style={{ color: "var(--text2)" }}>+{h.added} −{h.deleted}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                <div>
                  <div className="flex items-center gap-3 mb-1.5">
                    <span className="text-[9.5px] uppercase tracking-wider t-dim2">changelog</span>
                    {changelog?.from && <span className="text-[10px] font-mono t-dim2">{changelog.from} → {changelog.to}</span>}
                    {markdown && (
                      <button onClick={copy} className="ml-auto text-[10px] px-2 py-0.5 rounded" style={{ color: copied ? "var(--success)" : "var(--text2)", border: "1px solid color-mix(in srgb, var(--border) 40%, transparent)" }}>{copied ? "copied" : "copy markdown"}</button>
                    )}
                  </div>
                  {changelog?.error ? (
                    <div className="text-[11px]" style={{ color: "var(--error)" }}>{changelog.error}</div>
                  ) : changelog?.sections.length ? (
                    <div className="space-y-3">
                      {changelog.sections.map((s) => (
                        <div key={s.title}>
                          <div className="text-[11px] font-semibold mb-1" style={{ color: s.title === "Breaking changes" ? "var(--error)" : "var(--text)" }}>{s.title} <span className="t-dim2 font-normal">({s.entries.length})</span></div>
                          <ul className="space-y-0.5">
                            {s.entries.map((e, i) => <Entry key={i} e={e} />)}
                          </ul>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="text-[11px] t-dim2">no conventional-commits subjects in range</div>
                  )}
                </div>
              </div>
            )}
          </motion.div>
        </motion.div>
      </AnimatePresence>
    </Portal>
  );
}
