// Which listeners look forgotten. The decision that matters most is the folder:
// a static server started from one checkout and serving another was labelled by
// where it was started, so the row named the wrong place and every badge derived
// from it was about the wrong place too.
import { describe, expect, test } from "bun:test";
import {
  duplicatePids, foldSample, folderOf, idleFor, IDLE_MS, parseEstablished, servedDirOf, underTmp,
} from "../src/portstale.ts";

const py = (...rest: string[]) => ["python3", "-m", "http.server", ...rest];

describe("servedDirOf", () => {
  test("--directory wins over the directory it was started in", () => {
    expect(servedDirOf(py("8000", "--directory", "/tmp/report"), "/home/dev/code/orbit")).toBe("/tmp/report");
    expect(folderOf(py("8000", "--directory", "/tmp/report"), "/home/dev/code/orbit")).toBe("/tmp/report");
  });

  test("-d and --directory= are the same flag", () => {
    expect(servedDirOf(py("-d", "/srv/site"), "/home/dev")).toBe("/srv/site");
    expect(servedDirOf(py("--directory=/srv/site", "8000"), "/home/dev")).toBe("/srv/site");
  });

  test("a relative directory is relative to where it was started", () => {
    expect(servedDirOf(py("-d", "../out/"), "/home/dev/code/orbit")).toBe("/home/dev/code/out");
  });

  test("a relative directory with no cwd is unknown, not the root", () => {
    expect(servedDirOf(py("-d", "out"), null)).toBeNull();
  });

  test("no flag serves the cwd, so the cwd is the folder", () => {
    expect(servedDirOf(py("8000"), "/home/dev/code/orbit")).toBeNull();
    expect(folderOf(py("8000"), "/home/dev/code/orbit")).toBe("/home/dev/code/orbit");
  });

  test("only http.server is read: another program's -d means something else", () => {
    expect(servedDirOf(["node", "app.js", "-d", "/tmp/x"], "/home/dev")).toBeNull();
    // `http.server` as a value, not the module: `-m` must be right before it.
    expect(servedDirOf(["node", "http.server", "-d", "/tmp/x"], "/home/dev")).toBeNull();
  });

  test("a flag with nothing after it is no directory", () => {
    expect(servedDirOf(py("8000", "-d"), "/home/dev")).toBeNull();
  });

  test("a path with spaces survives, because argv is not re-split", () => {
    expect(servedDirOf(py("-d", "/tmp/my report"), "/home/dev")).toBe("/tmp/my report");
  });
});

describe("underTmp", () => {
  test("scratch directories, and only whole path segments", () => {
    expect(underTmp("/tmp/report")).toBe(true);
    expect(underTmp("/tmp")).toBe(true);
    expect(underTmp("/var/tmp/x/y")).toBe(true);
    expect(underTmp("/tmpfoo/x")).toBe(false);
    expect(underTmp("/home/dev/tmp/x")).toBe(false);
    expect(underTmp(null)).toBe(false);
  });
});

describe("duplicatePids", () => {
  const row = (pid: number, dir: string | null, proc = "python3", mine = true) => ({ mine, pid, proc, dir });

  test("two of the same program over one folder are duplicates", () => {
    expect([...duplicatePids([row(1, "/tmp/r"), row(2, "/tmp/r")])].sort()).toEqual([1, 2]);
  });

  test("one pid on two addresses is one listener", () => {
    expect(duplicatePids([row(1, "/tmp/r"), row(1, "/tmp/r")]).size).toBe(0);
  });

  test("different folders, different programs, other users' processes are not", () => {
    expect(duplicatePids([row(1, "/tmp/a"), row(2, "/tmp/b")]).size).toBe(0);
    expect(duplicatePids([row(1, "/code/orbit", "vite"), row(2, "/code/orbit", "bun")]).size).toBe(0);
    expect(duplicatePids([row(1, "/tmp/r", "python3", false), row(2, "/tmp/r", "python3", false)]).size).toBe(0);
    expect(duplicatePids([row(1, null), row(2, null)]).size).toBe(0);
  });
});

describe("idle", () => {
  test("ss without a State column, counted by local port", () => {
    const out = [
      "0      0      127.0.0.1:8000   127.0.0.1:51000",
      "0      0      127.0.0.1:51000  127.0.0.1:8000",
      "0      0      [::1]:8000       [::1]:52000",
    ].join("\n");
    const m = parseEstablished(out);
    expect(m.get(8000)).toBe(2);
    expect(m.get(51000)).toBe(1);
  });

  test("a listener first seen quiet starts its clock now, however old the process", () => {
    const seen = foldSample({}, [{ key: "1:8000", connections: 0 }], 1_000);
    expect(seen["1:8000"]).toBe(1_000);
    expect(idleFor(seen, "1:8000", 1_000 + IDLE_MS - 1)).toBeNull();
    expect(idleFor(seen, "1:8000", 1_000 + IDLE_MS)).toBe(IDLE_MS / 1000);
  });

  test("a connection resets the clock, quiet keeps it", () => {
    let seen = foldSample({}, [{ key: "1:8000", connections: 0 }], 0);
    seen = foldSample(seen, [{ key: "1:8000", connections: 0 }], 5_000);
    expect(seen["1:8000"]).toBe(0);
    seen = foldSample(seen, [{ key: "1:8000", connections: 1 }], 9_000);
    expect(seen["1:8000"]).toBe(9_000);
  });

  test("a long gap between samples, or a clock stepped back, starts every clock again", () => {
    // A laptop that slept, or a wall clock that moved: either reads as hours of
    // idleness for every listener at once, which is a false alarm and not data.
    const prev = { "@sampled": 0, "1:8000": 0 };
    const late = foldSample(prev, [{ key: "1:8000", connections: 0 }], IDLE_MS + 1);
    expect(late["1:8000"]).toBe(IDLE_MS + 1);
    const back = foldSample({ "@sampled": 10_000, "1:8000": 0 }, [{ key: "1:8000", connections: 0 }], 5_000);
    expect(back["1:8000"]).toBe(5_000);
  });

  test("a listener that went away is forgotten, so a reused pid starts fresh", () => {
    const seen = foldSample({ "1:8000": 0 }, [], 10);
    expect(seen["1:8000"]).toBeUndefined();
  });
});

describe("forgottenPorts (the Lantern's quiet section)", () => {
  const base = { port: 8000, addr: "127.0.0.1", proc: "python3", pid: 1, cwd: "/", mine: true, ageSec: 5, fromAgent: false, cwdGone: false,
    ancestry: [], publicBind: false, exeGone: false, dir: "/srv/site", tmpLeftover: false, duplicate: false, idleSec: null };

  test("only ours, only with a reason, reasons in badge order", async () => {
    const { forgottenPorts } = await import("../../web/src/lib/portsForgotten.ts");
    const r = forgottenPorts([
      base,
      { ...base, port: 8001, tmpLeftover: true, idleSec: 20000 },
      { ...base, port: 8002, duplicate: true, mine: false },
    ]);
    expect(r.map((f) => f.port.port)).toEqual([8001]);
    expect(r[0]!.why).toEqual(["tmp leftover", "idle"]);
  });
});
