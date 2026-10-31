/*
 * What sits under the header: the red line that says why a container needs you,
 * and the four cards (uptime, CPU, memory, ports). The numbers come from the
 * event feed's stats; nothing here asks Docker for them.
 */
import type { DockerContainer, DockerStat } from "../../../../shared/types.ts";
import { factsOf, healthLine, portChips } from "../../lib/dockerDetail.ts";
import { RefreshIcon, WarningIcon } from "../../lib/glyphIcons.tsx";
import { ICON } from "../../lib/iconSize.ts";
import { ExtIcon } from "./Glyphs.tsx";

export function WhyLine({ c, onShowLog }: { c: DockerContainer; onShowLog: () => void }) {
  const w = healthLine(c);
  if (!w) return null;
  return (
    <div className="dk-why" role="status" data-tone={w.tone === "amb" ? "amb" : undefined}>
      {w.tone === "amb" ? <RefreshIcon size={ICON.md} /> : <WarningIcon size={ICON.md} />}
      <span><b>{w.lead}</b>{w.code && <> <code>{w.code}</code></>} {w.rest}</span>
      <button type="button" className="dk-chip sm ghost" onClick={onShowLog} title="Scroll the log to the last error">Show in log</button>
    </div>
  );
}

function Bar({ pct, hot }: { pct: number | null; hot: boolean }) {
  if (pct == null) return null;
  return <div className="dk-m" data-hot={hot || undefined}><div className="bar"><i style={{ width: `${Math.max(2, Math.min(100, pct))}%` }} /></div></div>;
}

export function FactCards({ c, stat, onOpenPort }: { c: DockerContainer; stat?: DockerStat; onOpenPort: (url: string) => void }) {
  const f = factsOf(c, stat);
  const ports = portChips(c);
  return (
    <div className="dk-facts">
      <div className="dk-fact">
        <div className="k">Up</div>
        <div className="v">{f.up.value} {f.up.sub && <small>{f.up.sub}</small>}</div>
      </div>
      <div className="dk-fact" data-hot={f.cpu.hot || undefined}>
        <div className="k">CPU</div>
        <div className="v">{f.cpu.text}</div>
        <Bar pct={f.cpu.pct} hot={f.cpu.hot} />
      </div>
      <div className="dk-fact" data-hot={f.mem.hot || undefined}>
        <div className="k">Memory</div>
        <div className="v">{f.mem.text} {f.mem.sub && <small>{f.mem.sub}</small>}</div>
        <Bar pct={f.mem.pct} hot={f.mem.hot} />
      </div>
      <div className="dk-fact">
        <div className="k">Ports</div>
        <div className="pls v">
          {ports.length ? ports.map((p, i) => p.kind === "web"
            ? <button key={i} type="button" className="dk-port" data-port="web" title={p.title} onClick={() => onOpenPort(p.url!)}><ExtIcon size={12} />{p.label}</button>
            : <span key={i} className="dk-port" data-port={p.kind === "off" ? "off" : "plain"} title={p.title}>{p.label}</span>)
            : <span className="dk-port" data-port="none">none published</span>}
        </div>
      </div>
    </div>
  );
}
