/**
 * A one-off permission mode ("Permission mode for this run") reaches the server on
 * the terminal socket. Two rules hold there: only the modes an engine has a flag
 * for change how it starts, and an AGENT that opened the socket can only go as
 * strict as the person's setting, never looser — the escalation the settings door
 * already refuses.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchFlags, launchPerm } from "../src/launchperm.ts";
import { writeLaunchPermissions } from "../src/config.ts";

const prevXdg = process.env.XDG_CONFIG_HOME;
let dir = "";
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "agx-runmode-"));
  process.env.XDG_CONFIG_HOME = dir;
});
afterAll(() => {
  if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = prevXdg;
  rmSync(dir, { recursive: true, force: true });
});

describe("an agent cannot loosen the mode for a run", () => {
  test("the person's click can; an agent's request is held at the setting", () => {
    expect(writeLaunchPermissions({ mode: "default" }).ok).toBe(true);
    expect(launchPerm("bypassPermissions").mode).toBe("bypassPermissions");
    expect(launchPerm("bypassPermissions", false, true).mode).toBe("default");
    expect(launchPerm("auto", false, true).mode).toBe("default");
    expect(launchPerm(undefined, true, true).mode).toBe("default");
  });

  test("stricter than the setting is always allowed, looser is clamped to it", () => {
    expect(writeLaunchPermissions({ mode: "auto" }).ok).toBe(true);
    expect(launchPerm("default", false, true).mode).toBe("default");
    expect(launchPerm("auto", false, true).mode).toBe("auto");
    expect(launchPerm("bypassPermissions", false, true).mode).toBe("auto");
    expect(launchPerm(undefined, false, true).mode).toBe("auto");
    expect(writeLaunchPermissions({ mode: "default" }).ok).toBe(true);
  });

  test("every place the socket reads a mode passes whether an agent opened it", async () => {
    const term = await Bun.file(new URL("../src/terminal.ts", import.meta.url).pathname).text();
    const calls = term.match(/launchPerm\([^\n]*\)/g) ?? [];
    const fromMsg = calls.filter((c) => c.includes("msg.mode"));
    expect(fromMsg.length).toBe(4);
    // Inline, or through the one const that reads the same field.
    for (const c of fromMsg) expect(c.includes("(ws.data as PtyWsData).worker") || c.includes("fromWorker")).toBe(true);
    expect(term).toContain("const fromWorker = !!(ws.data as PtyWsData).worker;");
    const idx = await Bun.file(new URL("../src/index.ts", import.meta.url).pathname).text();
    expect(idx).toContain("worker: presentedWorker(req),");
  });
});

describe("only the modes an engine has a flag for change how it starts", () => {
  const knows = () => true;
  test("OpenCode maps bypass only; auto and acceptEdits start it as it is", () => {
    expect(launchFlags("opencode", { mode: "bypassPermissions", deny: [] }, knows)).toEqual(["--auto"]);
    expect(launchFlags("opencode", { mode: "auto", deny: [] }, knows)).toEqual([]);
    expect(launchFlags("opencode", { mode: "acceptEdits", deny: [] }, knows)).toEqual([]);
  });

  test("Codex maps auto and bypass", () => {
    expect(launchFlags("codex", { mode: "auto", deny: [] }, knows)).not.toEqual([]);
    expect(launchFlags("codex", { mode: "bypassPermissions", deny: [] }, knows)).not.toEqual([]);
    expect(launchFlags("codex", { mode: "acceptEdits", deny: [] }, knows)).toEqual([]);
  });
});
