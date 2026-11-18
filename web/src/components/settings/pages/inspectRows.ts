// The read-only rows of the Inspect page, as data. Every one is a fact (label + value + Copy):
// no control, and raw JSON lives only here. Values are read through the settings door by id.

export interface InspectRow {
  /** The setting id the door reads. */
  id: string;
  label: string;
  /** One sentence, 14 words at most. */
  help: string;
  section: string;
}

export const INSPECT_SECTIONS = ["Launch", "First run", "Workers and spending", "Data on disk"] as const;

export const INSPECT_ROWS: readonly InspectRow[] = [
  { id: "launch.mode", label: "Permission mode agents launch in", help: "The mode a new agent starts in.", section: "Launch" },
  { id: "launch.deny", label: "Tools every launched agent is denied", help: "Tools no launched agent may use.", section: "Launch" },
  { id: "launch.flags.antigravity", label: "Antigravity launch flags per permission mode", help: "The flags this engine starts with, for each mode.", section: "Launch" },
  { id: "launch.flags.codex", label: "Codex launch flags per permission mode", help: "The flags this engine starts with, for each mode.", section: "Launch" },
  { id: "launch.flags.gemini", label: "Gemini launch flags per permission mode", help: "The flags this engine starts with, for each mode.", section: "Launch" },
  { id: "launch.flags.hermes", label: "Hermes launch flags per permission mode", help: "The flags this engine starts with, for each mode.", section: "Launch" },
  { id: "launch.flags.opencode", label: "OpenCode launch flags per permission mode", help: "The flags this engine starts with, for each mode.", section: "Launch" },
  { id: "launch.flags.qwen", label: "Qwen Code launch flags per permission mode", help: "The flags this engine starts with, for each mode.", section: "Launch" },

  { id: "setup.inProgress", label: "A setup run is open", help: "Whether the setup guide is running now.", section: "First run" },
  { id: "setup.done", label: "The first run is finished", help: "Whether you completed the first-run setup.", section: "First run" },
  { id: "setup.agent", label: "The agent a first terminal starts", help: "The agent the first terminal opens with.", section: "First run" },
  { id: "setup.tutorial", label: "Tutorial cards already read", help: "The tutorial cards you have already seen.", section: "First run" },

  { id: "orchestration.policy", label: "Orchestration policy", help: "The workers policy as the app stores it.", section: "Workers and spending" },
  { id: "orchestration.presets", label: "Presets", help: "The saved flow presets as the app stores them.", section: "Workers and spending" },
  { id: "workers.mcpServers.available", label: "MCP servers configured on this machine", help: "The tool servers a worker role could be given.", section: "Workers and spending" },
  { id: "budgets", label: "Spending limits", help: "The spending limits as the app stores them.", section: "Workers and spending" },

  { id: "privacy.retentionDays", label: "Retention", help: "How many days the app keeps history.", section: "Data on disk" },
  { id: "privacy.clickupCardDays", label: "ClickUp card cache", help: "How many days cached cards are kept.", section: "Data on disk" },
  { id: "privacy.ledgerStubDays", label: "Understudy ledger", help: "How many days ledger stubs are kept.", section: "Data on disk" },
  { id: "secrets.keyring", label: "Keep secrets in the system keyring", help: "Whether secrets live in the system keyring.", section: "Data on disk" },
];

/** What a stored value looks like as one line of text. Empty and missing both read "Not set". */
export function factText(v: unknown): string {
  if (v === undefined || v === null || v === "") return "Not set";
  if (typeof v === "string") return v;
  try { return JSON.stringify(v); } catch { return String(v); }
}
