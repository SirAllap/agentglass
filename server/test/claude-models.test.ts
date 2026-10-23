import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { parseCatalog, isOffered, todayStamp, claudeModels, catalogPaths } from "../src/claudemodels.ts";

// Claude Code publishes no model list — no `models` subcommand, no
// `--list-models`, no cache on disk — so unlike Codex and Antigravity this one
// has to be written down. Written down as data, so it can be corrected without
// a rebuild, which puts the parsing and the expiry rule on this file.

const catalog = (rows: unknown[]) => JSON.stringify({ models: rows });
const row = (over: Record<string, unknown> = {}) => ({
  id: "claude-opus-5", display_name: "Claude Opus 5", status: "active",
  release_date: "2026-07-24", scheduled_shutdown_date: "2027-07-24", ...over,
});

describe("what is still offered", () => {
  test("a model is offered up to and including its shutdown date", () => {
    // The date is the last day it is offered, not the first day it is gone.
    // Stated here because it is the kind of boundary that is otherwise decided
    // by accident.
    expect(isOffered(row({ scheduled_shutdown_date: "2026-08-01" }), "2026-07-31")).toBe(true);
    expect(isOffered(row({ scheduled_shutdown_date: "2026-08-01" }), "2026-08-01")).toBe(true);
    expect(isOffered(row({ scheduled_shutdown_date: "2026-08-01" }), "2026-08-02")).toBe(false);
  });

  test("no shutdown date means no retirement announced, not retired long ago", () => {
    expect(isOffered({ id: "x" }, "2030-01-01")).toBe(true);
    expect(isOffered(row({ scheduled_shutdown_date: "" }), "2030-01-01")).toBe(true);
    expect(isOffered(row({ scheduled_shutdown_date: "soon" }), "2030-01-01")).toBe(true);
  });

  test("a retired model is dropped from the list", () => {
    const raw = catalog([
      row({ id: "claude-opus-5" }),
      row({ id: "claude-haiku-4-5", scheduled_shutdown_date: "2026-01-01" }),
    ]);
    expect(parseCatalog(raw, "2026-07-31").map((m) => m.id)).toEqual(["claude-opus-5"]);
  });

  test("status is recorded but does not filter", () => {
    // A superseded model still answers until it is actually retired; hiding it
    // early would take away a choice that works.
    const raw = catalog([row({ id: "claude-opus-4-6", status: "superseded", scheduled_shutdown_date: "2027-02-05" })]);
    expect(parseCatalog(raw, "2026-07-31").map((m) => m.id)).toEqual(["claude-opus-4-6"]);
  });
});

describe("reading the file", () => {
  test("display_name becomes the label, and the id stands in without one", () => {
    const out = parseCatalog(catalog([row(), row({ id: "claude-sonnet-5", display_name: undefined })]), "2026-07-31");
    expect(out).toEqual([
      { id: "claude-opus-5", label: "Claude Opus 5" },
      { id: "claude-sonnet-5", label: "claude-sonnet-5" },
    ]);
  });

  test("the 1M variant is its own entry", () => {
    // Not a duplicate: the suffix is what `claude` reads to pick a window behind
    // a gateway or on Bedrock, where the plain id really does mean 200k.
    const out = parseCatalog(catalog([row({ id: "claude-opus-5[1m]", display_name: "Claude Opus 5 · 1M" })]), "2026-07-31");
    expect(out.map((m) => m.id)).toEqual(["claude-opus-5[1m]"]);
  });

  test("an id the send path would refuse is not offered", () => {
    // The same expression guards the spawn in chat.ts. A dropdown entry that
    // cannot be sent is worse than one that is missing.
    const out = parseCatalog(catalog([row({ id: "../../etc/passwd" }), row({ id: "model with spaces" }), row()]), "2026-07-31");
    expect(out.map((m) => m.id)).toEqual(["claude-opus-5"]);
  });

  test("a file edited into nonsense yields nothing rather than throwing", () => {
    // This is hand-edited by definition, so a broken file is a normal state and
    // must not take the route down with it.
    expect(parseCatalog("{ not json", "2026-07-31")).toEqual([]);
    expect(parseCatalog(JSON.stringify({ models: "everything" }), "2026-07-31")).toEqual([]);
    expect(parseCatalog(JSON.stringify({}), "2026-07-31")).toEqual([]);
    expect(parseCatalog(catalog([null, 7, "x"]), "2026-07-31")).toEqual([]);
  });

  test("the same id twice is listed once", () => {
    expect(parseCatalog(catalog([row(), row()]), "2026-07-31")).toHaveLength(1);
  });
});

describe("where it is read from", () => {
  let dir = "";
  const saved = process.env.AGENTGLASS_CLAUDE_MODELS;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "agx-models-")); });
  afterEach(() => {
    if (saved === undefined) delete process.env.AGENTGLASS_CLAUDE_MODELS;
    else process.env.AGENTGLASS_CLAUDE_MODELS = saved;
    rmSync(dir, { recursive: true, force: true });
  });

  test("an override wins over the copy in the checkout", () => {
    // The point of the file being data is that it can be corrected on a machine
    // whose checkout is packaged or read-only.
    const p = join(dir, "claude-models.json");
    writeFileSync(p, catalog([row({ id: "claude-fable-5", display_name: "Only This One" })]));
    process.env.AGENTGLASS_CLAUDE_MODELS = p;
    expect(catalogPaths()[0]).toBe(p);
    expect(claudeModels()).toEqual([{ id: "claude-fable-5", label: "Only This One" }]);
  });

  test("an edit is picked up without a restart", () => {
    // Re-read on mtime, because "update the list without redeploying" is the
    // whole reason this is a file.
    const p = join(dir, "claude-models.json");
    process.env.AGENTGLASS_CLAUDE_MODELS = p;
    writeFileSync(p, catalog([row({ id: "claude-opus-5", display_name: "First" })]));
    expect(claudeModels()[0].label).toBe("First");
    writeFileSync(p, catalog([row({ id: "claude-opus-5", display_name: "Second" })]));
    expect(claudeModels()[0].label).toBe("Second");
  });

  test("a broken override falls through rather than emptying the dropdown", () => {
    const p = join(dir, "claude-models.json");
    writeFileSync(p, "{{{");
    process.env.AGENTGLASS_CLAUDE_MODELS = p;
    // The checkout's own catalogue answers instead.
    expect(claudeModels().length).toBeGreaterThan(0);
  });
});

describe("the catalogue this repo ships", () => {
  test("is readable, and every entry survives its own rules", () => {
    delete process.env.AGENTGLASS_CLAUDE_MODELS;
    const out = claudeModels();
    expect(out.length).toBeGreaterThan(1);
    // The default a new chat is created with has to be one of the offered ids,
    // or the picker opens showing a choice it does not list.
    expect(out.map((m) => m.id)).toContain("claude-opus-5");
  });

  test("offers the models Claude Code offers, not one fallback id", () => {
    delete process.env.AGENTGLASS_CLAUDE_MODELS;
    const ids = claudeModels().map((m) => m.id);
    for (const id of ["claude-sonnet-5-5", "claude-opus-5-5", "claude-fable-5-1", "claude-haiku-5-5", "claude-sonnet-5", "claude-opus-5", "claude-fable-5", "claude-opus-4-8"]) {
      expect(ids).toContain(id);
    }
    // claude-haiku-4-5 is catalogued with a shutdown of 2026-10-15, so it left
    // the list the next day and a test that names it fails on the calendar, not
    // on a change. Its retirement is asserted against a fixed day instead.
    const haiku = JSON.parse(readFileSync(join(import.meta.dir, "../../shared/claude-models.json"), "utf8")).models.find((m: { id: string }) => m.id === "claude-haiku-4-5");
    expect(isOffered(haiku, "2026-10-15")).toBe(true);
    expect(isOffered(haiku, "2026-10-16")).toBe(false);
  });

  test("today's stamp is a plain calendar date", () => {
    expect(todayStamp(new Date(2026, 6, 31))).toBe("2026-07-31");
    // Zero-padded, or string comparison against the file's dates is wrong for
    // nine months of the year.
    expect(todayStamp(new Date(2026, 0, 5))).toBe("2026-01-05");
  });
});

// The catalogue is read from disk at runtime, so `bun build --compile` does not
// carry it: a packaged app finds it beside its sidecar or it offers one model.
// Measured on an installed app: the local build staged no copy, and only CI did.
describe("the packaged layout carries the catalogue", () => {
  const ROOT = join(import.meta.dir, "../..");
  const build = Bun.file(join(ROOT, "electron/build.mjs")).text();

  test("the sidecar looks beside its own binary", () => {
    expect(catalogPaths()).toContain(join(dirname(process.execPath), "claude-models.json"));
  });

  test("build.mjs stages it on every path, after the local/CI split", async () => {
    const src = await build;
    const copy = src.indexOf('copyFileSync(resolve(REPO, "shared/claude-models.json")');
    expect(copy).toBeGreaterThan(-1);
    expect(src.slice(copy, copy + 200)).toContain('staging/claude-models.json');
    // Top level (column 0), so neither the local branch nor CI's
    // --provenance-only branch can skip it, and after the wipe of staging.
    expect(src.lastIndexOf("\n", copy) + 1).toBe(copy);
    expect(copy).toBeGreaterThan(src.indexOf('"--outfile", resolve(HERE, "staging/agentglass-server")'));
  });

  test("CI runs build.mjs, so the one copy covers it", async () => {
    const wf = await Bun.file(join(ROOT, ".github/workflows/desktop-binaries.yml")).text();
    expect(wf).toContain("node electron/build.mjs --provenance-only");
  });
});
