/*
 * What the Images, Volumes, Networks and Disk cards decide, pulled out of the
 * components so it can be tested: the shape a thing wears, what the header
 * filter matches, what a "..." menu may offer, what each answer card says, and
 * how wide each part of the disk bar is while one is being freed.
 *
 * The groups themselves (what is in use, safe, kept) are decided in
 * dockerResources.ts / dockerVolumeView.ts / dockerDisk.ts; this reads them.
 */
import type { DockerContainer, DockerImage, DockerNetwork, DockerNetworkMember } from "../../../shared/types.ts";
import { humanSize } from "../../../shared/dockerSize.ts";
import { displayName, READ_ONLY_REASON } from "./dockerState.ts";
import type { diskMath, SegmentKey } from "./dockerDisk.ts";
import type { ImageKind, imagesView, NetworkKind, networksView } from "./dockerResources.ts";
import type { VolumeState, volumesView } from "./dockerVolumeView.ts";

/** One image row has a repository, a tag and an id; several rows can share an id, so the key is all three. */
export const imageKey = (i: Pick<DockerImage, "id" | "repository" | "tag">): string => `${i.repository}:${i.tag}@${i.id}`;

export type ImageItem = ReturnType<typeof imagesView>["items"][number];
export type VolumeItem = ReturnType<typeof volumesView>["items"][number];
export type NetworkItem = ReturnType<typeof networksView>["items"][number];

/* ---- shapes: colour + shape + word, so none of them is carried by colour alone ---- */
export type ShapeKey = "use" | "idle" | "kept" | "safe" | "dang";
export const SHAPES: Record<ShapeKey, { word: string; tone: string }> = {
  use: { word: "in use", tone: "var(--success)" },
  idle: { word: "unused", tone: "var(--text3)" },
  kept: { word: "kept", tone: "var(--info)" },
  safe: { word: "safe to remove", tone: "var(--warning)" },
  dang: { word: "dangling", tone: "var(--text4)" },
};
export interface Worn { shape: ShapeKey; word: string }

export function imageShape(i: ImageItem): Worn {
  if (i.goneNow) return { shape: "safe", word: "worktree gone" };
  const shape: ShapeKey = i.kind === "dang" ? "dang" : i.kind === "idle" ? "idle" : "use";
  return { shape, word: SHAPES[shape].word };
}
export const volumeShape = (i: VolumeItem): Worn => ({ shape: i.state, word: SHAPES[i.state].word });
export function networkShape(i: NetworkItem): Worn {
  return i.kind === "built" ? { shape: "kept", word: "built in" }
    : i.kind === "use" ? { shape: "use", word: "in use" }
    : { shape: "dang", word: "nothing attached" };
}

/* ---- the header filter, shared by the three views ---- */
const matches = (q: string, parts: (string | null | undefined)[]): boolean => {
  const needle = q.trim().toLowerCase();
  return !needle || parts.filter(Boolean).join(" ").toLowerCase().includes(needle);
};
const holderNames = (cs: DockerContainer[]) => cs.flatMap((c) => [c.name, displayName(c)]);

export const imageHit = (i: ImageItem, q: string): boolean =>
  matches(q, [i.image.repository, i.image.tag, i.image.id, ...holderNames(i.usedBy)]);
export const volumeHit = (i: VolumeItem, q: string): boolean =>
  matches(q, [i.volume.name, i.kind === "nm" ? "node_modules" : "data", ...(i.volume.worktrees ?? []), ...holderNames(i.holders)]);
export const networkHit = (i: NetworkItem, q: string): boolean =>
  matches(q, [i.network.name, i.network.driver, i.network.subnet, ...(i.network.members ?? []).map((m) => m.name)]);

/* ---- the "..." menus ---- */
export interface XMenuItem { verb: "copy" | "disk" | "look" | "rm"; label: string; disabled?: boolean; reason?: string; danger?: boolean }
export type XMenuEntry = XMenuItem | { verb: "hr" };

/** Reading stays on in a read-only instance; Remove is off with the reason it is off. */
const removeEntry = (removable: boolean, why: string | undefined, readOnly: boolean): XMenuItem =>
  readOnly || !removable
    ? { verb: "rm", label: "Remove…", danger: true, disabled: true, reason: readOnly ? READ_ONLY_REASON : why }
    : { verb: "rm", label: "Remove…", danger: true };

export const imageMenu = (i: ImageItem, readOnly: boolean): XMenuEntry[] =>
  [{ verb: "copy", label: "Copy id" }, { verb: "disk", label: "Show in Disk" }, { verb: "hr" }, removeEntry(i.removable, i.why, readOnly)];
export const volumeMenu = (i: VolumeItem, readOnly: boolean): XMenuEntry[] =>
  [{ verb: "copy", label: "Copy name" }, { verb: "look", label: "Look inside" }, { verb: "hr" }, removeEntry(i.removable, i.why, readOnly)];

/** `members` missing means `network inspect` failed: unknown is not empty, so it is not offered. */
export const networkRemovable = (i: NetworkItem): { ok: boolean; why?: string } =>
  i.kind === "none" && !i.network.members ? { ok: false, why: "Could not read what is attached, so it is not offered for removal." }
    : { ok: i.removable, why: i.why };
export function networkMenu(i: NetworkItem, readOnly: boolean): XMenuEntry[] {
  const r = networkRemovable(i);
  return [{ verb: "copy", label: "Copy name" }, { verb: "hr" }, removeEntry(r.ok, r.why, readOnly)];
}

/* ---- networks: who is on what ---- */
export interface NetworkLink extends DockerNetworkMember { also: string[] }
/** Per network name: its members, each with the other networks it is on. */
export function networkLinks(networks: DockerNetwork[]): Record<string, NetworkLink[]> {
  const on = new Map<string, string[]>();
  for (const n of networks) for (const m of n.members ?? []) on.set(m.id, [...(on.get(m.id) ?? []), n.name]);
  return Object.fromEntries(networks.map((n) => [n.name, (n.members ?? []).map((m) => ({ ...m, also: (on.get(m.id) ?? []).filter((x) => x !== n.name) }))]));
}

/* ---- the answer cards ---- */
export type CardIcon = "check" | "moon" | "broom" | "lock";
export interface AnswerSpec<K extends string = string> { id: K; tone: string; icon: CardIcon; n: number; word: string; detail: string; now: string }
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

export function imageAnswers(v: ReturnType<typeof imagesView>): AnswerSpec<ImageKind>[] {
  const { use, idle, dang } = v.groups;
  const users = new Set(use.flatMap((i) => i.usedBy.map((c) => c.id))).size;
  return [
    { id: "use", tone: "var(--success)", icon: "check", n: use.length, word: "In use",
      detail: use.length ? `needed by ${plural(users, "container")}` : "no container uses an image", now: `${humanSize(v.bytes.use)} on disk` },
    { id: "idle", tone: "var(--text3)", icon: "moon", n: idle.length, word: "Unused",
      detail: v.goneNow.length ? `${v.goneNow.length} from removed worktrees` : idle.length ? "built or pulled, not running" : "nothing unused",
      now: idle.length ? `${humanSize(v.bytes.idle)} · can be pulled or built again` : "nothing to free" },
    { id: "dang", tone: "var(--text4)", icon: "broom", n: dang.length, word: "Dangling",
      detail: dang.length ? "untagged layers left by rebuilds" : "no leftovers",
      now: dang.length ? `${humanSize(v.bytes.dang)} that no tag points to` : "nothing to free" },
  ];
}

/** `measured`: false until the sizes arrive, so a card never says "0 B" for "not asked yet". */
export function volumeAnswers(v: ReturnType<typeof volumesView>, measured: boolean): AnswerSpec<VolumeState>[] {
  const { safe, use, kept } = v.groups;
  const size = (b: number, rest: string) => (measured ? `${humanSize(b)} ${rest}` : "measuring sizes…");
  return [
    { id: "safe", tone: "var(--warning)", icon: "broom", n: safe.length, word: "Safe to remove",
      detail: safe.length ? "node_modules with nothing attached" : "nothing idle",
      now: safe.length ? size(v.bytes.safe, "· the next install rebuilds them") : "nothing to free" },
    { id: "use", tone: "var(--success)", icon: "check", n: use.length, word: "In use",
      detail: use.length ? "attached to a container" : "nothing attached to a container", now: size(v.bytes.use, "on disk") },
    { id: "kept", tone: "var(--info)", icon: "lock", n: kept.length, word: "Kept",
      detail: kept.length ? "data volumes with nothing attached" : "no idle data volumes",
      now: kept.length ? size(v.bytes.kept, "· never removed from here") : "nothing idle" },
  ];
}

export function networkAnswers(v: ReturnType<typeof networksView>, links: Record<string, NetworkLink[]>): AnswerSpec<NetworkKind>[] {
  const { use, none, built } = v.groups;
  const connected = new Set(use.flatMap((i) => (links[i.network.name] ?? []).map((m) => m.id))).size;
  return [
    { id: "use", tone: "var(--success)", icon: "check", n: use.length, word: "In use",
      detail: use.length ? "containers sit on them" : "no container is on a network of yours", now: `${plural(connected, "container")} connected` },
    { id: "none", tone: "var(--text3)", icon: "moon", n: none.length, word: "Nothing attached",
      detail: none.length ? none.slice(0, 2).map((i) => i.network.name).join(", ") : "nothing is left over",
      now: none.length ? "safe to remove, nothing is lost" : "nothing to clean" },
    { id: "built", tone: "var(--info)", icon: "lock", n: built.length, word: "Built in",
      detail: built.map((i) => i.network.name).join(", "), now: "Docker keeps these; they cannot be removed" },
  ];
}

/* ---- the groups under the cards ---- */
export interface SectionDef<K extends string> { key: K; title: string; sub?: string }
/** The groups to draw: one when a card filters, none empty after the text filter. */
export function sectionsOf<K extends string, T>(groups: Record<K, T[]>, defs: readonly SectionDef<K>[], only: K | null, hit: (t: T) => boolean) {
  return defs.filter((d) => !only || d.key === only)
    .map((d) => ({ ...d, items: groups[d.key].filter(hit) }))
    .filter((s) => s.items.length > 0);
}

/* ---- the disk bar ---- */
export type ReclaimKey = "cache" | "orph" | "dang";
const SEGMENT_OF: Partial<Record<SegmentKey, ReclaimKey>> = { "cache-over": "cache", orphans: "orph", dangling: "dang" };

/** Each part's share of the bar. The part being freed goes to zero, and the bar's own transition shrinks it. */
export function stripeWidths(m: ReturnType<typeof diskMath>, busy: ReclaimKey | null) {
  return m.segments.map((s) => ({
    key: s.key, stripe: s.stripe, bytes: s.bytes,
    pct: busy && SEGMENT_OF[s.key] === busy ? 0 : m.total ? (s.bytes / m.total) * 100 : 0,
  }));
}
