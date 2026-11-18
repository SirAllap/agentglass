/*
 * useFavouriteImport (favourites -> real saved queries, with NO_FAVOURITES /
 * FAVOURITES_FAILED notes) had no production caller: TasksPanel still ran
 * the old useJiraFavourites path, which only lists favourites as virtual
 * rows and never writes them as saved queries until one is clicked.
 */
import { describe, expect, it } from "bun:test";

const src = await Bun.file(new URL("../src/components/TasksPanel.tsx", import.meta.url)).text();

describe("TasksPanel's Jira favourites sync", () => {
  it("imports favourites as real saved queries, not the old virtual-row path", () => {
    expect(src).toContain("useFavouriteImport(isJira && active && jiraSync, jiraSavedIds, () => {");
    expect(src).not.toContain("useJiraFavourites");
  });

  it("shows the import's note (NO_FAVOURITES / FAVOURITES_FAILED) in the footer", () => {
    expect(src).toContain("if (jiraFavNote) setNote({ ok: jiraFavNote !== FAVOURITES_FAILED, text: jiraFavNote });");
  });
});
