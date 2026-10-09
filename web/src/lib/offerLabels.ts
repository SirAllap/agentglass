/*
 * What a held open is called on its chip: "Settings > Notifications",
 * "Insights", "the Git view". One entry per door that can be held, keyed by the
 * registry's ids, so a new `open` door with no words is a type error (the
 * doors marked `inPlace` are never held and have none). Only a validated
 * command reaches here, so an argument is already a member of its closed set.
 */
import { UI_ACTIONS, uiOf, type UiActionDef, type UiActionId, type UiArgs } from "../../../shared/uiActions.ts";
import type { ControlCmd } from "../../../shared/types.ts";

type OpenId = { [K in UiActionId]: (typeof UI_ACTIONS)[K]["kind"] extends "open" ? K : never }[UiActionId];
type InPlaceId = { [K in OpenId]: (typeof UI_ACTIONS)[K] extends { inPlace: true } ? K : never }[OpenId];
export type HoldableId = Exclude<OpenId, InPlaceId>;

const words = (slug: string): string => {
  const t = slug.replace(/[-_:]+/g, " ");
  return t.charAt(0).toUpperCase() + t.slice(1);
};
const base = (p: string): string => p.split("/").pop() || p;

type Labels = { [Id in HoldableId]: (a: UiArgs<Id>) => string };

export const OFFER_LABELS: Labels = {
  "view.open": (a) => `the ${words(a.to).toLowerCase()} view`,
  "workspace.toggle": () => "the workspace",
  "panel.open": (a) => `${words(a.what)}`,
  "finder.open": (a) => `the file finder on ${base(a.path)}`,
  "chat.new": () => "a new chat",
  "settings.open": (a) => `Settings > ${words(a.page)}${a.row ? ` > ${words(a.row)}` : ""}`,
  "machine.open": (a) => `Machine > ${words(a.tab)}`,
  "project.picker": () => "the project picker",
  "windows.switcher": () => "the window switcher",
  "bench.toggle": () => "the bench",
  "bench.file": (a) => `${base(a.path)} on the bench`,
  "bench.board": (a) => `the ${a.kind} board on the bench`,
  "peek.file": (a) => base(a.path),
  "git.modal": (a) => `Git > ${words(a.which)}`,
  "git.compare": (a) => `Git > Compare with ${a.base}`,
  "git.blame": (a) => `Git > Blame ${base(a.path)}`,
  "git.rebase": (a) => `Git > Rebase from ${a.base}`,
  "event.open": () => "an event",
  "session.open": () => "a session",
  "whatsnew.open": () => "what's new",
  "lantern.schedule": () => "Lantern > Schedule",
  "terminal.resume": () => "Terminal > Resume sessions",
  "settings.plugin": (a) => `Settings > ${words(a.name)}`,
  "pane.open": (a) => `the ${a.which} of the focused terminal`,
};

/** The registry entry of a command, or null when it names no door. */
export function defOf(cmd: ControlCmd): { id: UiActionId; def: UiActionDef; cmd: NonNullable<ReturnType<typeof uiOf>> } | null {
  const u = uiOf(cmd as { cmd: string } & Record<string, unknown>);
  return u ? { id: u.do, def: UI_ACTIONS[u.do] as UiActionDef, cmd: u } : null;
}

/** The words for a command's chip, or null when it is not a holdable door. */
export function labelOf(cmd: ControlCmd): string | null {
  const d = defOf(cmd);
  if (!d || !Object.prototype.hasOwnProperty.call(OFFER_LABELS, d.id)) return null;
  return (OFFER_LABELS[d.id as HoldableId] as (a: unknown) => string)(d.cmd.args);
}
