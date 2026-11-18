/*
 * Images and networks: which group each one is in, and what that group says.
 *
 * Same shape as the Volumes view: a sentence on top, three answer cards that
 * also filter, then grouped cards. Removal is only ever offered for something
 * nothing depends on, and the reason it is not offered is written here, once.
 */
import type { DockerContainer, DockerDisk, DockerImage, DockerNetwork } from "../../../shared/types.ts";
import { humanSize } from "../../../shared/dockerSize.ts";
import { imageBytes, imageSizeIndex, orphanUniqueBytes } from "./dockerDisk.ts";

export type ImageKind = "use" | "idle" | "dang";

const HEX_ID = /^(?:sha256:)?[0-9a-f]{6,}$/;
const bareId = (s: string) => s.replace(/^sha256:/, "");

/** A container holds an image by `repo:tag`, by bare repo (docker reads that as
 *  `latest`), or by id. Stopped containers hold theirs too. */
export function usedBy(img: DockerImage, containers: DockerContainer[]): DockerContainer[] {
  return containers.filter((c) => {
    const ref = c.image || "";
    if (ref === `${img.repository}:${img.tag}` || (img.tag === "latest" && ref === img.repository)) return true;
    return HEX_ID.test(ref) && !!img.id && (bareId(img.id).startsWith(bareId(ref)) || bareId(ref).startsWith(bareId(img.id)));
  });
}

export function imageKind(img: DockerImage, containers: DockerContainer[]): ImageKind {
  if (usedBy(img, containers).length) return "use";
  return img.dangling ? "dang" : "idle";
}

/** Bytes of a list of image rows, each image id counted once: `docker images`
 *  gives one row per tag, and every tag of one id carries the image's full size. */
export const sum = (xs: { bytes: number; image?: { id?: string } }[]) => {
  const seen = new Set<string>();
  let n = 0;
  for (const x of xs) {
    const id = x.image?.id;
    if (id) { if (seen.has(id)) continue; seen.add(id); }
    n += x.bytes;
  }
  return n;
};
const count = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/**
 * What the Images view says, kept out of sync with `docker system df` for a
 * while: `docker images` lists one row per TAG, and its `Size` counts shared
 * layers once per row — 30 tags of one app image, 6.2 GB each, sharing almost
 * every layer, summed to 219 GB on a machine `system df` itself called 41 GB.
 * The total, the count and "unused" below come from `disk` (the daemon's own
 * arithmetic) whenever it has arrived; summing the rows is only the fallback
 * for the moment before the first `system df` answer is in.
 */
export function imagesView(
  images: DockerImage[], containers: DockerContainer[], orphans: DockerDisk["orphans"],
  disk?: Pick<DockerDisk, "images" | "imageCount" | "imageReclaimable" | "perImage"> | null,
) {
  const gone = new Set(orphans.flatMap((o) => [o.id, o.tag]));
  const sizes = imageSizeIndex(disk?.perImage);
  const items = images.map((image) => {
    const users = usedBy(image, containers);
    const kind = imageKind(image, containers);
    const isGone = gone.has(image.id) || gone.has(`${image.repository}:${image.tag}`);
    const sz = sizes.get(image.id);
    return {
      image, kind, bytes: imageBytes(image), unique: sz?.unique ?? null, shared: sz?.shared ?? null, created: sz?.created ?? null, usedBy: users,
      /** Built by a checkout that was removed, and nothing runs from it. */
      goneNow: isGone && !users.length,
      removable: !users.length,
      why: users.length
        ? `In use by ${users.map((c) => c.name).join(", ")}: remove ${users.length === 1 ? "that container" : "those containers"} first`
        : undefined,
    };
  });
  const group = (k: ImageKind) =>
    items.filter((i) => i.kind === k).sort((a, b) => Number(b.goneNow) - Number(a.goneNow) || b.bytes - a.bytes);
  const groups = { use: group("use"), idle: group("idle"), dang: group("dang") };
  const bytes = { use: sum(groups.use), idle: sum(groups.idle), dang: sum(groups.dang) };
  const goneNow = items.filter((i) => i.goneNow);
  // Shared with diskMath's orphan card (dockerDisk.ts), so the two can never
  // print a different "gone with their worktree" number for the same list.
  const goneBytes = orphanUniqueBytes(orphans);
  const itemCount = items.length;
  const hasUnused = groups.idle.length > 0 || groups.dang.length > 0;
  const total = humanSize(disk?.images ?? sum(items));
  const unused = disk?.imageReclaimable ?? (bytes.idle + bytes.dang);
  const shownCount = disk?.imageCount ?? itemCount;
  return {
    items, groups, bytes, goneNow, goneBytes,
    lead: hasUnused ? `${count(shownCount, "image")}, ${total}.` : "Nothing to clean up here.",
    rest: hasUnused
      ? `${humanSize(unused)} unused${goneNow.length ? `, ${humanSize(goneBytes)} of it gone with ${goneNow.length === 1 ? "its" : "their"} worktree` : ""}.`
      : `${count(shownCount, "image")}, ${total}, every one in use.`,
  };
}

export type NetworkKind = "built" | "use" | "none";
const BUILT_IN = new Set(["bridge", "host", "none"]);

export const isBuiltInNetwork = (n: Pick<DockerNetwork, "name">): boolean => BUILT_IN.has(n.name);

export const networkKind = (n: Pick<DockerNetwork, "name">, members: number): NetworkKind =>
  isBuiltInNetwork(n) ? "built" : members ? "use" : "none";

/** Containers per network name, for the networks the server described. */
export function networkMemberCounts(networks: DockerNetwork[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const n of networks) if (n.members) counts[n.name] = n.members.length;
  return counts;
}

/** Only a network of yours with nothing on it can go. `members` is containers
 *  per network name (see networkMemberCounts). */
export function networksView(networks: DockerNetwork[], members: Record<string, number>) {
  const items = networks.map((network) => {
    const m = members[network.name] ?? 0;
    const kind = networkKind(network, m);
    return {
      network, kind, members: m, removable: kind === "none",
      why: kind === "built" ? "Built in: Docker needs it and cannot remove it."
        : kind === "use" ? `${count(m, "container")} attached: remove ${m === 1 ? "it" : "them"} from this network first.`
        : undefined,
    };
  });
  const groups = {
    use: items.filter((i) => i.kind === "use"),
    none: items.filter((i) => i.kind === "none"),
    built: items.filter((i) => i.kind === "built"),
  };
  return {
    items, groups,
    lead: `${items.length} networks (${groups.built.length} built in).`,
    rest: groups.none.length
      ? `${groups.none.length} ${groups.none.length === 1 ? "has" : "have"} nothing attached and can go.`
      : "Every network of yours has something attached.",
  };
}
