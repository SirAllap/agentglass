/*
 * Which model a flight plan's builder starts on. One copy, both tiers: the
 * launch reads it to build the argv, and the Go card reads the same words to
 * say which model it will use and why.
 *
 * The plan picks, not the person's last mood: a plan that is L, or that touches
 * something sensitive, launches on the model the project sets for sensitive
 * work; anything else launches on what the builder role names. A stronger model
 * than that pick is the person's to choose, per Go — nothing here ever escalates
 * on its own.
 */

export type BuilderSize = "S" | "M" | "L";

/** The model names a launch takes, cheapest first. */
export const BUILDER_MODELS = ["haiku", "sonnet", "opus"] as const;
export type BuilderModel = (typeof BUILDER_MODELS)[number];

export const isBuilderModel = (m: unknown): m is BuilderModel => (BUILDER_MODELS as readonly unknown[]).includes(m);

/** "opus" reads as "Opus" in a sentence about it. */
export const modelLabel = (m: string): string => m.charAt(0).toUpperCase() + m.slice(1);

/** Higher is more expensive. A name outside the three sorts below all of them: it is not a choice the launch makes. */
export const modelRank = (m: string): number => (BUILDER_MODELS as readonly string[]).indexOf(m);

export const costlier = (a: string, b: string): boolean => modelRank(a) > modelRank(b);

/** Paths whose change the person looks at first: auth, migrations, secrets, payments, CI, and a dependency list. */
const SENSITIVE_PATH = [
  /(^|\/)(auth|oauth|login|sessions?|secrets?|credentials?|keyring|payments?|billing)(\/|\.|-|_|$)/i, /(^|\/)migrations?(\/|$)/i,
  /(^|\/)\.github(\/|$)/, /(^|\/)\.gitlab-ci\.yml$/, /(^|\/)Jenkinsfile$/,
  /(^|\/)(package\.json|bun\.lockb?|package-lock\.json|yarn\.lock|pnpm-lock\.yaml|requirements[\w.-]*\.txt|pyproject\.toml|Cargo\.(toml|lock)|go\.(mod|sum)|Gemfile(\.lock)?)$/,
];
const SENSITIVE_WORD = /\b(auth\w*|migrations?|secrets?|credentials?|payments?|billing|CI|dependenc(y|ies)|new package)\b/i;

/**
 * Whether the plan touches something sensitive: a path it names, or its own
 * "Risk" section saying so. Shortcut: a path written without a slash or a
 * recognised file name is missed; the Risk section is what catches it.
 */
export const sensitivePath = (path: string): boolean => SENSITIVE_PATH.some((re) => re.test(path));

export function sensitiveHit(planMd: string): string | null {
  for (const tok of planMd.match(/[\w@.-]+(?:\/[\w@.-]+)*/g) ?? []) if (sensitivePath(tok)) return tok;
  const risk = /^#{1,4}\s*Risks?\b.*\n([\s\S]*?)(?=^#{1,4}\s|(?![\s\S]))/im.exec(planMd)?.[1] ?? "";
  const w = SENSITIVE_WORD.exec(risk);
  return w ? w[0] : null;
}

/** The model a worker role names for the builder, in the short names a launch takes. Anything else is Sonnet. */
export const roleModel = (role: { provider: string; model: string }): BuilderModel =>
  role.provider === "claude" && isBuilderModel(role.model) ? role.model : "sonnet";

export interface BuilderPick { model: BuilderModel; why: string }

/**
 * The model this plan's builder starts on, and one sentence saying why. `strong`
 * is the project's model for sensitive work; an unknown name leaves the role's.
 */
export function builderPick(plan: { size: BuilderSize | null; planMd: string }, role: { provider: string; model: string }, strong: string): BuilderPick {
  const normal = roleModel(role);
  const strongSet = isBuilderModel(strong);
  const pick: BuilderModel = strongSet ? strong : normal;
  // With no usable name for sensitive work the model is the role's: saying otherwise would be false.
  const from = strongSet ? "the model set for sensitive work" : "the builder role's model";
  const hit = sensitiveHit(plan.planMd);
  if (plan.size === "L") return { model: pick, why: `${modelLabel(pick)}: this is an L plan, so it launches on ${from}.` };
  if (hit) return { model: pick, why: `${modelLabel(pick)}: this plan touches ${hit}, so it launches on ${from}.` };
  return { model: normal, why: `${modelLabel(normal)}: this plan is ${plan.size ?? "unsized"} and touches nothing sensitive, so it launches on the builder role's model.` };
}

/** Why a model asked for at Go cannot be used, or null. A stronger one than the plan's pick is the person's. */
export function overrideVerdict(pick: BuilderPick, wanted: string, person: boolean): string | null {
  if (!isBuilderModel(wanted)) return `model: a launch takes ${BUILDER_MODELS.join(", ")}`;
  if (!person && costlier(wanted, pick.model)) return `a stronger model than the plan's choice is the person's: ${modelLabel(wanted)} costs more than ${modelLabel(pick.model)}`;
  return null;
}
