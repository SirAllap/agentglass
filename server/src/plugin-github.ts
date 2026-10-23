/**
 * GitHub reads on behalf of a plugin.
 *
 * `gh auth login` keeps its token in the system keyring, and a plugin's box has
 * no keyring (no D-Bus, no runtime dir, and no token in its environment on
 * purpose), so a plugin that ran `gh` itself worked in a terminal and failed
 * with a 401 inside. The server is outside the box and already has the login,
 * so it does the read and hands back the text.
 *
 * A plugin names an operation and its parameters. It never sends a command
 * line or an API path, so the requests that can exist are the ones built
 * below, each a GET or a fixed read-only query, each with every parameter
 * checked against a strict shape. The token never leaves the server.
 */
import { gh as ghRun, type GhResult } from "./prs.ts";

const REPO = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const NUMBER = /^\d{1,9}$/;
const SHA = /^[0-9a-f]{40}$/;
const PR_FIELDS = "number,title,author,headRefOid,baseRefName,url,isDraft";
const CONTEXT_FIELDS = "title,body,author,commits,labels,baseRefName,headRefName";
const THREADS_QUERY = `query($o:String!,$n:String!,$p:Int!){repository(owner:$o,name:$n){pullRequest(number:$p){
  reviewThreads(first:100){nodes{isResolved isOutdated path line comments(first:1){nodes{author{login} body}}}}}}}`;

export type GhReadArgs = { ok: true; args: string[] } | { ok: false; error: string };

const fail = (error: string): GhReadArgs => ({ ok: false, error });

/** The `gh` arguments for one operation, or why there are none. */
export function ghReadArgs(op: string, q: URLSearchParams): GhReadArgs {
  if (op === "user") return { ok: true, args: ["api", "user"] };
  if (op === "repos") {
    return { ok: true, args: ["api", "user/repos?per_page=100&affiliation=owner,collaborator,organization_member&sort=pushed", "--paginate", "-q", ".[].full_name"] };
  }
  const repo = q.get("repo") ?? "";
  if (!REPO.test(repo)) return fail("repo must be owner/name");
  const number = q.get("number") ?? "";
  const needNumber = (): boolean => NUMBER.test(number);
  switch (op) {
    case "pr-list": {
      const label = q.get("label") ?? "";
      if (!label || label.length > 100 || /[\n\r]/.test(label)) return fail("label is required");
      return { ok: true, args: ["pr", "list", "-R", repo, "--state", "open", "--label", label, "--limit", "50", "--json", PR_FIELDS] };
    }
    case "pr-view":
      return needNumber() ? { ok: true, args: ["pr", "view", number, "-R", repo, "--json", PR_FIELDS] } : fail("number must be digits");
    case "pr-view-context":
      return needNumber() ? { ok: true, args: ["pr", "view", number, "-R", repo, "--json", CONTEXT_FIELDS] } : fail("number must be digits");
    case "pr-diff":
      return needNumber() ? { ok: true, args: ["pr", "diff", number, "-R", repo] } : fail("number must be digits");
    case "threads": {
      if (!needNumber()) return fail("number must be digits");
      const [o, n] = repo.split("/");
      return { ok: true, args: ["api", "graphql", "-f", `query=${THREADS_QUERY}`, "-f", `o=${o}`, "-f", `n=${n}`, "-F", `p=${number}`] };
    }
    case "compare": {
      const base = q.get("base") ?? "", head = q.get("head") ?? "";
      if (!SHA.test(base) || !SHA.test(head)) return fail("base and head must be 40-character commit ids");
      return { ok: true, args: ["api", "-H", "Accept: application/vnd.github.diff", `repos/${repo}/compare/${base}...${head}`] };
    }
    case "tarball": {
      const sha = q.get("sha") ?? "";
      return SHA.test(sha) ? { ok: true, args: ["api", `repos/${repo}/tarball/${sha}`] } : fail("sha must be a 40-character commit id");
    }
    default:
      return fail(`unknown operation "${op}"`);
  }
}

export type GhReadResult = { ok: true; stdout: string } | { ok: false; error: string };

/** Run a text operation. `run` is the seam tests replace. */
export async function runGhRead(
  op: string,
  q: URLSearchParams,
  run: (args: string[]) => Promise<GhResult> = (a) => ghRun(a),
): Promise<GhReadResult> {
  const built = ghReadArgs(op, q);
  if (!built.ok) return built;
  const r = await run(built.args);
  if (r.code !== 0) {
    const last = r.stderr.trim().split("\n").pop() ?? "";
    return { ok: false, error: (last || `gh ${built.args[0]} failed`).slice(0, 300) };
  }
  return { ok: true, stdout: r.stdout };
}

/** The tarball cap, the same one the plugin applied when it ran gh itself. */
export const MAX_TARBALL = 400 * 1024 * 1024;

/** Stream a commit's tarball, stopping at the cap. */
export function streamTarball(args: string[]): Response {
  const bin = Bun.which("gh");
  if (!bin) return Response.json({ ok: false, error: "the GitHub CLI (gh) is not installed" }, { status: 502 });
  const proc = Bun.spawn([bin, ...args], { stdout: "pipe", stderr: "ignore", env: { ...process.env, GH_PROMPT_DISABLED: "1", NO_COLOR: "1" } });
  let total = 0;
  const capped = (proc.stdout as ReadableStream<Uint8Array>).pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, ctl) {
      total += chunk.length;
      if (total > MAX_TARBALL) { try { proc.kill(); } catch { /* gone */ } ctl.error(new Error("tarball over the cap")); return; }
      ctl.enqueue(chunk);
    },
  }));
  return new Response(capped, { headers: { "Content-Type": "application/gzip", "Cache-Control": "no-store" } });
}
