// What this machine is doing: open ports, hungry processes, where the disk went,
// and which git locks are stuck.
//
// All of it has a perfectly good command-line answer already (`ss`, `top`, `du`),
// and asking any of them means leaving the app, finding a shell, and translating
// a pid back into "which of my six worktrees is that". The translation is the
// point. A port is only interesting once you know it is YOUR dev server in THAT
// checkout; a 700 MB process is only actionable once you know which branch owns it.
//
// One surface, reachable from the dashboard and from inside the workspace,
// because "is 5173 still up?" is a question you have while looking at anything.
// Nothing in it runs on a clock: see usePorts, Resources and Locks for what each
// tab listens to.
import { useEffect } from "react";
import { Portal } from "./Portal.tsx";
import { Button, Tabs } from "./workspace/Chrome.tsx";
import { CloseButton } from "./CloseButton.tsx";
import { api } from "../lib/api.ts";
import { publishMachineDisk, useLowDisk } from "../lib/diskClean.ts";
import { MACHINE_CSS } from "./machine/machineCss.ts";
import { Locks } from "./machine/Locks.tsx";
import { Ports } from "./machine/Ports.tsx";
import { Resources } from "./machine/Resources.tsx";
import { usePorts } from "./machine/usePorts.ts";

export type MachineTab = "ports" | "resources" | "locks";

/** One line per tab, under it: what the tab's buttons will and will not do. */
const FOOT: Record<MachineTab, React.ReactNode> = {
  ports: "Stopping a process asks it to quit (SIGTERM). You confirm each one first; nothing is removed.",
  resources: <><b>Safe</b> lines are things that come back by themselves, so removing them needs no sudo.</>,
  locks: "A lock is only listed as stuck when no live git holds it.",
};

export function MachinePanel({ tab, onTab, onClose, onOpenBrowser }: {
  tab: MachineTab;
  onTab: (t: MachineTab) => void;
  onClose: () => void;
  /** Switch to the built-in browser view, after a port has asked for it. Absent on surfaces that have no browser to switch to. */
  onOpenBrowser?: () => void;
}) {
  /* One quiet badge, on the tab that holds the disk numbers: no notification,
     nothing that repeats. It reads whatever the scan or the machine tile last saw. */
  const lowDisk = useLowDisk();
  // Once per open, on whichever tab it opens on: the badge has to be there before anyone visits Resources. Not a poll; Resources keeps it fresh after.
  useEffect(() => { api.machineResources(1).then((d) => publishMachineDisk(d.machine)).catch(() => {}); }, []);
  const ports = usePorts();
  const yours = ports.data?.ports.filter((p) => p.mine).length;
  return (
    // Above the workspace portal and above the file viewer: this opens from
    // inside the workspace as often as from the dashboard behind it, and a
    // panel that renders under the thing that opened it is not a panel.
    <Portal z={10050}>
      <style>{MACHINE_CSS}</style>
      <div className="fixed inset-0" style={{ zIndex: 1, background: "rgba(0,0,0,.6)" }} onClick={onClose} />
      <div role="dialog" aria-label="Machine" className="mc-mod">
        <div className="mc-h">
          <div className="mc-r1">
            <b>Machine</b><span>what this computer is doing, and what you can free</span>
            <span style={{ flex: 1 }} />
            <CloseButton onClick={onClose} title="Close (Esc)" />
          </div>
          {/* The shared `Tabs`: these swap the whole body, so they are a tab list to a screen reader, not loose buttons. */}
          <Tabs value={tab} onChange={onTab} label="Machine" panelId="machine-tab-body"
            options={[
              { id: "ports", label: <>Ports{yours != null && <span className="mc-tabn">{yours}</span>}</> },
              { id: "resources", title: lowDisk ?? undefined, label: <>Resources{lowDisk && <span className="mc-low" aria-label={lowDisk}>Low disk</span>}</> },
              { id: "locks", label: "Locks" },
            ]} />
        </div>
        <div className="mc-b">
          {/* Not a scroller itself: each tab owns its scrolling, because Resources pins a footer under one. */}
          <div id="machine-tab-body" role="tabpanel" className="flex-1 min-h-0 flex flex-col">
            {tab === "ports" ? <Ports ports={ports} onOpenBrowser={onOpenBrowser} /> : tab === "resources" ? <Resources /> : <Locks />}
          </div>
          <div className="mc-foot"><span className="why">{FOOT[tab]}</span><Button onClick={onClose}>Close</Button></div>
        </div>
      </div>
    </Portal>
  );
}
