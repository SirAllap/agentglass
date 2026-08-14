/*
 * What is on screen is what is marked.
 *
 * Three file lists in this app show a file before anybody has clicked one — the
 * Git panel's Changes, the pull-request Files tab, and the Diff view — because
 * a pane that opens empty is a pane that makes you click to find out it works.
 * All three did it the same way, with a `?? first` fallback where the diff is
 * rendered, and two of them compared the ROWS against the click state instead.
 *
 * So a diff sat on the right while every row on the left looked equally
 * unselected, and the file you were reading was indistinguishable from the
 * eleven you were not. Reported for both of them in one message.
 *
 * Held on the source: rendering these three lists needs a repository, a pull
 * request and a diff between them, and what actually broke is one expression in
 * each — the one that decides what the row compares itself to.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = join(import.meta.dir, "..", "src", "components");
const read = (f: string) => readFileSync(join(SRC, f), "utf8");

describe("the row that is being displayed", () => {
  it("is the one the Changes list marks", () => {
    const s = read("GitPanel.tsx");
    // `selected` carries the `?? all[0]` fallback; `selKey` is only what was
    // clicked, and starts null.
    expect(s).toContain("const activeKey = selected ? keyOf(selected) : null;");
    expect(s).toContain("active={activeKey === keyOf(c)}");
    expect(s).not.toContain("active={selKey === keyOf(c)}");
  });

  it("is the one the pull request's tree and file card mark", () => {
    const s = read("PrPanel.tsx");
    /* `showing` is the same expression the diff itself renders from — in
       one-file mode `sel ?? shownFiles[0]`. Marking against `sel` is what left
       the tree blank over a file that was on screen. */
    expect(s).toContain("node={buildFileTree(shownFiles)} sel={showing}");
    expect(s).toContain("const focused = showing === f.path;");
  });

  it("is the one the Diff view marks", () => {
    // This one was right from the start and is pinned so it stays that way:
    // the list is handed the healed selection, not the raw state.
    const s = read("diff/DiffPage.tsx");
    expect(s).toContain("selKey={selected?.key ?? null}");
  });
});
