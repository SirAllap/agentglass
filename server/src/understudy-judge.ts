/*
 * Judgement, for the cases the tables decline.
 *
 * Everything else here is counting. Counting answers "what did he do the last
 * nine times this exact shape came up" and it answers it well — the backtest
 * puts C3 at ninety per cent against a fifty per cent baseline. What counting
 * cannot do is generalise: a situation nobody has classified, a card written
 * this morning, a shape seen twice. For those the tables correctly decline, and
 * declining forever is not standing in for somebody.
 *
 * WHAT THIS IS AND WHAT IT IS NOT. It is a reader, not an actor. It is invoked
 * with NO TOOLS AT ALL — the argv carries an empty allowlist and a permission
 * mode that prompts, and there is no terminal to prompt at, so a tool call
 * cannot succeed even if one were attempted. Text goes in, a verdict comes out.
 * It cannot read a file, run a command, or reach the network on its own account.
 *
 * WHAT IT IS GIVEN. Only material that has already been through the
 * private-terms gate on its way into the bank — the rules and precedents this
 * person allowed, already translated. Not the raw files, not the paths, not the
 * transcripts. The prompt is assembled here so that what leaves is exactly what
 * this file put in it and can be read in one screen.
 *
 * AND IT IS OFF BY DEFAULT. The counting predictor runs entirely on this
 * machine; this one sends a prompt to a model. He uses that same channel by
 * hand every day, which is why it is the channel chosen rather than some new
 * service with a new key — but him typing into it and this app doing so on his
 * behalf while he is away are different acts, and the second one is his to
 * switch on.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { classOf, retrieve, judgeEnabled, privateTermsGate, translate, termsStatus, type Precedent } from "./understudy.ts";
import { compiledRules } from "./understudy-ask.ts";

const claudeBin = () => Bun.which("claude");

export const JUDGE_AVAILABLE = () => !!claudeBin();

export interface Verdict {
  /** What it thinks he would do, in his terms. Empty when it declines. */
  answer: string;
  /** 0..1, self-reported and treated as such. */
  confidence: number;
  why: string;
  /** True when it would rather not say. */
  declined: boolean;
  /** What went wrong, when something did. */
  error?: string;
}

const DECLINE: Verdict = { answer: "", confidence: 0, why: "", declined: true };

/*
 * THE ONLY PLACE ANYTHING LEAVES THIS MACHINE, and until now the only place
 * that did not check what was in it.
 *
 * Everything else the understudy holds went through the private-terms gate on
 * its way into the bank: translated where there is an agreed substitute,
 * dropped where there is not. The judge was reading from the bank for its rules
 * and precedents — already clean — and then adding two things that had never
 * been near the gate: file PATHS off the working tree, and the subjects of
 * recent commits.
 *
 * On a machine where the scope has been widened to somebody's real work, that
 * is a repository layout and a list of ticket numbers going to a model. Not a
 * catastrophe and not defensible either, and the gate exists precisely so that
 * nobody has to decide in the moment which it is.
 *
 * DROPPED, NEVER MASKED PAST THE GATE. A line that still trips it after
 * translation does not go in a shortened form, it does not go at all: half a
 * sentence with the identifying half removed is a judgement about which half
 * identified it, and that judgement is what the gate is there to avoid making.
 */
function safeLines(lines: string[]): string[] {
  const out: string[] = [];
  for (const line of lines) {
    const clean = translate(line);
    if (privateTermsGate(clean)) continue;
    out.push(clean);
  }
  return out;
}

/*
 * And it refuses to send anything at all without a terms list.
 *
 * The same rule the ingest already follows, for the same reason: with no list
 * there is no way to tell "checked, clean" from "could not check", and the
 * second is not something to guess at on the one path that reaches a network.
 */
function termsReady(): boolean {
  return termsStatus().ok;
}


/*
 * The prompt, and every line of it is a constraint.
 *
 * It is told to answer AS him from the evidence, to say plainly when the
 * evidence does not cover the case, and to return JSON. The last one is not
 * about parsing convenience: a free-text answer would have to be interpreted
 * here, and interpretation is where a "no" quietly becomes a "yes".
 */
function buildPrompt(q: { situation: string; cls: string }, rules: string[], cases: Precedent[]): string {
  const label = classOf(q.cls)?.label ?? q.cls;
  // The question itself is typed by the person, so it has never been near the
  // gate either — and it is the line most likely to name something.
  const situation = safeLines([q.situation])[0] ?? "(withheld)";
  const said = safeLines(cases.map((c) => c.hisWords || c.decision));
  return [
    "You are helping decide what ONE specific person would do, using only the evidence below.",
    "It is their own writing and their own past decisions. Do not use general best practice;",
    "if their evidence contradicts what you would advise, follow their evidence.",
    "",
    `THE SITUATION (${q.cls} — ${label}):`,
    situation,
    "",
    "WHAT THEY HAVE WRITTEN DOWN:",
    ...(rules.length ? rules.map((r) => `- ${r}`) : ["- (nothing on record)"]),
    "",
    "WHAT THEY ACTUALLY DID IN SIMILAR CASES:",
    ...(said.length ? said.map((c) => `- ${c}`) : ["- (nothing on record)"]),
    "",
    "Answer with JSON only, no prose around it:",
    '{"answer": "<what they would do, one sentence, in their terms>",',
    ' "confidence": <0 to 1>,',
    ' "why": "<which piece of the evidence decides it>",',
    ' "declined": <true if the evidence does not really cover this>}',
    "",
    "Decline rather than guess. An invented answer attributed to somebody is worse",
    "than no answer, because from outside the two look identical.",
  ].join("\n");
}

/** Pull the JSON object out of whatever came back. */
function parseVerdict(text: string): Verdict {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return { ...DECLINE, error: "no verdict in the reply" };
  try {
    const o = JSON.parse(text.slice(start, end + 1)) as Partial<Verdict>;
    const declined = o.declined === true || !o.answer;
    return {
      answer: declined ? "" : String(o.answer).slice(0, 400),
      confidence: declined ? 0 : Math.max(0, Math.min(1, Number(o.confidence) || 0)),
      why: String(o.why ?? "").slice(0, 400),
      declined,
    };
  } catch {
    return { ...DECLINE, error: "the reply was not the shape it was asked for" };
  }
}

/**
 * Ask, with a hard timeout and no tools.
 *
 * The timeout is short and it kills rather than waits: this runs inside a
 * request, and a judgement that takes a minute is a judgement nobody wanted by
 * the time it lands. Declining is always an acceptable answer here, so failing
 * closed costs nothing.
 */
export async function judge(
  q: { situation: string; cls: string; partition: string },
  opts: { timeoutMs?: number } = {},
): Promise<Verdict> {
  if (!judgeEnabled()) return { ...DECLINE, why: "judgement is switched off" };

  if (!termsReady()) {
    return { ...DECLINE, why: "there is no private-terms list, so it will not send anything" };
  }
  const rules = safeLines(compiledRules().filter((r) => r.cls === q.cls).slice(0, 8).map((r) => r.text));
  const cases = retrieve({ cls: q.cls, partition: q.partition, text: q.situation, limit: 6 });
  if (!rules.length && !cases.length) {
    // Nothing of the owner's to reason from. Asking anyway would produce a
    // fluent answer that is about nobody in particular, which is the exact
    // failure this whole feature is built to avoid.
    return { ...DECLINE, why: "it has nothing of yours on this" };
  }
  // The CLI is looked for last: a decline for want of a list or of material
  // is the same decline on a machine with no `claude` at all, and it says why.
  const bin = claudeBin();
  if (!bin) return { ...DECLINE, error: "no local claude CLI" };

  /*
   * NO TOOLS. An empty allowlist plus a prompting permission mode, and no
   * terminal for it to prompt at — so a tool call cannot succeed even if the
   * model tried one. `--dangerously-skip-permissions` is deliberately absent
   * and must stay absent: this reads and answers, and that is all.
   */
  const argv = [
    bin, "-p",
    "--output-format", "text",
    "--permission-mode", "default",
    "--allowedTools", "",
  ];

  const timeoutMs = Math.max(5_000, Math.min(60_000, opts.timeoutMs ?? 25_000));
  const room = judgeRoom();
  if (!room) return { ...DECLINE, error: "no private directory to run in" };
  try {
    const p = Bun.spawn(argv, {
      stdin: new TextEncoder().encode(buildPrompt(q, rules, cases)),
      stdout: "pipe",
      stderr: "ignore",
      cwd: room.cwd,
      env: { ...process.env, CLAUDE_CONFIG_DIR: room.config },
    });
    const timer = setTimeout(() => { try { p.kill(); } catch { /* already gone */ } }, timeoutMs);
    const text = await new Response(p.stdout).text();
    await p.exited;
    clearTimeout(timer);
    if (!text.trim()) return { ...DECLINE, error: "it returned nothing" };
    return parseVerdict(text);
  } catch (e) {
    return { ...DECLINE, error: String(e instanceof Error ? e.message : e) };
  } finally {
    room.done();
  }
}

/**
 * Where the judge runs, and it is not /tmp.
 *
 * The working directory was /tmp, on the reasoning that somewhere with nothing
 * in it gives a stray tool attempt nothing to find. The reasoning was about the
 * repository and missed the CLI: Claude Code reads from its working directory
 * before the prompt arrives — `CLAUDE.md` into the context, `.claude/settings.json`
 * for hooks (each one a shell command it runs for you), `.mcp.json` for tool
 * servers. /tmp is world-writable. Any other account on the machine could drop
 * those three files there and have every judgement run its hook, or read its
 * instructions, with "no tools" doing nothing about it because a hook is not a
 * tool call.
 *
 * So each call gets a directory of its own, mode 0700, under this app's state
 * dir — the same base understudy-pane.ts uses for the clone's config — made
 * with mkdtemp so two judgements never share one, and removed when the answer
 * is in. Nothing else can write there and nothing is there to read.
 *
 * `CLAUDE_CONFIG_DIR` is pointed at a private directory too, for the reason
 * understudy-pane.ts measured: his own config carries fourteen kinds of hook,
 * every one of which fired on a run that is not a conversation with him. NOT
 * an empty one, though — the credential lives in that directory, and an
 * empty config dir on an install signed in through the browser is a judge
 * that cannot answer. The credential file is symlinked, exactly as the pane
 * does it, so a token he rotates is rotated here and there is no second copy.
 * The directory is stable across calls (a symlink, not a session), while the
 * cwd is per call.
 */
function judgeRoom(): { cwd: string; config: string; done: () => void } | null {
  try {
    const base = process.env.AGENTGLASS_STATE_DIR
      || join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "agentglass");
    const rooms = join(base, "judge");
    mkdirSync(rooms, { recursive: true, mode: 0o700 });
    const cwd = mkdtempSync(join(rooms, "run-"));
    const config = join(base, "judge-claude");
    mkdirSync(config, { recursive: true, mode: 0o700 });
    const cred = join(homedir(), ".claude", ".credentials.json");
    const here = join(config, ".credentials.json");
    if (existsSync(cred) && !existsSync(here)) symlinkSync(cred, here);
    return { cwd, config, done: () => { try { rmSync(cwd, { recursive: true, force: true }); } catch { /* already gone */ } } };
  } catch {
    return null;
  }
}
