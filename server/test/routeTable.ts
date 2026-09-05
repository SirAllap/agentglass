/*
 * The server's route table, read out of `index.ts` by parsing it.
 *
 * There is exactly one caller today — `route-guard-coverage.test.ts`, which
 * asserts that everything mutating sits behind an Origin gate. It lives in its
 * own file anyway for one reason: a parser that reads a hard-coded path can
 * only ever be checked against the code it already agrees with. Pointing
 * `readRoutes` at a copy with a guard deleted is how you find out the walker
 * would actually have noticed — and that check is worth more than the test it
 * backs, because a route enumerator that silently stops enumerating turns the
 * whole thing green.
 *
 * Why the TypeScript AST and not a regex over the lines: the dispatcher is one
 * long chain of `if (pathname === …)` inside a single handler, and the gate for
 * a whole family — `/git/`, `/prs/`, `/docker/` — is one statement at the top
 * of a block whose routes are `case` labels twenty lines further down. "Is this
 * route inside a block that already refused an untrusted caller" is a question
 * about the tree, and answering it by counting braces in text is the kind of
 * parser that goes wrong quietly the first time somebody puts a brace in a
 * string. `typescript` is already a devDependency here — it is what
 * `bun run typecheck` runs.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as ts from "typescript";

/** The dispatcher. Overridable so the parser itself can be tested. */
export const SOURCE = join(import.meta.dir, "..", "src", "index.ts");

/** The two Origin gates. Anything that executes or mutates goes through one. */
export const GUARDS = new Set(["trustedCaller", "desktopOnly"]);

/** The verbs that change something. A route reachable only by these mutates. */
export const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

const HTTP_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);

export type Route = {
  /** The path as the dispatcher matches it; a family ends in `*`. */
  path: string;
  /** How the dispatcher matches: an exact path, a prefix, or a switch label. */
  kind: "exact" | "prefix" | "case" | "suffix";
  /** The methods the route's conditions restrict it to; empty means any. */
  methods: string[];
  /** Line in index.ts, so a failure can be opened rather than hunted for. */
  line: number;
  guarded: boolean;
  /** Upgrades to a WebSocket — a PTY or a live feed, so it executes. */
  upgrades: boolean;
};

/** Parse index.ts and walk out every path the dispatcher can match. */
export function readRoutes(file: string = SOURCE): Route[] {
  const text = readFileSync(file, "utf8");
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

  const subtreeHas = (node: ts.Node, pred: (n: ts.Node) => boolean): boolean => {
    let found = false;
    const visit = (n: ts.Node) => {
      if (found) return;
      if (pred(n)) { found = true; return; }
      ts.forEachChild(n, visit);
    };
    visit(node);
    return found;
  };

  const isGuardCall = (n: ts.Node) =>
    ts.isCallExpression(n) && ts.isIdentifier(n.expression) && GUARDS.has(n.expression.text);

  /*
   * `srv.upgrade(req, …)`. A WebSocket route is a GET as far as the method
   * goes and is not a read at all — `/terminal/pty` hands out a login shell —
   * so the upgrade call is what marks it. Matched on the method name rather
   * than on `srv` so that renaming the server handle does not quietly drop
   * every socket route out of the rule.
   */
  const isUpgradeCall = (n: ts.Node) =>
    ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)
    && n.expression.name.text === "upgrade";

  /*
   * Every `<something> === "literal"` and `pathname.startsWith("literal")` in
   * a condition, flattened. The dispatcher's conditions are ands and ors of
   * exactly these two shapes, so this is the whole vocabulary — and reading
   * both sides of an `||` is how `/v1/traces` and `/otlp/v1/traces` both get
   * counted from the one `if` that serves them.
   */
  const tests = (expr: ts.Node): Array<{ subject: string; value: string }> => {
    const out: Array<{ subject: string; value: string }> = [];
    const visit = (n: ts.Node) => {
      if (
        ts.isBinaryExpression(n)
        && n.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken
        && ts.isStringLiteral(n.right)
      ) {
        out.push({ subject: n.left.getText(sf), value: n.right.text });
      }
      if (
        ts.isCallExpression(n)
        && ts.isPropertyAccessExpression(n.expression)
        && n.expression.name.text === "startsWith"
        && n.expression.expression.getText(sf) === "pathname"
        && n.arguments.length === 1
        && ts.isStringLiteral(n.arguments[0])
      ) {
        out.push({ subject: "pathname.startsWith", value: (n.arguments[0] as ts.StringLiteral).text });
      }
      ts.forEachChild(n, visit);
    };
    visit(expr);
    return out;
  };

  /*
   * The guard idiom, and only that: `if (!trustedCaller(req, from)) return
   * csrfBlocked();` — the call in the CONDITION of an `if`, so the statement
   * either refuses the caller or falls through.
   *
   * The distinction matters twice. `updateStatus` calls `desktopOnly(req)` as
   * a value, to decide which of two answers to give rather than whether to
   * answer at all, and that is not a gate. And every route in this file is a
   * sibling of every other in one enormous block, so "somewhere above me there
   * is a trustedCaller" is true of nearly all of them and means nothing —
   * what has to be true is that the guard runs on the way to THIS route.
   */
  const isGuardStatement = (s: ts.Statement): boolean =>
    ts.isIfStatement(s) && subtreeHas(s.expression, isGuardCall);

  /** The statements of a block, or the single statement standing in for one. */
  const statementsOf = (n: ts.Node): readonly ts.Statement[] => {
    if (ts.isBlock(n) || ts.isCaseClause(n) || ts.isDefaultClause(n) || ts.isSourceFile(n)) {
      return (n as { statements: ts.NodeArray<ts.Statement> }).statements;
    }
    return ts.isStatement(n) ? [n] : [];
  };

  /**
   * A route inherits the guard of any block it sits in, as long as the guard
   * runs first. `s.end <= start` is that "runs first": the family gate has
   * already returned before the switch below it is reached, whereas a guard
   * further down the same block protects the routes after it and not this one.
   */
  const inheritsGuard = (node: ts.Node): boolean => {
    const start = node.getStart(sf);
    for (let cur: ts.Node | undefined = node.parent; cur; cur = cur.parent) {
      for (const s of statementsOf(cur)) {
        if (s.end <= start && isGuardStatement(s)) return true;
      }
    }
    return false;
  };

  /** The route's own block refuses first: the guard is a statement inside it. */
  const guardsItself = (n: ts.IfStatement): boolean =>
    statementsOf(n.thenStatement).some(isGuardStatement);

  /*
   * The methods a route is restricted to: its own condition plus every `if`
   * it is nested in, because the family blocks put `req.method === "POST"`
   * on the outer condition and the individual routes inside carry none.
   */
  const methodsFor = (node: ts.Node): string[] => {
    const found = new Set<string>();
    for (let cur: ts.Node | undefined = node; cur; cur = cur.parent) {
      if (!ts.isIfStatement(cur)) continue;
      for (const t of tests(cur.expression)) {
        if (t.subject === "req.method" && HTTP_METHODS.has(t.value)) found.add(t.value);
      }
    }
    return [...found];
  };

  const lineOf = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;

  /* The prefix of the family block a node sits in, for the `op === "x"` form. */
  const familyPrefix = (node: ts.Node): string | null => {
    for (let cur: ts.Node | undefined = node.parent; cur; cur = cur.parent) {
      if (!ts.isIfStatement(cur)) continue;
      const p = tests(cur.expression).find((t) => t.subject === "pathname.startsWith");
      if (p) return p.value;
    }
    return null;
  };

  const routes: Route[] = [];

  const visit = (n: ts.Node) => {
    if (ts.isIfStatement(n)) {
      const conditions = tests(n.expression);
      const guarded = guardsItself(n) || inheritsGuard(n);
      const upgrades = subtreeHas(n.thenStatement, isUpgradeCall);
      const methods = methodsFor(n);
      const add = (path: string, kind: Route["kind"]) =>
        routes.push({ path, kind, methods, line: lineOf(n), guarded, upgrades });

      for (const c of conditions) {
        if (c.subject === "pathname") add(c.value, "exact");
        else if (c.subject === "pathname.startsWith") add(`${c.value}*`, "prefix");
        else if (c.subject === "op") {
          // `const op = pathname.slice("/browser/".length)` and then a chain of
          // `op === "…"`. Same routes, spelled as the tail rather than the whole.
          const prefix = familyPrefix(n);
          if (prefix) add(prefix + c.value, "suffix");
        }
      }
    }

    /*
     * `switch (pathname) { case "/git/push": … }` — the family blocks list
     * their real routes here, and there are more of these than there are
     * `if`s. They are what a list-based test never sees, because nobody
     * writing one thinks of a `case` label as a route.
     */
    if (ts.isCaseClause(n) && ts.isStringLiteral(n.expression) && n.expression.text.startsWith("/")) {
      const block = n.parent;
      const sw = block.parent;
      if (ts.isSwitchStatement(sw) && sw.expression.getText(sf) === "pathname") {
        routes.push({
          path: n.expression.text,
          kind: "case",
          methods: methodsFor(n),
          line: lineOf(n),
          guarded: inheritsGuard(n),
          upgrades: false,
        });
      }
    }

    ts.forEachChild(n, visit);
  };

  visit(sf);
  return routes;
}

/** POST/PUT/PATCH/DELETE, or a socket upgrade — the things that are not reads. */
export const mutates = (r: Route) => r.methods.some((m) => MUTATING_METHODS.has(m)) || r.upgrades;

/** How a route is named in a failure: the method it answers and its path. */
export const label = (r: Route) => `${r.methods.slice().sort().join("/") || "ANY"} ${r.path}`;
