/*
 * Shell lines the base `never` rules refuse by what they DO, not by how they
 * start. A prefix rule (`git push origin main:*`) misses `git push origin
 * +main`, `git -C x push upstream main`, `git push origin HEAD:refs/heads/main`.
 * These read the arguments instead. A bare `git push` stays uncaught: there is
 * no text to match, and the remote's branch protection is the wall for it.
 */
const TRUNK = new Set(["main", "master"]);
const words = (seg: string): string[] => seg.trim().split(/\s+/).filter(Boolean).map((w) => w.replace(/^["']|["']$/g, ""));

/** `git [-C dir | -c k=v | --opt] push [flags] <remote> <refspec>…` where a refspec's destination is main or master. */
export function pushesToTrunk(seg: string): boolean {
  const w = words(seg);
  if (w[0] !== "git") return false;
  let i = 1;
  while (i < w.length && w[i] !== "push") {
    if (!w[i]!.startsWith("-")) return false;
    i += w[i] === "-C" || w[i] === "-c" ? 2 : 1;
  }
  if (w[i] !== "push") return false;
  const pos: string[] = [];
  for (const a of w.slice(i + 1)) {
    // `--all` and `--mirror` push every branch, main and master with them.
    if (a === "--all" || a === "--mirror") return true;
    if (!a.startsWith("-")) pos.push(a);
  }
  // The first positional is the remote; the rest are refspecs.
  return pos.slice(1).some((spec) => {
    const dst = (spec.includes(":") ? spec.slice(spec.lastIndexOf(":") + 1) : spec.replace(/^\+/, "")).replace(/^\+/, "").replace(/^refs\/heads\//, "");
    return TRUNK.has(dst);
  });
}

const apiPath = (w: string[]): string => w.slice(2).find((a) => !a.startsWith("-") && a.includes("/")) ?? "";
const apiMethod = (w: string[]): string => {
  for (let i = 2; i < w.length; i++) {
    if ((w[i] === "-X" || w[i] === "--method") && w[i + 1]) return w[i + 1]!.toUpperCase();
    const m = /^--method=(.+)$/.exec(w[i]!);
    if (m) return m[1]!.toUpperCase();
  }
  return w.some((a) => /^(-f|-F|--field|--raw-field|--input)(=|$)/.test(a)) ? "POST" : "GET";
};

/** `gh api …/pulls/N/merge`: merging a pull request by the API. */
export function mergesByApi(seg: string): boolean {
  const w = words(seg);
  return w[0] === "gh" && w[1] === "api" && /\/pulls\/\d+\/merge\/?$/.test(apiPath(w)) && apiMethod(w) !== "GET";
}

/** `gh api …/releases` with a method that writes. */
export function releasesByApi(seg: string): boolean {
  const w = words(seg);
  return w[0] === "gh" && w[1] === "api" && /\/releases(\/\d+)?\/?$/.test(apiPath(w)) && apiMethod(w) !== "GET";
}

const normTarget = (t: string): string => {
  let s = t.replace(/^["']|["']$/g, "").replace(/^\$\{?HOME\}?(?=\/|$)/, "~").replace(/\/{2,}/g, "/");
  if (s.length > 1) s = s.replace(/\/+$/, "");
  return s;
};

/** `rm` with a recursive flag aimed at `/`, `/*`, `~`, `~/*` or $HOME, in any flag order or spelling. */
export function removesRootOrHome(seg: string): boolean {
  const w = words(seg);
  if (!/^(?:\/\S*\/)?rm$/.test(w[0] ?? "")) return false;
  let recursive = false, ended = false;
  const targets: string[] = [];
  for (const a of w.slice(1)) {
    if (!ended && a === "--") { ended = true; continue; }
    if (!ended && a.startsWith("-")) { if (a === "--recursive" || /^-[A-Za-z]*[rR][A-Za-z]*$/.test(a)) recursive = true; continue; }
    targets.push(normTarget(a));
  }
  return recursive && targets.some((t) => t === "/" || t === "/*" || t === "~" || t === "~/*");
}

/** Which base rule action a line breaks by shape, if any. */
export function brokenBaseRule(seg: string): { action: string; why: string } | null {
  if (pushesToTrunk(seg)) return { action: "git.push.main", why: "a push whose destination is main or master is never, on any remote and in any spelling (+, refs/heads/, src:dst, :dst). A bare `git push` is not caught: there is no text to match, so the remote's branch protection is the wall for it." };
  if (mergesByApi(seg)) return { action: "gh.pr.merge", why: "merging a pull request, by `gh pr merge` or by the API, is the person's alone." };
  if (releasesByApi(seg)) return { action: "gh.release", why: "a release, by `gh release` or by the API, is the person's alone." };
  if (removesRootOrHome(seg)) return { action: "rm.rf.root", why: "a recursive remove of / or the home directory is never; a path under them (`rm -rf ./build`) is fine." };
  return null;
}
