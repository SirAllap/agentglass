/*
 * Where the disk went, and what is safe to take back.
 *
 * Docker's own answer is `docker system df`, which is four numbers and no
 * advice. The advice is the point: the piles differ wildly in what they cost to
 * lose, and three identical buttons make a reclaim that costs one slower build
 * look the same as one that hands every worktree a cold install.
 *
 * So every card says what it takes and what that costs, the confirm happens in
 * the card (the button turns red: "Yes, free 3.0 GB"), and the dangerous one is
 * not a button at all: "Volumes stay" is a sentence with the command, for
 * somebody who has decided anyway. Every figure comes out of `diskMath`.
 */
import { useState } from "react";
import type { DockerImage } from "../../../../shared/types.ts";
import { humanSize } from "../../../../shared/dockerSize.ts";
import { api } from "../../lib/api.ts";
import { BUILD_CACHE_BUDGET, diskMath } from "../../lib/dockerDisk.ts";
import { stripeWidths, type ReclaimKey } from "../../lib/dockerResourceUi.ts";
import { sinceLabel } from "../../lib/dockerVolumeView.ts";
import { READ_ONLY_REASON } from "../../lib/dockerState.ts";
import { BranchIcon, RefreshIcon, WarningIcon } from "../../lib/glyphIcons.tsx";
import { ICON } from "../../lib/iconSize.ts";
import type { DiskState } from "../../lib/useDiskData.ts";
import { useEscapeClose } from "../../lib/useDismiss.ts";
import { Button } from "../workspace/Chrome.tsx";
import { BroomIcon, CylinderIcon, LayersIcon } from "./DockerIcons.tsx";
import { Square } from "./Glyphs.tsx";

const TINT: Record<string, string> = { images: "var(--info)", cache: "var(--warning)", volumes: "var(--merged)", containers: "var(--success)" };
const LABEL: Record<string, string> = { images: "Images", cache: "Build cache", volumes: "Volumes", containers: "Containers" };
const SEG_TINT = (k: string) => (k.startsWith("cache") ? TINT.cache! : k === "volumes" ? TINT.volumes! : k === "containers" ? TINT.containers! : TINT.images!);
/** Reclaim card key to the stripe it shrinks. */
const STRIPE: Record<ReclaimKey, string> = { cache: "cache-over", orph: "orphans", dang: "dangling" };
const MINI_MAX = 14;

const tone = (v: string) => ({ "--tone": v }) as React.CSSProperties;
const tint = (v: string) => ({ "--tint": v }) as React.CSSProperties;

/** Mounted only while a confirm is open, so Esc means "keep it" exactly then. */
function Armed({ yes, onYes, onNo }: { yes: string; onYes: () => void; onNo: () => void }) {
  useEscapeClose(onNo);
  return (<>
    <Button tint="var(--error)" solid autoFocus onClick={onYes}>{yes}</Button>
    <Button tone="plain" onClick={onNo}>Keep</Button>
  </>);
}

export function Disk({ state, images, writeEnabled, flash }: {
  state: DiskState; images: DockerImage[]; writeEnabled: boolean; flash: (ok: boolean, msg: string) => void;
}) {
  const { d, error, measure } = state;
  const [armed, setArmed] = useState<ReclaimKey | null>(null);
  /* What is running. Removing 25 images is 25 sequential `docker image rm`
     calls and can take the better part of a minute, during which the old
     figures are still on screen: a dimmed button reads exactly like a click
     that did nothing, so the card says what it is doing and the striped part
     of the bar shrinks. */
  const [busy, setBusy] = useState<ReclaimKey | null>(null);
  const [showOrph, setShowOrph] = useState(false);

  if (!d && !error) {
    return (
      <div className="dk-dsk" aria-busy="true" aria-label="Measuring the disk">
        <span className="dk-xe" style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 12 }}>
          <span className="dk-spin" style={{ display: "inline-flex" }}><RefreshIcon size={ICON.sm} /></span>Measuring… <small>this can take a few seconds on a big disk</small>
        </span>
        <i className="dk-sk" style={{ width: "100%", height: 60 }} /><i className="dk-sk" style={{ width: "100%", height: 22 }} />
        <div className="dk-choices"><i className="dk-sk" style={{ height: 110 }} /><i className="dk-sk" style={{ height: 110 }} /><i className="dk-sk" style={{ height: 110 }} /></div>
      </div>
    );
  }
  if (!d) {
    return (
      <div className="dk-dsk" role="alert">
        <div className="dk-hnote"><WarningIcon size={ICON.md} /><div><b>Could not read the disk figures.</b><br />docker system df: {error}</div></div>
        <div><Button onClick={() => void measure(true)}><RefreshIcon size={ICON.sm} />Try again</Button></div>
      </div>
    );
  }

  const m = diskMath(d, images);
  const readOnly = !writeEnabled;
  const widths = stripeWidths(m, busy);
  const aria = m.legend.map((l) => `${LABEL[l.key]} ${humanSize(l.bytes)}${l.canGo ? `, of which ${humanSize(l.canGo)} can go` : ""}`).join(". ");
  const [cache, orph, dang] = m.cards;
  const gaugeMax = Math.max(d.buildCache, BUILD_CACHE_BUDGET);

  const run = async (key: ReclaimKey) => {
    setArmed(null); setBusy(key);
    try {
      const r = key === "cache" ? await api.dockerPruneCache(BUILD_CACHE_BUDGET)
        : await api.dockerRemoveImages(key === "orph" ? d.orphans.map((o) => o.tag) : m.danglingIds);
      flash(r.ok, r.ok ? (r.output || (key === "cache" ? "Build cache trimmed" : "Images removed")) : (r.error || "Docker refused"));
      // Held until the new figures are in, so the bar does not spring back to the old ones.
      await measure(true);
    } catch (e) { flash(false, String(e)); }
    finally { setBusy(null); }
  };

  const slot = (key: ReclaimKey, card: (typeof m.cards)[number], yes: string) => {
    if (busy === key) return <><Button disabled pending>Working…</Button><span className="dk-xe">the numbers refresh when it is done</span></>;
    if (card.none) return <Button tint="var(--success)" solid disabled>Nothing to free</Button>;
    if (armed === key) return <Armed yes={yes} onYes={() => void run(key)} onNo={() => setArmed(null)} />;
    return <Button tint="var(--success)" solid disabled={readOnly || !!busy} title={readOnly ? READ_ONLY_REASON : undefined} onClick={() => setArmed(key)}>{card.label}</Button>;
  };
  const plural = (n: number) => `${n} image${n === 1 ? "" : "s"}`;
  const minis = (n: number) => n === 0 ? <span className="dk-xe">none</span> : (
    <span className="dk-mini">
      {Array.from({ length: Math.min(n, MINI_MAX) }, (_, i) => <Square key={i} kind="stop" small />)}
      {n > MINI_MAX && <span className="dk-xe">+{n - MINI_MAX}</span>}
    </span>
  );

  return (
    <div className="dk-dsk">
      {error && <div className="dk-note" style={tint("var(--warning)")}><WarningIcon size={ICON.md} /><span>The last measure failed ({error}); these figures are from before.</span></div>}
      <div className="dk-diskobj">
        <div className="h">
          <b>{humanSize(m.total)}</b>
          <span>Docker uses on this machine · measured {sinceLabel(new Date(d.at).toISOString())}</span>
          <span className="back" style={tint("var(--text3)")}>{m.back > 0 ? <><i className="dk-stp" />{m.backText}</> : m.backText}</span>
        </div>
        <div className="dk-stackbar" role="img" aria-label={aria}>
          {widths.map((w) => (
            <i key={w.key} data-go={w.stripe || undefined} style={{ ...tint(SEG_TINT(w.key)), width: `${w.pct}%` }} title={w.stripe ? `${humanSize(w.bytes)} can go` : undefined} />
          ))}
        </div>
        <div className="dk-legend">
          {m.legend.map((l) => (
            <div className="dk-lg" key={l.key}>
              <i style={tint(TINT[l.key]!)} />
              <div>{LABEL[l.key]}<small>{humanSize(l.bytes)}{l.canGo ? ` · ${humanSize(l.canGo)} can go` : l.note ? ` · ${l.note}` : ""}</small></div>
            </div>
          ))}
        </div>
      </div>

      <div className="dk-choices">
        <div className="dk-choice" data-busy={busy === "cache" || undefined}>
          <span className="dk-tile" style={tone("var(--warning)")}><LayersIcon size={ICON.lg} /></span>
          <div style={{ minWidth: 0 }}>
            <h4>Keep the build cache under {humanSize(BUILD_CACHE_BUDGET)}</h4>
            <p>{busy === "cache" ? `Pruning the build cache down to ${humanSize(BUILD_CACHE_BUDGET)}…`
              : m.underBudget ? `${humanSize(d.buildCache)} in cache: already under the budget.`
              : "Least recently used goes first. The next build is slower; nothing else changes."}</p>
            <div className="now">NOW <span className="dk-gauge" data-ok={m.underBudget || undefined}><i style={{ width: `${(d.buildCache / gaugeMax) * 100}%` }} /><u style={{ left: `${(BUILD_CACHE_BUDGET / gaugeMax) * 100}%` }} /></span> {humanSize(d.buildCache)}{m.cacheOver ? <> · <b>frees {humanSize(m.cacheOver)}</b></> : null}</div>
            <div className="go">{slot("cache", cache!, `Yes, free ${humanSize(m.cacheOver)}`)}</div>
          </div>
        </div>

        <div className="dk-choice" data-busy={busy === "orph" || undefined}>
          <span className="dk-tile" style={tone("var(--text2)")}><BranchIcon size={ICON.lg} /></span>
          <div style={{ minWidth: 0 }}>
            <h4>Remove images from worktrees that are gone</h4>
            <p>{busy === "orph" ? "Removing the images…"
              : m.orphanCount ? `${plural(m.orphanCount)} built by checkouts that were removed since. Nothing running uses ${m.orphanCount === 1 ? "it" : "them"}.`
              : "No images are left over from removed worktrees."}</p>
            <div className="now">NOW {minis(m.orphanCount)} {plural(m.orphanCount)}{m.orphanBytes ? <> · <b>frees {humanSize(m.orphanBytes)}</b></> : null}</div>
            <div className="go">
              {slot("orph", orph!, `Yes, remove ${plural(m.orphanCount)}`)}
              {m.orphanCount > 0 && armed !== "orph" && busy !== "orph" && (
                <Button tone="quiet" aria-expanded={showOrph} onClick={() => setShowOrph((v) => !v)}>{showOrph ? "Hide them" : "Show them"}</Button>
              )}
            </div>
            {showOrph && m.orphanCount > 0 && <div className="dk-tags">{m.orphanTags.map((t) => <code key={t}>{t}</code>)}</div>}
          </div>
        </div>

        <div className="dk-choice" data-busy={busy === "dang" || undefined}>
          <span className="dk-tile" style={tone("var(--text3)")}><BroomIcon size={ICON.lg} /></span>
          <div style={{ minWidth: 0 }}>
            <h4>Remove dangling images</h4>
            <p>{busy === "dang" ? "Removing the images…"
              : m.danglingCount ? `${m.danglingCount} untagged image${m.danglingCount === 1 ? "" : "s"} left behind by rebuilds. No tag points to ${m.danglingCount === 1 ? "it" : "them"}.`
              : "No untagged images are left behind."}</p>
            <div className="now">NOW {minis(m.danglingCount)} {plural(m.danglingCount)}{m.danglingBytes ? <> · <b>frees {humanSize(m.danglingBytes)}</b></> : null}</div>
            <div className="go">{slot("dang", dang!, `Yes, remove ${plural(m.danglingCount)}`)}</div>
          </div>
        </div>

        {/* Not a button, on purpose: this is the one everybody reaches for and
            the one that costs other people their afternoon. */}
        <div className="dk-choice" data-quiet>
          <span className="dk-tile" style={tone("var(--text3)")}><CylinderIcon size={ICON.lg} /></span>
          <div>
            <h4 style={{ fontWeight: 500 }}>Volumes stay</h4>
            <p>No “prune volumes” button here. It frees a few gigabytes and takes every <code>node_modules</code> volume with it, a cold install for every worktree on this machine at once. If you have decided anyway: <code>docker volume prune</code>.</p>
          </div>
        </div>
      </div>
      {readOnly && <span className="dk-xe">This instance is read-only, so the buttons are off.</span>}
    </div>
  );
}
