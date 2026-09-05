/*
 * Reading the machine, once the user has said which parts of it.
 *
 * Everything here is local file reading. No network, no model, no API key —
 * which is not an accident of scope but the point: the material that would make
 * a prediction belong to a person is already on their disk, and none of it
 * needs to leave to be useful.
 *
 * THE ORDER IS THE SAFETY PROPERTY:
 *
 *     source allowed? → path forbidden? → read → translate → private-terms
 *     gate → bank
 *
 * The gate runs before anything is written and not after, and the translate
 * step runs before the gate so that a term which has an agreed fictional
 * substitute is substituted rather than refused. A window that still trips the
 * gate afterwards is dropped and counted; it is never stored "for review",
 * because a quarantine holding the text would be the leak with an apology
 * attached.
 *
 * WHAT COMES OUT. Two things, and they are not the same kind of thing.
 *
 *   RULES — from the files the user wrote deliberately. These become the
 *   policy: numbered lines with provenance, which the predictor reads as
 *   instructions.
 *
 *   PRECEDENTS — from the record of what they actually did. These become the
 *   bank, which the predictor reads as evidence. A rule says "never main"; a
 *   precedent says "on the fourteenth of August, given this, he made
 *   feat/pr-unread and based it on the tip". The second is what makes a
 *   prediction his rather than merely sensible.
 */
import { existsSync, readFileSync, readdirSync, statSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, basename, dirname } from "node:path";
import type { UnderstudyLearned, UnderstudySource } from "../../shared/types.ts";
import { Database } from "bun:sqlite";
import {
  CLASS_WORDS,
  classify,
  CLASSES, addPrecedent, consent, isForbidden, privateTermsGate, translate, sha256, termsStatus,
  precedentsByClass, isOpenProjectPath, openProjectName, OPEN_PARTITION,
} from "./understudy.ts";
import { allowedSources } from "./understudy-sources.ts";

const HOME = homedir();

/** Where the compiled policy lives. Outside any checkout, on purpose. */
export const policyDir = (): string =>
  join(process.env.XDG_CONFIG_HOME || join(HOME, ".config"), "agentglass", "policy");

/* ─────────────────────────────────────── walking ────────────────────────── */

function* files(path: string, exts: string[], maxDepth = 4, cap = 8000): Generator<string> {
  let seen = 0;
  function* walk(dir: string, depth: number): Generator<string> {
    if (depth > maxDepth || seen >= cap) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const e of entries) {
      if (seen >= cap) return;
      const full = join(dir, e);
      // The must-not-see list vetoes on the PATH before anything is opened.
      // Checking after reading would mean the forbidden thing had already been
      // in memory, which is a distinction that matters to the person who wrote
      // the list.
      if (isForbidden(full)) continue;
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) yield* walk(full, depth + 1);
      else if (exts.some((x) => e.endsWith(x))) {
        seen++;
        yield full;
      }
    }
  }
  try {
    if (statSync(path).isFile()) {
      if (!isForbidden(path)) yield path;
      return;
    }
  } catch {
    return;
  }
  yield* walk(path, 0);
}

/* ─────────────────────────────────────── rules ──────────────────────────── */

export interface Rule {
  id: string;
  cls: string;
  text: string;
  src: string;
  at: number;
  backed: number;
}

/**
 * Which class a rule belongs to, by the words in it.
 *
 * A keyword map and not a model, and it is honest about being one: a rule that
 * matches nothing lands in `general`, which the predictor reads for every
 * class. Being wrong here is cheap — a rule filed under the wrong class is
 * still read, just in one place too few — whereas a model call per line would
 * make the ingest need a network, which is the property this whole module is
 * built to avoid.
 */

/**
 * Rules out of one markdown file.
 *
 * A rule is a sentence with an instruction in it, and the shape that finds them
 * without a model is the imperative or the prohibition: lines that say never,
 * always, must, don't — in either language, because the user writes in both.
 * Bullets and bold lines are weighted in because that is how this particular
 * person writes a rule down.
 */
function rulesFromMarkdown(text: string, src: string, at: number): Rule[] {
  const out: Rule[] = [];
  const lines = text.split("\n");
  const INSTRUCTION = /\b(never|always|must|don'?t|do not|siempre|nunca|jam[aá]s|no\s+se\s+|hay que|tiene que|only|s[oó]lo|solo)\b/i;
  for (const raw of lines) {
    const line = raw.trim();
    if (line.length < 24 || line.length > 400) continue;
    if (line.startsWith("```") || line.startsWith("|") || line.startsWith("#")) continue;
    const bare = line.replace(/^[-*>]\s*/, "").replace(/\*\*/g, "").trim();
    if (!INSTRUCTION.test(bare)) continue;
    if (isForbidden(bare)) continue;
    const clean = translate(bare);
    if (privateTermsGate(clean)) continue;
    out.push({
      id: `R${sha256(clean).slice(0, 10)}`,
      cls: classify(clean),
      text: clean,
      src,
      at,
      backed: 0,
    });
  }
  return out;
}

/*
 * Rules out of a configuration file.
 *
 * A shell alias is the most compressed statement of a habit there is. Nobody
 * abbreviates something they do twice a year, so every one of these lines is a
 * person saying "I do this constantly, and I am tired of typing it". A prose
 * file has to be written on purpose; these accumulate by themselves, which
 * makes them harder to fool and better evidence.
 *
 * Four shapes, because four files are worth reading and they disagree about
 * syntax:
 *
 *   fish     abbr -a gs 'git status'      /  alias  /  function name
 *   git      [alias] st = status -sb
 *   tmux     bind -n M-h select-pane -L   /  set -g prefix C-a
 *   settings JSON, read as configuration rather than parsed line-wise
 *
 * The VALUE, not the name, is what carries meaning: `gs` says nothing and
 * `git status -sb` says everything, so the rule text keeps both and leads with
 * what it expands to.
 */
function rulesFromConfig(text: string, file: string, src: string, at: number): Rule[] {
  const out: Rule[] = [];
  const seen = new Set<string>();
  const push = (what: string, cls: string) => {
    if (what.length < 6 || what.length > 300) return;
    if (isForbidden(what)) return;
    const clean = translate(what);
    if (privateTermsGate(clean)) return;
    const id = `R${sha256(clean).slice(0, 10)}`;
    if (seen.has(id)) return;
    seen.add(id);
    out.push({ id, cls, text: clean, src, at, backed: 0 });
  };

  const base = basename(file);

  /*
   * The agent settings, which are the only file here that is already a list of
   * rules. `permissions.allow` and `permissions.deny` are literally "what I let
   * an agent do" and "what I never let it do" — the same statement the prose
   * files spend a paragraph making, written as data.
   *
   * Parsed as JSON rather than line-wise, because a line of JSON is a fragment
   * and the fragment is not the rule.
   */
  if (base === "settings.json" || base.endsWith(".json")) {
    try {
      const o = JSON.parse(text) as {
        permissions?: { allow?: unknown; deny?: unknown; ask?: unknown };
        hooks?: Record<string, unknown>;
      };
      const say = (list: unknown, how: string) => {
        if (!Array.isArray(list)) return;
        for (const raw of list) {
          if (typeof raw !== "string" || !raw.trim()) continue;
          push(`${how} ${raw.trim()}`, classify(raw));
        }
      };
      say(o.permissions?.deny, "You never let an agent run");
      say(o.permissions?.ask, "You want to be asked before an agent runs");
      say(o.permissions?.allow, "You let an agent run");
      for (const event of Object.keys(o.hooks ?? {})) {
        push(`You run a hook of your own on the "${event}" event - something you check automatically rather than by hand.`, "general");
      }
    } catch {
      // Not JSON we understand. A settings file we cannot parse teaches
      // nothing, and guessing at it teaches something wrong.
    }
    return out;
  }

  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;

    // fish: abbr and alias. Both end up as "you shorten X to Y".
    let m = /^(?:abbr|alias)\s+(?:-[a-zA-Z-]+\s+)*['"]?([\w.-]+)['"]?\s*(?:=|\s)\s*['"]?(.+?)['"]?;?$/.exec(line);
    if (m && m[2] && !/^-/.test(m[2])) {
      push(`You shorten "${m[2].trim()}" to "${m[1]}" - a command you run constantly.`, classify(m[2]));
      continue;
    }

    // git config: only the [alias] section carries intent; the rest is plumbing
    // except for a handful of defaults that genuinely describe a preference.
    if (base === ".gitconfig" || base === "config") {
      m = /^([\w.-]+)\s*=\s*(.+)$/.exec(line);
      if (m && /^(st|co|ci|br|lg|ll|amend|undo|last|unstage|please|s|d|p)$/.test(m[1]!)) {
        push(`In git you shorten "${m[2]!.trim()}" to "${m[1]}".`, "C4");
        continue;
      }
      if (m && /^(rebase|ff|autoStash|autosquash|default|editor|pager|conflictStyle|prune)$/i.test(m[1]!)) {
        push(`Your git default: ${m[1]} = ${m[2]!.trim()}.`, "C4");
        continue;
      }
    }

    // tmux: key bindings and the options that shape a screen.
    if (base === ".tmux.conf") {
      m = /^bind(?:-key)?\s+(?:-[a-zA-Z]+\s+)*(\S+)\s+(.+)$/.exec(line);
      if (m) { push(`In tmux you bound "${m[1]}" to ${m[2]!.trim()}.`, "C3"); continue; }
      m = /^set(?:-option|-window-option)?\s+(?:-[a-zA-Z]+\s+)*([\w-]+)\s+(.+)$/.exec(line);
      if (m) { push(`Your tmux setting: ${m[1]} is ${m[2]!.trim()}.`, "C3"); continue; }
    }

    // fish functions: a name is something you only give to what you repeat.
    m = /^function\s+([\w.-]+)/.exec(line);
    if (m) { push(`You wrote a shell function called "${m[1]}" - something you do often enough to name.`, "general"); continue; }
  }

  return out;
}

/*
 * Precedents out of a shell history.
 *
 * Five thousand lines, and banking them one for one would be the wrong shape
 * twice over: it would drown every other source in four hundred copies of
 * `git status`, and frequency would masquerade as importance simply because
 * the bank counts rows.
 *
 * So it banks DISTINCT commands and carries the count as weight. What survives
 * is the vocabulary - which tools, with which flags, in what proportion - and a
 * command run four hundred times gets one row that says so, rather than four
 * hundred rows that say it four hundred times.
 *
 * Two shapes. fish writes YAML-ish records:
 *
 *     - cmd: git status
 *       when: 1767289998
 *
 * bash writes one command per line. Both reduce to the same thing here.
 *
 * WHAT IS DROPPED, and this is not a nicety. A shell history is the single most
 * likely place on a machine to hold a credential in plain text: an `export
 * TOKEN=`, a `curl -H "Authorization: ..."`, a password typed into the wrong
 * prompt. The private-terms gate cannot help, because a token is not a known
 * term - it is a string nobody has ever seen before. So the filter here is
 * SHAPE, applied before anything is banked.
 */
const SECRET_SHAPED = [
  // fish assigns with a space (`set -x API_KEY v`) and every other shell with
  // an `=`. Accepting only `=` would have let the fish form straight through,
  // and fish is the shell this history came from.
  /\b(export|setenv|set\s+-[a-zA-Z]*x[a-zA-Z]*)\s+\w*(TOKEN|SECRET|KEY|PASSWORD|PASSWD|CREDENTIAL|API)\w*\s*[= ]/i,
  /--?(password|token|secret|api[-_]?key|auth)[=\s]\S/i,
  /\bAuthorization:\s*\S/i,
  /\b(gh|glab)\s+auth\s+(login|token)/i,
  /\bssh-add\b|\bgpg\s+--/i,
  /[A-Za-z0-9_-]{32,}/, // a bare high-entropy blob: not worth the risk
];

function bankShellHistory(text: string, file: string, partition: string, source: string) {
  let banked = 0;
  let quarantined = 0;

  const counts = new Map<string, { n: number; at: number }>();
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    let cmd: string;
    let at = 0;
    const fish = /^-\s*cmd:\s*(.+)$/.exec(raw);
    if (fish) {
      cmd = fish[1]!.trim();
      const when = /^\s+when:\s*(\d+)/.exec(lines[i + 1] ?? "");
      if (when) at = Number(when[1]) * 1000;
    } else if (/^\s*when:\s*\d+/.test(raw) || !raw.trim() || raw.startsWith(" ")) {
      continue;
    } else {
      // zsh's extended format, `: 1699999999:0;command`, carries its own clock;
      // bash's plain lines (and a `#1699999999` stamp line when HISTTIMEFORMAT
      // is set) do not, so those land undated.
      const zsh = /^:\s*(\d+):\d+;(.*)$/.exec(raw);
      if (zsh) { cmd = zsh[2]!.trim(); at = Number(zsh[1]) * 1000; }
      else if (/^#\d{9,}$/.test(raw.trim())) continue;
      else cmd = raw.trim();
    }
    if (cmd.length < 3 || cmd.length > 300) continue;
    if (SECRET_SHAPED.some((re) => re.test(cmd))) { quarantined++; continue; }
    const prev = counts.get(cmd);
    counts.set(cmd, { n: (prev?.n ?? 0) + 1, at: Math.max(prev?.at ?? 0, at) });
  }

  // Busiest first, so that if the cap bites it takes the tail rather than an
  // arbitrary slice of the alphabet.
  const ranked = [...counts.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 1500);
  const which = basename(file).includes("bash") ? "bash" : "fish";

  for (const [cmd, { n, at }] of ranked) {
    if (isForbidden(cmd)) continue;
    const clean = translate(cmd);
    if (privateTermsGate(clean)) { quarantined++; continue; }
    const id = addPrecedent({
      cls: classify(clean),
      partition,
      situation: `at a ${which} prompt`,
      decision: clean.slice(0, 160),
      hisWords: n > 1 ? `${clean}   (run ${n} times)` : clean,
      source,
      sourceRef: sha256(cmd).slice(0, 12),
      provenance: "typed",
      at: at || fileTime(file),
      // A command run constantly is a stronger statement about how somebody
      // works than one run once, but only to a point - the log flattens the
      // difference between 40 and 400, which is the honest shape of it.
      weight: Math.min(1.6, 0.7 + Math.log10(n + 1) / 2),
    });
    if (id) banked++;
  }

  return { banked, quarantined };
}

/* ────────────────────────────────────── precedents ──────────────────────── */

/** A typed human turn out of a Claude Code transcript line. */
function humanTurn(line: string): { text: string; at: number } | null {
  try {
    const o = JSON.parse(line) as {
      type?: string;
      timestamp?: string;
      message?: { role?: string; content?: unknown };
    };
    if (o.type !== "user" || o.message?.role !== "user") return null;
    const c = o.message.content;
    let text = "";
    if (typeof c === "string") text = c;
    else if (Array.isArray(c)) {
      for (const part of c as { type?: string; text?: string }[]) {
        if (part && part.type === "text" && typeof part.text === "string") text += part.text + " ";
      }
    }
    text = text.trim();
    // Tool results, hook output and slash-command scaffolding are the machine
    // talking, and they arrive on the same `user` turns as the person does.
    if (!text || text.length < 8 || text.length > 2000) return null;
    if (/^<(command-|local-command|system-reminder|task-notification)/.test(text)) return null;
    if (text.startsWith("Caveat:")) return null;
    return { text, at: o.timestamp ? Date.parse(o.timestamp) : 0 };
  } catch {
    return null;
  }
}

/**
 * Is this turn a DECISION worth banking.
 *
 * The highest-signal human turns are the short ones: a correction, a refusal, a
 * choice between two things somebody just offered. Long turns are usually a
 * brief rather than a decision, and banking those would fill the bank with
 * descriptions of work instead of judgements about it.
 */
/*
 * A turn that settles something, and it is a WEIGHT rather than a gate.
 *
 * It used to be the gate, and the measurement is why it is not any more: over
 * 205 transcripts and 5,303 typed turns, this pattern dropped 68% of them and
 * the class filter below dropped another 15%, so a gigabyte of transcripts
 * yielded a tenth of what the person actually said.
 *
 * What it threw away was not noise. A sample of the rejected turns:
 *
 *     "The rest is rubbish I don't care about"
 *     "Simple and humbler and more in my own words"
 *     "explain it to me like I was 5"
 *     "Don't comment on the product thing, don't drag it out any longer"
 *
 * Every one of those is the thing this feature exists to learn — how somebody
 * decides and how they talk — and none of them contains the word yes or no. A
 * twenty-word list cannot be the arbiter of which of your sentences counted.
 *
 * So a decisive turn now weighs more, and an ordinary one is still kept.
 */
const DECISIVE =
  /\b(no|nunca|jam[aá]s|mal|wrong|stop|don'?t|revert|undo|s[ií]|yes|dale|ok|vale|approve|merge|instala|install|mejor|better|instead|prefer|prefiero)\b/i;

/*
 * The turns that really are noise, which is a much smaller set.
 *
 * Bare assent carries no information — "ok", "dale", "sigue" — and neither does
 * something pasted in from a terminal, which is the machine talking through the
 * person. Everything else is kept.
 */
const FILLER = /^(s[ií]|no|ok|okay|vale|dale|sigue|continua|contin[uú]a|gracias|thanks|yes|yep|nope|k|👍)[\s.!]*$/i;
function isPastedOutput(t: string): boolean {
  const lines = t.split("\n");
  if (lines.length < 4) return false;
  // Log-shaped: timestamps, levels, stack frames, or a wall of paths.
  const machine = lines.filter((l) =>
    /^\s*(at |\d{4}-\d{2}-\d{2}|\[\d|ERROR|WARN|INFO|DEBUG|\+{3}|-{3}|\S+\.(ts|tsx|js|py):\d+)/.test(l),
  ).length;
  return machine >= lines.length / 2;
}

/* ─────────────────────────────────────── the run ────────────────────────── */

export interface IngestResult extends UnderstudyLearned {
  rulesList: Rule[];
}

/**
 * Read everything the user allowed, and turn it into policy and precedents.
 *
 * Synchronous and capped. This runs on demand from a button and takes seconds,
 * not minutes: the caps below are what keep a 2 GB transcript tree from turning
 * a click into a coffee break, and they are deliberately visible in the result
 * so a person can see that it stopped early rather than finding out later.
 */
export class IngestRefused extends Error {}

export function ingest(opts: { maxFilesPerSource?: number; iAcceptNoTermsList?: boolean } = {}): IngestResult {
  /*
   * REFUSE TO START if the private-terms list is not loaded.
   *
   * Found the hard way on the first real run: with the list missing, the gate
   * approved every window and 127 private terms were written into a compiled
   * policy. The gate could not tell "checked, clean" from "could not check",
   * and neither could anything downstream.
   *
   * Refusing is the only honest response. Reading a corpus is precisely the
   * operation where "I could not check" and "it is fine" must not be the same
   * answer, and the caller can override deliberately for a machine that
   * genuinely has nothing to protect — but it has to say so out loud.
   */
  const terms = termsStatus();
  if (!terms.ok && !opts.iAcceptNoTermsList) {
    throw new IngestRefused(
      `no private-terms list at ${terms.path} — refusing to read anything. ` +
      `Create it, or say explicitly that this machine has nothing to protect.`,
    );
  }
  const cap = opts.maxFilesPerSource ?? 1200;
  const { allow, extra } = consent();
  const sources = allowedSources(allow, extra);
  const at = Date.now();

  const rules: Rule[] = [];
  const bySource: UnderstudyLearned["bySource"] = [];
  let filesRead = 0;
  let filesSkipped = 0;
  let quarantined = 0;
  let precedents = 0;

  for (const src of sources) {
    let sRules = 0;
    let sPrec = 0;
    let sSkip = 0;

    if (src.kind === "rules" && src.path.endsWith(".db")) {
      // A memory store, read read-only through the same sqlite the app has.
      const got = ingestObservationsDb(src, at);
      sRules += got.rules.length;
      rules.push(...got.rules);
      sPrec += got.precedents;
      precedents += got.precedents;
      quarantined += got.quarantined;
      filesRead += 1;
    } else if (src.kind === "rules") {
      let n = 0;
      // Configuration is a rule source in a different syntax, so the walk has
      // to admit more than markdown. A single named file - `.gitconfig`,
      // `.tmux.conf` - is yielded whatever it is called; the extension list
      // only governs directories.
      for (const f of files(src.path, [".md", ".fish", ".conf", ".json", ".toml"], 4, cap)) {
        if (n++ >= cap) break;
        let text: string;
        try {
          text = readFileSync(f, "utf8");
        } catch {
          sSkip++;
          continue;
        }
        filesRead++;
        const got = f.endsWith(".md")
          ? rulesFromMarkdown(text, provenanceOf(f), fileTime(f))
          : rulesFromConfig(text, f, provenanceOf(f), fileTime(f));
        sRules += got.length;
        rules.push(...got);
      }
    } else {
      // precedents: transcripts and the worklog
      const isTranscripts = src.id.startsWith("transcripts:");
      const isHistory = src.id.startsWith("shell-history");
      const partition = partitionOf(src.path);
      let n = 0;
      const exts = isTranscripts ? [".jsonl"] : isHistory ? [] : [".md"];
      for (const f of files(src.path, exts, 4, cap)) {
        if (n++ >= cap) break;
        let text: string;
        try {
          text = readFileSync(f, "utf8");
        } catch {
          sSkip++;
          continue;
        }
        filesRead++;
        if (isTranscripts) {
          const got = bankTranscript(text, f, partition, src.id);
          sPrec += got.banked;
          precedents += got.banked;
          quarantined += got.quarantined;
        } else if (isHistory) {
          const got = bankShellHistory(text, f, partition, src.id);
          sPrec += got.banked;
          precedents += got.banked;
          quarantined += got.quarantined;
        } else if (src.id === "notes" || src.id === "projects") {
          const got = bankNotes(text, f, partition, src.id);
          sPrec += got.banked;
          precedents += got.banked;
          quarantined += got.quarantined;
        } else {
          const got = bankWorklog(text, f, partition, src.id);
          sPrec += got.banked;
          precedents += got.banked;
          quarantined += got.quarantined;
        }
      }
    }

    filesSkipped += sSkip;
    bySource.push({ id: src.id, label: src.label, rules: sRules, precedents: sPrec, skipped: sSkip });
  }

  // De-duplicate rules by id, keeping the newest source for each.
  const byId = new Map<string, Rule>();
  for (const r of rules) {
    const prev = byId.get(r.id);
    if (!prev || r.at > prev.at) byId.set(r.id, r);
  }
  const finalRules = [...byId.values()];

  // A rule is BACKED when the bank holds enough cases in its class to justify
  // it acting. Six, from the study's own finding that below that a retrieved
  // rule hurts more than it helps.
  const counts = countByClass();
  for (const r of finalRules) r.backed = counts[r.cls] ?? 0;

  writePolicy(finalRules, at);

  return {
    at,
    rules: finalRules.length,
    backed: finalRules.filter((r) => r.backed >= 6).length,
    precedents,
    filesRead,
    filesSkipped,
    quarantined,
    bySource,
    rulesList: finalRules,
  };
}

/* A static import, not a require().
 *
 * The first version reached for `require` here to dodge a circular-looking
 * import, and it cost an install: `bun build --compile` could no longer thread
 * the top-level await in pricing.ts through db.ts, and the packaged server
 * failed to build with an error naming neither this file nor the require. The
 * import is not actually circular — understudy.ts does not know about this
 * module — so there was nothing to dodge. */
function countByClass(): Record<string, number> {
  try {
    return precedentsByClass();
  } catch {
    return {};
  }
}

/**
 * What a rule's provenance is allowed to say.
 *
 * A KIND, never a path — and this cost a leak to learn. The first version wrote
 * `~/.claude/projects/-home-you-code-<employer>/memory/foo.md` into the
 * compiled policy, and 151 copies of an employer's name went into a generated
 * file. The private-terms gate did not catch it and could not have: the gate
 * runs over the TEXT of a rule, and this was the label beside it.
 *
 * A path is also the wrong thing on its own terms. What a reader needs is "you
 * wrote this in your conventions in August", not which directory it sat in, and
 * the moment provenance stops being a path there is nothing left in it that
 * could identify a private project.
 */
export function provenanceOf(p: string): string {
  const f = basename(p);
  if (f === "CLAUDE.md") return "your conventions";
  /*
   * NOT "a skill you wrote", which is what this said and which was false.
   *
   * `~/.claude/skills` holds whatever is installed there, and on this machine
   * three of the five came from elsewhere — one of them installed by this very
   * app. Their rules were being presented as the person's own: an answer to
   * "what do you know about me" came back with somebody else's opinions about
   * paginating an API, over a line claiming they had written it.
   *
   * There is no way to know who wrote a file, so it stops claiming to. The
   * skill's own name goes in instead, which is the thing that actually lets a
   * person recognise a stranger's rule and exclude it.
   */
  if (p.includes("/skills/")) {
    const seg = p.split("/skills/")[1]?.split("/")[0] ?? "";
    return seg ? `a skill on your machine (${seg})` : "a skill on your machine";
  }
  if (f.startsWith("feedback")) return "a correction you recorded";
  if (f.startsWith("bug")) return "a bug you wrote up";
  if (f.startsWith("project")) return "a project note";
  if (f.startsWith("reference")) return "a reference note";
  if (p.includes("/memory/")) return "project memory";
  if (/\/worklog\//.test(p) || p.includes("daily-worklog")) return "your worklog";
  if (f === ".gitconfig" || f === ".tmux.conf" || p.includes("/fish/") || f === ".zshrc" || f === ".bashrc") return "your shell and tool setup";
  if (f === "settings.json") return "your agent settings";
  if (p.includes("/Documents/notes/")) return "a note you keep";
  if (p.includes("/Documents/projects/")) return "evidence you assembled for a piece of work";
  return "a file you allowed";
}

function fileTime(p: string): number {
  try {
    return statSync(p).mtimeMs;
  } catch {
    return Date.now();
  }
}

/**
 * Which partition a path belongs to.
 *
 * Everything that is not demonstrably the open project is treated as closed.
 * The default matters more than the detection: a path we cannot place is not
 * "probably fine", it is unknown, and unknown material is kept out of the open
 * partition where it could be retrieved for a public repository.
 */
/**
 * Is this the open project, by name?
 *
 * A segment test rather than a substring one: `orbit` must match `orbit`,
 * `orbit-feature` and `orbit/server`, and must not match `orbital-private`.
 * That is the difference between "the project and its worktrees" and "anything
 * with those letters in it".
 */
function sameProject(name: string): boolean {
  const open = openProjectName().trim().toLowerCase();
  if (!open) return false;
  return name.toLowerCase().split(/[^a-z0-9]+/).includes(open);
}

function partitionOf(path: string): string {
  /*
   * THE SETTING, not this application's own name.
   *
   * Both sites here matched a literal project name, which is a fact about one
   * machine rather than about the software. Pointed at any other project, the
   * open partition would have collected THIS repository's material and filed
   * the project actually being worked on as closed — and a closed precedent is
   * never retrieved, so the effect is a bank that quietly learns the wrong
   * repository.
   *
   * It survived the conversion that fixed four other files because the guard
   * that catches it listed those four by name.
   */
  return isOpenProjectPath(path) ? OPEN_PARTITION : "closed";
}

function bankTranscript(text: string, file: string, partition: string, source: string) {
  let banked = 0;
  let quarantined = 0;
  const ref = basename(file, ".jsonl");
  const lines = text.split("\n");
  let i = 0;
  for (const line of lines) {
    if (!line || line.length < 40) continue;
    const turn = humanTurn(line);
    i++;
    if (!turn) continue;
    if (turn.text.length > 400) continue;
    if (FILLER.test(turn.text) || isPastedOutput(turn.text)) continue;
    if (isForbidden(turn.text)) continue;
    const clean = translate(turn.text);
    if (privateTermsGate(clean)) {
      quarantined++;
      continue;
    }
    /*
     * `general` used to be dropped here, and there was never a reason for it:
     * every other source in this file banks its general rows quite happily, and
     * they are the majority of the bank. Dropping them cost another 15% of the
     * transcripts on top of the 68% the gate above was taking.
     */
    const cls = classify(clean);
    const id = addPrecedent({
      cls,
      partition,
      situation: "a turn you typed",
      decision: clean.slice(0, 160),
      hisWords: clean,
      source,
      sourceRef: `${sha256(ref).slice(0, 10)}:${i}`,
      provenance: "typed",
      at: turn.at || fileTime(file),
      // A turn that settles something outranks one that asks a question, but
      // only by a little — the question is still how this person talks.
      weight: DECISIVE.test(clean) ? 1.3 : 0.9,
    });
    if (id) banked++;
  }
  return { banked, quarantined };
}

/*
 * Precedents out of a note.
 *
 * These went through the worklog banker at first and the numbers looked fine,
 * which is exactly how that kind of mistake survives. The worklog banker keeps
 * only lines starting `working` / `worked` / `pr` / `review` — the scrum shape
 * — and a note is not that shape at all. Everything else in the folder was
 * being dropped silently, and a source that reports precedents while discarding
 * most of the file is worse than one that reports none.
 *
 * A note is prose somebody kept, so what is worth banking is a line that STATES
 * something: a finding, a decision, a measurement, a conclusion. The filter is
 * length plus a verb, and the headings come along because in this person's
 * notes the heading is usually the conclusion.
 */
function bankNotes(text: string, file: string, partition: string, source: string) {
  let banked = 0;
  let quarantined = 0;
  const topic = basename(file).replace(/\.md$/, "").replace(/[-_]/g, " ");
  const at = fileTime(file);
  let n = 0;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.length < 30 || line.length > 400) continue;
    if (line.startsWith("```") || line.startsWith("|") || /^https?:\/\//.test(line)) continue;
    const bare = line.replace(/^#+\s*/, "").replace(/^[-*>]\s*/, "").replace(/\*\*/g, "").trim();
    if (bare.length < 30) continue;
    // A statement has a verb in it. A fragment, a path or a bare list of nouns
    // does not, and banking those fills the bank with things that cannot be
    // retrieved against anything.
    if (!/\s(is|was|are|were|has|have|does|did|should|must|never|always|es|era|fue|hay|tiene|debe|hace|no)\s/i.test(` ${bare} `)) continue;
    if (isForbidden(bare)) continue;
    const clean = translate(bare);
    if (privateTermsGate(clean)) { quarantined++; continue; }
    const id = addPrecedent({
      cls: classify(clean),
      partition,
      situation: `a note about ${topic}`,
      decision: clean.slice(0, 160),
      hisWords: clean,
      source,
      sourceRef: `${sha256(file).slice(0, 8)}:${n}`,
      provenance: "typed",
      at,
      weight: 1,
    });
    n++;
    if (id) banked++;
  }
  return { banked, quarantined };
}

function bankWorklog(text: string, file: string, partition: string, source: string) {
  let banked = 0;
  let quarantined = 0;
  const day = basename(file, ".md");
  text.split("\n").forEach((raw, i) => {
    const line = raw.trim().replace(/^[-*]\s*/, "");
    if (line.length < 16 || line.length > 400) return;
    if (!/^(working|worked|pr|review|merged|deploy)/i.test(line)) return;
    if (isForbidden(line)) return;
    const clean = translate(line);
    if (privateTermsGate(clean)) {
      quarantined++;
      return;
    }
    const id = addPrecedent({
      cls: classify(clean),
      partition,
      situation: `worklog ${day}`,
      decision: clean.slice(0, 160),
      hisWords: clean,
      source,
      sourceRef: `${day}:${i}`,
      provenance: "typed",
      at: Date.parse(day) || fileTime(file),
      weight: 1.2,
    });
    if (id) banked++;
  });
  return { banked, quarantined };
}

/**
 * A memory store, read read-only.
 *
 * The shape this expects, and the whole contract: a table `observations` with
 * `id`, `type`, `content`, `project` and `created_at`. Any sqlite that answers
 * it can be added as a source of the user's own; anything else falls into the
 * catch below and reads as empty, which is the honest answer for a file this
 * cannot understand. No tool is named here — the name and the path are the
 * person's, and this repository is public.
 *
 * Observations are the densest rule material on a machine — somebody wrote
 * each one down on purpose, with the reason attached — so they become rules
 * AND precedents: the text is an instruction, and the fact that it was
 * recorded on a particular day about a particular project is a case.
 */
function ingestObservationsDb(src: UnderstudySource, at: number) {
  const rules: Rule[] = [];
  let precedents = 0;
  let quarantined = 0;
  try {
    const dbro = new Database(src.path, { readonly: true });
    const rows = dbro
      .query<{ id: number; type: string; content: string; project: string | null; created_at: string | null }, []>(
        `SELECT id, type, content, project, created_at FROM observations ORDER BY id DESC LIMIT 1500`,
      )
      .all();
    for (const r of rows) {
      const raw = (r.content || "").trim();
      if (!raw || raw.length < 24) continue;
      if (isForbidden(raw)) continue;
      const clean = translate(raw.slice(0, 1200));
      if (privateTermsGate(clean)) {
        quarantined++;
        continue;
      }
      const cls = classify(clean);
      const when = r.created_at ? Date.parse(r.created_at) || at : at;
      if (/convention|feedback|decision|architecture/i.test(r.type)) {
        const first = clean.split("\n").find((l) => l.trim().length > 24) ?? clean;
        rules.push({ id: `R${sha256(first).slice(0, 10)}`, cls, text: first.slice(0, 400), src: src.id, at: when, backed: 0 });
      }
      if (cls !== "general") {
        const id = addPrecedent({
          cls,
          // A project NAME here rather than a path, so it is compared with the
          // open project's name — same setting, different shape of answer.
          partition: sameProject(r.project || "") ? OPEN_PARTITION : "closed",
          situation: `${src.id} ${r.type}`,
          decision: clean.split("\n")[0]!.slice(0, 160),
          hisWords: clean.slice(0, 240),
          source: src.id,
          sourceRef: String(r.id),
          provenance: "typed",
          at: when,
          weight: 1.4,
        });
        if (id) precedents++;
      }
    }
    dbro.close();
  } catch { /* absent, or a different shape: a normal, empty answer */ }
  return { rules, precedents, quarantined };
}

/* ─────────────────────────────────────── policy ─────────────────────────── */

/**
 * Write the compiled policy out as files a person can read and edit.
 *
 * Files rather than rows, because the policy is the part of this system a human
 * is supposed to argue with. A table you have to query to see what the thing
 * believes about you is a table nobody ever looks at.
 */
function writePolicy(rules: Rule[], at: number): void {
  const dir = policyDir();
  try {
    mkdirSync(join(dir, "playbooks"), { recursive: true });
    /*
     * The same rules, in a shape code can read.
     *
     * The markdown below is for a person to open and argue with, which is the
     * point of compiling to files at all — but it is a terrible thing to parse,
     * and for a year nothing read these rules back at all. A sibling JSON file
     * costs nothing and means the rules can answer a question rather than only
     * sit there being auditable.
     */
    writeFileSync(
      join(dir, "rules.json"),
      JSON.stringify({ at, rules: rules.map((r) => ({ id: r.id, cls: r.cls, text: r.text, src: r.src, backed: r.backed })) }),
    );
    const byClass = new Map<string, Rule[]>();
    for (const r of rules) {
      const list = byClass.get(r.cls) ?? [];
      list.push(r);
      byClass.set(r.cls, list);
    }
    const stamp = new Date(at).toISOString();
    writeFileSync(
      join(dir, "constitution.md"),
      [
        "# What it believes about you",
        "",
        `Compiled ${stamp} from the sources you allowed. This file is generated —`,
        "edit the memory files it came from, not this, or the next compile will",
        "overwrite you.",
        "",
        `${rules.length} rules across ${byClass.size} classes.`,
        "",
        ...[...byClass.entries()]
          .sort((a, b) => b[1].length - a[1].length)
          .map(([cls, list]) => `- **${cls}** — ${list.length} rules`),
        "",
      ].join("\n"),
    );
    for (const [cls, list] of byClass) {
      const def = CLASSES.find((c) => c.id === cls);
      writeFileSync(
        join(dir, "playbooks", `${cls}.md`),
        [
          `# ${cls} — ${def?.label ?? "general"}`,
          "",
          `Compiled ${stamp}. ${list.length} rules.`,
          "",
          ...list.map((r, i) =>
            [
              `${cls}.${i + 1}  ${r.text}`,
              `        [src: ${r.src} · ${new Date(r.at).toISOString().slice(0, 10)}` +
                (r.backed >= 6 ? `; precedents: ${r.backed}]` : `; precedents: ${r.backed} — UNBACKED]`),
              "",
            ].join("\n"),
          ),
        ].join("\n"),
      );
    }
  } catch { /* a policy we could not write is reported as zero rules, not as a crash */ }
}

/** What the last compile produced, for the panel. */
export function policySummary(): { rules: number; classes: number; at: number } | null {
  try {
    const f = join(policyDir(), "constitution.md");
    if (!existsSync(f)) return null;
    const text = readFileSync(f, "utf8");
    const m = /^(\d+) rules across (\d+) classes/m.exec(text);
    return { rules: Number(m?.[1] ?? 0), classes: Number(m?.[2] ?? 0), at: fileTime(f) };
  } catch {
    return null;
  }
}
