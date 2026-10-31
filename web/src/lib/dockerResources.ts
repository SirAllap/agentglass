/*
 * Images and networks: which group each one is in, and what that group says.
 *
 * Same shape as the Volumes view: a sentence on top, three answer cards that
 * also filter, then grouped cards. Removal is only ever offered for something
 * nothing depends on, and the reason it is not offered is written here, once.
 */
import type { DockerContainer, DockerDisk, DockerImage, DockerNetwork } from "../../../shared/types.ts";
import { humanSize } from "../../../shared/dockerSize.ts";
import { imageBytes } from "./dockerDisk.ts";

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

const sum = (xs: { bytes: number }[]) => xs.reduce((n, x) => n + x.bytes, 0);
const count = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

export function imagesView(images: DockerImage[], containers: DockerContainer[], orphans: DockerDisk["orphans"]) {
  const gone = new Set(orphans.flatMap((o) => [o.id, o.tag]));
  const items = images.map((image) => {
    const users = usedBy(image, containers);
    const kind = imageKind(image, containers);
    const isGone = gone.has(image.id) || gone.has(`${image.repository}:${image.tag}`);
    return {
      image, kind, bytes: imageBytes(image), usedBy: users,
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
  const unused = bytes.idle + bytes.dang;
  const goneNow = items.filter((i) => i.goneNow);
  const total = humanSize(sum(items));
  return {
    items, groups, bytes, goneNow,
    lead: unused ? `${count(items.length, "image")}, ${total}.` : "Nothing to clean up here.",
    rest: unused
      ? `${humanSize(unused)} unused${goneNow.length ? `, ${humanSize(sum(goneNow))} of it gone with ${goneNow.length === 1 ? "its" : "their"} worktree` : ""}.`
      : `${count(items.length, "image")}, ${total}, every one in use.`,
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
