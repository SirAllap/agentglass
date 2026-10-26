import type { LaunchMode } from "../../../shared/launchModes.ts";

/** What the "⋯" menu on a prompt row changes for ONE run; absent fields are the person's settings. */
export type SendOpts = {
  /** An engine id of shared/agentKinds.ts. */
  kind?: string;
  mode?: LaunchMode;
  /** The prompt text as edited, sent instead of the prompt the row stands for. */
  prompt?: string;
};
