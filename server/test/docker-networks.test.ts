/*
 * A network row has to say what is on it before it offers to remove it, and
 * `network ls` does not know: subnet and members live in `network inspect`.
 * One inspect for every network, not one per row.
 */
import { afterAll, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseNetworkInspect } from "../src/docker.ts";

const INSPECT = JSON.stringify([
  { Name: "orbit_default", Id: "aaaaaaaaaaaa1111", IPAM: { Config: [{ Subnet: "172.18.0.0/16", Gateway: "172.18.0.1" }] },
    Containers: { bbbbbbbbbbbb2222: { Name: "orbit-web-1", IPv4Address: "172.18.0.2/16" }, cccccccccccc3333: { Name: "orbit-db-1" } } },
  { Name: "host", Id: "dddddddddddd4444", IPAM: { Config: [] }, Containers: {} },
  { Name: "bare", Id: "eeeeeeeeeeee5555", IPAM: null, Containers: null },
]);

test("subnet and members come out of one inspect, keyed by the short id", () => {
  const m = parseNetworkInspect(INSPECT);
  expect(m.get("aaaaaaaaaaaa")).toEqual({
    subnet: "172.18.0.0/16",
    members: [{ id: "bbbbbbbbbbbb", name: "orbit-web-1" }, { id: "cccccccccccc", name: "orbit-db-1" }],
  });
  expect(m.get("dddddddddddd")).toEqual({ subnet: null, members: [] });
  expect(m.get("eeeeeeeeeeee")).toEqual({ subnet: null, members: [] });
});

test("output that is not JSON is no information, not an exception", () => {
  expect(parseNetworkInspect("Error: nope").size).toBe(0);
});

const dir = mkdtempSync(join(tmpdir(), "agx-nets-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("the overview carries them, from a single `network inspect` for all networks", () => {
  const log = join(dir, "calls.log");
  mkdirSync(join(dir, "bin"));
  writeFileSync(join(dir, "inspect.json"), INSPECT);
  writeFileSync(join(dir, "bin", "docker"), `#!/bin/sh
echo "$@" >> "${log}"
case "$1 $2" in
  "network ls") echo '{"ID":"aaaaaaaaaaaa","Name":"orbit_default","Driver":"bridge","Scope":"local"}'; echo '{"ID":"dddddddddddd","Name":"host","Driver":"host","Scope":"local"}' ;;
  "network inspect") cat "${join(dir, "inspect.json")}" ;;
  *) case "$1" in --version|version) echo "24.0.7" ;; inspect) echo '[]' ;; esac ;;
esac
exit 0
`);
  chmodSync(join(dir, "bin", "docker"), 0o755);
  const code = `import { overview } from ${JSON.stringify(new URL("../src/docker.ts", import.meta.url).pathname)};
    console.log(JSON.stringify((await overview(true)).networks));`;
  const p = Bun.spawnSync(["bun", "-e", code], {
    env: {
      PATH: `${join(dir, "bin")}:${process.env.PATH ?? ""}`, HOME: dir, XDG_CONFIG_HOME: dir, XDG_DATA_HOME: dir, XDG_CACHE_HOME: dir,
      AGENTGLASS_STATE_DIR: join(dir, "state"), AGENTGLASS_DB: join(dir, "d.db"), AGENTGLASS_ROOT: dir,
      AGENTGLASS_SCAN_DISABLED: "1", NODE_ENV: "test",
    },
    stdout: "pipe", stderr: "pipe",
  });
  const nets = JSON.parse(p.stdout.toString().trim().split("\n").pop() ?? "null");
  expect(nets[0]).toMatchObject({ name: "orbit_default", subnet: "172.18.0.0/16", members: [{ id: "bbbbbbbbbbbb", name: "orbit-web-1" }, { id: "cccccccccccc", name: "orbit-db-1" }] });
  expect(nets[1]).toMatchObject({ name: "host", subnet: null, members: [] });
  const inspects = readFileSync(log, "utf8").split("\n").filter((l) => l.startsWith("network inspect"));
  expect(inspects).toEqual(["network inspect aaaaaaaaaaaa dddddddddddd"]);
});
