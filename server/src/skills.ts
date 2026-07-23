// Skill catalog: scans the machine's Claude Code skill/command directories,
// parses SKILL.md / command frontmatter, dedupes worktree copies, and joins
// recorded usage from the events DB. Read-only and cached — the dashboard's
// answer to "what skills do we have and what do they do?".
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import type { SkillInfo } from "../../shared/types.ts";
import { skillUsageDetail } from "./db.ts";

// Where to look for `.claude` roots: the user's own + every project checkout.
const CODE_DIR = process.env.AGENTGLASS_CODE_DIR || join(homedir(), "code");
const TTL = 60_000;

let cache: SkillInfo[] | null = null;
let cacheAt = 0;

/** Minimal frontmatter reader: `--- key: value ... ---` at the top of the file.
 *  Handles plain scalars, quoted strings, and folded/literal block scalars
 *  (`key: >` / `key: |` followed by indented lines). */
function frontmatter(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw.startsWith("---")) return out;
  const end = raw.indexOf("\n---", 3);
  if (end < 0) return out;
  const lines = raw.slice(3, end).split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^([A-Za-z_-]+):\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if (/^[>|][+-]?$/.test(v)) {
      // Block scalar: consume subsequent indented lines as the value.
      const parts: string[] = [];
      while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1]) || lines[i + 1].trim() === "")) {
        i++;
        parts.push(lines[i].trim());
      }
      v = parts.join(" ").trim();
    } else if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    out[m[1].toLowerCase()] = v;
  }
  return out;
}

interface RawEntry {
  name: string;
  kind: "skill" | "command";
  description: string;
  argument_hint: string | null;
  source: string;
  path: string;
  mtime: number;
}

/** Ordered discovery rules: first match wins. Name is the strongest signal;
 *  description keywords catch the rest. */
const CATEGORY_RULES: { label: string; test: (n: string, d: string) => boolean }[] = [
  { label: "domain experts", test: (n) => /-expert$|-guide$/.test(n) },
  { label: "tasks & tracking", test: (n, d) => /task|ticket|issue|sprint|backlog|standup|planner/.test(n) || /issue tracker|task manager/i.test(d) },
  { label: "PRs & review", test: (n, d) => /^pr-|review|premortem|assign|dependabot/.test(n) || /pull request|code review/i.test(d) },
  { label: "testing & QA", test: (n, d) => /test|harness|qa\b|coverage|fixture/.test(n) || /\bQA\b|test(ing)? guide|verification/i.test(d) },
  { label: "evals & prompts", test: (n, d) => /eval|prompt|benchmark|golden|baseline|flaky/.test(n) || /evaluat(e|ion)|prompt/i.test(d) },
  { label: "release & ops", test: (n, d) => /release|deploy|hotfix|infra|secret|security|monitor|migrate|rollback|scheduler/.test(n) || /deploy(ment)?|infrastructure|hotfix/i.test(d) },
  { label: "context & sessions", test: (n) => /context|catchup|handoff|interview|kickoff|summar|onboard/.test(n) },
  { label: "dev workflow", test: (n, d) => /worktree|lint|debug|profil|refactor|scaffold|architecture|documentation|requirements|agent/.test(n) || /workflow|refactor/i.test(d) },
];

function categorize(name: string, description: string): string {
  for (const r of CATEGORY_RULES) if (r.test(name, description)) return r.label;
  return "other";
}

/** Pull the "Use when…" style sentence out of a description — the single most
 *  useful line for "which skill do I reach for in this situation?". */
function whenToUse(description: string): string | null {
  // A period only ends the sentence when followed by whitespace/EOL — periods
  // inside URLs ("docs.example.com") must not cut the extraction short.
  const m = description.match(
    /\b(?:use (?:it |this |these )?(?:when|after|for|if|before)|run (?:it |this )?when|triggers? on)\b(?:[^.!?]|[.!?](?!\s|$))*(?:[.!?]|$)/i
  );
  return m ? m[0].trim().replace(/[.!?]$/, "") : null;
}

function readEntry(path: string, kind: "skill" | "command", fallbackName: string, source: string): RawEntry | null {
  try {
    const raw = readFileSync(path, "utf-8");
    const fm = frontmatter(raw);
    return {
      name: fm.name || fallbackName,
      kind,
      description: fm.description || "",
      argument_hint: fm["argument-hint"] || null,
      source,
      path,
      mtime: statSync(path).mtimeMs,
    };
  } catch {
    return null;
  }
}

function scanClaudeRoot(root: string, source: string, out: RawEntry[]) {
  const skillsDir = join(root, "skills");
  if (existsSync(skillsDir)) {
    for (const dir of safeReaddir(skillsDir)) {
      const p = join(skillsDir, dir, "SKILL.md");
      if (existsSync(p)) {
        const e = readEntry(p, "skill", dir, source);
        if (e) out.push(e);
      }
    }
  }
  const cmdDir = join(root, "commands");
  if (existsSync(cmdDir)) {
    for (const f of safeReaddir(cmdDir)) {
      if (!f.endsWith(".md") || f.toLowerCase() === "readme.md") continue;
      const e = readEntry(join(cmdDir, f), "command", f.replace(/\.md$/, ""), source);
      if (e) out.push(e);
    }
  }
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/**
 * True "added" dates from git: one batched `git log --diff-filter=A` per repo,
 * mapping repo-relative path → first-commit epoch ms. File mtimes are useless
 * across worktrees (checkout resets them, so every copy clusters at checkout
 * time); git history is the honest signal for "newest".
 */
async function gitAddedDates(repo: string): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  try {
    // A full history walk, and it was synchronous: the loop watchdog caught it
    // at 790ms — the last thing in the app still freezing a steady-state
    // session, once a minute when the cache below expires. Awaited now, so the
    // walk costs wall clock rather than a terminal that has stopped echoing.
    const proc = Bun.spawn(
      ["git", "-C", repo, "log", "--diff-filter=A", "--format=C %ct", "--name-only", "--", ".claude/skills", ".claude/commands"],
      { stdout: "pipe", stderr: "ignore" }
    );
    const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    if (code !== 0) return map;
    let ts = 0;
    for (const line of out.split("\n")) {
      if (line.startsWith("C ")) {
        ts = Number(line.slice(2)) * 1000;
      } else if (line.trim()) {
        // Log is newest-first; keep overwriting so the FIRST add wins.
        map.set(line.trim(), ts);
      }
    }
  } catch {
    /* no git / not a repo — mtime fallback stands */
  }
  return map;
}

export async function getSkills(): Promise<SkillInfo[]> {
  const now = Date.now();
  if (cache && now - cacheAt < TTL) return cache;

  const raw: RawEntry[] = [];
  scanClaudeRoot(join(homedir(), ".claude"), "user", raw);
  for (const dir of safeReaddir(CODE_DIR)) {
    const root = join(CODE_DIR, dir, ".claude");
    if (existsSync(root)) scanClaudeRoot(root, dir, raw);
  }

  // Dedupe worktree copies by kind+name; keep the shortest source label
  // ("web" beats "web-feature-branch"), the OLDEST mtime (closest to the real
  // add date), and the longest description seen.
  const merged = new Map<string, SkillInfo>();
  for (const e of raw) {
    const key = `${e.kind}:${e.name}`;
    const cur = merged.get(key);
    if (!cur) {
      merged.set(key, { ...e, added: e.mtime, copies: 1, calls: 0, last_used: null, cost_usd: 0 } as SkillInfo & { mtime?: number });
      continue;
    }
    cur.copies++;
    if (e.mtime < cur.added) cur.added = e.mtime;
    if (e.description.length > cur.description.length) cur.description = e.description;
    if (!cur.argument_hint && e.argument_hint) cur.argument_hint = e.argument_hint;
    if (e.source === "user" || e.source.length < cur.source.length) {
      cur.source = e.source;
      cur.path = e.path;
    }
  }

  // Overlay real git added-dates for entries whose canonical copy lives in a
  // repo. One history walk per repo, and the repos are walked concurrently:
  // serially, a machine with several skill-bearing projects paid the sum.
  const repos = [...new Set([...merged.values()].filter((s) => s.source !== "user").map((s) => join(CODE_DIR, s.source)))];
  const gitCache = new Map(await Promise.all(repos.map(async (r) => [r, await gitAddedDates(r)] as const)));
  for (const s of merged.values()) {
    if (s.source === "user") continue;
    const repo = join(CODE_DIR, s.source);
    const added = gitCache.get(repo)?.get(relative(repo, s.path));
    if (added) s.added = added;
  }

  // Join usage + attributed cost ("plugin:skill" invocations also count for "skill").
  const usage = new Map<string, { calls: number; cost_usd: number; last_used: number }>();
  for (const u of skillUsageDetail()) {
    for (const key of new Set([u.skill, u.skill.split(":").pop()!])) {
      const cur = usage.get(key) ?? { calls: 0, cost_usd: 0, last_used: 0 };
      cur.calls += u.calls;
      cur.cost_usd += u.cost_usd;
      cur.last_used = Math.max(cur.last_used, u.last_used);
      usage.set(key, cur);
    }
  }

  cache = [...merged.values()]
    .map((s) => {
      const u = usage.get(s.name);
      const clean = { ...s } as SkillInfo & { mtime?: number };
      delete clean.mtime;
      return {
        ...clean,
        calls: u?.calls ?? 0,
        cost_usd: u?.cost_usd ?? 0,
        last_used: u?.last_used ?? null,
        category: categorize(s.name, s.description),
        when_to_use: whenToUse(s.description),
      };
    })
    .sort((a, b) => b.calls - a.calls || a.name.localeCompare(b.name));
  cacheAt = now;
  return cache;
}

/** Shareable catalog exports — markdown reads well in Slack/Notion/GitHub. */
export async function catalogMarkdown(): Promise<string> {
  const skills = await getSkills();
  const date = new Date().toISOString().slice(0, 10);
  const lines = [`# Skills catalog — ${date}`, "", `${skills.length} available. Generated by agentglass.`, ""];
  const categories = [...new Set(skills.map((s) => s.category))];
  for (const cat of categories) {
    const group = skills.filter((s) => s.category === cat);
    lines.push(`## ${cat} (${group.length})`, "");
    for (const s of group) {
      const usage = s.calls > 0 ? ` — used ${s.calls}×` : "";
      lines.push(`### \`/${s.name}\`${usage}`, "");
      if (s.when_to_use) lines.push(`**${s.when_to_use}.**`, "");
      if (s.description) lines.push(s.description, "");
      lines.push(`> invoke: \`/${s.name}${s.argument_hint ? ` ${s.argument_hint}` : ""}\` · ${s.kind} · source: ${s.source}`, "");
    }
  }
  return lines.join("\n");
}

export async function catalogCsv(): Promise<string> {
  const esc = (v: unknown) => {
    const s = v == null ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const cols = ["name", "kind", "source", "copies", "calls", "cost_usd", "argument_hint", "description"];
  const lines = [cols.join(",")];
  for (const s of await getSkills()) lines.push(cols.map((c) => esc((s as any)[c])).join(","));
  return lines.join("\n");
}
