/*
 * Repo insights — the last N days of a repository's life: what happened (a
 * sentence and four numbers), when (day bars), who, where, and the changelog
 * those conventional-commit subjects would make. Read-only: nothing here
 * writes a ref, touches the tree or calls a remote.
 *
 * Two columns in one GitDialog frame: the left scrolls, the right keeps its
 * header (range, copy) and its footer in place while the list scrolls.
 */
import { useEffect, useMemo, useState } from "react";
import { GitDialog } from "./GitDialog.tsx";
import { DayBars, Legend } from "./insights/DayBars.tsx";
import { ChangelogPane } from "./insights/ChangelogPane.tsx";
import { api } from "../lib/api.ts";
import { UNREACHABLE } from "../lib/gitDialog.ts";
import { CommitIcon, WarningIcon, TerminalIcon, RefreshIcon } from "../lib/glyphIcons.tsx";
import { ICON, HIT } from "../lib/iconSize.ts";
import type { RepoStats, Changelog, GitRangeCounts } from "../../../shared/types.ts";
import { chartGeometry, fewDays, initials, renameNote, sentence, splitPath, splits, tiles, windowDays } from "../lib/insightsModel.ts";
import { EDGE } from "./workspace/Chrome.tsx";

const DAY_OPTS = [7, 30, 90];
const UP = "color-mix(in srgb, var(--success) 70%, transparent)";
const DOWN = "color-mix(in srgb, var(--error) 55%, transparent)";
const card = { background: "var(--surface-card)", border: EDGE } as const;

function Bar({ s }: { s: { addPct: number; delPct: number } }) {
  return <span className="flex h-1.5 rounded-full overflow-hidden" style={{ background: "var(--surface-inset)" }}><i style={{ width: `${s.addPct}%`, background: UP }} /><i style={{ width: `${s.delPct}%`, background: DOWN }} /></span>;
}
const Title = ({ children, sub }: { children: string; sub: string }) => <div className="mb-2 text-[12.5px] font-semibold" style={{ color: "var(--text)" }}>{children} <span className="font-normal" style={{ color: "var(--text3)" }}>· {sub}</span></div>;

function Blank({ icon, title, text, children }: { icon: React.ReactNode; title: string; text: string; children?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center text-center gap-2 py-14">
      <span className="grid place-items-center rounded-lg" aria-hidden style={{ width: 36, height: 36, color: "var(--text2)", background: "var(--surface-inset)" }}>{icon}</span>
      <div className="text-[14px] font-semibold" style={{ color: "var(--text)" }}>{title}</div>
      <div className="text-[12px] max-w-[34ch]" style={{ color: "var(--text3)" }}>{text}</div>
      {children}
    </div>
  );
}

export function InsightsModal({ root, onClose, onGoToChanges, onOpenLog }: { root: string; onClose: () => void; onGoToChanges?: () => void; onOpenLog?: () => void }) {
  const [days, setDays] = useState(30);
  const [stats, setStats] = useState<RepoStats | null>(null);
  const [changelog, setChangelog] = useState<Changelog | null>(null);
  const [counts, setCounts] = useState<GitRangeCounts | null>(null);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("HEAD");
  const [refs, setRefs] = useState<{ tags: string[]; branches: string[] }>({ tags: [], branches: [] });
  const [attempt, setAttempt] = useState(0);
  const [logAttempt, setLogAttempt] = useState(0);

  useEffect(() => {
    let live = true;
    setStats(null);
    api.gitRepoStats(root, days).then((s) => { if (live) setStats(s); }).catch(() => { if (live) setStats({ error: UNREACHABLE } as RepoStats); });
    return () => { live = false; };
  }, [root, days, attempt]);

  // The changelog is read apart from the stats: a damaged history may stop one and not the other.
  useEffect(() => {
    let live = true;
    setChangelog(null);
    api.gitChangelog(root, from, to).then((c) => { if (live) setChangelog(c); }).catch(() => { if (live) setChangelog({ from, to, sections: [], error: UNREACHABLE }); });
    return () => { live = false; };
  }, [root, from, to, logAttempt]);

  // Counts follow the tags, and a pick can come from a tag made since the window opened: read once per attempt, not on a poll.
  useEffect(() => {
    let live = true;
    api.gitRangeCounts(root).then((c) => { if (live) setCounts(c); }).catch(() => {});
    Promise.all([api.gitTags(root).catch(() => ({ tags: [] })), api.gitBranches(root).catch(() => ({ branches: [] }))])
      .then(([t, b]) => { if (live) setRefs({ tags: t.tags.map((x) => x.name), branches: b.branches.map((x) => x.name) }); });
    return () => { live = false; };
  }, [root, logAttempt]);

  const view = useMemo(() => stats && !stats.error && !stats.empty ? {
    s: sentence(stats), tiles: tiles(stats), few: fewDays(stats),
    chart: chartGeometry(windowDays(stats.churn, stats.days)),
    people: stats.topContributors.slice(0, 6), peopleBars: splits(stats.topContributors.slice(0, 6)),
    files: stats.hotspots.slice(0, 6), fileBars: splits(stats.hotspots.slice(0, 6)),
  } : null, [stats]);

  const unreachable = stats?.error === UNREACHABLE;
  const pane = (
    <ChangelogPane changelog={stats?.empty ? { from: "", to: "HEAD", sections: [], empty: true } : changelog} counts={counts} refs={refs} from={from} to={to}
      onFrom={setFrom} onTo={setTo} onRetry={() => setLogAttempt((a) => a + 1)} />
  );

  return (
    <GitDialog title="Insights" tone="neutral" width="min(1800px, 88vw)" flush cancelLabel="Close" onClose={onClose} initialFocus="none"
      icon={<CommitIcon size={ICON.lg} />}
      reason="Read-only. Nothing here writes a ref or calls a remote."
      subtitle={<span className="inline-flex items-center gap-2 flex-wrap">
        <span className="font-mono">{root.split("/").filter(Boolean).pop()}</span>
        <span role="group" aria-label="Window" className="inline-flex rounded-lg p-0.5" style={{ background: "var(--surface-inset)", border: EDGE }}>
          {DAY_OPTS.map((d) => (
            <button key={d} type="button" aria-pressed={d === days} onClick={() => setDays(d)} className="px-2 rounded-md text-[11.5px]"
              style={{ height: HIT - 6, color: d === days ? "var(--text)" : "var(--text3)", background: d === days ? "var(--surface-card)" : "transparent", boxShadow: d === days ? "var(--surface-lift)" : undefined }}>{d} days</button>
          ))}
        </span>
      </span>}>
      <div className="grid min-h-0 grid-cols-1 [@media(min-width:900px)]:grid-cols-[minmax(0,1fr)_minmax(380px,32%)]" style={{ height: "calc(100dvh - 48px - 130px)" }}>
        <div className="min-w-0 overflow-y-auto p-4 flex flex-col gap-3.5" tabIndex={-1}>
          {!stats ? (
            <div role="status" aria-label="Reading the log" className="flex flex-col gap-3.5">
              <div className="text-[13px]" style={{ color: "var(--text3)" }}>Reading the log…</div>
              <div className="grid grid-cols-4 gap-2">{[0, 1, 2, 3].map((i) => <div key={i} className="h-[62px] rounded-lg motion-safe:animate-pulse" style={{ background: "var(--surface-inset)" }} />)}</div>
              <div className="h-[150px] rounded-xl motion-safe:animate-pulse" style={{ background: "var(--surface-inset)" }} />
              <div className="grid grid-cols-2 gap-3">{[0, 1].map((i) => <div key={i} className="h-[180px] rounded-xl motion-safe:animate-pulse" style={{ background: "var(--surface-inset)" }} />)}</div>
            </div>
          ) : stats.empty ? (
            <Blank icon={<CommitIcon size={ICON.lg} />} title="No commits yet" text="This repository has no history to read. Make the first commit and this window fills in.">
              {onGoToChanges && <button type="button" onClick={() => { onClose(); onGoToChanges(); }} className="mt-1 px-3 rounded-lg text-[12px] font-medium" style={{ height: HIT, background: "var(--primary)", color: "var(--on-primary)" }}>Go to Changes</button>}
            </Blank>
          ) : stats.error ? (
            <div role="alert" className="rounded-xl p-4 flex flex-col gap-3" style={{ ...card, borderColor: "color-mix(in srgb, var(--error) 30%, transparent)" }}>
              <div className="flex items-start gap-3">
                <span className="grid shrink-0 place-items-center rounded-lg" aria-hidden style={{ width: 36, height: 36, color: "var(--error)", background: "color-mix(in srgb, var(--error) 10%, transparent)" }}><WarningIcon size={ICON.lg} /></span>
                <div>
                  <div className="text-[14px] font-semibold" style={{ color: "var(--text)" }}>{unreachable ? "The server could not be reached" : "The history could not be read"}</div>
                  <div className="text-[12px]" style={{ color: "var(--text3)" }}>{unreachable ? "Nothing was asked of git." : "Git stopped. Nothing was changed; the changelog on the right was read separately."}</div>
                </div>
              </div>
              {!unreachable && <pre className="m-0 whitespace-pre-wrap rounded-lg px-2.5 py-2 text-[11.5px] font-mono" style={{ background: "var(--surface-inset)", border: EDGE, color: "var(--text2)", overflowWrap: "anywhere" }}>{stats.error}</pre>}
              <div className="flex items-center gap-2">
                <button type="button" onClick={() => setAttempt((a) => a + 1)} className="inline-flex items-center gap-1.5 px-3 rounded-lg text-[12px] font-medium" style={{ height: HIT, background: "var(--primary)", color: "var(--on-primary)" }}><RefreshIcon size={ICON.sm} />Try again</button>
                {onOpenLog && !unreachable && <button type="button" onClick={onOpenLog} className="ml-auto inline-flex items-center gap-1.5 px-3 rounded-lg text-[12px] font-medium" style={{ height: HIT, border: EDGE, color: "var(--text2)" }}><TerminalIcon size={ICON.sm} />Open the command log</button>}
              </div>
            </div>
          ) : view && (
            <>
              <p className="m-0 text-[13px] leading-relaxed" style={{ color: "var(--text2)" }}>
                In the last {view.s.days} days <b style={{ color: "var(--text)" }}>{view.s.people}</b> made <b style={{ color: "var(--text)" }}>{view.s.commits}</b> {view.s.when}.
                {view.s.topFile && <> Most of it went into <b className="font-mono" style={{ color: "var(--text)" }}>{view.s.topFile}</b>.</>}
              </p>
              <div className="grid grid-cols-2 [@media(min-width:640px)]:grid-cols-4 gap-2">
                {view.tiles.map((t) => (
                  <div key={t.k} className="min-w-0 rounded-lg px-3 py-2.5" style={card}>
                    <div className="text-[11px]" style={{ color: "var(--text3)" }}>{t.k}</div>
                    <div className="text-[22px] font-semibold leading-tight tabular-nums" style={{ color: "var(--text)" }}>{t.v}</div>
                    {t.sub && <div className="text-[11px] font-mono truncate" style={{ color: "var(--text3)" }}>{t.sub}</div>}
                  </div>
                ))}
              </div>
              <div className="rounded-xl px-3.5 py-3" style={card}>
                <div className="flex items-center gap-2 mb-2"><span className="text-[12.5px] font-semibold" style={{ color: "var(--text)" }}>Lines added and removed, per day</span><span className="ml-auto"><Legend /></span></div>
                <DayBars chart={view.chart} />
                {view.few && <div className="mt-2 text-[11.5px]" style={{ color: "var(--text3)" }}>Only one day had commits, so there is no trend to draw yet.{days === 7 && <> <b>30 days</b> may show one.</>}</div>}
              </div>
              <div className="grid grid-cols-1 [@media(min-width:760px)]:grid-cols-2 gap-3">
                <div className="min-w-0 rounded-xl px-3.5 py-3" style={card}>
                  <Title sub="commits">Who did the work</Title>
                  {view.people.length === 0 && <div className="text-[11.5px]" style={{ color: "var(--text3)" }}>No commits in this window.</div>}
                  <div className="flex flex-col gap-2">
                    {view.people.map((c, i) => (
                      <div key={`${c.name}\x00${c.email}`} className="grid items-center gap-2.5 text-[12px]" style={{ gridTemplateColumns: "22px minmax(0,1fr) 64px auto" }} title={`+${c.added} −${c.deleted}`}>
                        <span aria-hidden className="grid place-items-center rounded-full text-[9.5px] font-semibold" style={{ width: 22, height: 22, background: "var(--surface-inset)", color: "var(--text2)" }}>{initials(c)}</span>
                        <span className="truncate" style={{ color: "var(--text)" }}>{c.name || c.email}</span>
                        <Bar s={view.peopleBars[i]} />
                        <span className="tabular-nums text-right" style={{ color: "var(--text2)" }}>{c.commits} commit{c.commits === 1 ? "" : "s"}</span>
                      </div>
                    ))}
                  </div>
                </div>
                <div className="min-w-0 rounded-xl px-3.5 py-3" style={card}>
                  <Title sub="most-touched files">Where the change lives</Title>
                  <div className="flex flex-col gap-2">
                    {view.files.map((h, i) => {
                      const { dir, file } = splitPath(h.path);
                      const note = renameNote(h);
                      return (
                        <div key={h.path} className="grid items-center gap-2.5 text-[12px]" style={{ gridTemplateColumns: "minmax(0,1fr) 48px auto" }}>
                          <span className="min-w-0 flex flex-col font-mono" title={h.path}>
                            {/* rtl + bdi: the head of a long path is what gets cut, the file name stays whole. */}
                            <span className="overflow-hidden whitespace-nowrap text-left" style={{ direction: "rtl", textOverflow: "ellipsis", color: "var(--text3)" }}><bdi style={{ color: "var(--text3)" }}>{dir}<span style={{ color: "var(--text)" }}>{file}</span></bdi></span>
                            {note && <span className="overflow-hidden whitespace-nowrap text-left text-[10.5px] font-sans" style={{ direction: "rtl", textOverflow: "ellipsis", color: "var(--text3)" }}><bdi>{note}</bdi></span>}
                          </span>
                          <Bar s={view.fileBars[i]} />
                          <span className="tabular-nums text-right text-[11.5px] font-mono" style={{ color: "var(--text3)" }}>{h.commits}c · <span style={{ color: "var(--success)" }}>+{h.added}</span> <span style={{ color: "var(--error)" }}>−{h.deleted}</span></span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            </>
          )}
        </div>
        <div className="min-h-0 min-w-0 [@media(min-width:900px)]:border-l" style={{ borderColor: "var(--surface-line)" }}>{pane}</div>
      </div>
    </GitDialog>
  );
}
