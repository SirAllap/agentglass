/*
 * The words a volume row uses.
 *
 * Both of these print somebody's machine back at them, and both have a failure
 * mode that gets seen and not reported: a size that reads as empty when it is
 * really unknown, and a date that reads as "NaN days ago".
 */
import { describe, expect, test } from "bun:test";
import { humanSize, sinceLabel, volumeLabel } from "../src/lib/dockerVolumeView.ts";

describe("sizes", () => {
  test("read at a glance", () => {
    expect(humanSize(1_900_000_000)).toBe("1.9 GB");
    expect(humanSize(318_000_000)).toBe("318 MB");
    expect(humanSize(0)).toBe("0 B");
  });

  /* Unknown and empty are different answers, and conflating them is how
     somebody deletes a volume that was simply never measured. */
  test("unknown is not zero", () => {
    expect(humanSize(null)).toBe("—");
    expect(humanSize(undefined)).toBe("—");
  });
});

describe("how long ago", () => {
  const now = Date.parse("2026-08-19T12:00:00.000Z");

  test("coarse, because nobody decides anything on the minutes", () => {
    expect(sinceLabel("2026-08-19T11:58:00.000Z", now)).toBe("2 minutes ago");
    expect(sinceLabel("2026-08-19T06:00:00.000Z", now)).toBe("6 hours ago");
    expect(sinceLabel("2026-08-16T12:00:00.000Z", now)).toBe("3 days ago");
    expect(sinceLabel("2026-07-08T12:00:00.000Z", now)).toBe("6 weeks ago");
  });

  test("a day ago reads 'yesterday', one unit is singular", () => {
    expect(sinceLabel("2026-08-18T10:00:00.000Z", now)).toBe("yesterday");
    expect(sinceLabel("2026-08-19T10:30:00.000Z", now)).toBe("2 hours ago");
    expect(sinceLabel("2026-08-19T11:00:00.000Z", now)).toBe("1 hour ago");
  });

  test("an anonymous volume shows the two ends of its id", () => {
    const id = "0d3c" + "5".repeat(56) + "e19a";
    expect(volumeLabel(id)).toBe("0d3c...e19a");
    expect(volumeLabel("orbit_pgdata")).toBe("orbit_pgdata");
  });

  test("a moment ago is 'just now', not '0m'", () => {
    expect(sinceLabel("2026-08-19T11:59:40.000Z", now)).toBe("just now");
  });

  /* A container's clock can be ahead of ours. "in -2 minutes" is the kind of
     thing people screenshot. */
  test("a timestamp in the future reads as just now", () => {
    expect(sinceLabel("2026-08-19T12:00:30.000Z", now)).toBe("just now");
  });

  test("nothing to say about nothing", () => {
    expect(sinceLabel(null, now)).toBe("");
    expect(sinceLabel("", now)).toBe("");
    expect(sinceLabel("not a date", now)).toBe("");
  });
});

/* ---- data against node_modules, and what each may do ------------------------
   A node_modules volume is rebuilt by the next install; a data volume holds
   things that exist nowhere else. The whole view hangs on telling them apart,
   and on never offering the second one for removal. */
import type { DockerContainer, DockerVolume } from "../../shared/types.ts";
import { volumeKind, volumesView } from "../src/lib/dockerVolumeView.ts";

const vol = (name: string, over: Partial<DockerVolume> = {}): DockerVolume => ({ name, driver: "local", ...over });
const holder = (name: string, ...vols: string[]): DockerContainer => ({
  id: name, name, image: "acme/orbit:dev", state: "running", status: "Up 1 hour", ports: "", project: "orbit", service: null,
  workingDir: null, runningFor: "", size: "", mounts: vols.map((v) => ({ name: v, rw: true, destination: v.includes("node_modules") ? "/app/node_modules" : "/var/lib/data" })),
});

describe("data or node_modules", () => {
  test("by name, with compose's project prefix", () => {
    expect(volumeKind(vol("orbit_node_modules"), [])).toBe("nm");
    expect(volumeKind(vol("orbit-billing-fix_node_modules"), [])).toBe("nm");
    expect(volumeKind(vol("orbit_pgdata"), [])).toBe("data");
  });
  test("a lookalike is data: only the suffix counts", () => {
    expect(volumeKind(vol("orbit_node_modules_backup"), [])).toBe("data");
    expect(volumeKind(vol("my_node_modules_cache_db"), [])).toBe("data");
  });
  test("a volume mounted at /node_modules is node_modules whatever it is called", () => {
    const h = { ...holder("web", "cache1"), mounts: [{ name: "cache1", rw: true, destination: "/app/node_modules" }] };
    expect(volumeKind(vol("cache1"), [h])).toBe("nm");
  });
  test("when unsure it is data: the wrong guess must be the safe one", () => {
    expect(volumeKind(vol("0f3a9c"), [])).toBe("data");
  });
});

describe("the state of a volume", () => {
  const cs = [holder("orbit-web-1", "orbit_node_modules"), holder("orbit-db-1", "orbit_pgdata")];
  const v = volumesView([
    vol("orbit_node_modules"), vol("orbit_pgdata"), vol("old_node_modules"), vol("old_pgdata"),
  ], cs, { orbit_node_modules: 0.9e9, orbit_pgdata: 2.1e9, old_node_modules: 0.8e9, old_pgdata: 0.4e9 });
  const by = Object.fromEntries(v.items.map((i) => [i.volume.name, i]));

  test("attached is in use, idle node_modules is safe, idle data is kept", () => {
    expect(by.orbit_node_modules!.state).toBe("use");
    expect(by.orbit_pgdata!.state).toBe("use");
    expect(by.old_node_modules!.state).toBe("safe");
    expect(by.old_pgdata!.state).toBe("kept");
  });

  test("docker's own link count counts as attached when no container list says so", () => {
    expect(volumesView([vol("x_node_modules", { links: 1 })], [], {}).items[0]!.state).toBe("use");
  });

  test("only a safe volume can be removed; data never, and the reason says so", () => {
    expect(by.old_node_modules!.removable).toBe(true);
    expect(by.old_pgdata!.removable).toBe(false);
    expect(by.old_pgdata!.why).toContain("never removed from here");
    expect(by.orbit_pgdata!.removable).toBe(false);
    expect(by.orbit_node_modules!.why).toBe("Attached to orbit-web-1: remove that container first.");
  });

  test("a removable volume never reaches a bulk total through data", () => {
    expect(v.safeBytes).toBe(0.8e9);
    expect(v.items.filter((i) => i.kind === "data").every((i) => !i.removable)).toBe(true);
  });

  test("the three groups, biggest first", () => {
    expect(v.groups.use.map((i) => i.volume.name)).toEqual(["orbit_pgdata", "orbit_node_modules"]);
    expect(v.groups.safe.map((i) => i.volume.name)).toEqual(["old_node_modules"]);
    expect(v.groups.kept.map((i) => i.volume.name)).toEqual(["old_pgdata"]);
  });

  test("an unmeasured size is null, not zero, and sorts last", () => {
    const u = volumesView([vol("a_pgdata"), vol("b_pgdata")], [], { b_pgdata: 5 });
    expect(u.items.find((i) => i.volume.name === "a_pgdata")!.bytes).toBeNull();
    expect(u.groups.kept.map((i) => i.volume.name)).toEqual(["b_pgdata", "a_pgdata"]);
  });

  test("the size falls back to what the volume itself carries", () => {
    expect(volumesView([vol("a_pgdata", { bytes: 7 })], [], {}).items[0]!.bytes).toBe(7);
  });
});

describe("the volumes sentence", () => {
  test("names the safe node_modules when there is some", () => {
    const v = volumesView([vol("a_node_modules"), vol("b_pgdata")], [], { a_node_modules: 0.8e9, b_pgdata: 2.1e9 });
    expect(v.lead).toBe("2 volumes, 2.9 GB.");
    expect(v.rest).toBe("Data volumes are kept; 800 MB of node_modules is safe to remove.");
  });
  test("says nothing to remove, and counts the data volumes kept", () => {
    const v = volumesView([vol("b_pgdata")], [], { b_pgdata: 2.1e9 });
    expect(v.lead).toBe("Nothing to remove here.");
    expect(v.rest).toBe("1 volume, 2.1 GB. Data volumes are kept (1); no node_modules volume is sitting idle.");
  });
});
