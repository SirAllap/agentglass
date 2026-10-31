/*
 * The decisions behind the Images, Volumes, Networks and Disk cards: which
 * shape a thing wears, what the filter matches, what a "..." menu may offer,
 * what each answer card says, and how wide each part of the disk bar is.
 */
import { describe, expect, test } from "bun:test";
import type { DockerContainer, DockerDisk, DockerImage, DockerNetwork, DockerVolume } from "../../shared/types.ts";
import { diskMath } from "../src/lib/dockerDisk.ts";
import { imagesView, networkMemberCounts, networksView } from "../src/lib/dockerResources.ts";
import { volumesView } from "../src/lib/dockerVolumeView.ts";
import { READ_ONLY_REASON } from "../src/lib/dockerState.ts";
import {
  imageAnswers, imageHit, imageMenu, imageShape, networkAnswers, networkHit, networkLinks, networkMenu, networkShape,
  sectionsOf, stripeWidths, volumeAnswers, volumeHit, volumeMenu, volumeShape,
} from "../src/lib/dockerResourceUi.ts";

const GB = 1e9;
const ct = (id: string, image: string, over: Partial<DockerContainer> = {}): DockerContainer => ({
  id, name: `orbit-${id}-1`, image, state: "running", status: "Up 1 hour", ports: "", project: "orbit",
  service: id, workingDir: null, runningFor: "", size: "", ...over,
});
const img = (id: string, repository: string, tag: string, size: string, over: Partial<DockerImage> = {}): DockerImage => ({
  id, repository, tag, size, created: "3 hours ago", containers: "0", dangling: false, ...over,
});
const gone = (tag: string, id: string) => ({ id, tag, bytes: 1 * GB, worktree: "billing-fix" });

const containers = [ct("api", "acme/orbit-api:dev"), ct("web", "acme/orbit-web:dev")];
const images = [
  img("aa", "acme/orbit-api", "dev", "780MB"),
  img("bb", "acme/orbit-old", "dev", "1GB"),
  img("cc", "acme/orbit-spare", "dev", "300MB"),
  img("dd3f9a1c2b7e", "<none>", "<none>", "200MB", { dangling: true }),
  img("ee", "acme/orbit-web", "dev", "310MB"),
];
const iv = imagesView(images, containers, [gone("acme/orbit-old:dev", "bb")]);
const item = (id: string) => iv.items.find((i) => i.image.id === id)!;

describe("the shape a thing wears", () => {
  test("an image: in use, unused, dangling, and gone with its worktree", () => {
    expect(imageShape(item("aa"))).toEqual({ shape: "use", word: "in use" });
    expect(imageShape(item("cc"))).toEqual({ shape: "idle", word: "unused" });
    expect(imageShape(item("dd3f9a1c2b7e"))).toEqual({ shape: "dang", word: "dangling" });
    expect(imageShape(item("bb"))).toEqual({ shape: "safe", word: "worktree gone" });
  });

  test("a volume follows its state; a network its kind", () => {
    const vol = (name: string): DockerVolume => ({ name, driver: "local" });
    const vv = volumesView([vol("orbit_node_modules"), vol("orbit_pgdata")], [], {});
    expect(vv.items.map(volumeShape).map((s) => s.shape)).toEqual(["safe", "kept"]);
    const nv = networksView(
      [{ id: "1", name: "bridge", driver: "bridge", scope: "local" }, { id: "2", name: "orbit_default", driver: "bridge", scope: "local", members: [] }],
      {},
    );
    expect(nv.items.map(networkShape)).toEqual([{ shape: "kept", word: "built in" }, { shape: "dang", word: "nothing attached" }]);
  });
});

describe("the header filter", () => {
  test("images match by name, tag, id and the container using them", () => {
    expect(imageHit(item("aa"), "")).toBe(true);
    expect(imageHit(item("aa"), "ORBIT-API")).toBe(true);
    expect(imageHit(item("aa"), "dev")).toBe(true);
    expect(imageHit(item("dd3f9a1c2b7e"), "dd3f9")).toBe(true);
    expect(imageHit(item("aa"), "web")).toBe(false);
    expect(imageHit(item("ee"), "orbit-web-1")).toBe(true);
  });

  test("volumes match by name, node_modules or data, worktree and holder", () => {
    const v: DockerVolume = { name: "orbit_pgdata", driver: "local", worktrees: ["billing-fix"] };
    const vv = volumesView([v], [ct("db", "postgres:16", { mounts: [{ name: "orbit_pgdata", rw: true, destination: "/var/lib/postgresql" }] })], {});
    const it = vv.items[0]!;
    for (const q of ["pgdata", "data", "billing", "orbit-db-1"]) expect(volumeHit(it, q)).toBe(true);
    expect(volumeHit(it, "node_modules")).toBe(false);
  });

  test("networks match by name, driver, subnet and member", () => {
    const n: DockerNetwork = { id: "1", name: "orbit_default", driver: "bridge", scope: "local", subnet: "172.20.0.0/16", members: [{ id: "api", name: "orbit-api-1" }] };
    const it = networksView([n], networkMemberCounts([n])).items[0]!;
    for (const q of ["default", "bridge", "172.20", "orbit-api-1"]) expect(networkHit(it, q)).toBe(true);
    expect(networkHit(it, "postgres")).toBe(false);
  });
});

describe("what a '...' menu offers", () => {
  const labels = (m: ReturnType<typeof imageMenu>) => m.map((e) => ("label" in e ? e.label : "-"));

  test("an image: copy id, show in Disk, then Remove", () => {
    expect(labels(imageMenu(item("cc"), false))).toEqual(["Copy id", "Show in Disk", "-", "Remove…"]);
  });

  test("Remove is off for an image in use, with the reason, and for a read-only instance", () => {
    const inUse = imageMenu(item("aa"), false).find((e) => e.verb === "rm")!;
    expect(inUse).toMatchObject({ disabled: true });
    expect("reason" in inUse && inUse.reason).toContain("orbit-api-1");
    const ro = imageMenu(item("cc"), true).find((e) => e.verb === "rm")!;
    expect(ro).toMatchObject({ disabled: true, reason: READ_ONLY_REASON });
    // Reading stays on when writing is off.
    expect(imageMenu(item("cc"), true).find((e) => e.verb === "copy")).not.toHaveProperty("disabled", true);
  });

  test("a data volume's Remove is off and says why; Look inside stays on", () => {
    const vv = volumesView([{ name: "orbit_pgdata", driver: "local" }], [], {});
    const m = volumeMenu(vv.items[0]!, false);
    expect(labels(m)).toEqual(["Copy name", "Look inside", "-", "Remove…"]);
    const rm = m.find((e) => e.verb === "rm")!;
    expect(rm).toMatchObject({ disabled: true });
    expect("reason" in rm && rm.reason).toContain("Data volumes are never removed");
  });

  test("a built-in network cannot be removed; a user network with nothing on it can", () => {
    const nv = networksView([
      { id: "1", name: "host", driver: "host", scope: "local" },
      { id: "2", name: "orbit_default", driver: "bridge", scope: "local", members: [] },
    ], {});
    expect(networkMenu(nv.items[0]!, false).find((e) => e.verb === "rm")).toMatchObject({ disabled: true });
    expect(networkMenu(nv.items[1]!, false).find((e) => e.verb === "rm")).not.toHaveProperty("disabled", true);
  });

  test("a network whose members could not be read is not offered for removal", () => {
    const nv = networksView([{ id: "2", name: "orbit_default", driver: "bridge", scope: "local" }], {});
    const rm = networkMenu(nv.items[0]!, false).find((e) => e.verb === "rm")!;
    expect(rm).toMatchObject({ disabled: true });
    expect("reason" in rm && rm.reason).toContain("what is attached");
  });
});

describe("a container on several networks", () => {
  test("is listed on each, and each says what else it is on", () => {
    const nets: DockerNetwork[] = [
      { id: "1", name: "orbit_default", driver: "bridge", scope: "local", members: [{ id: "api", name: "orbit-api-1" }, { id: "web", name: "orbit-web-1" }] },
      { id: "2", name: "orbit_db", driver: "bridge", scope: "local", members: [{ id: "api", name: "orbit-api-1" }] },
    ];
    const l = networkLinks(nets);
    expect(l.orbit_default!.map((m) => [m.id, m.also])).toEqual([["api", ["orbit_db"]], ["web", []]]);
    expect(l.orbit_db![0]!.also).toEqual(["orbit_default"]);
  });
});

describe("the answer cards", () => {
  test("images: three cards whose numbers are the groups'", () => {
    const [use, idle, dang] = imageAnswers(iv);
    expect([use!.n, idle!.n, dang!.n]).toEqual([2, 2, 1]);
    expect(use!.detail).toBe("needed by 2 containers");
    expect(idle!.detail).toBe("1 from removed worktrees");
    expect(dang!.now).toContain("no tag points to");
  });

  test("an empty group says so in words and its card has nothing to press", () => {
    const only = imagesView([img("aa", "acme/orbit-api", "dev", "780MB")], [containers[0]!], []);
    const [, idle, dang] = imageAnswers(only);
    expect(idle).toMatchObject({ n: 0, detail: "nothing unused", now: "nothing to free" });
    expect(dang).toMatchObject({ n: 0, detail: "no leftovers" });
  });

  test("volumes: Safe to remove, In use, Kept; sizes wait for the measure", () => {
    const vv = volumesView([{ name: "orbit_node_modules", driver: "local" }, { name: "orbit_pgdata", driver: "local" }], [], { orbit_node_modules: 2 * GB });
    const [safe, use, kept] = volumeAnswers(vv, true);
    expect([safe!.id, use!.id, kept!.id]).toEqual(["safe", "use", "kept"]);
    expect(safe!.now).toContain("2.0 GB");
    expect(kept!.now).toContain("never removed from here");
    expect(volumeAnswers(vv, false)[0]!.now).toContain("measuring");
  });

  test("networks: In use, Nothing attached, Built in", () => {
    const nets: DockerNetwork[] = [
      { id: "0", name: "bridge", driver: "bridge", scope: "local" },
      { id: "1", name: "orbit_default", driver: "bridge", scope: "local", members: [{ id: "api", name: "a" }, { id: "web", name: "w" }] },
      { id: "2", name: "orbit_db", driver: "bridge", scope: "local", members: [{ id: "api", name: "a" }] },
      { id: "3", name: "old_default", driver: "bridge", scope: "local", members: [] },
    ];
    const [use, none, built] = networkAnswers(networksView(nets, networkMemberCounts(nets)), networkLinks(nets));
    expect([use!.n, none!.n, built!.n]).toEqual([2, 1, 1]);
    expect(use!.now).toBe("2 containers connected");
    expect(none!.detail).toBe("old_default");
  });
});

describe("the groups under the cards", () => {
  const defs = [{ key: "use", title: "In use" }, { key: "idle", title: "Unused" }, { key: "dang", title: "Dangling" }] as const;
  test("a card filter keeps one group; the text filter drops what does not match and empty groups", () => {
    const all = sectionsOf(iv.groups, defs, null, () => true);
    expect(all.map((s) => [s.key, s.items.length])).toEqual([["use", 2], ["idle", 2], ["dang", 1]]);
    expect(sectionsOf(iv.groups, defs, "idle", () => true).map((s) => s.key)).toEqual(["idle"]);
    expect(sectionsOf(iv.groups, defs, null, (i) => imageHit(i, "spare")).map((s) => s.key)).toEqual(["idle"]);
  });
});

describe("the disk bar while something is being freed", () => {
  const disk: DockerDisk = { images: 4 * GB, containers: 0.3 * GB, volumes: 3 * GB, buildCache: 8 * GB, reclaimable: 0, orphans: [gone("acme/orbit-old:dev", "bb")], volumes_: [], at: 0 };
  const m = diskMath(disk, images, 5 * GB);

  test("every striped part keeps its width until its own button is pressed", () => {
    const w = stripeWidths(m, null);
    expect(w.reduce((n, s) => n + s.pct, 0)).toBeCloseTo(100, 5);
    expect(w.filter((s) => s.stripe).map((s) => s.key).sort()).toEqual(["cache-over", "dangling", "orphans"]);
  });

  test("the part being freed goes to zero, the others stay", () => {
    const before = stripeWidths(m, null);
    const during = stripeWidths(m, "cache");
    expect(during.find((s) => s.key === "cache-over")!.pct).toBe(0);
    expect(during.find((s) => s.key === "orphans")!.pct).toBe(before.find((s) => s.key === "orphans")!.pct);
    expect(stripeWidths(m, "orph").find((s) => s.key === "orphans")!.pct).toBe(0);
    expect(stripeWidths(m, "dang").find((s) => s.key === "dangling")!.pct).toBe(0);
  });

  test("the dangling ids are the ones the card would remove, not the worktree-gone ones", () => {
    expect(m.danglingIds).toEqual(["dd3f9a1c2b7e"]);
  });
});
