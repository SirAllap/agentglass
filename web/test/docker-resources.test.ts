/*
 * Images and networks: which group each one is in, and what that group says.
 */
import { describe, expect, test } from "bun:test";
import type { DockerContainer, DockerImage, DockerNetwork } from "../../shared/types.ts";
import { imageKind, imagesView, isBuiltInNetwork, networkKind, networkMemberCounts, networksView } from "../src/lib/dockerResources.ts";

const ct = (image: string, over: Partial<DockerContainer> = {}): DockerContainer => ({
  id: image, name: "orbit-api-1", image, state: "running", status: "Up 1 hour", ports: "", project: "orbit",
  service: "api", workingDir: null, runningFor: "", size: "", ...over,
});
const img = (id: string, repository: string, tag: string, size: string, over: Partial<DockerImage> = {}): DockerImage => ({
  id, repository, tag, size, created: "3 hours ago", containers: "0", dangling: false, ...over,
});

describe("images", () => {
  const all = [
    img("aa", "acme/orbit-api", "dev", "780MB"),
    img("bb", "acme/orbit-web", "dev", "310MB"),
    img("cc", "acme/orbit-api", "old", "770MB"),
    img("dd3f9a1c2b7e", "<none>", "<none>", "200MB", { dangling: true }),
    img("ee", "postgres", "16", "430MB"),
  ];
  const running = [ct("acme/orbit-api:dev"), ct("postgres:16")];

  test("in use, unused, dangling", () => {
    const v = imagesView(all, running, []);
    expect(v.groups.use.map((x) => x.image.id)).toEqual(["aa", "ee"]);
    expect(v.groups.idle.map((x) => x.image.id).sort()).toEqual(["bb", "cc"]);
    expect(v.groups.dang.map((x) => x.image.id)).toEqual(["dd3f9a1c2b7e"]);
  });

  test("an image is used when a container was made from its repo:tag, its bare repo as latest, or its id", () => {
    expect(imageKind(all[0]!, running)).toBe("use");
    expect(imageKind(img("ff", "nginx", "latest", "1MB"), [ct("nginx")])).toBe("use");
    expect(imageKind(img("ff", "nginx", "1.27", "1MB"), [ct("nginx")])).toBe("idle");
    expect(imageKind(img("abc123", "x", "y", "1MB"), [ct("abc123")])).toBe("use");
  });

  test("a stopped container still holds its image", () => {
    expect(imageKind(all[0]!, [ct("acme/orbit-api:dev", { state: "exited" })])).toBe("use");
  });

  test("a dangling image that something runs from is in use, not dangling", () => {
    expect(imageKind(all[3]!, [ct("dd3f9a1c2b7e")])).toBe("use");
  });

  test("worktree-gone: flagged only while nothing uses it, and listed first in its group", () => {
    const v = imagesView(all, running, [{ id: "cc", tag: "acme/orbit-api:old", bytes: 770e6, worktree: "billing-fix" }]);
    expect(v.groups.idle[0]!.image.id).toBe("cc");
    expect(v.groups.idle[0]!.goneNow).toBe(true);
    const used = imagesView(all, [...running, ct("acme/orbit-api:old")], [{ id: "cc", tag: "acme/orbit-api:old", bytes: 770e6, worktree: "x" }]);
    expect(used.groups.use.find((x) => x.image.id === "cc")!.goneNow).toBe(false);
  });

  test("an in-use image cannot be removed, and says which container to stop first", () => {
    const v = imagesView(all, running, []);
    const a = v.groups.use.find((x) => x.image.id === "aa")!;
    expect(a.removable).toBe(false);
    expect(a.why).toBe("In use by orbit-api-1: remove that container first");
    expect(v.groups.idle[0]!.removable).toBe(true);
  });

  test("the sentence names what is unused and what is gone with a worktree", () => {
    const v = imagesView(all, running, [{ id: "cc", tag: "acme/orbit-api:old", bytes: 770e6, worktree: "billing-fix" }]);
    expect(v.lead).toBe("5 images, 2.5 GB.");
    expect(v.rest).toBe("1.3 GB unused, 770 MB of it gone with its worktree.");
  });

  test("when everything is in use there is nothing to clean", () => {
    const v = imagesView([all[0]!], running, []);
    expect(v.lead).toBe("Nothing to clean up here.");
    expect(v.rest).toBe("1 image, 780 MB, every one in use.");
  });

  test("group sizes add up, for the answer cards", () => {
    const v = imagesView(all, running, []);
    expect(v.bytes.use).toBe(780e6 + 430e6);
    expect(v.bytes.dang).toBe(200e6);
  });
});

describe("networks", () => {
  const n = (name: string): DockerNetwork => ({ id: name, name, driver: "bridge", scope: "local" });

  test("bridge, host and none are built in", () => {
    for (const name of ["bridge", "host", "none"]) expect(isBuiltInNetwork(n(name))).toBe(true);
    expect(isBuiltInNetwork(n("orbit_default"))).toBe(false);
  });

  test("built in, in use, nothing attached", () => {
    expect(networkKind(n("bridge"), 0)).toBe("built");
    expect(networkKind(n("orbit_default"), 3)).toBe("use");
    expect(networkKind(n("old_default"), 0)).toBe("none");
  });

  test("only a user network with nothing on it can be removed", () => {
    const v = networksView([n("orbit_default"), n("old_default"), n("bridge")], { orbit_default: 3 });
    const by = Object.fromEntries(v.items.map((i) => [i.network.name, i]));
    expect(by.old_default!.removable).toBe(true);
    expect(by.orbit_default!.removable).toBe(false);
    expect(by.orbit_default!.why).toBe("3 containers attached: remove them from this network first.");
    expect(by.bridge!.removable).toBe(false);
    expect(by.bridge!.why).toBe("Built in: Docker needs it and cannot remove it.");
  });

  test("member counts come from the networks the server described", () => {
    const withMembers = { ...n("orbit_default"), members: [{ id: "aaaaaaaaaaaa", name: "orbit-web-1" }, { id: "bbbbbbbbbbbb", name: "orbit-db-1" }] };
    const counts = networkMemberCounts([withMembers, { ...n("old_default"), members: [] }, n("unknown")]);
    expect(counts).toEqual({ orbit_default: 2, old_default: 0 });
    expect(networksView([withMembers], counts).items[0]!.why).toBe("2 containers attached: remove them from this network first.");
  });

  test("a single member is singular", () => {
    const v = networksView([n("orbit_default")], { orbit_default: 1 });
    expect(v.items[0]!.why).toBe("1 container attached: remove it from this network first.");
  });

  test("the sentence counts built-in ones apart and names what can go", () => {
    const v = networksView([n("orbit_default"), n("old_default"), n("bridge"), n("host"), n("none")], { orbit_default: 2 });
    expect(v.lead).toBe("5 networks (3 built in).");
    expect(v.rest).toBe("1 has nothing attached and can go.");
    expect(networksView([n("orbit_default"), n("bridge")], { orbit_default: 2 }).rest).toBe("Every network of yours has something attached.");
  });

  test("groups: yours in use, yours with nothing, built in", () => {
    const v = networksView([n("a"), n("b"), n("bridge")], { a: 1 });
    expect(v.groups.use.map((i) => i.network.name)).toEqual(["a"]);
    expect(v.groups.none.map((i) => i.network.name)).toEqual(["b"]);
    expect(v.groups.built.map((i) => i.network.name)).toEqual(["bridge"]);
  });
});
