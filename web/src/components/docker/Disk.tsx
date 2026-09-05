/*
 * Where the disk went, and what is safe to take back.
 *
 * Docker's own answer to this is `docker system df`, which is four numbers and
 * no advice. The advice is the whole point: on a machine like this one the
 * piles are wildly different in what they cost to lose, and a panel that offers
 * them as three identical buttons is worse than no panel — it makes a reclaim
 * that costs one slower build look exactly like one that hands every worktree a
 * cold install.
 *
 * So every button here says what it takes and what that costs, and the
 * dangerous one is not a button at all: it is a sentence explaining why, with
 * the command, for somebody who has decided anyway.
 */
import { useCallback, useEffect, useState } from "react";
import type { DockerDisk } from "../../../../shared/types.ts";
import { api } from "../../lib/api.ts";
import { humanSize } from "../../lib/dockerVolumeView.ts";

const SLICES: { key: keyof Pick<DockerDisk, "images" | "containers" | "volumes" | "buildCache">; label: string; tint: string }[] = [
  { key: "images", label: "images", tint: "var(--primary)" },
  { key: "volumes", label: "volumes", tint: "var(--phone)" },
  { key: "buildCache", label: "build cache", tint: "var(--warning)" },
  { key: "containers", label: "containers", tint: "var(--text3)" },
];

export function Disk({ writeEnabled, ask, onDone }: {
  writeEnabled: boolean;
  ask: (o: { title: string; body?: string; confirmLabel?: string; danger?: boolean }) => Promise<boolean>;
  onDone: (ok: boolean, msg: string) => void;
}) {
  const [d, setD] = useState<(DockerDisk & { error?: string }) | null>(null);
  /* What is running, in words. A boolean was enough to disable the buttons and
     not enough to tell anybody why: removing 25 images is 25 sequential
     `docker image rm` calls and takes the better part of a minute, during which
     the old figures are still on screen. Dimmed buttons and stale numbers read
     exactly like a click that did nothing. */
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async (force = false) => {
    setD(await api.dockerDisk(force).catch((e) => ({ error: String(e) } as DockerDisk & { error?: string })));
  }, []);

  // Once, on opening. `system df -v` makes the daemon walk every layer on the
  // machine: it is a number you read, not one you watch.
  useEffect(() => { void load(); }, [load]);

  const total = d && !d.error ? d.images + d.volumes + d.buildCache + d.containers : 0;
  const orphanBytes = (d?.orphans ?? []).reduce((n, o) => n + (o.bytes ?? 0), 0);

  /** The budget the cache is kept under. Measured: everything touched in the
   *  last few days fits well inside it, and what does not fit is what has not
   *  been used in months. */
  const BUDGET = 60_000_000_000;

  const capCache = async () => {
    const over = d && !d.error ? Math.max(0, d.buildCache - BUDGET) : 0;
    const ok = await ask({
      title: `Keep the build cache under ${humanSize(BUDGET)}?`,
      // The consequence, in the words of what it costs — not "are you sure".
      body: `About ${humanSize(over)} goes, oldest-used first. Nothing breaks: the next build that would have reused one of those layers is slower, once. `
        + "Everything you have built with recently stays, and no image, volume or container is touched.",
      confirmLabel: "Keep it under",
    });
    if (!ok) return;
    setBusy(`pruning the build cache down to ${humanSize(BUDGET)}…`);
    const r = await api.dockerPruneCache(BUDGET);
    setBusy(null);
    onDone(r.ok, r.ok ? (r.output || "pruned") : (r.error || "docker refused"));
    void load(true);
  };

  const dropOrphans = async () => {
    if (!d?.orphans.length) return;
    const ok = await ask({
      title: `Remove ${d.orphans.length} image${d.orphans.length === 1 ? "" : "s"} from worktrees that are gone?`,
      body: `${d.orphans.map((o) => o.tag).slice(0, 6).join(", ")}${d.orphans.length > 6 ? `, and ${d.orphans.length - 6} more` : ""}. `
        + `About ${humanSize(orphanBytes)}. Each was built for a checkout that no longer exists on this machine, and nothing is using them — `
        + "rebuilding one means checking that branch out again.",
      confirmLabel: "Remove them",
      danger: true,
    });
    if (!ok) return;
    setBusy(`removing ${d.orphans.length} image${d.orphans.length === 1 ? "" : "s"}, one at a time…`);
    const r = await api.dockerRemoveImages(d.orphans.map((o) => o.tag));
    setBusy(null);
    onDone(r.ok, r.ok ? (r.output || "removed") : (r.error || "docker refused"));
    void load(true);
  };

  if (!d) return <div className="flex-1 grid place-items-center t-dim2 text-[12px]"><span className="agx-spin" aria-hidden="true" /></div>;
  if (d.error) return <div className="flex-1 grid place-items-center t-dim2 text-[12px] px-6 text-center">{d.error}</div>;

  return (
    <div className="agx-scroll flex-1 min-h-0 overflow-auto p-4 flex flex-col gap-4">
      <div>
        <div className="flex items-baseline gap-2 mb-1.5">
          <span className="text-[12px]" style={{ color: "var(--text)" }}>{humanSize(total)}</span>
          <span className="text-[10px] t-dim2">on this machine</span>
          {d.reclaimable > 0 && (
            <span className="text-[10px] ml-auto" style={{ color: "var(--success)" }}>{humanSize(d.reclaimable)} reclaimable</span>
          )}
        </div>
        <div className="h-2 rounded-full overflow-hidden flex" style={{ background: "var(--bg3)" }}>
          {SLICES.map((s) => {
            const w = total ? (d[s.key] / total) * 100 : 0;
            return w > 0.2 ? <i key={s.key} title={`${s.label}: ${humanSize(d[s.key])}`} style={{ width: `${w}%`, background: s.tint }} /> : null;
          })}
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2 text-[10px]" style={{ color: "var(--text3)" }}>
          {SLICES.map((s) => (
            <span key={s.key} className="flex items-center gap-1.5">
              <i className="w-2 h-2 rounded-full" style={{ background: s.tint }} />
              {s.label} <span className="tabular-nums" style={{ color: "var(--text2)" }}>{humanSize(d[s.key])}</span>
            </span>
          ))}
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <span className="text-[10px] uppercase tracking-wider t-dim2">Reclaim</span>
          {busy && (
            <span className="flex items-center gap-1.5 text-[10px]" style={{ color: "var(--primary-hover)" }}>
              <span className="agx-spin" aria-hidden="true" />
              {busy}
              {/* Said out loud because docker gives no progress of its own and
                  the figures above stay stale until it finishes. */}
              <span className="t-dim2">the numbers below refresh when it is done</span>
            </span>
          )}
        </div>

        <button onClick={capCache} disabled={!writeEnabled || !!busy || d.buildCache <= BUDGET}
          className="text-left px-3 py-2 rounded-lg disabled:opacity-40"
          style={{ border: "1px solid color-mix(in srgb, var(--primary) 35%, transparent)", background: "color-mix(in srgb, var(--primary) 7%, transparent)" }}>
          <span className="text-[11.5px]" style={{ color: "var(--primary-hover)" }}>
            Keep the build cache under {humanSize(BUDGET)}
          </span>
          <span className="block text-[10px] t-dim2">
            {d.buildCache > BUDGET
              ? `${humanSize(d.buildCache - BUDGET)} goes, least recently used first. One build is slower; nothing else changes.`
              : `${humanSize(d.buildCache)} in cache — already under the budget.`}
          </span>
        </button>

        {d.orphans.length > 0 && (
          <button onClick={dropOrphans} disabled={!writeEnabled || !!busy}
            className="text-left px-3 py-2 rounded-lg disabled:opacity-40"
            style={{ border: "1px solid color-mix(in srgb, var(--warning) 35%, transparent)", background: "color-mix(in srgb, var(--warning) 7%, transparent)" }}>
            <span className="text-[11.5px]" style={{ color: "var(--warning)" }}>
              {d.orphans.length} image{d.orphans.length === 1 ? "" : "s"} from worktrees that are gone · {humanSize(orphanBytes)}
            </span>
            <span className="block text-[10px] t-dim2 break-all">{d.orphans.map((o) => o.tag).slice(0, 4).join(", ")}{d.orphans.length > 4 ? "…" : ""}</span>
          </button>
        )}

        {/* Not a button, on purpose. This is the one everybody reaches for and
            the one that costs other people their afternoon. */}
        <div className="px-3 py-2 rounded-lg text-[10px]" style={{ border: "1px dashed color-mix(in srgb, var(--border) 60%, transparent)", color: "var(--text3)" }}>
          <span style={{ color: "var(--text2)" }}>No “prune volumes” button here.</span> It frees a few gigabytes and takes every
          <code className="mx-1" style={{ color: "var(--text2)" }}>node_modules</code> volume with it — a cold install for every worktree on this machine, all at once.
          If you have decided anyway: <code style={{ color: "var(--text2)" }}>docker volume prune</code>.
        </div>

        {!writeEnabled && <span className="text-[10px] t-dim2">This instance is read-only, so the buttons are off.</span>}
      </div>
    </div>
  );
}
