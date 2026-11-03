// The "On GitHub" shelf of the Open projects list, and the refresh behind it.
//
// A remote row is a tick box, a cloud tile, a name, one sub line, a Read-only
// chip and Forget, each in a slot of fixed width so hovering or ticking moves
// nothing. A problem is a state of the row, never a reason to remove it: a repo
// that stopped answering keeps its last counts, and one GitHub says is gone
// stays until the person forgets it.
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { api } from "../lib/api.ts";
import { ICON } from "../lib/iconSize.ts";
import {
  findRemote, forgetRemoteStored, mergeAnswer, remoteRepos, rowState, saveRemotes, subscribeRemotes, tickRemote, tickedRemotes,
  type RemoteRepo, type RowState,
} from "../lib/remoteRepos.ts";
import { EDGE } from "./workspace/Chrome.tsx";
import { RIcon } from "./remoteIcons.tsx";

/** Counts older than this are asked again when the dialog opens. */
const STALE_MS = 10 * 60_000;
/** An entry this young is "just added": it shows the check while it runs. */
const JUST_ADDED_MS = 20_000;

export const useRemoteList = (): RemoteRepo[] => useSyncExternalStore(subscribeRemotes, remoteRepos, () => []);
export const useRemoteTicks = (): string[] => useSyncExternalStore(subscribeRemotes, tickedRemotes, () => []);

/**
 * Refresh what is stale, one repository at a time, when the dialog opens; and
 * hand out `refresh` for Retry. Sequential on purpose: thirty rows must not be
 * thirty `gh` processes at once (the server also caches a success for 60 s).
 */
export function useRemoteRefresh(active: boolean) {
  const [checking, setChecking] = useState<ReadonlySet<string>>(new Set());
  const [unreachable, setUnreachable] = useState<ReadonlySet<string>>(new Set());
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  const mark = (set: (f: (s: ReadonlySet<string>) => ReadonlySet<string>) => void, repo: string, on: boolean) =>
    set((s) => { const n = new Set(s); if (on) n.add(repo.toLowerCase()); else n.delete(repo.toLowerCase()); return n; });

  const refresh = async (repo: string, fresh: boolean) => {
    mark(setChecking, repo, true);
    try {
      const a = await api.ghRepoLookup(repo, fresh);
      const cur = findRemote(remoteRepos(), repo);
      if (cur) saveRemotes(remoteRepos().map((r) => (r === cur ? mergeAnswer(r, a, Date.now()) : r)));
      if (alive.current) mark(setUnreachable, repo, !a.found && (a.error === "unreachable" || a.error === "gh-missing" || a.error === "gh-not-signed-in"));
    } catch {
      if (alive.current) mark(setUnreachable, repo, true);
    } finally {
      if (alive.current) mark(setChecking, repo, false);
    }
  };

  useEffect(() => {
    if (!active) return;
    let stop = false;
    void (async () => {
      const now = Date.now();
      for (const r of remoteRepos().filter((x) => !x.gone && (now - x.lastSeen > STALE_MS || now - x.addedAt < JUST_ADDED_MS))) {
        if (stop) return;
        await refresh(r.repo, false);
      }
    })();
    return () => { stop = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  return { checking, unreachable, refresh };
}

const ago = (t: number): string => {
  const m = Math.max(0, Math.round((Date.now() - t) / 60_000));
  return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
};

const subLine = (r: RemoteRepo, s: RowState): string => {
  const prs = r.openPrs !== undefined ? `${r.openPrs} open pull request${r.openPrs === 1 ? "" : "s"}` : "";
  const priv = r.private ? "private" : "";
  if (s === "checking") return "Checking GitHub…";
  if (s === "gone") return "GitHub no longer finds this repository";
  if (s === "unreachable") return ["GitHub unreachable", `last seen ${ago(r.lastSeen)}`, r.openPrs !== undefined ? `${r.openPrs} PRs` : ""].filter(Boolean).join(" · ");
  if (s === "no-access") return ["This sign-in can no longer read it", prs].filter(Boolean).join(" · ");
  return ["GitHub only", prs, priv].filter(Boolean).join(" · ");
};

const CSS = `
.agx-rr .rr-forget{opacity:0}
.agx-rr:hover .rr-forget,.agx-rr:focus-within .rr-forget,.agx-rr[data-always] .rr-forget{opacity:1}
@media (hover:none){.agx-rr .rr-forget{opacity:1}}
.agx-rr .rr-chip{min-width:74px}
@media (max-width:560px){.agx-rr .rr-count{display:none}}
`;

function RemoteRow({ r, state, ticked, disabled, onTick, onOpen, onForget, onRetry }: {
  r: RemoteRepo; state: RowState; ticked: boolean; disabled?: boolean;
  onTick: () => void; onOpen: () => void; onForget: () => void; onRetry: () => void;
}) {
  const gone = state === "gone";
  const chip = gone ? "Not found" : state === "no-access" ? "No access" : "Read-only";
  const tile = gone ? "q" : state === "unreachable" ? "off" : "cloud";
  const sub = subLine(r, state);
  // At 520 px the count goes first: it is the line's tail, so the CSS hides it
  // by dropping the segment after the first " · " — see `rr-count`.
  const [head, ...tail] = sub.split(" · ");
  return (
    <div className="agx-rr flex items-center rounded-lg relative" data-remote-row={r.repo} data-state={state} data-always={gone || state === "no-access" ? "" : undefined}
      style={{ opacity: gone ? 0.75 : 1 }}>
      <input type="checkbox" checked={ticked} onChange={onTick} disabled={disabled || gone} aria-label={`Include ${r.repo}`}
        className="shrink-0 ml-3 cursor-pointer" style={{ accentColor: "var(--primary)" }} />
      <button onClick={onOpen} disabled={disabled || gone}
        className="agx-btn min-w-0 flex-1 text-left pl-2.5 pr-2 py-2 rounded-lg flex items-center gap-2.5">
        <span className="shrink-0 grid place-items-center rounded-lg" style={{ width: 28, height: 28,
          color: gone ? "var(--text3)" : "var(--info, #3b82f6)",
          background: gone ? "color-mix(in srgb, var(--bg3) 60%, transparent)" : "color-mix(in srgb, var(--info, #3b82f6) 14%, transparent)" }}>
          <RIcon name={tile} size={ICON.sm} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[12px] truncate" style={{ color: "var(--text)", fontWeight: 500 }} title={r.repo}>{r.repo}</span>
          <span className="block text-[10px] t-dim2 truncate" title={sub}>
            {head}{tail.map((t, i) => <span key={i} className={i === 0 && state === "ok" ? "rr-count" : undefined}> · {t}</span>)}
          </span>
        </span>
      </button>
      <span className="rr-chip shrink-0 inline-flex items-center justify-center gap-1 text-[9.5px] px-1.5 py-0.5 rounded-md"
        style={{ border: EDGE, color: gone ? "var(--text3)" : "var(--text2)" }}>
        {!gone && state !== "no-access" && <RIcon name="eye" size={ICON.xs} />}{chip}
      </span>
      {/* Two slots of their own, so a row that gains Retry does not move. */}
      <span className="shrink-0 flex items-center justify-end gap-0.5 pr-2" style={{ width: 104 }}>
        {state === "unreachable" && (
          <button onClick={onRetry} className="agx-btn text-[10px] px-1.5 py-0.5 rounded-md" style={{ color: "var(--primary-hover)" }}>Retry</button>
        )}
        <button onClick={onForget} disabled={disabled} className="rr-forget agx-btn text-[10px] px-1.5 py-0.5 rounded-md" style={{ color: "var(--text3)" }}
          title="Stop listing this repository — nothing on GitHub or on this machine is touched">Forget</button>
      </span>
    </div>
  );
}

/** Heading and rows. `rows` is already filtered by what was typed; an empty list draws nothing at all. */
export function RemoteShelfRows({ rows, ticks, disabled, state, onOpen }: {
  rows: RemoteRepo[]; ticks: string[]; disabled?: boolean; state: ReturnType<typeof useRemoteRefresh>; onOpen: (repo: string) => void;
}) {
  if (!rows.length) return null;
  return (
    <div data-remote-shelf>
      <style>{CSS}</style>
      <div className="flex items-center gap-2 px-3 pt-2.5 pb-1 text-[9.5px] uppercase tracking-wider" style={{ color: "var(--text4)" }}>
        <RIcon name="cloud" size={ICON.xs} />
        <span>On GitHub · {rows.length}</span>
        <span className="ml-auto normal-case tracking-normal">not on this machine</span>
      </div>
      {rows.map((r) => {
        const key = r.repo.toLowerCase();
        return (
          <RemoteRow key={key} r={r} disabled={disabled}
            state={rowState(r, state.checking.has(key), state.unreachable.has(key))}
            ticked={ticks.some((t) => t.toLowerCase() === key)}
            onTick={() => tickRemote(r.repo, !ticks.some((t) => t.toLowerCase() === key))}
            onOpen={() => onOpen(r.repo)} onForget={() => forgetRemoteStored(r.repo)} onRetry={() => void state.refresh(r.repo, true)} />
        );
      })}
    </div>
  );
}
