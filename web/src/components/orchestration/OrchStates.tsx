/*
 * The page's own states, from mockup screen 6 (the words now name Workers and the next step): nothing set up and a read that
 * failed. Whose setting is on screen is the shared scope control's job.
 * They sit outside the page body because each replaces it, and the page would
 * otherwise carry four copies of the same shape.
 */
import { ProblemNote } from "../SettingsKit.tsx";
import { Button } from "../workspace/Chrome.tsx";
import { LayersIcon } from "../settingsNavIcons.tsx";
import { ICON } from "../../lib/iconSize.ts";

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
        <b>No workers are set up yet</b>
        <p>Start from a preset or build a flow. It sets how many workers run at once and what each one does.</p>
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
