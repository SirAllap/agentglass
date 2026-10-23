/*
 * The person's own actions in the finder, apart from drawing them: what the menu
 * shows for the ones that match, the words of the confirmation, and the editor's
 * form turned into the definition the server judges. The server holds every rule
 * about what an action may be and whether it may run (server/src/finderactions.ts);
 * nothing here is a check, only the shape the screen needs.
 */
import type { FinderAction } from "../../../shared/types.ts";
import type { Item } from "./finderOps.ts";

export const actionMenuLabel = (a: FinderAction): string => a.unavailable ? `${a.name} — ${a.unavailable}` : a.name;

const itemOf = (a: FinderAction): Item => ({ id: "action", label: a.name, action: a.id, disabled: !!a.unavailable });

/**
 * The group Strata puts between the opening commands and Cut/Copy: the actions set to
 * `top` stand in the menu, the rest sit under one "Actions" entry. Null when none matches.
 */
export function actionGroup(actions: readonly FinderAction[]): Item[] | null {
  if (!actions.length) return null;
  const top = actions.filter((a) => a.menu === "top").map(itemOf);
  const sub = actions.filter((a) => a.menu !== "top").map(itemOf);
  return [...top, ...(sub.length ? [{ id: "actions" as const, label: "Actions", sub }] : [])];
}

export function confirmWords(a: FinderAction, count: number): { title: string; body: string } {
  return { title: `Run ${a.name} on ${count} item${count === 1 ? "" : "s"}?`, body: "It is your own program and runs with your permissions." };
}

/** A name as an action id: lowercase letters, digits and single dashes. Empty when nothing is left. */
export const slugify = (name: string): string => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);

export const listText = {
  parse: (t: string): string[] => [...new Set(t.split(/[,\n]/).map((x) => x.trim().replace(/^\./, "").toLowerCase()).filter(Boolean))],
  show: (l: readonly string[]): string => l.join(", "),
};

/** The editor's loose fields (text boxes), kept apart from the definition they build. */
export interface ActionForm { id: string; kinds: "both" | "file" | "folder"; extensions: string; mime: string; maxItems: string }

export function blankAction(): FinderAction {
  return {
    schema_version: 1, id: "", name: "", description: "", icon: "play", enabled: true, menu: "submenu",
    when: { kinds: [], extensions: [], mime_types: [], min_items: 1, max_items: null },
    run: { runtime: "python", entrypoint: "action.py", program: "", args: [], mode: "whole-selection", on_error: "continue", working_directory: "parent", confirm: false },
  };
}

export const formOf = (a: FinderAction): ActionForm => ({
  id: a.id, kinds: a.when.kinds.length === 1 ? a.when.kinds[0]! : "both",
  extensions: listText.show(a.when.extensions), mime: listText.show(a.when.mime_types), maxItems: a.when.max_items === null ? "" : String(a.when.max_items),
});

/** The definition the form describes. The id is the name's slug unless one is already fixed; the server refuses what does not hold. */
export function fromForm(a: FinderAction, f: ActionForm): FinderAction {
  const max = f.maxItems.trim() === "" ? null : Number(f.maxItems);
  return {
    ...a, id: f.id || slugify(a.name),
    when: {
      ...a.when, kinds: f.kinds === "both" ? [] : [f.kinds],
      extensions: listText.parse(f.extensions), mime_types: listText.parse(f.mime).map((m) => m.replace(/^\./, "")),
      max_items: max !== null && Number.isFinite(max) ? max : null,
    },
  };
}

/** What an action shows for, in a line. */
export function whenSummary(a: FinderAction): string {
  const w = a.when;
  const kind = w.kinds.length === 1 ? (w.kinds[0] === "file" ? "Files" : "Folders") : "";
  const kinds = [kind, w.extensions.length ? w.extensions.map((e) => `.${e}`).join(" ") : "", w.mime_types.join(" ")].filter(Boolean);
  return kinds.length ? kinds.join(" · ") : "Any file or folder";
}
