/*
 * Tests that actually execute the Docker panel.
 *
 * Everything else about this view is tested as data — grouping, filtering,
 * parsing — and all of it stays green if the component that draws it throws on
 * first paint. That failure mode is not hypothetical here: this app has shipped
 * a black window twice, both times from a component that imported fine and died
 * when React ran it (see the TDZ lock in the same suite).
 *
 * There is no DOM under `bun test`, so effects do not run and what these see is
 * the FIRST PAINT: no daemon, no data, nothing fetched. That is precisely the
 * state a user sees for the first second, and the one nothing else covers.
 */
import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { DockerContainer } from "../../shared/types.ts";
import { DockerView } from "../src/components/DockerPanel.tsx";
import { Detail } from "../src/components/docker/Detail.tsx";
import { LogView } from "../src/components/docker/LogView.tsx";

const draw = (el: React.ReactElement) => renderToStaticMarkup(el);
const bar = {
  step: { i: 2, n: 5, prev: "a", next: "c" }, showStep: true, readOnly: false, busy: false,
  onStep: () => {}, onVerb: () => {}, onMenuPick: () => {},
};
const folds = { env: false, config: false, top: false, compare: false };

const container = (over: Partial<DockerContainer> = {}): DockerContainer => ({
  id: "a1b2c3d4e5f6", name: "orbit-app", image: "orbit-django:dev", state: "running",
  status: "Up 4 hours (healthy)", ports: "0.0.0.0:8000->8000/tcp", project: "orbit", service: "app",
  workingDir: "/home/dev/code/orbit", runningFor: "4 hours ago", size: "",
  health: "healthy", uptime: "Up 4 hours", restarts: 0, startedAt: "2026-08-19T09:00:00Z",
  portList: [{ host: 8000, hostEnd: 8000, hostIp: "0.0.0.0", container: 8000, containerEnd: 8000, proto: "tcp", web: true }],
  owner: { worktree: "orbit-1042", branch: "ORBIT-1042-caller-id", foreign: true, path: "/home/dev/code/orbit-1042" },
  ...over,
});

describe("the view draws on its first paint", () => {
  test("DockerView renders before anything has been fetched", () => {
    // No daemon, no overview, no capability answer yet. This is the first
    // second of every session and it must not be a blank window.
    const html = draw(React.createElement(DockerView, { active: true }));
    expect(html.length).toBeGreaterThan(120);
    expect(html).toContain("<");
  });

  test("and while it is inactive, which is how it stays mounted", () => {
    expect(() => draw(React.createElement(DockerView, { active: false }))).not.toThrow();
  });
});

describe("the pieces the view is made of", () => {
  /* Each of these owns a hook or two of its own. A hook called conditionally,
     or a constant read before its declaration, throws here and nowhere else in
     the suite. */
  test("the detail, with a container that has everything", () => {
    const html = draw(React.createElement(Detail, {
      c: container(), stat: undefined, env: null, config: null, top: null, error: null,
      readOnly: false, tail: 200, onTail: () => {}, onOpenPort: () => {}, bar,
      open: folds, onToggle: () => {},
      others: [container({ id: "ffffffffffff", name: "orbit-app-2" })],
    }));
    expect(html).toContain("orbit-app");
    // The facts that used to hide behind the "Info" tab have to be in the
    // first paint, since that is the whole point of removing the tabs.
    expect(html).toContain("orbit-django:dev");
    expect(html).toContain("4 hours");
    expect(html).toContain("orbit-1042");
  });

  test("and with a container that has nothing but the poll's own fields", () => {
    // An older server, the demo adapter, a cached shape: every added field is
    // optional and the detail must not assume one.
    const bare: DockerContainer = {
      id: "abc", name: "x", image: "i", state: "exited", status: "Exited (0)", ports: "",
      project: null, service: null, workingDir: null, runningFor: "", size: "",
    };
    expect(() => draw(React.createElement(Detail, {
      c: bare, env: null, config: null, top: null, error: null, readOnly: true,
      tail: 200, onTail: () => {}, onOpenPort: () => {}, bar,
      open: folds, onToggle: () => {}, others: [],
    }))).not.toThrow();
  });

  test("the log view, with no stream open", () => {
    const html = draw(React.createElement(LogView, { id: "abc123", tail: 200, onTail: () => {}, running: true }));
    // "Live" is the claim it makes before a single byte arrives; the filters
    // are what make a wall of lines readable.
    expect(html).toContain("Live");
    expect(html).toContain("Errors");
    expect(html).toContain("Find in log");
  });

  test("a sick container shows the red line with its way into the log, a healthy one does not", () => {
    const props = { stat: undefined, env: null, config: null, top: null, error: null, readOnly: false, tail: 200, onTail: () => {}, onOpenPort: () => {}, bar, open: folds, onToggle: () => {}, others: [] };
    const sick = draw(React.createElement(Detail, { ...props, c: container({ health: "unhealthy", healthFailures: 3, healthError: "GET /healthz answers 502" }) }));
    expect(sick).toContain("Health check failing 3 times in a row:");
    expect(sick).toContain("Show in log");
    expect(draw(React.createElement(Detail, { ...props, c: container() }))).not.toContain("Show in log");
  });

  test("the head: the one action, Shell, the step in the list layout and not in split", () => {
    const props = { stat: undefined, env: null, config: null, top: null, error: null, readOnly: false, tail: 200, onTail: () => {}, onOpenPort: () => {}, open: folds, onToggle: () => {}, others: [] };
    const html = draw(React.createElement(Detail, { ...props, c: container(), bar }));
    expect(html).toContain("Restart");
    expect(html).toContain("Shell");
    expect(html).toContain("2 / 5");
    expect(draw(React.createElement(Detail, { ...props, c: container(), bar: { ...bar, showStep: false } }))).not.toContain("2 / 5");
    expect(draw(React.createElement(Detail, { ...props, c: container({ state: "paused", status: "Up 1 hour (Paused)" }), bar }))).toContain("Resume");
  });

  test("the four cards read the live stats, and the folds are all there", () => {
    const html = draw(React.createElement(Detail, {
      c: container(), stat: { id: "a1b2c3d4e5f6", cpu: 61.2, mem: 41.6, memUsage: "416MiB / 1GiB", netIO: "", blockIO: "", pids: 4 },
      env: null, config: null, top: null, error: null, readOnly: false, tail: 200, onTail: () => {}, onOpenPort: () => {},
      open: folds, onToggle: () => {}, others: [], bar,
    }));
    expect(html).toContain("61.2 %");
    expect(html).toContain("416MiB of 1GiB");
    for (const w of ["Environment", "Compare environment with another worktree", "Processes", "Inspect"]) expect(html).toContain(w);
  });
});

describe("what the panel refuses to offer", () => {
  /* The dangerous reclaim is deliberately not a button. This is the UI half of
     the lock in server/test/docker-prune.test.ts: the sentence explaining why
     has to survive, because deleting it and adding the button is a two-line
     change somebody will otherwise make on a quiet afternoon. */
  test("there is no volume-prune button, and the reason is written down", () => {
    const source = require("node:fs").readFileSync(new URL("../src/components/docker/Disk.tsx", import.meta.url).pathname, "utf8");
    expect(source).toContain("No “prune volumes” button here.");
    expect(source).not.toMatch(/dockerPruneVolumes|volume["'\s]*,\s*["']prune/);
  });
});
