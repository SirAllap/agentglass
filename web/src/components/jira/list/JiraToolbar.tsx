import { useState } from "react";
import { RefreshIcon, InfoIcon, TargetIcon, ArrowIcon } from "../../../lib/glyphIcons.tsx";
import { externalUrl } from "../../../lib/externalUrl.ts";
import { ICON } from "../../../lib/iconSize.ts";
import { tipAttr } from "../../../lib/tip.ts";
import { sprintTotals, splitSprint } from "../../../lib/jiraBoardContext.ts";
import { setCardMode, useCardMode } from "../../../lib/jiraCardMode.ts";
import { SidebarIcon } from "../../settingsNavIcons.tsx";
import { TaskDialog } from "../../tasks/TaskDialog.tsx";
import { Button } from "../../workspace/Chrome.tsx";
import { ListIconBtn, IconLink } from "./ListControls.tsx";
import type { JiraListModel } from "./model.ts";
import { breadcrumbOf, readStamp, sprintChip } from "./toolbarModel.ts";

/** The top bar: where the board is, its sprint, the brief, where a card opens, how fresh the read is, and the two ways out. */
export interface JiraToolbarProps {
  model: JiraListModel;
  onRefresh: () => void;
  /** The open epic (its key) or the sprint (`@sprints`); an epic's name joins the breadcrumb and the sprint badge steps aside. */
  areaId?: string | null;
}

const OverIcon = () => (
  <svg width={ICON.sm} height={ICON.sm} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <rect x="3" y="4" width="18" height="16" rx="2" /><rect x="8" y="9" width="8" height="6" rx="1" />
  </svg>
);

/** Parts truncate (the board name last, and widest) and each carries its full text as the tooltip. */
function Crumb({ parts }: { parts: string[] }) {
  return (
    <div className="flex items-center min-w-0" style={{ gap: 4, fontSize: 11, color: "var(--text4)", maxWidth: 520 }} data-testid="jira-crumb">
      {parts.map((p, i) => {
        const last = i === parts.length - 1;
        return (
          <span key={`${p}-${i}`} className="flex items-center min-w-0" style={{ gap: 4, flex: last ? "0 1 auto" : "0 1 120px" }}>
            {i > 0 && <span aria-hidden style={{ opacity: 0.7 }}>/</span>}
            <span className="truncate min-w-0" data-tip={p}
              style={last ? { fontSize: 15, fontWeight: 600, color: "var(--text)" } : undefined}>{p}</span>
          </span>
        );
      })}
    </div>
  );
}

export function JiraToolbar({ model, onRefresh, areaId }: JiraToolbarProps) {
  const mode = useCardMode();
  const [about, setAbout] = useState(false);
  const epic = areaId && !areaId.startsWith("@") ? model.epics.find((e) => e.key === areaId)?.name ?? areaId : null;
  const parts = [...breadcrumbOf(model.place), ...(epic ? [epic] : [])];
  const crumb = parts.length ? parts : [model.view?.name ?? "Jira"];
  const sprint = model.sprint && !epic ? model.sprint : undefined;
  const totals = sprint ? sprintTotals(splitSprint(model.cards, sprint.name).inSprint, model.statuses) : undefined;
  const chip = sprint ? sprintChip(sprint, Date.now(), totals) : null;
  const href = externalUrl(model.address);
  const stamp = readStamp(model.at);

  return (
    <div data-slot="toolbar" className="flex items-center shrink-0" style={{ gap: 8, padding: "12px 24px 0" }}>
      <Crumb parts={crumb} />
      {chip && (
        <span className="inline-flex items-center shrink-0 tabular-nums whitespace-nowrap" data-testid="jira-sprint" data-tip={chip.tip}
          style={{
            height: 22, gap: 6, padding: "0 10px", borderRadius: 99, fontSize: 10.5, fontWeight: 500,
            color: chip.late ? "var(--warning-ink)" : "var(--info-ink)",
            background: `color-mix(in srgb, ${chip.late ? "var(--warning)" : "var(--info)"} 12%, transparent)`,
          }}>
          <TargetIcon size={ICON.xs} /> {chip.name}{chip.left && <span style={{ opacity: 0.85 }}>{chip.left}</span>}
        </span>
      )}
      {!!model.description?.trim() && (
        <ListIconBtn label="About this board" tip="About this board - the brief, the docs, the team" onClick={() => setAbout(true)} size={26}>
          <InfoIcon size={ICON.sm} />
        </ListIconBtn>
      )}
      <span className="flex-1" />
      <span role="group" aria-label="Where a card opens" className="inline-flex shrink-0" style={{ gap: 2, padding: 2, borderRadius: 9, background: "var(--surface-inset)" }}>
        {([["side", "Open a card beside the list", <SidebarIcon key="s" size={ICON.sm} />], ["modal", "Open a card over the list", <OverIcon key="m" />]] as const).map(([id, tip, icon]) => (
          <ListIconBtn key={id} label={tip} on={mode === id} onClick={() => setCardMode(id)} size={24}>{icon}</ListIconBtn>
        ))}
      </span>
      {stamp && (
        <span className="shrink-0 whitespace-nowrap" style={{ fontSize: 10.5, color: "var(--text4)" }}
          data-tip={tipAttr({ name: stamp, text: "It reads again when you come back to this window, never behind your back. Refresh forces it now." })}>
          {stamp}
          {model.read === "retrying" && <span style={{ color: "var(--text3)" }}> · retrying</span>}
          {model.refreshing && model.read !== "retrying" && <span className="animate-pulse" style={{ color: "var(--primary-ink)" }}> · refreshing</span>}
        </span>
      )}
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
