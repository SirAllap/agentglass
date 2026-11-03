/*
 * What the Machine dialog showed that no state of the mock could: a project and
 * its main checkout sharing one history key, a CPU of "0.0%" before any CPU was
 * read, a Low disk badge that waited for a visit to Resources, a TB disk named in
 * GB (see disk-clean.test.ts), a progress bar in the ink colour, and a finished clean headed in amber.
 * Component rules are asserted against source: there is no renderer here.
 */
import { describe, expect, test } from "bun:test";

const SRC = new URL("../src/", import.meta.url);
const code = (rel: string) => Bun.file(new URL(rel, SRC)).text().then((t) => t.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n"));
const resources = await code("components/machine/Resources.tsx");
const panel = await code("components/MachinePanel.tsx");
const diskClean = await code("components/DiskClean.tsx");
const css = await code("components/machine/machineCss.ts");
const dockerCss = await code("components/docker/resourceCss.ts");
const states = await code("components/docker/States.tsx");

describe("Resources tree", () => {
  test("the project line has its own key: its history and its caret are not the main checkout's", () => {
    expect(resources).toContain("pushSample(history.current, projKey(n.key)");
    expect(resources).toContain("flip(projKey(n.key), setShut)");
    expect(resources).toContain("shut.has(projKey(n.key))");
  });
  test("a CPU nobody read is a dash, never 0.0%", () => {
    expect(resources).toContain('cpu == null ? "—"');
    expect(resources).toContain("cpu={data.rated ? n.cpu : null}");
    expect(resources).not.toContain("cpu={p.cpu ?? 0}");
    expect(resources).not.toContain("cpu={otherCpu ?? 0}");
  });
});

describe("Low disk badge", () => {
  test("the panel reads the disk once on open, not only when Resources mounts", () => {
    expect(panel).toContain("api.machineResources(1).then((d) => publishMachineDisk(d.machine))");
    expect(panel).toContain("}, []);");
  });
});

describe("Disk cleanup look", () => {
  test("the scanning bar is the info blue, like every bar that means progress", () => {
    expect(css).toMatch(/\.mc-ind i\{[^}]*background:var\(--info\)/);
  });
  test("the report headline is amber only for a failure", () => {
    const line = diskClean.split("\n").find((l) => l.includes("{r.headline}")) ?? "";
    expect(line).toContain("--error-ink");
    expect(line).not.toContain("warning");
  });
});

describe("Docker views the mock showed and the app drew differently", () => {
  test("the build-cache gauge is amber while over budget and green once under, never the info blue", () => {
    expect(dockerCss).toMatch(/\.dk-gauge i\{[^}]*background:var\(--warning\)/);
    expect(dockerCss).toContain(".dk-gauge[data-ok=true] i{background:var(--success)}");
  });
  test("Docker is not installed is drawn with the container cube, not the plain box", () => {
    const fn = states.slice(states.indexOf("export function NotInstalled("));
    expect(fn.slice(0, fn.indexOf("\n}"))).toContain("<CubeIcon");
    expect(states).not.toContain("BoxIcon");
  });
});
