/**
 * The lower bound of a Wilson score interval — the one implementation.
 *
 * The understudy is scored on agreement, and agreement is a proportion of a
 * small sample. The raw ratio is useless as a gate at that size: three for
 * three is 1.00 and means nothing, while 57 of 80 is a claim a reasonable
 * person would act on. The Wilson lower bound is what turns "how often did it
 * agree" into "how often would it agree, pessimistically", and it is the number
 * the threshold is written against — a class is only ever OFFERED as guided
 * when n >= 80, raw >= 0.70 and this bound is at least 0.60.
 *
 * There is exactly one copy of it, in `shared/`, and that placement is the
 * whole point of the file. Two implementations is how a UI ladder and a server
 * gate drift apart while both look right: the panel draws a bar that says the
 * class has earned it, the server refuses because its own arithmetic rounds the
 * other way, and the bug reads as a permissions problem rather than as two
 * functions disagreeing in the fourth decimal. So the server imports this and
 * the web imports this, and when the constant `z` is ever argued about, it is
 * argued about once.
 *
 * Kept free of imports so both sides can take it and so a test of it pulls no
 * application graph in behind it — the same rule shared/projectKey.ts follows.
 */

/**
 * The lower end of the Wilson score interval for `k` successes out of `n`.
 *
 * `z` is the standard normal quantile: 1.96 is the two-sided 95% interval,
 * which is a one-sided 97.5% floor — deliberately the conservative reading,
 * because the cost of over-crediting a class here is the understudy being
 * offered a promotion it has not earned.
 *
 * Returns 0 for an empty sample. A class nobody has watched yet has earned
 * nothing, and 0/0 is the one input where the arithmetic below is NaN rather
 * than merely pessimistic — a NaN compared against a threshold is false in
 * every direction, which would silently pass or silently fail depending on
 * which way the caller wrote the comparison.
 */
export function wilsonLower(k: number, n: number, z = 1.96): number {
  if (n <= 0) return 0;
  const p = k / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = p + z2 / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n);
  return (centre - margin) / denom;
}
