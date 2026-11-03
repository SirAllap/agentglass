#!/usr/bin/env bun
/**
 * "environment: node_modules missing", instead of a typecheck error that is not one.
 *
 * A `git worktree add` checkout has no node_modules, and bun installs each
 * workspace's own, so a checkout whose root node_modules is a symlink to the
 * main one still fails: measured on this worktree, `cd web && bun run typecheck`
 * answered `TS2688 Cannot find type definition file for 'vite/client'`, which
 * reads as a type error in somebody's change and is not.
 *
 * Run first by `make typecheck`, `make check` and `make ci`, because a check
 * that could not run is not a check that passed.
 *
 *   bun scripts/depscheck.ts            # this checkout
 *   bun scripts/depscheck.ts <dir>      # another one
 *
 * Exit 0 when every node_modules the checkout needs is there, 2 when one is
 * not — the code headcheck.ts already uses for "the check could not run".
 */
import { fileURLToPath } from "node:url";
import { nodeModulesGap } from "../server/src/checkoutDeps.ts";

// `pathname` percent-encodes, so a checkout under a path with a space read
// "no package.json" and this answered 0 instead of 2.
const repo = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
const gap = nodeModulesGap(process.argv[2] ?? repo);
if (gap) {
  console.error(gap.line);
  process.exit(2);
}
