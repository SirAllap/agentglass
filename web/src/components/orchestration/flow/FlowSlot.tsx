/*
 * The Flow editor the page opens, and the flow's names for the policy roles the
 * page prints. The editor is a whole screen in a portal; when it closes the
 * page reads the policy again (`onPolicySaved`), so what the person shaped is
 * what the page shows.
 */
import { useEffect, useState } from "react";
import { FlowEditor } from "./FlowEditor.tsx";
import { useFlow } from "./useFlow.ts";
import type { Flow } from "../../../../../shared/flow.ts";

/** What the page hands the editor in `editBlock` to open a panel instead of a block. */
export const OPEN_CONDITIONS = "@conditions";
export const OPEN_PRESETS = "@presets";

export function FlowSlot({ root, projects, editReq, editBlock, onNames, onPolicySaved }: { root: string; projects: string[]; editReq?: number; editBlock?: string; onNames?: (n: Record<string, { name: string; does: string }>, flow: Flow | null) => void; onPolicySaved?: () => void }) {
  // A flow belongs to one project: All projects shows the first one the person has.
  const project = root || projects[0] || "";
  const { load, reload } = useFlow(project);
  const [open, setOpen] = useState(false);
  // The page names a picked block as the flow does; a rename in the editor arrives with the reload.
  const flow = load.state === "loaded" ? load.flow : null;
  useEffect(() => {
    const names: Record<string, { name: string; does: string }> = {};
    for (const r of flow?.roster ?? []) if (r.policyRole) names[r.policyRole] = { name: r.name, does: r.does };
    onNames?.(names, flow);
  }, [flow, onNames]);
  // "Open the Flow editor" asks the page for the editor: each press counts up.
  useEffect(() => { if (editReq) setOpen(true); }, [editReq]);
  return open ? <FlowEditor root={project} allProjects={!root} select={editBlock} projects={projects} onPolicySaved={onPolicySaved} onClose={() => { setOpen(false); reload(); onPolicySaved?.(); }} /> : null;
}
