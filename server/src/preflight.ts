/*
 * PREFLIGHT: a review by a reader who knows nothing but a directory.
 *
 * The material goes into a fresh temporary directory, read-only, and one
 * `claude -p` runs there with project settings only, auto-memory off and three
 * read tools. It never sees the conversation, the memory or the hooks that
 * produced the work, so what it flags is what a cold reader cannot tell. Only
 * what was named is copied: the directory holds nothing else of the machine.
 * server/test/preflight-canary.test.ts proves that against a real claude.
 *
 * The runner is pure of the database: it takes a request and answers with the
 * certificate (preflightStore.ts keeps it).
 */
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, lstatSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, relative, resolve } from "node:path";

export const FILE_LIMIT_BYTES = 5 * 1024 * 1024;
export const NAMED_FILES_MAX = 12;
export const NAMED_BYTES_MAX = 400 * 1024;
/** A cited line gets this many lines around it; the first IMPORT_LINES of a file are always sent (its imports). */
export const SLICE_CONTEXT = 40;
export const IMPORT_LINES = 30;
/** A named file with no line is sent whole up to this size, else only its first UNCITED_HEAD_LINES. */
export const WHOLE_FILE_MAX = 40 * 1024;
export const UNCITED_HEAD_LINES = 200;
export const ISOLATION = "claude -p, auto-memory off, project settings only, read-only tools";

export type Severity = "blocker" | "major" | "nit";
export type FindingAction = "fix" | "contest" | "ask" | "dismiss";
export interface Finding {
  id: string; severity: Severity; title: string; quote: string; evidence: string;
  action: FindingAction | null; note: string | null;
  /** Who set the action, once one is set. */
  by?: string;
}
export interface Certificate {
  id: string; createdAt: number; model: string; costUsd: number;
  /** The most this run was allowed to spend; absent on a certificate from before it was recorded. */
  capUsd?: number;
  /** `part` is what of the file was sent: "whole", "lines 1–30, 1144–1264" or "partial" (the head of a big file named with no line). Absent on a certificate from before it was recorded. */
  files: { path: string; sha256: string; bytes: number; part?: string }[];
  mockups: { path: string; sha256: string; bytes: number; kind: "image" | "html" }[];
  skipped: { path: string; reason: string }[];
  /** One line naming what the reviewer was given: "Read PLAN.md + 4 files: a.ts, b.ts". Absent on a certificate from before it was recorded. */
  read?: string;
  sawConversation: false;
  isolation: string;
  findings: Finding[];
}
export interface PreflightInput {
  id?: string;
  /** Absolute paths. With no `pr`, the first is the material. */
  files: string[];
  pr?: { number: number; root: string };
  /** Paths inside the copy are relative to this when the file is under it, else to `/`. */
  root?: string;
  model: string;
  budgetUsd: number;
  /** Absolute paths of mockups (.png .jpg .webp .html), copied to mockup/<basename>. */
  mockups?: string[];
  /** Text written at the top of the directory; with no `pr`, the first is the material. */
  extraText?: { name: string; body: string }[];
  /** Line ranges the text cited per absolute path (from namedFiles); only those lines ±context are copied. A path with no range is a file named without a line. Absent: every file is copied whole. */
  ranges?: Record<string, [number, number][]>;
  /** Files the text named that namedFiles left out for the limits; carried into the certificate's `skipped`. */
  leftOut?: { path: string; reason: string }[];
}
export interface PreflightDeps {
  /** The claude command. A test passes `[process.execPath, stub]`. */
  bin?: string[];
  env?: Record<string, string>;
  timeoutMs?: number;
  /** Runs `gh` read-only in `cwd` and returns stdout. */
  gh?: (args: string[], cwd: string) => Promise<string>;
  /** Told where the work directory is before the child starts. */
  onWorkDir?: (dir: string) => void;
}

export const MOCKUP_KINDS: Record<string, "image" | "html"> = { ".png": "image", ".jpg": "image", ".jpeg": "image", ".webp": "image", ".html": "html" };
export const mockupKind = (p: string) => MOCKUP_KINDS[extname(p).toLowerCase()];

const NAMED = /`([^`\s]+)`|(?<![\w./`-])((?:[\w.-]+\/)+[\w.-]+\.[A-Za-z]{1,5}(?::\d+(?:-\d+)?)?)(?![\w/])/g;

/**
 * The files a text names (`path/file.ext` in backticks, or a bare path:line), resolved inside `root`.
 * A name that leaves the root, goes through a symlink or is not a regular file is dropped without a word:
 * the text may name anything, the reviewer's directory only ever gets files of the project.
 * The limits (NAMED_FILES_MAX files, NAMED_BYTES_MAX bytes) keep the first ones named and report the rest.
 */
export function namedFiles(text: string, root: string): { files: string[]; ranges: Record<string, [number, number][]>; leftOut: { path: string; reason: string }[] } {
  const files: string[] = [], leftOut: { path: string; reason: string }[] = [], seen = new Set<string>();
  const ranges: Record<string, [number, number][]> = {};
  let real: string;
  try { real = realpathSync(root); } catch { return { files, ranges, leftOut }; }
  let bytes = 0;
  for (const m of text.matchAll(NAMED)) {
    const raw = (m[1] ?? m[2])!;
    const tok = raw.replace(/:\d+(?:-\d+)?$/, "");
    if (!/^(?:[\w.-]+\/)*[\w.-]+\.[A-Za-z]{1,5}$/.test(tok)) continue;
    const want = resolve(real, tok);
    const cite = /:(\d+)(?:-(\d+))?$/.exec(raw);
    if (cite) {
      const a = Number(cite[1]), b = Number(cite[2] ?? cite[1]);
      (ranges[want] ??= []).push([Math.min(a, b), Math.max(a, b)]);
    }
    if (seen.has(want)) continue;
    seen.add(want);
    if (!want.startsWith(real + "/")) continue;
    let st;
    try { if (realpathSync(want) !== want) continue; st = lstatSync(want); } catch { continue; }
    if (!st.isFile()) continue;
    if (files.length >= NAMED_FILES_MAX) { leftOut.push({ path: want, reason: `over the ${NAMED_FILES_MAX}-file limit` }); continue; }
    if (bytes + st.size > NAMED_BYTES_MAX) { leftOut.push({ path: want, reason: `over the ${NAMED_BYTES_MAX / 1024} KB total` }); continue; }
    bytes += st.size;
    files.push(want);
  }
  for (const k of Object.keys(ranges)) if (!files.includes(k)) delete ranges[k];
  return { files, ranges, leftOut };
}

/**
 * What of a file the reviewer is given. Cited lines go in with SLICE_CONTEXT lines around them and the first
 * IMPORT_LINES of the file, each window under a `… lines A-B …` marker; a file named with no line goes whole
 * under WHOLE_FILE_MAX and as its first UNCITED_HEAD_LINES above it. shortcut: windows are by line, a cited
 * line inside a 5,000-character line still sends that whole line.
 */
export function sliceOf(data: Buffer, cited: [number, number][] | undefined): { data: Buffer; part: string } {
  const text = data.toString("utf8"), lines = text.split("\n");
  const last = lines.length > 1 && lines[lines.length - 1] === "" ? lines.length - 1 : lines.length;
  let wins: [number, number][];
  if (cited?.length) wins = [[1, Math.min(IMPORT_LINES, last)], ...cited.map(([a, b]): [number, number] => [Math.max(1, a - SLICE_CONTEXT), Math.min(last, b + SLICE_CONTEXT)])];
  else if (data.length <= WHOLE_FILE_MAX) return { data, part: "whole" };
  else wins = [[1, Math.min(UNCITED_HEAD_LINES, last)]];
  wins = wins.filter(([a, b]) => a <= b).sort((x, y) => x[0] - y[0]);
  const merged: [number, number][] = [];
  for (const w of wins) {
    const t = merged[merged.length - 1];
    if (t && w[0] <= t[1] + 1) t[1] = Math.max(t[1], w[1]); else merged.push([w[0], w[1]]);
  }
  if (merged.length === 1 && merged[0]![0] === 1 && merged[0]![1] >= last) return { data, part: "whole" };
  const out = merged.map(([a, b]) => `… lines ${a}-${b} …\n${lines.slice(a - 1, b).join("\n")}`).join("\n");
  return { data: Buffer.from(out + "\n"), part: cited?.length ? "lines " + merged.map(([a, b]) => `${a}–${b}`).join(", ") : "partial" };
}

const HEADING = /^### F(\d+) - (Blocker|Major|Nit) - (.+?)\s*$/i;

/** The findings in a reply, `[]` for "No findings", or null when it is neither (a failed run). */
export function parseFindings(text: string): Finding[] | null {
  const t = String(text ?? "").trim();
  if (/^No findings\.?$/i.test(t)) return [];
  const out: Finding[] = [];
  let field: "quote" | "evidence" | null = null;
  for (const line of t.split("\n")) {
    const h = HEADING.exec(line);
    if (h) {
      out.push({ id: `F${h[1]}`, severity: h[2]!.toLowerCase() as Severity, title: h[3]!, quote: "", evidence: "", action: null, note: null });
      field = null;
      continue;
    }
    const f = out[out.length - 1];
    if (!f) continue;
    const q = /^Quote:\s?(.*)$/.exec(line), e = /^Evidence:\s?(.*)$/.exec(line);
    if (q) { field = "quote"; f.quote = q[1]!; } else if (e) { field = "evidence"; f.evidence = e[1]!; } else if (field) f[field] += "\n" + line;
  }
  for (const f of out) { f.quote = f.quote.trim(); f.evidence = f.evidence.trim(); }
  return out.length ? out : null;
}

function promptFor(material: string, mockups: boolean): string {
  return `You are a reviewer who knows nothing except this directory. You have no other context and must not guess at any.

${material} is what is being reviewed. The directory files/ holds the files it names, copied as they are. Read the material first, then open whatever it points to. Check what the material says about those files against the files themselves. If a file it names is not in files/, that is not a problem to report: you were not given it.

Report only problems a person about to act on this material would regret not hearing:
- an assumption the material never states
- an acceptance criterion that two readers would judge differently
- no way to check the result in the real running app
- something the change removes or replaces without saying so
- a claim that conflicts with code you can read (cite file:line)
- a decision the worker would have to guess
${mockups ? `
The directory mockup/ holds mockups of the interface. Read every one (Read shows images). Also report:
- where the plan and a mockup disagree
- states the plan needs that no mockup shows: empty, loading, error, long text, narrow width
- a control a mockup shows that the plan gives no behaviour
` : ""}
Use exactly this format for each problem, and nothing else:

### F<n> - <Blocker|Major|Nit> - <short title>
Quote: <the line of the material the problem is about>
Evidence: <what you read that shows it, with file:line when it is code>

If there is nothing to report, reply with exactly: No findings
No praise, no summary, no advice beyond the problem.`;
}

async function defaultGh(args: string[], cwd: string): Promise<string> {
  const p = Bun.spawn(["gh", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  if ((await p.exited) !== 0) throw new Error(`gh ${args.slice(0, 2).join(" ")} failed: ${err.slice(0, 200)}`);
  return out;
}

/**
 * What the reviewer's child may inherit from the server: a list of what it needs, not a list of what to
 * remove. A server started from a shell with a token in it would otherwise hand that token to a reader
 * whose only job is to read a plan. The session markers of the asking Claude are not on the list.
 */
const ENV_ALLOWED = /^(PATH|HOME|USER|LOGNAME|SHELL|LANG|LC_[A-Z_]+|TERM|TMPDIR|XDG_[A-Z_]+|ANTHROPIC_[A-Z_]+|CLAUDE_CONFIG_DIR|CLAUDE_CODE_USE_[A-Z_]+|(HTTPS?|NO|ALL)_PROXY|(https?|no|all)_proxy)$/;
const RESERVED_TEXT = new Set(["MATERIAL.md", "PR.md", "PR.diff"]);

export async function runPreflight(input: PreflightInput, deps: PreflightDeps = {}): Promise<Certificate> {
  const bin = deps.bin ?? [Bun.which("claude") ?? ""];
  if (!bin[0]) throw new Error("claude is not on PATH");
  const id = input.id ?? `pc_${randomBytes(8).toString("hex")}`;
  const createdAt = Date.now();
  const work = mkdtempSync(join(tmpdir(), "agx-preflight-"));
  try {
    const files: Certificate["files"] = [], mockups: Certificate["mockups"] = [], skipped: Certificate["skipped"] = [...(input.leftOut ?? [])];
    const base = input.root ?? input.pr?.root;
    let first = true, material = "MATERIAL.md";
    const put = (rel: string, data: string | Uint8Array, readOnly = false) => {
      const to = join(work, rel);
      mkdirSync(dirname(to), { recursive: true });
      writeFileSync(to, data);
      if (readOnly) chmodSync(to, 0o444);
    };
    for (const p of input.files) {
      let data: Buffer;
      try {
        const st = lstatSync(p);
        if (!st.isFile()) { skipped.push({ path: p, reason: "not a regular file" }); continue; }
        if (st.size > FILE_LIMIT_BYTES) { skipped.push({ path: p, reason: `larger than ${FILE_LIMIT_BYTES / 1024 / 1024} MB` }); continue; }
        data = readFileSync(p);
      } catch { skipped.push({ path: p, reason: "unreadable" }); continue; }
      const rel = base && resolve(p).startsWith(resolve(base) + "/") ? relative(resolve(base), resolve(p)) : resolve(p).replace(/^\/+/, "");
      const cut = input.ranges && !(first && !input.pr && !input.extraText?.length) ? sliceOf(data, input.ranges[p]) : null;
      if (cut) data = cut.data;
      put(join("files", rel), data, true);
      files.push({ path: p, sha256: createHash("sha256").update(data).digest("hex"), bytes: data.length, ...(cut ? { part: cut.part } : {}) });
      if (first && !input.pr && !input.extraText?.length) put("MATERIAL.md", data, true);
      first = false;
    }
    for (const p of input.mockups ?? []) {
      const kind = mockupKind(p);
      if (!kind) { skipped.push({ path: p, reason: "not a .png, .jpg, .webp or .html mockup" }); continue; }
      let data: Buffer;
      try {
        const st = lstatSync(p);
        if (!st.isFile()) { skipped.push({ path: p, reason: "not a regular file" }); continue; }
        if (st.size > FILE_LIMIT_BYTES) { skipped.push({ path: p, reason: `larger than ${FILE_LIMIT_BYTES / 1024 / 1024} MB` }); continue; }
        data = readFileSync(p);
      } catch { skipped.push({ path: p, reason: "unreadable" }); continue; }
      // shortcut: two mockups with one basename overwrite each other, when a plan needs that, number them.
      put(join("mockup", basename(p)), data, true);
      mockups.push({ path: p, sha256: createHash("sha256").update(data).digest("hex"), bytes: data.length, kind });
    }
    for (const t of input.extraText ?? []) {
      if (RESERVED_TEXT.has(t.name) || t.name.includes("/") || t.name.includes("..")) throw new Error(`extra text name not allowed: ${t.name.slice(0, 80)}`);
      put(t.name.replace(/[^\w.-]/g, "_"), t.body, true);
    }
    if (input.extraText?.length && !input.pr) material = input.extraText[0]!.name.replace(/[^\w.-]/g, "_");
    if (input.pr) {
      const gh = deps.gh ?? defaultGh, n = String(input.pr.number);
      const meta = JSON.parse(await gh(["pr", "view", n, "--json", "title,body"], input.pr.root)) as { title?: string; body?: string };
      put("PR.md", `# ${meta.title ?? ""}\n\n${meta.body ?? ""}\n`, true);
      put("PR.diff", await gh(["pr", "diff", n], input.pr.root), true);
      material = "PR.md and PR.diff";
    }

    const env: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(process.env)) if (ENV_ALLOWED.test(k)) env[k] = v;
    env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = "1";
    Object.assign(env, deps.env);
    deps.onWorkDir?.(work);

    const argv = [
      ...bin, "-p", "--setting-sources", "project", "--model", input.model, "--output-format", "json",
      "--max-budget-usd", String(input.budgetUsd), "--tools", "Read,Grep,Glob", "--allowedTools", "Read", "Grep", "Glob", "--", promptFor(material, mockups.length > 0),
    ];
    const p = Bun.spawn(argv, { cwd: work, env: env as Record<string, string>, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => { try { p.kill(); } catch { /* already gone */ } }, deps.timeoutMs ?? 10 * 60_000);
    let out: string, err: string, code: number;
    try {
      [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
      code = await p.exited;
    } finally { clearTimeout(timer); }

    /* A run that failed still spent: the error carries what it cost, so the budget counts it (flightBudget.ts). With no reply to read the cost from, it is billed at its cap. */
    const billed = (message: string, costUsd: number) => Object.assign(new Error(message), { costUsd });
    let reply: { result?: unknown; total_cost_usd?: unknown; is_error?: unknown; subtype?: unknown };
    try { reply = JSON.parse(out); } catch { throw billed(`the reviewer gave no JSON (exit ${code}): ${(out || err).slice(0, 200)}`, input.budgetUsd); }
    const spent = Number(reply.total_cost_usd) || 0;
    /* claude -p ends a run that hit --max-budget-usd with this subtype and no result; the view reads "spent $X". */
    if (reply.subtype === "error_max_budget_usd") throw billed(`stopped at the cap: spent $${spent.toFixed(2)} of $${input.budgetUsd.toFixed(2)}`, spent);
    if (reply.is_error || typeof reply.result !== "string") throw billed(`the reviewer failed (exit ${code}): ${String(reply.result ?? err).slice(0, 200)}`, spent);
    const findings = parseFindings(reply.result);
    if (!findings) throw billed(`the reviewer's reply had no findings and no "No findings": ${reply.result.slice(0, 200)}`, spent);
    const texts = (input.extraText ?? []).map((t) => t.name.replace(/[^\w.-]/g, "_"));
    const named = input.extraText?.length ? files : files.slice(1);
    const read = `Read ${[...texts, ...(input.extraText?.length ? [] : files.slice(0, 1).map((f) => basename(f.path)))].join(" + ") || "nothing"}${named.length ? ` + ${named.length} file${named.length === 1 ? "" : "s"}: ${named.map((f) => (base && resolve(f.path).startsWith(resolve(base) + "/") ? relative(resolve(base), resolve(f.path)) : f.path) + (f.part ? ` (${f.part})` : "")).join(", ")}` : ""}`;
    return {
      id, createdAt, model: input.model, costUsd: Number(reply.total_cost_usd) || 0, capUsd: input.budgetUsd, files, mockups, skipped, read,
      sawConversation: false, isolation: ISOLATION, findings,
    };
  } finally {
    /* `work` is the literal mkdtemp result above, never empty; the check keeps a future edit from pointing rm elsewhere. */
    if (work.startsWith(tmpdir() + "/agx-preflight-")) rmSync(work, { recursive: true, force: true });
  }
}
