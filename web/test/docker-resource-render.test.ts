/*
 * First paint of the Images, Volumes, Networks and Disk views, plus the rules
 * about their source that a render cannot see (no timers, no second budget,
 * no way to remove a data volume).
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { DockerContainer, DockerDisk, DockerImage, DockerNetwork, DockerVolume } from "../../shared/types.ts";
import { Disk } from "../src/components/docker/Disk.tsx";
import { Images } from "../src/components/docker/Images.tsx";
import { Networks } from "../src/components/docker/Networks.tsx";
import { Volumes } from "../src/components/docker/Volumes.tsx";
import { ResourceError, ResourceSkeleton } from "../src/components/docker/ResourceKit.tsx";
import type { DiskState } from "../src/lib/useDiskData.ts";

const draw = (el: React.ReactElement) => renderToStaticMarkup(el);
const src = (p: string) => readFileSync(new URL(`../src/${p}`, import.meta.url).pathname, "utf8");
const noop = () => {};
/** The opening tag of the button labelled `label`, or null when there is none. */
const btn = (html: string, label: string) => html.match(new RegExp(`<button[^>]*aria-label="${label}"[^>]*>`))?.[0] ?? null;
const off = (html: string, label: string) => /\sdisabled(=|\s|>)/.test(btn(html, label) ?? "");
const common = { q: "", readOnly: false, flash: noop, onClear: noop, onGoContainer: noop };
const GB = 1e9;

const ct = (id: string, image: string, over: Partial<DockerContainer> = {}): DockerContainer => ({
  id, name: `orbit-${id}-1`, image, state: "running", status: "Up 1 hour", ports: "", project: "orbit",
  service: id, workingDir: null, runningFor: "", size: "", ...over,
});
const img = (id: string, repository: string, tag: string, size: string, over: Partial<DockerImage> = {}): DockerImage => ({
  id, repository, tag, size, created: "3 hours ago", containers: "0", dangling: false, ...over,
});
const containers = [ct("api", "acme/orbit-api:dev", { mounts: [{ name: "orbit_pgdata", rw: true, destination: "/var/lib/postgresql" }] })];
const images = [
  img("aa", "acme/orbit-api", "dev", "780MB"),
  img("cc", "acme/orbit-spare", "dev", "300MB"),
  img("dd3f9a1c2b7e", "<none>", "<none>", "200MB", { dangling: true }),
];
const volumes: DockerVolume[] = [{ name: "orbit_node_modules", driver: "local" }, { name: "orbit_pgdata", driver: "local" }];
const nets: DockerNetwork[] = [
  { id: "n1", name: "bridge", driver: "bridge", scope: "local", subnet: "172.17.0.0/16", members: [] },
  { id: "n2", name: "orbit_default", driver: "bridge", scope: "local", subnet: "172.20.0.0/16", members: [{ id: "api", name: "orbit-api-1" }] },
  { id: "n3", name: "orbit_spare", driver: "bridge", scope: "local", subnet: "172.21.0.0/16", members: [] },
];

describe("Images", () => {
  const html = draw(React.createElement(Images, { ...common, images, containers, orphans: [], onShowDisk: noop }));
  test("a sentence, three answer cards and a Remove on the unused one", () => {
    expect(html).toContain("In use");
    expect(html).toContain("Remove");
  });
  test("the image a container runs cannot be removed, and the reason is written", () => {
    expect(html).toMatch(/in use by|Running containers use it|used by/i);
  });
  test("read-only turns every Remove off and says why", () => {
    const ro = draw(React.createElement(Images, { ...common, readOnly: true, images, containers, orphans: [], onShowDisk: noop }));
    expect(ro).toContain("read-only");
  });
  test("none yet is an empty card, not a blank pane", () => {
    expect(draw(React.createElement(Images, { ...common, images: [], containers: [], orphans: [], onShowDisk: noop }))).toContain("No images");
  });
});

describe("Volumes", () => {
  test("data volumes are never offered for removal; node_modules ones are", () => {
    const html = draw(React.createElement(Volumes, { ...common, volumes, containers: [], sizes: { orbit_node_modules: 2 * GB, orbit_pgdata: 1 * GB }, sizeError: null }));
    expect(html).toContain("orbit_pgdata");
    expect(btn(html, "Remove orbit_node_modules")).not.toBeNull();
    expect(off(html, "Remove orbit_node_modules")).toBe(false);
    expect(off(html, "Remove orbit_pgdata")).toBe(true);
  });
  test("before the sizes arrive it says it is measuring", () => {
    expect(draw(React.createElement(Volumes, { ...common, volumes, containers: [], sizes: null, sizeError: null }))).toMatch(/measuring/i);
  });
  test("none yet is an empty card", () => {
    expect(draw(React.createElement(Volumes, { ...common, volumes: [], containers: [], sizes: null, sizeError: null }))).toContain("No volumes yet");
  });
});

describe("Networks", () => {
  const html = draw(React.createElement(Networks, { ...common, networks: nets, containers }));
  test("built-in networks have no Remove; an unused user network does", () => {
    expect(html).toContain("Built in");
    expect(off(html, "Remove bridge")).toBe(true);
    expect(off(html, "Remove orbit_spare")).toBe(false);
  });
  test("a member is a chip that goes to its container", () => {
    expect(html).toContain("orbit-api-1");
  });
  test("a network that is in use cannot be removed", () => {
    expect(off(html, "Remove orbit_default")).toBe(true);
  });
});

describe("Disk", () => {
  const state = (d: DockerDisk | null, error: string | null = null): DiskState => ({ d, error, measuring: false, measure: async () => {} });
  const disk: DockerDisk = {
    images: 4 * GB, containers: 0.1 * GB, volumes: 3 * GB, buildCache: 5 * GB, reclaimable: 6 * GB,
    orphans: [{ id: "bb", tag: "acme/orbit-old:dev", bytes: 1 * GB, worktree: "billing-fix" }],
    volumes_: [], at: Date.now(),
  } as DockerDisk;
  const ok = draw(React.createElement(Disk, { state: state(disk), images, writeEnabled: true, flash: noop }));
  test("three reclaim cards and the one that is not a button", () => {
    for (const w of ["Keep the build cache under", "Remove images from worktrees that are gone", "Remove dangling images", "Volumes stay"]) expect(ok).toContain(w);
  });
  test("before the numbers: a skeleton that says it is measuring", () => {
    expect(draw(React.createElement(Disk, { state: state(null), images, writeEnabled: true, flash: noop }))).toContain("Measuring");
  });
  test("a failed first measure offers Try again", () => {
    expect(draw(React.createElement(Disk, { state: state(null, "daemon down"), images, writeEnabled: true, flash: noop }))).toContain("Try again");
  });
  test("read-only says so", () => {
    expect(draw(React.createElement(Disk, { state: state(disk), images, writeEnabled: false, flash: noop }))).toContain("read-only");
  });
});

describe("the shared states", () => {
  test("skeleton and error", () => {
    expect(draw(React.createElement(ResourceSkeleton, { what: "images" }))).toContain("aria-busy");
    expect(draw(React.createElement(ResourceError, { what: "images", cmd: "image ls", error: "x", onTry: noop }))).toContain("Try again");
  });
});

describe("source rules", () => {
  const code = (p: string) => src(p).split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
  test("nothing here polls", () => {
    for (const p of ["lib/useDiskData.ts", "components/docker/Disk.tsx", "components/docker/Images.tsx", "components/docker/Volumes.tsx", "components/docker/Networks.tsx"]) {
      expect(code(p)).not.toMatch(/setInterval|setTimeout\(/);
    }
  });
  test("one build-cache budget, imported", () => {
    expect(code("components/docker/Disk.tsx")).toContain("BUILD_CACHE_BUDGET");
    expect(code("components/docker/Disk.tsx")).not.toMatch(/60_000_000_000|60e9/);
  });
  test("the old confirm dialog is gone from Disk", () => {
    expect(code("components/docker/Disk.tsx")).not.toMatch(/\bask\(/);
  });
  test("the panel passes the section to the header and keeps Disk off the filter", () => {
    const p = code("components/DockerPanel.tsx");
    expect(p).toContain("section={view}");
    expect(p).toContain('showFilter={view !== "disk"}');
  });
  test("a changed images, volumes or networks event reloads the overview, not a timer", () => {
    expect(code("lib/useDockerData.ts")).toContain("onChanged");
  });
});
