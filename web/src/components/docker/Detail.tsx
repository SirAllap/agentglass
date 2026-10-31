/*
 * One container, open: the head (state, name, its one action, Shell), the red
 * line that says why it needs you, four stat cards, then the log as the body
 * and four folds under it. The folds open UNDER the log rather than instead of
 * it: what you want while reading `docker inspect` is usually the log line that
 * made you open it.
 */
import { useState } from "react";
import type { DockerContainer, DockerEnvRow, DockerStat } from "../../../../shared/types.ts";
import { api } from "../../lib/api.ts";
import { envRows, envSummary, topTree } from "../../lib/dockerDetail.ts";
import { CaretIcon, SearchIcon } from "../../lib/glyphIcons.tsx";
import { ICON } from "../../lib/iconSize.ts";
import { Select } from "../Select.tsx";
import { BAR_INPUT, Button, EDGE, INPUT_STYLE } from "../workspace/Chrome.tsx";
import { DetailBar, type BarProps } from "./DetailBar.tsx";
import { FactCards, WhyLine } from "./DetailFacts.tsx";
import { LogView } from "./LogView.tsx";

export type DetailSection = "env" | "config" | "top" | "compare";

/** One fold under the log. A closed fold costs nothing: its content is not fetched until it opens. */
function Fold({ id, label, note, open, onToggle, children }: {
  id: DetailSection; label: string; note?: string; open: boolean; onToggle: (id: DetailSection) => void; children: React.ReactNode;
}) {
  return (
    <div className="dk-acc" data-open={open}>
      <button type="button" onClick={() => onToggle(id)} aria-expanded={open}>
        <CaretIcon size={ICON.sm} />{label}{note ? <span className="n">{note}</span> : null}
      </button>
      {/* Bounded in CSS: a 4,000-line `docker inspect` must not push the log off the screen. */}
      {open && <div className="ab">{children}</div>}
    </div>
  );
}

export function Detail({
  c, stat, env, config, top, error, readOnly, tail, onTail, onOpenPort, open, onToggle, others, bar,
}: {
  c: DockerContainer;
  stat?: DockerStat;
  env: string[] | null;
  config: string | null;
  top: string | null;
  error: string | null;
  readOnly: boolean;
  tail: number;
  onTail: (n: number) => void;
  onOpenPort: (url: string) => void;
  open: Record<DetailSection, boolean>;
  onToggle: (id: DetailSection) => void;
  /** Every other container on screen, for "why does yours start and mine not". */
  others: DockerContainer[];
  bar: BarProps;
}) {
  const [errorTick, setErrorTick] = useState(0);
  const procs = top ? topTree(top) : null;
  return (
    <>
      <div className="dk-head">
        <DetailBar c={c} bar={{ ...bar, readOnly }} />
        <WhyLine c={c} onShowLog={() => setErrorTick((n) => n + 1)} />
        <FactCards c={c} stat={stat} onOpenPort={onOpenPort} />
      </div>

      <LogView key={`log-${c.id}`} id={c.id} tail={tail} onTail={onTail} running={(c.state || "").toLowerCase() === "running"} errorTick={errorTick} />

      <div className="dk-folds" key={`folds-${c.id}`}>
        <Fold id="env" label="Environment" note={env ? envSummary(env) : undefined} open={open.env} onToggle={onToggle}>
          {env === null ? <div className="dk-mut">{error ?? "reading…"}</div> : <EnvList env={env} />}
        </Fold>
        <Fold id="compare" label="Compare environment with another worktree" note={open.compare ? undefined : "pick a container"} open={open.compare} onToggle={onToggle}>
          <EnvCompare c={c} others={others} />
        </Fold>
        <Fold id="top" label="Processes" note={procs ? String(procs.length) : undefined} open={open.top} onToggle={onToggle}>
          {procs ? (
            <table className="dk-tbl">
              <thead><tr><th>PID</th><th>User</th><th className="r">CPU</th><th>Command</th></tr></thead>
              <tbody>
                {procs.map((p) => (
                  <tr key={p.pid}>
                    <td>{p.pid}</td><td>{p.user}</td><td className="r">{p.cpu}</td>
                    <td style={{ paddingLeft: 10 + p.depth * 14 }}>{p.cmd}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : <pre className="dk-json">{top ?? error ?? ((c.state || "").toLowerCase() === "running" ? "reading…" : "the container is not running")}</pre>}
        </Fold>
        <Fold id="config" label="Inspect" note="raw JSON" open={open.config} onToggle={onToggle}>
          <pre className="dk-json">{config ?? error ?? "reading…"}</pre>
        </Fold>
      </div>
    </>
  );
}

/** The variables, with the secrets hidden until asked: the screen is the thing that gets screenshotted. */
function EnvList({ env }: { env: string[] }) {
  const [q, setQ] = useState("");
  const [shown, setShown] = useState<Record<string, true>>({});
  const rows = envRows(env, q);
  return (
    <>
      <div style={{ position: "relative", maxWidth: 260 }}>
        <span style={{ position: "absolute", left: 9, top: 7, color: "var(--text3)", pointerEvents: "none" }}><SearchIcon size={ICON.sm} /></span>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a variable" aria-label="Find a variable"
          spellCheck={false} autoComplete="off" className={`w-full ${BAR_INPUT}`} style={{ ...INPUT_STYLE, paddingLeft: 28 }} />
      </div>
      <div className="dk-kv">
        {rows.map((r) => {
          const hide = r.secret && !shown[r.key];
          return (
            <span key={r.key} style={{ display: "contents" }}>
              <span className="k" title={r.key}>{r.key}</span>
              <span className="v" data-mask={hide || undefined}>
                {hide
                  ? <button type="button" className="dk-lk" onClick={() => setShown((s) => ({ ...s, [r.key]: true }))}
                    title="Hidden because it looks like a secret. Click to reveal it.">•••••••• <u>show</u></button>
                  : r.value}
              </span>
            </span>
          );
        })}
      </div>
      {!rows.length && <div className="dk-mut">No variable matches.</div>}
    </>
  );
}

/**
 * "It works on mine."
 *
 * Two containers, one list of what differs. The comparison happens on the
 * server so credential values never reach this component: an environment is the
 * densest pile of secrets on the machine and a diff is what ends up in a
 * screenshot. A masked row still says whether it changed, because "the token
 * differs" is very often the whole answer.
 */
function EnvCompare({ c, others }: { c: DockerContainer; others: DockerContainer[] }) {
  const [against, setAgainst] = useState("");
  const [rows, setRows] = useState<DockerEnvRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [allRows, setAllRows] = useState(false);
  const candidates = others.filter((o) => o.id !== c.id);

  const compare = async (id: string) => {
    setAgainst(id);
    setRows(null); setErr(null);
    if (!id) return;
    setBusy(true);
    const r = await api.dockerEnvDiff(c.id, id);
    setBusy(false);
    if (r.ok && r.rows) setRows(r.rows); else setErr(r.error ?? "could not compare");
  };

  if (!candidates.length) return <div className="dk-mut">There is no other container to compare with.</div>;
  const differ = rows?.filter((r) => r.change !== "same") ?? [];
  const list = allRows ? rows ?? [] : differ;
  const sign = (r: DockerEnvRow) => (r.change === "only-a" ? "◀" : r.change === "only-b" ? "▶" : r.change === "changed" ? "≠" : "=");
  const cell = (r: DockerEnvRow, v: string | undefined) => (r.masked ? "••••••••" : v || "—");

  return (
    <>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <Select value={against} onChange={compare} title="Compare with"
          className="text-[11px] px-2.5 min-h-[28px] rounded-lg outline-none max-w-[260px]"
          style={{ background: "var(--surface-inset)", color: "var(--text2)", border: EDGE }}
          options={[{ value: "", label: "compare with…" }, ...candidates.map((o) => ({
            value: o.id,
            // The worktree is what tells two identically named containers apart.
            label: `${o.name}${o.owner ? ` · ${o.owner.worktree}` : ""}`,
          }))]} />
        {busy && <span className="dk-mut">reading both…</span>}
        {rows && (
          <>
            <span className="dk-mut">{differ.length} of {rows.length} differ</span>
            <Button size="compact" tone="quiet" onClick={() => setAllRows((v) => !v)}>{allRows ? "only the differences" : "show all"}</Button>
          </>
        )}
      </div>
      {err && <div className="dk-mut" style={{ color: "var(--warning-ink)" }}>{err}</div>}
      {rows && !differ.length && !allRows && <div className="dk-mut">Identical, variable for variable.</div>}
      {rows && list.length > 0 && (
        <>
          <div className="dk-dfr">
            {list.map((r) => (
              <span key={r.name} style={{ display: "contents" }}>
                <span className="sg" data-c={r.change} title={r.change}>{sign(r)}</span>
                <span className="dk-mut">{r.name}</span>
                <span className="mono" title={r.masked ? (r.change === "same" ? "identical" : "differs") : undefined}>{cell(r, r.a)}</span>
                <span className="mono">{cell(r, r.b)}</span>
              </span>
            ))}
          </div>
          <div className="dk-mut" style={{ fontSize: 10.5 }}>Secret values are compared on the server and never sent here.</div>
        </>
      )}
    </>
  );
}
