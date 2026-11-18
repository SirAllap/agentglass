/*
 * The Images view's "built at an old commit" decision, pure: for each repository whose image tag template has `{sha}`, the
 * images that template matches whose sha is no live checkout's HEAD. The matching is shared/dockerTag.ts, the same rule the
 * cleanup and the orphan sweep use.
 */
import { oldCommitRefs, templateHasSha } from "../../../shared/dockerTag.ts";
import type { DockerRepoLeftovers } from "../../../shared/types.ts";

export function oldCommitSet(left: readonly Pick<DockerRepoLeftovers, "template" | "liveHeads">[], refs: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const r of left) if (templateHasSha(r.template)) for (const ref of oldCommitRefs(r.template, refs, r.liveHeads)) out.add(ref);
  return out;
}
