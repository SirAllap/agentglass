/*
 * One `ss` per ports request.
 *
 * The list used to be two spawns: `ss -ltnpH` for who listens and `ss -tnH
 * state established` for who is connected to them, 2,930 an hour measured on an
 * open panel. One `ss -tnapH` answers both and `splitSockets` hands each half
 * to the parser that already read it. The fixture lines are the shapes of a
 * real machine, TIME-WAIT included, which `-a` adds and nothing reads.
 *
 * A stand-in `ss` on PATH logs every call, so this needs no sockets and the
 * count is of spawns, not of anything the function says about itself. It runs
 * in a child process because `Bun.which` resolves with the PATH the process
 * started with.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { splitSockets } from "../src/machine.ts";
import { parseEstablished } from "../src/portstale.ts";

const dir = mkdtempSync(join(tmpdir(), "agx-oness-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const combined = (pid: number) => [
  `LISTEN     0      512          0.0.0.0:8000      0.0.0.0:*    users:(("vite",pid=${pid},fd=24))`,
  `ESTAB      0      0          127.0.0.1:8000    127.0.0.1:51000 users:(("vite",pid=${pid},fd=30))`,
  `ESTAB      0      0          127.0.0.1:51000   127.0.0.1:8000`,
  `TIME-WAIT  0      0          127.0.0.1:8000    127.0.0.1:50999`,
  `FIN-WAIT-2 0      0          127.0.0.1:8000    127.0.0.1:50998`,
].join("\n");

describe("splitSockets", () => {
  test("listeners keep their row, established lose the State column, the rest is dropped", () => {
    const { listening, established } = splitSockets(combined(1234));
    expect(listening.split("\n")).toHaveLength(1);
    expect(listening).toContain("0.0.0.0:8000");
    expect(established.split("\n")).toHaveLength(2);
    expect(established.startsWith("0")).toBe(true);
    const m = parseEstablished(established);
    expect(m.get(8000)).toBe(1);
    expect(m.get(51000)).toBe(1);
    expect(m.get(50999)).toBeUndefined();
  });
});

test("a ports request spawns ss once", async () => {
  const log = join(dir, "ss.log");
  writeFileSync(join(dir, "ss"), `#!/bin/sh\necho "$@" >> "${log}"\ncat <<'EOF'\n${combined(process.pid)}\nEOF\n`);
  chmodSync(join(dir, "ss"), 0o755);
  const script = `import { listPortsAsync } from ${JSON.stringify(join(import.meta.dir, "../src/machine.ts"))};
    const r = await listPortsAsync(); console.log(JSON.stringify({ ports: r.ports.map((p) => p.port), error: r.error ?? null }));`;
  const p = Bun.spawn([process.execPath, "-e", script], {
    stdout: "pipe", stderr: "pipe",
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, NODE_ENV: "test", AGENTGLASS_STATE_DIR: join(dir, "state") },
  });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  expect(err).toBe("");
  expect(JSON.parse(out)).toEqual({ ports: [8000], error: null });
  expect(existsSync(log)).toBe(true);
  const calls = readFileSync(log, "utf8").split("\n").filter(Boolean);
  expect(calls).toEqual(["-tnapH"]);
}, 20_000);
