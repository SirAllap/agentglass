/*
 * Measured against the rendered mockup: the base type of the Docker view is
 * 12px/1.4 (the app body is 16px, which made every answer card 3px taller per
 * line), and the log's find arrows point up for "previous" and down for "next".
 * No DOM under `bun test`, so these assert the source.
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("../src/components/docker/dockerCss.ts", import.meta.url), "utf8");
const log = readFileSync(new URL("../src/components/docker/LogView.tsx", import.meta.url), "utf8");
const panel = readFileSync(new URL("../src/components/DockerPanel.tsx", import.meta.url), "utf8");

test("the Docker root sets the 12px/1.4 base the mockup measures", () => {
  expect(css).toContain(".dk-root{font-size:12px;line-height:1.4}");
  expect(panel).toContain('className="dk-root ');
});

test("the bench line is padded only when a session exists", () => {
  // Rendered empty, its wrapper's 6px+6px padding was a band between the
  // header and the sidebar that the main column did not have.
  expect(panel).toContain("const dockerJob = useBenchJob(workspace");
  expect(panel).toContain("{workspace && dockerJob && <div");
  expect(panel).not.toContain("{workspace && <div");
});

test("previous match is the arrow pointing up, next is not rotated", () => {
  const prev = log.slice(log.indexOf('title="Previous match'));
  expect(prev.slice(0, prev.indexOf("</IconButton>"))).toContain("rotate(180deg)");
  const next = log.slice(log.indexOf('title="Next match'));
  expect(next.slice(0, next.indexOf("</IconButton>"))).not.toContain("rotate");
});

test("the log says when every line it has came from the run before", () => {
  // `docker logs` of a container that never started returns the previous run's
  // output, which reads as this attempt's. The decision is a pure function in
  // lib/dockerDetail.ts; this is the wire between it and the pane.
  expect(log).toContain("logFromEarlierRun(container, entries)");
  expect(log).toContain("{NO_LOG_FROM_THIS_START}");
  expect(log).toContain('className="dk-logold"');
});
