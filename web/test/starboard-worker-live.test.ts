/*
 * The Live panel with a headless worker selected. Its steps are the tab the
 * server's reader draws, read over the named-agent door; before the first line
 * there is nothing to show, and the panel says which worker is quiet.
 */
import { test, expect } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { WorkerLive } from "../src/components/StarboardWorkerLive.tsx";

test("a worker with nothing printed yet is named rather than drawn as an empty feed", () => {
  const html = renderToStaticMarkup(React.createElement(WorkerLive, { name: "disk-cleanup-hero" }));
  expect(html).toContain("No steps yet from disk-cleanup-hero");
  expect(html).toContain("Live · disk-cleanup-hero");
  expect(html).not.toContain("No events match");
});
