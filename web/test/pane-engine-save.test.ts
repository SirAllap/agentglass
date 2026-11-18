// The Restore switch and Resume mode on Settings > Pane engine save on change.
//
// They used to be written only when the tmux binary row's Save was pressed, so
// a toggle followed by closing Settings was gone after a reload. A layout that
// must come back after a power-off cannot depend on a second button.
import { test, expect } from "bun:test";
import { savePaneField } from "../src/lib/paneEngineSave.ts";

const src = await Bun.file(new URL("../src/components/settings/pages/TerminalPage.tsx", import.meta.url)).text();
const lines = src.split("\n").filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*") && !l.trim().startsWith("/*"));
const code = lines.join("\n");

test("a toggle sends only its own field, and the server keeps it", async () => {
  const held: Record<string, unknown> = { restore: false, resume: "lazy" };
  const save = async (f: object) => { Object.assign(held, f); return { ok: true }; };
  expect(await savePaneField(save, { restore: true }, "Restore")).toEqual({ ok: true });
  expect(await savePaneField(save, { resume: "all" }, "Resume mode")).toEqual({ ok: true });
  expect(held).toEqual({ restore: true, resume: "all" });
});

test("a refused save says why, so the caller can roll back", async () => {
  const r = await savePaneField(async () => ({ ok: false, error: "disk full" }), { restore: true }, "Restore");
  expect(r).toEqual({ ok: false, error: "disk full" });
  const bare = await savePaneField(async () => ({ ok: false }), { restore: true }, "Restore");
  expect(bare).toEqual({ ok: false, error: "Could not save Restore." });
});

test("an unreachable server is a failed save, not a thrown one", async () => {
  const r = await savePaneField(async () => { throw new Error("down"); }, { resume: "all" }, "Resume mode");
  expect(r).toEqual({ ok: false, error: "Could not save Resume mode — server unreachable." });
});

test("the controls call the saving path, and the binary Save no longer carries them", () => {
  // The Restore and Resume rows live on the Terminal page and save at once through saveEngine.
  expect(code).toContain('saveEngine({ restore: v }, "Restore", { restore: !v })');
  expect(code).toContain('saveEngine({ resume: v === "all" ? "all" : "lazy" }, "Resume mode"');
  const at = code.indexOf("const saveEngine = async (");
  const fn = code.slice(at, code.indexOf("\n  };", at));
  expect(fn).toContain("savePaneField(api.tmuxSettingsSave, field, what)");
  expect(code).not.toContain("onChange={setResume}");
});

test("a failed save shows the failure and reloads the real value, without blanking the page", () => {
  const at = code.indexOf("const saveEngine = async (");
  const fn = code.slice(at, code.indexOf("\n  };", at));
  expect(fn).toContain("setSaid(r.error)");
  expect(fn).toContain("await load()");
});
