/*
 * The states the page is not: nothing set up yet, a read that failed, the save
 * chip in each of its four readings, and the row a project that follows all
 * projects gets. Rendered, not grepped, so each one is tested as a person sees
 * it — mockup screen 6, in the real app's words.
 */
import { describe, expect, test } from "bun:test";
import React from "react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { LoadFailed, NothingSetUp } from "../src/components/orchestration/OrchStates.tsx";

const html = (el: React.ReactElement) => renderToStaticMarkup(el);
const PANE = readFileSync(join(import.meta.dir, "..", "src", "components", "orchestration", "OrchestrationPane.tsx"), "utf8");

describe("nothing set up yet", () => {
  const out = html(React.createElement(NothingSetUp, { onStart() {} }));
  test("says it once, offers the one press that works without a project, and starts from a preset", () => {
    expect(out).toContain("No workers are set up yet");
    expect(out).toContain("Start from a preset or build a flow.");
    expect(out).toContain("Set up for all projects");
  });
  test("is the mockup's block: a bare glyph over the line, not a card and not a tinted box", () => {
    expect(out).toContain("agx-orch-empty");
    expect(out).toContain("agx-orch-empty-art");
    expect(out).toContain("<svg");
    expect(out).not.toContain("agx-le-list");
    expect(out).not.toContain("agx-le-art");
  });
  test("carries the mockup's sentence and nothing after the press", () => {
    expect(out).not.toContain("Nothing is saved until you pick.");
    expect(out.indexOf("Set up for all projects")).toBeGreaterThan(out.indexOf("Start from a preset"));
  });
  test("the block is centred by its own rule, not by the list card it left", () => {
    const css = readFileSync(join(import.meta.dir, "..", "src", "components", "orchestration", "orchestration.css"), "utf8");
    expect(css).toContain(".agx-orch-empty {");
    expect(css).toContain(".agx-orch-empty-art {");
  });
});

describe("a read that failed", () => {
  test("names the setting, repeats what the server answered, and says nothing was changed", () => {
    const out = html(React.createElement(LoadFailed, { name: "orbit", error: "HTTP 503 from the settings door", retrying: false, onRetry() {} }));
    expect(out).toContain('role="alert"');
    expect(out).toContain("Could not load the setting for orbit.");
    expect(out).toContain("HTTP 503 from the settings door");
    expect(out).toContain("Nothing was changed. Your last saved setting is still in force.");
    expect(out).toContain("Retry");
  });
  test("the server's sentence and the one after it do not run together", () => {
    const out = html(React.createElement(LoadFailed, { name: "orbit", error: "HTTP 503.", retrying: false, onRetry() {} }));
    expect(out).toContain("HTTP 503.</code> Nothing was changed.");
    expect(out).not.toContain(".</code>Nothing");
  });
  test("the mockup's row: one press at the end, nothing written beside it", () => {
    const out = html(React.createElement(LoadFailed, { name: "orbit", error: "x", retrying: false, onRetry() {} }));
    expect(out).not.toContain("Asks the server again");
    expect(out.indexOf("Retry")).toBeGreaterThan(out.indexOf("Could not load"));
  });
  test("while it asks again the press is spent and says so", () => {
    const out = html(React.createElement(LoadFailed, { name: "all projects", error: "Could not reach the server.", retrying: true, onRetry() {} }));
    expect(out).toContain("Could not load the setting for all projects.");
    expect(out).toContain("Trying again");
    expect(out).toContain("disabled");
  });
});

describe("the page draws its states, it does not keep its own copies", () => {
  test("the pane uses the two state components", () => {
    for (const c of ["NothingSetUp", "LoadFailed"]) expect(PANE).toContain(`<${c} `);
  });
  test("the save chip and the inherited banner are gone: the shared Applies to control and the row tags replace them", () => {
    for (const gone of ["SavedChip", "InheritedNote", "SpecificNote"]) expect(PANE).not.toContain(gone);
    expect(PANE).toContain("<ScopeControl");
    expect(PANE).not.toContain("ScopeStrip");
  });
});
