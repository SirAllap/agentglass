/*
 * Adding to the sidebar is a dialog, not a bar wedged between the rail and the
 * toolbar: the same shell as the other Tasks dialogs, header and Cancel, with
 * the folder picker, the address field and Enter/Esc still in it. Read as source.
 */
import { describe, expect, it } from "bun:test";

const panel = await Bun.file(new URL("../src/components/TasksPanel.tsx", import.meta.url)).text();
const jira = await Bun.file(new URL("../src/components/jira/AddBar.tsx", import.meta.url)).text();
const fn = (src: string, head: string) => {
  const i = src.indexOf(head);
  const j = src.indexOf("\n}\n", i);
  return src.slice(i, j);
};
const bar = fn(panel, "function AddBoardBar(");

describe("Add to the sidebar", () => {
  it("is a TaskDialog titled for the errand, with Cancel and a primary Add", () => {
    expect(bar).toContain('<TaskDialog title={editing ? "Change address" : "Add to the sidebar"}');
    expect(bar).toContain("<Button onClick={onClose}>Cancel</Button>");
    expect(bar).toContain('tone="primary"');
    expect(bar).toContain('"Add to sidebar"');
  });
  it("keeps the folder picker, the address field, Enter and Escape", () => {
    expect(bar).toContain("<FolderPicker ");
    expect(bar).toContain('e.key === "Enter"');
    expect(bar).toContain('e.key === "Escape"');
    expect(bar).toContain("onAddList={onAddList}");
  });
  it("offers the picker only when adding, never when changing one address", () => {
    expect(bar).toContain('useState<"folder" | "url">(editing ? "url" : "folder")');
    expect(bar).toContain("{!editing && (");
  });
  it("says a failed attempt inside the dialog, since the footer line is behind the scrim", () => {
    expect(bar).toContain("error ? error");
    expect(panel).toContain("error={note && !note.ok ? note.text : null}");
  });
  it("is the same dialog for Jira", () => {
    expect(jira).toContain('<TaskDialog title="Add to the sidebar"');
    expect(jira).toContain("Cancel");
  });
  it("is no longer an inline bar", () => {
    expect(bar).not.toContain("px-5 pb-2 flex flex-col");
    expect(bar).not.toContain(">Close</button>");
  });
});

describe("About a list", () => {
  const about = fn(panel, "function AboutList(");
  it("is a TaskDialog with the brief, Open in ClickUp and Close in the foot", () => {
    expect(about).toContain("<TaskDialog title={`About ${name}`}");
    expect(about).toContain("<AboutBody text={text} />");
    expect(about).toContain("Open in ClickUp");
    expect(about).toContain("<Button onClick={onClose}>Close</Button>");
  });
  it("no longer builds its own scrim and box", () => {
    expect(about).not.toContain("fixed inset-0");
    expect(about).not.toContain("boxShadow");
  });
});

describe("the dialog scrim", () => {
  it("dims with black, not with the text colour that is light on a dark theme", async () => {
    const shell = await Bun.file(new URL("../src/components/tasks/TaskDialog.tsx", import.meta.url)).text();
    const code = shell.split("\n").filter((l) => !/^\s*(\*|\/\*|\/\/)/.test(l)).join("\n");
    expect(code).toContain('background: "rgba(0, 0, 0, 0.4)"');
    expect(code).not.toContain("var(--text) 32%");
  });
});

describe("Edit prompt before sending", () => {
  it("is a TaskDialog with Cancel and a primary Send to terminal", async () => {
    const src = await Bun.file(new URL("../src/components/PromptOptions.tsx", import.meta.url)).text();
    expect(src).toContain('<TaskDialog title="Edit prompt before sending"');
    expect(src).toContain("<Button onClick={() => setText(null)}>Cancel</Button>");
    expect(src).toContain('tone="primary"');
    expect(src).toContain("send({ prompt: text })");
    expect(src).not.toContain("agx-scrim");
  });
});
