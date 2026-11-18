/*
 * The matching behind the agent rules, as a pure question: what a rule list
 * decides for one tool call, which edits hand an agent more, and what a person
 * would write as the rule for a call.
 */
import { describe, expect, test } from "bun:test";
import { BASE_RULES, BLOCK_ROLE, blockRole, decide, inForceFor, isLooser, isWrapper, isLooserMode, ruleFor, seatChecksRule, seatDelegatesRule, seatRules, SEAT_DELEGATES_ID, SEAT_DELEGATES_MATCHES, shellSegments, type AgentRule, type RuleSetting } from "../../shared/agentRules.ts";

/** The CLI's own `--role` choices, from the parser `agentglass-agent start --help` prints. */
const CLI = await Bun.file(new URL("../../bin/agentglass-agent", import.meta.url)).text();

const ROOT = "/work/acme/orbit";
let n = 0;
const rule = (match: string, setting: RuleSetting, project = "*"): AgentRule =>
  ({ id: `ar_${n++}`, project, action: `a${n}`, match, setting, source: "you", by: "you", at: 1 });
const base = BASE_RULES.map((b) => rule(b.match, b.setting));

describe("decide", () => {
  test("a project's own never beats the base allow for the same pattern", () => {
    const rules = [rule("Bash(git push:*)", "allow"), rule("Bash(git push:*)", "never", ROOT)];
    expect(decide(rules, ROOT, "Bash", { command: "git push origin main" }).decision).toBe("never");
    // another project keeps the base allow
    expect(decide(rules, "/work/acme/other", "Bash", { command: "git push origin main" }).decision).toBe("allow");
  });

  test("a project's own allow speaks for it over the base never", () => {
    const rules = [rule("Bash(gh pr merge:*)", "never"), rule("Bash(gh pr merge:*)", "allow", ROOT)];
    expect(decide(rules, ROOT, "Bash", { command: "gh pr merge 3" }).decision).toBe("allow");
  });

  test("merging hides nowhere in a compound line", () => {
    for (const command of ["cd x && gh pr merge 3", "echo \"$(gh pr merge 1)\"", "x=`gh pr merge 2`", "cat <<X\n$(gh pr merge 3)\nX", "echo hi; gh pr merge 3", "true | gh pr merge 3", "FOO=1 gh pr merge 3", "(gh pr merge 3)"]) {
      const d = decide(base, ROOT, "Bash", { command });
      expect(d.decision, command).toBe("never");
      expect(d.reason).toContain("gh pr merge");
    }
  });

  test("a prefix rule matches at a word boundary: `git push:*` is not `git pushy`", () => {
    const rules = [rule("Bash(git push:*)", "never")];
    expect(decide(rules, ROOT, "Bash", { command: "git push" }).decision).toBe("never");
    expect(decide(rules, ROOT, "Bash", { command: "git push -f" }).decision).toBe("never");
    expect(decide(rules, ROOT, "Bash", { command: "git pushy" }).decision).toBe("unknown");
  });

  test("a broad project allow does not loosen a narrower base never", () => {
    for (const broad of ["Bash(gh pr:*)", "Bash(gh:*)", "Bash"]) {
      const rules = [...base, rule(broad, "allow", ROOT)];
      expect(decide(rules, ROOT, "Bash", { command: "gh pr merge 12" }).decision, broad).toBe("never");
      expect(decide(rules, ROOT, "Bash", { command: "gh release create v1" }).decision, broad).toBe("never");
      expect(decide(rules, ROOT, "Bash", { command: "gh pr view 3" }).decision, broad).toBe("allow");
    }
    // a broad ask cannot turn the never into an ask either
    expect(decide([...base, rule("Bash(gh pr:*)", "ask", ROOT)], ROOT, "Bash", { command: "gh pr merge 12" }).decision).toBe("never");
    // the narrower one speaks: an allow on one subcommand under a broad never
    const narrow = [rule("Bash(npm:*)", "never", ROOT), rule("Bash(npm test:*)", "allow", ROOT)];
    expect(decide(narrow, ROOT, "Bash", { command: "npm test" }).decision).toBe("allow");
    expect(decide(narrow, ROOT, "Bash", { command: "npm publish" }).decision).toBe("never");
  });

  test("what is in force for a pattern is read through the rule that speaks for its calls", () => {
    expect(inForceFor(base, ROOT, "Bash(gh pr merge 1:*)")).toBe("never");
    expect(inForceFor(base, ROOT, "Bash(gh pr:*)")).toBeNull();
    expect(inForceFor(base, "*", "Bash(git push:*)")).toBe("allow");
  });

  test("an ask survives a chain: the strictest command of the line wins", () => {
    const rules = [...base, rule("Bash(npm publish:*)", "ask", ROOT), rule("Bash(npm run:*)", "allow", ROOT)];
    for (const command of ["npm publish", "cd pkg && npm publish", "npm run build && npm publish", "npm publish; echo done", "echo y | npm publish", "git push && npm publish"]) {
      expect(decide(rules, ROOT, "Bash", { command }).decision, command).toBe("ask");
    }
    // a command no rule covers outweighs an allow, and a never outweighs everything
    expect(decide(rules, ROOT, "Bash", { command: "npm run build && make" }).decision).toBe("unknown");
    expect(decide(rules, ROOT, "Bash", { command: "npm publish && gh pr merge 1" }).decision).toBe("never");
  });

  test("a heredoc body is text: an ask does not fire on it, a never still does", () => {
    const rules = [...base, rule("Bash(gh pr review:*)", "ask", ROOT)];
    const notes = "cat > notes.md <<EOF\n- the tab ended on `gh pr review 12 --approve`\nEOF";
    expect(decide(rules, ROOT, "Bash", { command: notes }).decision).toBe("unknown");
    // the same words on a command line, or after the body, are the call they look like
    expect(decide(rules, ROOT, "Bash", { command: "gh pr review 12" }).decision).toBe("ask");
    expect(decide(rules, ROOT, "Bash", { command: `${notes}\ngh pr review 12` }).decision).toBe("ask");
    // a quoted tag runs nothing; an unquoted one runs its substitutions, so a never still stops one
    expect(decide(rules, ROOT, "Bash", { command: "cat > notes.md <<'EOF'\ngh pr review 12\nEOF" }).decision).toBe("unknown");
    expect(decide(base, ROOT, "Bash", { command: "cat <<X\n$(gh pr merge 1)\nX" }).decision).toBe("never");
  });

  test("a wrapper does not hide the command it runs", () => {
    for (const command of ["env X=1 gh pr merge 1", "env -u HOME gh pr merge 1", "sudo gh pr merge 1", "sudo -u ci gh pr merge 1", "command gh pr merge 1",
      "nice -n 5 gh pr merge 1", "nohup gh pr merge 1", "timeout 60 gh pr merge 1", "timeout -s KILL 5m gh pr merge 1", "stdbuf -oL gh pr merge 1",
      "echo 1 | xargs -n1 gh pr merge", "exec gh pr merge 1", 'bash -c "gh release create v1"', "sh -c 'cd x && gh pr merge 1'",
      "bash -lc 'gh pr merge 1'", "eval 'gh pr merge 1'", "sudo bash -c 'env A=1 gh pr merge 1'"]) {
      expect(decide(base, ROOT, "Bash", { command }).decision, command).toBe("never");
    }
    // a learned allow on the wrapper is no allow on what it runs
    for (const w of ["Bash(timeout:*)", "Bash(bash:*)", "Bash(env:*)", "Bash(xargs:*)"]) {
      const rules = [...base, rule(w, "allow", ROOT)];
      for (const command of ["timeout 60 gh pr merge 1", "bash -c 'gh pr merge 1'", "env X=1 gh pr merge 1", "echo 1 | xargs gh pr merge"]) {
        expect(decide(rules, ROOT, "Bash", { command }).decision, `${w} ${command}`).toBe("never");
      }
    }
    // and a never on the wrapper still holds
    expect(decide([rule("Bash(sudo:*)", "never")], ROOT, "Bash", { command: "sudo ls" }).decision).toBe("never");
    expect(decide(base, ROOT, "Bash", { command: "command -v gh" }).decision).toBe("unknown");
  });

  test("git push allows a push, not a force push", () => {
    for (const command of ["git push --force origin main", "git push -f", "git push -uf origin x", "git push --force-with-lease", "git push --force-with-lease=main:abc",
      "git push origin +main", "timeout 60 git push --force", "git -C repo push --force", "cd x && git push -f",
      "git push --delete origin feat", "git push origin --delete feat", "git push -d origin feat", "git push origin :feat"]) {
      expect(decide(base, ROOT, "Bash", { command }).decision, command).toBe("ask");
    }
    for (const command of ["git push", "git push -u origin feat", "git push --force-if-includes origin x", "git push origin main:feat"]) {
      expect(decide(base, ROOT, "Bash", { command }).decision, command).toBe("allow");
    }
    // a never on push stays never; a rule that names the force decides it
    expect(decide([rule("Bash(git push:*)", "never")], ROOT, "Bash", { command: "git push -f" }).decision).toBe("never");
    expect(decide([...base, rule("Bash(git push --force:*)", "allow", ROOT)], ROOT, "Bash", { command: "git push --force" }).decision).toBe("allow");
    expect(decide([...base, rule("Bash(git push --delete:*)", "allow", ROOT)], ROOT, "Bash", { command: "git push --delete origin x" }).decision).toBe("allow");
  });

  test("a line with a command no rule covers is unknown, unless another command is already never", () => {
    expect(decide(base, ROOT, "Bash", { command: "git push && npm publish" }).decision).toBe("unknown");
    expect(decide(base, ROOT, "Bash", { command: "npm publish && gh release create v1" }).decision).toBe("never");
  });

  test("a project that allows git push still never pushes to master, in any spelling", () => {
    /* A learned "git push: allow" for a project won the line, and the trunk
       check was skipped with it: git push e2e HEAD:master ran. */
    const named = BASE_RULES.map((b) => ({ ...rule(b.match, b.setting), action: b.action }));
    const allowPush = [...named, { ...rule("Bash(git push:*)", "allow", ROOT), action: "git.push" }];
    for (const command of ["git push upstream HEAD:master", "git push origin +master", "git push --all", "git push origin main"]) {
      expect(decide(allowPush, ROOT, "Bash", { command }).decision, command).toBe("never");
    }
    expect(decide(allowPush, ROOT, "Bash", { command: "git push origin ORBIT-1042-fix" }).decision).toBe("allow");
  });

  test("a pending suggestion decides nothing", () => {
    const pending = { ...rule("Bash(npm publish:*)", "never"), pending: true };
    expect(decide([pending], ROOT, "Bash", { command: "npm publish" }).decision).toBe("unknown");
  });

  test("other tools match by name, and a path pattern by glob", () => {
    const rules = [rule("Edit", "ask"), rule("Write(/etc/**)", "never")];
    expect(decide(rules, ROOT, "Edit", { file_path: "/x/y.ts" }).decision).toBe("ask");
    expect(decide(rules, ROOT, "Write", { file_path: "/etc/hosts" }).decision).toBe("never");
    expect(decide(rules, ROOT, "Write", { file_path: "/tmp/hosts" }).decision).toBe("unknown");
  });

  test("a rule scoped to the seat decides for the seat and nobody else", () => {
    const rules = [{ ...rule("Bash(bun test:*)", "never", ROOT), role: "seat" as const }];
    expect(decide(rules, ROOT, "Bash", { command: "bun test" }, "seat").decision).toBe("never");
    expect(decide(rules, ROOT, "Bash", { command: "bun test" }).decision).toBe("unknown");
    // a rule with no role still decides for the seat
    expect(decide([rule("Bash(git push:*)", "never", ROOT)], ROOT, "Bash", { command: "git push" }, "seat").decision).toBe("never");
  });

  test("the derived seat rule is one rule over the commands a Verifier runs", () => {
    const seatRule = seatChecksRule(ROOT, true)!;
    expect(seatRule).toMatchObject({ role: "seat", setting: "never", project: ROOT });
    for (const command of ["bun test", "bun test --watch", "npx tsc --noEmit", "npm run typecheck", "make check", "cd src && make ci-docker", "make smoke"]) {
      const d = decide([seatRule], ROOT, "Bash", { command }, "seat");
      expect(d.decision, command).toBe("never");
      expect(d.reason, command).toContain("Verifier");
      // and it is not a rule for the worker that runs them
      expect(decide([seatRule], ROOT, "Bash", { command }).decision, command).toBe("unknown");
    }
    for (const command of ["git status", "bun run build", "make deploy", "cat test.ts", "npx tscx"]) {
      expect(decide([seatRule], ROOT, "Bash", { command }, "seat").decision, command).toBe("unknown");
    }
    // a project's allow on the same command does not loosen it: the stricter speaks
    expect(decide([rule("Bash(make check:*)", "allow", ROOT), seatRule], ROOT, "Bash", { command: "make check" }, "seat").decision).toBe("never");
    expect(seatChecksRule(ROOT, false)).toBeNull();
  });

  test("the delegation rule follows the engine, not a count of blocks", () => {
    const b = (name: string, kind: string | undefined, engine: string) => ({ name, kind, engine, onPath: true });
    expect(seatDelegatesRule(ROOT, [], "claude")).toBeNull();
    expect(seatDelegatesRule(ROOT, [b("Builder", "builder", "claude"), b("Inspector", "reviewer", "claude")], "claude")).toBeNull();
    expect(seatDelegatesRule(ROOT, [b("Inspector", "reviewer", "opencode")], "claude")).not.toBeNull();
    expect(seatDelegatesRule(ROOT, [b("Builder", "builder", "claude"), b("Inspector", "reviewer", "opencode")], "claude")).not.toBeNull();
    // the chair on OpenCode: the Claude block is the one that owns the job
    expect(seatDelegatesRule(ROOT, [b("Inspector", "reviewer", "claude")], "opencode")).not.toBeNull();
  });

  test("the sentence names the first on-path block with its CLI, then the path's workers with their engines", () => {
    const blocks = [
      { name: "Builder", kind: "builder", engine: "opencode", onPath: true },
      { name: "Inspector", kind: "reviewer", engine: "opencode", onPath: true },
      { name: "QA-only", kind: undefined, engine: "opencode", onPath: false },
    ];
    const delegation = seatDelegatesRule(ROOT, blocks, "claude")!;
    expect(delegation).toMatchObject({ id: SEAT_DELEGATES_ID, action: "seat.delegates", role: "seat", setting: "never", project: ROOT });
    const [first, workers, ceiling] = delegation.why!.split("\n");
    expect(first).toContain("Builder block (OpenCode)");
    expect(first).toContain("--role builder");
    expect(workers).toBe("The path's workers: Builder (OpenCode), Inspector (OpenCode).");
    expect(ceiling).toContain("agentglass's hook");
    expect(ceiling).toContain("flow.delegationGuard");
    const d = decide([delegation], ROOT, delegation.match, { description: "review the diff" }, "seat");
    expect(d.decision).toBe("never");
    expect(d.reason).toContain("--role builder");
    // a worker keeps its own answer, and a Bash call is not touched
    expect(decide([delegation], ROOT, delegation.match, { description: "review the diff" }).decision).toBe("unknown");
    expect(decide([delegation], ROOT, "Bash", { command: "git status" }, "seat").decision).toBe("unknown");
  });

  test("both names Claude Code gives the subagent tool are covered, and a stored wildcard allow does not loosen it", () => {
    const delegation = seatDelegatesRule(ROOT, [{ name: "Inspector", kind: "reviewer", engine: "opencode", onPath: true }], "claude")!;
    expect(SEAT_DELEGATES_MATCHES).toEqual(["Agent", "Task"]);
    for (const tool of ["Agent", "Task"]) {
      expect(decide([delegation], ROOT, tool, { description: "review the footer diff" }, "seat").decision, tool).toBe("never");
      // `Agent(*)` is specificity 1 against the bare tool's 0: the narrower-looking allow must not speak
      const stored = rule(`${tool}(*)`, "allow", ROOT);
      expect(decide([stored, delegation], ROOT, tool, { description: "review the footer diff" }, "seat").decision, tool).toBe("never");
      // every other agent keeps its own answer
      expect(decide([stored, delegation], ROOT, tool, { description: "review the footer diff" }).decision, tool).toBe("allow");
    }
  });

  test("every role a block can name is one of the CLI's --role choices, and a made-up kind starts as a builder", () => {
    const line = /p\.add_argument\("--role", choices=\[([^\]]*)\]/.exec(CLI);
    expect(line).not.toBeNull();
    const choices = [...line![1]!.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
    expect(choices.sort()).toEqual(["builder", "reviewer", "scout", "verifier"]);
    for (const kind of ["verifier", "reviewer", "builder", "scout"]) expect(choices, kind).toContain(blockRole(kind));
    for (const kind of [undefined, "qa-only", "landing", "custom"]) expect(blockRole(kind), String(kind)).toBe("builder");
    expect(Object.values(BLOCK_ROLE).every((r) => choices.includes(r))).toBe(true);
  });

  test("the derivation is pure: the caller's guard decides whether the delegated rule exists", () => {
    const flow = { hasVerifier: true, seatEngine: "claude", blocks: [{ name: "Inspector", kind: "reviewer", engine: "opencode", onPath: true }] };
    expect(seatRules(ROOT, flow, false).map((r) => r.id)).toEqual(["seat.checks"]);
    expect(seatRules(ROOT, flow, true).map((r) => r.id)).toEqual(["seat.checks", SEAT_DELEGATES_ID]);
    expect(seatRules(ROOT, { ...flow, hasVerifier: false }, false)).toEqual([]);
  });
});

describe("ruleFor", () => {
  test("a Bash command keeps its first two words", () => {
    expect(ruleFor("Bash", { command: "npm publish --tag beta" })).toEqual({ action: "bash.npm.publish", match: "Bash(npm publish:*)" });
    expect(ruleFor("Bash", { command: "git commit -m hi" })?.match).toBe("Bash(git commit:*)");
  });
  test("a flag or a path is not a subcommand", () => {
    expect(ruleFor("Bash", { command: "ls -la" })).toBeNull();
    expect(ruleFor("Bash", { command: "make -j4 build" })?.match).toBe("Bash(make:*)");
    // a path is not a plain word: it must not be skipped so that its flag becomes the rule
    expect(ruleFor("Bash", { command: "./run.sh --x" })).toBeNull();
    expect(ruleFor("Bash", { command: "/usr/bin/env --x" })).toBeNull();
  });
  test("another tool is its own name", () => {
    expect(ruleFor("Edit", { file_path: "/a" })).toEqual({ action: "edit", match: "Edit" });
  });
  test("a word that cannot start a command makes no rule", () => {
    for (const command of ["- master", "-", "1", "408", "ERROR", "FAILED", "EOF", "ORBIT-1042 fix", "done"]) {
      expect(ruleFor("Bash", { command })).toBeNull();
    }
    // a capitalised word is a command; only all-caps is text
    expect(ruleFor("Bash", { command: "Rscript run.R" })?.match).toBe("Bash(Rscript:*)");
    expect(ruleFor("Bash", { command: "Rscript fit" })?.match).toBe("Bash(Rscript fit:*)");
    expect(ruleFor("Bash", { command: "X=1 npm publish" })?.match).toBe("Bash(npm publish:*)");
    // a wrapper is never the rule; the command it runs is
    for (const command of ["timeout 60 npm publish", "env X=1 npm publish", "sudo npm publish", "bash -c 'npm publish'", "echo x | xargs npm publish"]) {
      expect(ruleFor("Bash", { command: command.replace(/^echo x \| /, "") })?.match, command).toBe("Bash(npm publish:*)");
    }
  });
  test("a call that only reads is null", () => {
    expect(ruleFor("Read", { file_path: "/a" })).toBeNull();
    expect(ruleFor("Grep", { pattern: "x" })).toBeNull();
    expect(ruleFor("Bash", { command: "ls" })).toBeNull();
    expect(ruleFor("Bash", { command: "cd /x && cat y" })).toBeNull();
  });
});

describe("isLooser", () => {
  test("handing an agent more is looser; the same or less is not", () => {
    expect(isLooser("never", "ask")).toBe(true);
    expect(isLooser("never", "allow")).toBe(true);
    expect(isLooser("ask", "allow")).toBe(true);
    expect(isLooser("allow", "ask")).toBe(false);
    expect(isLooser("allow", "never")).toBe(false);
    expect(isLooser("ask", "ask")).toBe(false);
  });
  test("no rule counts as ask", () => {
    expect(isLooser(null, "allow")).toBe(true);
    expect(isLooser(null, "ask")).toBe(false);
    expect(isLooser(null, "never")).toBe(false);
  });
  test("a mode that asks less is looser", () => {
    expect(isLooserMode("default", "bypassPermissions")).toBe(true);
    expect(isLooserMode("auto", "default")).toBe(false);
  });
});

describe("shellSegments", () => {
  test("splits on every operator and strips env assignments", () => {
    expect(shellSegments("A=1 B=2 git push && (echo a | cat); ls")).toEqual(["git push", "echo a", "cat", "ls"]);
  });
  test("loop and if words are not commands; the command after do/then/else is", () => {
    expect(shellSegments("for n in 1 2; do gh pr view $n; done")).toEqual(["gh pr view $n"]);
    expect(shellSegments("if git diff --quiet; then echo clean; else npm publish; fi")).toEqual(["git diff --quiet", "echo clean", "npm publish"]);
    expect(shellSegments("while read x; do ! grep -q y z; done")).toEqual(["read x", "grep -q y z"]);
  });

  test("a command inside $(...) or backticks is a segment of its own", () => {
    expect(shellSegments("for n in $(gh pr list); do echo $n; done")).toEqual(["gh pr list", "echo $n"]);
    expect(shellSegments("echo `gh pr merge 3`")).toEqual(["echo `gh pr merge 3`", "gh pr merge 3"]);
    expect(shellSegments('echo "$(gh pr merge 1)"')).toEqual(['echo "$(gh pr merge 1)"', "gh pr merge 1"]);
    expect(shellSegments("echo $((1 | 2))")).toEqual(["echo $((1 | 2))"]);
  });

  test("operators inside quotes, comments and heredoc bodies do not split", () => {
    expect(shellSegments(`grep -E "ERROR|Error|FAILED|Traceback" log | tail -5`)).toEqual([`grep -E "ERROR|Error|FAILED|Traceback" log`, "tail -5"]);
    expect(shellSegments("grep -E 'a|b;c' x && wc -l")).toEqual(["grep -E 'a|b;c' x", "wc -l"]);
    expect(shellSegments(`gh pr edit 5 --body "a | b; c && d\n- master"`)).toEqual([`gh pr edit 5 --body "a | b; c && d\n- master"`]);
    expect(shellSegments("make test 2>&1 | tail # last | 408; Ran")).toEqual(["make test 2>&1", "tail"]);
    expect(shellSegments("echo $'it\\'s; x' ; ls")).toEqual(["echo $'it\\'s; x'", "ls"]);
  });

  test("a heredoc body is skipped up to its tag; an unquoted tag still runs its substitutions", () => {
    const commit = `git commit -q -m "$(cat <<'EOF'\nFix the packfile | not ready; to master\n\n- master\n- code & pre\nEOF\n)" && git log -1`;
    expect(shellSegments(commit)).toEqual([commit.slice(0, commit.indexOf(" && ")), "cat <<'EOF'", "git log -1"]);
    expect(shellSegments("cat <<-X > f\n\t- in | to\n\tX\nnpm publish")).toEqual(["cat <<-X > f", "npm publish"]);
    expect(shellSegments("cat <<X\n$(gh pr merge 1) | Dockerfile\nX")).toEqual(["cat <<X", "gh pr merge 1"]);
    expect(shellSegments("cat <<<'a|b'")).toEqual(["cat <<<'a|b'"]);
  });

});

describe("the shell -c pattern", () => {
  test("still reads a shell that takes options before -c", () => {
    expect(isWrapper("bash -c 'git status'")).toBe(true);
    expect(isWrapper("sh -lc \"git status\"")).toBe(true);
    expect(isWrapper("zsh --norc --noprofile -c 'git status'")).toBe(true);
    expect(isWrapper("bash script.sh")).toBe(false);
  });
  // Cheap tripwire for a slow flag loop (CodeQL js/redos). The old pattern did not fail it in Bun; the cases above carry the proof.
  test("answers at once for a long run of option-shaped words with no -c", () => {
    const t0 = performance.now();
    isWrapper(`sh\t-${"--\t-".repeat(40)}x`);
    isWrapper(`bash ${"-ab ".repeat(2000)}x`);
    expect(performance.now() - t0).toBeLessThan(250);
  });
});
