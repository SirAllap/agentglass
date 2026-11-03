/*
 * THE LINE A SETTINGS BUTTON OWES WHEN IT OPENS SOMETHING OUTSIDE THE PAGE.
 *
 * A bench session is a window over every view, and from inside Settings it is
 * behind the modal. So a press that starts one has to say, in the row itself,
 * that it happened and where — and offer the one click that brings it to the
 * front. Three presses on a card that said nothing are what this closes.
 *
 * The session itself is the job's (benchJobs.ts): while one exists the row
 * shows this line, and the starter beside it is disabled or becomes "Open ·
 * Show it". Closing the tab ends the job, and the starter comes back.
 */
import { useSyncExternalStore } from "react";
import { Button } from "./workspace/Chrome.tsx";
import { TerminalIcon } from "../lib/glyphIcons.tsx";
import { ICON } from "../lib/iconSize.ts";
import { subscribeBench, type BenchTab } from "../lib/benchStore.ts";
import { rootOfTab, showBenchTab, tabForJob } from "../lib/benchJobs.ts";
import { closeSettings } from "../lib/openSettings.ts";

/** The tab this job has on this checkout, or null. Re-renders when the bench
 *  changes, so closing the tab brings the starter back without a reload.
 *  `claim` is the title the job gives its tab, so a session opened before jobs
 *  existed is seen too (benchJobs.ts). */
export function useBenchJob(root: string, job: string, claim?: string): BenchTab | null {
  /* The same snapshot on the server and on the client: this is one process's
     store, not a streamed tree, and a first frame that drew nothing while the
     session exists is the defect this line exists for. */
  const read = () => tabForJob(root, job, claim);
  return useSyncExternalStore(subscribeBench, read, read);
}

/** "Show it": the bench is behind Settings when a settings row asks for it, so
 *  the modal goes first. A no-op where Settings is not open. */
export function showBenchFromPage(id: string): void {
  closeSettings();
  showBenchTab(id);
}

/** The checkout's own name — the second half of "where it went". */
const projectName = (root: string): string => root.split("/").filter(Boolean).pop() ?? root;

/**
 * "Opened in the bench: Polaris setup · orbit  [Show it]"
 *
 * Drawn only while the job's session exists; nothing when it has not been
 * opened, so a row's `below` can carry it unconditionally.
 */
export function BenchJobLine({ root, job, what, claim }: { root: string; job: string; what: string; claim?: string }) {
  const tab = useBenchJob(root, job, claim);
  if (!tab) return null;
  const where = rootOfTab(tab.id) || root;
  return (
    <span role="status" data-bench-job={job} className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px]"
      style={{ color: "var(--text2)" }}>
      <span className="inline-flex items-center gap-1.5">
        <TerminalIcon size={ICON.sm} />
        Opened in the bench: <b style={{ color: "var(--text)" }}>{what}</b>
        {where && <span style={{ color: "var(--text3)" }}>· {projectName(where)}</span>}
      </span>
      <Button size="compact" data-tip="Brings the session to the front, over this page"
        onClick={() => showBenchFromPage(tab.id)}>Show it</Button>
    </span>
  );
}
