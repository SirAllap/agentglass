/*
 * The words a volume row uses.
 *
 * Small on purpose, and separate from the component for the same reason as the
 * rest of this view's helpers: "3 days ago" is a sentence about somebody's
 * machine, and a wrong one — an epoch parsed as a string, a future date read as
 * "in -2 days" — is the kind of thing that gets noticed and not reported.
 */
import type { DockerContainer, DockerVolume } from "../../../shared/types.ts";
import { humanSize } from "../../../shared/dockerSize.ts";
import { isNodeModulesVolume } from "../../../shared/dockerVolume.ts";
export { humanSize };

/**
 * How long ago, in words, from an ISO timestamp.
 *
 * Coarse by design: nobody needs "3 days, 4 hours" to decide whether a bundle
 * is theirs. Anything unparseable comes back empty rather than as "NaN days
 * ago", which is the failure this exists to make impossible.
 */
export function sinceLabel(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const s = Math.round((now - t) / 1000);
  // A clock that is behind the container's is not worth a paragraph; it reads
  // as "just now" rather than as a negative number.
  if (s < 90) return "just now";
  const n = (k: number, unit: string) => `${k} ${unit}${k === 1 ? "" : "s"} ago`;
  const m = Math.round(s / 60);
  if (m < 60) return n(m, "minute");
  const h = Math.round(m / 60);
  if (h < 24) return n(h, "hour");
  const d = Math.round(h / 24);
  if (d < 2) return "yesterday";
  return d < 14 ? n(d, "day") : n(Math.round(d / 7), "week");
}

/** An anonymous volume is named by its 64-hex id: show its two ends, keep the
 *  whole name in the title. */
export function volumeLabel(name: string): string {
  return /^[0-9a-f]{64}$/.test(name) ? `${name.slice(0, 4)}...${name.slice(-4)}` : name;
}

/* ---- data against node_modules ----------------------------------------------
 * A node_modules volume is rebuilt by the next install; a data volume holds
 * things that exist nowhere else. The view hangs on telling them apart, and
 * the guess when unsure is always "data": the wrong guess must be the safe one.
 */
export type VolumeKind = "nm" | "data";
export type VolumeState = "use" | "safe" | "kept";

/** By the compose-style suffix, or by where a container mounts it. Only the
 *  suffix counts: `orbit_node_modules_backup` is somebody's data. */
export function volumeKind(v: Pick<DockerVolume, "name">, containers: DockerContainer[]): VolumeKind {
  if (isNodeModulesVolume(v.name)) return "nm";
  const mountedAtModules = containers.some((c) =>
    c.mounts?.some((m) => m.name === v.name && /(?:^|\/)node_modules\/?$/.test(m.destination)));
  return mountedAtModules ? "nm" : "data";
}

const NOTE: Record<string, string> = {
  safe: "Nothing is attached. The next install in the worktree rebuilds it.",
  "use:nm": "Rebuilt by the next install, so it can go once nothing uses it.",
  "use:data": "Holds data that is not stored anywhere else. It stays.",
  kept: "Data volume: never removed from here, even with nothing attached.",
};

/** Volumes, classified. Removal is offered for `safe` only (node_modules, with
 *  nothing attached): data volumes are in no bulk total and never removable. */
export function volumesView(volumes: DockerVolume[], containers: DockerContainer[], sizes: Record<string, number | null>) {
  const items = volumes.map((volume) => {
    const kind = volumeKind(volume, containers);
    const holders = containers.filter((c) => c.mounts?.some((m) => m.name === volume.name));
    const state: VolumeState = holders.length || (volume.links ?? 0) > 0 ? "use" : kind === "nm" ? "safe" : "kept";
    return {
      volume, kind, state, holders,
      bytes: sizes[volume.name] ?? volume.bytes ?? null,
      removable: state === "safe",
      note: NOTE[state === "use" ? `use:${kind}` : state]!,
      why: state === "safe" ? undefined
        : state === "use"
          ? `Attached to ${holders.map((c) => c.name).join(", ") || "a container"}: remove ${holders.length === 1 ? "that container" : "those containers"} first.`
          : "Data volumes are never removed from here: they hold things that exist nowhere else. docker volume rm is the way if you are sure.",
    };
  });
  const group = (s: VolumeState) => items.filter((i) => i.state === s).sort((a, b) => (b.bytes ?? -1) - (a.bytes ?? -1));
  const groups = { safe: group("safe"), use: group("use"), kept: group("kept") };
  const sum = (xs: { bytes: number | null }[]) => xs.reduce((n, x) => n + (x.bytes ?? 0), 0);
  const total = humanSize(sum(items));
  const n = items.length;
  const vols = `${n} volume${n === 1 ? "" : "s"}`;
  const dataCount = items.filter((i) => i.kind === "data").length;
  const safeBytes = sum(groups.safe);
  return {
    items, groups, safeBytes,
    bytes: { safe: safeBytes, use: sum(groups.use), kept: sum(groups.kept) },
    lead: groups.safe.length ? `${vols}, ${total}.` : "Nothing to remove here.",
    rest: groups.safe.length
      ? `Data volumes are kept; ${humanSize(safeBytes)} of node_modules is safe to remove.`
      : `${vols}, ${total}. Data volumes are kept${dataCount ? ` (${dataCount})` : ""}; no node_modules volume is sitting idle.`,
  };
}
