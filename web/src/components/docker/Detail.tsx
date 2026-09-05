/*
 * One container, without the tab row.
 *
 * The tabs were five buttons, four of which hid a fact you needed while looking
 * at the fifth: the image, the ports, how long it has been up, whether its
 * health check is failing — all of that lived behind "Info", which is to say
 * behind a click, which is to say nowhere.
 *
 * So the facts are the header, always, and the log is the body, always. Env,
 * config and processes become sections that open UNDER the log rather than
 * instead of it: what you want while reading `docker inspect` is usually the
 * log line that made you open it.
 */
import { useState } from "react";
import type { DockerContainer, DockerEnvRow, DockerStat } from "../../../../shared/types.ts";
import { api } from "../../lib/api.ts";
import { CODE_FONT_STYLE } from "../diff/DiffLines.tsx";
import { Select } from "../Select.tsx";
import { LogView } from "./LogView.tsx";
import { healthLabel, healthTint, ownerTitle, portLabel, portUrl } from "../../lib/dockerRow.ts";

export type DetailSection = "env" | "config" | "top" | "compare";

const STATE_TINT: Record<string, string> = {
  running: "var(--success)", exited: "var(--text3)", paused: "var(--warning)",
  restarting: "var(--warning)", created: "var(--info)", dead: "var(--error)", removing: "var(--error)",
};

/** A fact in the header strip: a dim label and the value, on one line. */
function Fact({ label, children, title }: { label: string; children: React.ReactNode; title?: string }) {
  return (
    <span className="flex items-center gap-1 min-w-0 shrink-0" title={title}>
      <span className="text-[9px] uppercase tracking-wider t-dim2">{label}</span>
      <span className="text-[10px] truncate" style={{ color: "var(--text2)" }}>{children}</span>
    </span>
  );
}

/** One collapsible section under the log. Closed sections cost nothing: their
 *  content is not fetched until they are opened. */
function Section({ id, label, count, open, onToggle, children }: {
  id: DetailSection; label: string; count?: number; open: boolean;
  onToggle: (id: DetailSection) => void; children: React.ReactNode;
}) {
  return (
    <div className="shrink-0 border-t" style={{ borderColor: "color-mix(in srgb, var(--border) 40%, transparent)" }}>
      <button onClick={() => onToggle(id)} aria-expanded={open}
        className="w-full flex items-center gap-2 px-4 py-1 text-left min-h-[24px]">
        <span className="text-[10px] t-dim2 w-3">{open ? "▾" : "▸"}</span>
        <span className="text-[10px] uppercase tracking-wider" style={{ color: open ? "var(--text)" : "var(--text3)" }}>{label}</span>
        {count != null && <span className="text-[10px] t-dim2 tabular-nums">{count}</span>}
      </button>
      {/* Bounded: a 4,000-line `docker inspect` must not push the log off the
          screen just because somebody glanced at it. */}
      {open && <div className="agx-scroll overflow-auto px-4 pb-2" style={{ maxHeight: "38vh" }}>{children}</div>}
    </div>
  );
}

export function Detail({
  c, stat, env, config, top, error, writeEnabled, tail, onTail, onExec, onOpenPort, open, onToggle, others,
}: {
  c: DockerContainer;
  stat?: DockerStat;
  env: string[] | null;
  config: string | null;
  top: string | null;
  error: string | null;
  writeEnabled: boolean;
  tail: number;
  onTail: (n: number) => void;
  onExec: () => void;
  onOpenPort: (url: string) => void;
  open: Record<DetailSection, boolean>;
  onToggle: (id: DetailSection) => void;
  /** Every other container on screen, for "why does yours start and mine not". */
  others: DockerContainer[];
}) {
  const [envQ, setEnvQ] = useState("");
  const health = healthLabel(c);
  const tint = healthTint(c.health);
  const shownEnv = env?.filter((line) => !envQ.trim() || line.toLowerCase().includes(envQ.trim().toLowerCase())) ?? null;

  return (
    <>
      <div className="px-4 py-2 border-b shrink-0 flex flex-col gap-1" style={{ borderColor: "color-mix(in srgb, var(--border) 40%, transparent)" }}>
        <div className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full shrink-0" style={{ background: STATE_TINT[c.state] ?? "var(--text3)" }} />
          <span className="text-[12px] font-medium truncate" style={{ color: "var(--text)" }} title={c.name}>{c.name}</span>
          {health && tint && (
            <span className="text-[9.5px] px-1.5 py-0.5 rounded-md shrink-0"
              title={c.healthError ?? undefined}
              style={{ color: tint, border: `1px solid color-mix(in srgb, ${tint} 40%, transparent)`, background: `color-mix(in srgb, ${tint} 10%, transparent)` }}>
              {health}
            </span>
          )}
          {c.owner && (
            <span className="text-[9.5px] px-1.5 py-0.5 rounded-md shrink-0" title={ownerTitle(c.owner)}
              style={c.owner.foreign
                ? { color: "var(--warning)", border: "1px solid color-mix(in srgb, var(--warning) 40%, transparent)" }
                : { color: "var(--text3)", border: "1px solid color-mix(in srgb, var(--border) 40%, transparent)" }}>
              {c.owner.worktree}{c.owner.branch ? ` · ${c.owner.branch}` : ""}
            </span>
          )}
          <div className="ml-auto flex items-center gap-1 shrink-0">
            {/* Runs in the console already docked below, in the same shell you
                would have typed it into. A second, container-only terminal
                would be a second set of bugs for no extra reach. */}
            {writeEnabled && c.state === "running" && (
              <button onClick={onExec} className="text-[10px] px-2 py-0.5 rounded min-h-[20px]"
                style={{ color: "var(--primary-hover)", border: "1px solid color-mix(in srgb, var(--primary) 40%, transparent)" }}
                title={`Open a shell inside ${c.name}`}>Exec</button>
            )}
            <Select value={String(tail)} onChange={(v) => onTail(Number(v))} align="right"
              className="text-[10px] px-1 py-0.5 rounded outline-none"
              style={{ background: "color-mix(in srgb, var(--bg3) 50%, transparent)", color: "var(--text2)", border: "1px solid color-mix(in srgb, var(--border) 30%, transparent)" }}
              options={[100, 200, 400, 1000, 2000].map((n) => ({ value: String(n), label: `${n} lines` }))} />
          </div>
        </div>

        {/* The facts that used to be behind the "Info" tab. Every one of them
            is something you check WHILE reading the log, which is exactly what
            a tab makes impossible. */}
        <div className="flex items-center gap-x-3 gap-y-1 flex-wrap min-w-0">
          <Fact label="image" title={c.image}>{c.image}</Fact>
          <Fact label="up" title={c.startedAt ? `started ${c.startedAt}` : c.status}>{c.uptime || c.status}</Fact>
          {!!c.restarts && (
            <Fact label="restarts" title="Docker has restarted this container this many times since it was created">
              <span style={{ color: "var(--warning)" }}>{c.restarts}</span>
            </Fact>
          )}
          {stat && c.state === "running" && (
            <Fact label="cpu / mem" title={`memory ${stat.mem}% (${stat.memUsage})`}>{stat.cpu.toFixed(1)}% · {stat.mem.toFixed(0)}%</Fact>
          )}
          {c.portList?.length ? (
            <span className="flex items-center gap-1 min-w-0 flex-wrap">
              <span className="text-[9px] uppercase tracking-wider t-dim2">ports</span>
              {c.portList.map((p, i) => {
                const url = portUrl(p);
                return url ? (
                  <button key={i} onClick={() => onOpenPort(url)} title={`Open ${url}`}
                    className="text-[9.5px] px-1.5 py-0.5 rounded-md min-h-[20px]"
                    style={{ color: "var(--info)", border: "1px solid color-mix(in srgb, var(--info) 40%, transparent)", background: "color-mix(in srgb, var(--info) 8%, transparent)" }}>
                    {portLabel(p)} ↗
                  </button>
                ) : (
                  <span key={i} className="text-[9.5px] px-1.5 py-0.5 rounded-md" title={p.host === null ? "Exposed by the image, not published to the host" : "Published, but not a web port"}
                    style={{ color: "var(--text3)", border: "1px solid color-mix(in srgb, var(--border) 40%, transparent)" }}>
                    {portLabel(p)}
                  </span>
                );
              })}
            </span>
          ) : null}
        </div>

        {/* The probe's own words, where they belong: next to the state they
            explain. Reading this used to mean going to `docker inspect`. */}
        {c.health === "unhealthy" && c.healthError && (
          <div className="text-[10px] truncate" style={{ color: "var(--error)" }} title={c.healthError}>{c.healthError}</div>
        )}
      </div>

      <LogView key={c.id} id={c.id} tail={tail} running={c.state === "running"} />

      <Section id="env" label="Environment" count={env?.length} open={open.env} onToggle={onToggle}>
        {env === null ? (
          <div className="text-[11px] t-dim2 py-2">{error ?? "reading…"}</div>
        ) : (
          <>
            <input value={envQ} onChange={(e) => setEnvQ(e.target.value)} placeholder="find a variable"
              className="text-[10px] px-2 py-0.5 rounded-md outline-none w-full max-w-[280px] my-1"
              style={{ background: "color-mix(in srgb, var(--bg3) 50%, transparent)", color: "var(--text2)", border: "1px solid color-mix(in srgb, var(--border) 30%, transparent)" }} />
            <div className="text-[11px] leading-[1.6]" style={CODE_FONT_STYLE}>
              {shownEnv!.map((line, i) => {
                const eq = line.indexOf("=");
                const k = eq < 0 ? line : line.slice(0, eq);
                const v = eq < 0 ? "" : line.slice(eq + 1);
                return (
                  <div key={i} className="flex gap-2 min-w-0">
                    <span className="shrink-0" style={{ color: "var(--text3)" }}>{k}</span>
                    <span className="min-w-0 break-all" style={{ color: "var(--text2)" }}>{v}</span>
                  </div>
                );
              })}
              {!shownEnv!.length && <div className="t-dim2 py-1">nothing matches</div>}
            </div>
          </>
        )}
      </Section>

      <Section id="config" label="Inspect" open={open.config} onToggle={onToggle}>
        <pre className="text-[10.5px] leading-[1.5] whitespace-pre-wrap break-all" style={{ ...CODE_FONT_STYLE, color: "var(--text2)" }}>
          {config ?? error ?? "reading…"}
        </pre>
      </Section>

      <Section id="compare" label="Compare environment" open={open.compare} onToggle={onToggle}>
        <EnvCompare c={c} others={others} />
      </Section>

      <Section id="top" label="Processes" open={open.top} onToggle={onToggle}>
        <pre className="text-[10.5px] leading-[1.5] whitespace-pre" style={{ ...CODE_FONT_STYLE, color: "var(--text2)" }}>
          {top ?? error ?? (c.state === "running" ? "reading…" : "the container is not running")}
        </pre>
      </Section>
    </>
  );
}


/**
 * "It works on mine."
 *
 * Two containers, one list of what differs. The comparison happens on the
 * server precisely so that credential values never reach this component — a
 * diff view is exactly the surface that ends up in a screenshot, and an
 * environment is the densest pile of secrets on the machine. A masked row still
 * says whether it changed, because "the token differs" is very often the whole
 * answer.
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

  const differ = rows?.filter((r) => r.change !== "same") ?? [];
  const shown = allRows ? rows ?? [] : differ;

  return (
    <div className="py-1 flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <Select value={against} onChange={compare}
          className="text-[10px] px-1.5 py-0.5 rounded outline-none max-w-[240px]"
          style={{ background: "color-mix(in srgb, var(--bg3) 50%, transparent)", color: "var(--text2)", border: "1px solid color-mix(in srgb, var(--border) 30%, transparent)" }}
          options={[{ value: "", label: "compare with…" }, ...candidates.map((o) => ({
            value: o.id,
            // The worktree is the thing that makes two identically-named
            // containers tellable apart, which is the whole case for this.
            label: `${o.name}${o.owner ? ` · ${o.owner.worktree}` : ""}`,
          }))]} />
        {busy && <span className="text-[10px] t-dim2">reading both…</span>}
        {rows && (
          <span className="text-[10px] t-dim2">
            {differ.length} of {rows.length} differ
            <button onClick={() => setAllRows((v) => !v)} className="ml-2 min-h-[20px]" style={{ color: "var(--primary-hover)" }}>
              {allRows ? "only the differences" : "show all"}
            </button>
          </span>
        )}
      </div>

      {err && <div className="text-[10.5px]" style={{ color: "var(--warning)" }}>{err}</div>}
      {rows && !differ.length && <div className="text-[10.5px] t-dim2">Identical, variable for variable.</div>}

      {shown.map((r) => (
        <div key={r.name} className="flex gap-2 text-[10.5px] min-w-0" style={CODE_FONT_STYLE}>
          <span className="w-4 shrink-0" style={{ color: r.change === "changed" ? "var(--warning)" : r.change === "same" ? "var(--text4)" : "var(--info)" }}>
            {r.change === "only-a" ? "◀" : r.change === "only-b" ? "▶" : r.change === "changed" ? "≠" : "="}
          </span>
          <span className="w-56 shrink-0 truncate" style={{ color: "var(--text3)" }} title={r.name}>{r.name}</span>
          <span className="min-w-0 break-all" style={{ color: "var(--text2)" }}>
            {r.masked
              /* Compared, not shown. The state still travels; the value never
                 does. */
              ? <span className="t-dim2">{r.change === "same" ? "•••• identical" : "•••• differs"}</span>
              : r.change === "changed"
                ? <><span style={{ color: "var(--error)" }}>{r.a || "∅"}</span> → <span style={{ color: "var(--success)" }}>{r.b || "∅"}</span></>
                : <span>{r.a ?? r.b}</span>}
          </span>
        </div>
      ))}
    </div>
  );
}
