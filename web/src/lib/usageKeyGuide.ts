/**
 * The steps for making an OpenCode console key, written once and read in two
 * places: the key's own field under Agent engines, and the plan panel's empty
 * state, which is where somebody notices the console numbers are missing.
 *
 * Plain and in order, because the permission list is the part people get wrong:
 * `Models` spends money, and a key that can read budgets is the one thing the
 * panel asks for. The card draws them as numbered rows; the panel joins them
 * into the one sentence it has room for.
 */
export const USAGE_KEY_STEPS: readonly { title: string; what: string }[] = [
  { title: "Make the key", what: "At opencode.ai, sign in, then Account › Personal API keys › Add API key." },
  { title: "Workspace and expiry", what: "Workspace: Default. Expiration: 90 days." },
  { title: "Permissions", what: "Restricted: Usage = Read, everything else None. Models stays None, because that permission spends money." },
  { title: "Paste it here", what: "Copy it once. It is never shown again after it is saved." },
  { title: "If the console says 403", what: "Set Budgets = Read and create the key again." },
];

/** The same steps as one sentence, for the panel's narrow empty state. */
export const USAGE_KEY_GUIDE = USAGE_KEY_STEPS.map((s) => `${s.title}: ${s.what}`).join(" ");
