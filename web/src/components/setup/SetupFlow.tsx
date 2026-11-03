/*
 * The first run: a rail, a body, a footer.
 *
 * The frame every step plugs into. Steps 4-5 are built later, so they draw
 * their title and a line saying so; the frame, the step list and the footer
 * are already the ones those slices need. The pick writes `setup.agent` and the
 * first Continue writes `setup.inProgress`, so a reload resumes at step 1;
 * Finish and Skip are the only doors out, and both write `setup.done` there.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { EnginesReport, SetupState } from "../../../../shared/types.ts";
import { ICON } from "../../lib/iconSize.ts";
import { api, SERVER } from "../../lib/api.ts";
import { markAnswered } from "../../lib/projectPick.ts";
import { readSetupState } from "../../lib/setupState.ts";
import { desktopPaletteName, themeMode } from "../../lib/themes.ts";
import { setting } from "../../lib/settingsRegistry.ts";
import { notePickedAgent } from "../../lib/newWindow.ts";
import { shellNotices } from "../../lib/desktop.ts";
import { openSettings } from "../../lib/openSettings.ts";
import {
  apiPortOf, dismissPortNotice, noticePorts, portNotice, readDismissedPort,
} from "../../lib/setupNotices.ts";
import { PortNoticeBar } from "./SetupNotices.tsx";
import { AgentStep } from "./AgentStep.tsx";
import { ThemeStep } from "./ThemeStep.tsx";
import { ToolsStep } from "./ToolsStep.tsx";
import { ReposStep, type ReposFrame } from "./ReposStep.tsx";
import { ProjectFinder } from "./ProjectFinder.tsx";
import { FirstWorkStep, type FirstWorkFrame } from "./FirstWorkStep.tsx";
import { addedRoots, skipAction } from "../../lib/setupRepos.ts";

export interface SetupStep {
  id: "agent" | "theme" | "tools" | "repos" | "first";
  title: string;
  sub: string;
}

/** The five steps, in the order the rail and the reading order draw them. */
export const SETUP_STEPS: readonly SetupStep[] = [
  { id: "agent", title: "Your agent", sub: "One CLI to start" },
  { id: "theme", title: "Theme", sub: "How it looks" },
  { id: "tools", title: "Tools", sub: "What this machine has" },
  { id: "repos", title: "Repositories", sub: "Bring your code in" },
  { id: "first", title: "First terminal", sub: "Start working" },
];

/** What the footer's left button says, per step: the mock's own words. */
export function skipLabel(step: number): string {
  if (step === 0) return "Skip setup";
  if (step === SETUP_STEPS.length - 1) return "Not now";
  return "Skip for now";
}

export function SetupFlow({ state, onDone }: {
  state: SetupState;
  /** `note` is what the app says once the wizard is gone; `finished` is Finish,
   *  not Skip, which is what offers the tutorial. */
  onDone: (note: string, finished: boolean) => void;
}) {
  const [step, setStep] = useState(0);
  const [agent, setAgent] = useState(state.setupAgent);
  const [mode, setMode] = useState(() => themeMode());
  const [theme, setTheme] = useState(() => document.documentElement.getAttribute("data-theme") || "");
  const [desk] = useState(() => desktopPaletteName());
  const [report, setReport] = useState<EnginesReport | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  /** Step 3 counts what needs the person; the footer reads it, as the mock does. */
  const [needs, setNeeds] = useState(0);
  /** Step 4's own tally and whether Continue would do anything. */
  const [repos, setRepos] = useState<ReposFrame>({ tally: null, blocked: true });
  /** The Finder replaces the window; the ticks outlive it, so `←`/`×` keep them. */
  const [finder, setFinder] = useState(false);
  const [scanTicked, setScanTicked] = useState<string[]>([]);
  /** What is already open, so the Finder adds rather than replaces. */
  const [open, setOpen] = useState<string[]>([]);
  /** The last step's own frame: its tally and the words on the primary. */
  const [first, setFirst] = useState<FirstWorkFrame | null>(null);
  /** Continue asks the step for its one write, if it has one. */
  const commit = useRef<(() => Promise<boolean>) | null>(null);
  /** The window itself: the two ports and the display, read once at the frame. */
  const [shell] = useState(shellNotices);
  const [ports] = useState(() => noticePorts(shell, apiPortOf(SERVER)));
  const [dismissed, setDismissed] = useState(readDismissedPort);
  const notice = portNotice(ports, dismissed);

  useEffect(() => {
    let live = true;
    void api.engines().then((r) => { if (live) { setReport(r); setFailed(false); } })
      .catch(() => { if (live) setFailed(true); });
    void api.projects().then((r) => { if (live) setOpen(r.workspaces ?? []); })
      .catch(() => { /* nothing open is fine */ });
    return () => { live = false; };
  }, []);

  const recheck = useCallback(() => {
    setBusy(true);
    void api.engines(true).then((r) => { setReport(r); setFailed(false); })
      .catch(() => setFailed(true))
      .finally(() => setBusy(false));
  }, []);

  const pickAgent = (id: string) => {
    setAgent(id);
    notePickedAgent(id);
    // The pick IS the app's default agent, so it is written at the click.
    void api.settingsDoorSet("setup.agent", id).catch(() => {});
  };

  const pickMode = (id: "system" | "light" | "dark") => {
    setting("appearance.mode").set(id);
    setMode(themeMode());
    setTheme(document.documentElement.getAttribute("data-theme") || "");
  };
  const pickTheme = (id: string) => {
    setting("appearance.theme").set(id);
    setMode(themeMode());
    setTheme(id);
  };

  const finish = (finished: boolean) => {
    // The one place `setup.done` is written: Finish and Skip, at the keypress.
    // The run closes here too, or Settings ▸ Onboarding reads it as open for ever.
    void api.settingsDoorSet("setup.done", true).catch(() => {});
    void api.settingsDoorSet("setup.inProgress", false).catch(() => {});
    markAnswered();
    onDone(finished ? "Setup finished" : "Setup skipped", finished);
  };

  const next = async () => {
    if (commit.current) {
      const ok = await commit.current();
      if (!ok) return;
    }
    if (step === 0) void api.settingsDoorSet("setup.inProgress", true).catch(() => {});
    if (step === SETUP_STEPS.length - 1) { finish(true); return; }
    setStep((n) => Math.min(n + 1, SETUP_STEPS.length - 1));
  };

  const skip = () => {
    // `Skip for now` on a middle step leaves the setup open, so a reload resumes it.
    if (skipAction(step, SETUP_STEPS.length - 1) === "advance") { void next(); return; }
    finish(false);
  };

  // Ctrl+Enter presses the step's own primary. Esc is not a skip: with no sheet
  // open it does nothing, which is what today's app already does.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (finder) return;
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); void next(); }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });

  // The Finder is a mode of the window, not a sheet: it has the whole body and
  // its own footer, and the wizard is what is behind it.
  if (finder) {
    return (
      <ProjectFinder
        homedir={state.homedir}
        ticked={scanTicked}
        onTicked={setScanTicked}
        onBack={() => setFinder(false)}
        onAdd={async (roots) => {
          try {
            const r = await api.setWorkspaces(addedRoots(open, roots));
            if (!r.ok) return r.error || "The server did not take those repositories.";
            setOpen(addedRoots(open, roots));
            setFinder(false);
            setStep(4);
            return null;
          } catch (e) {
            return String(e);
          }
        }}
      />
    );
  }

  const tallyNow = step === 2
    ? <><b>{needs}</b> needed</>
    : step === 3 && repos.tally
      ? <><b>{repos.tally.n}</b> of {repos.tally.of} {repos.tally.of === 1 ? "repository" : "repositories"}</>
      : step === 4 && first?.tally != null
        ? <><b>{first.tally}</b> {first.tally === 1 ? "project" : "projects"} ready</>
        : <><b>{step + 1}</b> of {SETUP_STEPS.length}</>;
  const primary = step === 4 && first ? first.primary : "Continue";
  const blocked = step === 3 ? repos.blocked : step === 4 ? (first?.blocked ?? true) : false;

  return (
    <div className="setup-shell">
      <aside className="setup-rail" aria-label="Setup steps">
        <div className="setup-brand">
          <span className="setup-brand-drop"><Spark /></span>
          <span>
            <span className="setup-brand-name">agentglass</span>
            <span className="setup-brand-sub">First run</span>
          </span>
        </div>
        <ol className="setup-steps">
          {SETUP_STEPS.map((s, i) => {
            const rowState = i < step ? "done" : i === step ? "current" : "next";
            return (
              <li className="setup-step" key={s.id} data-state={rowState} aria-current={i === step ? "step" : undefined}>
                <span className="setup-step-n" aria-hidden="true">{rowState === "done" ? <Check /> : i + 1}</span>
                <span className="setup-step-what">
                  <span>{s.title}</span>
                  <small>{s.sub}</small>
                </span>
              </li>
            );
          })}
        </ol>
        <div className="setup-rail-foot">
          Nothing here is permanent. Every step is in Settings, and you can come back to this list under{" "}
          <b>Get started</b>.
        </div>
      </aside>

      <div className="setup-main">
        <div className="setup-body">
          <div className="setup-inner">
            {step === 0 && notice && (
              <PortNoticeBar
                notice={notice}
                onOpenSettings={() => openSettings("remote")}
                onDismiss={() => { dismissPortNotice(notice.port); setDismissed(notice.dismissValue); }}
              />
            )}
            {step === 0 && (
              <AgentStep report={report} error={failed} picked={agent} busy={busy} display={shell.displayServer} onPick={pickAgent} onRecheck={recheck} />
            )}
            {step === 1 && (
              <ThemeStep mode={mode} theme={theme} desk={desk} onMode={pickMode} onTheme={pickTheme} />
            )}
            {step === 2 && <ToolsStep picked={agent} onNeeds={setNeeds} />}
            {step === 3 && <ReposStep onFrame={setRepos} onCommit={(fn) => { commit.current = fn; }} onSearch={() => setFinder(true)} />}
            {step === 4 && (
              <FirstWorkStep state={state} agent={agent} onFrame={setFirst} onCommit={(fn) => { commit.current = fn; }} onBack={() => setStep(3)} />
            )}
          </div>
        </div>
        <div className="setup-foot">
          <div className="setup-inner setup-foot-inner">
            <button type="button" className="setup-btn setup-btn-quiet" onClick={skip}>{skipLabel(step)}</button>
            <span className="setup-grow" />
            <span className="setup-tally">{tallyNow}</span>
            {step > 0 && <button type="button" className="setup-btn setup-btn-secondary" onClick={() => setStep((n) => Math.max(0, n - 1))}>Back</button>}
            <button type="button" className="setup-btn setup-btn-primary" onClick={() => void next()} disabled={blocked}>
              {primary} <span className="setup-kbd">Ctrl ↵</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Kept here so `readSetupState`'s answer is what the gate and the flow share. */
export const setupOf = readSetupState;

function Spark() {
  return (
    <svg width={ICON.xs} height={ICON.xs} viewBox="0 0 16 16" fill="none" stroke="currentColor"
      strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M8 1.8v3.4M8 10.8v3.4M1.8 8h3.4M10.8 8h3.4M3.7 3.7l2.4 2.4M9.9 9.9l2.4 2.4M12.3 3.7 9.9 6.1M6.1 9.9l-2.4 2.4" />
    </svg>
  );
}

function Check() {
  return (
    <svg width={ICON.xs} height={ICON.xs} viewBox="0 0 16 16" fill="none" stroke="currentColor"
      strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 8.5 6.2 11.7 13 4.9" />
    </svg>
  );
}
