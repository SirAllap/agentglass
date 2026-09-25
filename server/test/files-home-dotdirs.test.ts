// With no project open, the file routes answer for the whole machine — the
// default install. The owner at the desk keeps that; a narrower key (a paired
// device, a plugin, an understudy run, a seat) does not get the
// dot-directories directly under $HOME.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Caller } from "../src/auth.ts";

const saved = { HOME: process.env.HOME, AGENTGLASS_ROOT: process.env.AGENTGLASS_ROOT };
let home: string;

beforeAll(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "agx-dothome-")));
  mkdirSync(join(home, ".ssh"));
  writeFileSync(join(home, ".ssh", "id_orbit"), "fake key\n");
  mkdirSync(join(home, "code", "orbit"), { recursive: true });
  writeFileSync(join(home, "code", "orbit", "README.md"), "# orbit\n");
  mkdirSync(join(home, "code", "orbit", ".github"));
  symlinkSync(join(home, ".ssh"), join(home, "code", "orbit", "keys"));
  process.env.HOME = home;
  delete process.env.AGENTGLASS_ROOT;
});

afterAll(() => {
  for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  rmSync(home, { recursive: true, force: true });
});

const phone = { kind: "device", scope: "read" } as Caller;
const plugin = { kind: "plugin", scope: "read" } as Caller;
const understudy = { kind: "machine", scope: "full", principal: "understudy" } as Caller;
const desk = { kind: "machine", scope: "full" } as Caller;

describe("dot-directories under home", () => {
  test("a narrower key is held back from a dot-directory under home, and below it", async () => {
    const { heldBackFrom } = await import("../src/files.ts");
    for (const c of [phone, plugin, understudy]) {
      expect(heldBackFrom(c, [join(home, ".ssh")])).toBe(true);
      expect(heldBackFrom(c, [join(home, ".ssh", "id_orbit")])).toBe(true);
      expect(heldBackFrom(c, [join(home, "code", "orbit", "keys", "id_orbit")])).toBe(true);
    }
  });

  test("the rest of home, and a repo's own dotfiles, stay readable to it", async () => {
    const { heldBackFrom } = await import("../src/files.ts");
    expect(heldBackFrom(phone, [home, join(home, "code", "orbit", "README.md")])).toBe(false);
    expect(heldBackFrom(phone, [join(home, "code", "orbit", ".github")])).toBe(false);
  });

  test("the desk keeps today's reach", async () => {
    const { heldBackFrom } = await import("../src/files.ts");
    expect(heldBackFrom(desk, [join(home, ".ssh", "id_orbit")])).toBe(false);
    expect(heldBackFrom(null, [join(home, ".ssh", "id_orbit")])).toBe(false);
  });

  test("a project of ~ contains every dot-directory, and does not open them", async () => {
    const { heldBackFrom } = await import("../src/files.ts");
    process.env.AGENTGLASS_ROOT = home;
    try {
      expect(heldBackFrom(phone, [join(home, ".ssh", "id_orbit")])).toBe(true);
    } finally {
      delete process.env.AGENTGLASS_ROOT;
    }
  });

  test("a project that IS the dot-directory opens it", async () => {
    const { heldBackFrom } = await import("../src/files.ts");
    process.env.AGENTGLASS_ROOT = join(home, ".ssh");
    try {
      expect(heldBackFrom(phone, [join(home, ".ssh", "id_orbit")])).toBe(false);
    } finally {
      delete process.env.AGENTGLASS_ROOT;
    }
  });
});
