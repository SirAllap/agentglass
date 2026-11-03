import { describe, expect, test } from "bun:test";
import { resolvePane } from "../src/lib/openSettings.ts";
import { SETTINGS_PAGES, SETTINGS_ROWS } from "../src/lib/settingsRows.gen.ts";

const read = (p: string) => Bun.file(new URL(`../src/${p}`, import.meta.url)).text();
const modal = await read("components/SettingsModal.tsx");
const gate = await read("components/agents/AgentsCards.tsx");
const clickup = await read("components/ClickUpPane.tsx");
const header = await read("components/SettingsPageHeader.tsx");
const lanternView = await read("components/LanternView.tsx");

const rowsOn = (pane: string) => SETTINGS_ROWS.filter((r) => r.pane === pane).map((r) => r.label);
const page = (id: string) => SETTINGS_PAGES.find((p) => p.id === id);

describe("Settings › Agents is one page", () => {
  test("one nav entry: Lantern is gone and its words are searchable on Agents", () => {
    expect(page("hooks")?.label).toBe("Agents");
    expect(page("lantern")).toBeUndefined();
    expect(modal).not.toContain('id: "lantern", label: "Lantern"');
    expect(modal).not.toContain('show("lantern")');
    const kw = /id: "hooks", label: "Agents", group: "Agents", kw: "([^"]*)"/.exec(modal)?.[1] ?? "";
    for (const word of ["lantern", "watching", "reminder", "orchestrator", "cache"]) expect(kw, word).toContain(word);
  });

  test("the blocks are in the mockup's order, down one column", () => {
    const body = modal.slice(modal.indexOf("function AgentsPage("), modal.indexOf("function SwitchButton("));
    for (const block of ['title="Watching"', 'title="Sessions"', 'title="The orchestrator"', 'title="Connect your agents"', 'title="Danger zone"']) {
      expect(body, block).toContain(block);
    }
    const order = ['title="Watching"', 'title="Sessions"', 'title="The orchestrator"', 'title="Connect your agents"', "<GateCard", "{skills}", 'title="Danger zone"'].map((x) => body.indexOf(x));
    expect(order.every((n) => n > -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(clickup).toContain('title="Card skills"');
  });

  test("every old id still has a row, and the old page's links land on Agents", () => {
    expect(resolvePane("lantern")).toBe("hooks");
    for (const l of ["Watch the agents and notify me", "Ask sessions what they are working on", "Wake the orchestrator at least every", "How long the prompt cache stays warm", "Ask me before anything leaves this machine"]) {
      expect(rowsOn("hooks"), l).toContain(l);
    }
    expect(rowsOn("hooks")).toEqual(expect.arrayContaining(["Take the hooks back out", "Forget worker roles", "Worker CLIs and models"]));
    // The pattern is a free-text row in the Card skills card, not a switch the index jumps into.
    expect(clickup).toContain('label="Card skills pattern"');
  });
});

describe("the merged page's controls", () => {
  test("Watching carries the live card beside it, with a Show it for the view outside", () => {
    const body = modal.slice(modal.indexOf("function AgentsPage("), modal.indexOf("function SwitchButton("));
    expect(body).toContain("<LanternPreview");
    expect(body).toContain("Opens the Agents view, outside Settings.");
    expect(body).toContain(">Show it</Button>");
    expect(body).toContain('emitControl({ cmd: "view", to: "agents" })');
    expect(body).toContain("closeSettings()");
  });

  test("the gate strip offers the same way out, and its copy says waits, not the banned verb", () => {
    expect(gate).toContain("agx-gate-strip");
    expect(gate).toContain(">Show it</Button>");
    for (const word of ["Holds", "held", "Hold what"]) expect(gate).not.toContain(word);
    expect(gate).toContain("Ask me before anything leaves this machine");
    expect(gate).toContain("Off: nothing is stopped.");
  });

  test("Card skills is generic and points at the tracker for the company's default", () => {
    expect(clickup).toContain('label="Card skills pattern"');
    expect(clickup).toContain("A pattern on a skill’s name or description.");
    expect(clickup).not.toContain('placeholder="clickup|');
    expect(clickup).toContain("The tracker’s own default lives on the");
    expect(clickup).toContain("Connect ClickUp under");
    expect(clickup).toContain('label="Card skills default"');
  });

  test("the shared frame carries the scope statement, and the index reads its cards", () => {
    expect(header).toContain('className="agx-ph-scope"');
    expect(modal).toContain('scope={navTab.id === "hooks" ?');
    expect(modal).toContain("Every project on this machine.");
    expect(modal).toContain("<SettingsToc");
  });
});

describe("what the merged page says before and without a read", () => {
  test("every control on the page is bound in the index under its own id", () => {
    const ids = SETTINGS_ROWS.filter((r) => r.pane === "hooks").map((r) => r.settingId);
    for (const id of ["lantern.watch", "lantern.watchMinutes", "lantern.nudge", "lantern.nudgeMinutes", "seat.wakeHours", "lantern.cacheTtlMinutes"]) {
      expect(ids, id).toContain(id);
    }
  });

  test("the watch's own facts are not reported before the read, nor invented when it fails", () => {
    const body = modal.slice(modal.indexOf("function AgentsPage("), modal.indexOf("function SwitchButton("));
    expect(body).toContain('const [watchRead, setWatchRead] = useState<"reading" | "ok" | "failed">("reading")');
    expect(body).toContain('setWatchRead("failed")');
    expect(body).toContain('const watchStatus = watchRead === "reading" ? "…"');
    expect(body).toContain("disabled={!watchKnown}");
  });

  test("an older shell draws no Browser access head over nothing", () => {
    expect(modal).toContain('data-panels={browser ? undefined : "1"}');
    expect(modal).toContain("{browser ? (");
  });

  test("no copy sends a reader to a Settings › Agents › Lantern page", () => {
    expect(lanternView).not.toContain("Agents → Lantern");
    expect(lanternView).not.toContain("Agents ▸ Lantern");
  });
});
