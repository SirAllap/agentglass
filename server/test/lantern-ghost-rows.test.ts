/*
 * A WORKER WHOSE WINDOW IS GONE, AND A TMUX THAT ANSWERED "NONE".
 *
 * The restart path leaves a registry row open (`ended_at = NULL`) so a dropped
 * tmux read cannot end a worker. The price is that such a row has to be
 * filtered against the pane list, and that filter used to switch itself off
 * whenever the list was empty — including when tmux successfully said there
 * were no panes at all. Every dead row then drew itself as working.
 *
 * The distinction only exists at `boardNow()`, where the tmux answer arrives,
 * so it is tested here rather than in a pure `merged()` fixture.
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "agx-ghost-"));
process.env.AGENTGLASS_DB = join(dir, "ghost.db");
process.env.AGENTGLASS_STATE_DIR = join(dir, "state");
process.env.XDG_CONFIG_HOME = join(dir, "config");
process.env.XDG_DATA_HOME = join(dir, "data");
process.env.XDG_CACHE_HOME = join(dir, "cache");
process.env.TMUX_TMPDIR = join(dir, "tmux");
delete process.env.AGENTGLASS_ROOT;

const fakeTmux = (name: string, body: string): string => {
  const file = join(dir, name);
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, 0o755);
  return file;
};
/* A tmux that answered with zero panes, and one that could not answer. */
const quiet = fakeTmux("tmux-quiet", "exit 0");
const failed = fakeTmux("tmux-failed", "exit 1");

let db: typeof import("../src/db.ts")["db"];
let lantern: typeof import("../src/lantern.ts");

beforeAll(async () => {
  db = (await import("../src/db.ts")).db;
  lantern = await import("../src/lantern.ts");
});

afterAll(() => {
  delete process.env.AGENTGLASS_TMUX_PATH;
});

describe("a registry row whose window is gone", () => {
  const insert = (name: string, paneId: string, startedAt: number) =>
    db.query("INSERT INTO named_agent (name, kind, cwd, pane_id, window_id, started_at, ended_at) VALUES (?, 'opencode', ?, ?, '@1', ?, NULL)")
      .run(name, join(dir, "gone-checkout"), paneId, startedAt);

  const names = async (bin: string) => {
    process.env.AGENTGLASS_TMUX_PATH = bin;
    db.query("DELETE FROM named_agent").run();
    insert("ghost-rows-worker", "%71", Date.now() - 5 * 60_000);
    return (await lantern.boardNow()).map((r) => r.name);
  };

  test("is not drawn when tmux successfully listed no panes", async () => {
    expect(await names(quiet)).not.toContain("ghost-rows-worker");
  });

  test("is still there when the read failed, because nobody looked", async () => {
    expect(await names(failed)).toContain("ghost-rows-worker");
  });
});
