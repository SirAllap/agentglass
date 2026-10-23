import { FlowView } from "../../orchestration/FlowView.tsx";
import type { Policy, RuleFacts } from "../../../../../shared/orchestration.ts";
import type { EngineReadiness } from "../../../../../shared/types.ts";

export interface OrchestrationPreviewProps {
  /** The policy the page is editing, unsaved changes included. */
  policy: Policy;
  /** What the probe found; null draws the chains unjudged. */
  readiness: readonly EngineReadiness[] | null;
  /** The scope the picture is for: a project's folder, or "" for every project. */
  root: string;
  /** Engines whose plan has nothing left. */
  limited?: ReadonlySet<string>;
  /** What the rules read (usage, time); left out, no rule fires and the base chains show. */
  facts?: RuleFacts;
}

const NO_FACTS = { on: () => false };
const NOOP = () => {};

/** The real "Right now" flow, read-only: who does each job under the policy being edited. Built from the app's own FlowView, so it is a real component and not a drawing. */
export function OrchestrationPreview({ policy, readiness, root, limited, facts }: OrchestrationPreviewProps) {
  return (
    <div data-preview="orchestration" className="min-w-0 w-full">
      <FlowView policy={policy} facts={facts ?? NO_FACTS} readiness={readiness} root={root} liveModel={null} disabled limited={limited} onChange={NOOP} />
    </div>
  );
}
