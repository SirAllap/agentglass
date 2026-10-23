/*
 * Rules about the source of the DEVICES surface, asserted against the source:
 * there is no renderer here. The passphrase is the one secret; the rail is the
 * one place the row's buttons must not be drawn.
 */
import { describe, expect, test } from "bun:test";

const dialogs = await Bun.file(new URL("../src/components/finder/machine/VolumeDialogs.tsx", import.meta.url)).text();
const flow = await Bun.file(new URL("../src/components/finder/machine/useVolumeFlow.tsx", import.meta.url)).text();
const logic = await Bun.file(new URL("../src/lib/finderVolumes.ts", import.meta.url)).text();
const bar = await Bun.file(new URL("../src/components/finder/machine/FinderPathBar.tsx", import.meta.url)).text();
const side = await Bun.file(new URL("../src/components/finder/machine/Sidebar.tsx", import.meta.url)).text();
const code = (s: string) => s.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");

describe("the passphrase", () => {
  for (const [name, src] of [["VolumeDialogs", dialogs], ["useVolumeFlow", flow], ["finderVolumes", logic]] as const) {
    test(`${name} keeps it nowhere: no storage, no console, no location`, () => {
      expect(code(src)).not.toMatch(/localStorage|sessionStorage|indexedDB|console\.|document\.cookie|location\.(hash|search)|history\./);
    });
  }
  test("the field is a password field that the browser is told not to remember, and is emptied on submit", () => {
    expect(dialogs).toContain('type={peek ? "text" : "password"}');
    expect(dialogs).toContain('autoComplete="off"');
    expect(dialogs).toMatch(/const p = pass; setPass\(""\); onSubmit\(p\)/);
  });
  test("the api call is the only place it leaves, and as the body", () => {
    expect(code(logic)).not.toContain("passphrase=");
    expect(code(flow)).toContain("api.volumeAct(act, v.id, passphrase)");
    expect(code(flow)).not.toContain("${passphrase}");
  });
});

describe("a server's credentials", () => {
  test("the connect dialog hands them over once and empties its state, and has no way to say yes by itself", () => {
    expect(dialogs).toMatch(/const answers = vals; setVals\(\{\}\); onAnswer\(\{ answers \}\)/);
    // A host key is a button per choice gio offered; nothing in the dialog or the flow chooses.
    expect(dialogs).toContain("onAnswer({ choice: i + 1 })");
    expect(code(flow)).not.toMatch(/choice:\s*\d/);
  });
  test("the password field hides what is typed until asked", () => { expect(dialogs).toContain('type={f === "Password" && !peek ? "password" : "text"}'); });
});

describe("the rail", () => {
  test("draws the device icon and nothing else: no heading, no lock, no eject", () => {
    const fn = side.slice(side.indexOf("const device = "), side.indexOf("return (\n    <div className=\"relative shrink-0 flex min-h-0\""));
    expect(fn).toContain("{!rail && lock && act(lock)}");
    expect(fn).toContain("{!rail && eject && act(eject)}");
    expect(fn).toContain("{!rail && <span className=\"truncate\">{v.name}</span>}");
    expect(side).toContain("{!rail && <div");
  });
  test("the section appears only when there is a volume", () => { expect(side).toContain("volumes.length > 0 &&"); });
});

describe("the path bar and a remote", () => {
  test("a typed address never reaches the folder completion, and goes to the connection flow", () => {
    expect(bar).toContain("isRemoteAddress(text) ? null : completePath");
    expect(bar).toMatch(/if \(isRemoteAddress\(v\)\) \{ onRemote\?\.\(v\); return; \}/);
  });
});
