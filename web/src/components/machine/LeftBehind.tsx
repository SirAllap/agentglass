// Processes left behind: a test run or a script that outlived the shell that
// started it, now owned by systemd, still burning CPU — and the named helpers
// (sleep, gio, git, inotifywait, udisksctl) whose parent went, each row saying
// the origin that was read for it: a checkout, an agent scratchpad or a temp
// wrapper, including this app's own monitors. Daemons that detach on purpose,
// like git's fsmonitor, are not here. Nothing else in the dialog finds them
// (they are nobody's descendant and listen on nothing). Hidden when there are
// none. Stop asks in the row; the server refuses any pid that is not flagged
// at that moment.
//
// The same command in the same cwd state folds into one row with a count: a run
// that leaves thirty-one `sleep 1` is one finding. The caret opens the pids, and
// the Stop in there is the press it always was.
import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../../lib/api.ts";
import type { OrphanProc, OrphanReport } from "../../../../shared/types.ts";
import { forAge } from "../../lib/machineView.ts";
import { LEFT_ROWS, foldLeftBehind, leftTitle, shownLeft, type LeftGroup } from "../../lib/leftBehind.ts";
import { tipAttr } from "../../lib/tip.ts";
import { ICON } from "../../lib/iconSize.ts";
import { CaretIcon } from "../../lib/glyphIcons.tsx";
import { useRefreshOnFocus } from "../../lib/useRefreshOnFocus.ts";
import { Button } from "../workspace/Chrome.tsx";
import { Group, StopConfirm } from "./bits.tsx";

/** `tick` moves when the person pressed Refresh: one fresh sample, since the server's own sampling is every few minutes. */
export function LeftBehind({ tick }: { tick: number }) {
  const [rep, setRep] = useState<OrphanReport | null>(null);
  const [armed, setArmed] = useState<number | null>(null);
  const [armedGroup, setArmedGroup] = useState<string | null>(null);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [showAll, setShowAll] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  /* A fresh report may carry different pids under the same key, so an armed group
     is put away: the confirmation must never name a set the person did not see. */
  const load = useCallback((fresh: boolean) => {
    api.machineOrphans(fresh).then((r) => { setRep(r); setArmedGroup(null); }).catch(() => {});
  }, []);
  useEffect(() => { load(true); }, [load, tick]);
  useRefreshOnFocus(true, () => load(false));

  const stop = async (p: OrphanProc) => {
    setArmed(null);
    const r = await api.machineOrphanStop(p.pid);
    setNote(r.ok ? (r.detail ?? "asked it to stop") : (r.error ?? "could not stop it"));
    setTimeout(() => load(true), 800);
  };

  /* One pid at a time through the route the single row uses: a folded group can
     stop nothing the server would not have stopped on its own. */
  const stopGroup = async (g: LeftGroup) => {
    setArmedGroup(null);
    let stopped = 0; let last = "";
    for (const p of g.procs) {
      const r = await api.machineOrphanStop(p.pid).catch(() => ({ ok: false, error: "no answer" }));
      if (r.ok) stopped += 1; else last = r.error ?? "could not stop it";
    }
    setNote(stopped === g.count
      ? `asked ${g.count} process${g.count === 1 ? "" : "es"} to stop`
      : `stopped ${stopped} of ${g.count}: ${last}`);
    setTimeout(() => load(true), 800);
  };

  const procs = rep?.procs ?? [];
  const groups = useMemo(() => foldLeftBehind(rep?.procs ?? []), [rep]);
  if (!procs.length && !note) return null;

  const shown = shownLeft(groups, showAll);
  const toggle = (key: string) => setOpen((cur) => { const n = new Set(cur); if (n.has(key)) n.delete(key); else n.add(key); return n; });

  return (
    <section aria-label="Left behind">
      <Group label="Left behind" count={procs.length} hint="processes that outlived whoever started them" />
      {shown.rows.map((g) => (
        <Fragment key={g.key}>
          {g.count === 1 ? (
            <OneRow p={g.procs[0]!} armed={armed === g.procs[0]!.pid} onArm={() => setArmed(g.procs[0]!.pid)} onKeep={() => setArmed(null)} onRun={() => void stop(g.procs[0]!)} />
          ) : (
            <FoldedRow g={g} open={open.has(g.key)} armed={armedGroup === g.key} onToggle={() => toggle(g.key)}
              onArm={() => setArmedGroup(g.key)} onKeep={() => setArmedGroup(null)} onRun={() => void stopGroup(g)} />
          )}
          {g.count > 1 && open.has(g.key) && g.procs.map((p) => (
            <OneRow key={p.pid} child p={p} armed={armed === p.pid} onArm={() => setArmed(p.pid)} onKeep={() => setArmed(null)} onRun={() => void stop(p)} />
          ))}
        </Fragment>
      ))}
      {groups.length > LEFT_ROWS && (
        <div className="mc-lbmore">
          <Button size="compact" tone="quiet" aria-expanded={showAll}
            data-tip={showAll ? "Fold back to the first eight" : `The other ${groups.length - LEFT_ROWS} commands left behind`}
            onClick={() => setShowAll((v) => !v)}>
            {showAll ? "Show fewer" : `Show all ${groups.length}`}
          </Button>
        </div>
      )}
      {note && <div className="mc-fine" style={{ marginTop: 4 }} role="status">{note}</div>}
    </section>
  );
}

function OneRow({ p, child, armed, onArm, onKeep, onRun }: {
  p: OrphanProc; child?: boolean; armed: boolean; onArm: () => void; onKeep: () => void; onRun: () => void;
}) {
  return (
    <div className="mc-lbr" data-child={child || undefined}>
      <div className="lm" data-tip={tipAttr({ name: p.cmd || p.comm, detail: `pid ${p.pid}`, text: p.cwd ?? "" })}>
        <b>{p.cmd || p.comm}</b>
        <small>pid {p.pid}{(p.origin || p.session) && ` · ${p.origin ?? ""}${p.session ? ` · session ${p.session.slice(0, 8)}` : ""}`}</small>
        <small>{p.reasons.join(" · ")}</small>
      </div>
      <span className="mc-r">{p.ageSec == null ? "—" : forAge(p.ageSec)}</span>
      <span className={`mc-r${p.hot ? " hot" : ""}`}>{p.cpu == null ? "—" : `${p.cpu.toFixed(1)}%`}</span>
      <span className="lb-btns">
        {armed
          ? <StopConfirm what={`pid ${p.pid}`} onYes={onRun} onNo={onKeep} />
          : <Button size="compact" data-tip={`Ask this process to stop (SIGTERM to pid ${p.pid}); you confirm next`} onClick={onArm}>Stop</Button>}
      </span>
    </div>
  );
}

function FoldedRow({ g, open, armed, onToggle, onArm, onKeep, onRun }: {
  g: LeftGroup; open: boolean; armed: boolean; onToggle: () => void; onArm: () => void; onKeep: () => void; onRun: () => void;
}) {
  return (
    <div className="mc-lbr" data-grp="true">
      <Button size="compact" square tone="quiet" aria-expanded={open} label={open ? `Fold ${g.cmd}` : `Show the ${g.count} pids`}
        data-tip={open ? "Fold these back into one row" : "Every pid in this group, each with its own Stop"} onClick={onToggle}>
        <i className="mc-car" data-shut={!open || undefined}><CaretIcon size={ICON.xs} /></i>
      </Button>
      <div className="lm" data-tip={tipAttr({ name: leftTitle(g), detail: `${g.count} processes`, text: g.reasons.join(" · ") })}>
        <b>{leftTitle(g)}</b>
        <small>{g.count} processes{g.cwdGone ? " · folder deleted" : ""}</small>
        <small>{g.reasons.join(" · ")}</small>
      </div>
      <span className="mc-r">{g.oldestSec == null ? "—" : forAge(g.oldestSec)}</span>
      <span className={`mc-r${g.hot ? " hot" : ""}`}>{g.cpu == null ? "—" : `${g.cpu.toFixed(1)}%`}</span>
      <span className="lb-btns">
        {armed
          ? <StopConfirm what={`${g.count} processes`} label={`Stop all ${g.count}`} onYes={onRun} onNo={onKeep} />
          : <Button size="compact" data-tip={`Ask all ${g.count} to stop; you confirm next`} onClick={onArm}>Stop all {g.count}</Button>}
      </span>
    </div>
  );
}
