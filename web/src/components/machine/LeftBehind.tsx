// Processes an agent left behind: a test run or a script that outlived the shell
// that started it, now owned by systemd, still burning CPU. Nothing else in the
// dialog finds them (they are nobody's descendant and listen on nothing).
// Hidden when there are none. Stop asks in the row; the server refuses any pid
// that is not flagged at that moment.
import { useCallback, useEffect, useState } from "react";
import { api } from "../../lib/api.ts";
import type { OrphanProc, OrphanReport } from "../../../../shared/types.ts";
import { forAge } from "../../lib/machineView.ts";
import { useRefreshOnFocus } from "../../lib/useRefreshOnFocus.ts";
import { Button } from "../workspace/Chrome.tsx";
import { Group, StopConfirm } from "./bits.tsx";

/** `tick` moves when the person pressed Refresh: one fresh sample, since the server's own sampling is every few minutes. */
export function LeftBehind({ tick }: { tick: number }) {
  const [rep, setRep] = useState<OrphanReport | null>(null);
  const [armed, setArmed] = useState<number | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const load = useCallback((fresh: boolean) => { api.machineOrphans(fresh).then(setRep).catch(() => {}); }, []);
  useEffect(() => { load(true); }, [load, tick]);
  useRefreshOnFocus(true, () => load(false));

  const stop = async (p: OrphanProc) => {
    setArmed(null);
    const r = await api.machineOrphanStop(p.pid);
    setNote(r.ok ? (r.detail ?? "asked it to stop") : (r.error ?? "could not stop it"));
    setTimeout(() => load(true), 800);
  };

  const procs = rep?.procs ?? [];
  if (!procs.length && !note) return null;
  return (
    <section aria-label="Left behind">
      <Group label="Left behind" count={procs.length} hint="processes an agent started that outlived it" />
      {procs.map((p) => (
        <div key={p.pid} className="mc-lbr">
          <div className="lm" title={`${p.cmd}\npid ${p.pid}\n${p.cwd ?? ""}`}>
            <b>{p.cmd || p.comm}</b>
            <small>pid {p.pid}{(p.origin || p.session) && ` · ${p.origin ?? ""}${p.session ? ` · session ${p.session.slice(0, 8)}` : ""}`}</small>
            <small>{p.reasons.join(" · ")}</small>
          </div>
          <span className="mc-r">{p.ageSec == null ? "—" : forAge(p.ageSec)}</span>
          <span className={`mc-r${p.hot ? " hot" : ""}`}>{p.cpu == null ? "—" : `${p.cpu.toFixed(1)}%`}</span>
          <span className="lb-btns">
            {armed === p.pid
              ? <StopConfirm pid={p.pid} onYes={() => void stop(p)} onNo={() => setArmed(null)} />
              : <Button size="compact" title="Ask this process to stop (you confirm next)" onClick={() => setArmed(p.pid)}>Stop</Button>}
          </span>
        </div>
      ))}
      {note && <div className="mc-fine" style={{ marginTop: 4 }} role="status">{note}</div>}
    </section>
  );
}
