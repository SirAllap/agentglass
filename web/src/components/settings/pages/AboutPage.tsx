import { SettingsPage } from "../shell/SettingsPage.tsx";
import { Section } from "../shell/Section.tsx";
import { SettingRow } from "../shell/SettingRow.tsx";
import { Button } from "../../workspace/Chrome.tsx";
import { AboutPane, OnboardingMark, OpensSection } from "../../SettingsModal.tsx";
import { openTutorial, tourProgress } from "../../../lib/setupTutorial.ts";
import { tourNow } from "../../setup/Tutorial.tsx";
import { pickedAgent } from "../../../lib/newWindow.ts";
import { ChecksList } from "../../setup/ChecksStep.tsx";
import { runSetupAgain } from "../../../lib/setupState.ts";
import { ReportProblemRow } from "./ReportProblem.tsx";
import type { PageCtx } from "./ctx.ts";

/** System > About. Version, updates, release notes and the auto-check row are AboutPane's run-time rows; the setup and tutorial rows are rebuilt here. */
export function AboutSettingsPage({ c }: { c: PageCtx }) {
  const { onboarding, setPane, tutorialSeen } = c;
  const tour = tourProgress(tutorialSeen, tourNow());
  const setup: { label: string; help: string; done: boolean; go: "hooks" | "connections" | "tmux" }[] = onboarding ? [
    { label: "An agent is wired in", help: onboarding.hook ? "Claude Code is hooked into this app." : "Not yet. Claude Code is not wired in.", done: onboarding.hook, go: "hooks" },
    { label: "A provider is connected", help: onboarding.provider ? "At least one provider is connected." : "Not yet. Connect GitHub, GitLab, ClickUp or Taskwarrior.", done: onboarding.provider, go: "connections" },
    { label: "The pane engine is ready", help: onboarding.paneEngine ? "tmux is on your PATH and works." : "Not yet. tmux is not on your PATH.", done: onboarding.paneEngine, go: "tmux" },
  ] : [];
  return (
    <SettingsPage
      title="About"
      purpose="See which version runs, update it, and finish setting up."
      sections={[
        { id: "build", title: "This build", kind: "normal", body: <div data-section="build"><AboutPane open={c.open} /></div> },
        ...(setup.length ? [{
          id: "setup", title: "What is left to set up", kind: "normal" as const,
          body: (
            <Section id="setup" title="What is left to set up" intro="Three things, and then this goes away.">
              {setup.map((s) => (
                <SettingRow key={s.label} kind="link" label={`${s.label}${s.done ? " · done" : ""}`} help={s.help} linkText="Open" onOpen={() => setPane(s.go)} />
              ))}
            </Section>
          ),
        }] : []),
        {
          id: "checks", title: "Setup checks", kind: "normal",
          body: (
            <Section id="checks" title="Setup checks" intro="The last step of the setup assistant. A row that is red still needs you.">
              <ChecksList picked={pickedAgent()} />
            </Section>
          ),
        },
        {
          id: "tutorial", title: "Tutorial", kind: "normal",
          body: (
            <Section id="tutorial" title="Tutorial" intro="A short tour of the app. Skip it any time; it resumes where you stopped.">
              <SettingRow kind="control" label="Tutorial" help={tour.line}
                control={<span className="flex items-center gap-2">
                  <OnboardingMark done={tour.done} />
                  {!tour.done && <Button size="compact" onClick={() => openTutorial(tour.resumeAt)}>{tour.line === "Not started" ? "Start" : "Resume"}</Button>}
                  <Button size="compact" onClick={() => openTutorial(0)}>Start over</Button>
                </span>} />
              <SettingRow kind="control" label="Run the setup again" help="Brings the first-run wizard back at step 1."
                control={<Button size="compact" onClick={() => void runSetupAgain()}>Run it</Button>} />
            </Section>
          ),
        },
        {
          id: "report", title: "Report a problem", kind: "normal",
          body: <Section id="report" title="Report a problem" intro="Share what went wrong, on your terms."><ReportProblemRow /></Section>,
        },
        { id: "opens", title: "What you open", kind: "normal", body: <div data-section="opens"><OpensSection open={c.open} /></div> },
      ]}
    />
  );
}
