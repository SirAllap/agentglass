/*
 * The agents pane, and the one distinction it exists to make.
 *
 * A config that was written and an event that arrived are different facts, and
 * every failure in this area looks like the first: a file in the right shape a
 * CLI does not read, a session started before the change, a typo in an
 * endpoint. A tick over a file that changed nothing stops the search, which is
 * worse than no tick at all.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const pane = readFileSync(new URL("../src/components/AgentsPane.tsx", import.meta.url), "utf8");

describe("the four states", () => {
  test("live means an event arrived, not that a file was written", () => {
    expect(pane).toContain('p.seenAt ? "live"');
    // …and a written config with nothing arrived has its own word, rather than
    // being rounded up to working or down to nothing.
    expect(pane).toContain('p.connected ? "waiting"');
  });

  test("and waiting says what to do about it", () => {
    // The state somebody otherwise sits in for ten minutes. Almost always the
    // answer is that the session predates the change.
    expect(pane).toMatch(/start a new session for it to take effect/);
  });

  test("installed-but-unwired is distinct from not installed", () => {
    expect(pane).toContain('p.found ? "ready" : "missing"');
  });
});

describe("what is shown", () => {
  test("everything, including what is not installed", () => {
    // A list of what is present says nothing about what is *supported*, which
    // is the question somebody has before they try a second agent at all.
    expect(pane).toContain("agents.map((p) => {");
    expect(pane).not.toContain("agents.filter");
  });

  test("with how to get the ones that are missing", () => {
    expect(pane).toContain("p.install");
  });

  test("and the file that connecting would write, on screen rather than in a tooltip", () => {
    // It is a file in somebody's home directory. A path that only appears in a
    // `title` is invisible on a touch device and to anybody not hovering — and
    // a check for the bare `{p.configPath}` passes on the tooltips alone.
    expect(pane).toMatch(/t-mono truncate[^>]*>\{p\.configPath\}</);
  });

  test("but no button for something that is not there", () => {
    // Nothing to wire. A Connect button over an absent CLI writes a config
    // that never does anything.
    expect(pane).toContain('{state === "missing" ? (');
  });
});

describe("what it says about itself", () => {
  test("that connected means an event landed", () => {
    expect(pane).toMatch(/Connected means an event has actually arrived/);
  });

  test("and that the config is backed up and a bad one left alone", () => {
    // Both true of connect_otel.py, and both the kind of thing somebody wants
    // to know before pressing a button that edits a file they did not open.
    expect(pane).toMatch(/backed up/);
    expect(pane).toMatch(/cannot parse is left alone/);
  });

  test("it polls, because the state it shows changes without anybody clicking", () => {
    // "waiting" becomes "live" the moment the first event arrives, and nobody
    // is going to press refresh to find that out.
    expect(pane).toContain("setInterval(load");
  });
});
