// A machine for the disk-cleanup tests that has no Docker, no GitHub and no
// real home: fake docker/git/gh/df/du/ps/tmux programs on a PATH directory, and
// a scratch home with the kinds of things the scan looks at.
//
// Nothing here may reach the real programs. `Bun.which` resolves against the
// PATH a process STARTED with, so every consumer runs in a child whose PATH
// begins with SHIM, and asserts `Bun.which("docker")` is the shim before it
// does anything. The shims log every call to $AGX_LOG, which is how a test
// proves the shim ran and that no `volume` command was ever issued.
import { chmodSync, lutimesSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const GB = 1e9;
export const OLD_ID = "11111111-aaaa-4bbb-8ccc-000000000001";
export const LIVE_ID = "22222222-aaaa-4bbb-8ccc-000000000002";
export const YOUNG_ID = "33333333-aaaa-4bbb-8ccc-000000000003";
export const LEGACY_ID = "44444444-aaaa-4bbb-8ccc-000000000004";
/** Where Claude's temp folders sit on a real machine: claude-tmp/claude-<uid>/<project>/<session>. */
export const TEMP_PROJ = "claude-1000/-home-dev-code-orbit";

/** Two stopped containers, full ids as `docker inspect` prints them. */
export const C1 = "a1".repeat(32);
export const C2 = "b2".repeat(32);
/** What `docker inspect --format` prints for one: id, image id, running, exit code, --rm, compose project. */
export const row = (id: string, autoRemove: boolean, o: { exit?: number; compose?: string; image?: string } = {}) =>
  `${id} sha256:${o.image ?? "c3".repeat(32)} false ${o.exit ?? 0} ${autoRemove} ${o.compose ?? ""}`;

const SH = (name: string, body: string[]) => ["#!/bin/sh", `printf '%s\\n' "${name} $*" >> "$AGX_LOG"`, ...body, ""].join("\n");

export const SHIMS: Record<string, string> = {
  docker: SH("docker", [
    'case "$1 $2" in',
    '  "info --format") if [ -n "$AGX_DOCKER_DOWN" ]; then echo "Cannot connect to the Docker daemon" >&2; exit 1; fi; echo "$AGX_DOCKER_ROOT";;',
    '  "context show") echo "${AGX_DOCKER_CONTEXT:-default}";;',
    '  "system df") cat "$AGX_DOCKER_DF";;',
    '  "ps -a") cat "$AGX_DOCKER_PS";;',
    '  "inspect --format") cat "$AGX_DOCKER_INSPECT";;',
    '  "images --digests") cat "$AGX_DOCKER_IMAGES";;',
    // a prune or a rm hands 5 GB back on the docker disk, the way a real one would
    '  "image prune"|"builder prune"|"rm "*) n=$(cat "$AGX_DF_VAULT"); echo $((n + 5000000000)) > "$AGX_DF_VAULT"; echo "Total reclaimed space: 5GB";;',
    '  "container prune") echo "a blanket container prune must never run" >&2; exit 2;;',
    '  *) echo "unexpected docker $*" >&2; exit 2;;',
    "esac",
  ]),
  df: SH("df", [
    'for p in "$@"; do :; done',
    'case "$p" in',
    '  "$AGX_DOCKER_ROOT"*|/vault*) echo "Filesystem 1-blocks Used Available Capacity Mounted on"; echo "/dev/mapper/vault 241000000000 26000000000 $(cat "$AGX_DF_VAULT") 11% /vault";;',
    '  *) echo "Filesystem 1-blocks Used Available Capacity Mounted on"; echo "/dev/mapper/omarchy_root 224000000000 219000000000 $(cat "$AGX_DF_HOME") 98% /home";;',
    "esac",
  ]),
  du: SH("du", [
    "shift",
    'for p in "$@"; do',
    '  b=$(awk -F"\\t" -v p="$p" \'index(p,$2){print $1; exit}\' "$AGX_DU")',
    '  printf "%s\\t%s\\n" "${b:-4096}" "$p"',
    "done",
  ]),
  git: SH("git", [
    // gitwork.ts's own calls put pinned `-c k=v` pairs before `-C`
    'while [ "$1" = "-c" ]; do shift 2; done',
    '[ "$1" = "-C" ] || exit 2',
    'd="$2"; shift 2; n=$(basename "$d")',
    'while [ "$1" = "-c" ]; do shift 2; done',
    'case "$1" in',
    '  worktree) case "$2" in',
    '    list) cat "$AGX_GIT_DIR/$n.list";;',
    '    remove) if [ -f "$AGX_GIT_DIR/$(basename "$3").rootowned" ]; then echo "error: failed to delete $3: Permission denied" >&2; exit 1; fi;;',
    '    *) exit 2;;',
    "  esac;;",
    '  status) case "$*" in *--ignored*) [ -f "$AGX_GIT_DIR/$n.ignored" ] && cat "$AGX_GIT_DIR/$n.ignored";; *) [ -f "$AGX_GIT_DIR/$n.status" ] && cat "$AGX_GIT_DIR/$n.status";; esac; exit 0;;',
    '  rev-list) if [ -f "$AGX_GIT_DIR/$n.unpushed" ]; then cat "$AGX_GIT_DIR/$n.unpushed"; else echo 0; fi;;',
    '  rev-parse) if [ "$2" = "--show-toplevel" ]; then echo "$d"; else echo "headof-$n"; fi;;',
    "  *) exit 2;;",
    "esac",
  ]),
  gh: SH("gh", [
    'if [ -n "$AGX_GH_FAIL" ]; then echo "gh: not signed in" >&2; exit 1; fi',
    // one branch: `pr list --head <branch> ...`
    'if [ "$3" = "--head" ]; then',
    '  b=$(printf "%s" "$4" | tr "/" "_")',
    '  if [ -f "$AGX_GH_DIR/$b.json" ]; then cat "$AGX_GH_DIR/$b.json"; else echo "[]"; fi; exit 0',
    "fi",
    // the whole repository: every pull request in the directory, or 200 other people's when AGX_GH_FULL says the batch is full
    'if [ -n "$AGX_GH_FULL" ]; then',
    '  i=0; printf "["; while [ $i -lt 200 ]; do [ $i = 0 ] || printf ","; printf \'{"number":%s,"state":"MERGED","headRefOid":"x","headRefName":"filler-%s","isCrossRepository":false,"updatedAt":"2026-01-01T00:00:00Z"}\' "$i" "$i"; i=$((i+1)); done; echo "]"; exit 0',
    "fi",
    'first=1; printf "["',
    'for f in "$AGX_GH_DIR"/*.json; do [ -f "$f" ] || continue; [ $first = 1 ] || printf ","; first=0; cut -c2- "$f" | sed \'s/.$//\' | tr -d "\\n"; done',
    'echo "]"',
  ]),
  ps: SH("ps", ['printf "%s\\n" "$AGX_PS"']),
  // AGX_PANES: the directories the panes of a running server stand in, one per line
  // a pane on another socket (`-S <path>`) is AGX_PANES_SOCK; the default server shows AGX_PANES
  tmux: SH("tmux", [
    'case " $* " in *" -S "*) if [ -n "$AGX_PANES_SOCK" ]; then printf "%s\\n" "$AGX_PANES_SOCK"; exit 0; fi;; esac',
    'if [ -n "$AGX_PANES" ] && [ "$1" = "list-panes" ]; then printf "%s\\n" "$AGX_PANES"; exit 0; fi',
    'echo "no server running" >&2', "exit 1"]),
};

export interface Fixture {
  dir: string;
  home: string;
  shim: string;
  /** Environment for a child that must see only the fakes. */
  env: Record<string, string>;
  log: string;
  /** Set a file the shims read. */
  put(rel: string, text: string): void;
}

/** A scratch machine. `docker` says how the fake Docker answers. */
export function makeFixture(opts: { dockerDown?: boolean; ghFail?: boolean } = {}): Fixture {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "agx-diskclean-")));
  const shim = join(dir, "shim");
  const home = join(dir, "home");
  const state = join(dir, "state");
  for (const d of [shim, home, state, join(state, "git"), join(state, "gh"), join(dir, "docker-root"), join(dir, "elsewhere")]) mkdirSync(d, { recursive: true });
  for (const [name, body] of Object.entries(SHIMS)) { writeFileSync(join(shim, name), body); chmodSync(join(shim, name), 0o755); }

  const put = (rel: string, text: string) => { mkdirSync(join(state, rel, ".."), { recursive: true }); writeFileSync(join(state, rel), text); };
  put("docker-df", [
    '{"Active":"7","Reclaimable":"59.37GB (54%)","Size":"109.5GB","TotalCount":"120","Type":"Images"}',
    '{"Active":"15","Reclaimable":"5GB (71%)","Size":"7GB","TotalCount":"17","Type":"Containers"}',
    '{"Active":"13","Reclaimable":"3.501GB (41%)","Size":"8.384GB","TotalCount":"103","Type":"Local Volumes"}',
    '{"Active":"0","Reclaimable":"61.06GB","Size":"79.42GB","TotalCount":"497","Type":"Build Cache"}',
  ].join("\n"));
  put("docker-ps", [
    ...Array.from({ length: 15 }, () => '{"State":"running","Status":"Up 3 hours","Labels":"com.docker.compose.project=orbit,a=b"}'),
    `{"ID":"${C1.slice(0, 12)}","Names":"orbit_check_1","State":"exited","Status":"Exited (0) 5 minutes ago","Labels":""}`,
    `{"ID":"${C2.slice(0, 12)}","Names":"orbit_check_2","State":"exited","Status":"Exited (0) 9 minutes ago","Labels":""}`,
  ].join("\n"));
  // both were started with --rm: the one signal that a stopped container is disposable
  put("docker-inspect", [row(C1, true), row(C2, true)].join("\n"));
  put("docker-images", "");
  put("df-home", String(5.1 * GB));
  put("df-vault", String(215 * GB));
  put("du", "");

  const env: Record<string, string> = {
    PATH: `${shim}:${process.env.PATH ?? "/usr/bin:/bin"}`,
    HOME: home, AGX_HOME: home, AGX_SHIM: shim,
    XDG_CONFIG_HOME: join(dir, "xdg-config"), XDG_DATA_HOME: join(dir, "xdg-data"), XDG_CACHE_HOME: join(dir, "xdg-cache"),
    AGENTGLASS_STATE_DIR: join(dir, "agx-state"), AGENTGLASS_DB: join(dir, "c.db"),
    AGX_LOG: join(dir, "calls.log"), AGX_DOCKER_ROOT: join(dir, "docker-root"), AGX_DOCKER_DF: join(state, "docker-df"), AGX_DOCKER_PS: join(state, "docker-ps"),
    AGX_DOCKER_INSPECT: join(state, "docker-inspect"), AGX_DOCKER_IMAGES: join(state, "docker-images"),
    AGX_DF_HOME: join(state, "df-home"), AGX_DF_VAULT: join(state, "df-vault"), AGX_DU: join(state, "du"), AGX_GIT_DIR: join(state, "git"), AGX_GH_DIR: join(state, "gh"),
    AGX_PS: `claude --resume ${LIVE_ID}`,
    ...(opts.dockerDown ? { AGX_DOCKER_DOWN: "1" } : {}), ...(opts.ghFail ? { AGX_GH_FAIL: "1" } : {}),
  };
  writeFileSync(env.AGX_LOG!, "");
  return { dir, home, shim, env, log: env.AGX_LOG!, put };
}

/** The home the tests scan: a repo with four checkouts, caches, Claude temp, trash, and things that are only explained. */
export function populateHome(fx: Fixture): { repo: string; wt: Record<string, string>; sessions: Record<string, string>; outside: string } {
  const { home, put } = fx;
  const code = join(home, "code");
  const repo = join(code, "orbit");
  mkdirSync(join(repo, ".git"), { recursive: true });
  const wt: Record<string, string> = {};
  for (const n of ["ORBIT-1042", "ORBIT-1050", "ORBIT-1060", "ORBIT-1070", "ORBIT-1080", "ORBIT-1090"]) { wt[n] = join(code, `orbit-${n}`); mkdirSync(wt[n]!, { recursive: true }); }
  const porcelain = [`worktree ${repo}`, "HEAD abcdef0123456789", "branch refs/heads/main", ""];
  for (const n of Object.keys(wt)) porcelain.push(`worktree ${wt[n]}`, "HEAD 1234567890abcdef", `branch refs/heads/feat/${n.toLowerCase()}`, "");
  put("git/orbit.list", porcelain.join("\n"));
  const pr = (n: string, number: number, state: string) =>
    put(`gh/feat_${n.toLowerCase()}.json`, JSON.stringify([{ number, state, headRefOid: "ffff", headRefName: `feat/${n.toLowerCase()}`, isCrossRepository: false, updatedAt: "2026-10-01T00:00:00Z" }]));
  pr("ORBIT-1042", 1042, "MERGED"); pr("ORBIT-1050", 1050, "MERGED"); pr("ORBIT-1060", 1060, "OPEN"); pr("ORBIT-1070", 1070, "MERGED"); pr("ORBIT-1080", 1080, "MERGED"); pr("ORBIT-1090", 1090, "MERGED");
  put("git/orbit-ORBIT-1050.status", " M a.ts\n?? b.ts\n M c.ts\n");
  put("git/orbit-ORBIT-1070.rootowned", "");
  // merged and clean, but it holds the only copy of an ignored file, which `worktree remove` would delete without a word
  writeFileSync(join(wt["ORBIT-1080"]!, ".env"), "TOKEN=x");
  put("git/orbit-ORBIT-1080.ignored", "!! .env\n!! __pycache__/\n");

  mkdirSync(join(home, ".cache", "uv"), { recursive: true });
  writeFileSync(join(home, ".cache", "uv", "blob"), "x");
  const trash = join(home, ".local/share/Trash/files");
  mkdirSync(trash, { recursive: true });
  writeFileSync(join(trash, "old.zip"), "x");
  // HF_HOME's default: the caches are two folders inside it, next to the person's login (invented token text)
  const hf = join(home, ".cache/huggingface");
  for (const d of ["hub", "xet", "accelerate"]) mkdirSync(join(hf, d), { recursive: true });
  writeFileSync(join(hf, "hub/blob"), "x"); writeFileSync(join(hf, "xet/chunk"), "x");
  writeFileSync(join(hf, "token"), "hf_invented_token_for_tests"); writeFileSync(join(hf, "accelerate/default_config.yaml"), "mixed_precision: bf16\n");
  mkdirSync(join(home, ".claude"), { recursive: true });
  mkdirSync(join(home, ".config/agentglass-electron/Partitions"), { recursive: true });

  const tmp = join(home, ".cache/claude-tmp", TEMP_PROJ);
  // legacy: the older shape, claude-tmp/<project>/<session>, kept as a second case
  const sessions: Record<string, string> = { old: join(tmp, OLD_ID), live: join(tmp, LIVE_ID), young: join(tmp, YOUNG_ID), legacy: join(home, ".cache/claude-tmp/-home-dev-code-orbit", LEGACY_ID) };
  // Something a link could be aimed at, from inside a folder the clean removes.
  const outside = join(fx.dir, "elsewhere");
  writeFileSync(join(outside, "precious.txt"), "keep me");
  const longAgo = new Date(Date.now() - 5 * 86400_000);
  for (const [k, p] of Object.entries(sessions)) {
    mkdirSync(join(p, "scratchpad"), { recursive: true });
    writeFileSync(join(p, "scratchpad", "out.json"), "{}");
    if (k === "old") { symlinkSync(outside, join(p, "scratchpad", "link-out")); lutimesSync(join(p, "scratchpad", "link-out"), longAgo, longAgo); }
    // Backdated last: creating a child updates its parent's mtime.
    if (k !== "young") for (const f of [join(p, "scratchpad", "out.json"), join(p, "scratchpad"), p]) utimesSync(f, longAgo, longAgo);
  }

  put("du", [
    `${1.8 * GB}\t${join(home, ".cache/uv")}`,
    `${900e6}\t${trash}`, `${3e9}\t${join(hf, "hub")}`, `${1e9}\t${join(hf, "xet")}`,
    `${4.3 * GB}\t${join(home, ".config/agentglass-electron/Partitions")}`,
    `${8.8 * GB}\t${join(home, ".claude")}`,
    `${3e6}\t${sessions.old}`, `${5.5 * GB}\t${sessions.live}`, `${3e6}\t${sessions.young}`, `${3e6}\t${sessions.legacy}`,
    `${1.1 * GB}\t${wt["ORBIT-1042"]}`, `${0.9 * GB}\t${wt["ORBIT-1050"]}`, `${1.4 * GB}\t${wt["ORBIT-1060"]}`, `${2.0 * GB}\t${wt["ORBIT-1070"]}`, `${0.5 * GB}\t${wt["ORBIT-1080"]}`, `${0.4 * GB}\t${wt["ORBIT-1090"]}`,
  ].map((l) => l.replace(/^([\d.e+]+)/, (m) => String(Math.round(Number(m))))).join("\n"));
  return { repo, wt, sessions, outside };
}
