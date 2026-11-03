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
import { InheritedNote, LoadFailed, NothingSetUp, SavedChip } from "../src/components/orchestration/OrchStates.tsx";

const html = (el: React.ReactElement) => renderToStaticMarkup(el);
const PANE = readFileSync(join(import.meta.dir, "..", "src", "components", "orchestration", "OrchestrationPane.tsx"), "utf8");

describe("nothing set up yet", () => {
  const out = html(React.createElement(NothingSetUp, { onStart() {} }));
  test("says it once, offers the one press that works without a project, and starts from a preset", () => {
    expect(out).toContain("Nothing is set up yet");
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

describe("the save chip", () => {
  const chip = (o: Partial<{ saving: boolean; failed: boolean; dirty: boolean; word: string }>) =>
    html(React.createElement(SavedChip, { saving: false, failed: false, dirty: false, word: "orbit", ...o }));
  test("four readings, one at a time", () => {
    expect(chip({ saving: true, failed: true, dirty: true })).toContain("Saving");
    expect(chip({ failed: true, dirty: true })).toContain("Not saved \u00b7 try again");
    expect(chip({ dirty: true })).toContain("Permissions not saved");
    expect(chip({})).toContain("Saved for orbit");
    expect(chip({ word: "all projects" })).toContain("Saved for all projects");
  });
  test("a save that failed is not also read as a draft waiting, and a save out is not read as kept", () => {
    const failed = chip({ failed: true, dirty: true });
    expect(failed).not.toContain("Permissions not saved");
    expect(failed).not.toContain("Saved for");
    expect(chip({ saving: true })).not.toContain("Saved for");
  });
  test("a screen reader hears the change without being pulled off the page", () => {
    expect(chip({})).toContain('role="status"');
    expect(chip({})).toContain('aria-live="polite"');
  });
});

describe("a project that follows all projects", () => {
  const out = html(React.createElement(InheritedNote, { name: "orbit", busy: false, onMakeSpecific() {} }));
  test("says whose setting it follows, what that locks, and offers its own copy in the scope bar's words", () => {
    expect(out).toContain("Follows all projects");
    expect(out).toContain("orbit uses the general setting.");
    expect(out).toContain("Make it specific to orbit");
  });
  test("it does not claim the whole page is read-only: the limits and the presets still write", () => {
    expect(out).not.toContain("Everything below is read-only");
    expect(out).toContain("permissions are read-only");
  });
  test("a long project name and the press stack instead of pushing the page sideways", () => {
    expect(out).toContain("flex-wrap");
    // A zero basis let the sentence shrink to a sliver at 390 instead of pushing the press onto its own line.
    expect(out).toContain("flex-[1_1_14rem]");
    expect(html(React.createElement(InheritedNote, { name: "a-folder-name-that-goes-on-and-on-and-on", busy: false, onMakeSpecific() {} }))).toContain("a-folder-name-that-goes-on-and-on-and-on");
  });
  test("busy disables its one press", () => {
    expect(html(React.createElement(InheritedNote, { name: "orbit", busy: true, onMakeSpecific() {} }))).toContain("disabled");
  });
});

describe("the page draws them, it does not keep its own copies", () => {
  test("the pane uses the four components", () => {
    for (const c of ["NothingSetUp", "LoadFailed", "SavedChip", "InheritedNote"]) expect(PANE).toContain(`<${c} `);
  });
  test("the inherited row is drawn only for a project that follows all projects", () => {
    expect(PANE).toContain("{inherited && <InheritedNote");
  });
});
