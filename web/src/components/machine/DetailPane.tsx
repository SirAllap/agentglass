// One process, in full, beside the list: what it is running, who started it, and
// what it was handed. The row can say what is listening; it cannot say these,
// and they are the next three questions every time. Shared by Ports, Resources
// and Locks because a pid is a pid. Loaded once per pid; nothing here refreshes.
import { useEffect, useState, type ReactNode } from "react";
import { api } from "../../lib/api.ts";
import type { ProcDetail } from "../../../../shared/types.ts";
import { FilterField } from "../workspace/Chrome.tsx";
import { CloseButton } from "../CloseButton.tsx";

/** Case-insensitive substring on the KEY only. The values are what the masking
 *  protects: a filter that searched them would answer "does this process hold a
 *  variable containing <string>" for anything that can reach this pane. */
export const envMatches = (key: string, q: string): boolean => !q.trim() || key.toLowerCase().includes(q.trim().toLowerCase());

/** "Environment (75)", or "Environment (3 of 75)" while filtering. */
export const envLabel = (total: number, q: string, shown: number): string => (q.trim() ? `Environment (${shown} of ${total})` : `Environment (${total})`);

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return <div className="mc-dpf"><small>{label}</small>{children}</div>;
}

export function DetailPane({ pid, onClose }: { pid: number; onClose: () => void }) {
  const [d, setD] = useState<ProcDetail | null>(null);
  const [shown, setShown] = useState<Record<string, string>>({});
  const [note, setNote] = useState<string | null>(null);
  const [q, setQ] = useState("");

  useEffect(() => {
    let live = true;
    setD(null); setShown({}); setNote(null); setQ("");
    api.machineProcess(pid).then((r) => { if (live) setD(r); }).catch((e) => { if (live) setNote(String(e)); });
    return () => { live = false; };
  }, [pid]);

  const reveal = async (key: string) => {
    const r = await api.machineEnv(pid, key);
    if (r.ok && r.value !== undefined) setShown((s) => ({ ...s, [key]: r.value! }));
    // The refusal a paired phone gets, said plainly: "nothing happened" reads as a bug and this is a decision.
    else setNote(r.error ?? "the desktop app is the only thing that can reveal these");
  };

  const env = d?.env.filter((v) => envMatches(v.key, q)) ?? [];
  return (
    <aside className="mc-dp" aria-label="Process">
      <div className="mc-dph">
        <b>{d?.comm || `pid ${pid}`}</b><span className="pid">pid {pid}</span>
        <span className="x"><CloseButton onClick={onClose} title="Close the detail" hit={22} /></span>
      </div>
      <div className="mc-dpb">
        {note && <div className="warn">{note}</div>}
        {!d ? (!note && <div>Reading /proc…</div>) : d.error ? <div className="warn">{d.error}</div> : (<>
          <Fact label="Command"><div className="sel">{d.cmd || "—"}</div></Fact>
          {d.cwd && <Fact label="Working directory"><div className="sel">{d.cwd}</div></Fact>}
          {d.ancestry.length > 0 && (
            <Fact label="Started by">
              {/* Oldest at the top: a descent from something you recognise to the thing in front of you. */}
              {[...d.ancestry].reverse().map((a, i) => (
                <div key={a.pid} className="anc" style={{ paddingLeft: i * 10 }}>{i > 0 && <i>└─ </i>}{a.name} ({a.pid})</div>
              ))}
              <div className="anc" style={{ paddingLeft: d.ancestry.length * 10, fontWeight: 600, color: "var(--text)" }}><i>└─ </i>{d.comm} ({d.pid})</div>
            </Fact>
          )}
          <Fact label={envLabel(d.env.length, q, env.length)}>
            <div className="mc-fld" style={{ margin: "4px 0", maxWidth: "none" }}><FilterField value={q} onChange={setQ} placeholder="Filter…" label="Filter variables by name" /></div>
            <div className="mc-kv">
              {env.map((v) => (
                <FragmentRow key={v.key} k={v.key}>
                  {shown[v.key] !== undefined ? shown[v.key]
                    : v.masked ? (
                      // The KEY is usually the whole answer; the value is a detail that must not travel to a phone.
                      <button type="button" onClick={() => void reveal(v.key)} title="Hidden because it looks like a secret. Click to reveal — the desktop app only.">•••••••• <u>show</u></button>
                    ) : v.value}
                </FragmentRow>
              ))}
            </div>
          </Fact>
        </>)}
      </div>
    </aside>
  );
}

function FragmentRow({ k, children }: { k: string; children: ReactNode }) {
  return <><span className="k" title={k}>{k}</span><span className="v">{children}</span></>;
}
