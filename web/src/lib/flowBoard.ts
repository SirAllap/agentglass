/*
 * The Flow board: the same flow the canvas edits, laid out as columns. One
 * column per stage, in the order the path first reaches it; in each column the
 * roles of the path that belong to that stage, in path order. Pure, so the
 * layout is asserted without a renderer; the board only paints it and edits
 * through `flowEdit.ts`, the functions the canvas uses.
 *
 * Its ceiling, stated: a stage the path leaves and comes back to is one column,
 * so a card's place in the column says its step, not its neighbours on the
 * path. Moving a card to another stage is the worker editor's Stage field; a
 * drag between columns is the next thing after this and is not here. Roles off
 * the path stay in the team rail, as they do beside the canvas.
 */
import { roleById, type Flow, type FlowRole, type FlowStage } from "../../../shared/flow.ts";

export interface BoardCard {
  role: FlowRole;
  /** 1-based step on the path. */
  step: number;
}

export interface BoardColumn {
  stage: FlowStage;
  cards: BoardCard[];
}

/** The columns the board draws. A stage no path role sits in has no column; a role whose stage is gone gets one named by its id. */
export function boardColumns(flow: Flow): BoardColumn[] {
  const cols = new Map<string, BoardColumn>();
  flow.path.forEach((id, i) => {
    const role = roleById(flow, id);
    if (!role) return;
    let col = cols.get(role.stage);
    if (!col) {
      col = { stage: flow.stages.find((s) => s.id === role.stage) ?? { id: role.stage, label: role.stage }, cards: [] };
      cols.set(role.stage, col);
    }
    col.cards.push({ role, step: i + 1 });
  });
  return [...cols.values()];
}

/** Where one step earlier (-1) or later (+1) puts a role on the path, for `movePath`; null at either end or off the path. */
export function stepTarget(flow: Flow, id: string, dir: -1 | 1): number | null {
  const at = flow.path.indexOf(id);
  if (at < 0) return null;
  const to = at + dir;
  return to < 0 || to >= flow.path.length ? null : to;
}
