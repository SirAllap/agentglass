import type { ReactNode } from "react";
import type { Field } from "../../lib/pluginTypes.ts";
import { ContextDietPreview, JevInboxPreview, LocalReviewPreview } from "./previews/index.ts";
import { capLabel, type JevMode } from "./previews/logic.ts";

const num = (v: unknown, d: number): number => (typeof v === "number" && Number.isFinite(v) ? v : d);
const JEV_MODES: readonly string[] = ["off", "shadow", "live"];

/**
 * The preview a plugin's settings page carries, drawn from the values the page
 * holds right now (the manifest's own keys and defaults). A plugin with no
 * picture here gets the plain page. A secret is never read: only whether one is
 * set.
 */
export function pluginPreview(name: string, values: Record<string, unknown>, secretsSet: readonly string[], fields: readonly Field[]): { title: string; node: ReactNode } | null {
  switch (name) {
    case "jev-inbox": {
      const mode = typeof values.mode === "string" && JEV_MODES.includes(values.mode) ? (values.mode as JevMode) : "off";
      return { title: "The Inbox, scored", node: <JevInboxPreview hasKey={secretsSet.includes("apiKey")} consent={values.consent === true} mode={mode}
        threshold={num(values.threshold, 0.75)} sendRepo={values.includeRepo === true} maxTitle={num(values.maxTitle, 200)} /> };
    }
    case "context-diet":
      // The tally always counts what subagents re-read: no setting for it.
      return { title: "The context ledger", node: <ContextDietPreview cap={capLabel(num(values.cap, 200_000))} countSubagents windowDays={num(values.windowDays, 30) <= 7 ? 7 : 30} /> };
    case "local-review": {
      const agent = typeof values.agent === "string" ? values.agent : "claude";
      const label = fields.find((f) => f.key === "agent")?.options?.find((o) => o.value === agent)?.label ?? agent;
      const model = typeof values.model === "string" && values.model.trim() ? values.model.trim() : "default model";
      return { title: "A local review", node: <LocalReviewPreview agent={label} model={model} capUsd={num(values.maxUsdPerReview, 2)} /> };
    }
    default:
      return null;
  }
}
