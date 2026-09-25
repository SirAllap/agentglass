/**
 * The default conflict prompt — the ask, unchanged in substance: reconcile
 * intent, explain the judgement calls, and stop short of committing so the
 * resolution can be reviewed. In `shared/` because the server ships it as the
 * built-in prompt and the panel falls back to it when the server cannot be
 * reached; two copies of a sentence drift on the first edit.
 */
export const CONFLICT_ASK = [
  "Please resolve each conflict, keeping both sides' intent where they do",
  "different things. Where they do the same thing differently, prefer the",
  "incoming side named above. Explain anything you had to choose between.",
  "Do not commit — leave the resolution staged so I can review it.",
];
