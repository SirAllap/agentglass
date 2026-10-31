/*
 * Images: one sentence, three cards that also filter, then the images in the
 * group they are in (in use, unused, dangling). Everything the sentence and
 * the cards say comes from `imagesView`, the same function the Disk view reads
 * for the images it can give back, so the two cannot disagree.
 */
import { useMemo, useState } from "react";
import type { DockerContainer, DockerDisk, DockerImage } from "../../../../shared/types.ts";
import { humanSize } from "../../../../shared/dockerSize.ts";
import { api } from "../../lib/api.ts";
import { imagesView, type ImageKind } from "../../lib/dockerResources.ts";
import { imageAnswers, imageHit, imageKey, imageMenu, imageShape, sectionsOf, type ImageItem } from "../../lib/dockerResourceUi.ts";
import { BranchIcon, DiskIcon } from "../../lib/glyphIcons.tsx";
import { ICON } from "../../lib/iconSize.ts";
import { PictureIcon } from "./DockerIcons.tsx";
import { Button } from "../workspace/Chrome.tsx";
import {
  Answers, Badge, ConfirmBar, ContainerChips, copyTo, GroupHead, MoreButton, NoMatch, ReadOnlyNote, RemoveButton,
  ResourceEmpty, Sentence, Shape, SizeBar, useMenu, XMenu,
} from "./ResourceKit.tsx";

const SECTIONS = [
  { key: "use", title: "In use" }, { key: "idle", title: "Unused" }, { key: "dang", title: "Dangling", sub: "untagged, nothing points to them" },
] as const;

/** A tagged image is removed by its tag, an untagged one by its id. */
const refOf = (i: DockerImage) => (i.dangling ? i.id : `${i.repository}:${i.tag}`);
const labelOf = (i: DockerImage) => (i.dangling ? `untagged image ${i.id}` : `${i.repository}:${i.tag}`);

export function Images({ images, containers, orphans, q, readOnly, flash, onClear, onGoContainer, onShowDisk }: {
  images: DockerImage[]; containers: DockerContainer[]; orphans: DockerDisk["orphans"];
  q: string; readOnly: boolean; flash: (ok: boolean, msg: string) => void; onClear: () => void;
  onGoContainer: (id: string) => void; onShowDisk: () => void;
}) {
  const view = useMemo(() => imagesView(images, containers, orphans), [images, containers, orphans]);
  const [only, setOnly] = useState<ImageKind | null>(null);
  const [armed, setArmed] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const menu = useMenu();

  if (!images.length) return <ResourceEmpty icon={<PictureIcon size={ICON.xl} />} title="No images yet" text="Pull or build one and it will show up here by itself." />;

  const biggest = Math.max(...view.items.map((i) => i.bytes));
  const sections = sectionsOf(view.groups, SECTIONS, only, (i) => imageHit(i, q));
  const remove = async (i: ImageItem) => {
    setArmed(null); setBusy(imageKey(i.image));
    try { const r = await api.dockerRemoveImages([refOf(i.image)]); flash(r.ok, r.ok ? `Removed ${labelOf(i.image)}` : (r.error || "Docker refused")); }
    catch (e) { flash(false, String(e)); }
    finally { setBusy(null); }
  };
  const menuItem = menu.key ? view.items.find((i) => imageKey(i.image) === menu.key) : undefined;

  return (
    <div className="dk-xs">
      <Sentence lead={view.lead} rest={view.rest} />
      <Answers cards={imageAnswers(view)} active={only} onPick={(k: ImageKind) => setOnly((cur) => (cur === k ? null : k))} what="image" />
      {view.goneNow.length > 0 && (
        <div className="dk-note" style={{ ["--tint" as string]: "var(--warning)" }}>
          <BranchIcon size={ICON.md} />
          <span><b>{view.goneNow.length} image{view.goneNow.length === 1 ? "" : "s"}</b> {view.goneNow.length === 1 ? "was" : "were"} built by a checkout that was removed ({humanSize(view.goneNow.reduce((n, i) => n + i.bytes, 0))}). Nothing running uses {view.goneNow.length === 1 ? "it" : "them"}.</span>
          <span style={{ marginLeft: "auto" }}><Button size="compact" onClick={onShowDisk}><DiskIcon size={ICON.xs} />Show in Disk</Button></span>
        </div>
      )}
      {sections.length === 0 ? <NoMatch q={q} filtered={only !== null} onClear={() => { setOnly(null); onClear(); }} />
        : sections.map((s) => (
          <div key={s.key}>
            <GroupHead title={s.title} sub={`${s.items.length} · ${humanSize(s.items.reduce((n, i) => n + i.bytes, 0))}${"sub" in s && s.sub ? ` · ${s.sub}` : ""}`} />
            <div className="dk-xgrid">
              {s.items.map((i) => (
                <ImageCard key={imageKey(i.image)} i={i} max={biggest} readOnly={readOnly} armed={armed === imageKey(i.image)} pending={busy === imageKey(i.image)}
                  menuOpen={menu.key === imageKey(i.image)} onMenu={menu.open(imageKey(i.image))} onArm={() => setArmed(imageKey(i.image))} onNo={() => setArmed(null)}
                  onYes={() => void remove(i)} onGoContainer={onGoContainer} />
              ))}
            </div>
          </div>
        ))}
      <ReadOnlyNote on={readOnly} />
      {menuItem && (
        <XMenu anchor={menu.anchor} entries={imageMenu(menuItem, readOnly)} onClose={menu.close}
          onPick={(v) => {
            if (v === "copy") void copyTo(`sha256:${menuItem.image.id}`, "the image id", flash);
            else if (v === "disk") onShowDisk();
            else if (v === "rm") setArmed(imageKey(menuItem.image));
          }} />
      )}
    </div>
  );
}

function ImageCard({ i, max, readOnly, armed, pending, menuOpen, onMenu, onArm, onNo, onYes, onGoContainer }: {
  i: ImageItem; max: number; readOnly: boolean; armed: boolean; pending: boolean; menuOpen: boolean;
  onMenu: (el: HTMLElement) => void; onArm: () => void; onNo: () => void; onYes: () => void; onGoContainer: (id: string) => void;
}) {
  const { image } = i;
  const worn = imageShape(i);
  const label = labelOf(image);
  return (
    <div className="dk-xk" data-dim={i.kind === "dang" || undefined} role="group" aria-label={`${label}, ${worn.word}`}>
      <div className="dk-xt">
        <Shape worn={worn} />
        <div className="nm">
          {image.dangling
            ? <><b className="dk-xn" data-none>&lt;none&gt;</b><span className="dk-tag" data-t="none">&lt;none&gt;</span></>
            : <><b className="dk-xn" title={image.repository}>{image.repository}</b><span className="dk-tag" data-t={image.tag === "latest" ? "latest" : undefined}>{image.tag}</span></>}
          {i.goneNow && <Badge tone="var(--warning)" title="Built by a checkout that was removed"><BranchIcon size={ICON.xs} />worktree gone</Badge>}
        </div>
        <RemoveButton label={`Remove ${label}`} off={!i.removable} reason={i.why} readOnly={readOnly} pending={pending} onClick={onArm} />
        <MoreButton label={label} open={menuOpen} onMenu={onMenu} />
      </div>
      <div className="dk-xb"><SizeBar bytes={i.bytes} max={max} tone={image.dangling ? "var(--text4)" : "var(--info)"} /><span className="dk-xsz">{humanSize(i.bytes)}</span></div>
      <div className="dk-xf">
        <ContainerChips cs={i.usedBy} none="not used by any container" onGo={onGoContainer} />
        <span className="dk-xage" title={`sha256:${image.id}`}>{image.dangling ? `${image.id} · ` : ""}built {image.created}</span>
      </div>
      {armed && (
        <ConfirmBar yes="remove" onYes={onYes} onNo={onNo}>
          remove <b>{label}</b>? Frees {humanSize(i.bytes)}. {i.goneNow ? "Its checkout is gone and nothing runs from it." : "It can be pulled or built again."}
        </ConfirmBar>
      )}
    </div>
  );
}
