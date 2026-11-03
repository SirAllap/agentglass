/*
 * Volumes: one sentence, three cards that also filter, then the volumes by
 * state. The line this view holds is that a data volume is never offered for
 * removal, with the reason written on the card: `volumesView` classifies, and
 * the server refuses anything that is not a node_modules volume as well.
 *
 * Sizes are the expensive half (`docker system df -v`), so they arrive from the
 * Disk measurement and the cards say "measuring" until they do. Selecting a
 * card opens the panel below with who holds the volume and "Look inside".
 */
import { useMemo, useState } from "react";
import type { DockerContainer, DockerPeek, DockerVolume } from "../../../../shared/types.ts";
import { api } from "../../lib/api.ts";
import { sinceLabel, volumeLabel, volumesView, type VolumeState } from "../../lib/dockerVolumeView.ts";
import { sectionsOf, volumeAnswers, volumeHit, volumeMenu, volumeShape, type VolumeItem } from "../../lib/dockerResourceUi.ts";
import { BranchIcon, FileIcon, FolderIcon, RefreshIcon } from "../../lib/glyphIcons.tsx";
import { ICON } from "../../lib/iconSize.ts";
import { useEscapeClose } from "../../lib/useDismiss.ts";
import { CubeIcon, CylinderIcon, UpIcon } from "./DockerIcons.tsx";
import { Button } from "../workspace/Chrome.tsx";
import { humanSize } from "../../../../shared/dockerSize.ts";
import {
  Answers, Badge, ConfirmBar, ContainerChips, copyTo, GroupHead, MoreButton, NoMatch, ReadOnlyNote, RemoveButton,
  ResourceEmpty, Sentence, Shape, SizeBar, useMenu, XMenu,
} from "./ResourceKit.tsx";

const SECTIONS = [
  { key: "safe", title: "Safe to remove", sub: "node_modules, nothing attached" },
  { key: "use", title: "In use" },
  { key: "kept", title: "Kept", sub: "data, nothing attached" },
] as const;

type Peek = { name: string; s: "busy" | "err" | "ok"; path: string; res?: DockerPeek };

/** Who made the volume what it is: the fact that explains a bundle you did not build. */
/** The peek reports local "YYYY-MM-DD HH:MM"; the cards say "3 weeks ago". */
function whenLabel(when: string): string {
  const t = new Date(when.replace(" ", "T"));
  return Number.isNaN(t.getTime()) ? when : sinceLabel(t.toISOString());
}

function Held({ v }: { v: DockerVolume }) {
  const w = v.worktrees;
  if (!w) return <span className="dk-xe">owner unknown</span>;
  if (!w.length) return <span className="dk-xe">no worktree</span>;
  return w.length === 1
    ? <Badge tone="var(--merged-ink)" title={`Belongs to the worktree ${w[0]}`}><BranchIcon size={ICON.xs} />{w[0]}</Badge>
    : <Badge tone="var(--warning-ink)" title={w.join(", ")}><BranchIcon size={ICON.xs} />{w.length} worktrees</Badge>;
}

export function Volumes({ volumes, containers, sizes, sizeError, q, readOnly, flash, onClear, onGoContainer }: {
  volumes: DockerVolume[]; containers: DockerContainer[];
  /** Null until the disk measurement has answered. */
  sizes: Record<string, number | null> | null; sizeError: string | null;
  q: string; readOnly: boolean; flash: (ok: boolean, msg: string) => void; onClear: () => void; onGoContainer: (id: string) => void;
}) {
  const view = useMemo(() => volumesView(volumes, containers, sizes ?? {}), [volumes, containers, sizes]);
  const [only, setOnly] = useState<VolumeState | null>(null);
  const [armed, setArmed] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [peek, setPeek] = useState<Peek | null>(null);
  const menu = useMenu();

  if (!volumes.length) return <ResourceEmpty icon={<CylinderIcon size={ICON.xl} />} title="No volumes yet" text="Volumes appear here once a container asks for one." />;

  const measured = sizes !== null;
  const biggest = Math.max(0, ...view.items.map((i) => i.bytes ?? 0));
  const sections = sectionsOf(view.groups, SECTIONS, only, (i) => volumeHit(i, q));
  const selected = sel ? view.items.find((i) => i.volume.name === sel) : undefined;

  const remove = async (i: VolumeItem) => {
    setArmed(null); setBusy(i.volume.name);
    try {
      const r = await api.dockerRemoveVolume(i.volume.name);
      flash(r.ok, r.ok ? `Removed ${i.volume.name}` : (r.error || "Docker refused"));
      if (r.ok && sel === i.volume.name) { setSel(null); setPeek(null); }
    } catch (e) { flash(false, String(e)); }
    finally { setBusy(null); }
  };
  const select = (name: string) => { setSel(name); setPeek((p) => (p?.name === name ? p : null)); };
  const toggle = (name: string) => { if (sel === name) { setSel(null); setPeek(null); } else select(name); };
  const look = async (name: string, path: string) => {
    setPeek({ name, s: "busy", path });
    try {
      const res = await api.dockerPeek(name, path);
      setPeek({ name, s: res.ok ? "ok" : "err", path, res });
    } catch (e) { setPeek({ name, s: "err", path, res: { ok: false, error: String(e) } }); }
  };
  const menuItem = menu.key ? view.items.find((i) => i.volume.name === menu.key) : undefined;

  // Until the sizes arrive the sentence says what it knows, not "0 B".
  const lead = measured ? view.lead : `${volumes.length} volume${volumes.length === 1 ? "" : "s"}.`;
  const rest = measured ? view.rest : "Measuring sizes… this can take a few seconds on a big disk.";

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="dk-xs">
        {sizeError && <div className="dk-note" style={{ ["--tint" as string]: "var(--warning)" }}><span>{sizeError}</span></div>}
        <Sentence lead={lead} rest={rest} />
        <Answers cards={volumeAnswers(view, measured)} active={only} onPick={(k: VolumeState) => setOnly((cur) => (cur === k ? null : k))} what="volume" />
        {sections.length === 0 ? <NoMatch q={q} filtered={only !== null} onClear={() => { setOnly(null); onClear(); }} />
          : sections.map((s) => (
            <div key={s.key}>
              <GroupHead title={s.title} sub={`${s.items.length}${measured ? ` · ${humanSize(s.items.reduce((n, i) => n + (i.bytes ?? 0), 0))}` : ""}${"sub" in s && s.sub ? ` · ${s.sub}` : ""}`} />
              <div className="dk-xgrid">
                {s.items.map((i) => (
                  <VolumeCard key={i.volume.name} i={i} max={biggest} measured={measured} readOnly={readOnly} selected={sel === i.volume.name}
                    armed={armed === i.volume.name} pending={busy === i.volume.name} menuOpen={menu.key === i.volume.name}
                    onMenu={menu.open(i.volume.name)} onSelect={() => toggle(i.volume.name)} onArm={() => setArmed(i.volume.name)}
                    onNo={() => setArmed(null)} onYes={() => void remove(i)} onGoContainer={onGoContainer} />
                ))}
              </div>
            </div>
          ))}
        <ReadOnlyNote on={readOnly} />
        <p className="dk-xe" style={{ margin: "12px 0 0" }}>Click a volume to see who holds it and to look inside.</p>
      </div>
      {selected && <VolumePanel i={selected} peek={peek?.name === selected.volume.name ? peek : null} onLook={(path) => void look(selected.volume.name, path)}
        onClosePeek={() => setPeek(null)} onClose={() => { setSel(null); setPeek(null); }} onGoContainer={onGoContainer} />}
      {menuItem && (
        <XMenu anchor={menu.anchor} entries={volumeMenu(menuItem, readOnly)} onClose={menu.close}
          onPick={(v) => {
            if (v === "copy") void copyTo(menuItem.volume.name, "the volume name", flash);
            else if (v === "look") { select(menuItem.volume.name); void look(menuItem.volume.name, ""); }
            else if (v === "rm") setArmed(menuItem.volume.name);
          }} />
      )}
    </div>
  );
}

function VolumeCard({ i, max, measured, readOnly, selected, armed, pending, menuOpen, onMenu, onSelect, onArm, onNo, onYes, onGoContainer }: {
  i: VolumeItem; max: number; measured: boolean; readOnly: boolean; selected: boolean; armed: boolean; pending: boolean; menuOpen: boolean;
  onMenu: (el: HTMLElement) => void; onSelect: () => void; onArm: () => void; onNo: () => void; onYes: () => void; onGoContainer: (id: string) => void;
}) {
  const { volume: v } = i;
  const worn = volumeShape(i);
  const last = v.lastWrite;
  return (
    <div className="dk-xk" data-click data-sel={selected || undefined} role="button" tabIndex={0} aria-pressed={selected} aria-label={`${v.name}, ${worn.word}`}
      onClick={onSelect} onKeyDown={(e) => { if (e.key === "Enter" && e.target === e.currentTarget) { e.preventDefault(); onSelect(); } }}>
      <div className="dk-xt">
        <Shape worn={worn} />
        <div className="nm">
          <b className="dk-xn" title={v.name}>{volumeLabel(v.name)}</b>
          {i.kind === "nm"
            ? <span className="dk-kind" data-k="nm" title="Installed dependencies. The next install rebuilds this volume."><CubeIcon size={ICON.xs} />node_modules</span>
            : <span className="dk-kind" title="Holds data that is not stored anywhere else"><CylinderIcon size={ICON.xs} />data</span>}
        </div>
        <RemoveButton label={`Remove ${v.name}`} off={!i.removable} reason={i.why} readOnly={readOnly} pending={pending} lock={i.kind === "data"} onClick={onArm} />
        <MoreButton label={v.name} open={menuOpen} onMenu={onMenu} />
      </div>
      <div className="dk-xb">
        {i.bytes == null
          ? <span className="dk-xe">{measured ? "size not reported" : "size not measured yet"}</span>
          : <SizeBar bytes={i.bytes} max={max} tone={i.kind === "nm" ? "var(--warning)" : "var(--merged)"} />}
        <span className="dk-xsz">{i.bytes == null ? "…" : humanSize(i.bytes)}</span>
      </div>
      <div className="dk-xf">
        <ContainerChips cs={i.holders} none="nothing attached" onGo={onGoContainer} />
        <Held v={v} />
        <span className="dk-xage" title={last ? `${last.via} · ${last.branch ?? "detached"} · ${last.at}` : undefined}>
          {last ? `written ${sinceLabel(last.at)}` : "no writes seen"}
        </span>
      </div>
      <div className="dk-xwhy">{i.note}</div>
      {armed && (
        <ConfirmBar yes="remove" onYes={onYes} onNo={onNo}>
          remove <b>{v.name}</b>? Frees {i.bytes == null ? "its space" : humanSize(i.bytes)}. The next install rebuilds it.
        </ConfirmBar>
      )}
    </div>
  );
}

function VolumePanel({ i, peek, onLook, onClosePeek, onClose, onGoContainer }: {
  i: VolumeItem; peek: Peek | null; onLook: (path: string) => void; onClosePeek: () => void; onClose: () => void; onGoContainer: (id: string) => void;
}) {
  const { volume: v } = i;
  const last = v.lastWrite;
  const busy = peek?.s === "busy";
  const up = (p: string) => p.split("/").slice(0, -1).join("/");
  useEscapeClose(onClose);
  return (
    <div className="dk-vdet" role="region" aria-label={`${v.name} detail`}>
      <div className="dk-vdi">
        <div className="dk-vdh">
          <Shape worn={volumeShape(i)} /><b>{v.name}</b>
          <span className="dk-btn-end" style={{ display: "inline-flex", gap: 6 }}>
            <Button size="compact" disabled={busy} onClick={() => onLook(peek?.path ?? "")}><FolderIcon size={ICON.xs} />{busy ? "Looking…" : peek ? "Look again" : "Look inside"}</Button>
          </span>
        </div>
        <div className="dk-vrow"><span className="k">Held by</span><span><ContainerChips cs={i.holders} none="nothing right now" onGo={onGoContainer} /></span></div>
        <div className="dk-vrow"><span className="k">Last written by</span>
          <span>{last ? `${last.worktree}${last.branch ? ` (${last.branch})` : ""} · ${sinceLabel(last.at)} · via ${last.via}` : <span className="dk-xe">agentglass has not seen anything write to it</span>}</span></div>
        <div className="dk-vrow"><span className="k">Worktrees</span>
          <span>{v.worktrees?.length ? v.worktrees.map((w) => <Badge key={w} tone="var(--merged-ink)"><BranchIcon size={ICON.xs} />{w}</Badge>) : <span className="dk-xe">none</span>}</span></div>
      </div>
      <div className="dk-vdp"><Listing peek={peek} up={up} onLook={onLook} onClose={onClosePeek} /></div>
    </div>
  );
}

function Listing({ peek, up, onLook, onClose }: { peek: Peek | null; up: (p: string) => string; onLook: (path: string) => void; onClose: () => void }) {
  if (!peek) return <div className="dk-xe" style={{ fontSize: 11.5 }}>Look inside lists its files through a throwaway container; nothing is changed.</div>;
  if (peek.s === "busy") {
    return <div className="dk-xe" style={{ display: "flex", gap: 8, alignItems: "center" }}><span className="dk-spin" style={{ display: "inline-flex" }}><RefreshIcon size={ICON.sm} /></span>Looking inside through a throwaway container…</div>;
  }
  const res = peek.res;
  if (peek.s === "err" || !res?.entries) {
    return (
      <div className="dk-hnote" role="alert">
        <div>
          <b>Could not look inside.</b><br />{res?.error || "The volume could not be read."}
          {res?.hint && <><br /><code>{res.hint}</code></>}
        </div>
      </div>
    );
  }
  const join = (name: string) => (peek.path ? `${peek.path}/${name}` : name);
  return (
    <div className="dk-pk">
      <div className="pr" data-head>
        <span>/{peek.path}</span>
        <span style={{ display: "inline-flex", gap: 6 }}>
          <Button size="compact" tone="quiet" disabled={!peek.path} onClick={() => onLook(up(peek.path))}><UpIcon size={ICON.xs} />Up</Button>
          <Button size="compact" tone="quiet" onClick={onClose}>Close</Button>
        </span>
      </div>
      {res.entries.length === 0 ? <div className="pr"><span /><span className="dk-xe">This volume is empty.</span></div>
        : res.entries.map((e) => (
          <div className="pr" key={e.name}>
            <span>{e.dir ? <FolderIcon size={ICON.sm} /> : <FileIcon size={ICON.sm} />}</span>
            {e.dir ? <button type="button" className="lk" onClick={() => onLook(join(e.name))}>{e.name}/</button> : <span>{e.name}</span>}
            <span className="r">{e.dir ? "" : humanSize(e.bytes)}</span>
            <span className="r dk-xe">{whenLabel(e.when)}</span>
          </div>
        ))}
      <div className="pr" data-foot><span /><span>read-only{res.image ? ` · via image ${res.image}` : ""}</span></div>
    </div>
  );
}
