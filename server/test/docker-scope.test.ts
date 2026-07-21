// The docker panel is scoped to the open project the same way events, sessions
// and diffs are — a cockpit opened for one repo shouldn't list every container
// on the machine.
//
// The two things worth pinning are the matching rule (compose normalizes
// project names, so a raw basename comparison quietly misses real repos) and
// the no-match fallback: showing nothing is indistinguishable from a dead
// daemon, so the full list comes back with a flag instead.
import { describe, expect, test } from "bun:test";
import { dockerScopeKey, containerInScope, applyScope, parsePsLine, stats } from "../src/docker.ts";

const c = (over: Partial<{ id: string; project: string | null; workingDir: string | null }> = {}) => ({
  id: over.id ?? "abc123",
  name: "svc-1",
  image: "nginx",
  state: "running",
  status: "Up 2 hours",
  ports: "",
  project: over.project ?? null,
  service: null,
  workingDir: over.workingDir ?? null,
  runningFor: "2 hours",
  size: "",
});

describe("dockerScopeKey", () => {
  test("derives the compose project name from the directory", () => {
    expect(dockerScopeKey("/home/x/code/myapp")).toEqual({ dir: "/home/x/code/myapp", project: "myapp" });
  });

  test("normalizes like compose does — lowercase, [a-z0-9_-] only", () => {
    expect(dockerScopeKey("/home/x/code/My.App")?.project).toBe("myapp");
    expect(dockerScopeKey("/home/x/code/Agent Glass")?.project).toBe("agentglass");
    expect(dockerScopeKey("/home/x/code/my_app-2")?.project).toBe("my_app-2");
  });

  test("trims a trailing slash so the prefix test can't be fooled", () => {
    expect(dockerScopeKey("/home/x/code/myapp/")?.dir).toBe("/home/x/code/myapp");
  });

  test("is null when the instance is machine-wide", () => {
    expect(dockerScopeKey(null)).toBeNull();
  });
});

describe("containerInScope", () => {
  const key = dockerScopeKey("/home/x/code/myapp")!;

  test("matches on the compose project name", () => {
    expect(containerInScope(c({ project: "myapp" }), key)).toBe(true);
    expect(containerInScope(c({ project: "MyApp" }), key)).toBe(true);
    expect(containerInScope(c({ project: "otherapp" }), key)).toBe(false);
  });

  test("matches on a working dir inside the workspace", () => {
    expect(containerInScope(c({ project: "renamed", workingDir: "/home/x/code/myapp" }), key)).toBe(true);
    expect(containerInScope(c({ project: "renamed", workingDir: "/home/x/code/myapp/deploy" }), key)).toBe(true);
  });

  test("a sibling directory sharing the prefix is not inside it", () => {
    // "/home/x/code/myapp-staging" starts with the scope string but is a
    // different project; the separator has to be part of the comparison.
    expect(containerInScope(c({ project: null, workingDir: "/home/x/code/myapp-staging" }), key)).toBe(false);
  });

  test("an unlabelled container never matches", () => {
    // A plain `docker run` has no compose labels at all. Empty must not read as
    // "same project" just because both sides normalize to "".
    expect(containerInScope(c(), key)).toBe(false);
    expect(containerInScope(c(), { dir: "/", project: "" })).toBe(false);
  });
});

describe("applyScope", () => {
  const key = dockerScopeKey("/home/x/code/myapp")!;
  const mine = c({ id: "aaa", project: "myapp" });
  const theirs = c({ id: "bbb", project: "otherapp" });

  test("unscoped leaves the host list untouched and reports no scope", () => {
    const r = applyScope([mine, theirs], null);
    expect(r.containers.map((x) => x.id)).toEqual(["aaa", "bbb"]);
    expect(r.scope).toBeUndefined();
  });

  test("scoped keeps only this project's containers", () => {
    const r = applyScope([mine, theirs], key);
    expect(r.containers.map((x) => x.id)).toEqual(["aaa"]);
    expect(r.scope).toEqual({ workspace: "/home/x/code/myapp", project: "myapp", matched: 1, showingAll: false });
  });

  test("no match falls back to the full list with showingAll set", () => {
    // The deliberate choice: an empty panel looks like a broken daemon, so the
    // host view comes back and the flag lets the UI explain why.
    const r = applyScope([theirs], key);
    expect(r.containers.map((x) => x.id)).toEqual(["bbb"]);
    expect(r.scope).toMatchObject({ matched: 0, showingAll: true });
  });

  test("the working-dir label never reaches the wire shape", () => {
    // It's a matching input, not something the panel renders.
    const [only] = applyScope([c({ workingDir: "/home/x/code/myapp" })], key).containers;
    expect(only).not.toHaveProperty("workingDir");
  });
});

/*
 * Labels used to arrive as `docker ps`'s `{{.Labels}}`: every label joined with
 * commas, no escaping, split back apart on the comma. A label *value* with a
 * comma in it therefore could not survive the round trip, and one with a comma
 * and an `=` invented a key that was never on the container.
 *
 * That reads as cosmetic right up until you remember scoping depends on these
 * labels: a container whose working_dir sits next to a comma-bearing label
 * quietly stops matching its own project, and the panel shows the whole host
 * instead with no sign anything went wrong. Each label is now asked for by name.
 */
describe("parsing a docker ps line", () => {
  const line = (over: Partial<Record<string, string>> = {}) =>
    [
      over.id ?? "9f1c2b3d4e5f6a7b",
      over.name ?? "api-rest",
      over.image ?? "node:22",
      over.state ?? "Running",
      over.status ?? "Up 3 hours",
      over.ports ?? "0.0.0.0:3000->3000/tcp",
      over.runningFor ?? "3 hours ago",
      over.project ?? "alavera_app",
      over.service ?? "api",
      over.workingDir ?? "/mnt/hdd/code/alavera_app",
    ].join("\t");

  test("a label value containing commas survives intact", () => {
    const c = parsePsLine(line({ workingDir: "/home/x/code/a,b" }))!;
    expect(c.workingDir).toBe("/home/x/code/a,b");
    // The old format would have produced "/home/x/code/a" here, and the
    // container would have stopped matching a scope on that directory.
    expect(c.project).toBe("alavera_app");
  });

  test("a label value containing an = does not invent a key", () => {
    const c = parsePsLine(line({ service: "api=v2,edge=1" }))!;
    expect(c.service).toBe("api=v2,edge=1");
    expect(c.workingDir).toBe("/mnt/hdd/code/alavera_app");
  });

  test("absent labels are null, not empty strings", () => {
    const c = parsePsLine(line({ project: "", service: "", workingDir: "" }))!;
    expect(c.project).toBeNull();
    expect(c.service).toBeNull();
    expect(c.workingDir).toBeNull();
  });

  test("id is truncated and state lowercased, as the panel expects", () => {
    const c = parsePsLine(line())!;
    expect(c.id).toBe("9f1c2b3d4e5f");
    expect(c.state).toBe("running");
  });

  test("blank lines are dropped", () => {
    expect(parsePsLine("")).toBeNull();
    expect(parsePsLine("   ")).toBeNull();
  });
});

describe("stats sampling", () => {
  test("nothing in scope is running: no daemon round-trip at all", async () => {
    expect(await stats([])).toEqual([]);
  });

  test("ids that cannot be container ids never reach the command line", async () => {
    expect(await stats(["; rm -rf /", "--format=x"])).toEqual([]);
  });
});
