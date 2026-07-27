/** The models a chat can be started or resumed with, newest first. */
export const MODELS = [
  { id: "claude-opus-5", label: "Opus 5", family: "opus" },
  { id: "claude-sonnet-5", label: "Sonnet 5", family: "sonnet" },
  { id: "claude-haiku-4-5", label: "Haiku 4.5", family: "haiku" },
];

/**
 * Which model to resume a session with.
 *
 * This used to be a ternary whose two branches were the same expression, so
 * replying from the phone silently moved every session to Opus — including the
 * Haiku ones, which is somebody's bill and not a thing the phone gets to
 * decide. Matching on the family keeps a session on the model it was started
 * with, and anything unrecognised stays on the default rather than guessing.
 *
 * Its own module, with no imports, so a test of it does not drag the whole
 * application's module graph in behind it.
 */
export function resumeModel(name: string | null | undefined): string {
  const n = (name || "").toLowerCase();
  return MODELS.find((m) => n.includes(m.family))?.id ?? MODELS[0]!.id;
}
