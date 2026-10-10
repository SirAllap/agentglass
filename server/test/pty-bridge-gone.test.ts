// A /tmp cleaner removes the extracted pty bridge while the server keeps running; every terminal
// attach then fails with "can't open file ... pty_bridge.py". The path is re-extracted when gone.
import { describe, expect, it } from "bun:test";
import { ensureBridge } from "../src/terminal.ts";

const src = "/$bunfs/root/pty_bridge.py";

describe("the extracted pty bridge survives a /tmp cleaner", () => {
  it("keeps the extracted copy while it is there", () => {
    let made = 0;
    expect(ensureBridge("/tmp/agentglass-bridge-AAAA/pty_bridge.py", src, () => true, () => { made++; return "x"; }))
      .toBe("/tmp/agentglass-bridge-AAAA/pty_bridge.py");
    expect(made).toBe(0);
  });

  it("extracts again when the directory was cleaned away", () => {
    expect(ensureBridge("/tmp/agentglass-bridge-AAAA/pty_bridge.py", src, () => false, () => "/tmp/agentglass-bridge-BBBB/pty_bridge.py"))
      .toBe("/tmp/agentglass-bridge-BBBB/pty_bridge.py");
  });

  it("never re-extracts when running from source (the path is the source file itself)", () => {
    let made = 0;
    expect(ensureBridge("/repo/server/pty_bridge.py", "/repo/server/pty_bridge.py", () => false, () => { made++; return "x"; }))
      .toBe("/repo/server/pty_bridge.py");
    expect(made).toBe(0);
  });

  it("the spawn asks for the live path, not the one captured at start-up", async () => {
    const t = await Bun.file(new URL("../src/terminal.ts", import.meta.url).pathname).text();
    expect(t).toContain("PYTHON, liveBridge(), ...run");
    expect(t).not.toMatch(/PYTHON, BRIDGE, \.\.\.run/);
  });
});
