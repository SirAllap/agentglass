import { describe, expect, it } from "bun:test";

/*
 * The bar's own parser, and the line it writes back.
 *
 * The server decides what a write means; this one only has to be honest about
 * what it is about to say, because it is what the user reads before pressing
 * Enter. If the two ever disagree the strip becomes a lie, so the cases that
 * matter are pinned on both sides — this file for the client, tasks-write for
 * the server.
 */
const mod = { __test: await import("../src/lib/taskGrammar.ts") };

describe("what the bar says it will do", () => {
  it("round-trips a task through the line and back to the same fields", () => {
    // `e` is only an edit rather than a retype if the line it produces parses
    // to the task it came from.
    const t = {
      uuid: "u", description: "fix the login redirect", status: "pending" as const,
      project: "web", priority: "H" as const, tags: ["auth", "urgent"],
      due: "2026-08-09", created: null, completed: null, urgency: 0, notes: [], urls: [],
    };
    const line = mod.__test.toLine(t);
    expect(line).toContain("fix the login redirect");
    const back = mod.__test.parseLocal(line);
    expect(back.description).toBe(t.description);
    expect(back.priority).toBe("H");
    expect(back.tags).toEqual(["auth", "urgent"]);
    expect(back.project).toBe("web");
    expect(back.due).toBe("2026-08-09");
  });

  it("leaves a token it will not take in the description, where it is visible", () => {
    // Eating it is the trap: the user types something, it disappears, and the
    // app has silently decided what they meant.
    const p = mod.__test.parseLocal("write about C++ and +$(id) and @../../etc");
    expect(p.tags).toEqual([]);
    expect(p.project).toBe(null);
    expect(p.description).toContain("$(id)");
  });

  it("keeps an accented tag whole", () => {
    expect(mod.__test.parseLocal("algo +revisión").tags).toEqual(["revisión"]);
  });

  it("puts a task with nothing in the sorted field last, not first", () => {
    // An absent due date is not "very soon".
    const mk = (uuid: string, due: string | null) => ({
      uuid, description: uuid, status: "pending" as const, project: null, priority: null,
      tags: [], due, created: null, completed: null, urgency: 0, notes: [], urls: [],
    });
    const out = mod.__test.sortTasks([mk("none", null), mk("late", "2026-12-01"), mk("soon", "2026-08-05")], "due");
    expect(out.map((t) => t.uuid)).toEqual(["soon", "late", "none"]);
  });
});

describe("moving the selection", () => {
  const { step } = mod.__test;

  it("lands on an end from nothing, rather than one step into the list", () => {
    // The bug this was extracted for: `j` on a freshly opened list selected row
    // 1, and row 0 could not be reached without arrowing back up.
    expect(step(-1, 1, 3)).toBe(0);
    expect(step(-1, -1, 3)).toBe(2);
  });

  it("stops at both ends instead of wrapping", () => {
    expect(step(0, -1, 3)).toBe(0);
    expect(step(2, 1, 3)).toBe(2);
  });

  it("moves one row at a time from wherever it is", () => {
    expect(step(0, 1, 3)).toBe(1);
    expect(step(2, -1, 3)).toBe(1);
  });

  it("has nowhere to go in an empty list, and says so rather than picking row 0", () => {
    expect(step(-1, 1, 0)).toBe(-1);
    expect(step(-1, -1, 0)).toBe(-1);
  });
});

describe("checklists in a note", () => {
  const { checkbox, toggleCheckbox, checkProgress } = mod.__test;

  it("reads the spelling the editor writes, not markdown's", () => {
    // These notes already exist in the store. A reader that only knew `- [ ]`
    // would render every one of them as prose.
    expect(checkbox("() call the bank")).toEqual({ checked: false, label: "call the bank" });
    expect(checkbox("(x) call the bank")).toEqual({ checked: true, label: "call the bank" });
    expect(checkbox("( ) with a space")).toEqual({ checked: false, label: "with a space" });
    expect(checkbox("- () with a bullet")).toEqual({ checked: false, label: "with a bullet" });
    expect(checkbox("  (X) indented and shouting")).toEqual({ checked: true, label: "indented and shouting" });
  });

  it("leaves prose alone", () => {
    for (const line of ["just a sentence", "(not a box) really", "()", "- a plain bullet", ""]) {
      expect(checkbox(line), line).toBe(null);
    }
  });

  it("flips one line and hands back the whole note", () => {
    // The caller replaces the note wholesale, so returning the line alone would
    // push the reassembly — and the chance of losing the rest — to the caller.
    const note = "shopping\n() bread\n(x) milk\nnot a box";
    expect(toggleCheckbox(note, 1)).toBe("shopping\n(x) bread\n(x) milk\nnot a box");
    expect(toggleCheckbox(note, 2)).toBe("shopping\n() bread\n() milk\nnot a box");
  });

  it("writes unchecked back as the editor spells it", () => {
    // `()`, not `( )`: a toggle must not restyle a note that a synced store
    // would then show as changed.
    expect(toggleCheckbox("( ) spaced", 0)).toBe("(x) spaced");
    expect(toggleCheckbox("(x) spaced", 0)).toBe("() spaced");
  });

  it("keeps the bullet and the indent it found", () => {
    expect(toggleCheckbox("  - () nested", 0)).toBe("  - (x) nested");
  });

  it("refuses a line that is not a checkbox, so a stray click writes nothing", () => {
    expect(toggleCheckbox("shopping\n() bread", 0)).toBe(null);
    expect(toggleCheckbox("() bread", 9)).toBe(null);
  });

  it("counts across every note on the task", () => {
    expect(checkProgress(["() a\n(x) b", "prose", "(x) c"])).toEqual({ done: 2, total: 3 });
    expect(checkProgress(["nothing here"])).toEqual({ done: 0, total: 0 });
  });
});

describe("which checkout a task is about", () => {
  const { rootForTask, taskPrompt } = mod.__test;
  const repos = [{ root: "/home/u/code/orbit", name: "orbit" }, { root: "/home/u/code/atlas", name: "atlas" }];

  it("takes the repo the project names", () => {
    expect(rootForTask("atlas", repos, "/fallback")).toBe("/home/u/code/atlas");
    expect(rootForTask("Atlas", repos, "/fallback")).toBe("/home/u/code/atlas");
  });

  it("reads the last segment of a dotted project, which is how a hierarchy is spelled", () => {
    expect(rootForTask("work.atlas", repos, "/fallback")).toBe("/home/u/code/atlas");
  });

  it("falls back to where the panel already is", () => {
    expect(rootForTask("nothing-like-it", repos, "/fallback")).toBe("/fallback");
    expect(rootForTask(null, repos, "/fallback")).toBe("/fallback");
  });

  it("says nowhere rather than picking a directory to be going on with", () => {
    expect(rootForTask(null, [], null)).toBe(null);
    expect(rootForTask("atlas", [], "")).toBe(null);
  });

  it("seeds a prompt from the task as written, and asks for nothing", () => {
    const p = taskPrompt({
      description: "the login redirect loops", project: "atlas", tags: ["auth", "web"],
      notes: ["happens only with SSO", "  "],
    });
    expect(p).toContain("the login redirect loops");
    expect(p).toContain("project: atlas");
    expect(p).toContain("tags: auth, web");
    expect(p).toContain("happens only with SSO");
    // No instruction: this lands in a composer that has not been sent.
    expect(p.toLowerCase()).not.toContain("please");
    expect(p.toLowerCase()).not.toContain("fix this");
  });

  it("is just the description when there is nothing else", () => {
    expect(taskPrompt({ description: "buy milk", project: null, tags: [], notes: [] })).toBe("buy milk");
  });
});

describe("two identical checklist lines", () => {
  const { toggleCheckbox, checkProgress } = mod.__test;

  it("toggle independently, because the line is addressed by index", () => {
    // The hazard the plan called out: `task denotate` matches by SUBSTRING, so
    // anything that identified a line by its text would flip whichever copy it
    // found first — and a list with "() review" twice is an ordinary list.
    const note = "() review\n() review";
    expect(toggleCheckbox(note, 0)).toBe("(x) review\n() review");
    expect(toggleCheckbox(note, 1)).toBe("() review\n(x) review");
  });

  it("counts both", () => {
    expect(checkProgress(["(x) review\n() review"])).toEqual({ done: 1, total: 2 });
  });
});

describe("the line a mouse click writes", () => {
  const { lineWith, inUse } = mod.__test;
  const t = {
    uuid: "u", description: "fix the redirect", status: "pending" as const,
    project: "web", priority: "M" as const, tags: ["auth", "urgent"],
    due: "2026-08-09", created: null, completed: null, urgency: 1, notes: [], urls: [],
  };

  it("changes one field and keeps every other", () => {
    // The whole point: `edit` clears what the line leaves out, so a patch that
    // rebuilt only part of the line would silently drop the rest.
    const line = lineWith(t, { priority: "H" });
    expect(line).toContain("fix the redirect");
    expect(line).toContain("!h");
    expect(line).toContain("@web");
    expect(line).toContain("+auth");
    expect(line).toContain("+urgent");
    expect(line).toContain("due:2026-08-09");
  });

  it("clears a field by leaving it out, which is what the verb means", () => {
    expect(lineWith(t, { priority: null })).not.toContain("!");
    expect(lineWith(t, { due: null })).not.toContain("due:");
    expect(lineWith(t, { project: null })).not.toContain("@");
    expect(lineWith(t, { tags: [] })).not.toContain("+");
  });

  it("round-trips through the parser it will be handed to", () => {
    const back = mod.__test.parseLocal(lineWith(t, { priority: "L" }));
    expect(back.description).toBe("fix the redirect");
    expect(back.priority).toBe("L");
    expect(back.project).toBe("web");
    expect(back.tags.sort()).toEqual(["auth", "urgent"]);
    expect(back.due).toBe("2026-08-09");
  });

  it("collects the projects and tags already in use, once each and sorted", () => {
    // Offered rather than typed again, because retyping is how `@web` and
    // `@Web` become two projects.
    const got = inUse([t, { ...t, project: "api", tags: ["auth"] }, { ...t, project: null, tags: [] }]);
    expect(got.projects).toEqual(["api", "web"]);
    expect(got.tags).toEqual(["auth", "urgent"]);
  });
});

describe("keys meant for a text field", () => {
  const { typingInto } = mod.__test;

  it("recognises everything a person types into", () => {
    for (const tagName of ["INPUT", "TEXTAREA", "SELECT", "input", "textarea"]) {
      expect(typingInto({ tagName }), tagName).toBe(true);
    }
    expect(typingInto({ tagName: "DIV", isContentEditable: true })).toBe(true);
  });

  it("leaves the list itself alone, which is where the shortcuts belong", () => {
    for (const tagName of ["DIV", "BUTTON", "SPAN", "KBD"]) {
      expect(typingInto({ tagName }), tagName).toBe(false);
    }
    expect(typingInto(null)).toBe(false);
    expect(typingInto(undefined)).toBe(false);
  });
});
