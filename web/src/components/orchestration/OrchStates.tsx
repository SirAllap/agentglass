/*
 * The page's own states, from mockup screen 6: nothing set up, a read that
 * failed, the save chip and the row a project following all projects gets.
 * They sit outside the page body because each replaces it, and the page would
 * otherwise carry four copies of the same shape.
 */
import { ProblemNote, StatusBadge } from "../SettingsKit.tsx";
import { Button, LINE } from "../workspace/Chrome.tsx";
import { LayersIcon } from "../settingsNavIcons.tsx";
import { ICON } from "../../lib/iconSize.ts";
import { PAGE_BTN_SM } from "./OrchKit.tsx";

/**
 * No project is open: the one thing that still works is setting it up for
 * every project, so that is the only press here. The mockup's block, word for
 * word: a bare glyph, the line, what to do, the press.
 */
export function NothingSetUp({ onStart }: { onStart: () => void }) {
  return (
    <div className="agx-orch" style={{ maxWidth: 620 }}>
      <div className="agx-orch-empty" data-nothing-set-up>
        <span aria-hidden className="agx-orch-empty-art"><LayersIcon size={ICON.md} /></span>
        <b>Nothing is set up yet</b>
        <p>Start from a preset or build a flow.</p>
        <Button tone="primary" onClick={onStart}>Set up for all projects</Button>
      </div>
    </div>
  );
}

/**
 * The setting did not load. The mockup's row: the mark, one sentence, the press
 * at the right end. What the server answered, and that nothing moved, sit under
 * the sentence rather than beside the button.
 */
export function LoadFailed({ name, error, retrying, onRetry }: {
  /** The project's folder name, or "all projects". */
  name: string;
  error: string;
  retrying: boolean;
  onRetry: () => void;
}) {
  return (
    <div className="agx-orch" style={{ maxWidth: 620 }}>
      <ProblemNote title={`Could not load the setting for ${name}.`}
        action={<Button tone="primary" pending={retrying} disabled={retrying} onClick={onRetry}>{retrying ? "Trying again\u2026" : "Retry"}</Button>}>
        <span>The server answered: <code className="t-mono" style={{ overflowWrap: "anywhere" }}>{error}</code>{" "}Nothing was changed. Your last saved setting is still in force.</span>
      </ProblemNote>
    </div>
  );
}

/**
 * What happened to the last save, in one chip: out, failed, dirty, or kept for
 * the scope on screen. The mockup's four chips, in the order they matter.
 */
export function SavedChip({ saving, failed, dirty, word }: {
  saving: boolean;
  /** The last save through this page was refused. */
  failed: boolean;
  dirty: boolean;
  /** Who the setting is kept for: "orbit", or "all projects". */
  word: string;
}) {
  return (
    <span role="status" aria-live="polite">
      {saving ? <StatusBadge tone="saving">{"Saving\u2026"}</StatusBadge>
        : failed ? <StatusBadge tone="err">{"Not saved \u00b7 try again"}</StatusBadge>
          : dirty ? <StatusBadge tone="warn">Permissions not saved</StatusBadge>
            : <StatusBadge tone="ok">Saved for {word}</StatusBadge>}
    </span>
  );
}

/**
 * A project that follows all projects. It says why the permission controls
 * below cannot be moved, and offers the one press that gives it its own copy.
 * The press is here as well as in the scope bar because a disabled switch with
 * no explanation beside it is the thing this row exists to prevent.
 */
export function InheritedNote({ name, busy, onMakeSpecific }: { name: string; busy: boolean; onMakeSpecific: () => void }) {
  return (
    <div data-inherited-note className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg px-3 py-2 mt-2"
      style={{ background: "color-mix(in srgb, var(--info) 10%, transparent)", border: LINE }}>
      <StatusBadge tone="info">Follows all projects</StatusBadge>
      {/* 14rem floor, the house row's: at 390 a zero basis let the sentence shrink to a sliver instead of pushing the press to its own line. */}
      <span className="min-w-0 flex-[1_1_14rem] text-[12px]" style={{ color: "var(--text2)" }}>
        {name} uses the general setting. Its permissions are read-only until it has one of its own.
      </span>
      <Button tone="primary" size="compact" disabled={busy} onClick={onMakeSpecific}>Make it specific to {name}</Button>
    </div>
  );
}

/**
 * A project with a setting of its own: the mockup's row over the title, and the
 * one press that sends it back to the general setting. It lives here rather
 * than in the scope bar because that is where the mockup puts it.
 */
export function SpecificNote({ name, busy, onGeneral }: { name: string; busy: boolean; onGeneral: () => void }) {
  return (
    <div data-specific-note className="agx-flow-banner" data-tone="plain">
      <span className="agx-flow-chip" data-tone="acc">{name} has its own settings</span>
      <span className="agx-flow-sp" />
      <Button style={PAGE_BTN_SM} disabled={busy} onClick={onGeneral}>Use the general setting</Button>
    </div>
  );
}
