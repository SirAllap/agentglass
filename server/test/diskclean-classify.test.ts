// The verdict rules, as tables: facts in, verdict and reason out. No process is
// started and no file is read here.
import { describe, expect, test } from "bun:test";
import {
  CLAUDE_TEMP_MIN_AGE_MS, classifyClaudeTemp, classifyDocker, classifyWorktree, localOnlyImages, parseDf, parseDockerDf, parseDockerImages, parseDockerPs, parseDockerSize, type DockerPs, type WorktreeFacts,
} from "../src/diskclean.ts";
import { C1, C2 } from "./diskcleanFixture.ts";

const HOUR = 3600_000;

describe("sizes and listings", () => {
  test("Docker prints SI units, sometimes with a percentage after", () => {
    expect(parseDockerSize("109.5GB")).toBe(109.5e9);
    expect(parseDockerSize("59.37GB (54%)")).toBe(59.37e9);
    expect(parseDockerSize("4.096kB")).toBe(4096);
    expect(parseDockerSize("0B")).toBe(0);
    expect(parseDockerSize("")).toBe(0);
    expect(parseDockerSize(undefined)).toBe(0);
    expect(parseDockerSize("lots")).toBe(0);
  });

  test("df: the mount, the source and the bytes free (not the root-reserved ones)", () => {
    const out = "Filesystem 1-blocks Used Available Capacity Mounted on\n/dev/mapper/omarchy_root 224000000000 213000000000 5100000000 98% /home\n";
    expect(parseDf(out)).toEqual({ source: "/dev/mapper/omarchy_root", size: 224e9, free: 5.1e9, mount: "/home" });
    expect(parseDf("df: nope")).toBeNull();
    expect(parseDf("")).toBeNull();
  });

  test("df: a mount point with a space in it survives", () => {
    expect(parseDf("Filesystem 1-blocks Used Available Capacity Mounted on\n/dev/sdb1 100 40 60 40% /mnt/my disk\n")?.mount).toBe("/mnt/my disk");
  });

  test("docker system df: a line that is not JSON is skipped, not fatal", () => {
    const r = parseDockerDf('warning: x\n{"Type":"Images","TotalCount":"4","Active":"1","Size":"2GB","Reclaimable":"1.5GB (75%)"}\n{broken');
    expect(r).toEqual({ Images: { total: 4, active: 1, size: 2e9, reclaimable: 1.5e9 } });
  });

  test("docker ps: running, finished (exit 0) and failed are told apart, and compose projects are named", () => {
    const ps = parseDockerPs([
      '{"ID":"0123456789ab","State":"running","Status":"Up 2 hours","Labels":"com.docker.compose.project=orbit,x=y"}',
      '{"ID":"ba9876543210","Names":"orbit_check","State":"exited","Status":"Exited (0) 3 minutes ago","Labels":""}',
      '{"ID":"cccccccccccc","State":"exited","Status":"Exited (137) 1 hour ago","Labels":"com.docker.compose.project=acme"}',
      '{"State":"created","Status":"Created","Labels":""}',
    ].join("\n"));
    expect(ps).toEqual({
      running: 1, stopped: 3, stoppedServices: 1, stoppedProjects: ["acme"], projects: ["acme", "orbit"],
      ids: ["0123456789ab", "ba9876543210", "cccccccccccc"], exitedClean: [{ id: "ba9876543210", name: "orbit_check" }], selfRemoving: [],
    });
  });
});

const wt = (over: Partial<WorktreeFacts> = {}): WorktreeFacts => ({
  branch: "feat/orbit-1042", head: "aaa", locked: false, dirty: 0, unpushed: 0, prKnown: true,
  pr: { number: 1042, state: "MERGED", headSha: "bbb" }, busy: false, leftovers: { names: [], more: 0 }, ...over,
});

describe("worktrees", () => {
  const rows: [string, Partial<WorktreeFacts>, "safe" | "ask" | "inuse", RegExp][] = [
    ["merged, clean, nothing unpushed", {}, "safe", /#1042 is merged/],
    ["closed, clean", { pr: { number: 7, state: "CLOSED", headSha: "x" } }, "safe", /#7 is closed/],
    ["open pull request", { pr: { number: 9, state: "OPEN", headSha: "x" } }, "inuse", /#9 is still open/],
    ["open and dirty is still in use, not a plain ask", { dirty: 4, pr: { number: 9, state: "OPEN", headSha: "x" } }, "inuse", /still open/],
    ["merged but 3 files changed", { dirty: 3 }, "ask", /3 files/],
    ["merged but 1 file changed", { dirty: 1 }, "ask", /1 file with/],
    ["merged but 2 commits only here", { unpushed: 2 }, "ask", /2 commits exist only/],
    ["merged, branch deleted upstream, HEAD is the pull request's head", { unpushed: 5, head: "bbb" }, "safe", /merged/],
    ["no pull request", { pr: null }, "ask", /No pull request .*feat\/orbit-1042/],
    ["detached head, no pull request", { pr: null, branch: "(detached)" }, "ask", /this checkout/],
    ["GitHub could not be asked", { pr: null, prKnown: false }, "ask", /GitHub could not be asked/],
    ["git could not read status", { dirty: null }, "ask", /could not read/],
    ["git could not count unpushed", { unpushed: null }, "ask", /could not read/],
    ["locked", { locked: true }, "inuse", /locked/],
    ["an agent still sits in a merged, clean checkout", { busy: true }, "inuse", /running inside this checkout/],
    ["merged and clean, but a .env that no other copy has", { leftovers: { names: [".env", "notes/todo.md"], more: 0 } }, "ask", /\.env, notes\/todo\.md/],
    ["more ignored files than are named", { leftovers: { names: ["a", "b", "c", "d"], more: 2 } }, "ask", /a, b, c and 3 more/],
    ["the ignored files could not be listed", { leftovers: { names: [], more: 0, error: "boom" } }, "ask", /could not be listed/],
    ["the ignored files were never looked at", { leftovers: null }, "ask", /not looked at/],
  ];
  for (const [name, over, verdict, why] of rows) {
    test(`${name} -> ${verdict}`, () => {
      const v = classifyWorktree(wt(over));
      expect(v.verdict).toBe(verdict);
      expect(v.why).toMatch(why);
    });
  }

  test("GUARD: an empty head never equals an empty pull-request head, so unpushed work still asks", () => {
    expect(classifyWorktree(wt({ head: "", unpushed: 2, pr: { number: 1, state: "MERGED", headSha: "" } })).verdict).toBe("ask");
  });
});

describe("Claude temp folders", () => {
  test("a running session is in use however old its folder is", () => {
    expect(classifyClaudeTemp({ ageMs: 30 * 24 * HOUR, live: true }).verdict).toBe("inuse");
  });
  test("younger than 24 hours and not running asks", () => {
    expect(classifyClaudeTemp({ ageMs: CLAUDE_TEMP_MIN_AGE_MS - 1, live: false }).verdict).toBe("ask");
    expect(classifyClaudeTemp({ ageMs: 5 * 60_000, live: false }).why).toContain("5 min");
  });
  test("24 hours or more and not running is safe, and says memory is elsewhere", () => {
    const v = classifyClaudeTemp({ ageMs: CLAUDE_TEMP_MIN_AGE_MS, live: false });
    expect(v.verdict).toBe("safe");
    expect(v.why).toContain("memory and history live elsewhere");
  });
});

describe("Docker lines", () => {
  const df = parseDockerDf([
    '{"Type":"Images","TotalCount":"120","Active":"7","Size":"109.5GB","Reclaimable":"59.37GB (54%)"}',
    '{"Type":"Containers","TotalCount":"17","Active":"15","Size":"619.5MB","Reclaimable":"4.096kB (0%)"}',
    '{"Type":"Local Volumes","TotalCount":"103","Active":"13","Size":"8.384GB","Reclaimable":"3.501GB (41%)"}',
    '{"Type":"Build Cache","TotalCount":"497","Active":"0","Size":"79.42GB","Reclaimable":"61.06GB"}',
  ].join("\n"));
  const ps: DockerPs = { running: 15, stopped: 2, stoppedServices: 0, stoppedProjects: [], projects: ["orbit"], ids: [C1, C2], exitedClean: [{ id: C1, name: "orbit_check_1" }, { id: C2, name: "orbit_check_2" }], selfRemoving: [C1, C2] };
  const get = (lines: ReturnType<typeof classifyDocker>, id: string) => lines.find((l) => l.id === id);

  test("the real case: unused images and build cache are the plan, the rest is in use", () => {
    const lines = classifyDocker(df, ps);
    expect(get(lines, "docker:images")).toMatchObject({ verdict: "safe", bytes: 59.37e9 });
    expect(get(lines, "docker:images-used")).toMatchObject({ verdict: "inuse", bytes: 109.5e9 - 59.37e9 });
    expect(get(lines, "docker:cache")).toMatchObject({ verdict: "safe", bytes: 61.06e9 });
    expect(get(lines, "docker:cache-used")).toMatchObject({ verdict: "inuse", bytes: 79.42e9 - 61.06e9, target: null });
  });

  test("containers started with --rm that finished are safe, and the target names exactly their ids; running ones are reported in use", () => {
    const lines = classifyDocker(df, ps);
    expect(get(lines, "docker:containers")).toMatchObject({ verdict: "safe", target: { via: "docker", what: "containers", ids: [C1, C2] } });
    expect(get(lines, "docker:containers")!.why).toContain("docker run --rm");
    expect(get(lines, "docker:containers-running")).toMatchObject({ verdict: "inuse", target: null });
  });

  test("exit 0 is not enough: a container nothing proves removes itself asks, names itself, and has no target", () => {
    // `docker run -it --name dev ubuntu bash`, then exit; or a hand-run postgres that was stopped. Both are Exited (0) with no compose label.
    const lines = classifyDocker(df, { ...ps, exitedClean: [{ id: C1, name: "dev" }, { id: C2, name: "pg" }], selfRemoving: [] });
    expect(get(lines, "docker:containers")).toMatchObject({ verdict: "ask", target: null });
    expect(get(lines, "docker:containers")!.why).toMatch(/dev, pg exited with 0.*shell you left.*database you stopped/);
  });

  test("one container that is not provably disposable keeps the whole line from having a button", () => {
    const lines = classifyDocker(df, { ...ps, selfRemoving: [C1] });
    expect(get(lines, "docker:containers")).toMatchObject({ verdict: "ask", target: null });
  });

  test("a container that stopped with an error asks, and has no target", () => {
    const lines = classifyDocker(df, { ...ps, stopped: 3, selfRemoving: [C1] });
    expect(get(lines, "docker:containers")).toMatchObject({ verdict: "ask", target: null });
    expect(get(lines, "docker:containers")!.why).toContain("1 ended with an error");
  });

  test("a stopped compose service exits 0 like a test run does, and still asks: it may be a database", () => {
    const lines = classifyDocker(df, { ...ps, stopped: 2, exitedClean: [], selfRemoving: [], stoppedServices: 2, stoppedProjects: ["orbit"] });
    expect(get(lines, "docker:containers")).toMatchObject({ verdict: "ask", target: null });
    expect(get(lines, "docker:containers")!.why).toMatch(/2 belong to compose project orbit.*database or service/);
  });

  test("GUARD: volumes are never safe and never carry a target; attached ones name their projects", () => {
    const lines = classifyDocker(df, ps);
    const vols = lines.filter((l) => l.kind === "docker-volumes");
    expect(vols.map((v) => v.verdict).sort()).toEqual(["explain", "inuse"]);
    for (const v of vols) expect(v.target).toBeNull();
    expect(get(lines, "docker:volumes-used")!.why).toContain("orbit");
  });

  test("GUARD: only images, cache and containers ever get a docker target", () => {
    for (const l of classifyDocker(df, ps)) if (l.target) expect(["images", "cache", "containers"]).toContain((l.target as { what: string }).what);
  });

  test("images that exist nowhere else (commit, load, local build) make the images line ask, named, with no target", () => {
    const lines = classifyDocker(df, ps, ["acme/tools:dev", "orbit-api:latest"]);
    expect(get(lines, "docker:images")).toMatchObject({ verdict: "ask", target: null });
    expect(get(lines, "docker:images")!.why).toMatch(/2 images exist only on this machine \(acme\/tools:dev, orbit-api:latest\).*permanent/);
    // and Docker that would not list them is not "none"
    expect(get(classifyDocker(df, ps, null), "docker:images")).toMatchObject({ verdict: "ask", target: null });
  });

  test("local-only images: only the unused ones with no registry digest count", () => {
    const imgs = parseDockerImages([
      '{"ID":"sha256:aaaa11112222","Repository":"orbit-api","Tag":"latest","Digest":"<none>"}',
      '{"ID":"bbbb11112222","Repository":"postgres","Tag":"16","Digest":"sha256:feed"}',
      '{"ID":"cccc11112222","Repository":"<none>","Tag":"<none>","Digest":"<none>"}',
      '{"ID":"dddd11112222","Repository":"orbit-web","Tag":"dev","Digest":"<none>"}',
    ].join("\n"));
    // orbit-web is used by a container; postgres has a registry copy
    expect(localOnlyImages(imgs, ["dddd11112222" + "0".repeat(52)])).toEqual(["orbit-api:latest", "cccc11112222"]);
  });

  test("nothing reclaimable means no safe line to click", () => {
    const empty = parseDockerDf('{"Type":"Images","TotalCount":"1","Active":"1","Size":"1.8GB","Reclaimable":"0B (0%)"}\n{"Type":"Build Cache","TotalCount":"0","Active":"0","Size":"0B","Reclaimable":"0B"}');
    const lines = classifyDocker(empty, { running: 1, stopped: 0, stoppedServices: 0, stoppedProjects: [], projects: [], ids: [], exitedClean: [], selfRemoving: [] });
    expect(lines.some((l) => l.verdict === "safe")).toBe(false);
  });
});
