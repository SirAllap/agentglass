import { useState } from "react";
import { RefreshIcon, InfoIcon, ArrowIcon } from "../../../lib/glyphIcons.tsx";
import { externalUrl } from "../../../lib/externalUrl.ts";
import { HIT, ICON } from "../../../lib/iconSize.ts";
import { TaskDialog } from "../../tasks/TaskDialog.tsx";
import { Button } from "../../workspace/Chrome.tsx";
import { ListIconBtn, IconLink } from "./ListControls.tsx";
import type { JiraListModel } from "./model.ts";
import { breadcrumbOf } from "./toolbarModel.ts";

/** The top bar: where the board is, its sprint, the brief, how fresh the read is, and the two ways out. Where a card opens is the panel's own choice (its chrome), not this bar's. */
export interface JiraToolbarProps {
  model: JiraListModel;
  onRefresh: () => void;
  /** The open tab's name: the title when no folder path names the board. */
  title?: string;
  /** The open epic (its key) or the sprint (`@sprints`); an epic's name joins the breadcrumb and the sprint badge steps aside. */
  areaId?: string | null;
}

/** The folder parts give way first (shrink 1000 to 1) so the board name stays whole; each part carries its full text as the tooltip. */
function Crumb({ parts }: { parts: string[] }) {
  return (
    <div className="flex items-center min-w-0" style={{ gap: 4, fontSize: 11, color: "var(--text4)", maxWidth: 520 }} data-testid="jira-crumb">
      {parts.map((p, i) => {
        const last = i === parts.length - 1;
        return (
          <span key={`${p}-${i}`} className="flex items-center min-w-0" style={{ gap: 4, flex: last ? "0 1 auto" : "0 1000 auto", minWidth: last ? 0 : 24 }}>
            {i > 0 && <span aria-hidden style={{ opacity: 0.7 }}>/</span>}
            <span className="truncate min-w-0" data-tip={p}
              style={last ? { fontSize: 15, fontWeight: 600, color: "var(--text)" } : undefined}>{p}</span>
          </span>
        );
      })}
    </div>
  );
}

export function JiraToolbar({ model, onRefresh, areaId, title }: JiraToolbarProps) {
  const [about, setAbout] = useState(false);
  const epic = areaId && !areaId.startsWith("@") ? model.epics.find((e) => e.key === areaId)?.name ?? areaId : null;
  const parts = [...breadcrumbOf(model.place), ...(epic ? [epic] : [])];
  /* A named tab is what is open: its name is the title, not the board the sidebar row came from. */
  const crumb = title && !epic ? [title] : parts.length ? parts : [model.view?.name ?? "Jira"];
  const href = externalUrl(model.address);

  return (
    <div data-slot="toolbar" className="flex items-center shrink-0" style={{ gap: 8, padding: "12px 24px 0" }}>
      <Crumb parts={crumb} />
      {!!model.description?.trim() && (
        <ListIconBtn label="About this board" tip="About this board - the brief, the docs, the team" onClick={() => setAbout(true)} size={HIT}>
          <InfoIcon size={ICON.sm} />
        </ListIconBtn>
      )}
      <span className="flex-1" />
      <ListIconBtn label="Read this board again" tip={model.view?.name ? `Read ${model.view.name} again now - no other board is touched` : "Read this board again now"}
        edge onClick={onRefresh} disabled={model.refreshing}>
        <RefreshIcon size={ICON.md} className={model.refreshing ? "agx-turn" : undefined} />
      </ListIconBtn>
      {href && (
        <IconLink label="Open in Jira" tip={`Open ${model.view?.name ?? "this board"} in Jira`} href={href} edge>
          <ArrowIcon size={ICON.md} />
        </IconLink>
      )}
      {about && (
        <TaskDialog title={`About ${model.view?.name ?? "this board"}`} width={560} onClose={() => setAbout(false)}
          footer={<Button onClick={() => setAbout(false)}>Close</Button>}>
          <div className="text-[12px] whitespace-pre-wrap" style={{ color: "var(--text2)" }}>{model.description}</div>
        </TaskDialog>
      )}
    </div>
  );
}
