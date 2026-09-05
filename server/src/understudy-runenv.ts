/*
 * WHAT A RUN MAY NOT REACH, as environment rather than as a sentence.
 *
 * The three ladders that start an agent all run it with permissions skipped,
 * unattended, at night. The only thing standing between one of them and a
 * `git push` was a line in the brief — and this repository says, in its own
 * words, that a rule is not a mechanism. A prompt injection out of a pull
 * request body is enough to reach a rule; it is not enough to reach this.
 *
 * WHAT IS FENCED, and how each one is actually shut:
 *
 *   - `git push` over https — `credential.helper` is emptied, so nothing can
 *     mint a token, AND every push url is rewritten to a host that does not
 *     resolve. Either alone would be enough; both, because the first fails
 *     with a prompt and the second fails with a name.
 *   - `git push` over ssh — the agent socket is taken away and the ssh forms
 *     are rewritten too, so a remote added by hand inside the run cannot get
 *     out either.
 *   - `gh` — its config directory is pointed at an empty one inside the run,
 *     and the token variables are cleared. `gh pr create`, `gh pr comment`,
 *     `gh release upload`: all of them ask who you are first, and get nobody.
 *   - EVERY OTHER SECRET IN THE OPERATOR'S SHELL. The hidden ladder runs the
 *     agent with `{...process.env, ...this}`, and the pane ladders open a
 *     window on a tmux server that inherited the same shell. Measured on the
 *     shell this server is started from, names only: with the three variables
 *     above blanked, a `--dangerously-skip-permissions` run still inherited
 *     the tracker's API key, the desktop app's own machine token and the
 *     messaging token of the operator's live agent session — three
 *     credentials, none of them git's. A fence that takes the `gh` login and
 *     leaves the tracker's key is a fence with one plank. So every variable
 *     whose NAME says it is a credential is blanked — see SECRET_NAME — plus
 *     the alert webhook by name, and the run keeps the one it cannot start
 *     without, listed in KEPT.
 *
 * WHAT IS NOT, and is deliberate:
 *
 *   - `git fetch` and `git clone` over https keep working. The project is
 *     public, so they need no credential, and a run that cannot read the
 *     remote cannot rebase.
 *   - The commit identity survives. This is why the git side is
 *     `GIT_CONFIG_COUNT` and never `GIT_CONFIG_GLOBAL`: the global file also
 *     holds `user.name` and `core.hooksPath`, and replacing it would leave
 *     the run committing as nobody with the private-terms hook switched off —
 *     a fence that opens a worse hole than it shuts.
 *   - Anything the agent reaches that is not git or gh. This closes the
 *     publishing routes the project actually uses, not every route that could
 *     be imagined.
 *   - A secret whose name does not say so. `MY_CONFIG=hunter2` walks through.
 *     The list below is the conventions the tools this machine runs actually
 *     use, not a claim to know every name a secret can wear.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";

/** A url no resolver answers. Not `localhost`: something may be listening. */
const NOWHERE = "https://refused.invalid/";

/**
 * A variable name that says "credential".
 *
 * Suffixes first — `_TOKEN`, `_KEY`, `_SECRET`, `_PASSWORD`, `_CREDENTIALS` —
 * which is how most tools spell one, then the vendor prefixes whose whole
 * namespace is authentication: a cloud provider's `AWS_*` carries the key pair
 * and the session token under names that do not all end in `_KEY`. Case-blind,
 * because `Github_Token` is a real thing people export.
 */
export const SECRET_NAME =
  /(_TOKEN|_KEY|_SECRET|_PASSWORD|_PASS|_CREDENTIALS?|_API_KEY|^AWS_|^AZURE_|^GOOGLE_APPLICATION|^OPENAI_|^ANTHROPIC_API|^CLICKUP|^SLACK_|^DISCORD_|^NPM_TOKEN|^PYPI|^DOCKER_)/i;

/**
 * Blanked by name whatever the regexp says: the one url a run must not hold.
 * `AGENTGLASS_WEBHOOK` is where this server posts alerts; a run holding it can
 * post an alert of its own wording to the same channel, and nothing on the
 * receiving end can tell the two apart.
 */
const ALWAYS_BLANK = ["AGENTGLASS_WEBHOOK"];

/**
 * What matches SECRET_NAME and is handed to the run anyway.
 *
 * Every name here is a variable the run itself needs to START, not one it
 * merely finds useful, and each earns its line:
 *
 *   `ANTHROPIC_API_KEY` — the credential the agent CLI spends. On an install
 *     signed in through the browser it is absent and nothing is kept; on an
 *     install that authenticates with a key, blanking it is not containment,
 *     it is no run at all. The process holding it is the process being fenced,
 *     which is the one place a fence cannot reach by construction.
 *   `AGENTGLASS_TOKEN` / `AGENTGLASS_READ_TOKEN` — NOT kept from the shell. The
 *     fence blanks the machine token like any other, and index.ts then writes
 *     the run's own read-scoped token over both names AFTER the fence, which is
 *     the order that makes the substitution rather than the leak win. They are
 *     listed here so that the next reader does not add them.
 */
const KEPT = new Set(["ANTHROPIC_API_KEY"]);

/** Every name in `from` a run may not carry, blanked. Pure, so a test can hand
 *  it a shell of its own making rather than reading this process's. */
export function secretsBlanked(from: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of Object.keys(from)) {
    if (KEPT.has(name)) continue;
    if (SECRET_NAME.test(name)) out[name] = "";
  }
  for (const name of ALWAYS_BLANK) out[name] = "";
  return out;
}

/**
 * The environment a run is given, on top of whatever it already carries.
 *
 * `runDir` is a directory this run owns; the empty `gh` config goes inside it,
 * so two runs never share one and nothing is left behind in the user's own.
 *
 * `from` is the shell the run would otherwise inherit — this process's, unless
 * a test hands in one of its own. The fence can only blank a name it can see,
 * so it has to look at the same environment the spawn will copy.
 */
export function understudyRunEnv(runDir: string, from: Record<string, string | undefined> = process.env): Record<string, string> {
  const ghDir = join(runDir, "gh");
  try { mkdirSync(ghDir, { recursive: true, mode: 0o700 }); } catch { /* a run with no writable dir still gets the git fence */ }

  /* Repeated keys are how git expresses a multi-valued setting, and
     `pushInsteadOf` has to name every form a remote can take: the https url
     this project uses, the scp-style `git@host:owner/repo`, and `ssh://`. */
  const git: [string, string][] = [
    ["credential.helper", ""],
    [`url.${NOWHERE}.pushInsteadOf`, "https://"],
    [`url.${NOWHERE}.pushInsteadOf`, "git@"],
    [`url.${NOWHERE}.pushInsteadOf`, "ssh://"],
  ];
  const env: Record<string, string> = {
    /* The by-name blanks first, so the explicit ones below win on a collision
       — they are the same value, but the order says which list is the rule. */
    ...secretsBlanked(from),
    GH_CONFIG_DIR: ghDir,
    GH_TOKEN: "",
    GITHUB_TOKEN: "",
    GH_ENTERPRISE_TOKEN: "",
    SSH_AUTH_SOCK: "",
    GIT_CONFIG_COUNT: String(git.length),
  };
  git.forEach(([k, v], i) => { env[`GIT_CONFIG_KEY_${i}`] = k; env[`GIT_CONFIG_VALUE_${i}`] = v; });
  return env;
}
