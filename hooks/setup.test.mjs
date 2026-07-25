import assert from "node:assert/strict";
import test from "node:test";

import { runSetup } from "./setup.mjs";

test("undo runs both integrations and preserves the first failure", () => {
  const calls = [];
  const statuses = [1, 0];
  const spawn = (...args) => {
    calls.push(args);
    return { status: statuses.shift() };
  };

  assert.equal(runSetup(true, spawn), 1);
  assert.deepEqual(
    calls.map(([, args]) => args.slice(1)),
    [
      ["install_hooks.py", "--uninstall"],
      ["connect_opencode.py", "--undo"],
    ],
  );
});

test("setup succeeds only when both integrations succeed", () => {
  const calls = [];
  const spawn = (...args) => {
    calls.push(args);
    return { status: 0 };
  };

  assert.equal(runSetup(false, spawn), 0);
  assert.deepEqual(
    calls.map(([, args]) => args.slice(1)),
    [["install_hooks.py"], ["connect_opencode.py"]],
  );
});

test("setup runs both integrations when the second one fails", () => {
  const calls = [];
  const statuses = [0, 2];
  const spawn = (...args) => {
    calls.push(args);
    return { status: statuses.shift() };
  };

  assert.equal(runSetup(false, spawn), 2);
  assert.equal(calls.length, 2);
});

test("setup reports a process launch error", () => {
  const spawn = () => ({ error: new Error("spawn failed"), status: null });

  assert.equal(runSetup(false, spawn), 1);
});
